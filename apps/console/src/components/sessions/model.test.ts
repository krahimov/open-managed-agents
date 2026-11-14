import { describe, expect, it } from "vitest";

import type { Event } from "@/lib/events";
import { sessionTitle } from "@/lib/sessions";

import { briefFailures, buildConversation, handoffKey, handoffKeyOf } from "./model";

const events = (list: Array<Record<string, unknown>>): Event[] =>
  list.map((e, i) => ({ id: `e${i}`, seq: i + 1, ts: 1_800_000_000_000 + i * 1000, ...e })) as unknown as Event[];

describe("a mission iteration", () => {
  it("is never titled by the mission's id", () => {
    expect(sessionTitle({ title: "Mission mis-V1StGXR8Z5jdHi6BmyTq4 · iteration 3", agent: undefined as never })).toBe(
      "Run until done · iteration 3",
    );
    expect(sessionTitle({ title: "Mission control retro", agent: undefined as never })).toBe("Mission control retro");
  });

  it("reads the failed checks out of the brief the run wrote", () => {
    const brief = [
      "[Mission mis-abc — iteration 3 of 10]",
      "",
      "Goal: migrate the routes",
      "",
      "When your turn ends, these checks must exit 0:",
      "  - npm test -- routes",
      "  - npx tsc --noEmit",
      "",
      "Previous attempt failed these checks:",
      "  - npm test -- routes",
      "      FAIL src/routes/events/events.test.ts",
      "      AssertionError: expected 500 to be 400",
    ].join("\n");
    expect(briefFailures(brief)).toEqual(["npm test -- routes"]);
    expect(briefFailures("Goal: anything")).toEqual([]);
  });

  it("opens with a note from the run, not a message from a person", () => {
    const { items } = buildConversation(
      events([
        { type: "user.message", content: [{ type: "text", text: "[Mission mis-abc — iteration 2 of 10]\n\nGoal: x" }], metadata: { kind: "mission_iteration", mission_iteration: 2 } },
      ]),
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "brief", iteration: 2, failing: [] });
  });
});

describe("a hand-off to another agent", () => {
  it("spells an agent id the way the runtime does in a tool name", () => {
    expect(handoffKeyOf("agent-rrtcdqruug4a13d0")).toBe("agent_rrtcdqruug4a13d0");
    expect(handoffKey("call_agent_agent_rrtcdqruug4a13d0")).toBe("agent_rrtcdqruug4a13d0");
    expect(handoffKey("bash")).toBeNull();
  });

  it("is named from the thread it started, and that thread's note is not drawn twice", () => {
    const { items } = buildConversation(
      events([
        { type: "user.message", content: [{ type: "text", text: "Is it ready?" }] },
        { type: "agent.tool_use", id: "call1", name: "call_agent_agent_rrtcdqruug4a13d0", input: { message: "Review #1850" } },
        { type: "session.thread_created", session_thread_id: "sthr_1", agent_id: "agent-rrtcdqruug4a13d0", agent_name: "PR Reviewer", parent_thread_id: "sthr_primary" },
        { type: "agent.tool_result", tool_use_id: "call1", content: "Safe to merge." },
      ]),
    );
    const turn = items.find((i) => i.kind === "agent");
    expect(turn?.kind === "agent" && turn.blocks.map((b) => b.kind)).toEqual(["tools"]);
    const block = turn?.kind === "agent" ? turn.blocks[0] : undefined;
    const call = block?.kind === "tools" ? block.calls[0] : undefined;
    expect(call?.handoff).toEqual({ agentKey: "agent_rrtcdqruug4a13d0", agentId: "agent-rrtcdqruug4a13d0", agentName: "PR Reviewer", threadId: "sthr_1" });
    expect(call?.output).toBe("Safe to merge.");
  });
});

describe("a request the agent makes of a person", () => {
  it("is drawn once, as its card, without the tool call that produced it", () => {
    const { items } = buildConversation(
      events([
        { type: "user.message", content: [{ type: "text", text: "Build the plan" }] },
        { type: "agent.tool_use", id: "r1", name: "request_access", input: { service: "hubspot", reason: "To read the deal" } },
        { type: "system.access_request", request_id: "acreq-1", service: "hubspot", reason: "To read the deal", auth_kind: "composio" },
        { type: "agent.tool_result", tool_use_id: "r1", content: '{"request_id":"acreq-1","status":"pending"}' },
      ]),
    );
    const turn = items.find((i) => i.kind === "agent");
    expect(turn?.kind === "agent" && turn.blocks.map((b) => b.kind)).toEqual(["card"]);
  });

  it("keeps the call when no card followed it", () => {
    const { items } = buildConversation(
      events([
        { type: "user.message", content: [{ type: "text", text: "Build the plan" }] },
        { type: "agent.tool_use", id: "r1", name: "request_access", input: { service: "hubspot" } },
        { type: "agent.tool_result", tool_use_id: "r1", content: "Request failed", is_error: true },
      ]),
    );
    const turn = items.find((i) => i.kind === "agent");
    expect(turn?.kind === "agent" && turn.blocks.map((b) => b.kind)).toEqual(["tools"]);
  });
});

describe("a failed turn's explanation", () => {
  const RAW = "No output generated. Check the stream for errors.";
  const QUOTA = "429 insufficient_quota: You exceeded your current quota";

  it("is the model's own error, as the error card says it, even when the runtime reports the failure twice", () => {
    const c = buildConversation(
      events([
        { type: "user.message", content: [{ type: "text", text: "hey" }] },
        { type: "span.model_request_end", finish_reason: "error", error_message: QUOTA },
        { type: "session.error", error: "model_error", message: RAW },
        { type: "session.status_idle" },
        { type: "session.error", error: "model_error", message: RAW, work_item_id: "sw_1" },
      ]),
    );
    expect(c.failed).toBe(true);
    expect(c.failure).toBe(QUOTA);
  });

  it("is the runtime's message when the model said nothing, and nothing once a new turn starts", () => {
    const only = buildConversation(
      events([
        { type: "user.message", content: [{ type: "text", text: "hey" }] },
        { type: "session.error", error: "model_error", message: RAW },
      ]),
    );
    expect(only.failure).toBe(RAW);
    const again = buildConversation(
      events([
        { type: "user.message", content: [{ type: "text", text: "hey" }] },
        { type: "session.error", error: "model_error", message: RAW },
        { type: "user.message", content: [{ type: "text", text: "try again" }] },
      ]),
    );
    expect(again.failed).toBe(false);
    expect(again.failure).toBeNull();
  });
});
