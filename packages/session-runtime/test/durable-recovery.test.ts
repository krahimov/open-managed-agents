// Durable-execution recovery policy (docs/durable-execution.md).
//
// Simulates a crash between the write-ahead `agent.tool_use` persist and
// the `agent.tool_result` persist, then checks recovery resolves each
// orphan by its execution class.

import { describe, it, expect } from "vitest";
import {
  InMemoryEventLog,
  InMemoryStreamRepo,
} from "@open-managed-agents/event-log/memory";
import type { SessionEvent } from "@open-managed-agents/shared";
import { recoverInterruptedState } from "../src/recovery";
import {
  classifyTool,
  executionClassOf,
  findOrphanToolUses,
  idempotencyKeyFor,
} from "../src/tool-classification";

function fixture(events: unknown[]) {
  const log = new InMemoryEventLog(() => {});
  for (const e of events) log.append(e as SessionEvent);
  return { log, streams: new InMemoryStreamRepo(), all: () => log.getEvents() as unknown as Array<Record<string, unknown>> };
}

const KEY = "sess-1:toolu_1";

describe("classifyTool", () => {
  it("classifies built-ins, MCP annotations and client tools", () => {
    expect(classifyTool("read")).toBe("idempotent");
    expect(classifyTool("grep")).toBe("idempotent");
    expect(classifyTool("web_fetch")).toBe("idempotent");
    expect(classifyTool("list_schedules")).toBe("idempotent");
    expect(classifyTool("bash")).toBe("side_effect");
    expect(classifyTool("write")).toBe("side_effect");
    expect(classifyTool("edit")).toBe("side_effect");
    expect(classifyTool("schedule")).toBe("side_effect");
    expect(classifyTool("cancel_schedule")).toBe("side_effect");
    expect(classifyTool("call_agent_x")).toBe("side_effect");
    expect(classifyTool("mcp__github__create_issue")).toBe("side_effect");
    expect(classifyTool("mcp__github__get_issue", { annotations: { readOnlyHint: true } })).toBe("idempotent");
    expect(classifyTool("mcp__kv__put", { annotations: { idempotentHint: true } })).toBe("idempotent");
    expect(classifyTool("mcp__kv__del", { annotations: { destructiveHint: true } })).toBe("side_effect");
    expect(classifyTool("read", { hasExecute: false })).toBe("client");
    expect(classifyTool("send_email", { hasExecute: false })).toBe("client");
  });

  it("idempotency key = sessionId:toolCallId", () => {
    expect(idempotencyKeyFor("sess-1", "toolu_1")).toBe(KEY);
    expect(idempotencyKeyFor(undefined, "toolu_1")).toBe("toolu_1");
  });

  it("event class: stamped class wins; ask-permission and custom are client", () => {
    expect(executionClassOf({ type: "agent.tool_use", name: "bash", execution_class: "idempotent" })).toBe("idempotent");
    expect(executionClassOf({ type: "agent.tool_use", name: "bash", evaluated_permission: "ask" })).toBe("client");
    expect(executionClassOf({ type: "agent.custom_tool_use", name: "x" })).toBe("client");
    expect(executionClassOf({ type: "agent.custom_tool_use", name: "browser_click", execution_class: "side_effect" })).toBe("side_effect");
    expect(executionClassOf({ type: "agent.mcp_tool_use", name: "mcp__a__b" })).toBe("side_effect");
    expect(executionClassOf({ type: "agent.tool_use", name: "glob" })).toBe("idempotent");
  });
});

describe("recoverInterruptedState — crash between tool_use and tool_result", () => {
  it("side_effect orphan → is_error result: may have taken effect, verify, carries idempotency key", async () => {
    const f = fixture([
      { type: "user.message", content: [{ type: "text", text: "deploy" }] },
      { type: "agent.tool_use", id: "toolu_1", name: "bash", input: { command: "git push" },
        idempotency_key: KEY, execution_class: "side_effect", session_thread_id: "sthr_primary" },
    ]);
    const report = await recoverInterruptedState(f.streams, f.log);
    expect(report.injectedToolResults).toEqual(["toolu_1"]);
    const result = f.all()[2];
    expect(result).toMatchObject({
      type: "agent.tool_result",
      tool_use_id: "toolu_1",
      is_error: true,
      parent_event_id: "toolu_1",
      session_thread_id: "sthr_primary",
    });
    expect(result.content).toMatch(/MAY have taken effect/);
    expect(result.content).toMatch(/Verify the current state/);
    expect(result.content).toContain(KEY);
    expect(report.recoveredToolCalls).toEqual([
      expect.objectContaining({ tool_use_id: "toolu_1", execution_class: "side_effect", action: "injected_unknown_outcome", idempotency_key: KEY }),
    ]);
    expect(report.warnings[0]).toMatchObject({ source: "tool_call_interrupted", details: { action: "injected_unknown_outcome", idempotency_key: KEY } });
  });

  it("MCP side_effect orphan → is_error mcp_tool_result", async () => {
    const f = fixture([
      { type: "agent.mcp_tool_use", id: "m1", name: "mcp__linear__create_issue", mcp_server_name: "linear", input: {},
        idempotency_key: "sess-1:m1", execution_class: "side_effect" },
    ]);
    const report = await recoverInterruptedState(f.streams, f.log);
    expect(report.injectedMcpToolResults).toEqual(["m1"]);
    expect(f.all()[1]).toMatchObject({ type: "agent.mcp_tool_result", mcp_tool_use_id: "m1", is_error: true });
    expect(f.all()[1].content).toContain("sess-1:m1");
  });

  it("idempotent orphan (default) → 'safe to re-run' is_error result", async () => {
    const f = fixture([
      { type: "agent.tool_use", id: "r1", name: "read", input: { file_path: "/a" }, execution_class: "idempotent", idempotency_key: "k:r1" },
    ]);
    const report = await recoverInterruptedState(f.streams, f.log);
    expect(report.injectedToolResults).toEqual(["r1"]);
    expect(report.pendingReexecution).toEqual([]);
    expect(f.all()[1]).toMatchObject({ type: "agent.tool_result", tool_use_id: "r1", is_error: true });
    expect(f.all()[1].content).toMatch(/safe to call it again/);
    expect(report.recoveredToolCalls[0].action).toBe("injected_retry_safe");
  });

  it("idempotent orphan with deferIdempotent → left unresolved for harness re-execution", async () => {
    const f = fixture([
      { type: "agent.tool_use", id: "r1", name: "read", input: {}, execution_class: "idempotent" },
      { type: "agent.tool_use", id: "b1", name: "bash", input: {}, execution_class: "side_effect" },
    ]);
    const report = await recoverInterruptedState(f.streams, f.log, { deferIdempotent: true });
    expect(report.pendingReexecution).toEqual(["r1"]);
    expect(report.injectedToolResults).toEqual(["b1"]);
    expect(findOrphanToolUses(f.log.getEvents()).map((o) => o.tool_use_id)).toEqual(["r1"]);
  });

  it("client orphans (custom tool, ask-permission) are never fabricated", async () => {
    const f = fixture([
      { type: "agent.custom_tool_use", id: "c1", name: "send_email", input: {}, execution_class: "client" },
      { type: "agent.tool_use", id: "a1", name: "bash", input: {}, evaluated_permission: "ask" },
    ]);
    const report = await recoverInterruptedState(f.streams, f.log);
    expect(report.pendingCustomToolUses).toEqual(["c1", "a1"]);
    expect(f.all()).toHaveLength(2);
  });

  it("is idempotent across repeated recovery passes", async () => {
    const f = fixture([{ type: "agent.tool_use", id: "b1", name: "bash", input: {} }]);
    await recoverInterruptedState(f.streams, f.log);
    const again = await recoverInterruptedState(f.streams, f.log);
    expect(again.injectedToolResults).toEqual([]);
    expect(f.all()).toHaveLength(2);
  });
});
