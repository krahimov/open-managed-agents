// Outcome state derived from the event log.
//
// CF keeps the active outcome (+ iteration counter + evaluation history)
// in SessionDO state. The Node runtime has no per-session state store, so
// it derives the same three facts from events that are already durable:
//
//   - the latest `user.define_outcome` defines the active outcome
//   - `span.outcome_evaluation_end` rows for that outcome_id are the
//     evaluation history; a terminal result closes the outcome
//   - the iteration to resume at = the last end span's iteration + 1
//
// Pure — both runtimes can use it.

import type { SessionEvent } from "@open-managed-agents/shared";

const TERMINAL = new Set(["satisfied", "max_iterations_reached", "failed", "interrupted"]);

export interface DerivedOutcome {
  outcome: {
    outcome_id: string;
    description: string;
    rubric?: unknown;
    verifier?: { type: string; [key: string]: unknown };
    max_iterations?: number;
  };
  /** 0-indexed iteration the supervisor should run next. */
  iteration: number;
  evaluations: Array<{
    outcome_id: string;
    result: string;
    iteration: number;
    explanation?: string;
    feedback?: string;
    usage?: unknown;
    processed_at?: string;
  }>;
}

/** Active (non-terminal) outcome, or null when none is pending. */
export function activeOutcomeFromEvents(events: SessionEvent[]): DerivedOutcome | null {
  let def: Record<string, unknown> | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "user.define_outcome") {
      def = events[i] as unknown as Record<string, unknown>;
      break;
    }
  }
  if (!def || typeof def.outcome_id !== "string") return null;
  const outcomeId = def.outcome_id;
  const evaluations: DerivedOutcome["evaluations"] = [];
  let next = 0;
  for (const e of events) {
    if (e.type !== "span.outcome_evaluation_end") continue;
    const end = e as unknown as DerivedOutcome["evaluations"][number];
    if (end.outcome_id !== outcomeId) continue;
    if (TERMINAL.has(end.result)) return null;
    evaluations.push(end);
    next = Math.max(next, (end.iteration ?? 0) + 1);
  }
  return {
    outcome: {
      outcome_id: outcomeId,
      description: String(def.description ?? ""),
      ...(def.rubric !== undefined ? { rubric: def.rubric } : {}),
      ...(def.verifier ? { verifier: def.verifier as { type: string } } : {}),
      ...(typeof def.max_iterations === "number" ? { max_iterations: def.max_iterations } : {}),
    },
    iteration: next,
    evaluations,
  };
}
