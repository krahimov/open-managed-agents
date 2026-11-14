/**
 * Evals: the shapes the eval endpoints return, and the ONE reading of them
 * that every eval screen shares.
 *
 * The API speaks in run states ("completed", "failed") and metrics
 * (pass@k, pass^k, reward). People ask a simpler question: did it pass?
 * This module answers it the same way for a trial, a task and a run, so
 * the list, the run page and the trial page never disagree.
 *
 * Vocabulary (see VERDICT):
 *   Passed      every graded trial cleared its pass mark
 *   Flaky       some trials cleared it and some did not
 *   Failed      no trial cleared it
 *   Error       it could not finish (a run that never started, a trial
 *               that timed out or crashed): the reason is always shown
 *   Not graded  the judge could not run, so there is no score to read
 *   Running / Queued   not finished yet
 *
 * Metrics, in the words the screens use:
 *   pass mark   the score a trial needs (`pass_threshold`, default 1.0)
 *   pass@k      "passed at least once": a task with one passing trial or more
 *   pass^k      "passed every time": a task whose trials all passed
 *
 * Trials are zero-based on the wire and in URLs; people count from one.
 * Always print `trialNumber(trial_index)`.
 *
 * Pure and synchronous: no React, no fetching.
 */
import type { StatusTone } from "@/components/Badge";

import { toDate } from "./format";
import type { JudgeFinding } from "./trajectory";

// ── Wire shapes ─────────────────────────────────────────────────────────

export type EvalRunStatus = "pending" | "running" | "completed" | "failed";

export interface EvalTrial {
  trial_index: number;
  status: EvalRunStatus;
  session_id?: string;
  trajectory_id?: string;
  current_message_index?: number;
  error?: string;
  started_at?: string;
  ended_at?: string;
  /** The judge's score for this attempt, 0 to 1. */
  reward?: number;
  /** The judge could not run: the score says nothing about the agent. */
  ungraded?: boolean;
  exit_code?: number;
  duration_seconds?: number;
  turns?: number;
  output_tail?: string;
  // Simulation trials only.
  persona_turns?: number;
  sim_ended_by?: "persona" | "max_turns";
  persona_model_id?: string;
  persona_usage?: { input_tokens: number; output_tokens: number; calls: number };
  findings?: JudgeFinding[];
}

export interface SimulationPersona {
  name?: string;
  identity: string;
  goals: string[];
  hidden_knowledge?: string;
  communication_style?: string;
  termination: string;
  scripted_messages?: string[];
}

export interface SimulationSpec {
  scenario: string;
  persona: SimulationPersona;
  opening_message?: string;
  max_turns?: number;
  persona_model?: { model_card_id?: string; reasoning_level?: string; cross_family?: boolean };
}

export interface EvalTaskSpec {
  id: string;
  /** Exactly one of `messages` / `simulation` is set (the server enforces it). */
  messages?: string[];
  simulation?: SimulationSpec;
  setup_files?: { path: string; content: string }[];
  setup_script?: string;
  timeout_ms?: number;
  trials?: number;
  pass_threshold?: number;
  reward?: { type?: string; rubric?: string; judge?: { model_card_id?: string; reasoning_level?: string }; [key: string]: unknown };
  [key: string]: unknown;
}

export interface EvalTask {
  id: string;
  spec: EvalTaskSpec;
  status: EvalRunStatus;
  trials: EvalTrial[];
  /** Trials that ran to the end (NOT trials that passed; see `taskSummary`). */
  trial_pass_count?: number;
  trial_total?: number;
  error?: string;
  /** At least one trial passed. Stamped once every trial is finished. */
  pass_at_k?: boolean;
  /** Every trial passed. */
  pass_all_k?: boolean;
  reward_mean?: number;
  reward_std?: number;
}

export interface FindingsReport {
  generated_at: string;
  /** category → severity → count */
  by_category: Record<string, Record<string, number>>;
  top: Array<JudgeFinding & { task_id: string; trial_index: number }>;
}

export interface EvalRun {
  id: string;
  agent_id: string;
  agent_version?: number;
  environment_id: string;
  status: EvalRunStatus;
  created_at?: string;
  started_at?: string;
  ended_at?: string;
  error?: string;
  task_count: number;
  completed_count: number;
  failed_count: number;
  tasks_pass_at_k?: number;
  tasks_pass_all_k?: number;
  /** Set when the run was started from a saved suite. */
  suite_id?: string;
  suite_name?: string;
  /** Set when the run is one side of a version comparison. */
  comparison_id?: string;
  comparison_role?: "baseline" | "candidate";
  findings_report?: FindingsReport;
  tasks: EvalTask[];
}

export interface EvalSuiteSummary {
  id: string;
  name: string;
  agent_id?: string;
  judge?: { model_id?: string; model_card_id?: string; reasoning_level?: string };
  task_count: number;
  created_at: string;
  updated_at: string;
}

export interface EvalSuite extends Omit<EvalSuiteSummary, "task_count"> {
  tasks: EvalTaskSpec[];
  source_sessions?: string[];
}

// ── Verdicts ────────────────────────────────────────────────────────────

export type Verdict = "passed" | "flaky" | "failed" | "error" | "ungraded" | "running" | "queued";

export const VERDICT: Record<Verdict, { label: string; tone: StatusTone; live?: boolean }> = {
  passed: { label: "Passed", tone: "success" },
  flaky: { label: "Flaky", tone: "warning" },
  failed: { label: "Failed", tone: "danger" },
  error: { label: "Error", tone: "danger" },
  ungraded: { label: "Not graded", tone: "neutral" },
  running: { label: "Running", tone: "info", live: true },
  queued: { label: "Queued", tone: "neutral" },
};

/** What each verdict means for a task, in one line (tooltips, legends). */
export const TASK_VERDICT_MEANING: Record<Verdict, string> = {
  passed: "Every trial passed",
  flaky: "Some trials passed",
  failed: "No trial passed",
  error: "Could not finish",
  ungraded: "The judge could not grade it",
  running: "Still running",
  queued: "Waiting to start",
};

/** The score a trial needs. The judge's "pass" is 1, which is the default mark. */
export function passMark(spec: Pick<EvalTaskSpec, "pass_threshold"> | undefined): number {
  const t = spec?.pass_threshold;
  return typeof t === "number" && Number.isFinite(t) ? t : 1;
}

function hasScore(trial: EvalTrial): boolean {
  return typeof trial.reward === "number" && Number.isFinite(trial.reward);
}

export function trialVerdict(trial: EvalTrial, mark: number): Verdict {
  if (trial.status === "pending") return "queued";
  if (trial.status === "running") return "running";
  if (trial.ungraded) return "ungraded";
  // A trial that stopped (timed out, crashed) counts as not passed, but the
  // useful thing to say is why it stopped, not a score it never earned.
  if (trial.status === "failed") return "error";
  if (!hasScore(trial)) return "ungraded";
  return (trial.reward as number) >= mark ? "passed" : "failed";
}

export interface TaskSummary {
  verdict: Verdict;
  mark: number;
  /** Trials that cleared the pass mark. */
  passed: number;
  /** Trials that count toward the result (everything but "not graded"). */
  graded: number;
  total: number;
  /** Trials that stopped with an error. */
  errored: number;
  finished: number;
  mean: number | null;
  spread: number | null;
  simulation: boolean;
  trials: Array<{ trial: EvalTrial; verdict: Verdict }>;
}

export function taskSummary(task: EvalTask): TaskSummary {
  const mark = passMark(task.spec);
  const trials = task.trials.map((trial) => ({ trial, verdict: trialVerdict(trial, mark) }));
  const count = (v: Verdict) => trials.filter((t) => t.verdict === v).length;
  const passed = count("passed");
  const errored = count("error");
  const active = count("running") + count("queued");
  const graded = passed + count("failed") + errored;
  const total = trials.length;

  let verdict: Verdict;
  if (total === 0) verdict = task.status === "failed" ? "error" : task.status === "running" ? "running" : "queued";
  else if (active > 0) verdict = count("running") > 0 || active < total ? "running" : "queued";
  else if (graded === 0) verdict = "ungraded";
  // Once the runner has stamped the task, its flags are the record: the
  // run-level counts are built from them.
  else if (task.pass_all_k === true) verdict = "passed";
  else if (task.pass_at_k === true) verdict = "flaky";
  else if (task.pass_at_k === false) verdict = "failed";
  else verdict = passed === graded ? "passed" : passed > 0 ? "flaky" : "failed";

  // Mean and spread: a stopped trial is a 0, not a gap (as the runner counts it).
  let mean = typeof task.reward_mean === "number" ? task.reward_mean : null;
  let spread = typeof task.reward_std === "number" ? task.reward_std : null;
  if (mean === null && graded > 0 && active === 0) {
    const scores = trials.filter((t) => t.verdict !== "ungraded").map((t) => (hasScore(t.trial) ? (t.trial.reward as number) : 0));
    mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    spread = Math.sqrt(scores.reduce((a, s) => a + (s - (mean as number)) ** 2, 0) / scores.length);
  }

  return { verdict, mark, passed, graded, total, errored, finished: total - active, mean, spread, simulation: !!task.spec.simulation, trials };
}

export type RunKind = "suite" | "simulation" | "comparison" | "oneoff";

export function runKind(run: Pick<EvalRun, "suite_id" | "suite_name" | "comparison_id" | "tasks">): RunKind {
  if (run.suite_name || run.suite_id) return "suite";
  if (run.comparison_id) return "comparison";
  const tasks = run.tasks ?? [];
  if (tasks.length > 0 && tasks.every((t) => !!t.spec?.simulation)) return "simulation";
  return "oneoff";
}

export const RUN_KIND_LABEL: Record<RunKind, string> = {
  suite: "Suite",
  simulation: "Simulation",
  comparison: "Version comparison",
  oneoff: "One-off run",
};

/**
 * What a run is called. A run has no name of its own, so it takes its
 * suite's; a run that came from no suite is named for what it is. Never
 * the id.
 */
export function runName(run: Pick<EvalRun, "suite_id" | "suite_name" | "comparison_id" | "tasks">): string {
  const kind = runKind(run);
  if (kind === "suite") return run.suite_name?.trim() || "Suite run";
  return RUN_KIND_LABEL[kind];
}

/** The page title: the run's name, with the agent when the name alone is generic. */
export function runTitle(run: EvalRun, agentName?: string | null): string {
  const kind = runKind(run);
  if (kind === "suite" || !agentName) return runName(run);
  if (kind === "simulation") return `Simulation with ${agentName}`;
  if (kind === "comparison") return `Version comparison of ${agentName}`;
  return `One-off run of ${agentName}`;
}

export interface RunSummary {
  verdict: Verdict;
  kind: RunKind;
  tasks: Array<{ task: EvalTask; summary: TaskSummary }>;
  /**
   * Tasks by verdict. `active` are the tasks with trials still to run:
   * they are NOT failed, and no count of "not passing" may include them.
   * `finished` is everything else.
   */
  taskCounts: { passed: number; flaky: number; failed: number; ungraded: number; active: number; finished: number; total: number };
  /**
   * Tasks with at least one passing trial (pass@k). One passing trial
   * settles it, so a task that is still running counts as soon as it has one.
   */
  passedOnce: number;
  /** Tasks whose trials all passed (pass^k). Only a finished task can be one. */
  passedAlways: number;
  /** Tasks that finished without passing every time: flaky, failed, error, not graded. */
  notPassing: number;
  /**
   * True when every trial that was planned has run. False while the run is
   * going and after a run that stopped early: totals are then "so far", and
   * nothing may say the trials "ran".
   */
  complete: boolean;
  trials: { passed: number; graded: number; total: number; errored: number; finished: number };
  /** Share of graded trials that passed, 0 to 1. Null until something is graded. */
  passRate: number | null;
  scoreMean: number | null;
  /** Trials per task when every task uses the same number, else null. */
  trialsPerTask: number | null;
  durationSeconds: number | null;
  active: boolean;
}

export function runSummary(run: EvalRun): RunSummary {
  const tasks = (run.tasks ?? []).map((task) => ({ task, summary: taskSummary(task) }));
  const n = (v: Verdict) => tasks.filter((t) => t.summary.verdict === v).length;
  const taskCounts = {
    passed: n("passed"),
    flaky: n("flaky"),
    failed: n("failed") + n("error"),
    ungraded: n("ungraded"),
    active: n("running") + n("queued"),
    finished: tasks.length - n("running") - n("queued"),
    total: tasks.length,
  };
  const sum = (pick: (s: TaskSummary) => number) => tasks.reduce((a, t) => a + pick(t.summary), 0);
  const trials = {
    passed: sum((s) => s.passed),
    graded: sum((s) => s.graded),
    total: sum((s) => s.total),
    errored: sum((s) => s.errored),
    finished: sum((s) => s.finished),
  };
  const active = run.status === "pending" || run.status === "running";

  let verdict: Verdict;
  if (run.status === "pending") verdict = "queued";
  else if (run.status === "running") verdict = "running";
  else if (trials.graded === 0) verdict = run.status === "failed" || run.error ? "error" : "ungraded";
  else if (taskCounts.failed > 0) verdict = "failed";
  else if (taskCounts.flaky > 0) verdict = "flaky";
  else verdict = "passed";

  const means = tasks.map((t) => t.summary.mean).filter((m): m is number => m !== null);
  const perTask = new Set(tasks.map((t) => t.summary.total));
  const start = toDate(run.started_at ?? run.created_at);
  const end = toDate(run.ended_at);

  return {
    verdict,
    kind: runKind(run),
    tasks,
    taskCounts,
    passedOnce:
      taskCounts.passed +
      taskCounts.flaky +
      tasks.filter((t) => (t.summary.verdict === "running" || t.summary.verdict === "queued") && t.summary.passed > 0).length,
    passedAlways: taskCounts.passed,
    notPassing: taskCounts.finished - taskCounts.passed,
    complete: !active && taskCounts.active === 0,
    trials,
    passRate: trials.graded > 0 ? trials.passed / trials.graded : null,
    scoreMean: means.length > 0 ? means.reduce((a, b) => a + b, 0) / means.length : null,
    trialsPerTask: perTask.size === 1 ? [...perTask][0] : null,
    // A queued run has not started, and a finished run with no end time has
    // no duration worth printing.
    durationSeconds:
      start && run.status !== "pending" && (end || active) ? Math.max(0, ((end ?? new Date()).getTime() - start.getTime()) / 1000) : null,
    active,
  };
}

// ── Words ───────────────────────────────────────────────────────────────

/** Trials are zero-based on the wire; people count from one. */
export const trialNumber = (index: number) => index + 1;

export const percent = (ratio: number) => `${Math.round(ratio * 100)}%`;

/** A judge score, 0 to 1: "1.00", "0.83". */
export function formatScore(n: number | null | undefined): string {
  return n == null || !Number.isFinite(n) ? "No score" : n.toFixed(2);
}

/** "needs 1.00" reads oddly for the default mark; say what it means. */
export function passMarkPhrase(mark: number): string {
  return mark >= 1 ? "needs a full score" : `needs ${formatScore(mark)} or more`;
}

/** "5 tasks × 3 trials", "2 scenarios × 3 trials", "4 tasks, 9 trials". */
export function runShape(summary: RunSummary): string {
  const noun = summary.kind === "simulation" ? "scenario" : "task";
  const t = summary.taskCounts.total;
  if (t === 0) return "No tasks";
  const tasks = `${t} ${t === 1 ? noun : `${noun}s`}`;
  if (summary.trialsPerTask === null) return `${tasks}, ${summary.trials.total} trials`;
  if (summary.trialsPerTask <= 1) return tasks;
  return `${tasks} × ${summary.trialsPerTask} trials`;
}

/** The run's result as one sentence, for the header. */
export function runSentence(summary: RunSummary): string {
  const { taskCounts: c, trials } = summary;
  const noun = (n: number) => (summary.kind === "simulation" ? (n === 1 ? "scenario" : "scenarios") : n === 1 ? "task" : "tasks");
  if (summary.verdict === "queued") return "Waiting for a runner to pick it up.";
  if (summary.verdict === "running") {
    return c.total === 0 ? "Starting up." : `${c.total - c.active} of ${c.total} ${noun(c.total)} finished so far.`;
  }
  if (summary.verdict === "error") {
    return c.total === 0 ? "The run stopped before any task started." : "The run stopped before a single trial was graded.";
  }
  if (summary.verdict === "ungraded") return "The judge could not grade any trial, so there is no result to read.";
  const lead = `${trials.passed} of ${trials.graded} trials passed.`;
  if (c.passed === c.total && c.ungraded === 0) {
    return `${lead} ${c.total === 1 ? `The ${noun(1)} passed` : `All ${c.total} ${noun(c.total)} passed`} every time.`;
  }
  const parts: string[] = [];
  if (c.passed > 0) parts.push(`${c.passed} passed every time`);
  if (c.flaky > 0) parts.push(`${c.flaky} ${c.flaky === 1 ? "was" : "were"} flaky`);
  if (c.failed > 0) parts.push(`${c.failed} never passed`);
  if (c.ungraded > 0) parts.push(`${c.ungraded} could not be graded`);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0];
  return `${lead} Of ${c.total} ${noun(c.total)}, ${list}.`;
}

/** What the agent was asked: the first message, or the simulated situation. */
export function taskPrompt(spec: EvalTaskSpec | undefined): string {
  if (!spec) return "";
  if (spec.simulation) return spec.simulation.scenario ?? "";
  return spec.messages?.[0] ?? "";
}

/** "identified_known_issue" → "Identified known issue", "gate:tests_pass" → "Gate: tests pass". */
export function humanizeId(id: string): string {
  const words = id
    .replace(/[_-]+/g, " ")
    .replace(/\s*:\s*/g, ": ")
    .replace(/\s+/g, " ")
    .trim();
  return words ? words[0].toUpperCase() + words.slice(1) : id;
}

// ── Findings ────────────────────────────────────────────────────────────

export const SEVERITY_ORDER = ["critical", "major", "minor", "info"] as const;
export type Severity = (typeof SEVERITY_ORDER)[number];

export const SEVERITY: Record<string, { label: string; tone: StatusTone }> = {
  critical: { label: "Critical", tone: "danger" },
  major: { label: "Major", tone: "warning" },
  minor: { label: "Minor", tone: "neutral" },
  info: { label: "Note", tone: "neutral" },
};

export const FINDING_CATEGORY: Record<string, string> = {
  task: "Task",
  safety: "Safety",
  security: "Security",
  tool_use: "Tool use",
  communication: "Communication",
};

export const categoryLabel = (c: string) => FINDING_CATEGORY[c] ?? humanizeId(c);
export const severityRank = (s: string) => {
  const i = (SEVERITY_ORDER as readonly string[]).indexOf(s);
  return i === -1 ? SEVERITY_ORDER.length : i;
};

/** Counts per severity across a findings report, worst first, zeros dropped. */
export function severityTotals(report: FindingsReport | undefined): Array<{ severity: string; count: number }> {
  const totals = new Map<string, number>();
  for (const sevs of Object.values(report?.by_category ?? {})) {
    for (const [sev, n] of Object.entries(sevs)) totals.set(sev, (totals.get(sev) ?? 0) + (n ?? 0));
  }
  return [...totals.entries()]
    .filter(([, n]) => n > 0)
    .sort((a, b) => severityRank(a[0]) - severityRank(b[0]))
    .map(([severity, count]) => ({ severity, count }));
}

// ── Judge settings (the two run dialogs share them) ─────────────────────

/** Radix Select items cannot carry an empty value. */
export const AUTO_JUDGE = "__auto__";

export const REASONING_LEVELS = [
  { value: "instant", label: "Instant" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "max", label: "Max" },
] as const;

/** Write the chosen judge onto every `llm_judge` reward in a reward tree. */
export function injectJudge(spec: unknown, judge: { model_card_id?: string; reasoning_level: string }): void {
  if (!spec || typeof spec !== "object") return;
  const s = spec as { type?: string; judge?: Record<string, unknown>; components?: Array<{ verifier?: unknown }> };
  if (s.type === "llm_judge") {
    s.judge = {
      ...(s.judge ?? {}),
      ...(judge.model_card_id ? { model_card_id: judge.model_card_id } : {}),
      reasoning_level: judge.reasoning_level,
    };
  } else if (s.type === "composite" && Array.isArray(s.components)) {
    for (const c of s.components) injectJudge(c?.verifier, judge);
  }
}
