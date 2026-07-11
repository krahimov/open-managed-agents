// Mission supervisor decision logic — pure, no I/O, no node imports (unit
// tests run under the workerd pool). The supervisor pump gathers the state
// (mission row + active-session state + verdict history) and this function
// answers "what happens this tick":
//
//   wait    — active session still working (or mission not running); no-op
//   verify  — active session finished a turn; run the verifiers
//   spawn   — no active session and budget remains; start the next iteration
//   succeed — fresh verdict passed every verifier
//   exhaust — iteration or wall-clock budget spent
//   stuck   — last 3 verdicts are identical failures (same commands, same
//             pass/fail pattern) — repeating won't help, stop burning budget
//
// Call it twice per verify cycle: once without `freshVerdict` (→ verify),
// then again with the just-computed verdict to pick the terminal/continue
// branch. `spawn` after a fresh verdict means "clear the active session so
// the next tick starts iteration N+1".

export interface MissionBudget {
  max_iterations: number;
  wall_clock_minutes: number;
}

export interface MissionVerifier {
  kind: "command";
  command: string;
  timeout_ms?: number;
}

export interface MissionVerdictResult {
  command: string;
  pass: boolean;
  output_snippet: string;
}

export interface MissionVerdict {
  iteration: number;
  results: MissionVerdictResult[];
  all_pass: boolean;
  judge: "skipped";
  at: string;
}

export type MissionStatus =
  | "running"
  | "succeeded"
  | "stopped"
  | "budget_exhausted"
  | "stuck";

export type MissionAction =
  | "wait"
  | "verify"
  | "spawn"
  | "succeed"
  | "exhaust"
  | "stuck";

export interface MissionDecisionInput {
  status: MissionStatus;
  /** Iterations already spawned (the active session, when set, IS iteration N). */
  iteration: number;
  budget: MissionBudget;
  /** Mission created_at, epoch ms — wall-clock budget anchors here. */
  createdAt: number;
  now: number;
  /** null = no active session. "working" = turn in flight; "finished" =
   *  turn ended (idle/terminated) and the workspace is safe to verify. */
  activeSession: { state: "working" | "finished" } | null;
  /** All recorded verdicts, oldest first, INCLUDING freshVerdict when set. */
  verdictHistory: MissionVerdict[];
  /** The verdict computed this tick, if the verifiers just ran. */
  freshVerdict?: MissionVerdict;
}

/** Failure signature — commands + pass pattern, ignoring output snippets
 *  (timestamps/paths in output would defeat the identical-failure check). */
export function verdictSignature(v: MissionVerdict): string {
  return JSON.stringify(v.results.map((r) => [r.command, r.pass]));
}

function budgetSpent(input: MissionDecisionInput): boolean {
  if (input.iteration >= input.budget.max_iterations) return true;
  return input.now - input.createdAt >= input.budget.wall_clock_minutes * 60_000;
}

function stuckOnRepeatedFailure(history: MissionVerdict[]): boolean {
  if (history.length < 3) return false;
  const last3 = history.slice(-3);
  if (last3.some((v) => v.all_pass)) return false;
  const sig = verdictSignature(last3[0]);
  return last3.every((v) => verdictSignature(v) === sig);
}

export function decideMissionAction(input: MissionDecisionInput): MissionAction {
  // Stopped / already-terminal missions never spawn or verify.
  if (input.status !== "running") return "wait";

  if (input.freshVerdict) {
    if (input.freshVerdict.all_pass) return "succeed";
    if (budgetSpent(input)) return "exhaust";
    if (stuckOnRepeatedFailure(input.verdictHistory)) return "stuck";
    return "spawn";
  }

  if (input.activeSession) {
    return input.activeSession.state === "working" ? "wait" : "verify";
  }

  // No active session: spawning iteration N+1 must fit the budget. The
  // wall-clock check also covers a mission that idled past its window
  // between iterations.
  if (budgetSpent(input)) return "exhaust";
  return "spawn";
}

// ── Create-time validation (shared by the POST /v1/missions route) ──────

export const MAX_ITERATIONS_CEILING = 200;
export const WALL_CLOCK_MINUTES_CEILING = 1440;
// Verifiers run sequentially inside the supervisor's (protected, non-
// overlapping) sweep — one mission's verifier wall time starves every other
// mission, so both the count and the per-command timeout are capped.
export const MAX_VERIFIERS = 20;
export const VERIFIER_TIMEOUT_CEILING_MS = 10 * 60_000;

export function validateMissionInput(input: {
  goal?: unknown;
  verifiers?: unknown;
  budget?: unknown;
}): { goal: string; verifiers: MissionVerifier[]; budget: MissionBudget } {
  const goal = typeof input.goal === "string" ? input.goal.trim() : "";
  if (!goal) throw new Error("mission needs a non-empty goal");

  if (!Array.isArray(input.verifiers) || input.verifiers.length === 0) {
    throw new Error("mission needs at least one verifier");
  }
  if (input.verifiers.length > MAX_VERIFIERS) {
    throw new Error(`mission allows at most ${MAX_VERIFIERS} verifiers`);
  }
  const verifiers: MissionVerifier[] = input.verifiers.map((raw, i) => {
    const v = raw as { kind?: unknown; command?: unknown; timeout_ms?: unknown };
    if (v?.kind !== "command") {
      throw new Error(`verifier[${i}]: kind must be "command"`);
    }
    const command = typeof v.command === "string" ? v.command.trim() : "";
    if (!command) throw new Error(`verifier[${i}]: command must be a non-empty string`);
    const timeout =
      v.timeout_ms === undefined ? undefined : Number(v.timeout_ms);
    if (
      timeout !== undefined &&
      (!Number.isFinite(timeout) || timeout <= 0 || timeout > VERIFIER_TIMEOUT_CEILING_MS)
    ) {
      throw new Error(
        `verifier[${i}]: timeout_ms must be a positive number ≤ ${VERIFIER_TIMEOUT_CEILING_MS}`,
      );
    }
    return { kind: "command", command, ...(timeout !== undefined ? { timeout_ms: timeout } : {}) };
  });

  const b = (input.budget ?? {}) as { max_iterations?: unknown; wall_clock_minutes?: unknown };
  const maxIterations = Number(b.max_iterations);
  const wallClock = Number(b.wall_clock_minutes);
  if (
    !Number.isInteger(maxIterations) ||
    maxIterations < 1 ||
    maxIterations > MAX_ITERATIONS_CEILING
  ) {
    throw new Error(`budget.max_iterations must be an integer 1..${MAX_ITERATIONS_CEILING}`);
  }
  if (
    !Number.isFinite(wallClock) ||
    wallClock < 1 ||
    wallClock > WALL_CLOCK_MINUTES_CEILING
  ) {
    throw new Error(`budget.wall_clock_minutes must be 1..${WALL_CLOCK_MINUTES_CEILING}`);
  }
  return {
    goal,
    verifiers,
    budget: { max_iterations: maxIterations, wall_clock_minutes: wallClock },
  };
}
