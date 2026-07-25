// pass@k / pass^k / reward mean±std (evals-design §6) over multi-trial
// tasks. Metrics are additive: status semantics are computed elsewhere
// and never consulted here — only rewards vs pass_threshold matter.

import { describe, it, expect } from "vitest";
import {
  computeTaskMetrics,
  computeRunRollup,
  passThresholdOf,
  trialPassed,
  DEFAULT_PASS_THRESHOLD,
  type EvalRunRecord,
  type EvalTaskResult,
  type EvalTrialResult,
} from "@open-managed-agents/evals-runner";

function trial(reward: number | undefined, status: "completed" | "failed" = "completed"): EvalTrialResult {
  return { trial_index: 0, status, reward };
}

function task(
  trials: EvalTrialResult[],
  spec: Partial<EvalTaskResult["spec"]> = {},
): EvalTaskResult {
  return {
    id: "t1",
    spec: { id: "t1", messages: ["go"], ...spec },
    status: "completed",
    trials,
  };
}

describe("computeTaskMetrics", () => {
  it("default threshold 1.0: only perfect rewards pass", () => {
    const t = task([trial(1), trial(0.9), trial(1)]);
    computeTaskMetrics(t);
    expect(t.pass_at_k).toBe(true);
    expect(t.pass_all_k).toBe(false);
    expect(t.reward_mean).toBeCloseTo((1 + 0.9 + 1) / 3, 10);
  });

  it("custom pass_threshold admits partial rewards", () => {
    const t = task([trial(0.8), trial(0.7), trial(0.75)], { pass_threshold: 0.7 });
    computeTaskMetrics(t);
    expect(t.pass_at_k).toBe(true);
    expect(t.pass_all_k).toBe(true); // 0.7 >= 0.7 — threshold is inclusive
  });

  it("no trial clears the threshold: both metrics false, mean/std still real", () => {
    const t = task([trial(0.2), trial(0.6)], { pass_threshold: 0.9 });
    computeTaskMetrics(t);
    expect(t.pass_at_k).toBe(false);
    expect(t.pass_all_k).toBe(false);
    expect(t.reward_mean).toBeCloseTo(0.4, 10);
    expect(t.reward_std).toBeCloseTo(0.2, 10); // population std of [0.2, 0.6]
  });

  it("missing reward (trial never produced a trajectory) counts as 0", () => {
    const t = task([trial(1), trial(undefined, "failed")], { pass_threshold: 0.5 });
    computeTaskMetrics(t);
    expect(t.pass_at_k).toBe(true);
    expect(t.pass_all_k).toBe(false);
    expect(t.reward_mean).toBeCloseTo(0.5, 10);
    expect(t.reward_std).toBeCloseTo(0.5, 10);
  });

  it("single-trial task: pass@1 === pass^1", () => {
    const t = task([trial(1)]);
    computeTaskMetrics(t);
    expect(t.pass_at_k).toBe(true);
    expect(t.pass_all_k).toBe(true);
    expect(t.reward_std).toBe(0);
  });

  it("identical rewards give zero std", () => {
    const t = task([trial(0.5), trial(0.5), trial(0.5)], { pass_threshold: 0.5 });
    computeTaskMetrics(t);
    expect(t.reward_mean).toBeCloseTo(0.5, 10);
    expect(t.reward_std).toBe(0);
    expect(t.pass_all_k).toBe(true);
  });

  it("non-finite pass_threshold falls back to the 1.0 default", () => {
    const t = task([trial(0.9)], { pass_threshold: Number.NaN });
    expect(passThresholdOf(t)).toBe(DEFAULT_PASS_THRESHOLD);
    computeTaskMetrics(t);
    expect(t.pass_at_k).toBe(false);
  });
});

describe("trialPassed", () => {
  it("rejects missing / NaN rewards regardless of threshold", () => {
    expect(trialPassed(trial(undefined), 0)).toBe(false);
    expect(trialPassed(trial(Number.NaN), 0)).toBe(false);
    expect(trialPassed(trial(0), 0)).toBe(true);
  });
});

describe("computeRunRollup", () => {
  it("counts tasks with computed metrics; unfinished tasks don't count", () => {
    const t1 = task([trial(1), trial(1)]);
    const t2 = task([trial(1), trial(0)]);
    const t3 = task([trial(0)]);
    for (const t of [t1, t2, t3]) computeTaskMetrics(t);
    const pending = task([{ trial_index: 0, status: "running" }]); // metrics not computed yet
    const run = {
      id: "r1",
      tenant_id: "ten",
      agent_id: "a",
      environment_id: "e",
      status: "running",
      created_at: "2026-07-24T10:00:00Z",
      task_count: 4,
      completed_count: 0,
      failed_count: 0,
      tasks: [t1, t2, t3, pending],
    } as EvalRunRecord;
    computeRunRollup(run);
    expect(run.tasks_pass_at_k).toBe(2); // t1, t2
    expect(run.tasks_pass_all_k).toBe(1); // t1 only
  });
});
