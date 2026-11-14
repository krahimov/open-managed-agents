import { describe, expect, it } from "vitest";

import type { OperationsReport } from "@/lib/operations";

import { logCandidates, REQUEST_WINDOW } from "./readings";

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
