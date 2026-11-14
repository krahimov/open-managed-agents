import { describe, expect, it } from "vitest";

import type { OperationsReport } from "@/lib/operations";
import type { OpenRequest } from "@/lib/session-state";

import { buildOperationsView } from "./model";

const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const DAY = 24 * 60 * 60_000;

type Row = OperationsReport["sessions"][number];
const session = (id: string, status: string, lastMsAgo: number, more: Partial<Row> = {}): Row => ({
  id,
  title: id,
  agent_id: "agent_1",
  status,
  updated_at: NOW - lastMsAgo,
  last_event_at: iso(lastMsAgo),
  error: null,
  pending_approvals: [],
  ...more,
});
const report = (sessions: Row[], missions: OperationsReport["missions"] = []): OperationsReport => ({
  sessions,
  missions,
  work_items: [],
  usage: { totals: { cost_usd: 0, processed_tokens: 0, sessions: 0 } },
  budgets: [],
  truncated: false,
});
const view = (r: OperationsReport, requests?: Map<string, OpenRequest[]>) => buildOperationsView(r, new Map(), [], requests, NOW);

describe("what is running now", () => {
  it("counts a run until done and the session of its iteration once", () => {
    // The council's case: three sessions at work, one of them a run's iteration.
    const v = view(
      report(
        [session("s1", "running", 4000), session("s2", "running", 9000), session("iter3", "running", 2000)],
        [{ id: "mis-1", goal: "Migrate the routes", status: "running", iteration: 3, active_session_id: "iter3", updated_at: NOW }],
      ),
    );
    expect(v.running).toHaveLength(3);
    expect(v.runningNow).toBe(3);
    expect(v.idleMissions).toEqual([]);
    expect(v.running.find((r) => r.key === "iter3")?.mission?.id).toBe("mis-1");
  });

  it("still counts a run that has no session at work (between iterations)", () => {
    const v = view(
      report([session("s1", "running", 4000)], [{ id: "mis-1", goal: "g", status: "running", iteration: 2, active_session_id: null, updated_at: NOW }]),
    );
    expect(v.runningNow).toBe(2);
    expect(v.idleMissions.map((m) => m.id)).toEqual(["mis-1"]);
  });

  it("keeps sessions that have gone silent out of the count, under their own heading", () => {
    // The seed: one "running" and one "retrying" session, silent for days.
    const v = view(report([session("quiet", "running", 5 * DAY), session("retry", "rescheduling", 9 * DAY), session("live", "running", 3000)]));
    expect(v.running.map((r) => r.key)).toEqual(["live"]);
    expect(v.stalled.map((r) => r.key)).toEqual(["quiet", "retry"]);
    expect(v.runningNow).toBe(1);
    expect(v.stalled.map((r) => r.reading.label)).toEqual(["Stalled", "Stalled"]);
    expect(v.stalled[0].reading.detail).toBe("No activity for 5d");
    // A retrying session that is still active reads "Retrying" here as everywhere.
    expect(view(report([session("r", "rescheduling", 60_000)])).running[0].reading).toMatchObject({ label: "Retrying", detail: "Retrying after a failure" });
  });
});

describe("what is waiting on a person", () => {
  const approval = { tool_use_id: "t1", name: "bash", input: { command: "ls" }, requested_at: NOW - 1000 };
  const open: OpenRequest[] = [
    { kind: "access", key: "a1", name: "HubSpot", at: NOW - 180_000 },
    { kind: "access", key: "a2", name: "Retell", at: NOW - 170_000 },
    { kind: "skill", key: "s1", name: "Word documents", at: NOW - 160_000 },
  ];

  it("counts open access and skill requests with approvals, in one number", () => {
    const r = report([session("asks", "idle", 180_000), session("approve", "idle", 1000, { pending_approvals: [approval] })]);
    const without = view(r);
    expect(without.requests).toEqual([]);
    expect(without.attention).toBe(1);

    const v = view(r, new Map([["asks", open]]));
    expect(v.requests).toHaveLength(1);
    expect(v.requests[0]).toMatchObject({ key: "asks", at: NOW - 180_000 });
    expect(v.requests[0].reading).toMatchObject({ label: "Waiting on you", detail: "Waiting on you: 2 access requests and 1 skill request" });
    expect(v.waitingOnYou).toBe(4);
    expect(v.attention).toBe(4);
    expect(v.queueSize).toBe(4);
  });

  it("does not wait on a session that has ended", () => {
    const v = view(report([session("gone", "terminated", 1000)]), new Map([["gone", open]]));
    expect(v.requests).toEqual([]);
    expect(v.waitingOnYou).toBe(0);
  });
});

describe("one session, one explanation of its failure", () => {
  const RAW = "No output generated. Check the stream for errors.";
  const QUOTA = "429 insufficient_quota: You exceeded your current quota";
  const failedReport = (): OperationsReport => ({
    ...report([session("ended", "terminated", 60_000, { error: RAW }), session("work", "idle", 60_000, { error: RAW })]),
    work_items: [
      { id: "sw_1", sessionId: "work", agentId: "agent_1", status: "failed", attempts: 1, lastError: RAW, createdAt: iso(60_000), updatedAt: iso(60_000) },
    ] as unknown as OperationsReport["work_items"],
  });

  it("reads the cause from the session's log when it is known, for failed work and for sessions that ended on an error", () => {
    const causes = new Map([
      ["ended", QUOTA],
      ["work", QUOTA],
    ]);
    const v = buildOperationsView(failedReport(), new Map(), [], undefined, NOW, causes);
    expect(v.ended.map((e) => e.error)).toEqual([QUOTA]);
    expect(v.failures.map((f) => f.error)).toEqual([QUOTA]);
  });

  it("falls back to the report's words when the log has not been read", () => {
    const v = buildOperationsView(failedReport(), new Map(), [], undefined, NOW);
    expect(v.ended[0].error).toBe(RAW);
    expect(v.failures[0].error).toBe(RAW);
  });
});
