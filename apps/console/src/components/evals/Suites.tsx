import { PanelGroup } from "../PanelGroup";
import { Link } from "react-router";
import { ArrowDownRightIcon, ArrowUpRightIcon, CopyIcon, DramaIcon, FlaskConicalIcon, PlayIcon, Trash2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { copyText } from "@/lib/clipboard";
import { useAgents } from "@/lib/directory";
import { passMark, passMarkPhrase, percent, taskPrompt, type EvalSuiteSummary, type EvalTaskSpec } from "@/lib/evals";
import { plural } from "@/lib/format";
import { cn } from "@/lib/utils";

import { AgentAvatar, EntityAvatar } from "../AgentAvatar";
import { Chip } from "../Badge";
import { EmptyState } from "../EmptyState";
import { EntityRef } from "../EntityRef";
import { IdChip } from "../IdChip";
import { ModelBadge } from "../ModelBadge";
import { Property, PropertyList } from "../PropertyList";
import { ErrorState } from "../QueryProblem";
import { RelativeTime } from "../RelativeTime";
import { RowActionsMenu } from "../RowActionsMenu";
import { Skeleton } from "../Skeleton";
import { Tip } from "../Tip";
import { passRateChange, useEvalSuite, type RunWithSummary } from "./data";
import { TaskStrip, VerdictBadge } from "./parts";

/**
 * Suites: saved sets of tasks that are run again and again.
 *
 *   <SuiteCard>    a suite in the gallery: what it tests, on which agent,
 *                  how its last run went and whether that was better or
 *                  worse than the one before. The card opens the sheet;
 *                  "Run" starts a run.
 *   <SuiteSheet>   the suite, inspected without leaving the page: its
 *                  tasks in words, its recent runs, its details.
 *   <PassRateDelta> the change against the previous run, in points.
 */

/** "+40 pts" against the run before, green when it went up. */
export function PassRateDelta({ points, className }: { points: number; className?: string }) {
  if (points === 0) return <span className={cn("text-xs text-fg-subtle", className)}>No change</span>;
  const up = points > 0;
  const Icon = up ? ArrowUpRightIcon : ArrowDownRightIcon;
  return (
    <span className={cn("inline-flex items-center gap-0.5 text-xs font-medium", up ? "text-success" : "text-danger", className)}>
      <Icon className="size-3.5" />
      {Math.abs(points)} {Math.abs(points) === 1 ? "pt" : "pts"}
    </span>
  );
}

function SuiteAgent({ agentId }: { agentId?: string }) {
  const { byId, isLoading } = useAgents();
  if (!agentId) return <span>No agent set</span>;
  const agent = byId.get(agentId);
  if (!agent) return isLoading ? <Skeleton className="h-3 w-24" rounded="sm" /> : <span>Deleted agent</span>;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <AgentAvatar name={agent.name} id={agent.id} size="xs" archived={!!agent.archived_at} />
      <span className="truncate">{agent.name}</span>
    </span>
  );
}

export function SuiteCard({
  suite,
  history,
  index = 0,
  onOpen,
  onRun,
  onDelete,
}: {
  suite: EvalSuiteSummary;
  /** This suite's runs, newest first. */
  history: RunWithSummary[] | undefined;
  index?: number;
  onOpen: () => void;
  onRun: () => void;
  onDelete: () => void;
}) {
  // The headline is the last run that finished; a run in progress is said in the footer.
  const running = history?.find((h) => h.summary.active);
  const latest = history?.find((h) => !h.summary.active);
  const change = latest ? passRateChange(latest, history) : null;
  const empty = suite.task_count === 0;

  return (
    <article
      className={cn(
        "group/card lift stagger relative flex animate-rise-in flex-col rounded-xl border border-border bg-bg-surface p-5 shadow-[var(--shadow-sm)]",
        // Keyboard focus rings the whole card, since the whole card opens the suite.
        "has-[h3>button:focus-visible]:outline-2 has-[h3>button:focus-visible]:outline-offset-2 has-[h3>button:focus-visible]:outline-plum",
      )}
      style={{ "--i": Math.min(index, 12) } as React.CSSProperties}
    >
      <div className="flex items-start gap-3">
        <EntityAvatar icon={FlaskConicalIcon} size="lg" />
        <div className="min-w-0 flex-1 pt-px">
          <h3 className="flex text-h3 text-fg" title={suite.name}>
            {/* The stretched button makes the whole card the click target. */}
            <button
              type="button"
              className="min-w-0 truncate rounded-sm text-left after:absolute after:inset-0 after:rounded-xl focus-visible:outline-none"
              onClick={onOpen}
            >
              {suite.name}
            </button>
          </h3>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-small text-fg-muted">
            <span className="shrink-0">{plural(suite.task_count, "task")}</span>
            <span aria-hidden="true" className="text-fg-faint">
              ·
            </span>
            <SuiteAgent agentId={suite.agent_id} />
          </div>
        </div>
        <div className="relative z-10 -mt-1 -mr-2 shrink-0 opacity-0 transition-quick group-focus-within/card:opacity-100 group-hover/card:opacity-100 has-[[aria-expanded=true]]:opacity-100">
          <RowActionsMenu
            label={`Actions for ${suite.name}`}
            actions={[
              { label: "Run suite", icon: <PlayIcon />, disabled: empty, onSelect: onRun },
              { label: "Copy suite id", icon: <CopyIcon />, onSelect: () => void copyText(suite.id) },
              { label: "Delete", icon: <Trash2Icon />, destructive: true, onSelect: onDelete },
            ]}
          />
        </div>
      </div>

      <div className="mt-5 flex min-h-[52px] items-end justify-between gap-4">
        {latest ? (
          <>
            <div className="min-w-0">
              <div className="flex items-baseline gap-2">
                <span className="text-stat text-fg tabular-nums">
                  {latest.summary.passRate !== null ? percent(latest.summary.passRate) : "—"}
                </span>
                {change && <PassRateDelta points={change.points} />}
              </div>
              <p className="mt-2 truncate text-xs text-fg-subtle">
                {latest.summary.passRate !== null
                  ? `${latest.summary.trials.passed} of ${latest.summary.trials.graded} trials passed`
                  : "No trial was graded"}
              </p>
            </div>
            <span className="relative z-10 mb-0.5 inline-flex">
              <TaskStrip summary={latest.summary} />
            </span>
          </>
        ) : (
          <p className="self-center text-small text-fg-subtle">
            {empty ? "No tasks yet. Save a session as an eval to add the first." : running ? "Its first run is under way." : "Not run yet."}
          </p>
        )}
      </div>

      <div className="mt-5 flex items-center justify-between gap-3 border-t border-border pt-4">
        <div className="flex min-w-0 items-center gap-2 text-xs text-fg-subtle">
          {running ?? latest ? (
            <>
              <VerdictBadge verdict={(running ?? latest)!.summary.verdict} className="text-xs" />
              <span aria-hidden="true" className="text-fg-faint">
                ·
              </span>
              <RelativeTime value={(running ?? latest)!.run.started_at ?? (running ?? latest)!.run.created_at} className="truncate" />
            </>
          ) : (
            <RelativeTime value={suite.updated_at} prefix="Updated" />
          )}
        </div>
        <Tip label={empty ? "This suite has no tasks to run" : undefined}>
          <span className="relative z-10 shrink-0">
            <Button variant="outline" size="sm" disabled={empty} onClick={onRun} aria-label={`Run ${suite.name}`}>
              <PlayIcon data-icon="inline-start" className="size-3! fill-current" />
              Run
            </Button>
          </span>
        </Tip>
      </div>
    </article>
  );
}

// ── Sheet ───────────────────────────────────────────────────────────────

/** One task of a suite, in words: its name, what the agent is asked, how it is graded. */
export function TaskSpecRow({ spec }: { spec: EvalTaskSpec }) {
  const prompt = taskPrompt(spec);
  const trials = spec.trials ?? 1;
  const more = (spec.messages?.length ?? 0) - 1;
  return (
    <li className="flex gap-3 py-3 first:pt-0 last:pb-0">
      <EntityAvatar icon={spec.simulation ? DramaIcon : FlaskConicalIcon} size="sm" className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <p className="truncate font-mono text-small-size font-medium text-fg" title={spec.id}>
          {spec.id}
        </p>
        {prompt && (
          <p className="mt-0.5 line-clamp-2 text-small text-fg-muted" title={prompt}>
            {prompt}
          </p>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {spec.simulation && <Chip>Simulated user</Chip>}
          {more > 0 && <Chip>{plural(more, "more message")}</Chip>}
          <Chip>{plural(trials, "trial")}</Chip>
          <Chip title="The score a trial needs to pass">{`Pass mark: ${passMarkPhrase(passMark(spec)).replace(/^needs /, "")}`}</Chip>
        </div>
      </div>
    </li>
  );
}

export function SuiteSheet({
  suite,
  history,
  onClose,
  onRun,
  onDelete,
}: {
  suite: EvalSuiteSummary | null;
  history: RunWithSummary[] | undefined;
  onClose: () => void;
  onRun: (suite: EvalSuiteSummary) => void;
  onDelete: (suite: EvalSuiteSummary) => void;
}) {
  return (
    <Sheet open={!!suite} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        className="w-full gap-0 p-0 outline-none data-[side=right]:sm:max-w-[560px]"
        // Keep focus on the panel: the first focusable element is a copy chip,
        // and focusing it would pop its tooltip on open.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement | null)?.focus?.();
        }}
        tabIndex={-1}
      >
        {suite && <SuiteSheetBody key={suite.id} suite={suite} history={history} onRun={onRun} onDelete={onDelete} />}
      </SheetContent>
    </Sheet>
  );
}

function SuiteSheetBody({
  suite,
  history,
  onRun,
  onDelete,
}: {
  suite: EvalSuiteSummary;
  history: RunWithSummary[] | undefined;
  onRun: (suite: EvalSuiteSummary) => void;
  onDelete: (suite: EvalSuiteSummary) => void;
}) {
  const detail = useEvalSuite(suite.id);
  const tasks = detail.data?.tasks ?? [];
  const judgeModel = suite.judge?.model_id;
  const runs = history ?? [];

  return (
    <>
      <SheetHeader className="flex-row items-start gap-4 pb-5">
        <EntityAvatar icon={FlaskConicalIcon} size="xl" />
        <div className="min-w-0 flex-1 pt-0.5">
          <SheetTitle className="truncate" title={suite.name}>
            {suite.name}
          </SheetTitle>
          <SheetDescription className="mt-1">
            {suite.task_count === 0
              ? "An empty suite. Save a session as an eval to add its first task."
              : `${plural(suite.task_count, "task")} to run again after every change to the agent.`}
          </SheetDescription>
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {suite.agent_id && <EntityRef kind="agent" id={suite.agent_id} variant="chip" />}
            {runs[0] && <VerdictBadge verdict={runs[0].summary.verdict} variant="soft" />}
            <IdChip id={suite.id} />
          </div>
        </div>
      </SheetHeader>

      <div className="min-h-0 flex-1 space-y-7 overflow-y-auto px-6 pb-6">
        <PanelGroup label={`Tasks${tasks.length > 0 ? ` (${tasks.length})` : ""}`}>
          {detail.error ? (
            <ErrorState compact title="The tasks could not be loaded" error={detail.error} retry={() => void detail.refetch()} />
          ) : detail.isLoading ? (
            <div className="space-y-4" aria-hidden="true">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex gap-3">
                  <Skeleton className="size-6 shrink-0" rounded="md" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-3" rounded="sm" style={{ width: `${32 + i * 9}%` }} />
                    <Skeleton className="h-3 w-4/5" rounded="sm" />
                  </div>
                </div>
              ))}
            </div>
          ) : tasks.length === 0 ? (
            <p className="text-small text-fg-muted">
              No tasks yet. Open a session that went the way you want and choose Save as eval.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {tasks.map((t) => (
                <TaskSpecRow key={t.id} spec={t} />
              ))}
            </ul>
          )}
        </PanelGroup>

        <PanelGroup label="Recent runs">
          {runs.length === 0 ? (
            <p className="text-small text-fg-muted">This suite has not been run yet.</p>
          ) : (
            <RunHistoryList runs={runs.slice(0, 6)} />
          )}
        </PanelGroup>

        <PanelGroup label="Details">
          <PropertyList>
            <Property label="Agent" empty="No agent set">
              {suite.agent_id && <EntityRef kind="agent" id={suite.agent_id} />}
            </Property>
            {judgeModel && (
              <Property label="Judge">
                <ModelBadge model={judgeModel} variant="plain" className="text-fg" />
              </Property>
            )}
            <Property label="Created">
              <RelativeTime value={suite.created_at} />
            </Property>
            <Property label="Updated">
              <RelativeTime value={suite.updated_at} />
            </Property>
            <Property label="Suite id">
              <IdChip id={suite.id} full />
            </Property>
          </PropertyList>
        </PanelGroup>
      </div>

      <SheetFooter className="flex-row items-center justify-between gap-2 bg-bg-inset/60 px-6 py-4">
        <Button variant="ghost" onClick={() => onDelete(suite)}>
          <Trash2Icon data-icon="inline-start" />
          Delete suite
        </Button>
        <Button disabled={suite.task_count === 0} onClick={() => onRun(suite)}>
          <PlayIcon data-icon="inline-start" className="size-3! fill-current" />
          Run suite
        </Button>
      </SheetFooter>
    </>
  );
}

/**
 * Runs of one suite, newest first: pass rate, the task strip, the verdict
 * and when. Each row opens its run. `currentId` marks the run being read.
 */
export function RunHistoryList({ runs, currentId }: { runs: RunWithSummary[]; currentId?: string }) {
  if (runs.length === 0) return <EmptyState size="sm" variant="plain" title="No runs yet" />;
  return (
    <ul className="-mx-2">
      {runs.map(({ run, summary }) => {
        const current = run.id === currentId;
        const row = (
          <>
            <span className="w-10 shrink-0 text-small font-medium text-fg tabular-nums">
              {summary.passRate !== null ? percent(summary.passRate) : "—"}
            </span>
            <TaskStrip summary={summary} size="sm" tip={false} max={12} />
            <span className="min-w-0 flex-1 truncate text-right text-xs text-fg-subtle">
              {current ? "This run" : <RelativeTime value={run.started_at ?? run.created_at} />}
            </span>
            <VerdictBadge verdict={summary.verdict} className="w-[74px] justify-end text-xs" />
          </>
        );
        return (
          <li key={run.id}>
            {current ? (
              <div className="flex h-10 items-center gap-3 rounded-md bg-bg-soft px-2">{row}</div>
            ) : (
              <Link to={`/evals/${run.id}`} className="flex h-10 items-center gap-3 rounded-md px-2 transition-quick hover:bg-bg-hover">
                {row}
              </Link>
            )}
          </li>
        );
      })}
    </ul>
  );
}
