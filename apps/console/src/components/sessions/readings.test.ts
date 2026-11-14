import { describe, expect, it } from "vitest";

import type { OperationsReport } from "@/lib/operations";

import { foldApprovals, logCandidates, logReport, REQUEST_WINDOW } from "./readings";

const row = (id: string, extra: Partial<OperationsReport["sessions"][number]> = {}) =>
  ({ id, title: id, agent_id: "a", status: "idle", updated_at: 1_800_000_000_000, last_event_at: "2026-11-10T10:00:00Z", error: null, pending_approvals: [], ...extra }) as OperationsReport["sessions"][number];
const report = (sessions: OperationsReport["sessions"], work_items: unknown[] = []) =>
  ({ sessions, work_items, missions: [], budgets: [], usage: {}, truncated: false }) as unknown as OperationsReport;

describe("which sessions the lists read the logs of", () => {
  it("reads the ones that can still be answered, newest first, within the report's window", () => {
    const got = logCandidates(
      report([row("old", { last_event_at: "2026-11-01T10:00:00Z" }), row("new", { last_event_at: "2026-11-10T10:00:00Z" })]),
      [{ id: "archived", status: "idle", archived_at: "2026-11-02T00:00:00Z" }, { id: "ended", status: "terminated" }],
    );
    expect(got.map((c) => c.id)).toEqual(["new", "old"]);
    const many = report(Array.from({ length: 150 }, (_, i) => row(`s${i}`)));
    expect(logCandidates(many, [])).toHaveLength(REQUEST_WINDOW);
  });

  it("also reads an ended session that failed, for its cause, and marks every failed one", () => {
    const got = logCandidates(
      report(
        [row("ended-failed", { status: "terminated", error: "No output generated. Check the stream for errors." }), row("work", {})],
        [{ id: "w1", sessionId: "work", status: "failed" }],
      ),
      [],
    );
    expect(got.find((c) => c.id === "ended-failed")?.needFailure).toBe(true);
    expect(got.find((c) => c.id === "work")?.needFailure).toBe(true);
  });

  it("knows a session has something new by its newest event", () => {
    const a = logCandidates(report([row("s", { last_event_at: "2026-11-10T10:00:00Z" })]), [])[0];
    const b = logCandidates(report([row("s", { last_event_at: "2026-11-10T10:05:00Z" })]), [])[0];
    expect(a.stamp).not.toBe(b.stamp);
  });
});

describe("approvals read from a session's log, where the server has no report", () => {
  const use = (id: string, name = "bash", input: unknown = { command: "rm -rf build" }) =>
    ({ type: "agent.tool_use", id, name, input, processed_at: "2026-11-10T10:00:00Z" }) as never;
  const idle = (event_ids: string[], action_type = "tool_confirmation") =>
    ({ type: "session.status_idle", stop_reason: { type: "requires_action", action_type, event_ids }, processed_at: "2026-11-10T10:00:01Z" }) as never;

  it("is waiting on the calls the turn ended asking about, with their names and inputs", () => {
    const asked = foldApprovals([], [use("t1"), use("t2", "send_email", { to: "a@b.test" }), idle(["t1", "t2"])]);
    expect(asked.map((a) => [a.tool_use_id, a.name])).toEqual([["t1", "bash"], ["t2", "send_email"]]);
    expect(asked[0].input).toEqual({ command: "rm -rf build" });
    expect(asked[0].requested_at).toBe(Date.parse("2026-11-10T10:00:00Z"));
  });

  it("drops a call once it is confirmed or has a result, and all of them when the session moves on", () => {
    const asked = foldApprovals([], [use("t1"), use("t2"), idle(["t1", "t2"])]);
    expect(foldApprovals(asked, [{ type: "user.tool_confirmation", tool_use_id: "t1", result: "allow" } as never]).map((a) => a.tool_use_id)).toEqual(["t2"]);
    expect(foldApprovals(asked, [{ type: "agent.tool_result", tool_use_id: "t2" } as never]).map((a) => a.tool_use_id)).toEqual(["t1"]);
    expect(foldApprovals(asked, [{ type: "session.status_running" } as never])).toEqual([]);
    expect(foldApprovals(asked, [{ type: "session.status_idle", stop_reason: { type: "end_turn" } } as never])).toEqual([]);
  });

  it("does not count a custom tool's call: a program answers it, not a person", () => {
    const custom = { type: "agent.custom_tool_use", id: "c1", name: "lookup", input: {} } as never;
    expect(foldApprovals([], [custom, idle(["c1"], "custom_tool_result")])).toEqual([]);
    // Asked for without the call in what was read: the action type decides.
    expect(foldApprovals([], [idle(["c9"], "custom_tool_result")])).toEqual([]);
    expect(foldApprovals([], [idle(["t9"])]).map((a) => a.name)).toEqual(["a tool"]);
  });

  it("names a deferred MCP call by its real tool", () => {
    const deferred = use("m1", "call_mcp_tool", { name: "mcp__linear__create_issue", arguments: { title: "Bug" } });
    const [asked] = foldApprovals([], [deferred, idle(["m1"])]);
    expect(asked.name).toBe("create_issue");
    expect(asked.input).toEqual({ title: "Bug" });
  });
});

describe("the stand-in report built from the logs", () => {
  const session = (id: string, extra: Record<string, unknown> = {}) =>
    ({ id, title: null, agent: { id: "agent_1", version: 1 }, environment_id: "env", status: "idle", created_at: "2026-11-10T09:00:00Z", ...extra }) as never;

  it("has a row for each session whose log was read, with what it said, and nothing it cannot know", () => {
    const got = logReport([session("read"), session("unread"), session("gone", { archived_at: "2026-11-10T00:00:00Z" })], {
      approvals: new Map([["read", [{ tool_use_id: "t1", name: "bash", input: {}, requested_at: 1 }]]]),
      failures: new Map([["read", "The provider rejected the key"]]),
      lastEventAt: new Map([["read", 1_800_000_000_000], ["gone", 1]]),
    });
    expect(got.sessions.map((s) => s.id)).toEqual(["read"]);
    expect(got.sessions[0]).toMatchObject({ agent_id: "agent_1", last_event_at: 1_800_000_000_000, error: "The provider rejected the key" });
    expect(got.sessions[0].pending_approvals).toHaveLength(1);
    expect(got.work_items).toEqual([]);
    expect(got.budgets).toEqual([]);
    expect(got.truncated).toBe(false);
  });

  it("says it covers only the recent window once the window is full", () => {
    const many = Array.from({ length: REQUEST_WINDOW }, (_, i) => session(`s${i}`));
    expect(logReport(many, { approvals: new Map(), failures: new Map(), lastEventAt: new Map() }).truncated).toBe(true);
  });
});
