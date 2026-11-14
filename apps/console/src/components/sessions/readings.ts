import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { useApi } from "@/lib/api";
import { useAgentActivity, useOperations, useRecentSessions, type AgentActivity } from "@/lib/directory";
import { readFailure } from "@/lib/failures";
import { toDate } from "@/lib/format";
import type { OperationsReport } from "@/lib/operations";
import { readSession, type OpenRequest, type SessionReading } from "@/lib/session-state";

import { failureText, openOf, readSessionLog, type EventsPage, type LogState, type ReadBudget } from "./log-reading";
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
 */

/** Sessions whose logs are read for open requests: the report's window. */
export const REQUEST_WINDOW = 100;
export const LOG_BUDGET: ReadBudget = { tail: 40, page: 200, most: 2000 };
const AT_ONCE = 4;
/** How often sessions that could not be read are asked for again. */
const RETRY_UNKNOWN_MS = 30_000;
const STORE = "muse:session-log:v2";

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

interface Known {
  stamp: string;
  state: LogState;
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
  /** Sessions whose requests are not known, and why. */
  unknown: Map<string, Unknown>;
  /** Why a failed turn failed, by session, as the session page reads it (`readFailure` input). */
  failures: Map<string, string>;
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
        try {
          const result = await readSessionLog(
            (q) => api<EventsPage>(`/v1/sessions/${c.id}/events${q}`, { signal, silentErrors: true }),
            known?.state ?? null,
            c.needFailure,
            LOG_BUDGET,
          );
          read.set(c.id, {
            stamp: c.stamp,
            state: result.state,
            partial: result.kind === "too-long" || undefined,
            exhausted: result.exhausted || undefined,
          });
        } catch {
          // What was known is for an older version of the log: it says
          // nothing certain about now. Not known, and asked again.
          if (!signal.aborted) failed.add(c.id);
        }
      });
      const keep = new Set(candidates.map((c) => c.id));
      persist(keep);
      const out: LogReadings = { open: new Map(), unknown: new Map(), failures: new Map() };
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
  return { bySession: data.open, unknown: data.unknown, failures: data.failures, isLoading, isFetching: query.isFetching, retry };
}
const EMPTY: LogReadings = { open: new Map(), unknown: new Map(), failures: new Map() };

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

  const reported = useMemo(
    () => new Map<string, ReportSession>((ops.report?.sessions ?? []).map((s) => [s.id, s])),
    [ops.report],
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

  const counts = useMemo(() => {
    let open = 0;
    for (const list of requests.bySession.values()) open += list.length;
    return {
      approvals: ops.approvals,
      requests: open,
      failed: ops.failed,
      /** Things waiting on a person: approvals and requests. */
      waiting: ops.approvals + open,
      /** The one number for the sidebar, Home and Operations. */
      attention: ops.approvals + open + ops.failed,
      /** Sessions that may be waiting on a person: their requests could not be read. */
      unknown: unknownIds.length,
    };
  }, [ops.approvals, ops.failed, requests.bySession, unknownIds]);

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
