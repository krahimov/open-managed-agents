import { useMemo } from "react";
import { Link } from "react-router";
import { ArrowRightIcon, CheckIcon, CircleAlertIcon, SquareIcon } from "lucide-react";

import { formatDate, plural, toDate } from "@/lib/format";
import { sessionTitle } from "@/lib/sessions";

import type { AgentRecord } from "../../types/agent";
import type { SessionRecord } from "../../types/session";
import { AgentAvatar } from "../AgentAvatar";
import { EmptyState } from "../EmptyState";
import { readFailure, type OperationsView } from "../operations/model";
import { QueryProblem } from "../QueryProblem";
import { RelativeTime } from "../RelativeTime";
import { Section, sectionLinkClass } from "../SectionCard";
import { Skeleton } from "../Skeleton";
import { Tip } from "../Tip";
import { readPulse } from "./activity";
import { useSessionTail } from "./RightNow";

/**
 * What finished, and how it went.
 *
 * The sidebar lists recent sessions by title. This says what came of them:
 * each row carries the agent's own closing words ("Posted the review as
 * Request changes with 3 inline comments"), or why it failed, read from
 * the end of the session's event log. Work that finished after the
 * person's last visit is marked new and comes first in the count.
 *
 * Sessions that are still running, and ones waiting on a person, are not
 * here: they are in the band above.
 */

export interface FinishedSession {
  session: SessionRecord;
  title: string;
  agentName?: string;
  at: number;
  /** Stopped on an error with nothing queued to retry. */
  error?: string;
  /** Finished after the person's last visit. */
  fresh: boolean;
}

const MAX_ROWS = 5;

/** When the last visit was, as it fits after "since your last visit": "3 hours ago", "yesterday", "on Nov 4". */
export function lastVisitWords(since: number, now: number = Date.now()): string {
  const minutes = Math.round((now - since) / 60_000);
  if (minutes < 60) return "less than an hour ago";
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? "an hour ago" : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return `on ${formatDate(since).replace(/, \d{4}$/, "")}`;
}

/** Sessions that have come to rest, newest first. */
export function finishedSessions({
  sessions,
  view,
  report,
  agents,
  since,
  causes,
}: {
  sessions: SessionRecord[];
  view: OperationsView | null;
  /** The operations report's own session rows, to know which sessions ever ran. */
  report: Array<{ id: string; last_event_at: string | number | null; updated_at: string | number; error: string | null }> | undefined;
  agents: Map<string, AgentRecord>;
  since: number | null;
  /**
   * Why each failed session failed, read from its log as its own page reads
   * it (`useSessionReadings().failures`). The report has only the runtime's
   * message, so a row without this could say one thing and the page another.
   */
  causes?: ReadonlyMap<string, string>;
}): FinishedSession[] {
  // Still someone's to act on: shown under "Needs attention" instead.
  const waiting = new Set<string>();
  for (const a of view?.approvals ?? []) waiting.add(a.session.id);
  for (const r of view?.requests ?? []) waiting.add(r.session.id);
  for (const u of view?.unknown ?? []) waiting.add(u.session.id);
  for (const f of view?.failures ?? []) waiting.add(f.session.id);
  const ended = new Map((view?.ended ?? []).map((e) => [e.session.id, e]));
  const reported = new Map((report ?? []).map((r) => [r.id, r]));

  const out: FinishedSession[] = [];
  for (const s of sessions) {
    if (s.archived_at || waiting.has(s.id)) continue;
    if (s.status !== "idle" && s.status !== "terminated") continue;
    const row = reported.get(s.id);
    // Created but never spoken to: nothing finished.
    if (row && !toDate(row.last_event_at) && !row.error) continue;
    const at = toDate(row?.last_event_at ?? null) ?? toDate(s.updated_at) ?? toDate(s.created_at);
    if (!at) continue;
    const agentName = agents.get(s.agent.id)?.name ?? s.agent.name;
    out.push({
      session: s,
      title: sessionTitle(s, agentName),
      agentName,
      at: at.getTime(),
      error: ended.get(s.id)?.error ?? (row?.error ? causes?.get(s.id) || row.error : undefined),
      fresh: since !== null && at.getTime() > since,
    });
  }
  return out.sort((a, b) => b.at - a.at);
}

function Outcome({ item }: { item: FinishedSession }) {
  const tail = useSessionTail(item.session.id, { limit: 12 });
  const pulse = useMemo(() => (tail.data ? readPulse(tail.data.data ?? []) : null), [tail.data]);
  if (item.error) {
    const reading = readFailure(item.error);
    return (
      <p className="flex min-w-0 items-center gap-1.5 text-small text-fg-muted">
        <CircleAlertIcon className="size-3.5 shrink-0 text-danger" aria-hidden="true" />
        <span className="shrink-0 font-medium text-danger">Failed</span>
        <span className="min-w-0 truncate" title={reading.cause ?? reading.headline}>
          {reading.cause ?? reading.headline}
        </span>
      </p>
    );
  }
  if (tail.isLoading) return <Skeleton className="my-1 h-3.5 w-1/2" rounded="sm" />;
  const ended = item.session.status === "terminated";
  const said = pulse?.lastSaid;
  return (
    <p className="flex min-w-0 items-center gap-1.5 text-small text-fg-muted">
      {ended ? (
        <SquareIcon className="size-3 shrink-0 fill-current text-fg-faint" aria-hidden="true" />
      ) : (
        <CheckIcon className="size-3.5 shrink-0 stroke-[2.5] text-success" aria-hidden="true" />
      )}
      {ended && <span className="shrink-0 font-medium text-fg">Ended</span>}
      {said ? (
        <span className="min-w-0 truncate" title={said}>
          {said}
        </span>
      ) : (
        <span className="min-w-0 truncate">{ended ? "It was stopped before the agent replied." : "Finished without a written reply."}</span>
      )}
    </p>
  );
}

export function SinceLastVisit({
  finished,
  since,
  loading,
  error,
  retry,
}: {
  finished: FinishedSession[];
  since: number | null;
  loading: boolean;
  error?: unknown;
  retry?: () => unknown;
}) {
  const fresh = finished.filter((f) => f.fresh).length;
  const shown = finished.slice(0, MAX_ROWS);
  const hiddenFresh = Math.max(0, fresh - shown.filter((f) => f.fresh).length);

  // A first visit has no "since": then it is simply the latest work.
  const title = since !== null && fresh > 0 ? "Since you were last here" : "Recently finished";
  const description =
    since === null
      ? "The latest work your agents finished, and how it went."
      : fresh > 0
        ? `${plural(fresh, "session")} finished since your last visit ${lastVisitWords(since)}.`
        : `Nothing has finished since your last visit ${lastVisitWords(since)}. This is the latest work before it.`;

  return (
    <Section
      title={title}
      description={error || loading || finished.length === 0 ? undefined : description}
      action={
        <Link to="/sessions" className={sectionLinkClass}>
          All sessions <ArrowRightIcon className="size-3.5" />
        </Link>
      }
    >
      {error ? (
        <QueryProblem title="Recent sessions could not be loaded" error={error} retry={retry} />
      ) : loading ? (
        <div className="surface divide-y divide-border overflow-hidden rounded-xl" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-3.5 px-4 py-3.5">
              <Skeleton className="size-8" rounded="md" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3.5" rounded="sm" style={{ width: `${44 - i * 8}%` }} />
                <Skeleton className="h-3" rounded="sm" style={{ width: `${66 - i * 9}%` }} />
              </div>
            </div>
          ))}
        </div>
      ) : finished.length === 0 ? (
        <EmptyState
          kind="session"
          title="Nothing has finished yet"
          body="When an agent completes a task, what it reported is shown here so you do not have to open the session to find out."
        />
      ) : (
        <ul className="surface divide-y divide-border overflow-hidden rounded-xl">
          {shown.map((item, i) => (
            <li key={item.session.id} className="stagger animate-rise-in" style={{ "--i": i } as React.CSSProperties}>
              <Link
                to={`/sessions/${item.session.id}`}
                className="group/row flex items-center gap-3.5 px-4 py-3.5 transition-quick hover:bg-bg-hover"
              >
                <AgentAvatar name={item.agentName} id={item.session.agent.id} size="md" />
                <div className="min-w-0 flex-1">
                  <p className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 truncate text-sm font-medium text-fg" title={item.title}>
                      {item.title}
                    </span>
                    {item.fresh && (
                      <Tip label="Finished since your last visit">
                        <span className="flex h-[18px] shrink-0 items-center rounded-full bg-plum-subtle px-1.5 text-micro font-semibold text-plum">
                          New
                        </span>
                      </Tip>
                    )}
                  </p>
                  <div className="mt-1 flex min-h-5 items-center">
                    <Outcome item={item} />
                  </div>
                </div>
                <div className="hidden shrink-0 items-center gap-1.5 pl-2 text-xs text-fg-subtle @[480px]:flex">
                  {item.agentName && <span className="hidden max-w-44 truncate @[760px]:inline">{item.agentName}</span>}
                  {item.agentName && (
                    <span aria-hidden="true" className="hidden @[760px]:inline">
                      ·
                    </span>
                  )}
                  <RelativeTime value={item.at} />
                </div>
              </Link>
            </li>
          ))}
          {hiddenFresh > 0 && (
            <li>
              <Link
                to="/sessions"
                className="flex items-center justify-between px-4 py-3 text-small font-medium text-fg-muted transition-quick hover:bg-bg-hover hover:text-fg"
              >
                {plural(hiddenFresh, "more session")} finished since your last visit
                <ArrowRightIcon className="size-3.5" />
              </Link>
            </li>
          )}
        </ul>
      )}
    </Section>
  );
}
