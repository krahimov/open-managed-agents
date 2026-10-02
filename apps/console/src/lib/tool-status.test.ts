import { describe, expect, it } from "vitest";
import { buildToolCallIndex } from "./tool-status";
import type { Event } from "./events";

const user = { type: "user.message", content: [{ type: "text", text: "go" }] };
const askBash = (id: string) => ({ type: "agent.tool_use", id, name: "bash", input: { command: "env" }, evaluated_permission: "ask" });
const custom = (id: string) => ({ type: "agent.custom_tool_use", id, name: "send_email", input: {} });
const idleRequires = (ids: string[], action_type = "tool_confirmation") => ({
  type: "session.status_idle",
  stop_reason: { type: "requires_action", action_type, event_ids: ids },
});
const idleEnd = { type: "session.status_idle", stop_reason: { type: "end_turn" } };
const running = { type: "session.status_running" };
const result = (id: string, extra: Record<string, unknown> = {}) => ({ type: "agent.tool_result", tool_use_id: id, content: "out", ...extra });

const index = (events: unknown[]) => buildToolCallIndex(events as Event[]);

describe("buildToolCallIndex", () => {
  it("marks an ask-gated call awaiting approval while the session idles on requires_action", () => {
    const idx = index([user, askBash("c1"), idleRequires(["c1"])]);
    expect(idx.info("c1").status).toBe("awaiting_approval");
    expect([...idx.awaiting]).toEqual([["c1", "tool_confirmation"]]);
  });

  it("marks a custom tool call as waiting for the client result", () => {
    const idx = index([user, custom("t1"), idleRequires(["t1"], "custom_tool_result")]);
    expect(idx.info("t1").status).toBe("awaiting_client");
  });

  it("tells custom and ask-gated calls apart in a mixed requires_action turn", () => {
    const idx = index([user, custom("t1"), askBash("c1"), idleRequires(["t1", "c1"], "custom_tool_result")]);
    expect(idx.info("t1").status).toBe("awaiting_client");
    expect(idx.info("c1").status).toBe("awaiting_approval");
  });

  it("falls back to structurally waiting calls when event_ids are missing", () => {
    const idx = index([user, askBash("c1"), { type: "session.status_idle", stop_reason: { type: "requires_action" } }]);
    expect(idx.info("c1").status).toBe("awaiting_approval");
  });

  it("moves to responded after the confirmation, and to completed with the result", () => {
    const confirm = { type: "user.tool_confirmation", tool_use_id: "c1", result: "allow" };
    expect(index([user, askBash("c1"), idleRequires(["c1"]), confirm]).info("c1").status).toBe("responded");
    expect(index([user, askBash("c1"), idleRequires(["c1"]), confirm, running, result("c1"), idleEnd]).info("c1").status).toBe("completed");
  });

  it("renders denied calls as denied even when the result lacks is_error", () => {
    const deny = { type: "user.tool_confirmation", tool_use_id: "c1", result: "deny", deny_message: "not now" };
    const info = index([user, askBash("c1"), idleRequires(["c1"]), deny, running, result("c1", { content: "Denied: not now" }), idleEnd]).info("c1");
    expect(info.status).toBe("denied");
    expect(info.denyMessage).toBe("not now");
  });

  it("treats is_error results (tool errors, recovery placeholders) as failed", () => {
    const placeholder = result("c1", {
      is_error: true,
      content: "The platform restarted while this tool was running; it MAY have taken effect.",
    });
    expect(index([user, { type: "agent.tool_use", id: "c1", name: "bash", input: {} }, placeholder]).info("c1").status).toBe("failed");
    expect(index([user, { type: "agent.mcp_tool_use", id: "m1", name: "x", input: {} }, { type: "agent.mcp_tool_result", mcp_tool_use_id: "m1", content: "boom", is_error: true }]).info("m1").status).toBe("failed");
  });

  it("drops the awaiting state once the session runs again or a later turn ends", () => {
    expect(index([user, askBash("c1"), idleRequires(["c1"]), running]).info("c1").status).toBe("running");
    expect(index([user, askBash("c1"), idleRequires(["c1"]), running, idleEnd]).awaiting.size).toBe(0);
  });
});
