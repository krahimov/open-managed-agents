import { describe, expect, it } from "vitest";

import { runSummary, type EvalRun, type EvalTask, type EvalTrial } from "./evals";

const trial = (trial_index: number, status: EvalTrial["status"], reward?: number): EvalTrial => ({ trial_index, status, reward });

const task = (id: string, status: EvalTask["status"], trials: EvalTrial[], flags: Partial<EvalTask> = {}): EvalTask => ({
  id,
  spec: { id, messages: ["hi"], trials: trials.length },
  status,
  trials,
  ...flags,
});

const run = (status: EvalRun["status"], tasks: EvalTask[]): EvalRun => ({
  id: "evrun_1",
  agent_id: "agent-1",
  environment_id: "env-1",
  status,
  task_count: tasks.length,
  completed_count: 0,
  failed_count: 0,
  started_at: "2026-11-11T10:00:00Z",
  tasks,
});

// Five tasks of three trials: two finished (one passed, one flaky), one part-way
// with a passing trial already, one part-way with a failing trial, one not started.
const IN_FLIGHT = run("running", [
  task("a", "completed", [trial(0, "completed", 1), trial(1, "completed", 1), trial(2, "completed", 1)], { pass_at_k: true, pass_all_k: true }),
  task("b", "completed", [trial(0, "completed", 1), trial(1, "completed", 0.5), trial(2, "completed", 1)], { pass_at_k: true, pass_all_k: false }),
  task("c", "running", [trial(0, "completed", 1), trial(1, "running"), trial(2, "pending")]),
  task("d", "running", [trial(0, "completed", 0), trial(1, "running"), trial(2, "pending")]),
  task("e", "pending", [trial(0, "pending"), trial(1, "pending"), trial(2, "pending")]),
]);

describe("a run in flight", () => {
  const s = runSummary(IN_FLIGHT);

  it("keeps unfinished tasks apart from the ones that did not pass", () => {
    expect(s.active).toBe(true);
    expect(s.complete).toBe(false);
    expect(s.taskCounts).toMatchObject({ total: 5, finished: 2, active: 3, passed: 1, flaky: 1, failed: 0 });
    // One finished task did not pass every time. The three still going are not among them.
    expect(s.notPassing).toBe(1);
  });

  it("counts a task as passed-at-least-once as soon as one trial has passed", () => {
    // a, b, and c (still running, with a pass already). Not d or e.
    expect(s.passedOnce).toBe(3);
    // Only a finished task can have passed every time.
    expect(s.passedAlways).toBe(1);
  });

  it("counts trials as graded and planned, not as run", () => {
    expect(s.trials).toMatchObject({ passed: 6, graded: 8, total: 15, finished: 8 });
    expect(s.passRate).toBeCloseTo(6 / 8);
  });
});

describe("a finished run", () => {
  it("is complete, and its counts read as before", () => {
    const s = runSummary(
      run("completed", [
        task("a", "completed", [trial(0, "completed", 1), trial(1, "completed", 1)], { pass_at_k: true, pass_all_k: true }),
        task("b", "completed", [trial(0, "completed", 0), trial(1, "completed", 1)], { pass_at_k: true, pass_all_k: false }),
        task("c", "completed", [trial(0, "completed", 0), trial(1, "completed", 0)], { pass_at_k: false, pass_all_k: false }),
      ]),
    );
    expect(s.complete).toBe(true);
    expect(s.taskCounts).toMatchObject({ total: 3, finished: 3, active: 0 });
    expect(s.passedOnce).toBe(2);
    expect(s.passedAlways).toBe(1);
    expect(s.notPassing).toBe(2);
  });

  it("is not complete when it stopped with trials that never ran", () => {
    const s = runSummary(
      run("failed", [
        task("a", "completed", [trial(0, "completed", 1), trial(1, "completed", 1)], { pass_at_k: true, pass_all_k: true }),
        task("b", "pending", [trial(0, "pending"), trial(1, "pending")]),
      ]),
    );
    expect(s.active).toBe(false);
    expect(s.complete).toBe(false);
    expect(s.taskCounts).toMatchObject({ finished: 1, active: 1 });
    expect(s.notPassing).toBe(0);
  });
});
