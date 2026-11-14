import { describe, expect, it } from "vitest";

import type { Event } from "../../lib/events";
import { bucketIntoTurns, deriveSpans } from "./derive";

// Port of main's timeline/derive.test.ts, in Muse's vocabulary: a finished
// call has no detail, a failed one is `failed`, and waiting for a person is
// its own "Waiting for approval" span.

let clock = Date.parse("2026-09-30T00:00:00.000Z");
const at = <T extends Record<string, unknown>>(e: T) => ({ ...e, processed_at: new Date((clock += 1000)).toISOString() }) as unknown as Event;

const toolSpan = (events: Event[], context?: Event[]) =>
  deriveSpans(events, context).spans.find((s) => s.family === "tool" || s.family === "custom_tool" || s.family === "mcp");
const approvalSpan = (events: Event[], context?: Event[]) => deriveSpans(events, context).spans.find((s) => s.family === "approval");

describe("timeline tool spans", () => {
  it("leave a successful call plain", () => {
    const span = toolSpan([at({ type: "user.message" }), at({ type: "agent.tool_use", id: "a", name: "bash" }), at({ type: "agent.tool_result", tool_use_id: "a", content: "ok" })]);
    expect(span?.detail).toBeUndefined();
    expect(span?.failed).toBe(false);
  });

  it("mark is_error results (including recovery placeholders) failed", () => {
    const span = toolSpan([
      at({ type: "user.message" }),
      at({ type: "agent.tool_use", id: "a", name: "bash" }),
      at({ type: "agent.tool_result", tool_use_id: "a", content: "outcome unknown; it MAY have taken effect", is_error: true }),
    ]);
    expect(span).toMatchObject({ detail: "failed", failed: true });
  });

  it("mark a command that exited non-zero failed", () => {
    const span = toolSpan([
      at({ type: "user.message" }),
      at({ type: "agent.tool_use", id: "a", name: "bash" }),
      at({ type: "agent.tool_result", tool_use_id: "a", content: [{ type: "text", text: "exit=2\nnot found" }] }),
    ]);
    expect(span).toMatchObject({ detail: "failed", failed: true });
  });

  it("mark MCP error results failed, under the app's name", () => {
    const span = toolSpan([
      at({ type: "user.message" }),
      at({ type: "agent.mcp_tool_use", id: "m", name: "search", mcp_server_name: "github" }),
      at({ type: "agent.mcp_tool_result", mcp_tool_use_id: "m", content: "boom", is_error: true }),
    ]);
    expect(span).toMatchObject({ family: "mcp", source: "GitHub", label: "search", detail: "failed", failed: true });
  });

  it("read a decision made in a later turn from the wider log", () => {
    const turn1 = [
      at({ type: "user.message" }),
      at({ type: "agent.tool_use", id: "c", name: "bash", evaluated_permission: "ask" }),
      at({ type: "session.status_idle", stop_reason: { type: "requires_action", action_type: "tool_confirmation", event_ids: ["c"] } }),
    ];
    expect(approvalSpan(turn1, turn1)?.detail).toBe("still waiting");
    expect(toolSpan(turn1, turn1)?.detail).toBe("not run yet");

    const turn2 = [
      at({ type: "user.tool_confirmation", tool_use_id: "c", result: "deny", deny_message: "no" }),
      at({ type: "session.status_running" }),
      at({ type: "agent.tool_result", tool_use_id: "c", content: "Denied: no" }),
      at({ type: "session.status_idle", stop_reason: { type: "end_turn" } }),
    ];
    const all = [...turn1, ...turn2];
    const approval = approvalSpan(turn1, all);
    expect(approval?.detail).toBe("denied");
    // It waited until the turn closed; the bar never runs past the turn.
    const { totalMs } = deriveSpans(turn1, all);
    expect(approval!.startMs + approval!.durationMs).toBeLessThanOrEqual(totalMs);
    expect(toolSpan(turn1, all)?.detail).toBe("denied");
  });

  it("label a deferred call_mcp_tool as the app call it carries, and a tool search in words", () => {
    const { spans } = deriveSpans([
      at({ type: "user.message" }),
      at({ type: "agent.tool_use", id: "d", name: "call_mcp_tool", input: { name: "mcp__github__repos__create_pr", arguments: "{}" } }),
      at({ type: "agent.tool_result", tool_use_id: "d", content: "ok" }),
      at({ type: "agent.tool_use", id: "s", name: "search_mcp_tools", input: { query: "pull request" } }),
      at({ type: "agent.tool_use", id: "l", name: "search_mcp_tools", input: { query: "issue", server: "linear" } }),
      at({ type: "agent.tool_use", id: "x", name: "call_mcp_tool", input: {} }),
    ]);
    const tools = spans.filter((s) => s.family === "tool" || s.family === "mcp");
    expect(tools.map((s) => [s.family, s.source ?? null, s.label])).toEqual([
      ["mcp", "GitHub", "repos__create_pr"],
      ["tool", null, "Searched all tools for “pull request”"],
      ["tool", null, "Searched Linear tools for “issue”"],
      ["tool", null, "call_mcp_tool"],
    ]);
    expect(tools[0].detail).toBeUndefined();
    expect(tools[1].plain).toBe(true);
    expect(tools[3].plain).toBeUndefined();
  });

  it("pair a custom tool call with the runtime's agent.tool_result", () => {
    const span = toolSpan([
      at({ type: "user.message" }),
      at({ type: "agent.custom_tool_use", id: "t", name: "send_email" }),
      at({ type: "user.custom_tool_result", custom_tool_use_id: "t", content: [] }),
      at({ type: "agent.tool_result", tool_use_id: "t", content: "sent" }),
    ]);
    expect(span?.detail).toBeUndefined();
    expect(span?.durationMs).toBeGreaterThan(0);
  });

  it("say a custom tool waits for the app's result", () => {
    const turn = [
      at({ type: "user.message" }),
      at({ type: "agent.custom_tool_use", id: "t", name: "send_email" }),
      at({ type: "session.status_idle", stop_reason: { type: "requires_action", action_type: "custom_tool_result", event_ids: ["t"] } }),
    ];
    expect(toolSpan(turn, turn)?.detail).toBe("waiting for the app's result");
    expect(approvalSpan(turn, turn)).toBeUndefined();
  });
});

describe("bucketIntoTurns", () => {
  it("marks a turn parked on requires_action as waiting, not completed", () => {
    const turns = bucketIntoTurns([
      at({ type: "user.message" }),
      at({ type: "agent.tool_use", id: "c", name: "bash" }),
      at({ type: "session.status_idle", stop_reason: { type: "requires_action", action_type: "tool_confirmation", event_ids: ["c"] } }),
    ]);
    expect(turns.map((t) => t.status)).toEqual(["approval"]);
  });

  it("settles that turn once it is answered", () => {
    const turns = bucketIntoTurns([
      at({ type: "user.message" }),
      at({ type: "agent.tool_use", id: "c", name: "bash" }),
      at({ type: "session.status_idle", stop_reason: { type: "requires_action", action_type: "tool_confirmation", event_ids: ["c"] } }),
      at({ type: "user.tool_confirmation", tool_use_id: "c", result: "allow" }),
      at({ type: "agent.tool_result", tool_use_id: "c", content: "ok" }),
      at({ type: "session.status_idle", stop_reason: { type: "end_turn" } }),
    ]);
    expect(turns.map((t) => t.status)).toEqual(["completed", "completed"]);
  });

  it("tells a custom tool's wait from an approval, with or without the action type", () => {
    const custom = bucketIntoTurns([
      at({ type: "user.message" }),
      at({ type: "agent.custom_tool_use", id: "t", name: "send_email" }),
      at({ type: "session.status_idle", stop_reason: { type: "requires_action", action_type: "custom_tool_result", event_ids: ["t"] } }),
    ]);
    expect(custom.map((t) => t.status)).toEqual(["awaiting_client"]);
    const untyped = bucketIntoTurns([
      at({ type: "user.message" }),
      at({ type: "agent.custom_tool_use", id: "t", name: "send_email" }),
      at({ type: "session.status_idle", stop_reason: { type: "requires_action", event_ids: ["t"] } }),
    ]);
    expect(untyped.map((t) => t.status)).toEqual(["awaiting_client"]);
    const approval = bucketIntoTurns([
      at({ type: "user.message" }),
      at({ type: "agent.tool_use", id: "c", name: "bash", evaluated_permission: "ask" }),
      at({ type: "session.status_idle", stop_reason: { type: "requires_action", event_ids: ["c"] } }),
    ]);
    expect(approval.map((t) => t.status)).toEqual(["approval"]);
  });
});
