import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { useApi } from "@/lib/api";
import { unwrapCallMcpTool } from "@/lib/deferred-mcp";
import { useAgentActivity, useOperations, useRecentSessions, type AgentActivity } from "@/lib/directory";
import type { Event } from "@/lib/events";
import { readFailure } from "@/lib/failures";
import { toDate } from "@/lib/format";
import type { OperationsReport } from "@/lib/operations";
import { readSession, type OpenRequest, type SessionReading } from "@/lib/session-state";
import type { SessionRecord } from "@/types/session";

import { failureText, normalize, openOf, readSessionLog, type EventsPage, type LogState, type ReadBudget } from "./log-reading";
import { eventTime } from "./model";
import { requestsPending } from "./requests";

/**
 * What the console knows about every recent session, gathered once, so any
 * screen can ask for the one reading of a session (`lib/session-state.ts`)
 * and get the same answer as every other screen.
 *
 *   the operations report   status, the time of the newest event, tool
 *                           calls waiting for approval, that a turn failed
 *   each session's log      unanswered access and skill requests, and why a
 *                           failed turn failed in the session page's words.
 *                           No report carries those (`log-reading.ts`).
 *
 * A request stays open however long the conversation runs on after it, so
 * a fixed tail is not enough: an access request followed by fifty thinking
 * events would drop out of every count while its own page said "Needs
 * access". Each session is read backward until every request is settled
 * (a person's reply or the session's end settles all before it), and then
 * only forward from where that read stopped.
 *
 * The budget, and why:
 *
 *   which sessions  those that can still be answered (not ended, not
 *                   archived) among the 100 most recently active: the
 *                   report's window. An ended one only when the report says
 *                   it failed, for the cause (its log no longer changes).
 *   first ask       the newest 40 events: enough for almost every session,
 *                   whose last message from a person is recent.
 *   then            pages of 200 backward, up to 2,000 events in all. Past
 *                   that (a long unattended run with no reply in it), the
 *                   session's requests are "not known", said as such, rather
 *                   than guessed; requests found in what was read still count.
 *   later reads     only events newer than the last one read (`after_seq`),
 *                   when the report says the session has something new.
 *   at once         four sessions at a time.
 *
 * What was read is kept for the tab (and across a reload), so a session is
 * read back once. A session whose events could not be read is "not known"
 * on every screen (never "Idle", never left out of a count without saying
 * so) and is asked for again on the next round, or on Try again.
 *
 * A server without the operations report (`useServerFeature("operations")`
 * is off) still has every session's log. The same reads then also say what
 * the report would have: which tool calls wait for a person's approval (the
 * newest `session.status_idle` that `requires_action`, less the calls
 * answered since) and when the session last recorded anything. From those
 * and the recent sessions `logReport` builds a stand-in report, so every
 * screen reads a session the same way on either server. It knows nothing
 * of queued work, runs or budgets, and says so by leaving them empty.
 */

/** Sessions whose logs are read for open requests: the report's window. */
export const REQUEST_WINDOW = 100;
export const LOG_BUDGET: ReadBudget = { tail: 40, page: 200, most: 2000 };
const AT_ONCE = 4;
/** How often sessions that could not be read are asked for again. */
const RETRY_UNKNOWN_MS = 30_000;
// v3: entries also keep the approvals and the newest time.
const STORE = "muse:session-log:v3";

type ReportSession = OperationsReport["sessions"][number];

interface Candidate {
  id: string;
  /** Changes when the session records something new. */
  stamp: string;
  /** The report says its last turn failed: read why, as its page does. */
  needFailure: boolean;
}

/** Why a session's requests are not known. */
export type Unknown = "unreadable" | "too-long";

/** A tool call waiting for a person's approval, as the log says it (the report's shape). */
export type AskedApproval = OperationsReport["sessions"][number]["pending_approvals"][number];

interface Known {
  stamp: string;
  state: LogState;
  /** Tool calls waiting for approval as of `state.seq` (older entries have none). */
  asked?: AskedApproval[];
  /** When the newest event read was recorded. */
  lastAt?: number | null;
  /** Set when the read stopped short of settling every request. */
  partial?: boolean;
  /** The read stopped at the budget: not asked again until the session records something new. */
  exhausted?: boolean;
}

// ── what has been read, by session, for the life of the tab ─────────────

const read = new Map<string, Known>();
let restored = false;

function restore() {
  if (restored) return;
  restored = true;
  try {
    const raw = sessionStorage.getItem(STORE);
    if (!raw) return;
    for (const [id, entry] of Object.entries(JSON.parse(raw) as Record<string, Known>)) {
      if (entry && typeof entry.stamp === "string" && entry.state && Array.isArray(entry.state.pending) && typeof entry.state.seq === "number") {
        read.set(id, entry);
      }
    }
  } catch {
    // unreadable storage: read the logs again
  }
}

function persist(keep: Set<string>) {
  try {
    const out: Record<string, Known> = {};
    for (const [id, entry] of read) if (keep.has(id)) out[id] = entry;
    sessionStorage.setItem(STORE, JSON.stringify(out));
  } catch {
    // storage unavailable: nothing is lost but a few reads on reload
  }
}

/** Run `task` over `items`, at most `limit` at a time, in order. */
async function pooled<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await task(items[next++]);
    }),
  );
}

const ms = (value: string | number | null | undefined): number | null => toDate(value)?.getTime() ?? null;

export interface LogReadings {
  /** Open access and skill requests, by session. */
  open: Map<string, OpenRequest[]>;
  /** Tool calls waiting for approval, by session, read from the log. */
  approvals: Map<string, AskedApproval[]>;
  /** When each session whose log was read last recorded anything (null: nothing yet). */
  lastEventAt: Map<string, number | null>;
  /** Sessions whose requests are not known, and why. */
  unknown: Map<string, Unknown>;
  /** Why a failed turn failed, by session, as the session page reads it (`readFailure` input). */
  failures: Map<string, string>;
}

const TOOL_USES = new Set(["agent.tool_use", "agent.mcp_tool_use", "agent.custom_tool_use"]);

/**
 * The tool calls a session waits on a person to approve, folded over events
 * (oldest first) onto what was known. The runtime asks in the
 * `session.status_idle` that ends a turn (`stop_reason.requires_action`,
 * the tool calls in `event_ids`); a confirmation or a result answers one, and
 * the session starting, ending or ending a turn some other way answers the
 * rest. A custom tool's call waits on a program, not a person: not counted.
 * Pure, for tests.
 */
export function foldApprovals(prev: readonly AskedApproval[], eventsAsc: readonly Event[]): AskedApproval[] {
  const uses = new Map<string, { name: string; input: unknown; at: number | null; custom: boolean }>();
  let asked: AskedApproval[] = [...prev];
  const answer = (id: unknown) => {
    if (typeof id === "string") asked = asked.filter((a) => a.tool_use_id !== id);
  };
  for (const e of eventsAsc) {
    if (TOOL_USES.has(e.type)) {
      if (typeof e.id !== "string") continue;
      const deferred = unwrapCallMcpTool(e.name, e.input);
      uses.set(e.id, {
        name: deferred?.tool ?? (typeof e.name === "string" && e.name ? e.name : "a tool"),
        input: deferred?.arguments ?? e.input ?? {},
        at: eventTime(e),
        custom: e.type === "agent.custom_tool_use",
      });
      continue;
    }
    switch (e.type) {
      case "session.status_idle": {
        const stop = e.stop_reason as { type?: string; action_type?: string; event_ids?: unknown } | undefined;
        if (stop?.type !== "requires_action" || !Array.isArray(stop.event_ids)) {
          asked = [];
          break;
        }
        const at = eventTime(e);
        asked = stop.event_ids.flatMap((id): AskedApproval[] => {
          if (typeof id !== "string") return [];
          const use = uses.get(id);
          // Only a custom tool's result was asked for: nobody needs to approve anything.
          if (use?.custom || (!use && stop.action_type === "custom_tool_result")) return [];
          return [{ tool_use_id: id, name: use?.name ?? "a tool", input: use?.input ?? {}, requested_at: use?.at ?? at ?? 0 }];
        });
        break;
      }
      case "session.status_running":
      case "session.status_rescheduled":
      case "session.status_terminated":
        asked = [];
        break;
      case "user.tool_confirmation":
      case "agent.tool_result":
        answer(e.tool_use_id);
        break;
      case "agent.mcp_tool_result":
        answer(e.mcp_tool_use_id);
        break;
      case "user.custom_tool_result":
        answer(e.custom_tool_use_id);
        break;
    }
  }
  return asked;
}

/**
 * A stand-in for the operations report, built from the recent sessions and
 * what their logs said, for a server that has no report. Only sessions whose
 * log was read get a row (one that was not is read from its own record, as
 * on a server with a report it would be when the report left it out).
 * Queued work, runs and budgets are not known: empty. Pure, for tests.
 */
export function logReport(
  recent: readonly SessionRecord[],
  logs: Pick<LogReadings, "approvals" | "failures" | "lastEventAt">,
  window: number = REQUEST_WINDOW,
): OperationsReport {
  const sessions: OperationsReport["sessions"] = [];
  for (const s of recent) {
    if (s.archived_at || !logs.lastEventAt.has(s.id)) continue;
    sessions.push({
      id: s.id,
      title: s.title ?? "",
      agent_id: s.agent?.id ?? "",
      status: s.status ?? "idle",
      updated_at: s.updated_at ?? s.created_at,
      last_event_at: logs.lastEventAt.get(s.id) ?? null,
      error: logs.failures.get(s.id) ?? null,
      pending_approvals: logs.approvals.get(s.id) ?? [],
    });
  }
  return {
    sessions,
    missions: [],
    work_items: [],
    usage: { totals: { cost_usd: 0, processed_tokens: 0, sessions: 0 } },
    budgets: [],
    // The recent list holds the newest sessions only: older ones are not read.
    truncated: recent.length >= window,
  };
}

/**
 * Sessions to read, newest first: the ones a person is most likely looking
 * at are read first. Pure, for tests.
 */
export function logCandidates(
  report: OperationsReport | undefined,
  recent: ReadonlyArray<{ id: string; status?: string | null; archived_at?: string | null; updated_at?: string | number | null; created_at?: string | number | null }>,
): Candidate[] {
  const out = new Map<string, Candidate & { at: number }>();
  const reported = new Map<string, ReportSession>((report?.sessions ?? []).map((s) => [s.id, s]));
  const failedWork = new Set(
    (report?.work_items ?? []).filter((w) => w.status === "failed" || w.status === "dead_letter").map((w) => w.sessionId),
  );
  const needFailure = (id: string) => !!reported.get(id)?.error || failedWork.has(id);
  for (const s of recent) {
    if (s.archived_at) continue;
    if (s.status === "terminated" && !needFailure(s.id)) continue;
    const row = reported.get(s.id);
    const at = ms(row?.last_event_at) ?? ms(s.updated_at) ?? ms(s.created_at) ?? 0;
    out.set(s.id, { id: s.id, stamp: `${row?.last_event_at ?? s.updated_at ?? s.created_at ?? ""}`, at, needFailure: needFailure(s.id) });
  }
  for (const row of report?.sessions ?? []) {
    if (out.has(row.id) || (row.status === "terminated" && !needFailure(row.id))) continue;
    out.set(row.id, {
      id: row.id,
      stamp: `${row.last_event_at ?? row.updated_at ?? ""}`,
      at: ms(row.last_event_at) ?? ms(row.updated_at) ?? 0,
      needFailure: needFailure(row.id),
    });
  }
  return [...out.values()]
    .sort((a, b) => b.at - a.at)
    .slice(0, REQUEST_WINDOW)
    .map(({ at: _at, ...c }) => c);
}

/**
 * Open access and skill requests, which sessions could not be read, and the
 * failure causes, for the sessions that can still be answered among the
 * most recently active.
 */
export function useOpenRequests() {
  const { api } = useApi();
  const ops = useOperations();
  const recent = useRecentSessions();

  const candidates = useMemo(() => logCandidates(ops.report, recent.sessions), [recent.sessions, ops.report]);
  const signature = useMemo(() => candidates.map((c) => `${c.id}@${c.stamp}${c.needFailure ? "!" : ""}`).join("|"), [candidates]);

  const query = useQuery<LogReadings>({
    queryKey: ["session-requests", signature],
    enabled: candidates.length > 0,
    staleTime: 2 * 60_000,
    retry: false,
    placeholderData: keepPreviousData,
    refetchInterval: (q) => (q.state.data?.unknown.size ? RETRY_UNKNOWN_MS : false),
    queryFn: async ({ signal }) => {
      restore();
      const failed = new Set<string>();
      const stale = candidates.filter((c) => {
        const known = read.get(c.id);
        return !known || known.stamp !== c.stamp || (c.needFailure && !known.state.failureKnown && !known.exhausted);
      });
      await pooled(stale, AT_ONCE, async (c) => {
        if (signal.aborted) return;
        const known = read.get(c.id);
        // Every event this read sees, for the approvals and the newest time
        // (the request and failure fold keeps only what it needs).
        const seen = new Map<number, Event>();
        let unnumbered = false;
        try {
          const result = await readSessionLog(
            async (q) => {
              const page = await api<EventsPage>(`/v1/sessions/${c.id}/events${q}`, { signal, silentErrors: true });
              for (const raw of Array.isArray(page?.data) ? page.data : []) {
                const e = normalize(raw);
                if (typeof e.seq === "number") seen.set(e.seq, e);
                else unnumbered = true;
              }
              return page;
            },
            known?.state ?? null,
            c.needFailure,
            LOG_BUDGET,
          );
          const events = [...seen.values()].sort((a, b) => (a.seq as number) - (b.seq as number));
          // Only what is newer than the last read is folded onto what it knew.
          const from = known?.state.seq ?? 0;
          const onTop = !!known && from > 0 && events.every((e) => (e.seq as number) > from);
          const newest = events.length ? eventTime(events[events.length - 1]) : null;
          read.set(c.id, {
            stamp: c.stamp,
            state: result.state,
            partial: result.kind === "too-long" || undefined,
            exhausted: result.exhausted || undefined,
            asked: unnumbered ? [] : foldApprovals(onTop ? (known?.asked ?? []) : [], events),
            lastAt: newest ?? known?.lastAt ?? null,
          });
        } catch {
          // What was known is for an older version of the log: it says
          // nothing certain about now. Not known, and asked again.
          if (!signal.aborted) failed.add(c.id);
        }
      });
      const keep = new Set(candidates.map((c) => c.id));
      persist(keep);
      const out: LogReadings = { open: new Map(), approvals: new Map(), lastEventAt: new Map(), unknown: new Map(), failures: new Map() };
      for (const c of candidates) {
        if (failed.has(c.id)) {
          out.unknown.set(c.id, "unreadable");
          continue;
        }
        const known = read.get(c.id);
        if (!known) continue;
        const open = openOf(known.state);
        if (open.length) out.open.set(c.id, open);
        else if (known.partial) out.unknown.set(c.id, "too-long");
        const why = failureText(known.state);
        if (why) out.failures.set(c.id, why);
        if (known.asked?.length) out.approvals.set(c.id, known.asked);
        out.lastEventAt.set(c.id, known.lastAt ?? null);
      }
      return out;
    },
  });

  // Loading until the first whole answer (see requestsPending).
  const settled = useRef(false);
  if (query.isSuccess && !query.isPlaceholderData) settled.current = true;
  const isLoading = requestsPending({
    candidates: candidates.length,
    isLoading: query.isLoading,
    isPlaceholderData: query.isPlaceholderData,
    settled: settled.current,
  });
  const { refetch } = query;
  const retry = useCallback(() => void refetch(), [refetch]);
  const data = query.data ?? EMPTY;
  return {
    bySession: data.open,
    approvals: data.approvals,
    lastEventAt: data.lastEventAt,
    unknown: data.unknown,
    failures: data.failures,
    isLoading,
    isFetching: query.isFetching,
    retry,
  };
}
const EMPTY: LogReadings = { open: new Map(), approvals: new Map(), lastEventAt: new Map(), unknown: new Map(), failures: new Map() };

/**
 * How long a count that includes the open requests waits for them before it
 * is drawn without them. On a cold tab with many sessions the tails can take
 * a while, and the report alone is worth showing by then. Counted from the
 * moment the tails are first being read (not from when the page opened, or
 * the lists they depend on would use up the wait), and once for the tab, so
 * the sidebar's badge and Home's Needs attention stop waiting together and
 * draw the same number.
 */
export const REQUESTS_PATIENCE = 1500;
let patienceFrom: number | null = null;

/** True while a count that includes the open requests should still wait for them. */
export function usePatienceForRequests(loading: boolean): boolean {
  if (loading && patienceFrom === null) patienceFrom = Date.now();
  const left = patienceFrom === null ? REQUESTS_PATIENCE : Math.max(0, patienceFrom + REQUESTS_PATIENCE - Date.now());
  const [waited, setWaited] = useState(left === 0);
  useEffect(() => {
    if (waited || !loading) return;
    const id = window.setTimeout(() => setWaited(true), left);
    return () => window.clearTimeout(id);
  }, [waited, loading, left]);
  return loading && !waited && left > 0;
}

/** What a caller knows about the session it wants read. */
export interface ReadableSession {
  id: string;
  status?: string | null;
  updated_at?: string | number | null;
}

/**
 * The reading of any session, the same on every screen.
 *
 *   const { read } = useSessionReadings();
 *   const r = read(session);          // { status, tone, label, detail, waiting, stalled }
 *   <SessionStatus reading={r} />
 *
 * `counts` is what "waiting on you" adds up to across the workspace:
 * approvals, open requests and failed work. The sidebar badge, Home's
 * "Needs attention" and Operations all show `counts.attention`, and say
 * beside it how many sessions could not be checked (`counts.unknown`).
 */
export function useSessionReadings() {
  const ops = useOperations();
  const requests = useOpenRequests();
  const recent = useRecentSessions();

  // The report the readings stand on: the server's, or on a server without
  // one, the stand-in the session logs make (see `logReport`).
  const fromLogs = ops.unsupported;
  const logs = useMemo(
    () =>
      fromLogs && recent.data
        ? logReport(recent.sessions, { approvals: requests.approvals, failures: requests.failures, lastEventAt: requests.lastEventAt })
        : undefined,
    [fromLogs, recent.data, recent.sessions, requests.approvals, requests.failures, requests.lastEventAt],
  );
  const report = ops.report ?? logs;

  const reported = useMemo(
    () => new Map<string, ReportSession>((report?.sessions ?? []).map((s) => [s.id, s])),
    [report],
  );

  const read = useCallback(
    (session: ReadableSession, more: { activity?: string | null; lastEventAt?: number | null; now?: number } = {}): SessionReading => {
      const row = reported.get(session.id);
      const status = session.status ?? row?.status;
      return readSession({
        status,
        approvals: row?.pending_approvals.length ?? 0,
        requests: requests.bySession.get(session.id),
        requestsUnknown: requests.unknown.get(session.id) ?? null,
        // The cause in the session page's words: the model's own error when the log has it.
        error: row?.error ? (readFailure(requests.failures.get(session.id) ?? row.error).cause ?? true) : null,
        // A session the report does not cover is only as fresh as its record.
        lastEventAt: more.lastEventAt ?? ms(row?.last_event_at) ?? ms(row?.updated_at) ?? ms(session.updated_at),
        activity: more.activity,
        now: more.now,
      });
    },
    [reported, requests.bySession, requests.unknown, requests.failures],
  );

  // Sessions whose state reads "State unknown": not counted as waiting, and
  // never silently left out either. One working or ended is not waiting on
  // anyone, whatever its log says, and one with a request known to be open
  // is already counted as waiting.
  const unknownIds = useMemo(
    () =>
      [...requests.unknown.keys()].filter((id) => {
        const row = reported.get(id);
        if (row && (row.status === "running" || row.status === "rescheduling" || row.status === "terminated")) return false;
        return !requests.bySession.get(id)?.length;
      }),
    [requests.unknown, requests.bySession, reported],
  );

  // Approvals as the report says them; from the logs, those of sessions that
  // can still be answered.
  const approvals = useMemo(() => {
    if (!logs) return ops.approvals;
    return logs.sessions.reduce((n, s) => n + (s.status === "terminated" ? 0 : s.pending_approvals.length), 0);
  }, [logs, ops.approvals]);

  const counts = useMemo(() => {
    let open = 0;
    for (const list of requests.bySession.values()) open += list.length;
    return {
      approvals,
      requests: open,
      // Failed work is queued work: only the report knows it.
      failed: ops.failed,
      /** Things waiting on a person: approvals and requests. */
      waiting: approvals + open,
      /** The one number for the sidebar, Home and Operations. */
      attention: approvals + open + ops.failed,
      /** Sessions that may be waiting on a person: their requests could not be read. */
      unknown: unknownIds.length,
    };
  }, [approvals, ops.failed, requests.bySession, unknownIds]);

  return {
    read,
    requests: requests.bySession,
    unknown: requests.unknown,
    unknownIds,
    failures: requests.failures,
    requestsLoading: requests.isLoading,
    retryRequests: requests.retry,
    /** The logs are being read now (a Try again shows it). */
    requestsFetching: requests.isFetching,
    counts,
    ops,
    /**
     * The report every overview builds on: the server's operations report,
     * or the stand-in read from the session logs where the server has none
     * (`source: "logs"`; approvals are then known only once the logs are
     * read, `requestsLoading`). Undefined while neither is known.
     */
    report,
    source: (ops.report ? "operations" : logs ? "logs" : null) as "operations" | "logs" | null,
  };
}

/**
 * Per-agent activity (`useAgentActivity`) with `running` counted by the one
 * reading: a session the server still calls running but that has been silent
 * for half an hour is Stalled everywhere else, so an agent card, the agents
 * table and the sidebar's Frequent do not call it running either.
 */
export function useAgentActivityNow() {
  const { byAgent, isLoading } = useAgentActivity();
  const { sessions } = useRecentSessions();
  const { read } = useSessionReadings();
  const now = useMemo(
    () => {
      const working = new Map<string, number>();
      for (const s of sessions) {
        const id = s.agent?.id;
        if (!id || s.archived_at) continue;
        if (read(s).working) working.set(id, (working.get(id) ?? 0) + 1);
      }
      const out = new Map<string, AgentActivity>();
      for (const [id, a] of byAgent) out.set(id, { ...a, running: working.get(id) ?? 0 });
      return out;
    },
    [byAgent, sessions, read],
  );
  return { byAgent: now, isLoading };
}
