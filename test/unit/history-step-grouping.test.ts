// @ts-nocheck
// Step grouping in the history projection (QA F4). Write-ahead tool
// execution persists each tool_result as soon as its tool finishes, so the
// results of parallel calls can land between the tool_use events of the same
// model step. The projection must still yield, per step, ONE assistant
// message with every call followed by ONE tool message with every result —
// a result must never precede its call.
import { describe, it, expect } from "vitest";
import { eventsToMessages, eventsToMessagesAsync } from "../../apps/agent/src/runtime/history";
import type { SessionEvent } from "@open-managed-agents/shared";

const USER = { type: "user.message", content: [{ type: "text", text: "read three files" }] };
const use = (id: string, step: string | null = "step1") => ({
  type: "agent.tool_use",
  id,
  name: "read",
  input: { path: id },
  ...(step ? { model_request_start_id: step } : {}),
});
const result = (id: string) => ({ type: "agent.tool_result", tool_use_id: id, content: `ok ${id}` });
const text = (t: string, step: string | null = "step1") => ({
  type: "agent.message",
  content: [{ type: "text", text: t }],
  ...(step ? { model_request_start_id: step } : {}),
});
const thinking = (t: string, step = "step1") => ({ type: "agent.thinking", text: t, model_request_start_id: step });

// Run both projections; the async one only diverges from the sync path
// when a resolver is supplied, so pass a no-op resolver to exercise it.
async function project(events: unknown[]) {
  const sync = eventsToMessages(events as SessionEvent[]);
  const async = await eventsToMessagesAsync(events as SessionEvent[], async () => null);
  expect(async).toEqual(sync);
  return sync;
}

const shape = (msgs) =>
  msgs.map((m) =>
    m.role === "user"
      ? "user"
      : `${m.role}(${m.content.map((p) => p.toolCallId ?? (p.type === "text" ? `text:${p.text}` : p.type)).join(",")})`,
  );

/** Every tool-result must reference a call made in the immediately preceding assistant message. */
function expectResultsFollowCalls(msgs) {
  msgs.forEach((m, i) => {
    if (m.role !== "tool") return;
    const prev = msgs[i - 1];
    expect(prev?.role).toBe("assistant");
    const calls = new Set(prev.content.filter((p) => p.type === "tool-call").map((p) => p.toolCallId));
    for (const r of m.content) expect(calls.has(r.toolCallId)).toBe(true);
  });
}

describe("history projection — step grouping with interleaved results", () => {
  it("QA F4 reproducer: use A, result A, use B, use C, result B, result C", async () => {
    const msgs = await project([USER, use("a"), result("a"), use("b"), use("c"), result("b"), result("c")]);
    expect(shape(msgs)).toEqual(["user", "assistant(a,b,c)", "tool(a,b,c)"]);
    expectResultsFollowCalls(msgs);
  });

  it("results arriving in arbitrary order stay in one tool message after all calls", async () => {
    const orders = [
      [use("a"), use("b"), use("c"), result("c"), result("a"), result("b")],
      [use("a"), result("a"), use("b"), result("b"), use("c"), result("c")],
      [use("a"), use("b"), result("b"), use("c"), result("c"), result("a")],
      [use("a"), use("b"), result("a"), result("b"), use("c"), result("c")],
    ];
    for (const order of orders) {
      const msgs = await project([USER, ...order]);
      expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
      expect(msgs[1].content.map((p) => p.toolCallId)).toEqual(["a", "b", "c"]);
      expect(msgs[2].content.map((p) => p.toolCallId).sort()).toEqual(["a", "b", "c"]);
      expectResultsFollowCalls(msgs);
    }
  });

  it("thinking + text + calls of one step stay together around early results", async () => {
    const msgs = await project([
      USER,
      thinking("plan"),
      text("Looking"),
      use("a"),
      result("a"),
      text("and also"),
      use("b"),
      result("b"),
    ]);
    expect(shape(msgs)).toEqual([
      "user",
      "assistant(reasoning,text:Looking,a,text:and also,b)",
      "tool(a,b)",
    ]);
    expectResultsFollowCalls(msgs);
  });

  it("two consecutive steps project to two assistant/tool pairs", async () => {
    const msgs = await project([
      USER,
      use("a", "step1"),
      result("a"),
      use("b", "step1"),
      result("b"),
      use("c", "step2"),
      use("d", "step2"),
      result("d"),
      result("c"),
      text("done", "step3"),
    ]);
    expect(shape(msgs)).toEqual([
      "user",
      "assistant(a,b)",
      "tool(a,b)",
      "assistant(c,d)",
      "tool(d,c)",
      "assistant(text:done)",
    ]);
    expectResultsFollowCalls(msgs);
  });

  it("a user message closes the open step", async () => {
    const msgs = await project([USER, use("a"), result("a"), USER, use("b", "step2"), result("b")]);
    expect(shape(msgs)).toEqual(["user", "assistant(a)", "tool(a)", "user", "assistant(b)", "tool(b)"]);
  });

  it("legacy events without step ids keep the old grouping", async () => {
    const msgs = await project([
      USER,
      use("a", null),
      result("a"),
      use("b", null),
      use("c", null),
      result("b"),
      result("c"),
      text("done", null),
    ]);
    expect(shape(msgs)).toEqual([
      "user",
      "assistant(a)",
      "tool(a)",
      "assistant(b,c)",
      "tool(b,c)",
      "assistant(text:done)",
    ]);
  });
});
