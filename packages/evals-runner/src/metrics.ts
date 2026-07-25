// pass@k / pass^k metrics (evals-design §6). A trial PASSES iff its
// final reward clears the task's pass_threshold (default 1.0 — judge
// `pass` maps to 1). Metrics are additive on top of the existing
// completed/failed status semantics, which stay untouched: a task can be
// status "failed" (a trial errored) while pass_at_k is still true.

import type { EvalRunRecord, EvalTaskResult, EvalTrialResult } from "./types";

export const DEFAULT_PASS_THRESHOLD = 1.0;

export function passThresholdOf(task: EvalTaskResult): number {
  const t = task.spec.pass_threshold;
  return typeof t === "number" && Number.isFinite(t) ? t : DEFAULT_PASS_THRESHOLD;
}

export function trialPassed(trial: EvalTrialResult, threshold: number): boolean {
  // Missing/non-finite reward (trial never produced a trajectory) ⇒ fail.
  return (
    typeof trial.reward === "number" &&
    Number.isFinite(trial.reward) &&
    trial.reward >= threshold
  );
}

/**
 * Populate pass_at_k / pass_all_k / reward_mean / reward_std on a task
 * whose trials have all reached a terminal state. Missing rewards count
 * as 0 in the mean/std (a crashed trial is a 0, not a gap — otherwise
 * flaky agents would look better than reliable ones).
 *
 * UNGRADED trials (judge infrastructure failed — provider outage, no
 * resolver) are excluded from every metric: their 0 says nothing about
 * the agent. A task where every trial is ungraded gets no metrics at
 * all (undefined), which the console renders as "—".
 */
export function computeTaskMetrics(task: EvalTaskResult): void {
  const threshold = passThresholdOf(task);
  const trials = task.trials.filter((t) => t.ungraded !== true);
  if (trials.length === 0) {
    task.pass_at_k = undefined;
    task.pass_all_k = undefined;
    task.reward_mean = undefined;
    task.reward_std = undefined;
    return;
  }
  const rewards = trials.map((t) =>
    typeof t.reward === "number" && Number.isFinite(t.reward) ? t.reward : 0,
  );

  task.pass_at_k = trials.some((t) => trialPassed(t, threshold));
  task.pass_all_k = trials.every((t) => trialPassed(t, threshold));

  const n = rewards.length;
  const mean = rewards.reduce((a, b) => a + b, 0) / n;
  task.reward_mean = mean;
  task.reward_std = Math.sqrt(rewards.reduce((a, r) => a + (r - mean) ** 2, 0) / n);
}

/** Run-level rollup: how many tasks cleared pass@k / pass^k. Tasks whose
 *  metrics haven't been computed yet (still running) simply don't count. */
export function computeRunRollup(run: EvalRunRecord): void {
  run.tasks_pass_at_k = run.tasks.filter((t) => t.pass_at_k === true).length;
  run.tasks_pass_all_k = run.tasks.filter((t) => t.pass_all_k === true).length;
}
