import { describe, expect, it } from "vitest";

import type { OperationsReport } from "@/lib/operations";
import type { OpenRequest } from "@/lib/session-state";

import type { SessionRecord } from "../../types/session";
import { buildOperationsView } from "../operations/model";
import { finishedSessions } from "./SinceLastVisit";

const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const RAW = "No output generated. Check the stream for errors.";
const KEY = "401 invalid x-api-key";

type Row = OperationsReport["sessions"][number];
const row = (id: string, status: string, more: Partial<Row> = {}): Row => ({
  id,
  title: id,
  agent_id: "agent_1",
  status,
  updated_at: NOW - 60_000,
  last_event_at: iso(60_000),
  error: null,
  pending_approvals: [],
  ...more,
});
const record = (id: string, status: string): SessionRecord => ({
  id,
  title: id,
  agent: { id: "agent_1", version: 1, name: "Support Triage" },
  environment_id: "env_1",
  status,
  created_at: iso(120_000),
  updated_at: iso(60_000),
});
const report = (sessions: Row[]): OperationsReport => ({
  sessions,
  missions: [],
  work_items: [],
  usage: { totals: { cost_usd: 0, processed_tokens: 0, sessions: 0 } },
  budgets: [],
  truncated: false,
});

describe("Since you were last here", () => {
  it("says why a session failed in its page's words, not the runtime's", () => {
    const r = report([row("failed", "idle", { error: RAW })]);
    const sessions = [record("failed", "idle")];
    const causes = new Map([["failed", KEY]]);
    const view = buildOperationsView(r, new Map(), sessions, undefined, NOW, causes);
    const out = finishedSessions({ sessions, view, report: r.sessions, agents: new Map(), since: null, causes });
    expect(out.map((f) => f.error)).toEqual([KEY]);
  });

  it("uses the cause even when there is no view yet", () => {
    const r = report([row("failed", "idle", { error: RAW })]);
    const sessions = [record("failed", "idle")];
    const out = finishedSessions({ sessions, view: null, report: r.sessions, agents: new Map(), since: null, causes: new Map([["failed", KEY]]) });
    expect(out[0].error).toBe(KEY);
  });

  it("leaves out a session waiting on a request, or one whose state is unknown: Needs attention lists those", () => {
    const r = report([row("asks", "idle"), row("unread", "idle"), row("done", "idle")]);
    const sessions = [record("asks", "idle"), record("unread", "idle"), record("done", "idle")];
    const requests = new Map<string, OpenRequest[]>([["asks", [{ kind: "access", key: "req_1", name: "HubSpot", at: NOW - 90_000 }]]]);
    const unknown = new Map<string, "unreadable" | "too-long">([["unread", "unreadable"]]);
    const view = buildOperationsView(r, new Map(), sessions, requests, NOW, undefined, unknown);
    const out = finishedSessions({ sessions, view, report: r.sessions, agents: new Map(), since: null });
    expect(out.map((f) => f.session.id)).toEqual(["done"]);
  });
});
