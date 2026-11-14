import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowRightIcon, CircleAlertIcon, CircleCheckIcon, CircleHelpIcon, HandIcon, ShieldAlertIcon, TriangleAlertIcon } from "lucide-react";

import { useApi } from "@/lib/api";
import { useAgents, useOperations, useRecentSessions } from "@/lib/directory";
import { useServerFeature } from "@/lib/server-features";
import type { Event } from "@/lib/events";
import { plural, toDate } from "@/lib/format";
import { quietWords, STALLED_AFTER_MS, UNKNOWN_DETAIL, type SessionReading } from "@/lib/session-state";
import { sessionTitle } from "@/lib/sessions";
import { cn } from "@/lib/utils";
import { quietLink } from "@/lib/links";

import type { AgentRecord } from "../../types/agent";
import type { SessionRecord } from "../../types/session";
import { AgentAvatar } from "../AgentAvatar";
import { StatusDot } from "../Badge";
import { buildOperationsView, readFailure, type OperationsView, type TimeValue } from "../operations/model";
import { QueryProblem } from "../QueryProblem";
import { RelativeTime } from "../RelativeTime";
import { sectionLinkClass } from "../SectionCard";
import { Skeleton } from "../Skeleton";
import { Tip } from "../Tip";
import { eventTime } from "../sessions/model";
import { usePatienceForRequests, useSessionReadings } from "../sessions/readings";
import { SessionStatus } from "../sessions/SessionStatus";
import { formatClock, readPulse, type SessionPulse } from "./activity";

/**
 * Right now: what only Home can show at a glance.
 *
 *   Running now       every session an agent is working in, live: a clock
 *                     that counts, and what the agent is doing this moment
 *                     ("Running a command: duckdb …"), read from the tail of
 *                     the session's event log every few seconds.
 *                     Under it, apart and not counted: "Stalled", the
 *                     sessions that report as running and have recorded
 *                     nothing for half an hour. They get no clock.
 *   Needs attention   what is waiting on a person: approvals, requests for
 *                     access to an app or for a skill, failed turns that
 *                     can be retried, budget warnings. The same count as
 *                     the sidebar badge and the Operations page.
 *
 * Every row is drawn from the session's one reading
 * (lib/session-state.ts): the server's status decides what a session is
 * called, the newest events only add what it is doing.
 *
 * Side by side from `lg`, stacked below it. When nothing is running and
 * nothing is waiting, the band is one quiet line.
 *
 * On a server without the operations report the bands read the stand-in
 * the session logs make (`useSessionReadings().report`, source "logs"):
 * running sessions from the sessions list, approvals and requests from each
 * session's log. Failed work and budgets are the report's alone, so they are
 * not listed (a failed turn is under "Recently finished"), and every "see
 * all" goes to the Sessions list, filtered, instead of Operations.
 */

type Ops = ReturnType<typeof useOperations>;

/** Where "see all" goes: Operations where the server has it, else the Sessions list, filtered the same way. */
function useBandLinks() {
  const operations = useServerFeature("operations");
  return operations
    ? { running: "/operations?tab=running", approvals: "/operations?tab=approvals", waiting: "/operations", all: "/operations", allLabel: "Open operations" }
    : { running: "/sessions?status=running", approvals: "/sessions?status=approval", waiting: "/sessions?status=approval", all: "/sessions?status=approval", allLabel: "Waiting on you" };
}

/** The newest events of a session, newest first. `live` keeps reading while the agent works. */
export function useSessionTail(sessionId: string | undefined, opts: { live?: boolean; limit?: number } = {}) {
  const { api } = useApi();
  const limit = opts.limit ?? 20;
  return useQuery({
    queryKey: ["home", "session-tail", sessionId, limit],
    queryFn: ({ signal }) =>
      api<{ data: Event[] }>(`/v1/sessions/${sessionId}/events?limit=${limit}&order=desc`, { signal, silentErrors: true }),
    enabled: !!sessionId,
    retry: false,
    staleTime: opts.live ? 0 : 5 * 60_000,
    // A working agent is read every five seconds. One that reports as
    // running but has stalled is read twice a minute: enough to notice it
    // wake, without asking in vain.
    refetchInterval: opts.live
      ? (query) => {
          const last = eventTime(query.state.data?.data?.[0]);
          return last !== null && Date.now() - last > STALLED_AFTER_MS ? 30_000 : 5_000;
        }
      : false,
  });
}

/** Re-render every second while mounted. The clock is the only thing that does. */
function useNow(everyMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(id);
  }, [everyMs]);
  return now;
}

function Clock({ since, className }: { since: number; className?: string }) {
  const now = useNow();
  return (
    <span className={cn("tabular-nums", className)} role="timer" aria-live="off">
      {formatClock(now - since)}
    </span>
  );
}

function BandHeading({ title, count, tone, action }: { title: string; count?: number; tone: "info" | "warning"; action?: ReactNode }) {
  return (
    <div className="mb-4 flex h-8 items-center justify-between gap-4">
      <h2 className="flex items-center gap-2.5 text-h2 text-fg">
        {title}
        {count !== undefined && count > 0 && (
          <span
            className={cn(
              "inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-full px-1.5 text-xs font-semibold",
              tone === "info" ? "bg-info-subtle text-info" : "bg-warning-subtle text-warning",
            )}
          >
            {count}
          </span>
        )}
      </h2>
      {action}
    </div>
  );
}

// ── running ─────────────────────────────────────────────────────────────

export interface RunningSession {
  id: string;
  title: string;
  agentId?: string;
  agentName?: string;
  /** The server's status: `running` or `rescheduling`. */
  status: string;
  retrying: boolean;
  /** When the session was created: the clock's fallback. */
  createdAt: number | null;
  /** When it last recorded anything, as far as the lists know. */
  lastEventAt: number | null;
  needsApproval: boolean;
}

/**
 * Sessions whose status says an agent is working in them, from the recent
 * list and the operations report together. Stalled ones are included: the
 * band draws them apart (see <RunningNow>).
 */
export function runningSessions(
  sessions: SessionRecord[],
  view: OperationsView | null,
  agents: Map<string, AgentRecord>,
  attention: Map<string, "approval" | "error" | null>,
): RunningSession[] {
  const out = new Map<string, RunningSession>();
  const reported = [...(view?.running ?? []), ...(view?.stalled ?? [])];
  const lastEvent = new Map(reported.map((r) => [r.session.id, toDate(r.lastEventAt)?.getTime() ?? null]));
  for (const s of sessions) {
    if (s.archived_at || (s.status !== "running" && s.status !== "rescheduling")) continue;
    const agentName = agents.get(s.agent.id)?.name ?? s.agent.name;
    out.set(s.id, {
      id: s.id,
      title: sessionTitle(s, agentName),
      agentId: s.agent.id,
      agentName,
      status: s.status,
      retrying: s.status === "rescheduling",
      createdAt: toDate(s.created_at)?.getTime() ?? null,
      lastEventAt: lastEvent.get(s.id) ?? toDate(s.updated_at)?.getTime() ?? null,
      needsApproval: attention.get(s.id) === "approval",
    });
  }
  for (const r of reported) {
    if (out.has(r.session.id)) continue;
    out.set(r.session.id, {
      id: r.session.id,
      title: r.session.title,
      agentId: r.session.agentId,
      agentName: r.session.agentName,
      status: r.retrying ? "rescheduling" : "running",
      retrying: r.retrying,
      createdAt: null,
      lastEventAt: lastEvent.get(r.session.id) ?? null,
      needsApproval: attention.get(r.session.id) === "approval",
    });
  }
  // Working first, then the ones waiting on a retry.
  return [...out.values()].sort((a, b) => Number(a.retrying) - Number(b.retrying));
}

function ActivityLine({ pulse, loading, fallback }: { pulse: SessionPulse | null; loading: boolean; fallback: string }) {
  if (loading) return <Skeleton className="my-1 h-3.5 w-3/5" rounded="sm" />;
  const a = pulse?.activity;
  if (!a) return <p className="truncate text-small text-fg-muted">{fallback}</p>;
  const Icon = a.icon;
  return (
    // Keyed by what it says, so a change of activity fades in instead of snapping.
    <p key={`${a.label}|${a.detail ?? ""}`} className="flex min-w-0 animate-fade-in items-center gap-1.5 text-small text-fg-muted">
      <Icon className={cn("size-3.5 shrink-0", a.tone === "waiting" ? "text-warning" : "text-fg-subtle")} aria-hidden="true" />
      <span className="shrink-0 font-medium text-fg">{a.label}</span>
      {a.detail && (
        <span className={cn("min-w-0 truncate", a.code && "font-mono text-xs text-fg-muted")} title={a.detail}>
          {a.detail}
        </span>
      )}
    </p>
  );
}

type Read = ReturnType<typeof useSessionReadings>["read"];

/** The reading of a row: the lists' evidence, sharpened by the row's own newest events. */
function useRowReading(session: RunningSession, read: Read, now: number) {
  const tail = useSessionTail(session.id, { live: true });
  const pulse = useMemo(
    () => (tail.data ? readPulse(tail.data.data ?? [], { retrying: session.retrying }) : null),
    [tail.data, session.retrying],
  );
  const reading = read(
    { id: session.id, status: session.status },
    { activity: pulse?.activity?.label, lastEventAt: pulse?.lastEventAt ?? session.lastEventAt, now },
  );
  return { tail, pulse, reading };
}

/** A session with an agent at work: a clock that counts, and what it is doing this moment. */
function RunningRow({ session, read }: { session: RunningSession; read: Read }) {
  const now = useNow(30_000);
  const { tail, pulse, reading } = useRowReading(session, read, now);
  const since = pulse?.turnStartedAt ?? session.createdAt;
  const waiting = reading.waiting;
  return (
    <li>
      <Link to={`/sessions/${session.id}`} className="group/row flex items-start gap-3.5 px-4 py-3.5 transition-quick hover:bg-bg-hover">
        <AgentAvatar name={session.agentName} id={session.agentId} size="md" className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3">
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg" title={session.title}>
              {session.title}
            </span>
            <span className="flex shrink-0 items-center gap-2 text-small font-medium text-fg">
              <StatusDot status={reading.status} tone={reading.tone} />
              <span className="sr-only">{reading.label} for </span>
              {since && reading.working ? <Clock since={since} /> : <span className="text-fg-muted">{reading.label}</span>}
            </span>
          </div>
          <div className="mt-1 flex min-h-5 items-center">
            <ActivityLine
              pulse={waiting ? { ...(pulse ?? EMPTY_PULSE), activity: { icon: HandIcon, label: reading.waiting ? waitingLine(reading) : "", tone: "waiting" } } : pulse}
              loading={tail.isLoading}
              fallback={reading.detail}
            />
          </div>
          <p className="mt-1 flex items-center gap-1.5 text-xs text-fg-subtle">
            <span className="truncate">{session.agentName ?? "Unknown agent"}</span>
            {tail.isLoading && <InlineSkeleton className="h-2.5 w-24" />}
            {pulse?.lastEventAt && (
              <>
                <span aria-hidden="true">·</span>
                <span className="shrink-0">
                  last activity <RelativeTime value={pulse.lastEventAt} />
                </span>
              </>
            )}
          </p>
        </div>
      </Link>
    </li>
  );
}

/** What a working session is also waiting on a person for. */
function waitingLine(reading: SessionReading): string {
  const w = reading.waiting;
  if (!w) return reading.detail;
  return w.kinds.length === 1 && w.kinds[0] === "approval" ? "Waiting for your approval" : `Waiting on you: ${w.summary}`;
}

/**
 * A session that reports as running and has gone silent. No clock (a clock
 * that counts says "live"), an amber dot that does not pulse, and the one
 * wording for silence, with what it was last doing after it.
 */
function StalledRow({ session, read }: { session: RunningSession; read: Read }) {
  const now = useNow(30_000);
  const { tail, pulse, reading } = useRowReading(session, read, now);
  const was = pulse?.activity && !session.retrying ? `${pulse.activity.label}${pulse.activity.detail ? ` ${pulse.activity.detail}` : ""}` : null;
  return (
    <li>
      <Link to={`/sessions/${session.id}`} className="group/row flex items-start gap-3.5 px-4 py-3 transition-quick hover:bg-bg-hover">
        <AgentAvatar name={session.agentName} id={session.agentId} size="md" className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3">
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg" title={session.title}>
              {session.title}
            </span>
            <SessionStatus reading={reading} tip={false} />
          </div>
          <p className="mt-1 flex min-w-0 items-center gap-1.5 text-small text-fg-muted">
            <span className="shrink-0 font-medium text-fg">{reading.stalled ? reading.detail : quietWords(reading.quietForMs ?? 0)}</span>
            {/* What it was last doing comes from its own events: its place is held until they are read, so the line does not grow. */}
            {tail.isLoading && !session.retrying && <InlineSkeleton className="h-3 w-40 max-w-[40%]" />}
            {was && (
              <>
                <span aria-hidden="true">·</span>
                <span className="min-w-0 truncate" title={was}>
                  last seen {was[0].toLowerCase()}
                  {was.slice(1)}
                </span>
              </>
            )}
            {session.retrying && (
              <>
                <span aria-hidden="true">·</span>
                <span className="min-w-0 truncate">it was retrying after a failure</span>
              </>
            )}
          </p>
          <p className="mt-1 truncate text-xs text-fg-subtle">{session.agentName ?? "Unknown agent"}</p>
        </div>
      </Link>
    </li>
  );
}

/** A skeleton that can sit inside a line of text (a <span>, so it may live in a <p>). */
function InlineSkeleton({ className }: { className?: string }) {
  return <span aria-hidden="true" data-slot="skeleton" className={cn("skeleton-pulse inline-block shrink-0 rounded-sm bg-bg-pressed", className)} />;
}

const EMPTY_PULSE: SessionPulse = { activity: null, turnStartedAt: null, lastEventAt: null };

const MAX_RUNNING = 3;
const MAX_STALLED = 2;

export function RunningNow({ running, loading }: { running: RunningSession[]; loading: boolean }) {
  const { read } = useSessionReadings();
  const links = useBandLinks();
  const now = useNow(30_000);
  // Live work and stalled work are told apart by the reading the lists
  // already hold; each row then sharpens it from its own newest events.
  const { live, stalled } = useMemo(() => {
    const live: RunningSession[] = [];
    const stalled: RunningSession[] = [];
    for (const s of running) (read({ id: s.id, status: s.status }, { lastEventAt: s.lastEventAt, now }).stalled ? stalled : live).push(s);
    return { live, stalled };
  }, [running, read, now]);
  const shown = live.slice(0, MAX_RUNNING);
  const more = live.length - shown.length;
  const shownStalled = stalled.slice(0, MAX_STALLED);
  const moreStalled = stalled.length - shownStalled.length;
  return (
    <section aria-label="Running now" className="flex min-w-0 flex-col">
      <BandHeading
        title="Running now"
        count={live.length}
        tone="info"
        action={
          running.length > 0 ? (
            <Link to={links.running} className={sectionLinkClass}>
              All running <ArrowRightIcon className="size-3.5" />
            </Link>
          ) : undefined
        }
      />
      {loading ? (
        <BandSkeleton />
      ) : running.length === 0 ? (
        <Quiet icon={<StatusDot tone="neutral" className="size-2" />} title="Nothing is running">
          A session you start, or an agent woken by a trigger, shows up here while it works.
        </Quiet>
      ) : (
        <div className="space-y-4">
          {live.length > 0 ? (
            <ul className="surface divide-y divide-border overflow-hidden rounded-xl">
              {shown.map((s) => (
                <RunningRow key={s.id} session={s} read={read} />
              ))}
              {more > 0 && (
                <li>
                  <Link
                    to={links.running}
                    className="flex items-center justify-between px-4 py-3 text-small font-medium text-fg-muted transition-quick hover:bg-bg-hover hover:text-fg"
                  >
                    {plural(more, "more session")} running
                    <ArrowRightIcon className="size-3.5" />
                  </Link>
                </li>
              )}
            </ul>
          ) : (
            <p className="text-small text-fg-muted">No agent is working right now.</p>
          )}
          {stalled.length > 0 && (
            <div>
              <div className="mb-2 flex items-baseline gap-2">
                <h3 className="flex items-center gap-2 text-small font-medium text-fg">
                  Stalled
                  <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-warning-subtle px-1.5 text-micro text-warning">
                    {stalled.length}
                  </span>
                </h3>
                <p className="min-w-0 truncate text-xs text-fg-subtle" title="These report as running and have recorded nothing for half an hour or more. Open one to check on it, or stop it.">
                  Reported as running, silent for half an hour or more
                </p>
              </div>
              <ul className="surface divide-y divide-border overflow-hidden rounded-xl">
                {shownStalled.map((s) => (
                  <StalledRow key={s.id} session={s} read={read} />
                ))}
                {moreStalled > 0 && (
                  <li>
                    <Link
                      to={links.running}
                      className="flex items-center justify-between px-4 py-3 text-small font-medium text-fg-muted transition-quick hover:bg-bg-hover hover:text-fg"
                    >
                      {plural(moreStalled, "more session")} stalled
                      <ArrowRightIcon className="size-3.5" />
                    </Link>
                  </li>
                )}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// ── waiting on a person ─────────────────────────────────────────────────

interface AttentionRow {
  key: string;
  /** `unknown`: a session whose requests could not be read; it may be waiting on you. */
  kind: "approval" | "request" | "unknown" | "failed" | "budget";
  title: string;
  detail: string;
  /** For an approval: the part of `detail` that is a command. */
  command?: string;
  caption?: ReactNode;
  to: string;
  action: string;
}

/**
 * Needs attention: approvals first (up to two shown in full), then
 * requests for access to an app or for a skill (they wait on a person
 * exactly as an approval does), then failed work (one row, or a single
 * summary row when there are several), then budget warnings, which are
 * listed but not counted. It reads the operations report the same way the
 * Operations page does (components/operations/model.ts) and the open
 * requests from the same reader (sessions/readings.ts), so the count here
 * is the count there.
 * Sessions that ended on an error with nothing left to retry are history:
 * they are under "finished", not here.
 */
export function NeedsAttention({ ops, view: given }: { ops: Ops; view: OperationsView | null }) {
  // The view handed in may not know about open requests (they are read
  // from each session's newest events, not from the report): add them here,
  // so the rows and the count are right whoever built the view.
  const readings = useSessionReadings();
  const report = readings.report;
  const fromLogs = readings.source === "logs";
  const links = useBandLinks();
  const { byId: agents } = useAgents();
  const { sessions: recent } = useRecentSessions();
  const view = useMemo(
    () => (given && report ? buildOperationsView(report, agents, recent, readings.requests, Date.now(), readings.failures) : given),
    [given, report, agents, recent, readings.requests, readings.failures],
  );
  const unknownIds = readings.unknownIds;
  const titleOf = useMemo(() => sessionTitleLookup(report, recent), [report, recent]);
  const rows = useMemo<AttentionRow[]>(() => {
    if (!view) return [];
    const out: AttentionRow[] = [];
    const who = (name: string | undefined, at: TimeValue, verb: string) => (
      <>
        {name && <span className="truncate">{name}</span>}
        {toDate(at) && (
          <>
            {name && <span aria-hidden="true">·</span>}
            <span className="shrink-0">
              {verb} <RelativeTime value={at} />
            </span>
          </>
        )}
      </>
    );
    for (const a of view.approvals.slice(0, 2)) {
      const command = typeof a.input.command === "string" ? a.input.command : undefined;
      out.push({
        key: `a-${a.key}`,
        kind: "approval",
        title: a.session.title,
        detail: command ? `Wants to run ${a.name}` : `Wants to use ${a.name}`,
        command,
        caption: who(a.session.agentName, a.requestedAt, "asked"),
        to: `/sessions/${a.session.id}`,
        action: "Review",
      });
    }
    if (view.approvals.length > 2) {
      out.push({
        key: "more-approvals",
        kind: "approval",
        title: `${plural(view.approvals.length - 2, "more approval")} waiting`,
        detail: view.approvals
          .slice(2)
          .map((a) => a.session.title)
          .join(" · "),
        to: links.approvals,
        action: "See all",
      });
    }
    for (const r of view.requests.slice(0, 2)) {
      out.push({
        key: `r-${r.key}`,
        kind: "request",
        title: r.session.title,
        detail: r.reading.waiting && r.reading.waiting.approvals === 0 ? r.reading.detail : requestWords(r.requests),
        caption: who(r.session.agentName, r.at, "asked"),
        to: `/sessions/${r.session.id}#needs-you`,
        action: "Answer",
      });
    }
    if (view.requests.length > 2) {
      out.push({
        key: "more-requests",
        kind: "request",
        title: `${plural(view.requests.length - 2, "more session")} waiting for access or a skill`,
        detail: view.requests
          .slice(2)
          .map((r) => r.session.title)
          .join(" · "),
        to: links.waiting,
        action: "See all",
      });
    }
    // Sessions whose requests could not be read are not counted, and not
    // left out either: nothing says they are not waiting on you.
    if (unknownIds.length === 1) {
      const id = unknownIds[0];
      out.push({
        key: `u-${id}`,
        kind: "unknown",
        title: titleOf(id),
        detail: UNKNOWN_DETAIL[readings.unknown.get(id) ?? "unreadable"],
        to: `/sessions/${id}`,
        action: "Open",
      });
    } else if (unknownIds.length > 1) {
      out.push({
        key: "unknown",
        kind: "unknown",
        title: `${plural(unknownIds.length, "session")} could not be checked for requests`,
        detail: unknownIds.map(titleOf).join(" · "),
        to: links.waiting,
        action: "See all",
      });
    }
    if (view.failures.length === 1) {
      const f = view.failures[0];
      const reading = readFailure(f.error);
      out.push({
        key: `f-${f.key}`,
        kind: "failed",
        title: f.session.title,
        detail: reading.cause ?? reading.headline,
        caption: who(f.session.agentName, f.at, "failed"),
        to: `/sessions/${f.session.id}`,
        action: "Open",
      });
    } else if (view.failures.length > 1) {
      out.push({
        key: "failures",
        kind: "failed",
        title: `${plural(view.failures.length, "turn")} failed and can be retried`,
        detail: view.failures.map((f) => f.session.title).join(" · "),
        to: "/operations?tab=failed",
        action: "See all",
      });
    }
    for (const b of view.budgets) {
      for (const w of b.warnings) {
        if (out.filter((r) => r.kind === "budget").length >= 2) break;
        out.push({
          key: `b-${b.scope.scope_id}-${w}`,
          kind: "budget",
          title: b.agentId ? `Budget for ${b.label}` : "Workspace budget",
          detail: w,
          to: "/operations?tab=budgets",
          action: "Open",
        });
      }
    }
    return out;
  }, [view, unknownIds, titleOf, readings.unknown, links]);

  // The band is drawn once, from whole evidence: the report, the names, and
  // the open requests (read from each session's newest events). Drawn
  // earlier, a row could change its words or a request row push in above
  // it, and the count would jump. The requests are waited for at most
  // REQUESTS_PATIENCE: on a cold tab with many sessions their reads can
  // take a while, and the report alone is worth showing by then.
  // The patience is the tab's, shared with the sidebar's badge.
  const waitForRequests = usePatienceForRequests(readings.requestsLoading);
  // From the logs, approvals are in the same reads as the requests: without
  // them nothing is known yet, so there is nothing to draw early.
  const loading = ops.isLoading || (fromLogs ? readings.requestsLoading : waitForRequests);

  return (
    <section aria-label="Needs attention" className="flex min-w-0 flex-col">
      <BandHeading
        title="Needs attention"
        count={loading ? undefined : view?.attention}
        tone="warning"
        action={
          <Link to={links.all} className={sectionLinkClass}>
            {links.allLabel} <ArrowRightIcon className="size-3.5" />
          </Link>
        }
      />
      {ops.unsupported && !report ? (
        <Quiet title="Not reported by this runtime">
          Approvals and failures are shown on each session instead.{" "}
          <Link className={cn(quietLink, "text-fg")} to="/sessions">
            Open sessions
          </Link>
        </Quiet>
      ) : ops.error ? (
        <QueryProblem title="Operational activity could not be loaded" error={ops.error} retry={ops.refetch} />
      ) : loading ? (
        <BandSkeleton />
      ) : rows.length === 0 ? (
        <Quiet icon={<CircleCheckIcon className="size-[18px] text-success" />} title="Nothing is waiting on you">
          {fromLogs
            ? "Approvals an agent asks for, and its requests for access to an app or for a skill, are listed here."
            : "Approvals and requests an agent makes, and turns that fail, are listed here the moment they happen."}
        </Quiet>
      ) : (
        <>
          <ul className="surface divide-y divide-border overflow-hidden rounded-xl">
            {rows.map((it) => {
              const Icon =
                it.kind === "approval"
                  ? ShieldAlertIcon
                  : it.kind === "request"
                    ? HandIcon
                    : it.kind === "unknown"
                      ? CircleHelpIcon
                      : it.kind === "failed"
                        ? CircleAlertIcon
                        : TriangleAlertIcon;
              return (
                <li key={it.key}>
                  <Link to={it.to} className="group/row flex items-start gap-3.5 px-4 py-3.5 transition-quick hover:bg-bg-hover">
                    <span
                      className={cn(
                        "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-[10px]",
                        it.kind === "failed"
                          ? "bg-danger-subtle text-danger"
                          : it.kind === "unknown"
                            ? "bg-bg-soft text-fg-muted"
                            : "bg-warning-subtle text-warning",
                      )}
                    >
                      <Icon className="size-[18px]" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-3">
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg" title={it.title}>
                          {it.title}
                        </span>
                        <span className="-my-1 inline-flex h-7 shrink-0 items-center rounded-full bg-bg-soft px-3 text-small font-medium text-fg transition-quick group-hover/row:bg-ink group-hover/row:text-on-ink">
                          {it.action}
                        </span>
                      </div>
                      <p className="mt-1 flex min-h-5 min-w-0 items-center gap-1.5 text-small text-fg-muted" title={it.command ?? it.detail}>
                        <span className={cn(it.command ? "shrink-0" : "truncate")}>{it.detail}</span>
                        {it.command && (
                          <code className="min-w-0 truncate rounded-sm bg-bg-soft px-1 py-0.5 font-mono text-xs text-fg">{it.command}</code>
                        )}
                      </p>
                      {it.caption && <p className="mt-1 flex items-center gap-1.5 text-xs text-fg-subtle">{it.caption}</p>}
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
          {report?.truncated && (
            <p className="mt-2 text-xs text-fg-subtle">
              {fromLogs ? "Read from the 100 most recent sessions." : "Counts cover the recent records returned by this runtime."}
            </p>
          )}
        </>
      )}
    </section>
  );
}

/** A session's title by id, from the recent sessions or the report. */
function sessionTitleLookup(report: Ops["report"] | undefined, recent: SessionRecord[]) {
  const known = new Map(recent.map((s) => [s.id, s]));
  const rows = new Map((report?.sessions ?? []).map((s) => [s.id, s]));
  return (id: string): string => {
    const s = known.get(id);
    if (s) return sessionTitle(s);
    const row = rows.get(id);
    return sessionTitle({ title: row?.title, agent: { id: row?.agent_id ?? "", version: 0 } });
  };
}

/** "Waiting for access to HubSpot and for the Word documents skill" */
function requestWords(requests: Array<{ kind: "access" | "skill"; name: string }>): string {
  const access = requests.filter((r) => r.kind === "access");
  const skills = requests.filter((r) => r.kind === "skill");
  const parts = [
    access.length > 0 ? (access.length <= 2 ? `access to ${access.map((r) => r.name).join(" and ")}` : plural(access.length, "access request")) : "",
    skills.length > 0 ? (skills.length === 1 ? `the ${skills[0].name} skill` : plural(skills.length, "skill")) : "",
  ].filter(Boolean);
  return `Waiting for ${parts.join(" and for ")}`;
}

// ── shared pieces ───────────────────────────────────────────────────────

function Quiet({ icon, title, children }: { icon?: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3.5 rounded-xl border border-dashed border-border-strong/70 px-4 py-5">
      {icon && <span className="flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-bg-soft">{icon}</span>}
      <div className="min-w-0">
        <p className="text-sm font-medium text-fg">{title}</p>
        <p className="mt-0.5 text-small text-fg-muted">{children}</p>
      </div>
    </div>
  );
}

function BandSkeleton() {
  return (
    <div className="surface divide-y divide-border overflow-hidden rounded-xl" aria-hidden="true">
      {[0, 1].map((i) => (
        <div key={i} className="flex items-start gap-3.5 px-4 py-3.5">
          <Skeleton className="size-8" rounded="md" />
          <div className="flex-1 space-y-2 py-0.5">
            <Skeleton className="h-3.5" rounded="sm" style={{ width: `${62 - i * 14}%` }} />
            <Skeleton className="h-3" rounded="sm" style={{ width: `${84 - i * 10}%` }} />
            <Skeleton className="h-2.5 w-28" rounded="sm" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The band when the workspace is at rest: one line instead of two empty
 * cards. "Nothing is waiting on you" is only said once the open requests
 * have been read too: a session waiting for access to an app is waiting on
 * a person even though no report lists it, and then this is not the quiet
 * line at all but what needs attention.
 */
export function AllQuiet() {
  const readings = useSessionReadings();
  const { ops, report } = readings;
  const { byId: agents } = useAgents();
  const { sessions: recent } = useRecentSessions();
  // A session that could not be checked may be waiting on you: then this is
  // not the quiet line either, but the band that says so. (From the logs, an
  // approval is found by the same reads, so it counts here too.)
  const view = useMemo(
    () =>
      report && (readings.counts.requests > 0 || readings.counts.unknown > 0 || readings.counts.approvals > 0)
        ? buildOperationsView(report, agents, recent, readings.requests, Date.now(), readings.failures)
        : null,
    [report, agents, recent, readings.requests, readings.counts.requests, readings.counts.unknown, readings.counts.approvals, readings.failures],
  );
  if (view) return <NeedsAttention ops={ops} view={view} />;
  if (readings.requestsLoading) {
    return (
      <div className="flex items-center gap-2.5 rounded-xl border border-dashed border-border-strong/70 px-4 py-3.5" aria-hidden="true">
        <Skeleton className="size-4" rounded="full" />
        <Skeleton className="h-3.5 w-72 max-w-[60%]" rounded="sm" />
      </div>
    );
  }
  return (
    <p className="flex items-center gap-2.5 rounded-xl border border-dashed border-border-strong/70 px-4 py-3.5 text-small text-fg-muted">
      <CircleCheckIcon className="size-4 shrink-0 text-success" />
      <span>
        <span className="font-medium text-fg">All quiet.</span> Nothing is running and nothing is waiting on you.
      </span>
    </p>
  );
}

/**
 * The band when neither the sessions nor a report could be read: what is
 * running and what is waiting are not known, and the band says that, in
 * one neutral line, rather than "Nothing is running". Why the reads failed
 * is said once, by Home's banner above.
 */
export function AllUnknown() {
  return (
    <p className="flex items-center gap-2.5 rounded-xl border border-dashed border-border-strong/70 px-4 py-3.5 text-small text-fg-muted">
      <CircleHelpIcon className="size-4 shrink-0 text-fg-subtle" />
      <span>
        <span className="font-medium text-fg">Not known right now.</span> What is running and what is waiting on you shows here again once
        the sessions can be read.
      </span>
    </p>
  );
}
