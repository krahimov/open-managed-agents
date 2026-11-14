import { useState, type CSSProperties } from "react";
import { Link } from "react-router";
import { ArrowDownIcon, ArrowUpIcon, ChevronRightIcon, MessagesSquareIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  SEVERITY,
  VERDICT,
  formatScore,
  humanizeId,
  passMarkPhrase,
  severityRank,
  taskPrompt,
  trialNumber,
  type EvalRun,
  type EvalTask,
  type EvalTrial,
  type SimulationSpec,
  type TaskSummary,
  type Verdict,
} from "@/lib/evals";
import { formatSpan, plural, toDate } from "@/lib/format";
import { describeModel } from "@/lib/models";
import type { RewardResult } from "@/lib/trajectory";
import { cn } from "@/lib/utils";

import { Chip } from "../Badge";
import { Disclosure } from "../Disclosure";
import { CodeWell } from "../EventCard";
import { Skeleton } from "../Skeleton";
import { Tip } from "../Tip";
import { useTrialTrajectory } from "./data";
import { Labeled, ScoreText, TrialMarks, VerdictBadge, VerdictMark, trialReason } from "./parts";

/**
 * The tasks of a run, as rows that open.
 *
 * Closed, a row answers "did this task pass?": the task, one mark per
 * trial (each a link to that trial), how many passed, the score and the
 * verdict. Open, it answers "what happened?": what the agent was asked,
 * each trial with the reason for its verdict, and the scripts and output
 * behind it.
 *
 * Opening a row loads the stored record of each of its trials, which is
 * where the judge's reasons live; nothing is fetched for a closed row.
 */

/** Task · Trials · Score · Verdict. Below `md` only task and verdict. */
const COLS = "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-5 md:grid-cols-[minmax(0,1fr)_auto_100px_88px]";

export function TaskTable({
  run,
  tasks,
  noun = "Task",
  previous,
  previousWhen,
}: {
  run: EvalRun;
  tasks: Array<{ task: EvalTask; summary: TaskSummary }>;
  /** Column heading: "Task", or "Scenario" when every row is a simulation. */
  noun?: string;
  /** Each task's verdict in the suite's previous run, to mark what moved. */
  previous?: Map<string, Verdict>;
  /** When that run was, for the tooltip: "Oct 28". */
  previousWhen?: string;
}) {
  // One mark per trial; the column is as wide as the longest row needs.
  const marks = Math.max(...tasks.map((t) => t.summary.total), 1);
  const marksWidth = { minWidth: `${Math.max(marks * 24 - 4, 48)}px` };
  // In a run of simulations every row is one; the chip only helps in a mixed run.
  const mixed = tasks.some((t) => t.summary.simulation) && tasks.some((t) => !t.summary.simulation);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div>
      <div className={cn(COLS, "hidden h-9 border-b border-border pr-5 pl-[52px] text-xs font-medium text-fg-subtle md:grid")}>
        <span>{noun}</span>
        <span style={marksWidth}>Trials</span>
        <span>Score</span>
        <span>Verdict</span>
      </div>
      <ul>
        {tasks.map(({ task, summary }) => (
          <TaskRow
            key={task.id}
            run={run}
            task={task}
            summary={summary}
            open={open.has(task.id)}
            onToggle={() => toggle(task.id)}
            marksWidth={marksWidth}
            showKind={mixed}
            before={previous?.get(task.id)}
            beforeWhen={previousWhen}
          />
        ))}
      </ul>
    </div>
  );
}

function TaskRow({
  run,
  task,
  summary,
  open,
  onToggle,
  marksWidth,
  showKind,
  before,
  beforeWhen,
}: {
  run: EvalRun;
  task: EvalTask;
  summary: TaskSummary;
  open: boolean;
  onToggle: () => void;
  marksWidth: CSSProperties;
  showKind: boolean;
  before?: Verdict;
  beforeWhen?: string;
}) {
  const prompt = taskPrompt(task.spec);
  const moved = verdictMove(before, summary.verdict);
  const panelId = `task-${run.id}-${task.id}`;
  return (
    <li className="border-t border-border first:border-t-0">
      <div className={cn(COLS, "group/row relative min-h-[60px] py-2.5 pr-5 pl-3 transition-quick hover:bg-bg-hover", open && "bg-bg-inset/60")}>
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex size-8 shrink-0 items-center justify-center text-fg-subtle">
            <ChevronRightIcon
              className={cn("size-4 transition-transform duration-[var(--dur-base)] ease-[var(--ease-rise)]", open && "rotate-90")}
            />
          </span>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              {/* The stretched button makes the whole row the click target. */}
              <button
                type="button"
                aria-expanded={open}
                aria-controls={panelId}
                onClick={onToggle}
                className="min-w-0 truncate rounded-sm text-left font-mono text-small-size font-medium text-fg after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-plum"
                title={task.id}
              >
                {task.id}
              </button>
              {showKind && summary.simulation && <Chip className="hidden lg:inline-flex">Simulated user</Chip>}
            </div>
            {prompt && (
              <p className="truncate text-xs text-fg-subtle" title={prompt}>
                {prompt}
              </p>
            )}
          </div>
        </div>
        <div className="relative z-10 hidden md:block" style={marksWidth}>
          <TrialMarks summary={summary} runId={run.id} taskId={task.id} />
        </div>
        <div className="relative z-10 hidden text-small md:block">
          <ScoreText mean={summary.mean} spread={summary.spread} pending={summary.verdict === "running" || summary.verdict === "queued"} />
        </div>
        <span className="relative z-10 inline-flex items-center gap-1.5 justify-self-start">
          <Tip label={verdictTip(summary)}>
            <span className="inline-flex">
              <VerdictBadge verdict={summary.verdict} />
            </span>
          </Tip>
          {moved !== 0 && before && (
            <Tip label={`${moved > 0 ? "Better" : "Worse"} than the run before${beforeWhen ? ` (${beforeWhen})` : ""}, where it ${VERDICT[before].label.toLowerCase()}`}>
              <span
                role="img"
                aria-label={moved > 0 ? "Better than the run before" : "Worse than the run before"}
                className={cn("inline-flex size-4 items-center justify-center rounded-full", moved > 0 ? "bg-success-subtle text-success" : "bg-danger-subtle text-danger")}
              >
                {moved > 0 ? <ArrowUpIcon className="size-3 stroke-[2.5]" /> : <ArrowDownIcon className="size-3 stroke-[2.5]" />}
              </span>
            </Tip>
          )}
        </span>
      </div>
      {open && <TaskPanel id={panelId} run={run} task={task} summary={summary} />}
    </li>
  );
}

const VERDICT_RANK: Partial<Record<Verdict, number>> = { passed: 3, flaky: 2, failed: 1, error: 1 };

/** +1 when a task did better than in the run before, -1 when worse, 0 when it held or cannot be compared. */
export function verdictMove(before: Verdict | undefined, now: Verdict): number {
  const a = before ? VERDICT_RANK[before] : undefined;
  const b = VERDICT_RANK[now];
  if (a === undefined || b === undefined) return 0;
  return Math.sign(b - a);
}

function verdictTip(s: TaskSummary): string {
  if (s.verdict === "passed") return s.total === 1 ? "Its one trial passed" : `All ${s.graded} trials passed`;
  if (s.verdict === "flaky") return `${s.passed} of ${s.graded} trials passed`;
  if (s.verdict === "failed") return s.graded === 1 ? "Its one trial did not pass" : `None of the ${s.graded} trials passed`;
  if (s.verdict === "ungraded") return "The judge could not grade any trial";
  if (s.verdict === "running") return `${s.finished} of ${s.total} trials finished`;
  return "Waiting to start";
}

function TaskPanel({ id, run, task, summary }: { id: string; run: EvalRun; task: EvalTask; summary: TaskSummary }) {
  const spec = task.spec;
  const outputs = task.trials.filter((t) => t.output_tail);
  return (
    <div id={id} className="animate-fade-in space-y-5 border-t border-border bg-bg-inset/60 py-5 pr-5 pl-[52px]">
      {spec.simulation ? <SimulationBrief sim={spec.simulation} /> : <Messages messages={spec.messages ?? []} />}

      <Labeled
        label={
          <>
            {plural(summary.total, "trial")}
            <span className="font-normal"> · each {passMarkPhrase(summary.mark)} to pass</span>
          </>
        }
      >
        <ul className="divide-y divide-border rounded-lg border border-border bg-bg-surface">
          {summary.trials.map(({ trial, verdict }) => (
            <TrialRow key={trial.trial_index} runId={run.id} taskId={task.id} trial={trial} verdict={verdict} mark={summary.mark} />
          ))}
        </ul>
      </Labeled>

      {(outputs.length > 0 || spec.setup_script || (spec.setup_files?.length ?? 0) > 0) && (
        <div className="space-y-2">
          {outputs.length > 0 && (
            <Disclosure title="Check output" meta="The last lines the checking script printed">
              <div className="space-y-3">
                {outputs.map((t) => (
                  <Labeled key={t.trial_index} label={`Trial ${trialNumber(t.trial_index)}`}>
                    <CodeWell>{t.output_tail}</CodeWell>
                  </Labeled>
                ))}
              </div>
            </Disclosure>
          )}
          {spec.setup_script && (
            <Disclosure title="Setup script" meta="Runs in the sandbox before the first message">
              <CodeWell>{spec.setup_script}</CodeWell>
            </Disclosure>
          )}
          {(spec.setup_files?.length ?? 0) > 0 && (
            <Disclosure title="Setup files" meta={plural(spec.setup_files!.length, "file")}>
              <ul className="space-y-1">
                {spec.setup_files!.map((f) => (
                  <li key={f.path} className="truncate font-mono text-xs text-fg-muted" title={f.path}>
                    {f.path}
                  </li>
                ))}
              </ul>
            </Disclosure>
          )}
        </div>
      )}
    </div>
  );
}

/** What the agent is sent: the first message in full, the rest numbered. */
export function Messages({ messages }: { messages: string[] }) {
  if (messages.length === 0) return null;
  return (
    <Labeled label={messages.length === 1 ? "The agent is asked" : `The agent is sent ${messages.length} messages`}>
      <ol className="space-y-2">
        {messages.map((m, i) => (
          <li key={i} className="flex gap-2.5">
            {messages.length > 1 && <span className="mt-2 w-4 shrink-0 text-right text-xs text-fg-subtle tabular-nums">{i + 1}</span>}
            <p className="max-w-[72ch] rounded-lg rounded-tl-sm bg-bg-soft px-3.5 py-2 text-small whitespace-pre-wrap text-fg">{m}</p>
          </li>
        ))}
      </ol>
    </Labeled>
  );
}

/** A simulated-user task in words: the situation, who plays the user, what they want. */
export function SimulationBrief({ sim, className }: { sim: SimulationSpec; className?: string }) {
  const p = sim.persona;
  return (
    <div className={cn("grid gap-x-8 gap-y-4 lg:grid-cols-2", className)}>
      <Labeled label="The situation" className="lg:col-span-2">
        <p className="max-w-[72ch] text-small text-fg">{sim.scenario}</p>
      </Labeled>
      <Labeled label={p.name ? `Played by ${p.name}` : "Who plays the user"}>
        <p className="text-small text-fg-muted">{p.identity}</p>
        {p.communication_style && <p className="mt-1 text-small text-fg-muted">Style: {p.communication_style}</p>}
      </Labeled>
      {p.goals.length > 0 && (
        <Labeled label="What they want">
          <ul className="space-y-1 text-small text-fg-muted">
            {p.goals.map((g, i) => (
              <li key={i} className="flex gap-2">
                <span aria-hidden="true" className="mt-[0.5625rem] size-1 shrink-0 rounded-full bg-fg-faint" />
                <span>{g}</span>
              </li>
            ))}
          </ul>
        </Labeled>
      )}
      {p.hidden_knowledge && (
        <Labeled label="What they only say if asked">
          <p className="text-small text-fg-muted">{p.hidden_knowledge}</p>
        </Labeled>
      )}
      <Labeled label="The conversation ends when">
        <p className="text-small text-fg-muted">
          {p.termination}
          {sim.max_turns ? `, or after ${plural(sim.max_turns, "turn")}` : ""}
        </p>
      </Labeled>
      {sim.opening_message && (
        <Labeled label="Opening message" className="lg:col-span-2">
          <p className="max-w-[72ch] rounded-lg rounded-tl-sm bg-bg-soft px-3.5 py-2 text-small whitespace-pre-wrap text-fg">{sim.opening_message}</p>
        </Labeled>
      )}
    </div>
  );
}

function trialSeconds(trial: EvalTrial): number | null {
  if (typeof trial.duration_seconds === "number") return trial.duration_seconds;
  const start = toDate(trial.started_at);
  const end = toDate(trial.ended_at);
  return start && end ? Math.max(0, (end.getTime() - start.getTime()) / 1000) : null;
}

/** "2m 6s · 1 turn · 3 from the simulated user". */
export function trialFacts(trial: EvalTrial): string[] {
  const facts: string[] = [];
  const seconds = trialSeconds(trial);
  if (seconds !== null) facts.push(formatSpan(seconds));
  if (trial.turns !== undefined) facts.push(plural(trial.turns, "turn"));
  if (trial.persona_turns !== undefined) facts.push(`${plural(trial.persona_turns, "message")} from the simulated user`);
  if (trial.exit_code !== undefined && trial.exit_code !== 0) facts.push(`exit code ${trial.exit_code}`);
  return facts;
}

/** Who graded, as people say it: the judge model, or the name of the check. */
export function graderLabel(reward: RewardResult | undefined): string | null {
  const judge = reward?.metadata?.judge_model_id;
  if (judge) return describeModel(judge).label;
  const id = reward?.verifier_id;
  if (!id) return null;
  const [kind, rest] = id.split(":");
  if (kind === "llm_judge" && rest) return describeModel(rest).label;
  return humanizeId(id.replace(/:/g, " "));
}

function TrialRow({
  runId,
  taskId,
  trial,
  verdict: recorded,
  mark,
}: {
  runId: string;
  taskId: string;
  trial: EvalTrial;
  verdict: Verdict;
  mark: number;
}) {
  // The stored record says why: the judge's summary and the checks that failed.
  const { data: trajectory, isLoading } = useTrialTrajectory(trial);
  const reward = trajectory?.reward;
  const judgeFailed = reward?.metadata?.judge_error === true;
  const verdict: Verdict = judgeFailed ? "ungraded" : recorded;
  const judge = reward?.metadata?.verdict;
  const failedChecks = judge?.criteria.filter((c) => !c.pass).map((c) => humanizeId(c.id)) ?? [];
  const breakdown = !judge && reward ? Object.entries(reward.raw_rewards ?? {}) : [];
  const grader = graderLabel(reward);
  const facts = trialFacts(trial);
  const n = trialNumber(trial.trial_index);
  // What the judge noticed on this trial, beyond the verdict: the most serious first.
  const findings = [...(trial.findings ?? [])].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));

  const reason = judgeFailed
    ? typeof reward?.metadata?.reason === "string"
      ? `The judge could not run: ${reward.metadata.reason}`
      : "The judge could not run, so this trial is left out of the result."
    : verdict === "error" || verdict === "ungraded"
      ? trialReason(trial, verdict, mark)
      : null;

  return (
    <li className="flex items-start gap-3 px-3.5 py-3">
      <VerdictMark verdict={verdict} size="md" className="mt-px" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-small">
          <span className="font-medium text-fg">Trial {n}</span>
          <span className={cn(verdict === "passed" ? "text-success" : verdict === "failed" || verdict === "error" ? "text-danger" : "text-fg-muted")}>
            {VERDICT[verdict].label}
          </span>
          {(verdict === "passed" || verdict === "failed") && (
            <span className="text-fg-muted tabular-nums">
              scored {formatScore(trial.reward)}
              {verdict === "failed" && `, ${passMarkPhrase(mark)}`}
            </span>
          )}
          {facts.length > 0 && <span className="text-xs text-fg-subtle">{facts.join(" · ")}</span>}
        </div>
        {reason && <p className={cn("mt-1 text-small", verdict === "error" ? "text-danger" : "text-fg-muted")}>{reason}</p>}
        {isLoading && trial.session_id && <Skeleton className="mt-2 h-3 w-2/3" rounded="sm" />}
        {judge?.summary && <p className="mt-1 max-w-[72ch] text-small text-fg-muted">{judge.summary}</p>}
        {failedChecks.length > 0 && (
          <p className="mt-1 text-small text-fg-muted">
            <span className="font-medium text-fg">Did not pass:</span> {failedChecks.join(", ")}
          </p>
        )}
        {breakdown.length > 0 && (
          <dl className="mt-2 grid max-w-sm grid-cols-[minmax(0,1fr)_auto] gap-x-6 gap-y-1 text-xs">
            {breakdown.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="truncate text-fg-muted" title={k}>
                  {humanizeId(k)}
                </dt>
                <dd className="text-right font-medium text-fg tabular-nums">{Number.isFinite(v) ? v.toFixed(2) : String(v)}</dd>
              </div>
            ))}
          </dl>
        )}
        {findings.length > 0 && (
          <p className="mt-1 max-w-[72ch] text-small text-fg-muted">
            <span className="font-medium text-fg">
              {findings[0].severity === "info" ? "Noted:" : `${SEVERITY[findings[0].severity]?.label ?? "A"} finding:`}
            </span>{" "}
            {findings[0].summary}
            {findings.length > 1 && <span className="text-fg-subtle"> And {plural(findings.length - 1, "more")}.</span>}
          </p>
        )}
        {grader && !judgeFailed && (verdict === "passed" || verdict === "failed") && (
          <p className="mt-1 text-xs text-fg-subtle">Graded by {grader}</p>
        )}
      </div>
      {trial.session_id ? (
        <div className="flex shrink-0 items-center gap-1">
          <Tip label="Open the recorded session">
            <Button variant="ghost" size="icon-sm" asChild>
              <Link to={`/sessions/${trial.session_id}`} aria-label={`Open the session of trial ${n}`}>
                <MessagesSquareIcon />
              </Link>
            </Button>
          </Tip>
          <Button variant="outline" size="sm" asChild>
            <Link to={`/evals/${runId}/trials/${encodeURIComponent(taskId)}/${trial.trial_index}`}>Open trial</Link>
          </Button>
        </div>
      ) : (
        (verdict === "passed" || verdict === "failed") && (
          <Tip label="This trial kept no session, so there is nothing to replay">
            <span className="shrink-0 py-1.5 text-xs text-fg-subtle">No session kept</span>
          </Tip>
        )
      )}
    </li>
  );
}
