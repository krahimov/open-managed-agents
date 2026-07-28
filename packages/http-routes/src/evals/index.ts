// Eval routes — POST/GET/DELETE for /v1/evals/runs.
//
// Sourced from apps/main/src/routes/evals.ts pre-extract: same wire shape,
// same status codes, same opaque `results` JSON column. The cron tick
// (packages/evals-runner/tickEvalRuns) advances rows independently — these
// routes only manage create + read + cancel.
//
// Storage: caller injects `evals` (EvalRunService from
// @open-managed-agents/evals-store) + `agents`/`environments` for the
// existence checks. CF passes its services bundle; Node passes its own
// (Node returns null from `environments` lookups today — we accept the
// run create against a synthesized localhost env).

import { Hono } from "hono";
import { customAlphabet } from "nanoid";
import type {
  EvalRunService,
  EvalRunRow,
  EvalRunStatus,
} from "@open-managed-agents/evals-store";
import type { AgentService } from "@open-managed-agents/agents-store";
import type { EnvironmentService } from "@open-managed-agents/environments-store";
import { listAll, type KvStore } from "@open-managed-agents/kv-store";
import type { RewardSpec } from "@open-managed-agents/shared";

interface Vars {
  Variables: { tenant_id: string };
}

export interface EvalTaskSpec {
  id: string;
  setup_files?: { path: string; content: string }[];
  setup_script?: string;
  messages: string[];
  timeout_ms?: number;
  trials?: number;
  reward?: RewardSpec;
  /** A trial passes iff final_reward >= this (evals-design §6). Default 1.0. */
  pass_threshold?: number;
}

/** Stored suite record (evals-design §8 save-as-eval). KV-backed at
 *  `t:<tenant>:eval_suite:<id>` — no migration, mirrors trajectory storage. */
export interface EvalSuite {
  id: string;
  name: string;
  agent_id?: string;
  judge?: { model_card_id?: string; reasoning_level?: string };
  tasks: EvalTaskSpec[];
  source_sessions?: string[];
  baseline_run_id?: string;
  created_at: string;
  updated_at: string;
}

export interface EvalRoutesDeps {
  evals: EvalRunService;
  agents: AgentService;
  /** Optional. When omitted we don't 404 on missing environments — Node
   *  doesn't have a per-tenant environments store yet (P5 work). */
  environments?: EnvironmentService;
  /** Optional. Backs GET /trajectories/:id — the eval runner stores the
   *  enriched trajectory (reward metadata, trace_facts) in KV under
   *  `t:<tenant>:trajectory:<id>` (evals-runner kvKey). Also backs the
   *  /suites CRUD. Runtimes without a KV binding here get a clear 501
   *  instead of a silent rebuild that would drop the verdict + trace
   *  facts. */
  kv?: KvStore;
}

// Lowercase alnum only — same alphabet as @oma/shared generateId.
const suiteIdAlphabet = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 12);

function suiteKey(tenantId: string, id: string): string {
  return `t:${tenantId}:eval_suite:${id}`;
}

/** Per-task validation shared by POST /runs and the suite routes.
 *  Returns an error message, or null when the task is valid. */
function taskSpecError(task: EvalTaskSpec): string | null {
  if (!task || typeof task !== "object") {
    return `task must be an object: ${JSON.stringify(task).slice(0, 100)}`;
  }
  if (!task.id) return `task missing id: ${JSON.stringify(task).slice(0, 100)}`;
  if (!Array.isArray(task.messages) || task.messages.length === 0) {
    return `task ${task.id} requires non-empty messages array`;
  }
  if (
    task.pass_threshold !== undefined &&
    (typeof task.pass_threshold !== "number" || !Number.isFinite(task.pass_threshold))
  ) {
    return `task ${task.id} pass_threshold must be a finite number`;
  }
  return null;
}

function duplicateTaskId(tasks: EvalTaskSpec[]): string | null {
  const seen = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.id)) return task.id;
    seen.add(task.id);
  }
  return null;
}

/** Initial `results` JSON for a fresh run — shared by POST /runs and
 *  POST /suites/:id/run so both create identical rows for the cron tick. */
function buildInitialResults(tasks: EvalTaskSpec[]) {
  return {
    task_count: tasks.length,
    completed_count: 0,
    failed_count: 0,
    tasks: tasks.map((spec) => {
      const trialCount = Math.max(1, spec.trials || 1);
      const trials = [];
      for (let i = 0; i < trialCount; i++) {
        trials.push({ trial_index: i, status: "pending" as EvalRunStatus });
      }
      return { id: spec.id, spec, status: "pending" as EvalRunStatus, trials, trial_total: trialCount };
    }),
  };
}

export function buildEvalRoutes(deps: EvalRoutesDeps) {
  const app = new Hono<Vars>();

  // POST /v1/evals/runs — create
  app.post("/runs", async (c) => {
    const t = c.var.tenant_id;
    const body = await c.req.json<{
      agent_id: string;
      environment_id: string;
      tasks: EvalTaskSpec[];
    }>();

    if (!body.agent_id) return c.json({ error: "agent_id is required" }, 400);
    if (!body.environment_id) return c.json({ error: "environment_id is required" }, 400);
    if (!Array.isArray(body.tasks) || body.tasks.length === 0) {
      return c.json({ error: "tasks array is required and must be non-empty" }, 400);
    }
    for (const task of body.tasks) {
      const taskErr = taskSpecError(task);
      if (taskErr) return c.json({ error: taskErr }, 400);
    }

    const [agentRow, envRow] = await Promise.all([
      deps.agents.get({ tenantId: t, agentId: body.agent_id }),
      deps.environments
        ? deps.environments.get({ tenantId: t, environmentId: body.environment_id })
        : Promise.resolve({} as unknown), // Node: skip env existence check
    ]);
    if (!agentRow) return c.json({ error: "Agent not found" }, 404);
    if (deps.environments && !envRow) return c.json({ error: "Environment not found" }, 404);

    const run = await deps.evals.create({
      tenantId: t,
      agentId: body.agent_id,
      environmentId: body.environment_id,
      results: buildInitialResults(body.tasks),
    });

    return c.json({ run_id: run.id, task_count: body.tasks.length });
  });

  // GET /v1/evals/runs — paginated list
  app.get("/runs", async (c) => {
    const t = c.var.tenant_id;
    const limitParam = c.req.query("limit");
    let limit = limitParam ? parseInt(limitParam, 10) : 100;
    if (isNaN(limit) || limit < 1) limit = 100;
    if (limit > 1000) limit = 1000;

    // status: enum filter. Whitelist strictly — any unknown value is a 400,
    // NOT a silent fallback to "all". Allowing arbitrary strings here would
    // mask client bugs (typo'd "completed " returning every row looks like a
    // feature). Mirrors the agents route pattern.
    const statusRaw = c.req.query("status");
    let status: EvalRunStatus | undefined;
    if (statusRaw !== undefined) {
      if (
        statusRaw === "pending" ||
        statusRaw === "running" ||
        statusRaw === "completed" ||
        statusRaw === "failed"
      ) {
        status = statusRaw;
      } else {
        return c.json(
          {
            error: {
              type: "invalid_request_error",
              code: "invalid_status",
              message: `Invalid status '${statusRaw}'; expected one of pending|running|completed|failed.`,
            },
          },
          400,
        );
      }
    }

    const runs = await deps.evals.list({
      tenantId: t,
      limit,
      agentId: c.req.query("agent_id") || undefined,
      environmentId: c.req.query("environment_id") || undefined,
      status,
    });

    return c.json({ data: runs.map(rowToApi) });
  });

  // GET /v1/evals/trajectories/:id — stored (enriched) trajectory.
  // The runner persists this at trial finalize with reward.metadata
  // (llm_judge verdict, judge identity, usage) and trace_facts already
  // stamped — unlike GET /v1/sessions/:id/trajectory, which rebuilds
  // from events and carries neither.
  app.get("/trajectories/:id", async (c) => {
    if (!deps.kv) {
      return c.json({ error: "stored trajectories unavailable on this runtime" }, 501);
    }
    const t = c.var.tenant_id;
    // Key shape must match evals-runner kvKey(t, "trajectory", id).
    const raw = await deps.kv.get(`t:${t}:trajectory:${c.req.param("id")}`);
    if (raw === null) return c.json({ error: "Trajectory not found" }, 404);
    return c.body(raw, 200, { "content-type": "application/json" });
  });

  // GET /v1/evals/runs/:id — detail
  app.get("/runs/:id", async (c) => {
    const t = c.var.tenant_id;
    const run = await deps.evals.get({ tenantId: t, runId: c.req.param("id") });
    if (!run) return c.json({ error: "Run not found" }, 404);
    return c.json(rowToApi(run));
  });

  // DELETE /v1/evals/runs/:id — cancel (mark failed) + delete
  app.delete("/runs/:id", async (c) => {
    const t = c.var.tenant_id;
    const id = c.req.param("id");
    const run = await deps.evals.get({ tenantId: t, runId: id });
    if (!run) return c.json({ error: "Run not found" }, 404);
    // If still in-flight, flip to failed first so the cron tick stops
    // touching it before we delete the row.
    if (run.status === "pending" || run.status === "running") {
      await deps.evals.markCompleted({
        tenantId: t,
        runId: id,
        status: "failed",
        error: "cancelled by user",
      });
    }
    await deps.evals.delete({ tenantId: t, runId: id });
    return c.json({ type: "eval_run_deleted", id });
  });

  // ── Eval suites (evals-design §8 save-as-eval) ──────────────────────
  // KV-backed CRUD + "run this suite". Same 501 posture as the stored-
  // trajectory route: runtimes without a KV binding get a clear error.

  // POST /v1/evals/suites — create
  app.post("/suites", async (c) => {
    if (!deps.kv) return c.json({ error: "suites unavailable on this runtime" }, 501);
    const t = c.var.tenant_id;
    const body = await c.req.json<Partial<EvalSuite>>().catch(() => null);
    if (!body || typeof body.name !== "string" || !body.name.trim()) {
      return c.json({ error: "name is required" }, 400);
    }
    // Empty tasks is allowed on create — the save-as-eval flow drafts a
    // suite first and appends tasks one session at a time.
    const tasks = body.tasks ?? [];
    if (!Array.isArray(tasks)) return c.json({ error: "tasks must be an array" }, 400);
    for (const task of tasks) {
      const taskErr = taskSpecError(task);
      if (taskErr) return c.json({ error: taskErr }, 400);
    }
    const dup = duplicateTaskId(tasks);
    if (dup) return c.json({ error: `duplicate task id in suite: ${dup}` }, 400);

    const now = new Date().toISOString();
    const suite: EvalSuite = {
      id: `evsuite-${suiteIdAlphabet()}`,
      name: body.name.trim(),
      ...(body.agent_id ? { agent_id: body.agent_id } : {}),
      ...(body.judge ? { judge: body.judge } : {}),
      tasks,
      ...(Array.isArray(body.source_sessions) ? { source_sessions: body.source_sessions } : {}),
      ...(body.baseline_run_id ? { baseline_run_id: body.baseline_run_id } : {}),
      created_at: now,
      updated_at: now,
    };
    await deps.kv.put(suiteKey(t, suite.id), JSON.stringify(suite));
    return c.json(suite);
  });

  // GET /v1/evals/suites — list (tasks summarized as task_count)
  app.get("/suites", async (c) => {
    if (!deps.kv) return c.json({ error: "suites unavailable on this runtime" }, 501);
    const t = c.var.tenant_id;
    const kv = deps.kv;
    const keys = await listAll(kv, `t:${t}:eval_suite:`);
    const suites: EvalSuite[] = [];
    for (const key of keys) {
      const raw = await kv.get(key.name);
      if (raw === null) continue;
      try {
        suites.push(JSON.parse(raw) as EvalSuite);
      } catch {
        // skip corrupt rows rather than failing the whole listing
      }
    }
    suites.sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
    return c.json({
      data: suites.map(({ tasks, ...rest }) => ({
        ...rest,
        task_count: Array.isArray(tasks) ? tasks.length : 0,
      })),
    });
  });

  // GET /v1/evals/suites/:id — full suite
  app.get("/suites/:id", async (c) => {
    if (!deps.kv) return c.json({ error: "suites unavailable on this runtime" }, 501);
    const raw = await deps.kv.get(suiteKey(c.var.tenant_id, c.req.param("id")));
    if (raw === null) return c.json({ error: "Suite not found" }, 404);
    return c.body(raw, 200, { "content-type": "application/json" });
  });

  // POST /v1/evals/suites/:id — partial update
  app.post("/suites/:id", async (c) => {
    if (!deps.kv) return c.json({ error: "suites unavailable on this runtime" }, 501);
    const t = c.var.tenant_id;
    const key = suiteKey(t, c.req.param("id"));
    const raw = await deps.kv.get(key);
    if (raw === null) return c.json({ error: "Suite not found" }, 404);
    const suite = JSON.parse(raw) as EvalSuite;

    const body = await c.req
      .json<Partial<EvalSuite> & { append_task?: EvalTaskSpec }>()
      .catch(() => null);
    if (!body) return c.json({ error: "invalid JSON body" }, 400);

    if (body.name !== undefined) {
      if (typeof body.name !== "string" || !body.name.trim()) {
        return c.json({ error: "name must be a non-empty string" }, 400);
      }
      suite.name = body.name.trim();
    }
    if (body.agent_id !== undefined) suite.agent_id = body.agent_id || undefined;
    if (body.judge !== undefined) suite.judge = body.judge || undefined;
    if (body.baseline_run_id !== undefined) suite.baseline_run_id = body.baseline_run_id || undefined;
    if (body.tasks !== undefined) {
      if (!Array.isArray(body.tasks)) return c.json({ error: "tasks must be an array" }, 400);
      for (const task of body.tasks) {
        const taskErr = taskSpecError(task);
        if (taskErr) return c.json({ error: taskErr }, 400);
      }
      const dup = duplicateTaskId(body.tasks);
      if (dup) return c.json({ error: `duplicate task id in suite: ${dup}` }, 400);
      suite.tasks = body.tasks;
    }
    if (body.append_task !== undefined) {
      const taskErr = taskSpecError(body.append_task);
      if (taskErr) return c.json({ error: taskErr }, 400);
      if (suite.tasks.some((task) => task.id === body.append_task!.id)) {
        return c.json({ error: `task id already exists in suite: ${body.append_task.id}` }, 400);
      }
      suite.tasks = [...suite.tasks, body.append_task];
    }

    suite.updated_at = new Date().toISOString();
    await deps.kv.put(key, JSON.stringify(suite));
    return c.json(suite);
  });

  // DELETE /v1/evals/suites/:id — hard delete
  app.delete("/suites/:id", async (c) => {
    if (!deps.kv) return c.json({ error: "suites unavailable on this runtime" }, 501);
    const t = c.var.tenant_id;
    const id = c.req.param("id");
    const key = suiteKey(t, id);
    const raw = await deps.kv.get(key);
    if (raw === null) return c.json({ error: "Suite not found" }, 404);
    await deps.kv.delete(key);
    return c.json({ type: "eval_suite_deleted", id });
  });

  // POST /v1/evals/suites/:id/run — launch a run from the suite's tasks.
  // Identical row shape to POST /runs (shared buildInitialResults), plus
  // suite provenance stamped into `results` — evals-runner rowToRecord /
  // extractResults carry the two fields across ticks.
  app.post("/suites/:id/run", async (c) => {
    if (!deps.kv) return c.json({ error: "suites unavailable on this runtime" }, 501);
    const t = c.var.tenant_id;
    const raw = await deps.kv.get(suiteKey(t, c.req.param("id")));
    if (raw === null) return c.json({ error: "Suite not found" }, 404);
    const suite = JSON.parse(raw) as EvalSuite;

    const body = await c.req
      .json<{ agent_id?: string; environment_id?: string }>()
      .catch(() => ({}) as { agent_id?: string; environment_id?: string });
    const agentId = body.agent_id ?? suite.agent_id;
    if (!agentId) return c.json({ error: "agent_id is required (suite has none pinned)" }, 400);
    if (!body.environment_id) return c.json({ error: "environment_id is required" }, 400);
    if (!Array.isArray(suite.tasks) || suite.tasks.length === 0) {
      return c.json({ error: "suite has no tasks" }, 400);
    }

    const [agentRow, envRow] = await Promise.all([
      deps.agents.get({ tenantId: t, agentId }),
      deps.environments
        ? deps.environments.get({ tenantId: t, environmentId: body.environment_id })
        : Promise.resolve({} as unknown), // Node: skip env existence check
    ]);
    if (!agentRow) return c.json({ error: "Agent not found" }, 404);
    if (deps.environments && !envRow) return c.json({ error: "Environment not found" }, 404);

    const run = await deps.evals.create({
      tenantId: t,
      agentId,
      environmentId: body.environment_id,
      results: {
        ...buildInitialResults(suite.tasks),
        suite_id: suite.id,
        suite_name: suite.name,
      },
    });

    return c.json({ run_id: run.id, task_count: suite.tasks.length, suite_id: suite.id });
  });

  return app;
}

function rowToApi(run: EvalRunRow) {
  const partial = (run.results ?? {}) as {
    task_count?: number;
    completed_count?: number;
    failed_count?: number;
    tasks?: unknown[];
    tasks_pass_at_k?: number;
    tasks_pass_all_k?: number;
    suite_id?: string;
    suite_name?: string;
  };
  return {
    id: run.id,
    tenant_id: run.tenant_id,
    agent_id: run.agent_id,
    environment_id: run.environment_id,
    status: run.status,
    created_at: run.started_at,
    started_at: run.started_at,
    ended_at: run.completed_at ?? undefined,
    error: run.error ?? undefined,
    task_count: partial.task_count ?? 0,
    completed_count: partial.completed_count ?? 0,
    failed_count: partial.failed_count ?? 0,
    tasks: partial.tasks ?? [],
    // §6 rollups — computed by the runner tick, absent on legacy rows.
    ...(partial.tasks_pass_at_k !== undefined ? { tasks_pass_at_k: partial.tasks_pass_at_k } : {}),
    ...(partial.tasks_pass_all_k !== undefined ? { tasks_pass_all_k: partial.tasks_pass_all_k } : {}),
    // §8 suite provenance — present only on runs launched via /suites/:id/run.
    ...(partial.suite_id !== undefined ? { suite_id: partial.suite_id } : {}),
    ...(partial.suite_name !== undefined ? { suite_name: partial.suite_name } : {}),
  };
}
