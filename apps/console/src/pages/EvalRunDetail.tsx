import { useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { ArrowUpDownIcon, CircleXIcon, CopyIcon, FlaskConicalIcon, LinkIcon, RotateCwIcon, Trash2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";

import { EntityAvatar } from "../components/AgentAvatar";
import { Chip } from "../components/Badge";
import { Callout } from "../components/Callout";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { DetailHeader } from "../components/DetailHeader";
import { RecordNotFound } from "../components/EmptyState";
import { EntityRef } from "../components/EntityRef";
import { CodeWell } from "../components/EventCard";
import { IdChip } from "../components/IdChip";
import { Page } from "../components/Page";
import { Property, PropertyList } from "../components/PropertyList";
import { ErrorState } from "../components/QueryProblem";
import { RelativeTime } from "../components/RelativeTime";
import { RowActionsMenu } from "../components/RowActionsMenu";
import { SectionCard } from "../components/SectionCard";
import { SegmentedControl } from "../components/SegmentedControl";
import { Skeleton } from "../components/Skeleton";
import { StatTile } from "../components/StatTile";
import { Tip } from "../components/Tip";
import { RUNS_KEY, passRateChange, suiteHistory, useEvalRun, useEvalRuns } from "../components/evals/data";
import { PassBar, RUN_KIND_ICON, SeverityChip, VerdictBadge, VerdictLegend } from "../components/evals/parts";
import { RunDialog, type RunTarget } from "../components/evals/RunDialog";
import { RunHistoryList } from "../components/evals/Suites";
import { TaskTable, verdictMove } from "../components/evals/TaskTable";
import { ApiError, useApi } from "../lib/api";
import { copyText } from "../lib/clipboard";
import { useAgents } from "../lib/directory";
import {
  RUN_KIND_LABEL,
  categoryLabel,
  formatScore,
  percent,
  runName,
  runSentence,
  runShape,
  runSummary,
  runTitle,
  severityRank,
  severityTotals,
  trialNumber,
  type EvalRun,
  type FindingsReport,
  type RunSummary,
} from "../lib/evals";
import { formatDate, formatSpan, plural } from "../lib/format";
import { useQueryClient } from "../lib/useApiQuery";
import { cn } from "@/lib/utils";
import { linkHitArea } from "@/lib/links";

/** Label column for the narrow aside, so a name fits beside it. */
const ASIDE_ROW = "grid-cols-[6.5rem_minmax(0,1fr)]";

/**
 * One eval run: did the agent pass, and where did it not?
 *
 *   header   the run by name (its suite, or what kind of run it is), the
 *            verdict, the result as one sentence, and Run again
 *   tiles    the four numbers, each defined in plain words: trials
 *            passed, tasks that passed every time, tasks that passed at
 *            least once, average score
 *
 * WHILE THE RUN IS GOING (and after one that stopped early) nothing speaks
 * of trials that have not run as if they had. The tiles are labelled "so
 * far" and say what they count against ("1 of the 2 that finished"), the
 * tasks card says how many trials are PLANNED per task rather than that
 * each "ran", and a task that is still running is listed as unfinished,
 * never among the ones that are not passing.
 *   findings what the judge noticed beyond pass or fail (simulations)
 *   tasks    every task with a mark per trial; a row opens to what was
 *            asked and why each trial got its verdict
 *   aside    the run's facts, and the suite's earlier runs for comparison
 */
export function EvalRunDetail() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const { api } = useApi();
  const queryClient = useQueryClient();
  const { byId: agentsById } = useAgents();

  const { data: run, isLoading, error, refetch } = useEvalRun(id);
  const summary = useMemo(() => (run ? runSummary(run) : null), [run]);

  // The suite's other runs give this one something to be compared with.
  const others = useEvalRuns(undefined, !!run?.suite_id);
  const history = useMemo(
    () => (run?.suite_id ? (suiteHistory(others.runs).get(run.suite_id) ?? []) : []),
    [others.runs, run?.suite_id],
  );

  const [runTarget, setRunTarget] = useState<RunTarget | null>(null);
  const [confirm, setConfirm] = useState<"cancel" | "delete" | null>(null);
  // Which tasks are shown lives in the address, like every other view.
  const [searchParams, setSearchParams] = useSearchParams();
  const tasksParam = searchParams.get("tasks");
  const chosen: "all" | "attention" | "unfinished" = tasksParam === "attention" || tasksParam === "unfinished" ? tasksParam : "all";
  const setShow = (v: "all" | "attention" | "unfinished") =>
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (v === "all") next.delete("tasks");
        else next.set("tasks", v);
        return next;
      },
      { replace: true },
    );

  if (error && !run) {
    const missing = error instanceof ApiError && error.status === 404;
    return (
      <Page>
        {missing ? (
          <RecordNotFound thing="eval run" kind="eval" back={{ to: "/evals", label: "evals" }} className="mt-4" />
        ) : (
          <ErrorState title="This run could not be loaded" error={error} retry={() => void refetch()} className="mt-4" />
        )}
      </Page>
    );
  }
  if (isLoading || !run || !summary) {
    return (
      <Page>
        <RunSkeleton />
      </Page>
    );
  }

  const agent = agentsById.get(run.agent_id);
  const title = runTitle(run, agent?.name);
  const change = passRateChange({ run, summary }, history);
  const hasResult = summary.trials.graded > 0;
  const { taskCounts: c, trials } = summary;
  const noun = summary.kind === "simulation" ? "Scenario" : "Task";
  const nounPlural = `${noun}s`;
  // A task with trials still to run has not failed: it is unfinished, and is
  // counted and filtered apart from the tasks that finished without passing.
  const isUnfinished = (v: string) => v === "running" || v === "queued";
  const unfinished = summary.tasks.filter((t) => isUnfinished(t.summary.verdict));
  const attention = summary.tasks.filter((t) => t.summary.verdict !== "passed" && !isUnfinished(t.summary.verdict));
  // A filter whose tasks have all moved on (the run is live) falls back to everything.
  const show =
    (chosen === "attention" && attention.length === 0) || (chosen === "unfinished" && unfinished.length === 0) ? "all" : chosen;
  const shownTasks = show === "attention" ? attention : show === "unfinished" ? unfinished : summary.tasks;
  const k = summary.trialsPerTask;
  // "So far" while it runs; after a run that stopped early the numbers are final but partial.
  const soFar = summary.active ? " so far" : "";
  const partial = !summary.complete;
  // Unfinished tasks are running or still queued: "running" would be untrue of the queued ones.
  const stillWord = summary.active ? (unfinished.length === 1 ? "has not finished yet" : "have not finished yet") : "did not finish";
  const trialsLine =
    k && k > 1 ? (partial ? `${k} trials planned per ${noun.toLowerCase()}. ` : `Each ran ${k} times. `) : "";
  // What moved since the suite's previous finished run, task by task.
  const previous = change ? new Map(change.previous.summary.tasks.map((t) => [t.task.id, t.summary.verdict])) : undefined;
  const previousWhen = change
    ? formatDate(change.previous.run.started_at ?? change.previous.run.created_at).replace(/, \d{4}$/, "")
    : undefined;
  const moves = summary.tasks.map((t) => verdictMove(previous?.get(t.task.id), t.summary.verdict));
  const better = moves.filter((m) => m > 0).length;
  const worse = moves.filter((m) => m < 0).length;
  const noTasks = c.total === 0;

  const details = (columns: 1 | 2) => (
    <PropertyList columns={columns}>
      <Property label="Agent" className={ASIDE_ROW}>
        <span className="flex min-w-0 items-center gap-2">
          <EntityRef kind="agent" id={run.agent_id} />
          {run.agent_version !== undefined && (
            <Tip label={`Ran against version ${run.agent_version} of the agent`}>
              <span className="shrink-0 font-mono text-micro text-fg-subtle">v{run.agent_version}</span>
            </Tip>
          )}
        </span>
      </Property>
      <Property label="Environment" className={ASIDE_ROW}>
        <EntityRef kind="environment" id={run.environment_id} />
      </Property>
      <Property label={summary.kind === "suite" ? "Suite" : "Kind"} className={ASIDE_ROW}>
        {run.suite_id ? (
          <Link
            to={`/evals?view=suites&suite=${run.suite_id}`}
            className="block truncate rounded-sm font-medium decoration-border-strong underline-offset-4 hover:underline"
            title={runName(run)}
          >
            {runName(run)}
          </Link>
        ) : (
          RUN_KIND_LABEL[summary.kind]
        )}
      </Property>
      <Property label="Started" className={ASIDE_ROW} empty="Not started">
        {(run.started_at ?? run.created_at) && <RelativeTime value={run.started_at ?? run.created_at} />}
      </Property>
      <Property
        label={summary.active ? "Running for" : summary.verdict === "error" ? "Stopped after" : "Duration"}
        className={ASIDE_ROW}
        empty="Not recorded"
      >
        {summary.durationSeconds !== null && formatSpan(summary.durationSeconds)}
      </Property>
      <Property label="Run id" className={ASIDE_ROW}>
        <IdChip id={run.id} full />
      </Property>
    </PropertyList>
  );

  return (
    <Page>
      <DetailHeader
        avatar={<EntityAvatar icon={RUN_KIND_ICON[summary.kind]} size="xl" />}
        title={title}
        status={<VerdictBadge verdict={summary.verdict} variant="soft" />}
        description={runSentence(summary)}
        meta={
          <>
            <EntityRef kind="agent" id={run.agent_id} variant="chip" />
            {run.agent_version !== undefined && (
              <Chip tone="outline" mono title={`Ran against version ${run.agent_version} of the agent`}>
                v{run.agent_version}
              </Chip>
            )}
            {c.total > 0 && <Chip>{runShape(summary)}</Chip>}
            {summary.durationSeconds !== null && (
              <Chip>
                {summary.active ? "Running for" : summary.verdict === "error" ? "Stopped after" : "Took"} {formatSpan(summary.durationSeconds)}
              </Chip>
            )}
          </>
        }
        actions={
          summary.active ? (
            <Button variant="outline" onClick={() => setConfirm("cancel")}>
              <CircleXIcon data-icon="inline-start" />
              Cancel run
            </Button>
          ) : (
            run.tasks.length > 0 && (
              <Button onClick={() => setRunTarget({ kind: "rerun", run })}>
                <RotateCwIcon data-icon="inline-start" />
                Run again
              </Button>
            )
          )
        }
        menu={
          <RowActionsMenu
            label={`Actions for ${title}`}
            actions={[
              { label: "Copy link", icon: <LinkIcon />, onSelect: () => void copyText(window.location.href) },
              { label: "Copy run id", icon: <CopyIcon />, onSelect: () => void copyText(run.id) },
              ...(run.suite_id
                ? [{ label: "Open suite", icon: <FlaskConicalIcon />, onSelect: () => nav(`/evals?view=suites&suite=${run.suite_id}`) }]
                : []),
              { label: "Delete", icon: <Trash2Icon />, destructive: true, onSelect: () => setConfirm("delete") },
            ]}
          />
        }
      />

      {run.error && <RunError run={run} summary={summary} />}

      {(hasResult || summary.active) && (
        <div className="mb-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatTile
            label={`Trials passed${soFar}`}
            value={summary.passRate !== null ? percent(summary.passRate) : "None yet"}
            delta={
              change && change.points !== 0
                ? { value: `${Math.abs(change.points)} ${Math.abs(change.points) === 1 ? "pt" : "pts"}`, direction: change.points > 0 ? "up" : "down", good: change.points > 0 }
                : undefined
            }
            hint={
              partial ? (
                // The label says "so far"; this says against what, and how many there will be.
                <>
                  {trials.passed} of {trials.graded} graded · {trials.total} planned
                </>
              ) : (
                <>
                  {trials.passed} of {trials.graded} graded trials
                  {change && (
                    <>
                      . {change.points === 0 ? "The same as" : "It was"} {percent(change.previous.summary.passRate ?? 0)} on {previousWhen}.
                    </>
                  )}
                </>
              )
            }
            footer={<PassBar value={trials.passed} max={Math.max(partial ? trials.total : trials.graded, 1)} />}
          />
          <StatTile
            label={`Passed every time${soFar}`}
            value={
              <>
                {summary.passedAlways}
                <span className="text-fg-subtle"> of {partial ? c.finished : c.total}</span>
              </>
            }
            hint={
              <>
                {partial ? `Finished ${nounPlural.toLowerCase()}` : nounPlural} where {k && k > 1 ? `all ${k} trials` : "every trial"} passed.{" "}
                {partial && `${unfinished.length} ${stillWord}. `}
                <Jargon>pass^k</Jargon>
              </>
            }
            footer={<PassBar value={summary.passedAlways} max={Math.max(c.total, 1)} />}
          />
          <StatTile
            label={`Passed at least once${soFar}`}
            value={
              <>
                {summary.passedOnce}
                <span className="text-fg-subtle"> of {c.total}</span>
              </>
            }
            hint={
              <>
                {nounPlural} where one trial or more {summary.active ? "has passed" : "passed"}. <Jargon>pass@k</Jargon>
              </>
            }
            footer={<PassBar value={summary.passedOnce} max={Math.max(c.total, 1)} />}
          />
          <StatTile
            label={`Average score${soFar}`}
            value={summary.scoreMean !== null ? formatScore(summary.scoreMean) : "None yet"}
            hint={
              partial
                ? `The judge's mean score, 0 to 1, over the ${plural(c.finished, `finished ${noun.toLowerCase()}`)}.`
                : "The judge scores each trial from 0 to 1. This is the mean."
            }
            footer={<PassBar value={summary.scoreMean ?? 0} max={1} />}
          />
        </div>
      )}

      {noTasks ? (
        // Nothing ran, so there is no result to lay out: just the facts of the run.
        <SectionCard title="Details">{details(2)}</SectionCard>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
          <div className="min-w-0 space-y-4">
            {run.findings_report && Object.keys(run.findings_report.by_category).length > 0 && (
              <FindingsCard report={run.findings_report} run={run} />
            )}
            <SectionCard
              title={nounPlural}
              description={
                previous
                  ? `${trialsLine}Since ${previousWhen}, ${movedPhrase(better, worse)}.`
                  : `${trialsLine}Open a row to see ${partial ? "why" : "what was asked and why"}.`
              }
              actions={
                (attention.length > 0 && attention.length < c.total) || (unfinished.length > 0 && unfinished.length < c.total) ? (
                  <SegmentedControl
                    label={`Show ${nounPlural.toLowerCase()}`}
                    size="sm"
                    value={show}
                    onChange={setShow}
                    options={[
                      { value: "all" as const, label: `All ${c.total}` },
                      // Only tasks that finished can be "not passing".
                      ...(attention.length > 0 ? [{ value: "attention" as const, label: `Not passing ${attention.length}` }] : []),
                      ...(unfinished.length > 0 ? [{ value: "unfinished" as const, label: `Unfinished ${unfinished.length}` }] : []),
                    ]}
                  />
                ) : undefined
              }
              flush
              footer={
                <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5">
                  <VerdictLegend />
                  {previous && (better > 0 || worse > 0) && (
                    <span className="flex items-center gap-1.5 text-xs text-fg-muted">
                      <span aria-hidden="true" className="inline-flex size-4 items-center justify-center rounded-full bg-bg-soft text-fg-muted">
                        <ArrowUpDownIcon className="size-3" />
                      </span>
                      moved since {previousWhen}
                    </span>
                  )}
                </div>
              }
            >
              <TaskTable run={run} tasks={shownTasks} noun={noun} previous={previous} previousWhen={previousWhen} />
            </SectionCard>
          </div>

          {/* Below xl the aside drops under the tasks and lays its cards side by side. */}
          <aside className="grid min-w-0 content-start gap-4 md:grid-cols-2 xl:grid-cols-1">
            <SectionCard title="Details">{details(1)}</SectionCard>
            {run.suite_id && (history.length > 1 || others.isLoading) && (
              <SectionCard title="Runs of this suite" description="The same tasks, bar for bar, over time.">
                {others.isLoading ? (
                  <div className="space-y-3" aria-hidden="true">
                    {[0, 1].map((i) => (
                      <Skeleton key={i} className="h-4 w-full" rounded="sm" />
                    ))}
                  </div>
                ) : (
                  <RunHistoryList runs={history.slice(0, 6)} currentId={run.id} />
                )}
              </SectionCard>
            )}
          </aside>
        </div>
      )}

      <RunDialog target={runTarget} onClose={() => setRunTarget(null)} />
      <ConfirmDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        destructive={confirm === "delete"}
        title={confirm === "cancel" ? `Cancel this run of ${runName(run)}?` : `Delete this run of ${runName(run)}?`}
        body={
          confirm === "cancel"
            ? "Trials that are still going are stopped, and the run is removed from the list. This cannot be undone."
            : "The run and its results are removed. The sessions its trials recorded are kept. This cannot be undone."
        }
        confirmLabel={confirm === "cancel" ? "Cancel run" : "Delete run"}
        cancelLabel={confirm === "cancel" ? "Keep running" : "Cancel"}
        onConfirm={async () => {
          // One endpoint does both: it stops a run that is still going, then removes it.
          await api(`${RUNS_KEY}/${run.id}`, { method: "DELETE" });
          void queryClient.invalidateQueries({ queryKey: [RUNS_KEY] });
          nav("/evals");
        }}
      />
    </Page>
  );
}

/** "2 got better and 1 got worse", "nothing moved". */
function movedPhrase(better: number, worse: number): string {
  if (better === 0 && worse === 0) return "no verdict changed";
  const parts = [better > 0 && `${better} got better`, worse > 0 && `${worse} got worse`].filter(Boolean);
  return parts.join(" and ");
}

/** The metric's technical name, for readers who know it by that. */
function Jargon({ children }: { children: string }) {
  return (
    <Tip label={`Also written ${children}, where k is the number of trials per task`}>
      <span className="font-mono text-micro-size whitespace-nowrap text-fg-subtle underline decoration-border-strong decoration-dotted underline-offset-2">
        {children}
      </span>
    </Tip>
  );
}

/** A run that stopped: say that it stopped, what was lost, and the server's reason. */
function RunError({ run, summary }: { run: EvalRun; summary: RunSummary }) {
  const nothingRan = summary.trials.graded === 0;
  return (
    <Callout
      tone="danger"
      title={nothingRan ? "The run stopped before anything was graded" : "The run stopped before it finished"}
      className="mb-4"
    >
      <p>
        {nothingRan
          ? "No trial produced a score, so there is no result to read. This is what the runner reported:"
          : `${plural(summary.trials.graded, "trial")} had been graded when it stopped. This is what the runner reported:`}
      </p>
      <CodeWell tone="danger" className="mt-2 border-danger/15 bg-bg-surface/70">
        {run.error}
      </CodeWell>
    </Callout>
  );
}

/** What the judge noticed across the whole run, worst first. */
function FindingsCard({ report, run }: { report: FindingsReport; run: EvalRun }) {
  const totals = severityTotals(report);
  const count = totals.reduce((a, t) => a + t.count, 0);
  const categories = Object.entries(report.by_category)
    .map(([category, sevs]) => ({
      category,
      count: Object.values(sevs).reduce((a, n) => a + (n ?? 0), 0),
      worst: Object.keys(sevs).sort((a, b) => severityRank(a) - severityRank(b))[0],
    }))
    .filter((x) => x.count > 0)
    .sort((a, b) => severityRank(a.worst) - severityRank(b.worst) || b.count - a.count);
  const top = [...report.top].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
  const sessionOf = (taskId: string, trialIndex: number) =>
    run.tasks.find((t) => t.id === taskId)?.trials.find((tr) => tr.trial_index === trialIndex)?.session_id;

  return (
    <SectionCard
      title={`Findings (${count})`}
      description="What the judge noticed while grading, whether or not the trial passed."
      actions={
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {totals.map((t) => (
            <SeverityChip key={t.severity} severity={t.severity} count={t.count} />
          ))}
        </div>
      }
      flush
      footer={
        <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="text-fg-subtle">By area</span>
          {categories.map((x) => (
            <span key={x.category}>
              <span className="font-medium text-fg">{categoryLabel(x.category)}</span> {x.count}
            </span>
          ))}
          {top.length < count && (
            <span className="ml-auto text-fg-subtle">
              Showing the {top.length} most serious. The rest are on their trials.
            </span>
          )}
        </span>
      }
    >
      <ul>
        {top.map((f, i) => {
          const where = `${f.task_id} · trial ${trialNumber(f.trial_index)}`;
          const session = sessionOf(f.task_id, f.trial_index);
          return (
            <li key={`${f.task_id}-${f.trial_index}-${i}`} className="flex items-start gap-3 border-t border-border px-5 py-3.5 first:border-t-0">
              <SeverityChip severity={f.severity} className="mt-px w-[58px] justify-center" />
              <div className="min-w-0 flex-1">
                <p className="text-small text-fg">{f.summary}</p>
                {f.recommendation && (
                  <p className="mt-1 text-small text-fg-muted">
                    <span className="font-medium text-fg">Suggested fix:</span> {f.recommendation}
                  </p>
                )}
                <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 text-xs text-fg-subtle">
                  <span>{categoryLabel(f.category)}</span>
                  <span aria-hidden="true" className="text-fg-faint">
                    ·
                  </span>
                  {session ? (
                    <Link
                      to={`/evals/${run.id}/trials/${encodeURIComponent(f.task_id)}/${f.trial_index}`}
                      className={cn("rounded-sm font-mono underline-offset-4 hover:text-fg hover:underline", linkHitArea)}
                    >
                      {where}
                    </Link>
                  ) : (
                    <span className="font-mono">{where}</span>
                  )}
                </p>
              </div>
            </li>
          );
        })}
      </ul>
    </SectionCard>
  );
}

/** The run page while it loads: header, four tiles, the tasks card and the aside. */
function RunSkeleton() {
  return (
    <div className="pt-4" aria-hidden="true">
      <div className="flex items-start gap-5 pb-6">
        <Skeleton className="size-14" rounded="xl" />
        <div className="flex-1 space-y-3 pt-1">
          <Skeleton className="h-6 w-72" rounded="md" />
          <Skeleton className="h-3.5 w-[min(30rem,70%)]" rounded="sm" />
          <div className="flex gap-2 pt-1">
            <Skeleton className="h-[22px] w-28" rounded="full" />
            <Skeleton className="h-[22px] w-12" rounded="full" />
            <Skeleton className="h-[22px] w-32" rounded="full" />
          </div>
        </div>
        <Skeleton className="h-9 w-28" rounded="full" />
      </div>
      <div className="mb-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="surface rounded-xl p-5">
            <Skeleton className="h-3 w-24" rounded="sm" />
            <Skeleton className="mt-3 h-8 w-20" rounded="md" />
            <Skeleton className="mt-3 h-3 w-4/5" rounded="sm" />
            <Skeleton className="mt-6 h-1.5 w-full" rounded="full" />
          </div>
        ))}
      </div>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="surface overflow-hidden rounded-xl">
          <div className="space-y-2 px-5 pt-5 pb-4">
            <Skeleton className="h-4 w-20" rounded="sm" />
            <Skeleton className="h-3 w-2/3" rounded="sm" />
          </div>
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="flex h-[60px] items-center gap-4 border-t border-border px-5">
              <Skeleton className="size-4 shrink-0" rounded="sm" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-3" rounded="sm" style={{ width: `${26 + ((i * 11) % 22)}%` }} />
                <Skeleton className="h-2.5" rounded="sm" style={{ width: `${48 + ((i * 7) % 30)}%` }} />
              </div>
              <Skeleton className="hidden h-5 w-20 md:block" rounded="full" />
              <Skeleton className="hidden h-3 w-12 md:block" rounded="sm" />
              <Skeleton className="h-3 w-14" rounded="sm" />
            </div>
          ))}
        </div>
        <div className="surface space-y-4 self-start rounded-xl p-5">
          <Skeleton className="h-4 w-16" rounded="sm" />
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="flex justify-between gap-6">
              <Skeleton className="h-3 w-20" rounded="sm" />
              <Skeleton className="h-3 w-28" rounded="sm" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
