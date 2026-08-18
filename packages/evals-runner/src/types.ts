// EvalRunRecord / EvalTaskSpec / EvalTrialResult — the wire shape returned
// by /v1/evals/runs. Stored opaquely inside EvalRunRow.results JSON.

import type { RewardSpec, JudgeFinding } from "@open-managed-agents/shared";
import type { EvalRunStatus } from "@open-managed-agents/evals-store";

/** The simulated user a persona LLM role-plays during a simulation task. */
export interface SimulationPersonaSpec {
  /** Display name, e.g. "Dana — frustrated enterprise admin". */
  name?: string;
  /** Who the persona is: role, background, situation. */
  identity: string;
  /** What they want out of the interaction. */
  goals: string[];
  /** Facts the persona knows but only reveals when asked (order id, error text…). */
  hidden_knowledge?: string;
  /** Tone/verbosity, e.g. "terse, impatient, non-technical". */
  communication_style?: string;
  /** Natural-language rule for when the persona considers the conversation
   *  over (goal met, agent clearly failed, waiting on something external). */
  termination: string;
  /** Deterministic mode for tests/smokes: bypasses the persona LLM entirely.
   *  Message i is sent on persona turn i; the conversation ends after the
   *  last one. */
  scripted_messages?: string[];
}

export interface SimulationSpec {
  /** Situation description — persona-side context, never shown to the agent. */
  scenario: string;
  persona: SimulationPersonaSpec;
  /** Optional fixed opener; when absent the persona LLM authors turn 1. */
  opening_message?: string;
  /** Max persona turns (default 10, hard cap 40). timeout_ms still applies. */
  max_turns?: number;
  /** Persona model resolution — same block shape as LlmJudgeRewardSpec.judge.
   *  Defaults: resolver-picked card, reasoning_level "low", cross_family true. */
  persona_model?: { model_card_id?: string; reasoning_level?: string; cross_family?: boolean };
  /** Chaos injection — deterministic seeded tool failures the runtime
   *  applies to this trial's session (stamped into session metadata.eval.
   *  chaos; see apps/agent/src/harness/chaos.ts). Tests retry discipline,
   *  fallback, and honesty under degraded tools. */
  chaos?: { rules: SimulationChaosRule[] };
  /** Memory-aware simulation. Attaches a memory store to the trial's
   *  session so the agent can read prior "memories" and write new ones.
   *  `fresh: true` provisions an isolated store per trial (named
   *  `sim-<run>-<task>-<trial>`); `store_id` reuses an existing one.
   *  `seed_files` plant memories from a fictional prior session BEFORE the
   *  conversation starts — this is how "you told me last week…" scenarios
   *  get their ground truth. */
  memory_store?: SimulationMemorySpec;
  /** Multi-episode simulation: sequential sessions sharing ONE memory
   *  store within a trial. Episode i runs after episode i-1 completes; the
   *  agent has no conversation history across episodes — only what it
   *  wrote to memory. Tests memory WRITES + retrieval. When set, the
   *  top-level scenario/persona are episode 1 and each entry here is a
   *  subsequent episode (its fields override the top-level ones). */
  episodes?: SimulationEpisode[];
}

export interface SimulationMemorySpec {
  store_id?: string;
  fresh?: boolean;
  access?: "read_only" | "read_write";
  /** Instructions rendered into the memory reminder for the agent. */
  instructions?: string;
  /** Files planted into the store before the conversation. Paths are
   *  store-relative (e.g. "preferences.md"). */
  seed_files?: Array<{ path: string; content: string }>;
}

export interface SimulationEpisode {
  /** Free-text shown to the PERSONA about what happened in between
   *  (e.g. "two weeks later"). Never shown to the agent. */
  gap_description?: string;
  scenario?: string;
  persona?: Partial<SimulationPersonaSpec>;
  opening_message?: string;
  max_turns?: number;
}

export interface SimulationChaosRule {
  tool: string;
  failure_rate: number;
  mode?: "error" | "timeout" | "empty";
  error_text?: string;
  seed?: number;
  max_failures?: number;
  timeout_ms?: number;
}

export interface EvalTaskSpec {
  id: string;
  setup_files?: { path: string; content: string }[];
  /** Bash run in the sandbox via /exec before the first message. */
  setup_script?: string;
  /** Scripted mode. Exactly one of messages | simulation must be set. */
  messages?: string[];
  /** Simulation mode — persona-driven multi-turn conversation. */
  simulation?: SimulationSpec;
  timeout_ms?: number;
  trials?: number;
  reward?: RewardSpec;
  /** A trial passes iff final_reward >= this (evals-design §6). Default 1.0. */
  pass_threshold?: number;
}

export type { EvalRunStatus };

export interface EvalTrialResult {
  trial_index: number;
  status: EvalRunStatus;
  session_id?: string;
  trajectory_id?: string;
  current_message_index?: number;
  error?: string;
  started_at?: string;
  ended_at?: string;
  finalize_retry_count?: number;
  reward?: number;
  /** True when the judge could not run (provider outage, no resolver) —
   *  the 0 reward says nothing about the agent, so metrics exclude it. */
  ungraded?: boolean;
  // Simulation trials only — all optional so old rows keep parsing.
  /** Persona messages sent so far (includes the opener). */
  persona_turns?: number;
  sim_ended_by?: "persona" | "max_turns";
  persona_model_id?: string;
  persona_usage?: { input_tokens: number; output_tokens: number; calls: number };
  /** Copied (clipped) from reward.metadata.verdict.findings at finalize so
   *  the run record is self-contained for the run-level findings report. */
  findings?: JudgeFinding[];
  /** Memory-aware simulations: the store attached to this trial. */
  memory_store_id?: string;
  /** Multi-episode simulations: 0-based index of the episode currently
   *  running (session_id/trajectory_id refer to the CURRENT episode);
   *  completed episodes are recorded in `episodes`. */
  episode_index?: number;
  episodes?: Array<{
    index: number;
    session_id: string;
    trajectory_id?: string;
    persona_turns?: number;
    sim_ended_by?: "persona" | "max_turns";
  }>;
}

export interface EvalTaskResult {
  id: string;
  spec: EvalTaskSpec;
  status: EvalRunStatus;
  trials: EvalTrialResult[];
  trial_pass_count?: number;
  trial_total?: number;
  error?: string;
  // §6 metrics — set once every trial is terminal; additive to status.
  /** ≥1 trial's reward cleared pass_threshold (capability view). */
  pass_at_k?: boolean;
  /** ALL trials cleared pass_threshold (reliability view). */
  pass_all_k?: boolean;
  reward_mean?: number;
  reward_std?: number;
}

export interface EvalRunRecord {
  id: string;
  tenant_id: string;
  agent_id: string;
  environment_id: string;
  status: EvalRunStatus;
  created_at: string;
  started_at?: string;
  ended_at?: string;
  task_count: number;
  completed_count: number;
  failed_count: number;
  /** §6 rollup: tasks with pass_at_k / pass_all_k true. */
  tasks_pass_at_k?: number;
  tasks_pass_all_k?: number;
  /** §8 provenance: set when the run was launched from a stored suite
   *  (POST /v1/evals/suites/:id/run). */
  suite_id?: string;
  suite_name?: string;
  /** Simulation rollup — computed in code at run completion, no LLM.
   *  Feeds the self-improvement loop: read → edit agent config → re-run. */
  findings_report?: FindingsReport;
  tasks: EvalTaskResult[];
  error?: string;
}

export interface FindingsReport {
  generated_at: string;
  /** category → severity → count */
  by_category: Record<string, Record<string, number>>;
  /** Severity-sorted, capped — each finding tagged with its provenance. */
  top: Array<JudgeFinding & { task_id: string; trial_index: number }>;
}

/**
 * Translate an EvalRunRow (storage shape) to the legacy EvalRunRecord
 * (route + advanceRun consumer shape). The mutable per-tick state lives
 * in the opaque `results` JSON column.
 */
export function rowToRecord(row: import("@open-managed-agents/evals-store").EvalRunRow): EvalRunRecord {
  const partial = (row.results ?? {}) as Partial<EvalRunRecord>;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    agent_id: row.agent_id,
    environment_id: row.environment_id,
    status: row.status as EvalRunStatus,
    created_at: row.started_at,
    started_at: row.started_at,
    ended_at: row.completed_at ?? undefined,
    error: row.error ?? undefined,
    task_count: partial.task_count ?? 0,
    completed_count: partial.completed_count ?? 0,
    failed_count: partial.failed_count ?? 0,
    tasks_pass_at_k: partial.tasks_pass_at_k,
    tasks_pass_all_k: partial.tasks_pass_all_k,
    suite_id: partial.suite_id,
    suite_name: partial.suite_name,
    findings_report: partial.findings_report,
    tasks: partial.tasks ?? [],
  };
}

export function extractResults(run: EvalRunRecord): unknown {
  return {
    task_count: run.task_count,
    completed_count: run.completed_count,
    failed_count: run.failed_count,
    tasks_pass_at_k: run.tasks_pass_at_k,
    tasks_pass_all_k: run.tasks_pass_all_k,
    suite_id: run.suite_id,
    suite_name: run.suite_name,
    findings_report: run.findings_report,
    tasks: run.tasks,
  };
}

export function kvKey(tenantId: string, ...parts: string[]): string {
  return `t:${tenantId}:${parts.join(":")}`;
}
