import { describe, expect, it } from "vitest";
import { bucketIntoTurns, deriveSpans } from "./derive";
import type { Event } from "../../lib/events";

let clock = Date.parse("2026-09-30T00:00:00.000Z");
const at = <T extends Record<string, unknown>>(e: T) => ({ ...e, processed_at: new Date((clock += 1000)).toISOString() }) as unknown as Event;

const toolSpan = (events: Event[], context?: Event[]) =>
  deriveSpans(events, context).spans.find((s) => s.family === "tool" || s.family === "custom_tool" || s.family === "mcp");

describe("timeline tool spans", () => {
  it("labels successful results completed", () => {
    const span = toolSpan([at({ type: "user.message" }), at({ type: "agent.tool_use", id: "a", name: "bash" }), at({ type: "agent.tool_result", tool_use_id: "a", content: "ok" })]);
    expect(span?.detail).toBe("completed");
    expect(span?.isError).toBeUndefined();
  });

  it("labels is_error results (including recovery placeholders) failed", () => {
    const span = toolSpan([
      at({ type: "user.message" }),
      at({ type: "agent.tool_use", id: "a", name: "bash" }),
      at({ type: "agent.tool_result", tool_use_id: "a", content: "outcome unknown; it MAY have taken effect", is_error: true }),
    ]);
    expect(span?.detail).toBe("failed");
    expect(span?.isError).toBe(true);
  });

  it("labels MCP error results failed", () => {
    const span = toolSpan([
      at({ type: "user.message" }),
      at({ type: "agent.mcp_tool_use", id: "m", name: "search", mcp_server_name: "gh" }),
      at({ type: "agent.mcp_tool_result", mcp_tool_use_id: "m", content: "boom", is_error: true }),
    ]);
    expect(span?.detail).toBe("failed");
  });

  it("resolves awaiting / denied status across turns via the context events", () => {
    const turn1 = [
      at({ type: "user.message" }),
      at({ type: "agent.tool_use", id: "c", name: "bash", evaluated_permission: "ask" }),
      at({ type: "session.status_idle", stop_reason: { type: "requires_action", action_type: "tool_confirmation", event_ids: ["c"] } }),
    ];
    expect(toolSpan(turn1, turn1)?.detail).toBe("awaiting approval");
    const turn2 = [
      at({ type: "user.tool_confirmation", tool_use_id: "c", result: "deny", deny_message: "no" }),
      at({ type: "session.status_running" }),
      at({ type: "agent.tool_result", tool_use_id: "c", content: "Denied: no" }),
      at({ type: "session.status_idle", stop_reason: { type: "end_turn" } }),
    ];
    const span = toolSpan(turn1, [...turn1, ...turn2]);
    expect(span?.detail).toBe("denied");
    expect(span?.isError).toBe(true);
  });

  it("pairs custom tool calls with their agent.tool_result", () => {
    const span = toolSpan([
      at({ type: "user.message" }),
      at({ type: "agent.custom_tool_use", id: "t", name: "send_email" }),
      at({ type: "user.custom_tool_result", custom_tool_use_id: "t", content: [] }),
      at({ type: "agent.tool_result", tool_use_id: "t", content: "sent" }),
    ]);
    expect(span?.detail).toBe("completed");
    expect(span?.durationMs).toBeGreaterThan(0);
  });
});

describe("bucketIntoTurns", () => {
  it("marks a turn parked on requires_action as awaiting_action, not completed", () => {
    const turns = bucketIntoTurns([
      at({ type: "user.message" }),
      at({ type: "agent.tool_use", id: "c", name: "bash" }),
      at({ type: "session.status_idle", stop_reason: { type: "requires_action", action_type: "tool_confirmation", event_ids: ["c"] } }),
      at({ type: "user.tool_confirmation", tool_use_id: "c", result: "allow" }),
      at({ type: "agent.tool_result", tool_use_id: "c", content: "ok" }),
      at({ type: "session.status_idle", stop_reason: { type: "end_turn" } }),
    ]);
    expect(turns.map((t) => t.status)).toEqual(["awaiting_action", "completed"]);
  });
});
