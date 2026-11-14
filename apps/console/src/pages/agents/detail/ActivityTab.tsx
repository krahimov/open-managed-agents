import { Link, useNavigate } from "react-router";
import { ArrowRightIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatSpan, plural } from "@/lib/format";
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
  sectionLinkClass,
} from "../../../components/kit";
import type { AgentRecord } from "../../../types/agent";
import type { SessionRecord } from "../../../types/session";

/** How many sessions the profile loads. Past that the Sessions page takes over. */
export const ACTIVITY_LIMIT = 100;

/**
 * Activity: every session this agent has had, newest first. Rows open the
 * session. Status is upgraded to "Needs approval" or "Failed" when the
 * operations report says a person is needed.
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
            <Skeleton className="h-3.5 w-16" rounded="sm" />
            <Skeleton className="h-3.5 w-14" rounded="sm" />
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
          <col className="w-[170px]" />
          <col className="w-[130px]" />
        </colgroup>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="pl-5">Session</TableHead>
            <TableHead className="px-4">Status</TableHead>
            <TableHead className="pr-5 pl-4">Started</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sessions.map((s) => {
            const reading = read(s);
            const source = sessionSource(s);
            const title = sessionTitle(s, agent.name);
            // `duration_seconds` is only a real run length once the session has ended.
            const ranFor =
              s.status === "terminated" && s.stats?.duration_seconds != null ? formatSpan(s.stats.duration_seconds) : null;
            const facts = [
              source === "console" ? "Started in the console" : `Started from ${SESSION_SOURCE_LABEL[source]}`,
              ranFor ? `ran for ${ranFor}` : null,
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
                  <SessionStatus reading={reading} />
                </TableCell>
                <TableCell className="pr-5 pl-4">
                  <RelativeTime value={s.created_at} className="text-fg-muted" fallback="Unknown" />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </SectionCard>
  );
}
