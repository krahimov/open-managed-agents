import { Link } from "react-router";
import { ArrowRightIcon, ArrowUpRightIcon, CircleStopIcon, GoalIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { formatCompact, formatCost, plural } from "@/lib/format";
import { cn } from "@/lib/utils";

import { AgentAvatar } from "../AgentAvatar";
import { Chip, StatusBadge } from "../Badge";
import { Callout } from "../Callout";
import { Meter } from "../charts";
import { EmptyState } from "../EmptyState";
import { RelativeTime } from "../RelativeTime";
import { SectionCard, sectionLinkClass } from "../SectionCard";
import { SessionStatus } from "../sessions/SessionStatus";
import { Tip } from "../Tip";
import type { OperationActions } from "./actions";
import { budgetLines, missionStatus, type BudgetEntry, type BudgetLine, type Mission, type RunningEntry } from "./model";
import { SessionMark } from "./queue";

/**
 * The live side of Operations: what is working right now and how today's
 * spend sits against the limits. Nothing here is waiting on a person, but
 * a person can stop any of it.
 *
 *   <RunningList>      sessions with an agent at work, or stalled ones
 *                      (compact in the rail). Each row is the session's one
 *                      reading (lib/session-state.ts), so it says here what
 *                      Home, the Sessions list and the session itself say.
 *   <MissionList>      "Run until done" goals, with pause and stop
 *   <BudgetSummary>    the workspace budget at a glance (rail)
 *   <BudgetScopeCard>  one budget scope in full (Budgets tab)
 */

const STOP_SESSION = {
  title: "Stop this session?",
  body: "The agent is interrupted where it is and the session goes idle. The conversation is kept, and work already done is not undone.",
  confirmLabel: "Stop session",
};

function stopSession(entry: RunningEntry, actions: OperationActions) {
  actions.confirm({
    ...STOP_SESSION,
    run: () => actions.run("stop", entry.key, `/v1/operations/sessions/${entry.key}/stop`),
  });
}

function RunningProblem({ actions, scope }: { actions: OperationActions; scope: string }) {
  if (actions.failure?.scope !== scope) return null;
  return (
    <p role="alert" className="mt-1.5 text-xs text-danger">
      Not completed. {actions.failure.message}
    </p>
  );
}

/** Sessions with an agent at work, or stalled ones. `compact` is the rail's version. */
export function RunningList({
  entries,
  actions,
  compact,
}: {
  entries: RunningEntry[];
  actions: OperationActions;
  compact?: boolean;
}) {
  return (
    <ul className="divide-y divide-border">
      {entries.map((entry) => {
        const { session, reading, mission } = entry;
        const stopping = actions.busy === `stop:${entry.key}`;
        const max = mission?.budget?.max_iterations;
        // What the row says after the state: for live work, who and when; for
        // stalled work, how long it has been silent (the one wording).
        const facts = [
          reading.stalled ? reading.detail : reading.status === "rescheduling" ? reading.detail : null,
          !compact || !reading.stalled ? session.agentName : null,
          mission && !compact ? `Run until done, iteration ${mission.iteration}${max ? ` of ${max}` : ""}` : null,
        ].filter(Boolean);
        return (
          <li key={entry.key} className={cn("flex items-center gap-3", compact ? "px-4 py-3" : "px-5 py-3")}>
            <SessionMark session={session} size={compact ? "sm" : "md"} />
            <div className="min-w-0 flex-1">
              <Link
                to={`/sessions/${session.id}`}
                title={session.title}
                className="block truncate rounded-sm text-small font-medium text-fg decoration-border-strong underline-offset-4 hover:underline"
              >
                {session.title}
              </Link>
              <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-fg-subtle">
                <SessionStatus reading={reading} className="text-xs" tip={!reading.stalled && reading.status !== "rescheduling"} />
                {facts.length > 0 && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="truncate" title={facts.join(" · ")}>
                      {facts.join(" · ")}
                    </span>
                  </>
                )}
                {entry.lastEventAt && !reading.stalled ? (
                  <>
                    <span aria-hidden="true">·</span>
                    <RelativeTime value={entry.lastEventAt} prefix={compact ? undefined : "Last event"} fallback="" className="shrink-0" />
                  </>
                ) : null}
              </div>
              <RunningProblem actions={actions} scope={entry.key} />
            </div>
            {compact ? (
              <Tip label="Stop session">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Stop session: ${session.title}`}
                  disabled={actions.locked && !stopping}
                  loading={stopping}
                  onClick={() => stopSession(entry, actions)}
                >
                  <CircleStopIcon />
                </Button>
              </Tip>
            ) : (
              <Button
                variant="outline"
                size="sm"
                disabled={actions.locked && !stopping}
                loading={stopping}
                onClick={() => stopSession(entry, actions)}
              >
                <CircleStopIcon data-icon="inline-start" />
                Stop session
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The heading of the stalled sessions, wherever they are listed: what
 * "stalled" means, said once, so no row has to explain itself.
 */
export function StalledNote({ count, compact }: { count: number; compact?: boolean }) {
  return (
    <div className={cn("flex items-start gap-2", compact ? "px-4 pt-3 pb-1" : "px-5 pt-4 pb-1")}>
      <p className="min-w-0 flex-1 text-xs text-fg-muted">
        <span className="font-medium text-fg">Stalled</span>
        <span className="ml-1.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-warning-subtle px-1.5 align-[1px] text-micro text-warning">
          {count}
        </span>
        <span className="mt-0.5 block">
          {count === 1 ? "It reports" : "They report"} as running and {count === 1 ? "has" : "have"} recorded nothing for half an hour
          or more. Open {count === 1 ? "it" : "one"} to check, or stop it.
        </span>
      </p>
    </div>
  );
}

/** "Run until done" goals. Active ones can be paused (the iteration in flight finishes) or stopped (it is interrupted). */
export function MissionList({
  missions,
  actions,
  agentName,
  compact,
}: {
  missions: Mission[];
  actions: OperationActions;
  agentName: (id: string | undefined) => string | undefined;
  compact?: boolean;
}) {
  return (
    <ul className="divide-y divide-border">
      {missions.map((mission) => {
        const st = missionStatus(mission.status);
        const active = mission.status === "running" || mission.status === "paused";
        const pausing = actions.busy === `pause:${mission.id}`;
        const stopping = actions.busy === `stop-mission:${mission.id}`;
        const agent = agentName(mission.agent_id);
        const max = mission.budget?.max_iterations;
        return (
          <li key={mission.id} className={cn("flex gap-3", compact ? "px-4 py-3" : "px-5 py-4")}>
            {agent ? (
              <AgentAvatar name={agent} id={mission.agent_id} size={compact ? "sm" : "md"} />
            ) : (
              <span
                className={cn(
                  "flex shrink-0 items-center justify-center bg-bg-soft text-fg-muted",
                  compact ? "size-6 rounded-[7px]" : "size-8 rounded-[10px]",
                )}
              >
                <GoalIcon className={compact ? "size-3.5" : "size-4"} />
              </span>
            )}
            <div className="min-w-0 flex-1">
              <p className={cn("text-small font-medium text-fg", compact ? "line-clamp-2" : "line-clamp-3")} title={mission.goal}>
                {mission.goal}
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-subtle">
                <StatusBadge status={st.status} label={st.label} className="text-xs" />
                <span aria-hidden="true">·</span>
                <span>
                  Iteration {mission.iteration}
                  {max ? ` of ${max}` : ""}
                </span>
                {!compact && agent && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="truncate">{agent}</span>
                  </>
                )}
                {mission.updated_at ? (
                  <>
                    <span aria-hidden="true">·</span>
                    <RelativeTime value={mission.updated_at} prefix={compact ? undefined : "Updated"} fallback="" />
                  </>
                ) : null}
              </div>
              {(active || mission.active_session_id) && (
                <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                  {mission.status === "running" && (
                    <Tip label="The iteration in flight finishes. No new one starts.">
                      <Button
                        variant="outline"
                        size="xs"
                        disabled={actions.locked && !pausing}
                        loading={pausing}
                        onClick={() => void actions.run("pause", mission.id, `/v1/missions/${mission.id}/stop`, { mode: "pause_future" })}
                      >
                        Pause future iterations
                      </Button>
                    </Tip>
                  )}
                  {active && (
                    <Tip label="Interrupts the iteration in flight.">
                      <Button
                        variant="outline"
                        size="xs"
                        disabled={actions.locked && !stopping}
                        loading={stopping}
                        onClick={() =>
                          actions.confirm({
                            title: "End this run now?",
                            body: "The iteration in flight is interrupted and no new one starts. Work already done is kept. To let the current iteration finish instead, pause future iterations.",
                            confirmLabel: "End the run",
                            run: () => actions.run("stop-mission", mission.id, `/v1/missions/${mission.id}/stop`, { mode: "stop_now" }),
                          })
                        }
                      >
                        End the run
                      </Button>
                    </Tip>
                  )}
                  {mission.active_session_id &&
                    (compact ? (
                      <Tip label="Open working session">
                        <Link
                          to={`/sessions/${mission.active_session_id}`}
                          aria-label="Open working session"
                          className="inline-flex size-7 items-center justify-center rounded-full text-fg-subtle transition-quick hover:bg-bg-hover hover:text-fg"
                        >
                          <ArrowUpRightIcon className="size-3.5" />
                        </Link>
                      </Tip>
                    ) : (
                      <Link to={`/sessions/${mission.active_session_id}`} className={cn(sectionLinkClass, "h-7 px-2 text-xs")}>
                        Open working session
                      </Link>
                    ))}
                </div>
              )}
              <RunningProblem actions={actions} scope={mission.id} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

const fmtLine = (line: BudgetLine, n: number) => (line.kind === "cost" ? formatCost(n) : formatCompact(n));

/** One limit: a meter when a limit is set, otherwise today's figure and "No limit". */
function BudgetLineRow({ line, exceeded, track }: { line: BudgetLine; exceeded: boolean; track?: boolean }) {
  if (line.limit === null || line.limit <= 0) {
    return (
      <div>
        <div className="flex items-baseline justify-between gap-3 text-small">
          <span className="text-fg-muted">{line.label}</span>
          <span className="text-fg">
            <span className="font-medium">{fmtLine(line, line.used)}</span>
            <span className="text-fg-subtle"> · no limit</span>
          </span>
        </div>
        {/* An empty track keeps the three columns of a scope card on one line. */}
        {track && <div aria-hidden="true" className="mt-1.5 h-1.5 rounded-full bg-bg-soft" />}
      </div>
    );
  }
  return (
    <Meter
      label={line.label}
      value={line.used}
      max={line.limit}
      formatValue={(n) => fmtLine(line, n)}
      tone={exceeded ? "danger" : undefined}
    />
  );
}

/** The workspace budget at a glance, for the rail. */
export function BudgetSummary({ budgets }: { budgets: BudgetEntry[] }) {
  const workspace = budgets.find((b) => b.scope.scope_id === "workspace");
  const others = budgets.filter((b) => b.scope.scope_id !== "workspace" && b.limited);
  const anyLimit = budgets.some((b) => b.limited);
  return (
    <SectionCard
      title="Budgets today"
      description={anyLimit ? "Since 00:00 UTC, against the workspace limits." : undefined}
      actions={
        <Link to="/workspace" className={cn(sectionLinkClass, "-mr-2")}>
          {anyLimit ? "Edit limits" : "Set limits"}
        </Link>
      }
    >
      {!anyLimit ? (
        <p className="text-small text-fg-muted">
          No limits are set, so nothing caps what agents can spend in a day. A limit pauses new work when it is reached.
        </p>
      ) : (
        <div className="space-y-4">
          {workspace &&
            budgetLines(workspace.scope).map((line) => (
              <BudgetLineRow key={line.key} line={line} exceeded={workspace.scope.exceeded.includes(line.key)} />
            ))}
          {others.length > 0 && (
            <Link to="?tab=budgets" className="flex items-center justify-between gap-2 rounded-md text-small text-fg-muted transition-quick hover:text-fg">
              <span>
                {plural(others.length, "agent")} with {others.length === 1 ? "its" : "their"} own limits
                {others.some((b) => b.blocked) ? " · one is reached" : ""}
              </span>
              <ArrowRightIcon className="size-3.5 shrink-0" />
            </Link>
          )}
        </div>
      )}
    </SectionCard>
  );
}

/** One budget scope in full: the three limits, how much of each is used, what is wrong. */
export function BudgetScopeCard({ entry }: { entry: BudgetEntry }) {
  const { scope } = entry;
  const workspace = scope.scope_id === "workspace";
  return (
    <SectionCard
      title={
        <span className="flex min-w-0 items-center gap-2.5">
          {!workspace && <AgentAvatar name={entry.label} id={entry.agentId} size="sm" />}
          <span className="truncate">{entry.label}</span>
          {entry.blocked ? (
            <Chip tone="danger">Limit reached</Chip>
          ) : entry.warnings.length > 0 ? (
            <Chip tone="warning">Near a limit</Chip>
          ) : !entry.limited ? (
            <Chip>No limits</Chip>
          ) : null}
        </span>
      }
      description={
        workspace
          ? "Applies to every session in this workspace."
          : "Applies to this agent's sessions, alongside the workspace limits."
      }
    >
      <div className="grid gap-x-8 gap-y-5 sm:grid-cols-3">
        {budgetLines(scope).map((line) => (
          <BudgetLineRow key={line.key} line={line} exceeded={scope.exceeded.includes(line.key)} track />
        ))}
      </div>
      {scope.usage.unpriced_calls > 0 && scope.limits.daily_cost_usd !== null && (
        <Callout tone="warning" className="mt-5">
          {plural(scope.usage.unpriced_calls, "call")} today {scope.usage.unpriced_calls === 1 ? "has" : "have"} no price estimate, so
          cost-limited work is paused. Add pricing for the model to resume it.
        </Callout>
      )}
    </SectionCard>
  );
}

/** Nothing running: a calm line for the rail, a block for the tab. */
export function NothingRunning({ compact }: { compact?: boolean }) {
  if (compact) return <p className="px-4 py-4 text-small text-fg-muted">No agent is working right now.</p>;
  return (
    <EmptyState
      kind="session"
      title="Nothing is running"
      body="Sessions appear here while an agent is working, with a way to stop them."
    />
  );
}
