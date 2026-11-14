// One trial of one task: why it passed or failed.
//
// A trial is an ordinary session with a grade on it. The grade comes from
// the stored trajectory (the judge's verdict with its reasons, and the
// facts the platform extracted); the replay comes from the session's own
// events, drawn by the same timeline the session page uses.
//
//   bar       the task, the verdict, which trial of how many, and the view
//             switch. It never scrolls.
//   Verdict   the judge's summary and score against the pass mark, every
//             check with its reason and evidence, findings, the simulated
//             user, and what the agent did as the platform recorded it
//   Timeline  the session as a waterfall. Evidence in the verdict links
//             straight to its step here.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link, useOutletContext, useParams, useSearchParams } from "react-router";
import { MessagesSquareIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

import type { AppOutletContext } from "../components/AppShell";
import { Chip } from "../components/Badge";
import { EmptyState, RecordNotFound } from "../components/EmptyState";
import { EntityRef } from "../components/EntityRef";
import { CodeWell } from "../components/EventCard";
import { ModelBadge } from "../components/ModelBadge";
import { PAGE_GUTTER } from "../components/Page";
import { Property, PropertyList } from "../components/PropertyList";
import { ErrorState } from "../components/QueryProblem";
import { RelativeTime } from "../components/RelativeTime";
import { SectionCard } from "../components/SectionCard";
import { SegmentedControl } from "../components/SegmentedControl";
import { Skeleton, SkeletonText } from "../components/Skeleton";
import { TimelineView } from "../components/timeline/TimelineView";
import { Tip } from "../components/Tip";
import { useEvalRun, useTrialTrajectory } from "../components/evals/data";
import { Labeled, VerdictBadge, VerdictMark } from "../components/evals/parts";
import { Messages, SimulationBrief, graderLabel, trialFacts } from "../components/evals/TaskTable";
import { Checks, EvidenceProvider, FindingsCard, ScoreBreakdown, ScoreMeter, TraceFactsCard } from "../components/evals/TrialParts";
import { ApiError, useApi } from "../lib/api";
import { useAgents } from "../lib/directory";
import {
  VERDICT,
  formatScore,
  passMark,
  passMarkPhrase,
  runName,
  trialNumber,
  trialVerdict,
  type EvalRun,
  type EvalTask,
  type EvalTrial,
  type Verdict,
} from "../lib/evals";
import { isReasoningLevel, REASONING_LEVEL_LABELS } from "@open-managed-agents/api-types";
import type { Event } from "../lib/events";
import { formatCompact, plural } from "../lib/format";
import { cn } from "../lib/utils";

type View = "verdict" | "timeline";

/** The page's width: wide, so the bar, the verdict and the timeline share their edges. */
const CONTAINER = cn("mx-auto w-full max-w-[1440px]", PAGE_GUTTER);
const ASIDE_ROW = "grid-cols-[6.5rem_minmax(0,1fr)]";

/** Every event of a session, oldest first (the same paged walk the session page does). */
function useSessionEvents(sessionId: string | undefined) {
  const { api } = useApi();
  const [state, setState] = useState<{ events: Event[]; loading: boolean; error: unknown }>({ events: [], loading: false, error: null });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    setState({ events: [], loading: true, error: null });
    void (async () => {
      const acc: Event[] = [];
      let afterSeq = 0;
      let error: unknown = null;
      // Bounded, so a malformed next_page can never spin forever.
      for (let i = 0; i < 500; i++) {
        try {
          const res = await api<{
            data: Array<{ seq?: number; type: string; ts?: string; data: Event }>;
            has_more?: boolean;
            next_page?: string | null;
          }>(`/v1/sessions/${sessionId}/events?limit=200&order=asc&after_seq=${afterSeq}`, { silentErrors: true });
          for (const e of res.data) {
            const inner = e.data || (e as unknown as Event);
            if (e.ts && !inner.ts) inner.ts = e.ts;
            if (e.seq !== undefined && inner.seq === undefined) inner.seq = e.seq;
            acc.push(inner);
          }
          if (cancelled) return;
          setState({ events: [...acc], loading: true, error: null });
          if (!res.has_more || !res.next_page) break;
          const m = /^seq_(\d+)$/.exec(res.next_page);
          if (!m) break;
          const next = parseInt(m[1], 10);
          if (!Number.isFinite(next) || next <= afterSeq) break;
          afterSeq = next;
        } catch (e) {
          error = e;
          break;
        }
      }
      if (!cancelled) setState({ events: acc, loading: false, error: acc.length === 0 ? error : null });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, attempt]);
  return { ...state, reload: () => setAttempt((n) => n + 1) };
}

export function EvalTrialDetail() {
  const { id: runId, taskId, trialIndex } = useParams<{ id: string; taskId: string; trialIndex: string }>();
  const { data: run, isLoading, error, refetch } = useEvalRun(runId);

  const task = run?.tasks.find((t) => t.id === taskId);
  const trial = task?.trials.find((tr) => tr.trial_index === Number(trialIndex));
  const sessionId = trial?.session_id;

  const { events, loading: eventsLoading, error: eventsError, reload: reloadEvents } = useSessionEvents(sessionId);
  const trajectory = useTrialTrajectory(trial);

  // The view lives in the URL so a timeline can be linked to.
  const [params, setParams] = useSearchParams();
  const view: View = params.get("view") === "timeline" && sessionId ? "timeline" : "verdict";
  const setView = useCallback(
    (next: View) => {
      const sp = new URLSearchParams(params);
      if (next === "verdict") sp.delete("view");
      else sp.set("view", next);
      setParams(sp, { replace: true });
    },
    [params, setParams],
  );

  // Evidence links: switch to the timeline and open the step that holds the event.
  const [scrollTarget, setScrollTarget] = useState<{ eventId: string; nonce: number } | null>(null);
  const jumpTo = useCallback(
    (eventId: string) => {
      setScrollTarget((cur) => ({ eventId, nonce: (cur?.nonce ?? 0) + 1 }));
      setView("timeline");
    },
    [setView],
  );

  if (error && !run) {
    const missing = error instanceof ApiError && error.status === 404;
    return (
      <div className={cn(CONTAINER, "pt-6")}>
        {missing ? (
          <RecordNotFound thing="eval run" kind="eval" back={{ to: "/evals", label: "evals" }} />
        ) : (
          <ErrorState title="This trial could not be loaded" error={error} retry={() => void refetch()} />
        )}
      </div>
    );
  }
  if (isLoading || !run) return <TrialSkeleton />;
  if (!task || !trial) {
    return (
      <div className={cn(CONTAINER, "pt-6")}>
        <EmptyState
          kind="eval"
          size="lg"
          heading="h1"
          title="This trial does not exist"
          body={`${runName(run)} has no ${task ? `trial ${Number.isFinite(Number(trialIndex)) ? trialNumber(Number(trialIndex)) : ""} of this task` : "task with this name"}.`}
          action={
            <Button asChild>
              <Link to={`/evals/${run.id}`}>Back to the run</Link>
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <TrialPage
      run={run}
      task={task}
      trial={trial}
      trajectory={trajectory}
      events={events}
      eventsLoading={eventsLoading}
      eventsError={eventsError}
      reloadEvents={reloadEvents}
      view={view}
      setView={setView}
      scrollTarget={scrollTarget}
      jumpTo={jumpTo}
    />
  );
}

function TrialPage({
  run,
  task,
  trial,
  trajectory,
  events,
  eventsLoading,
  eventsError,
  reloadEvents,
  view,
  setView,
  scrollTarget,
  jumpTo,
}: {
  run: EvalRun;
  task: EvalTask;
  trial: EvalTrial;
  trajectory: ReturnType<typeof useTrialTrajectory>;
  events: Event[];
  eventsLoading: boolean;
  eventsError: unknown;
  reloadEvents: () => void;
  view: View;
  setView: (v: View) => void;
  scrollTarget: { eventId: string; nonce: number } | null;
  jumpTo: (eventId: string) => void;
}) {
  const { byId: agentsById } = useAgents();
  const agent = agentsById.get(run.agent_id);
  const mark = passMark(task.spec);
  const n = trialNumber(trial.trial_index);
  const total = task.trials.length;
  const sessionId = trial.session_id;

  const traj = trajectory.data;
  const reward = traj?.reward;
  const meta = reward?.metadata;
  const judge = meta?.verdict;
  const judgeFailed = meta?.judge_error === true;
  // The judge failing to run says nothing about the agent: never show it as a fail.
  const verdict: Verdict = judgeFailed ? "ungraded" : trialVerdict(trial, mark);
  const score = typeof trial.reward === "number" ? trial.reward : reward?.final_reward;
  const scored = (verdict === "passed" || verdict === "failed") && typeof score === "number";
  const grader = graderLabel(reward);
  const facts = trialFacts(trial);
  const failedChecks = judge?.criteria.filter((c) => !c.pass).length ?? 0;
  const trajectoryPending = trajectory.isLoading && (!!trial.trajectory_id || !!sessionId);

  // The line under the title. Later facts drop out on narrow panels rather
  // than wrap: each is repeated in the page below.
  const subline: Array<{ node: ReactNode; show?: string }> = [
    {
      node: (
        <span>
          Trial {n} of {total}
        </span>
      ),
    },
    { node: <EntityRef kind="agent" id={run.agent_id} name={agent?.name} avatar={false} className="font-normal text-fg-muted" /> },
    ...(scored
      ? [
          {
            node: (
              <span className="tabular-nums">
                Scored {formatScore(score)}, {passMarkPhrase(mark)}
              </span>
            ),
            show: "hidden min-[1100px]:inline-flex",
          },
        ]
      : []),
    ...facts.map((f) => ({ node: <span>{f}</span>, show: "hidden min-[1340px]:inline-flex" })),
  ];

  return (
    <EvidenceProvider events={events} onJump={jumpTo}>
      <div className="flex h-full min-h-0 flex-col">
        <TrialBar>
          <VerdictMark verdict={verdict} size="lg" className="mt-0.5 self-start" />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2.5">
              <Tip label={task.id} delay={600}>
                <h1 className="min-w-0 truncate text-h2 text-fg">{task.id}</h1>
              </Tip>
              <VerdictBadge verdict={verdict} variant="soft" />
            </div>
            <div className="mt-0.5 flex min-w-0 items-center gap-x-1.5 overflow-hidden text-small whitespace-nowrap text-fg-muted">
              {subline.map((part, i) => (
                <span key={i} className={cn("min-w-0 shrink-0 items-center gap-x-1.5", part.show ?? "inline-flex")}>
                  {i > 0 && (
                    <span aria-hidden="true" className="text-fg-faint">
                      ·
                    </span>
                  )}
                  {part.node}
                </span>
              ))}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2 self-start">
            {sessionId && (
              <SegmentedControl<View>
                label="Trial view"
                value={view}
                onChange={setView}
                options={[
                  { value: "verdict", label: "Verdict" },
                  { value: "timeline", label: "Timeline" },
                ]}
              />
            )}
            {sessionId && (
              <Tip label="The full conversation this trial recorded">
                <Button variant="outline" asChild>
                  <Link to={`/sessions/${sessionId}`}>
                    <MessagesSquareIcon data-icon="inline-start" />
                    Open session
                  </Link>
                </Button>
              </Tip>
            )}
          </div>
        </TrialBar>

        {view === "timeline" ? (
          eventsError ? (
            <div className={cn(CONTAINER, "pt-6")}>
              <ErrorState title="The session's events could not be loaded" error={eventsError} retry={reloadEvents} />
            </div>
          ) : (
            <TimelineView
              events={events}
              loading={eventsLoading}
              scrollTarget={scrollTarget}
              // In a trial nobody at this screen sent the messages: the task did, or the simulated user.
              sender={
                task.spec.simulation
                  ? { name: "Simulated user", message: "Message from the simulated user" }
                  : { name: "Task", message: "Message from the task" }
              }
            />
          )
        ) : (
          <div data-slot="trial-scroll" className="no-scrollbar min-h-0 flex-1 overflow-y-auto">
            <div className={cn(CONTAINER, "grid animate-rise-in gap-4 pt-6 pb-16 xl:grid-cols-[minmax(0,1fr)_340px]")}>
              <div className="min-w-0 space-y-4">
                {/* The verdict: what the judge decided, the score against the mark, and every check. */}
                <section className="surface overflow-hidden rounded-xl">
                  <div className="flex flex-col gap-5 p-5 sm:flex-row sm:items-start sm:justify-between">
                    <div className="flex min-w-0 items-start gap-4">
                      <VerdictMark verdict={verdict} size="xl" />
                      <div className="min-w-0">
                        <h2 className="text-h2 text-fg">{verdictHeadline(verdict, failedChecks, judge?.criteria.length ?? 0)}</h2>
                        {trajectoryPending ? (
                          <SkeletonText lines={2} className="mt-2 w-[min(28rem,60vw)]" />
                        ) : (
                          <p className="mt-1 max-w-[68ch] text-[0.9375rem] leading-relaxed text-fg-muted">
                            {verdictSentence({ verdict, trial, judgeSummary: judge?.summary, judgeReason: meta?.reason, hasTrajectory: !!traj })}
                          </p>
                        )}
                        {grader && !judgeFailed && scored && !trajectoryPending && (
                          <p className="mt-2 text-xs text-fg-subtle">
                            Graded by {grader}
                            {meta?.judge_reasoning_level ? ` at ${reasoningWords(meta.judge_reasoning_level)} reasoning` : ""}
                          </p>
                        )}
                      </div>
                    </div>
                    {scored && (
                      <div className="w-full shrink-0 sm:w-[188px]">
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="text-small text-fg-muted">Score</span>
                          <span className="text-stat text-fg tabular-nums">
                            {formatScore(score)}
                          </span>
                        </div>
                        <ScoreMeter score={score as number} mark={mark} verdict={verdict} className="mt-3" />
                        <p className="mt-2 text-right text-xs text-fg-subtle">
                          {mark >= 1 ? "A trial needs a full score to pass" : `The pass mark is ${formatScore(mark)}`}
                        </p>
                      </div>
                    )}
                  </div>

                  {trial.error && (
                    <div className="border-t border-border px-5 py-4">
                      <Labeled label="What the runner reported">
                        <CodeWell tone="danger">{trial.error}</CodeWell>
                      </Labeled>
                    </div>
                  )}

                  {trajectoryPending ? (
                    <div className="space-y-4 border-t border-border p-5" aria-hidden="true">
                      {[0, 1, 2].map((i) => (
                        <div key={i} className="flex gap-3">
                          <Skeleton className="size-5 shrink-0" rounded="full" />
                          <div className="flex-1 space-y-2">
                            <Skeleton className="h-3" rounded="sm" style={{ width: `${24 + i * 8}%` }} />
                            <Skeleton className="h-3 w-3/4" rounded="sm" />
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : judge && judge.criteria.length > 0 ? (
                    <div className="border-t border-border p-5">
                      <div className="mb-3 flex items-baseline justify-between gap-3">
                        <h3 className="text-h3 text-fg">Checks</h3>
                        <span className="text-small text-fg-muted">
                          {judge.criteria.length - failedChecks} of {judge.criteria.length} passed
                        </span>
                      </div>
                      <Checks criteria={judge.criteria} />
                    </div>
                  ) : reward && !judgeFailed && Object.keys(reward.raw_rewards ?? {}).length > 0 ? (
                    <div className="border-t border-border p-5">
                      <h3 className="mb-3 text-h3 text-fg">Score breakdown</h3>
                      <ScoreBreakdown reward={reward} />
                    </div>
                  ) : null}
                </section>

                {judge?.findings && judge.findings.length > 0 && <FindingsCard findings={judge.findings} />}

                {task.spec.simulation && (
                  <SectionCard
                    title="The simulated user"
                    description="A model played the user from this brief. The agent saw only its messages."
                    actions={
                      trial.sim_ended_by && (
                        <Tip
                          label={
                            trial.sim_ended_by === "persona"
                              ? "The simulated user ended the conversation, as its brief told it to"
                              : "The conversation was cut off at the turn limit before the simulated user was done"
                          }
                        >
                          <span className="inline-flex">
                            <Chip tone={trial.sim_ended_by === "persona" ? "neutral" : "warning"}>
                              {trial.sim_ended_by === "persona" ? "Ended by the user" : "Hit the turn limit"}
                            </Chip>
                          </span>
                        </Tip>
                      )
                    }
                  >
                    <SimulationBrief sim={task.spec.simulation} />
                  </SectionCard>
                )}

                {traj?.trace_facts && <TraceFactsCard facts={traj.trace_facts} />}
              </div>

              {/* Below xl the aside drops under the verdict and lays its cards side by side. */}
              <aside className="grid min-w-0 content-start gap-4 md:grid-cols-2 xl:grid-cols-1">
                <SectionCard title="Trial">
                  <PropertyList>
                    <Property label="Run" className={ASIDE_ROW}>
                      <Link
                        to={`/evals/${run.id}`}
                        className="block truncate rounded-sm font-medium decoration-border-strong underline-offset-4 hover:underline"
                        title={runName(run)}
                      >
                        {runName(run)}
                      </Link>
                    </Property>
                    <Property label="Agent" className={ASIDE_ROW}>
                      <EntityRef kind="agent" id={run.agent_id} />
                    </Property>
                    <Property label="Session" className={ASIDE_ROW} empty="None kept">
                      {sessionId && <EntityRef kind="session" id={sessionId} />}
                    </Property>
                    <Property label="Started" className={ASIDE_ROW} empty="Not started">
                      {trial.started_at && <RelativeTime value={trial.started_at} />}
                    </Property>
                    {facts.length > 0 && (
                      <Property label="Took" className={ASIDE_ROW} align="start">
                        <span className="block py-0.5">{facts.join(" · ")}</span>
                      </Property>
                    )}
                    {meta?.judge_model_id && (
                      <Property label="Judge" className={ASIDE_ROW}>
                        <span className="flex min-w-0 flex-wrap items-center gap-x-2">
                          <ModelBadge model={meta.judge_model_id} variant="plain" className="text-fg" />
                          {meta.judge_reasoning_level && <span className="text-xs text-fg-subtle">{reasoningWords(meta.judge_reasoning_level)} reasoning</span>}
                        </span>
                      </Property>
                    )}
                    {meta?.usage && (meta.usage.input_tokens ?? meta.usage.output_tokens) !== undefined && (
                      <Property label="Judge tokens" className={ASIDE_ROW}>
                        <span className="tabular-nums">
                          {formatCompact(meta.usage.input_tokens ?? 0)} in · {formatCompact(meta.usage.output_tokens ?? 0)} out
                        </span>
                      </Property>
                    )}
                    {trial.persona_model_id && (
                      <Property label="Played by" className={ASIDE_ROW}>
                        <Tip label="The model that played the simulated user">
                          <span className="inline-flex">
                            <ModelBadge model={trial.persona_model_id} variant="plain" className="text-fg" />
                          </span>
                        </Tip>
                      </Property>
                    )}
                    {trial.persona_usage && (
                      <Property label="User tokens" className={ASIDE_ROW}>
                        <Tip label={`${plural(trial.persona_usage.calls, "model call")} by the simulated user`}>
                          <span className="tabular-nums">
                            {formatCompact(trial.persona_usage.input_tokens)} in · {formatCompact(trial.persona_usage.output_tokens)} out
                          </span>
                        </Tip>
                      </Property>
                    )}
                  </PropertyList>
                </SectionCard>

                {!task.spec.simulation && (task.spec.messages?.length ?? 0) > 0 && (
                  <SectionCard title="The task">
                    <Messages messages={task.spec.messages ?? []} />
                  </SectionCard>
                )}

                {total > 1 && (
                  <SectionCard title="Trials of this task" description={`A trial ${passMarkPhrase(mark)} to pass.`}>
                    <ul className="-mx-2">
                      {task.trials.map((t) => {
                        const v = trialVerdict(t, mark);
                        const current = t.trial_index === trial.trial_index;
                        const row = (
                          <>
                            <VerdictMark verdict={v} size="sm" />
                            <span className="text-small font-medium text-fg">Trial {trialNumber(t.trial_index)}</span>
                            <span className="min-w-0 flex-1 truncate text-right text-xs text-fg-subtle tabular-nums">
                              {current ? "This trial" : v === "passed" || v === "failed" ? formatScore(t.reward) : !t.session_id ? "No session kept" : ""}
                            </span>
                            <span className="w-[68px] shrink-0 text-right text-xs font-medium whitespace-nowrap text-fg-muted">{VERDICT[v].label}</span>
                          </>
                        );
                        const cls = "flex h-10 items-center gap-2.5 rounded-md px-2";
                        return (
                          <li key={t.trial_index}>
                            {current ? (
                              <div className={cn(cls, "bg-bg-soft")} aria-current="page">
                                {row}
                              </div>
                            ) : t.session_id ? (
                              <Link
                                to={`/evals/${run.id}/trials/${encodeURIComponent(task.id)}/${t.trial_index}`}
                                className={cn(cls, "transition-quick hover:bg-bg-hover")}
                              >
                                {row}
                              </Link>
                            ) : (
                              <div className={cls}>{row}</div>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </SectionCard>
                )}
              </aside>
            </div>
          </div>
        )}
      </div>
    </EvidenceProvider>
  );
}

function verdictHeadline(verdict: Verdict, failedChecks: number, checks: number): string {
  if (verdict === "passed") return "Passed";
  if (verdict === "failed") return checks > 0 && failedChecks > 0 ? `Failed ${failedChecks} of ${plural(checks, "check")}` : "Failed";
  if (verdict === "error") return "Stopped by an error";
  if (verdict === "ungraded") return "Not graded";
  if (verdict === "running") return "Still running";
  return "Waiting to start";
}

function verdictSentence({
  verdict,
  trial,
  judgeSummary,
  judgeReason,
  hasTrajectory,
}: {
  verdict: Verdict;
  trial: EvalTrial;
  judgeSummary?: string;
  judgeReason?: unknown;
  hasTrajectory: boolean;
}): string {
  if (verdict === "error") return "The trial did not finish, so the judge had nothing to grade. It counts as not passed.";
  if (verdict === "running") return "The agent is still working on this trial. The verdict appears here when the judge has graded it.";
  if (verdict === "queued") return "This trial has not started yet.";
  if (verdict === "ungraded") {
    if (typeof judgeReason === "string" && judgeReason) return `The judge could not run: ${judgeReason}. The trial is left out of the result.`;
    return trial.ungraded || hasTrajectory
      ? "The judge could not run, so there is no score. The trial is left out of the result."
      : "No score was recorded for this trial.";
  }
  if (judgeSummary) return judgeSummary;
  return hasTrajectory
    ? "The check recorded a score and no written reasons."
    : "The score is on record, but the judge's reasons were not kept for this trial.";
}

/** The fixed bar of the page, in the shell's header slot (as the session bar is). */
function TrialBar({ children }: { children: ReactNode }) {
  const slot = useOutletContext<AppOutletContext | undefined>()?.pageHeaderSlot;
  if (!slot) return null;
  return createPortal(
    <div data-slot="trial-bar" className="border-b border-border">
      <div className={cn(CONTAINER, "flex items-center gap-3 pt-1 pb-3.5")}>{children}</div>
    </div>,
    slot,
  );
}

function TrialSkeleton() {
  return (
    <div className="flex h-full min-h-0 flex-col" aria-hidden="true">
      <TrialBar>
        <Skeleton className="size-8 shrink-0" rounded="lg" />
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton className="h-4.5 w-[min(22rem,60%)]" rounded="sm" />
          <Skeleton className="h-3 w-72" rounded="sm" />
        </div>
        <Skeleton className="h-9 w-44" rounded="full" />
      </TrialBar>
      <div className={cn(CONTAINER, "grid gap-4 pt-6 xl:grid-cols-[minmax(0,1fr)_340px]")}>
        <div className="surface rounded-xl p-5">
          <div className="flex items-start gap-4">
            <Skeleton className="size-11 shrink-0" rounded="xl" />
            <div className="flex-1 space-y-2.5 pt-1">
              <Skeleton className="h-5 w-32" rounded="sm" />
              <SkeletonText lines={2} className="max-w-md" />
            </div>
          </div>
          <div className="mt-8 space-y-5">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex gap-3">
                <Skeleton className="size-5 shrink-0" rounded="full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-3" rounded="sm" style={{ width: `${22 + i * 7}%` }} />
                  <Skeleton className="h-3 w-3/4" rounded="sm" />
                </div>
              </div>
            ))}
          </div>
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

/** A reasoning level in words ("Extra High"), lower-cased to sit mid-sentence. */
function reasoningWords(level: string): string {
  return (isReasoningLevel(level) ? REASONING_LEVEL_LABELS[level] : level.replace(/[-_]/g, " ")).toLowerCase();
}
