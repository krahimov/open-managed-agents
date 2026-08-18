// Eval runner — advances pending/running EvalRuns toward completion.
// Runtime-agnostic: the CF cron handler and the Node scheduler both
// invoke `tickEvalRuns(ctx)` once per cron tick.
//
// State machine per run:
//   pending → start_run() → running (creates first session for first task)
//   running → poll all running tasks; advance idle ones to next task; mark
//             run completed when all tasks done
//
// Each task = a fresh session against the run's agent_id + environment_id.
// On bootstrap we (1) create the session, (2) write any declared setup_files
// directly to /workspace via raw /exec (NOT through the agent), then (3)
// send the spec's first user message and wait for idle, repeating for each
// subsequent message.

import {
  buildTrajectory,
  extractTraceFacts,
  verifierForSpec,
  NoRunVerifier,
  logWarn,
  type StoredEvent,
  type Trajectory,
  type RewardResult,
  type RewardSpec,
  type VerifierContext,
  type LlmJudgeRewardSpec,
  type ResolvedJudge,
  type SessionRecord,
  type FullStatus,
} from "@open-managed-agents/shared";
import type { AgentService } from "@open-managed-agents/agents-store";
import type { EnvironmentService } from "@open-managed-agents/environments-store";
import type { SessionService } from "@open-managed-agents/sessions-store";
import type { EvalRunService } from "@open-managed-agents/evals-store";
import type { KvStore } from "@open-managed-agents/kv-store";
import { toEnvironmentConfig } from "@open-managed-agents/environments-store";
import {
  type EvalRunRecord,
  type EvalTaskResult,
  type EvalTrialResult,
  type SimulationSpec,
  rowToRecord,
  extractResults,
  kvKey,
} from "./types";
import { computeTaskMetrics, computeRunRollup } from "./metrics";
import {
  buildPersonaPrompt,
  parsePersonaTurn,
  salvageRawMessage,
  transcriptFromEvents,
  aggregateFindings,
  clipFinding,
  maxTurnsOf,
  effectiveSim,
  episodeCount,
  SIM_DEFAULT_TIMEOUT_MS,
  type PersonaTurn,
  type TranscriptEntry,
} from "./simulation";
import type { JudgeFinding } from "@open-managed-agents/shared";

/** Narrow services shape — just what the runner actually touches.
 *  Keeps the package decoupled from packages/services. CF satisfies
 *  this from buildCfServices(); Node from its own bundle. */
export interface EvalRunnerServices {
  agents: AgentService;
  environments: EnvironmentService;
  sessions: SessionService;
  evals: EvalRunService;
  kv: KvStore;
}

/**
 * Minimal Fetcher shape — both CF service bindings and Node test fakes
 * satisfy this. Defined here so the package doesn't depend on
 * @cloudflare/workers-types.
 */
export interface SandboxFetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

/**
 * Runtime-supplied context for the eval-runner. CF builds this from
 * `env` (binding lookups by name); Node builds it from its services
 * + a no-op sandbox resolver until cloud environments land on Node.
 */
export interface EvalRunnerContext {
  /** Cross-shard fan-out. CF passes `(fn) => forEachShardServices(env, fn)`;
   *  Node passes `(fn) => fn(services).then((r) => [r])`. */
  forEachShard: <T>(
    fn: (services: EvalRunnerServices) => Promise<T>,
  ) => Promise<T[]>;
  /** Per-tenant services accessor (cached per call). CF uses
   *  getCfServicesForTenant; Node returns its single Services instance. */
  getServicesForTenant: (tenantId: string) => Promise<EvalRunnerServices>;
  /** Resolve the sandbox Fetcher for a (tenant, environment). Returns
   *  null if the environment is unknown / not ready / not mapped to a
   *  binding on this runtime. */
  getSandboxBinding: (
    tenantId: string,
    environmentId: string,
  ) => Promise<SandboxFetcher | null>;
  /** Resolve an `llm_judge` RewardSpec into a runtime JudgeFn + identity
   *  for the given tenant/agent (agent id drives the cross-family
   *  default). Optional: runtimes without in-process model handles (CF
   *  cron today) leave it undefined and llm_judge trials score 0 with an
   *  "unavailable" reason. */
  resolveJudge?: (
    tenantId: string,
    agentId: string,
    spec: LlmJudgeRewardSpec,
  ) => Promise<ResolvedJudge | null>;
  /** Wall-clock budget for advancing multiple simulation persona turns
   *  inside one tick. Overrides SIM_TICK_BUDGET_MS. 0 = one turn per tick.
   *  Default 40s — must stay under the 60s cron period. */
  simTickBudgetMs?: number;
  /** Memory-store port for memory-aware simulations. Optional: runtimes
   *  without it fail simulation.memory_store trials fast with a clear
   *  error (same posture as the missing judge resolver). */
  memory?: EvalMemoryPort;
}

/** Narrow memory-store surface the runner needs. Node wires it from
 *  memoryService + the session_memory_stores table; kept as a port so
 *  evals-runner stays a leaf package. */
export interface EvalMemoryPort {
  /** Create an empty store; returns its id. */
  provisionStore(input: { tenantId: string; name: string; description?: string }): Promise<{ id: string }>;
  /** Attach a store to a session (upsert). Must happen BEFORE the first
   *  turn so the harness's memory reminder + mount see it. */
  attachToSession(input: {
    tenantId: string;
    sessionId: string;
    storeId: string;
    access: "read_only" | "read_write";
    instructions?: string;
  }): Promise<void>;
  /** Write a memory file (store-relative path) — used to plant seed_files. */
  writeFile(input: { tenantId: string; storeId: string; path: string; content: string }): Promise<void>;
  /** Read back the store's files for the judge's memory section. */
  listFiles(input: { tenantId: string; storeId: string }): Promise<Array<{ path: string; content: string }>>;
}

// ---------- Sandbox fetch helper ----------

function fwd(
  binding: SandboxFetcher,
  path: string,
  method: string = "GET",
  body?: BodyInit | null,
): Promise<Response> {
  return binding.fetch(new Request(`https://sandbox${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? body : undefined,
  }));
}

// ---------- Run / task lifecycle ----------

async function loadRun(
  ctx: EvalRunnerContext,
  tenantId: string,
  runId: string,
): Promise<EvalRunRecord | null> {
  const services = await ctx.getServicesForTenant(tenantId);
  const row = await services.evals.get({ tenantId, runId });
  if (!row) return null;
  return rowToRecord(row);
}

async function saveRun(ctx: EvalRunnerContext, run: EvalRunRecord): Promise<void> {
  const services = await ctx.getServicesForTenant(run.tenant_id);
  if (run.status === "completed" || run.status === "failed") {
    await services.evals.markCompleted({
      tenantId: run.tenant_id,
      runId: run.id,
      status: run.status,
      results: extractResults(run),
      error: run.error,
    });
  } else {
    await services.evals.update({
      tenantId: run.tenant_id,
      runId: run.id,
      status: run.status,
      results: extractResults(run),
      error: run.error ?? null,
    });
  }
}

/**
 * Resolve (provisioning if `fresh`) the memory store for a memory-aware
 * simulation trial and plant seed_files. Idempotent per trial: the store
 * id is persisted on the trial so later episodes / resumed ticks reuse it.
 */
async function ensureTrialMemoryStore(
  ctx: EvalRunnerContext,
  run: EvalRunRecord,
  task: EvalTaskResult,
  trial: EvalTrialResult,
): Promise<string | undefined> {
  const mem = task.spec.simulation?.memory_store;
  if (!mem) return undefined;
  if (trial.memory_store_id) return trial.memory_store_id;
  if (!ctx.memory) {
    throw new Error("simulation.memory_store requires a memory port on this runtime (Node)");
  }
  let storeId = mem.store_id;
  if (mem.fresh === true) {
    const created = await ctx.memory.provisionStore({
      tenantId: run.tenant_id,
      name: `sim-${run.id.replace(/^evrun-/, "")}-${task.id}-${trial.trial_index}`,
      description: `Simulation memory for eval ${run.id} / ${task.id} / trial ${trial.trial_index}`,
    });
    storeId = created.id;
  }
  if (!storeId) throw new Error("simulation.memory_store: no store_id resolved");
  // seed_files plant "prior-session memories". For a FRESH per-trial store
  // that is exactly right. For a SHARED store_id with trials>1 (or several
  // tasks pointing at it), concurrent trials would each re-plant into the
  // same store and cross-contaminate each other mid-conversation — so seed
  // only fresh stores; a shared store is assumed pre-seeded by the author.
  if (mem.fresh === true) {
    for (const f of mem.seed_files ?? []) {
      await ctx.memory.writeFile({ tenantId: run.tenant_id, storeId, path: f.path, content: f.content });
    }
  } else if ((mem.seed_files?.length ?? 0) > 0) {
    logWarn(
      { op: "sim.memory.seed_skipped", run_id: run.id, task_id: task.id, store_id: storeId },
      "seed_files ignored for a shared store_id (only fresh:true stores are seeded per trial)",
    );
  }
  trial.memory_store_id = storeId;
  return storeId;
}

async function createTaskSession(
  ctx: EvalRunnerContext,
  run: EvalRunRecord,
  task: EvalTaskResult,
  opts: { episodeIndex?: number; memoryStoreId?: string } = {},
): Promise<string> {
  const t = run.tenant_id;
  const services = await ctx.getServicesForTenant(t);
  const agentRow = await services.agents.get({ tenantId: t, agentId: run.agent_id });
  if (!agentRow) throw new Error(`agent ${run.agent_id} not found`);
  const { tenant_id: _atid, ...agentSnapshot } = agentRow;
  const envRow = await services.environments.get({ tenantId: t, environmentId: run.environment_id });
  const environmentSnapshot = envRow ? toEnvironmentConfig(envRow) : undefined;

  const binding = await ctx.getSandboxBinding(t, run.environment_id);
  if (!binding) throw new Error(`environment ${run.environment_id} not ready`);

  const episodeSuffix =
    opts.episodeIndex !== undefined && opts.episodeIndex > 0 ? ` :: ep${opts.episodeIndex + 1}` : "";
  const { session } = await services.sessions.create({
    tenantId: t,
    agentId: run.agent_id,
    environmentId: run.environment_id,
    title: `eval ${run.id} :: ${task.id}${episodeSuffix}`,
    agentSnapshot,
    environmentSnapshot,
  });
  const sessionId = session.id;

  // Memory-aware simulations: attach the trial's store BEFORE init so the
  // harness's memory reminder + /mnt/memory mount see it on turn 1.
  if (opts.memoryStoreId && task.spec.simulation?.memory_store) {
    if (!ctx.memory) throw new Error("simulation.memory_store requires a memory port on this runtime (Node)");
    await ctx.memory.attachToSession({
      tenantId: t,
      sessionId,
      storeId: opts.memoryStoreId,
      access: task.spec.simulation.memory_store.access ?? "read_write",
      instructions: task.spec.simulation.memory_store.instructions,
    });
  }

  // Tag the session metadata so Console picks eval sessions out of the
  // general session list (mirrors Linear / Slack metadata pattern).
  try {
    await services.sessions.update({
      tenantId: t,
      sessionId,
      metadata: {
        eval: {
          run_id: run.id,
          task_id: task.id,
          ...(task.spec.simulation ? { kind: "simulation" } : {}),
          ...(opts.episodeIndex !== undefined ? { episode: opts.episodeIndex } : {}),
          // Chaos rules ride the session so the runtime's tool builder can
          // wrap targeted tools with deterministic seeded failures.
          ...(task.spec.simulation?.chaos ? { chaos: task.spec.simulation.chaos } : {}),
        },
      },
    });
  } catch (err) {
    logWarn(
      { op: "eval.session.tag", session_id: sessionId, run_id: run.id, task_id: task.id, err },
      "eval session metadata tag failed; session usable but won't show eval badge in console",
    );
  }

  await fwd(binding, `/sessions/${sessionId}/init`, "PUT", JSON.stringify({
    agent_id: run.agent_id,
    environment_id: run.environment_id,
    title: `eval ${run.id} :: ${task.id}`,
    session_id: sessionId,
    tenant_id: t,
    vault_ids: [],
  }));

  return sessionId;
}

async function postUserMessage(
  ctx: EvalRunnerContext,
  run: EvalRunRecord,
  sessionId: string,
  text: string,
): Promise<void> {
  const binding = await ctx.getSandboxBinding(run.tenant_id, run.environment_id);
  if (!binding) throw new Error("environment binding lost");
  await fwd(binding, `/sessions/${sessionId}/event`, "POST", JSON.stringify({
    type: "user.message",
    content: [{ type: "text", text }],
  }));
}

async function writeSetupFiles(
  ctx: EvalRunnerContext,
  run: EvalRunRecord,
  sessionId: string,
  files: ReadonlyArray<{ path: string; content: string }>,
): Promise<void> {
  if (files.length === 0) return;
  const binding = await ctx.getSandboxBinding(run.tenant_id, run.environment_id);
  if (!binding) throw new Error("environment binding lost");

  for (const f of files) {
    if (!f.path.startsWith("/")) {
      throw new Error(`setup_files path must be absolute, got "${f.path}"`);
    }
    const sentinel = `OMA_SETUP_EOF_${Math.random().toString(16).slice(2, 14).toUpperCase()}`;
    if (f.content.includes(sentinel)) {
      throw new Error(`setup_files heredoc sentinel collision for ${f.path} (impossible — re-run)`);
    }
    const lastSlash = f.path.lastIndexOf("/");
    const dir = lastSlash > 0 ? f.path.slice(0, lastSlash) : "/";
    const command = [
      `mkdir -p ${shellQuote(dir)}`,
      `cat > ${shellQuote(f.path)} <<'${sentinel}'`,
      f.content,
      sentinel,
    ].join("\n");
    const res = await fwd(binding, `/sessions/${sessionId}/exec`, "POST", JSON.stringify({
      command,
      timeout_ms: 30_000,
    }));
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`setup_files write failed for ${f.path}: HTTP ${res.status} ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as { exit_code?: number; output?: string };
    if (data.exit_code !== 0) {
      throw new Error(`setup_files write exit=${data.exit_code} for ${f.path}: ${(data.output ?? "").slice(0, 200)}`);
    }
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

async function runSetupScript(
  ctx: EvalRunnerContext,
  run: EvalRunRecord,
  sessionId: string,
  script: string,
): Promise<void> {
  const binding = await ctx.getSandboxBinding(run.tenant_id, run.environment_id);
  if (!binding) throw new Error("environment binding lost");
  const res = await fwd(binding, `/sessions/${sessionId}/exec`, "POST", JSON.stringify({
    command: script,
    timeout_ms: 30 * 60 * 1000,
  }));
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`setup_script HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { exit_code?: number; output?: string };
  if (data.exit_code !== 0) {
    throw new Error(
      `setup_script exit=${data.exit_code}: ${(data.output ?? "").slice(0, 4000)}`,
    );
  }
}

/** Paginated walk of a session's stored events. Shared by trajectory
 *  building and the simulation persona loop (transcript reconstruction). */
async function fetchSessionEvents(
  ctx: EvalRunnerContext,
  run: EvalRunRecord,
  sessionId: string,
): Promise<StoredEvent[]> {
  const binding = await ctx.getSandboxBinding(run.tenant_id, run.environment_id);
  if (!binding) throw new Error("environment binding lost");
  const all: StoredEvent[] = [];
  let afterSeq = 0;
  while (true) {
    const res = await fwd(binding, `/sessions/${sessionId}/events?limit=1000&order=asc&after_seq=${afterSeq}`, "GET");
    if (!res.ok) break;
    const body = (await res.json()) as { data?: StoredEvent[]; has_more?: boolean };
    const batch = body.data || [];
    all.push(...batch);
    if (!body.has_more || batch.length === 0) break;
    afterSeq = batch[batch.length - 1].seq;
  }
  return all;
}

async function getSessionStatus(
  ctx: EvalRunnerContext,
  run: EvalRunRecord,
  sessionId: string,
): Promise<string | null> {
  const binding = await ctx.getSandboxBinding(run.tenant_id, run.environment_id);
  if (!binding) return null;
  try {
    const res = await fwd(binding, `/sessions/${sessionId}/status`, "GET");
    if (!res.ok) return null;
    const data = (await res.json()) as { status: string };
    return data.status;
  } catch (err) {
    logWarn(
      { op: "eval.fetch_session_status", session_id: sessionId, err },
      "session status fetch failed; treating as unknown",
    );
    return null;
  }
}

function buildVerifierContext(
  ctx: EvalRunnerContext,
  run: EvalRunRecord,
  sessionId: string,
): VerifierContext {
  return {
    sessionId,
    runExec: async (cmd, opts) => {
      const binding = await ctx.getSandboxBinding(run.tenant_id, run.environment_id);
      if (!binding) throw new Error("environment binding lost");
      const res = await fwd(binding, `/sessions/${sessionId}/exec`, "POST", JSON.stringify({
        command: cmd,
        timeout_ms: opts?.timeoutMs ?? 600_000,
      }));
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return { exit_code: -1, output: `HTTP ${res.status}: ${body.slice(0, 200)}` };
      }
      const data = (await res.json()) as { exit_code?: number; output?: string };
      return { exit_code: data.exit_code ?? -1, output: data.output ?? "" };
    },
    resolveJudge: ctx.resolveJudge
      ? (spec) => ctx.resolveJudge!(run.tenant_id, run.agent_id, spec)
      : undefined,
  };
}

async function runVerifier(
  ctx: EvalRunnerContext,
  run: EvalRunRecord,
  task: EvalTaskResult,
  trial: EvalTrialResult,
  sessionId: string,
  trajectory: Trajectory,
): Promise<RewardResult> {
  const computedAt = new Date().toISOString();
  const reward = task.spec.reward;

  if (!reward) {
    return {
      raw_rewards: { outcome: 1 },
      final_reward: 1,
      verifier_id: "eval-runner.trial-status.v1",
      computed_at: computedAt,
    };
  }

  const vctx = buildVerifierContext(ctx, run, sessionId);
  // Simulations: the conversation IS the artifact. Unless the author
  // explicitly opted out, the judge must see the full transcript — a
  // multi-turn rubric graded on the final reply alone false-negatives
  // (seen live: "Bob was omitted" when Bob was greeted in turn 1).
  const effectiveReward = task.spec.simulation
    ? withSimulationTranscriptDefault(reward)
    : reward;
  let verifier;
  try {
    verifier = verifierForSpec(effectiveReward, vctx);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logWarn(
      { op: "eval.verifier.spec_invalid", run_id: run.id, task_id: task.spec.id, err: msg },
      "verifier spec rejected; recording 0 reward",
    );
    return {
      raw_rewards: { spec_invalid: 0 },
      final_reward: 0,
      verifier_id: "verifier-spec-invalid.v1",
      computed_at: computedAt,
    };
  }

  let score;
  try {
    score = await verifier.check(trajectory);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logWarn(
      { op: "eval.verifier.check_threw", run_id: run.id, task_id: task.spec.id, verifier_id: verifier.id, err: msg },
      "verifier check threw; recording 0 reward",
    );
    return {
      raw_rewards: { verifier_error: 0 },
      final_reward: 0,
      verifier_id: verifier.id,
      computed_at: computedAt,
    };
  }

  const criteria = (score.metadata as { criteria?: Record<string, number> } | undefined)?.criteria;
  const rawRewards = criteria && Object.keys(criteria).length > 0
    ? criteria
    : { value: score.value };
  const persisted: Record<string, number> = {};
  for (const [k, v] of Object.entries(rawRewards)) {
    if (typeof v === "number" && Number.isFinite(v)) persisted[k] = v;
  }

  // Carry the verifier's metadata AND reason into storage — llm_judge puts
  // the structured verdict + judge identity + usage in metadata (console
  // Phase 4 renders the verdict card straight off the stored trajectory),
  // while degrade paths ("llm_judge unavailable on this runtime", composite
  // child failures) explain their 0 only via Score.reason. RewardResult has
  // no reason field, so fold it into metadata or operators can't tell a
  // judge that never ran from an agent that failed every criterion.
  const metadata: Record<string, unknown> = {
    ...(score.metadata ?? {}),
    ...(score.reason ? { reason: score.reason } : {}),
  };
  return {
    raw_rewards: persisted,
    final_reward: score.value,
    verifier_id: verifier.id,
    computed_at: computedAt,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

/** For simulation tasks, default `include_transcript: true` on every
 *  llm_judge spec (top-level or nested in a composite) that doesn't set it
 *  explicitly. Pure; never mutates the stored spec. */
function withSimulationTranscriptDefault(spec: RewardSpec): RewardSpec {
  if (spec.type === "llm_judge") {
    return spec.include_transcript === undefined ? { ...spec, include_transcript: true } : spec;
  }
  if (spec.type === "composite") {
    return {
      ...spec,
      components: spec.components.map((c) => ({ ...c, verifier: withSimulationTranscriptDefault(c.verifier) })),
    };
  }
  return spec;
}

async function synthesizeNoRunReward(reasonHint: string): Promise<RewardResult> {
  const verifier = new NoRunVerifier(reasonHint);
  const score = await verifier.check({} as Trajectory);
  return {
    raw_rewards: { failure: 0 },
    final_reward: score.value,
    verifier_id: verifier.id,
    computed_at: new Date().toISOString(),
  };
}

/**
 * Trajectory v1 envelope enrichment — task_id / group_id / outcome /
 * reward / trace_facts all wired BEFORE storage so the persisted
 * trajectory is self-describing. Phase 3+4 (judge prompt, Console UI)
 * read these directly. Exported for tests.
 */
export function finalizeTrajectoryForStorage(
  trajectory: Trajectory,
  opts: {
    taskId: string;
    groupId: string;
    reward: RewardResult;
    outcomeOverride?: Trajectory["outcome"];
    trialError?: string;
  },
): Trajectory {
  trajectory.task_id = opts.taskId;
  trajectory.group_id = opts.groupId;
  if (opts.outcomeOverride) {
    trajectory.outcome = opts.outcomeOverride;
  } else if (opts.trialError && /timeout/i.test(opts.trialError)) {
    trajectory.outcome = "timeout";
  }
  trajectory.reward = opts.reward;
  trajectory.trace_facts = extractTraceFacts(trajectory);
  return trajectory;
}

async function buildAndStoreTrajectory(
  ctx: EvalRunnerContext,
  run: EvalRunRecord,
  task: EvalTaskResult,
  trial: EvalTrialResult,
  sessionId: string,
  reward: RewardResult,
  outcomeOverride?: Trajectory["outcome"],
): Promise<{ trajectory_id: string; final_reward: number }> {
  const t = run.tenant_id;
  const services = await ctx.getServicesForTenant(t);
  const sessionRow = await services.sessions.get({ tenantId: t, sessionId });
  if (!sessionRow) throw new Error(`session ${sessionId} not found`);
  const session = {
    id: sessionRow.id,
    agent_id: sessionRow.agent_id,
    environment_id: sessionRow.environment_id,
    title: sessionRow.title,
    status: sessionRow.status,
    created_at: sessionRow.created_at,
    updated_at: sessionRow.updated_at ?? undefined,
    archived_at: sessionRow.archived_at ?? undefined,
    vault_ids: sessionRow.vault_ids ?? undefined,
    metadata: sessionRow.metadata ?? undefined,
    agent_snapshot: sessionRow.agent_snapshot ?? undefined,
    environment_snapshot: sessionRow.environment_snapshot ?? undefined,
  } as SessionRecord;
  const binding = await ctx.getSandboxBinding(t, run.environment_id);
  if (!binding) throw new Error("environment binding lost");

  const trajectory = await buildTrajectory(session, {
    fetchAllEvents: () => fetchSessionEvents(ctx, run, sessionId),
    fetchFullStatus: async (): Promise<FullStatus | null> => {
      const res = await fwd(binding, `/sessions/${sessionId}/full-status`, "GET");
      if (!res.ok) return null;
      return (await res.json()) as FullStatus;
    },
  });

  finalizeTrajectoryForStorage(trajectory, {
    taskId: task.spec.id,
    groupId: run.id,
    reward,
    outcomeOverride,
    trialError: trial.error,
  });

  // Trajectory storage goes through services.kv (CF: CONFIG_KV; Node:
  // SqlKvStore). Same key shape both runtimes.
  await services.kv.put(kvKey(t, "trajectory", trajectory.trajectory_id), JSON.stringify(trajectory));
  return { trajectory_id: trajectory.trajectory_id, final_reward: reward.final_reward };
}

async function persistFailureTrajectory(
  ctx: EvalRunnerContext,
  run: EvalRunRecord,
  task: EvalTaskResult,
  trial: EvalTrialResult,
  sessionId: string,
  outcome: Trajectory["outcome"],
  reasonHint: string,
): Promise<void> {
  try {
    const reward = await synthesizeNoRunReward(reasonHint);
    const result = await buildAndStoreTrajectory(ctx, run, task, trial, sessionId, reward, outcome);
    trial.trajectory_id = result.trajectory_id;
    trial.reward = result.final_reward;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logWarn(
      { op: "eval.failure_trajectory.skip", run_id: run.id, task_id: task.spec.id, session_id: sessionId, err: msg },
      "could not build failure-trial trajectory; trial.failed without trajectory_id",
    );
  }
}

// ---------- Simulation persona loop ----------

/** Wall-clock budget for advancing multiple persona turns inside ONE cron
 *  tick. Must stay under the 60s cron period so overlapping ticks can't
 *  double-drive a run. Set to 0 for the maximally cautious one-turn-per-
 *  tick posture. */
function simTickBudgetMs(ctx: EvalRunnerContext): number {
  if (ctx.simTickBudgetMs !== undefined && ctx.simTickBudgetMs >= 0) {
    return ctx.simTickBudgetMs;
  }
  const raw = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env?.SIM_TICK_BUDGET_MS;
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 40_000;
}

const SIM_IDLE_POLL_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Persona model resolution rides the judge resolver — a persona call is
 *  exactly a JudgeFn. Default: resolver-picked card, "low" reasoning,
 *  cross-family (mirrors the judge's anti-self-preference default). */
function personaJudgeSpec(sim: SimulationSpec): LlmJudgeRewardSpec {
  return {
    type: "llm_judge",
    rubric: "",
    judge: {
      model_card_id: sim.persona_model?.model_card_id,
      reasoning_level: sim.persona_model?.reasoning_level ?? "low",
      cross_family: sim.persona_model?.cross_family !== false,
    },
  };
}

async function nextPersonaTurn(
  ctx: EvalRunnerContext,
  run: EvalRunRecord,
  trial: EvalTrialResult,
  sim: SimulationSpec,
  transcript: TranscriptEntry[],
): Promise<PersonaTurn> {
  const scripted = sim.persona.scripted_messages;
  if (scripted && scripted.length > 0) {
    const idx = transcript.filter((t) => t.role === "persona").length;
    return idx < scripted.length
      ? { action: "message", text: scripted[idx] }
      : { action: "end", reason: "scripted messages exhausted" };
  }

  if (!ctx.resolveJudge) {
    throw new Error("simulation requires an LLM resolver on this runtime (Node)");
  }
  const resolved = await ctx.resolveJudge(run.tenant_id, run.agent_id, personaJudgeSpec(sim));
  if (!resolved) {
    throw new Error("persona model resolution failed (no usable model card)");
  }
  trial.persona_model_id = resolved.judgeModelId;

  const prompt = buildPersonaPrompt(sim, transcript);
  let lastText = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await resolved.judge(prompt);
    if (res.usage) {
      const u = trial.persona_usage ?? { input_tokens: 0, output_tokens: 0, calls: 0 };
      u.input_tokens += res.usage.input_tokens;
      u.output_tokens += res.usage.output_tokens;
      u.calls += 1;
      trial.persona_usage = u;
    }
    lastText = res.text || "";
    const turn = parsePersonaTurn(lastText);
    if (turn) return turn;
  }
  const salvaged = salvageRawMessage(lastText);
  if (salvaged) return { action: "message", text: salvaged };
  throw new Error(`persona_parse_failure: ${lastText.slice(0, 120)}`);
}

/**
 * Advance a simulation conversation as far as the intra-tick budget
 * allows. Returns true when the conversation is OVER (persona ended it or
 * max_turns reached) — the caller falls through to finalize — and false
 * when the trial should resume on a later tick.
 *
 * Persona turn count is derived from the event log each iteration (not the
 * persisted counter), so a crash between a posted message and a saved run
 * row resumes correctly.
 */
async function driveSimulation(
  ctx: EvalRunnerContext,
  run: EvalRunRecord,
  task: EvalTaskResult,
  trial: EvalTrialResult,
  sim: SimulationSpec,
): Promise<boolean> {
  const sessionId = trial.session_id!;
  const deadline = Date.now() + simTickBudgetMs(ctx);
  const maxTurns = maxTurnsOf(sim);

  while (true) {
    const events = await fetchSessionEvents(ctx, run, sessionId);
    const transcript = transcriptFromEvents(events);
    const personaTurns = transcript.filter((t) => t.role === "persona").length;
    trial.persona_turns = personaTurns;

    // The session polled idle, but the agent hasn't replied to the last
    // persona message yet (work-queue pickup race, or an errored turn).
    // Never let the persona talk to itself, and never FINALIZE on a
    // dangling persona message (the judge would see the last turn as
    // missing an agent reply) — wait; the trial timeout is the backstop
    // for a turn that never completes.
    const awaitingAgent =
      transcript.length > 0 && transcript[transcript.length - 1].role === "persona";

    if (personaTurns >= maxTurns && !awaitingAgent) {
      trial.sim_ended_by = "max_turns";
      return true;
    }

    if (!awaitingAgent) {
      const turn = await nextPersonaTurn(ctx, run, trial, sim, transcript);
      if (turn.action === "end") {
        trial.sim_ended_by = "persona";
        return true;
      }
      await postUserMessage(ctx, run, sessionId, turn.text!);
      trial.persona_turns = personaTurns + 1;
      // Persist after every posted turn — the loop may be interrupted at
      // any point and the next tick resumes from the event log.
      await saveRun(ctx, run);
    }

    if (Date.now() >= deadline) return false;
    await sleep(SIM_IDLE_POLL_MS);
    while (Date.now() < deadline) {
      const status = await getSessionStatus(ctx, run, sessionId);
      if (status === "idle") break;
      await sleep(SIM_IDLE_POLL_MS);
    }
    if (Date.now() >= deadline) return false;
  }
}

/**
 * Start episode `index` of a trial: create the session (memory attached,
 * chaos stamped), run setup, post the opener. Sets trial.session_id /
 * episode_index / persona_turns for the new episode. Used by the pending
 * branch (index 0) and by the episode roll-over. Returns the session id.
 */
async function startEpisode(
  ctx: EvalRunnerContext,
  run: EvalRunRecord,
  task: EvalTaskResult,
  trial: EvalTrialResult,
  index: number,
  opts: { finishedEpisode?: NonNullable<EvalTrialResult["episodes"]>[number] } = {},
): Promise<string> {
  // CRASH CONSISTENCY: trials advance concurrently and any sibling's
  // saveRun() may snapshot this trial mid-await. So we do every awaited
  // step against LOCAL state and commit the visible fields to `trial` in
  // ONE synchronous block at the end. A snapshot taken before that block
  // still shows the previous consistent state (pending, or the prior
  // episode with its session_id), and the resume path re-derives progress
  // from the event log — so a crash anywhere in here is safe.
  const memoryStoreId = await ensureTrialMemoryStore(ctx, run, task, trial);
  const sessionId = await createTaskSession(ctx, run, task, { episodeIndex: index, memoryStoreId });
  // Setup files/script run for EVERY episode — each is a fresh sandbox.
  if (task.spec.setup_files && task.spec.setup_files.length > 0) {
    await writeSetupFiles(ctx, run, sessionId, task.spec.setup_files);
  }
  if (task.spec.setup_script && task.spec.setup_script.trim().length > 0) {
    await runSetupScript(ctx, run, sessionId, task.spec.setup_script);
  }
  const sim = task.spec.simulation;
  let opener: string;
  if (sim) {
    const epSim = effectiveSim(sim, index);
    const turn = epSim.opening_message?.trim()
      ? { action: "message" as const, text: epSim.opening_message }
      : await nextPersonaTurn(ctx, run, trial, epSim, []);
    if (turn.action !== "message" || !turn.text) {
      throw new Error("persona ended the conversation before the opening message");
    }
    opener = turn.text;
  } else {
    opener = task.spec.messages![0];
  }
  await postUserMessage(ctx, run, sessionId, opener);

  // ---- atomic commit (no awaits below this line) ----
  if (opts.finishedEpisode) {
    trial.episodes = [...(trial.episodes ?? []), opts.finishedEpisode];
  }
  trial.session_id = sessionId;
  trial.episode_index = index;
  trial.current_message_index = 0;
  trial.persona_turns = sim ? 1 : undefined;
  trial.sim_ended_by = undefined;
  trial.status = "running";
  if (!trial.started_at) trial.started_at = new Date().toISOString();
  return sessionId;
}

// ---------- Single-tick advance (per-trial) ----------

async function advanceTrial(
  ctx: EvalRunnerContext,
  run: EvalRunRecord,
  task: EvalTaskResult,
  trial: EvalTrialResult,
): Promise<boolean> {
  if (trial.status === "completed" || trial.status === "failed") return false;

  if (trial.status === "pending") {
    let sessionId: string | undefined;
    try {
      // status/started_at/session_id are committed atomically inside
      // startEpisode — a mid-flight snapshot still reads "pending".
      sessionId = await startEpisode(ctx, run, task, trial, 0);
      return true;
    } catch (err: unknown) {
      trial.status = "failed";
      trial.error = err instanceof Error ? err.message : String(err);
      trial.ended_at = new Date().toISOString();
      if (sessionId ?? trial.session_id) {
        await persistFailureTrajectory(ctx, run, task, trial, (sessionId ?? trial.session_id)!, "failure", trial.error);
      }
      return true;
    }
  }

  if (!trial.session_id) {
    trial.status = "failed";
    trial.error = "running trial missing session_id";
    return true;
  }

  const timeoutMs =
    task.spec.timeout_ms ?? (task.spec.simulation ? SIM_DEFAULT_TIMEOUT_MS : 3_600_000);
  if (trial.started_at) {
    const elapsed = Date.now() - Date.parse(trial.started_at);
    if (elapsed > timeoutMs) {
      trial.status = "failed";
      trial.error = `trial timeout: ${Math.round(elapsed / 1000)}s exceeded budget ${Math.round(timeoutMs / 1000)}s (m_idx=${trial.current_message_index ?? 0})`;
      trial.ended_at = new Date().toISOString();
      await persistFailureTrajectory(ctx, run, task, trial, trial.session_id, "timeout", trial.error);
      return true;
    }
  }

  const status = await getSessionStatus(ctx, run, trial.session_id);
  if (status !== "idle") return false;

  if (task.spec.simulation) {
    try {
      const epSim = effectiveSim(task.spec.simulation, trial.episode_index ?? 0);
      const conversationOver = await driveSimulation(ctx, run, task, trial, epSim);
      if (!conversationOver) return true; // progressed; resume next tick
      // conversation over → either roll to the next episode or finalize.
      const total = episodeCount(task.spec.simulation);
      const current = trial.episode_index ?? 0;
      if (current + 1 < total) {
        // Roll to the next episode. The finished episode is recorded and
        // session_id switched in ONE synchronous commit inside startEpisode
        // (its trajectory is built at the very end alongside the last one so
        // a single judge call sees all episodes; the session stays intact).
        // If startEpisode throws, `trial` still points at the finished
        // episode's session, so persistFailureTrajectory targets a real,
        // complete conversation rather than a half-created one.
        await startEpisode(ctx, run, task, trial, current + 1, {
          finishedEpisode: {
            index: current,
            session_id: trial.session_id!,
            persona_turns: trial.persona_turns,
            sim_ended_by: trial.sim_ended_by,
          },
        });
        return true;
      }
    } catch (err: unknown) {
      trial.status = "failed";
      trial.error = err instanceof Error ? err.message : String(err);
      trial.ended_at = new Date().toISOString();
      await persistFailureTrajectory(ctx, run, task, trial, trial.session_id, "failure", trial.error);
      return true;
    }
  } else {
    const nextIndex = (trial.current_message_index ?? 0) + 1;
    if (nextIndex < task.spec.messages!.length) {
      try {
        await postUserMessage(ctx, run, trial.session_id, task.spec.messages![nextIndex]);
        trial.current_message_index = nextIndex;
        return true;
      } catch (err: unknown) {
        trial.status = "failed";
        trial.error = err instanceof Error ? err.message : String(err);
        trial.ended_at = new Date().toISOString();
        await persistFailureTrajectory(ctx, run, task, trial, trial.session_id, "failure", trial.error);
        return true;
      }
    }
  }

  // All messages sent and session idle → build trajectory + run verifier.
  try {
    const t = run.tenant_id;
    const services = await ctx.getServicesForTenant(t);
    const placeholder = await synthesizeNoRunReward("pre-verify placeholder");

    // Multi-episode: persist each earlier episode's trajectory now (they
    // were left unbuilt so a crash mid-trial can't orphan half a set) and
    // collect their transcripts for the judge.
    const priorEpisodes: Array<{ index: number; transcript: string; trajectory_id: string }> = [];
    for (const ep of trial.episodes ?? []) {
      if (!ep.trajectory_id) {
        const epBuilt = await buildAndStoreTrajectory(ctx, run, task, trial, ep.session_id, placeholder);
        ep.trajectory_id = epBuilt.trajectory_id;
      }
      const raw = await services.kv.get(kvKey(t, "trajectory", ep.trajectory_id));
      if (raw) {
        const epTraj = JSON.parse(raw) as Trajectory;
        priorEpisodes.push({
          index: ep.index,
          trajectory_id: ep.trajectory_id,
          transcript: transcriptFromEvents(epTraj.events ?? [])
            .map((e) => `${e.role === "persona" ? "User" : "Agent"}: ${e.text}`)
            .join("\n"),
        });
      }
    }

    const built = await buildAndStoreTrajectory(ctx, run, task, trial, trial.session_id, placeholder);
    const stored = await services.kv.get(kvKey(t, "trajectory", built.trajectory_id));
    if (!stored) throw new Error(`trajectory ${built.trajectory_id} disappeared after store`);
    const trajectory = JSON.parse(stored) as Trajectory;

    // Memory-aware: snapshot the store's final contents + prior episodes
    // onto the trajectory so the judge (and re-grade, and the console) see
    // them without re-deriving. Additive fields; absent on plain runs.
    if (trial.memory_store_id && ctx.memory) {
      try {
        const files = await ctx.memory.listFiles({ tenantId: t, storeId: trial.memory_store_id });
        (trajectory as Trajectory & { memory_store?: unknown }).memory_store = {
          store_id: trial.memory_store_id,
          files: files.map((f) => ({ path: f.path, content: f.content.slice(0, 4_000) })).slice(0, 20),
        };
      } catch (err) {
        logWarn({ op: "sim.memory.snapshot", run_id: run.id, err }, "memory snapshot failed; judge proceeds without it");
      }
    }
    if (priorEpisodes.length > 0) {
      (trajectory as Trajectory & { prior_episodes?: unknown }).prior_episodes = priorEpisodes;
    }
    if (trial.memory_store_id || priorEpisodes.length > 0) {
      await services.kv.put(kvKey(t, "trajectory", built.trajectory_id), JSON.stringify(trajectory));
    }

    const reward = await runVerifier(ctx, run, task, trial, trial.session_id, trajectory);
    trajectory.reward = reward;
    await services.kv.put(
      kvKey(t, "trajectory", built.trajectory_id),
      JSON.stringify(trajectory),
    );

    trial.trajectory_id = built.trajectory_id;
    trial.status = "completed";
    trial.ended_at = new Date().toISOString();
    trial.reward = reward.final_reward;
    if ((reward.metadata as { judge_error?: boolean } | undefined)?.judge_error === true) {
      trial.ungraded = true;
    }
    const verdict = (reward.metadata as { verdict?: { findings?: JudgeFinding[] } } | undefined)
      ?.verdict;
    if (task.spec.simulation && verdict?.findings?.length) {
      trial.findings = verdict.findings.slice(0, 10).map(clipFinding);
    }
    return true;
  } catch (err: unknown) {
    // Bounded retry: events fetch can transiently 500 under storage
    // contention. 3 attempts × ~60s cron ≈ 3 min before giving up.
    const msg = err instanceof Error ? err.message : String(err);
    trial.finalize_retry_count = (trial.finalize_retry_count ?? 0) + 1;
    if (trial.finalize_retry_count >= 3) {
      trial.status = "failed";
      trial.error = `events_unavailable_during_finalize (${trial.finalize_retry_count} attempts): ${msg.slice(0, 200)}`;
      trial.ended_at = new Date().toISOString();
    }
    return true;
  }
}

async function advanceTask(
  ctx: EvalRunnerContext,
  run: EvalRunRecord,
  task: EvalTaskResult,
): Promise<boolean> {
  if (task.status === "completed" || task.status === "failed") return false;

  // Trials advance CONCURRENTLY — simulation trials can hold the driver
  // for up to the intra-tick budget waiting on agent turns, and judge
  // finalize calls at max reasoning take minutes. Serial advance starved
  // later trials into their wall-clock timeouts once several simulations
  // ran at once (seen live: two 3-scenario runs → every trial processed
  // last timed out at persona_turns=1 with the agent long idle). Each
  // trial mutates only its own object; run-level rollups happen after.
  const active = task.trials.filter(
    (trial) => trial.status === "pending" || trial.status === "running",
  );
  const results = await Promise.all(
    active.map((trial) => advanceTrial(ctx, run, task, trial)),
  );
  const progressed = results.some(Boolean);

  const completed = task.trials.filter((t) => t.status === "completed").length;
  const failed = task.trials.filter((t) => t.status === "failed").length;
  task.trial_pass_count = completed;
  task.trial_total = task.trials.length;
  if (completed + failed === task.trials.length) {
    if (completed === task.trials.length) {
      task.status = "completed";
    } else {
      task.status = "failed";
      task.error = task.trials.find((t) => t.error)?.error;
    }
    // §6 metrics are additive — status semantics above stay untouched.
    computeTaskMetrics(task);
  } else {
    task.status = "running";
  }
  return progressed;
}

async function advanceRun(ctx: EvalRunnerContext, run: EvalRunRecord): Promise<void> {
  if (run.status === "completed" || run.status === "failed") return;

  if (run.status === "pending") {
    run.status = "running";
    run.started_at = new Date().toISOString();
  }

  // Tasks advance concurrently for the same starvation reason as trials
  // (see advanceTask). Task objects are disjoint; the shared `run` object
  // is only rolled up after all tasks settle.
  const activeTasks = run.tasks.filter(
    (task) => task.status === "pending" || task.status === "running",
  );
  const taskResults = await Promise.all(
    activeTasks.map((task) => advanceTask(ctx, run, task)),
  );
  const progressed = taskResults.some(Boolean);

  run.completed_count = run.tasks.filter((t) => t.status === "completed").length;
  run.failed_count = run.tasks.filter((t) => t.status === "failed").length;
  computeRunRollup(run);

  if (run.completed_count + run.failed_count === run.task_count) {
    run.status = run.failed_count > 0 && run.completed_count === 0 ? "failed" : "completed";
    run.ended_at = new Date().toISOString();
    aggregateFindings(run);
    await saveRun(ctx, run);
    return;
  }

  if (progressed) await saveRun(ctx, run);
}

// ---------- Re-grade (evals-design §7) ----------

/**
 * Re-run ONLY the verifier on a completed run's stored trajectories —
 * conversations are not re-executed. Used to correct verdicts after
 * judge-side fixes (prompt changes, sweep fixes) or rubric edits without
 * paying for fresh agent/persona turns. Workspace access is best-effort:
 * if the session's sandbox is gone the judge still re-runs, just without
 * the workspace section.
 *
 * Trial rewards, ungraded flags, findings, task metrics, run rollups, and
 * the findings report are all recomputed; the run's status/timestamps are
 * untouched.
 */
export async function regradeRun(
  ctx: EvalRunnerContext,
  tenantId: string,
  runId: string,
  opts: { taskId?: string; trialIndex?: number } = {},
): Promise<{ run: EvalRunRecord; regraded: number; skipped: number } | { error: "run_active" } | null> {
  const run = await loadRun(ctx, tenantId, runId);
  if (!run) return null;
  // Re-grade writes the whole results blob back via saveRun; doing that
  // while the cron tick is still advancing this run would clobber live
  // progress. Only terminal runs are re-gradable.
  if (run.status !== "completed" && run.status !== "failed") return { error: "run_active" };
  const services = await ctx.getServicesForTenant(tenantId);

  let regraded = 0;
  let skipped = 0;
  for (const task of run.tasks) {
    if (opts.taskId !== undefined && task.id !== opts.taskId) continue;
    let touched = false;
    for (const trial of task.trials) {
      if (opts.trialIndex !== undefined && trial.trial_index !== opts.trialIndex) continue;
      if (trial.status !== "completed" || !trial.trajectory_id || !trial.session_id) {
        skipped++;
        continue;
      }
      const stored = await services.kv.get(kvKey(tenantId, "trajectory", trial.trajectory_id));
      if (!stored) {
        skipped++;
        continue;
      }
      let trajectory: Trajectory;
      try {
        trajectory = JSON.parse(stored) as Trajectory;
      } catch {
        skipped++;
        continue;
      }

      const reward = await runVerifier(ctx, run, task, trial, trial.session_id, trajectory);
      trajectory.reward = reward;
      await services.kv.put(
        kvKey(tenantId, "trajectory", trial.trajectory_id),
        JSON.stringify(trajectory),
      );

      trial.reward = reward.final_reward;
      if ((reward.metadata as { judge_error?: boolean } | undefined)?.judge_error === true) {
        trial.ungraded = true;
      } else {
        delete trial.ungraded;
      }
      const verdict = (reward.metadata as { verdict?: { findings?: JudgeFinding[] } } | undefined)
        ?.verdict;
      if (task.spec.simulation && verdict?.findings?.length) {
        trial.findings = verdict.findings.slice(0, 10).map(clipFinding);
      } else {
        delete trial.findings;
      }
      regraded++;
      touched = true;
    }
    if (touched) computeTaskMetrics(task);
  }

  if (regraded > 0) {
    computeRunRollup(run);
    run.findings_report = undefined;
    aggregateFindings(run);
    await saveRun(ctx, run);
  }
  return { run, regraded, skipped };
}

// ---------- Public entry point ----------

/**
 * Cross-shard scan: list active eval runs on every shard via the
 * services-level fan-out abstraction, advance each one, save updated
 * state back. Called by the cron tick on both runtimes.
 */
export async function tickEvalRuns(
  ctx: EvalRunnerContext,
): Promise<{ advanced: number; total: number }> {
  let advanced = 0;
  let total = 0;
  const perShard = await ctx.forEachShard(async (services) => {
    const activeRows = await services.evals.listActive();
    return activeRows;
  });
  for (const activeRows of perShard) {
    total += activeRows.length;
    // Runs advance concurrently — a run full of simulations must not
    // starve the runs behind it in the scan (their trial wall-clock
    // timeouts keep ticking while they wait).
    const outcomes = await Promise.all(
      activeRows.map(async (row) => {
        const run = rowToRecord(row);
        try {
          await advanceRun(ctx, run);
          return true;
        } catch (err: unknown) {
          run.status = "failed";
          run.error = err instanceof Error ? err.message : String(err);
          run.ended_at = new Date().toISOString();
          await saveRun(ctx, run);
          return false;
        }
      }),
    );
    advanced += outcomes.filter(Boolean).length;
  }
  return { advanced, total };
}

export { loadRun };
