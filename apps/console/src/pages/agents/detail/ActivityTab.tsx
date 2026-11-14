import { Link, useNavigate } from "react-router";
import { ArrowRightIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatSpan, plural, toDate } from "@/lib/format";
import type { SessionReading } from "@/lib/session-state";
import {
  SESSION_SOURCE_LABEL,
  sessionSource,
  sessionTitle,
} from "@/lib/sessions";

import { cn } from "@/lib/utils";

import { openRowFromEvent } from "../../../components/DataTable";
import { SessionStatus } from "../../../components/sessions/SessionStatus";
import { useSessionReadings } from "../../../components/sessions/readings";
import {
  EmptyState,
  ErrorState,
  RelativeTime,
  SectionCard,
  Skeleton,
  Tip,
  sectionLinkClass,
} from "../../../components/kit";
import type { AgentRecord } from "../../../types/agent";
import type { SessionRecord } from "../../../types/session";

/** How many sessions the profile loads. Past that the Sessions page takes over. */
export const ACTIVITY_LIMIT = 100;

/**
 * How long the session ran, read as the Sessions list reads it: start to
 * end for one that ended, start to its last activity otherwise. Null when
 * nothing was recorded after it started (the API then only knows its age,
 * which is not a duration).
 */
export function sessionSeconds(s: SessionRecord): number | null {
  const start = toDate(s.created_at)?.getTime();
  if (start == null) return null;
  if (s.status === "terminated" && typeof s.stats?.duration_seconds === "number") return s.stats.duration_seconds;
  const end = toDate(s.terminated_at ?? s.updated_at)?.getTime();
  if (end == null || end < start) return null;
  return (end - start) / 1000;
}

/**
 * The line under a session's state: what came of it, or what it is waiting
 * on. Said only where the reading says more than its label: a session at
 * rest ("Idle", "Ended") needs no second line on every row.
 */
function outcomeLine(reading: SessionReading): string | null {
  if (reading.tone === "neutral" && reading.status !== "unknown") return null;
  return reading.detail && reading.detail !== reading.label ? reading.detail : null;
}

/**
 * Activity: every session this agent has had, newest first, read the way
 * the Sessions list reads them: the one session reading for the state, with
 * what came of it or what it waits on under it, how long it ran, and when
 * it was last active. Rows open the session.
 */
export function ActivityTab({
  agent,
  sessions,
  loading,
  error,
  retry,
  onStart,
}: {
  agent: AgentRecord;
  sessions: SessionRecord[];
  loading: boolean;
  error: unknown;
  retry: () => void;
  onStart: () => void;
}) {
  const navigate = useNavigate();
  // The one reading of a session, the same as the Sessions list and the session's header.
  const { read } = useSessionReadings();

  if (error) return <ErrorState title="Sessions could not be loaded" error={error} retry={retry} />;

  if (loading) {
    return (
      <div className="surface overflow-hidden rounded-xl" aria-hidden="true">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex h-[60px] items-center gap-4 border-t border-border px-5 first:border-t-0">
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-3.5 w-[min(22rem,60%)]" rounded="sm" />
              <Skeleton className="h-3 w-28" rounded="sm" />
            </div>
            <div className="w-[200px] space-y-2">
              <Skeleton className="h-3.5 w-20" rounded="sm" />
              <Skeleton className="h-3 w-36" rounded="sm" />
            </div>
            <Skeleton className="hidden h-3.5 w-12 sm:block" rounded="sm" />
            <Skeleton className="hidden h-3.5 w-16 sm:block" rounded="sm" />
          </div>
        ))}
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <EmptyState
        kind="session"
        title="No sessions yet"
        body={
          agent.archived_at
            ? `${agent.name} was archived before it ran a session.`
            : `Give ${agent.name} something to do and its work will show up here.`
        }
        action={
          agent.archived_at ? undefined : (
            <Button variant="outline" onClick={onStart}>
              Start session
            </Button>
          )
        }
      />
    );
  }

  return (
    <SectionCard
      flush
      footer={
        <span className="flex items-center justify-between gap-4">
          <span>
            {sessions.length >= ACTIVITY_LIMIT
              ? `The latest ${ACTIVITY_LIMIT} sessions, newest first`
              : `${plural(sessions.length, "session")}, newest first`}
          </span>
          <Link to={`/sessions?agent_id=${encodeURIComponent(agent.id)}`} className={cn(sectionLinkClass, "-my-1.5 -mr-2.5")}>
            Open in Sessions
            <ArrowRightIcon className="size-3.5" aria-hidden="true" />
          </Link>
        </span>
      }
    >
      <Table className="table-fixed text-small-size">
        <colgroup>
          <col />
          <col className="w-[160px] sm:w-[240px]" />
          <col className="hidden w-[96px] sm:table-column" />
          <col className="hidden w-[132px] sm:table-column" />
        </colgroup>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="pl-5">Session</TableHead>
            <TableHead className="px-4">Status</TableHead>
            <TableHead className="hidden px-4 text-right sm:table-cell">Duration</TableHead>
            <TableHead className="hidden pr-5 pl-4 sm:table-cell">Last activity</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sessions.map((s) => {
            const reading = read(s);
            const source = sessionSource(s);
            const title = sessionTitle(s, agent.name);
            const seconds = sessionSeconds(s);
            const outcome = outcomeLine(reading);
            const facts = [
              source === "console" ? "Started in the console" : `Started from ${SESSION_SOURCE_LABEL[source]}`,
              s.agent?.version !== undefined && s.agent.version !== agent.version ? `as v${s.agent.version}` : null,
            ].filter(Boolean);
            // The title is the row's link (Tab + Enter, ⌘-click). A click
            // anywhere else on the row opens it with the same modifiers:
            // ⌘/Ctrl-click and middle-click open a new tab.
            const target = { href: `/sessions/${s.id}` };
            return (
              <TableRow
                key={s.id}
                onClick={(e) => openRowFromEvent(e, target, navigate)}
                onAuxClick={(e) => openRowFromEvent(e, target, navigate)}
                className="h-[60px] cursor-pointer"
              >
                <TableCell className="pl-5">
                  <Link to={target.href} className="block truncate rounded-sm font-medium text-fg outline-offset-4" title={title}>
                    {title}
                  </Link>
                  <div className="truncate text-xs text-fg-subtle">{facts.join(" · ")}</div>
                </TableCell>
                <TableCell className="px-4">
                  {/* The detail is written under the badge, so the badge needs no tooltip. */}
                  <SessionStatus reading={reading} tip={!outcome} />
                  {outcome && (
                    <div
                      className={cn("truncate text-xs", reading.tone === "danger" ? "text-danger" : "text-fg-subtle")}
                      title={outcome}
                    >
                      {outcome}
                    </div>
                  )}
                </TableCell>
                <TableCell className="hidden px-4 text-right sm:table-cell">
                  {seconds == null ? (
                    <Tip label="Nothing was recorded after this session started">
                      <span className="text-fg-faint">
                        <span aria-hidden="true">–</span>
                        <span className="sr-only">Not recorded</span>
                      </span>
                    </Tip>
                  ) : (
                    <span className="text-fg-muted tabular-nums">{seconds < 1 ? "<1s" : formatSpan(seconds)}</span>
                  )}
                </TableCell>
                <TableCell className="hidden pr-5 pl-4 sm:table-cell">
                  <RelativeTime value={s.updated_at || s.created_at} className="text-fg-muted" fallback="Unknown" />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </SectionCard>
  );
}
