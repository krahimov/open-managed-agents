// Composite Verifier — wraps N sub-Verifiers and aggregates their
// `score.value` by weighted average. Each sub-score becomes a key in
// the composite's `criteria`.
//
// Use case: a task that wants both "tests pass" (script) and "code is
// idiomatic" (reward_model judge) signals combined into a single
// reward scalar. The sub-Verifiers run in parallel — one slow LLM
// judge doesn't stall the script verifier.

import type { Trajectory } from "../../trajectory/types.js";
import type { Score } from "../../scorers/types.js";
import type { Verifier, VerifierContext, CompositeRewardSpec } from "../types.js";
import { verifierForSpec } from "../registry.js";

export class CompositeVerifier implements Verifier {
  readonly id = "composite.v1";

  constructor(
    private readonly spec: CompositeRewardSpec,
    private readonly ctx: VerifierContext,
  ) {}

  async check(traj: Trajectory): Promise<Score> {
    const components = this.spec.components;
    if (!components || components.length === 0) {
      return {
        pass: false,
        value: 0,
        reason: "composite verifier has no components",
        metadata: { criteria: {} },
      };
    }

    // Hard-gate short-circuit (evals-design §4.4): when any component is
    // named `gate:*`, run components sequentially in declared order and
    // stop the moment a gate scores 0 — no judge tokens are spent on a
    // trial that already failed a cheap deterministic check. Specs
    // without gates keep the parallel path below.
    if (components.some((c) => c.name.startsWith("gate:"))) {
      return this.checkSequentialWithGates(traj);
    }

    // Parallel execution — composite latency is max(child), not sum.
    const settled = await Promise.allSettled(
      components.map(async (c) => ({
        name: c.name,
        weight: c.weight,
        score: await verifierForSpec(c.verifier, this.ctx).check(traj),
      })),
    );

    const criteria: Record<string, number> = {};
    const reasons: string[] = [];
    const judgeMeta: Record<string, unknown> = {};
    let weightedSum = 0;
    let totalWeight = 0;
    let allPass = true;

    for (const s of settled) {
      if (s.status === "rejected") {
        allPass = false;
        reasons.push(`unknown_child_failed: ${String(s.reason).slice(0, 100)}`);
        continue;
      }
      const { name, weight, score } = s.value;
      criteria[name] = score.value;
      weightedSum += score.value * weight;
      totalWeight += weight;
      reasons.push(`${name}=${score.value.toFixed(3)} (${score.reason.slice(0, 80)})`);
      if (!score.pass) allPass = false;
      absorbJudgeMetadata(judgeMeta, score);
    }

    const value = totalWeight > 0 ? weightedSum / totalWeight : 0;
    return {
      pass: allPass,
      value,
      reason: `composite: ${reasons.join("; ")}`,
      metadata: { criteria, ...judgeMeta },
    };
  }

  private async checkSequentialWithGates(traj: Trajectory): Promise<Score> {
    const criteria: Record<string, number> = {};
    const reasons: string[] = [];
    const judgeMeta: Record<string, unknown> = {};
    let weightedSum = 0;
    let totalWeight = 0;
    let allPass = true;

    for (const c of this.spec.components) {
      let score: Score;
      try {
        score = await verifierForSpec(c.verifier, this.ctx).check(traj);
      } catch (err: unknown) {
        allPass = false;
        reasons.push(`${c.name}_failed: ${String(err).slice(0, 100)}`);
        if (c.name.startsWith("gate:")) {
          // A gate that can't even run is a failed gate.
          return {
            pass: false,
            value: 0,
            reason: `composite: gate "${c.name}" failed (verifier threw: ${String(err).slice(0, 100)}); remaining components skipped`,
            metadata: { criteria: { ...criteria, [c.name]: 0 }, gate_failed: c.name },
          };
        }
        continue;
      }
      criteria[c.name] = score.value;
      if (c.name.startsWith("gate:") && score.value === 0) {
        return {
          pass: false,
          value: 0,
          reason: `composite: gate "${c.name}" failed (${score.reason.slice(0, 120)}); remaining components skipped`,
          metadata: { criteria, gate_failed: c.name },
        };
      }
      weightedSum += score.value * c.weight;
      totalWeight += c.weight;
      reasons.push(`${c.name}=${score.value.toFixed(3)} (${score.reason.slice(0, 80)})`);
      if (!score.pass) allPass = false;
      absorbJudgeMetadata(judgeMeta, score);
    }

    const value = totalWeight > 0 ? weightedSum / totalWeight : 0;
    return {
      pass: allPass,
      value,
      reason: `composite: ${reasons.join("; ")}`,
      metadata: { criteria, ...judgeMeta },
    };
  }
}

/**
 * Surface an LLM-judge component's rich metadata on the composite score.
 * Without this a judge inside a composite loses its verdict card in the
 * console and its judge_error marker in the runner (found live: the only
 * evidence of a judge-side billing outage was buried in the sub-score).
 * First judge component wins — composing two LLM judges is not a
 * supported shape today.
 */
function absorbJudgeMetadata(target: Record<string, unknown>, score: Score): void {
  const md = score.metadata as Record<string, unknown> | undefined;
  if (!md) return;
  for (const key of [
    "verdict",
    "judge_model_id",
    "judge_reasoning_level",
    "usage",
  ] as const) {
    if (md[key] !== undefined && target[key] === undefined) target[key] = md[key];
  }
  if (md.judge_error === true) target.judge_error = true;
}
