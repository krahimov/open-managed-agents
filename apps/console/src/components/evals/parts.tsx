import type { ComponentType, ReactNode } from "react";
import { Link } from "react-router";
import {
  CheckIcon,
  DramaIcon,
  FlaskConicalIcon,
  GitCompareArrowsIcon,
  ListChecksIcon,
  LoaderCircleIcon,
  MinusIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import {
  SEVERITY,
  TASK_VERDICT_MEANING,
  VERDICT,
  formatScore,
  passMarkPhrase,
  trialNumber,
  type EvalTrial,
  type RunKind,
  type RunSummary,
  type TaskSummary,
  type Verdict,
} from "@/lib/evals";

import { Chip, StatusBadge } from "../Badge";
import { Tip } from "../Tip";

/**
 * The small parts every eval screen is built from. They all read the one
 * verdict vocabulary in `lib/evals.ts`, so a result looks and reads the
 * same in the runs list, on a run and on a trial.
 *
 *   <VerdictBadge verdict="flaky" />              ● Flaky (dot; `variant="soft"` for headers)
 *   <VerdictMark verdict="passed" />              the glyph in a tinted disc (trial marks, checks)
 *   <TaskStrip summary={runSummary(run)} />       one small bar per task: how the run went, at a glance
 *   <TrialMarks task={…} runId={…} />             one mark per trial, each a link to that trial
 *   <ScoreText mean spread />                     0.83 ± 0.24
 *   <SeverityChip severity="major" />             a judge finding's weight
 */

/** The mark of a run, by what kind of run it is. Suites wear the Evals icon. */
export const RUN_KIND_ICON: Record<RunKind, ComponentType<{ className?: string }>> = {
  suite: FlaskConicalIcon,
  simulation: DramaIcon,
  comparison: GitCompareArrowsIcon,
  oneoff: ListChecksIcon,
};

// ── Verdict ─────────────────────────────────────────────────────────────

export function VerdictBadge({
  verdict,
  variant = "dot",
  className,
}: {
  verdict: Verdict;
  variant?: "dot" | "soft";
  className?: string;
}) {
  const def = VERDICT[verdict];
  // `status` only drives the live halo ("running"); label and tone are ours.
  return <StatusBadge status={verdict} label={def.label} tone={def.tone} variant={variant} className={className} />;
}

/** A tilde: "sometimes". Drawn on the lucide grid with the same stroke. */
function TildeIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M4 14c1.7-3.6 4.4-4.2 7-1.7s5.3 1.9 7-1.7" />
    </svg>
  );
}

export const VERDICT_ICON: Record<Verdict, ComponentType<{ className?: string }>> = {
  passed: CheckIcon,
  flaky: TildeIcon,
  failed: XIcon,
  error: TriangleAlertIcon,
  ungraded: MinusIcon,
  running: LoaderCircleIcon,
  queued: MinusIcon,
};

const MARK_TONE: Record<Verdict, string> = {
  passed: "bg-success-subtle text-success",
  flaky: "bg-warning-subtle text-warning",
  failed: "bg-danger-subtle text-danger",
  error: "bg-danger-subtle text-danger",
  ungraded: "bg-bg-soft text-fg-subtle",
  running: "bg-info-subtle text-info",
  queued: "bg-bg-soft text-fg-faint",
};

const MARK_SIZE = {
  xs: { box: "size-4", icon: "size-2.5 stroke-[3]" },
  sm: { box: "size-5", icon: "size-3 stroke-[2.75]" },
  md: { box: "size-6", icon: "size-3.5 stroke-[2.5]" },
  lg: { box: "size-8 rounded-[10px]", icon: "size-4 stroke-[2.25]" },
  xl: { box: "size-11 rounded-[13px]", icon: "size-5 stroke-[2.25]" },
} as const;

/**
 * A verdict as a glyph in a tinted disc. The glyph carries the meaning
 * (check, cross, tilde, warning), the tint repeats it, so it never relies
 * on colour alone. `lg` and `xl` are squircle tiles for headers.
 */
export function VerdictMark({
  verdict,
  size = "sm",
  className,
}: {
  verdict: Verdict;
  size?: keyof typeof MARK_SIZE;
  className?: string;
}) {
  const Icon = VERDICT_ICON[verdict];
  const s = MARK_SIZE[size];
  return (
    <span
      aria-hidden="true"
      className={cn("inline-flex shrink-0 items-center justify-center rounded-full", MARK_TONE[verdict], s.box, className)}
    >
      <Icon className={cn(s.icon, verdict === "running" && "motion-safe:animate-spin")} />
    </span>
  );
}

// ── Task strip ──────────────────────────────────────────────────────────

const BAR_FILL: Record<Verdict, string> = {
  passed: "bg-success-solid",
  flaky: "bg-warning-solid",
  failed: "bg-danger-solid",
  error: "bg-danger-solid",
  ungraded: "bg-fg-faint",
  running: "bg-info-solid",
  queued: "bg-fg-faint",
};

/** How full a task's bar is: the share of its trials that passed. */
function fillOf(s: TaskSummary): number {
  if (s.verdict === "passed") return 1;
  if (s.verdict === "running") return 0.5;
  if (s.verdict === "flaky") return Math.min(Math.max(s.graded > 0 ? s.passed / s.graded : 0.5, 0.3), 0.8);
  return 0.16;
}

function stripLabel(summary: RunSummary): string {
  const c = summary.taskCounts;
  const parts = [
    c.passed > 0 && `${c.passed} passed`,
    c.flaky > 0 && `${c.flaky} flaky`,
    c.failed > 0 && `${c.failed} failed`,
    c.ungraded > 0 && `${c.ungraded} not graded`,
    // Running or queued: both are "not finished", only one is running.
    c.active > 0 && `${c.active} not finished yet`,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "No tasks";
}

/**
 * One run, as a row of small bars: one bar per task, in suite order. A
 * full green bar passed every trial, a part-filled amber bar passed some
 * (the fill is the share), a red stub passed none. Two runs of the same
 * suite line up bar for bar, so a regression is visible without reading
 * a number.
 *
 * Past `max` tasks the bars would be slivers, so it becomes one
 * proportion bar (passed / flaky / failed).
 */
export function TaskStrip({
  summary,
  max = 16,
  size = "md",
  tip = true,
  className,
}: {
  summary: RunSummary;
  max?: number;
  size?: "sm" | "md";
  /** Explain the bars on hover. Turn off when the parent has its own tooltip. */
  tip?: boolean;
  className?: string;
}) {
  const { tasks, taskCounts: c } = summary;
  if (tasks.length === 0) return null;
  const label = stripLabel(summary);

  const body =
    tasks.length > max ? (
      <span
        role="img"
        aria-label={label}
        className={cn("flex h-1.5 w-20 shrink-0 gap-0.5 overflow-hidden rounded-full", className)}
      >
        {(
          [
            ["passed", c.passed],
            ["flaky", c.flaky],
            ["failed", c.failed],
            ["ungraded", c.ungraded],
            ["running", c.active],
          ] as Array<[Verdict, number]>
        )
          .filter(([, n]) => n > 0)
          .map(([v, n]) => (
            <span key={v} className={cn("h-full min-w-1 rounded-full", BAR_FILL[v])} style={{ width: `${(100 * n) / c.total}%` }} />
          ))}
      </span>
    ) : (
      <span role="img" aria-label={label} className={cn("inline-flex shrink-0 items-end gap-[3px]", size === "md" ? "h-5" : "h-4", className)}>
        {tasks.map(({ task, summary: s }) => (
          <span key={task.id} className={cn("relative h-full overflow-hidden rounded-[2.5px] bg-bg-soft", size === "md" ? "w-1.5" : "w-[5px]")}>
            <span
              className={cn(
                "absolute inset-x-0 bottom-0 rounded-[2.5px]",
                BAR_FILL[s.verdict],
                s.verdict === "running" && "motion-safe:animate-pulse",
                s.verdict === "queued" && "opacity-50",
              )}
              style={{ height: `${Math.round(fillOf(s) * 100)}%` }}
            />
          </span>
        ))}
      </span>
    );

  if (!tip) return body;
  const listed = tasks.slice(0, 10);
  return (
    <Tip
      label={
        <span className="block space-y-0.5 text-left">
          {listed.map(({ task, summary: s }) => (
            <span key={task.id} className="flex items-center justify-between gap-4">
              <span className="font-mono">{task.id}</span>
              <span className="opacity-80">
                {VERDICT[s.verdict].label}
                {s.graded > 0 && ` ${s.passed}/${s.graded}`}
              </span>
            </span>
          ))}
          {tasks.length > listed.length && <span className="block opacity-70">and {tasks.length - listed.length} more</span>}
        </span>
      }
    >
      {body}
    </Tip>
  );
}

// ── Trial marks ─────────────────────────────────────────────────────────

/** Why a trial got its verdict, in a few words (tooltips, row captions). */
export function trialReason(trial: EvalTrial, verdict: Verdict, mark: number): string {
  if (verdict === "error") return trial.error?.trim() || "Stopped before it finished";
  if (verdict === "ungraded") return "The judge could not grade this trial";
  if (verdict === "running") return "Still running";
  if (verdict === "queued") return "Waiting to start";
  const score = `Scored ${formatScore(trial.reward)}`;
  return verdict === "passed" ? score : `${score}, ${passMarkPhrase(mark)}`;
}

/**
 * One mark per trial of a task, in order. A trial with a recorded session
 * links to its trial page; the tooltip says which trial it is and why it
 * got its verdict.
 */
export function TrialMarks({
  summary,
  runId,
  taskId,
  size = "sm",
  className,
}: {
  summary: TaskSummary;
  runId: string;
  taskId: string;
  size?: "xs" | "sm" | "md";
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      {summary.trials.map(({ trial, verdict }) => {
        const n = trialNumber(trial.trial_index);
        const tip = (
          <span className="block max-w-[260px] text-left">
            <span className="block font-medium">
              Trial {n} · {VERDICT[verdict].label}
            </span>
            <span className="block opacity-80">{trialReason(trial, verdict, summary.mark)}</span>
          </span>
        );
        const mark = <VerdictMark verdict={verdict} size={size} />;
        return (
          <Tip key={trial.trial_index} label={tip}>
            {trial.session_id ? (
              <Link
                to={`/evals/${runId}/trials/${encodeURIComponent(taskId)}/${trial.trial_index}`}
                onClick={(e) => e.stopPropagation()}
                aria-label={`Trial ${n}: ${VERDICT[verdict].label}. Open trial`}
                className="inline-flex rounded-full transition-quick hover:brightness-95 hover:saturate-150 dark:hover:brightness-125"
              >
                {mark}
              </Link>
            ) : (
              <span role="img" aria-label={`Trial ${n}: ${VERDICT[verdict].label}`} className="inline-flex">
                {mark}
              </span>
            )}
          </Tip>
        );
      })}
    </span>
  );
}

// ── Numbers ─────────────────────────────────────────────────────────────

/** A task's score across its trials: the average, and how much it moved. */
export function ScoreText({
  mean,
  spread,
  pending,
  className,
}: {
  mean: number | null;
  spread?: number | null;
  /** The trials are not finished: there is nothing to average yet. */
  pending?: boolean;
  className?: string;
}) {
  if (mean === null) {
    return pending ? (
      <span className={cn("text-fg-faint", className)}>
        <span aria-hidden="true">—</span>
        <span className="sr-only">Not scored yet</span>
      </span>
    ) : (
      <span className={cn("text-fg-subtle", className)}>No score</span>
    );
  }
  const showSpread = spread != null && spread >= 0.005;
  return (
    <Tip
      label={
        showSpread
          ? "Average judge score across the trials (0 to 1), and how much it varied between them"
          : "Average judge score across the trials, from 0 to 1"
      }
    >
      <span className={cn("whitespace-nowrap tabular-nums", className)}>
        <span className="font-medium text-fg">{formatScore(mean)}</span>
        {showSpread && <span className="text-fg-subtle"> ± {formatScore(spread)}</span>}
      </span>
    </Tip>
  );
}

/**
 * A proportion bar: how many of the total passed. One fill, one track.
 * `tone` is the verdict's, so the bar agrees with the badge beside it.
 */
export function PassBar({
  value,
  max,
  verdict,
  className,
}: {
  value: number;
  max: number;
  verdict?: Verdict;
  className?: string;
}) {
  const ratio = max > 0 ? Math.min(Math.max(value / max, 0), 1) : 0;
  const fill = verdict ? BAR_FILL[verdict] : "bg-ink";
  return (
    <div
      role="meter"
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      className={cn("h-1.5 overflow-hidden rounded-full bg-bg-soft", className)}
    >
      <div
        className={cn("h-full rounded-full transition-[width] duration-[var(--dur-slow)] ease-[var(--ease-rise)]", fill)}
        style={{ width: `${ratio * 100}%` }}
      />
    </div>
  );
}

// ── Findings ────────────────────────────────────────────────────────────

export function SeverityChip({ severity, count, className }: { severity: string; count?: number; className?: string }) {
  const def = SEVERITY[severity] ?? { label: severity, tone: "neutral" as const };
  return (
    <Chip tone={def.tone === "plum" ? "neutral" : def.tone} className={className}>
      {count !== undefined ? `${count} ${def.label.toLowerCase()}` : def.label}
    </Chip>
  );
}

/** A quiet line that defines the verdict words: "Passed: every trial passed". */
export function VerdictLegend({ verdicts = ["passed", "flaky", "failed"], className }: { verdicts?: Verdict[]; className?: string }) {
  return (
    <ul className={cn("flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs text-fg-muted", className)}>
      {verdicts.map((v) => (
        <li key={v} className="flex items-center gap-1.5">
          <VerdictMark verdict={v} size="xs" />
          <span>
            <span className="font-medium text-fg">{VERDICT[v].label}:</span> {TASK_VERDICT_MEANING[v].toLowerCase()}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** A labelled block inside a card or sheet: 12px medium label, then content. */
export function Labeled({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={className}>
      <div className="mb-1.5 text-xs font-medium text-fg-subtle">{label}</div>
      {children}
    </div>
  );
}
