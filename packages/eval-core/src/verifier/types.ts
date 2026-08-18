// OMA Verifier framework — Phase 2 of the Trajectory v1 unification plan.
//
// Replaces the three parallel verification paths that grew up independently:
//   - eval-runner: ad-hoc /exec verify_script + exit_code
//   - outcome-evaluator: standalone LLM judge
//   - rl/verifier: turn-based heuristic checks
//
// Now: one Verifier interface, three consumers (eval / outcome / RL), one
// canonical RewardSpec wire format. Trajectory.reward.verifier_id records
// which Verifier produced a given reward, so a session can be re-graded
// with a different one without re-executing.
//
// Design rule (per docs/archive/handoff-verifier-framework.md):
//   Task + Agent execution + Verifier → Score
//     Outcome: score → needs_revision/satisfied (supervisor loop)
//     Eval:    score → pass/fail (quality report)
//     RL:      score → reward signal (training)

import type { Trajectory } from "../trajectory/types.js";
import type { Score } from "../scorers/types.js";
// Type-only import — erased at runtime, so no module cycle with the builtin.
import type { JudgeFn } from "./builtins/llm_judge.js";

/**
 * Runtime-resolved judge handle. `LanguageModel` isn't serializable, so
 * the consumer (evals-runner tick, outcome supervisor) resolves the
 * spec's `judge` block into a callable + identity pair and hands it in
 * through VerifierContext.resolveJudge. Identity fields are persisted
 * into Score.metadata so runs stay reproducible/comparable.
 */
export interface ResolvedJudge {
  judge: JudgeFn;
  judgeModelId: string;
  judgeReasoningLevel: string;
}

/** Sandbox + session handle the script Verifier needs to run a verify
 *  command. Ignored by Verifiers that don't touch the sandbox. */
export interface VerifierContext {
  /** Session whose sandbox the verifier should use. */
  sessionId: string;
  /**
   * Run a shell command in the session's sandbox via /exec. Returns the
   * exit code and combined stdout+stderr. Wall-clock timeout is the
   * caller's responsibility — implementations should pass through
   * `timeoutMs` when supplied.
   */
  runExec(cmd: string, opts?: { timeoutMs?: number }): Promise<{ exit_code: number; output: string }>;
  /**
   * Resolve an `llm_judge` spec into a runtime JudgeFn. Optional: keeps
   * eval-core a leaf package (no `ai` / provider SDK imports) — runtimes
   * that can build models wire this in; when absent (or when it returns
   * null) the spec-driven judge verifier scores 0 with an "unavailable"
   * reason instead of throwing.
   */
  resolveJudge?: (spec: LlmJudgeRewardSpec) => Promise<ResolvedJudge | null>;
}

/**
 * One verifier — produces a Score from a Trajectory.
 *
 * Two modes:
 *   - check(traj): deterministic inspection (script exit, file existence,
 *     tool-use pattern match, …). Always available.
 *   - judge(traj, rubric): LLM-based qualitative assessment. Optional;
 *     consumers must fall back to check() when undefined.
 */
export interface Verifier {
  /** Stable id used as `RewardResult.verifier_id` and for logging. */
  readonly id: string;
  /** Deterministic check — pure inspection of the trajectory. */
  check(traj: Trajectory): Promise<Score>;
  /**
   * Optional LLM-judge variant when the task ships a rubric. Verifiers
   * that don't have a judge mode should leave this undefined; consumers
   * fall back to `check`.
   */
  judge?(traj: Trajectory, rubric: string): Promise<Score>;
}

/**
 * Reward spec shapes that ship today. Verifier registry maps each to
 * a concrete implementation. Keeps the existing JSON wire format
 * (`type: "verifiable" | "script" | "reward_model" | "composite"`)
 * intact so old task JSONs keep working.
 *
 * `weights` is consumer-defined metadata — composite uses per-component
 * weight (see ScriptRewardSpec); leaf shapes carry it for forward-compat
 * with future aggregators (e.g. multi-criterion scorers).
 */
export type RewardSpec =
  | ScriptRewardSpec
  | RewardModelRewardSpec
  | CompositeRewardSpec
  | VerifiableRewardSpec
  | LlmJudgeRewardSpec;

export interface ScriptRewardSpec {
  type: "script";
  /** Bash script to run in the agent's sandbox. exit 0 = pass. */
  verify_script: string;
  /** Optional: per-component weights (currently informational). */
  weights?: Record<string, number>;
  /** Optional per-script wall-clock timeout in ms. Default at the runner. */
  timeout_ms?: number;
}

export interface RewardModelRewardSpec {
  type: "reward_model";
  /** External HTTP endpoint the trajectory + rubric are POSTed to. */
  endpoint: string;
  /** Optional rubric / prompt template the endpoint will use. */
  prompt_template?: string;
  weights?: Record<string, number>;
}

export interface CompositeRewardSpec {
  type: "composite";
  components: Array<{
    /** Sub-Verifier RewardSpec. */
    verifier: RewardSpec;
    /** Weight applied to this sub-Verifier's `score.value` during aggregation. */
    weight: number;
    /** Human-readable name used as the criteria key. */
    name: string;
  }>;
}

/**
 * Serializable LLM-judge spec (evals-design §4.1). The judge block is
 * resolution *input* — the consumer maps it to a concrete model via
 * VerifierContext.resolveJudge; the resolved identity is echoed back in
 * Score.metadata (judge_model_id / judge_reasoning_level).
 */
export interface LlmJudgeRewardSpec {
  type: "llm_judge";
  /** Markdown rubric, per-criterion (see evals-design §4.3 template). */
  rubric: string;
  /** Optional grading context prepended to the judge prompt as "## Context"
   *  (before "## Task"). Simulations put the scenario + persona goals +
   *  termination condition here so the judge grades against what the
   *  simulated user actually wanted. */
  context?: string;
  /** Ask the judge for structured findings alongside the verdict —
   *  diagnostic observations (category/severity/evidence/recommendation)
   *  for the agent's operator, independent of pass/fail. */
  findings?: boolean;
  judge?: {
    /** Tenant model card to judge with. Default: resolver picks. */
    model_card_id?: string;
    /** Reasoning level for the judge model. Default "max". */
    reasoning_level?: string;
    /** Prefer a judge from a different provider family than the agent
     *  under eval (reduces self-preference bias). Default true. */
    cross_family?: boolean;
  };
  /** Escape hatch for tasks where the conversation IS the artifact
   *  (e.g. tone evals). Default false: the judge never sees the agent's
   *  intermediate prose/self-narrative (anti-anchoring, §4.2). */
  include_transcript?: boolean;
  weights?: Record<string, number>;
}

export interface VerifiableRewardSpec {
  type: "verifiable";
  /**
   * Name of a registered Scorer (eval-core/src/scorers/scorers.ts —
   * `bashExit`, `fileWritten`, `idleNoError`, `regex`, …). Resolved by
   * the verifiable builtin's mapping table.
   */
  scorer: string;
  /** Constructor opts forwarded to the named scorer factory. */
  opts?: Record<string, unknown>;
  weights?: Record<string, number>;
}
