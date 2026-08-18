// Eval suites — KV-backed CRUD + run-from-suite (evals-design §8).
//
// Same pure package-level pattern as deployments-routes.test.ts: in-memory
// KV, in-memory eval-run service, stub agents service. What's under test is
// the route contract: validation, 501-without-KV posture, tenant scoping of
// suite keys, and that /suites/:id/run creates the same run row shape as
// POST /runs plus suite provenance in `results`.

import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { buildEvalRoutes } from "@open-managed-agents/http-routes";
import { InMemoryKvStore } from "@open-managed-agents/kv-store";
import { createInMemoryEvalRunService } from "@open-managed-agents/evals-store/test-fakes";

const TENANT = "tenant_a";

const TASK = {
  id: "task-1",
  messages: ["do the thing"],
  trials: 2,
};

const SIM_TASK = {
  id: "sim-1",
  simulation: {
    scenario: "A customer cannot find their invoice from March.",
    persona: {
      identity: "Dana, a busy office manager with low technical patience",
      goals: ["get the March invoice emailed to accounting"],
      termination: "invoice is located or the agent gives up",
    },
    max_turns: 5,
  },
  reward: { type: "llm_judge", rubric: "- invoice-found: ...", include_transcript: true, findings: true },
};

function makeHarness(opts: { kv?: boolean } = {}) {
  const kv = new InMemoryKvStore();
  const { service: evals, repo } = createInMemoryEvalRunService();
  const agents = {
    get: async ({ agentId }: { tenantId: string; agentId: string }) =>
      agentId === "agent_1" ? { id: "agent_1", name: "Agent One" } : null,
  };

  const app = new Hono<{ Variables: { tenant_id: string } }>();
  app.use("*", async (c, next) => {
    c.set("tenant_id", TENANT);
    await next();
  });
  app.route(
    "/",
    buildEvalRoutes({
      evals,
      agents: agents as never,
      ...(opts.kv === false ? {} : { kv }),
    }),
  );
  return { app, kv, repo };
}

async function createSuite(
  app: Hono<{ Variables: { tenant_id: string } }>,
  body: Record<string, unknown> = {},
) {
  const res = await app.request("/suites", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "regression", tasks: [TASK], ...body }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    id: string;
    name: string;
    tasks: Array<{ id: string }>;
    [k: string]: unknown;
  };
}

describe("eval suites — CRUD", () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
  });

  it("creates a suite and stores it under the tenant-scoped key", async () => {
    const suite = await createSuite(h.app, { agent_id: "agent_1" });
    expect(suite.id).toMatch(/^evsuite-[a-z0-9]{12}$/);
    expect(suite.name).toBe("regression");
    expect(suite.tasks).toHaveLength(1);
    const raw = await h.kv.get(`t:${TENANT}:eval_suite:${suite.id}`);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!).id).toBe(suite.id);
  });

  it("rejects create without a name and with an invalid task", async () => {
    const noName = await h.app.request("/suites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tasks: [] }),
    });
    expect(noName.status).toBe(400);

    const badTask = await h.app.request("/suites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x", tasks: [{ id: "t", messages: [] }] }),
    });
    expect(badTask.status).toBe(400);
  });

  it("lists suites with task_count instead of inlined tasks, updated_at desc", async () => {
    await createSuite(h.app, { name: "a" });
    await new Promise((r) => setTimeout(r, 5));
    await createSuite(h.app, { name: "b", tasks: [TASK, { ...TASK, id: "task-2" }] });

    const res = await h.app.request("/suites");
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Array<Record<string, unknown>> };
    expect(data).toHaveLength(2);
    expect(data[0].name).toBe("b");
    expect(data[0].task_count).toBe(2);
    expect(data[0]).not.toHaveProperty("tasks");
  });

  it("gets a full suite and 404s on a missing id", async () => {
    const suite = await createSuite(h.app);
    const res = await h.app.request(`/suites/${suite.id}`);
    expect(res.status).toBe(200);
    const full = (await res.json()) as { tasks: unknown[] };
    expect(full.tasks).toHaveLength(1);

    const missing = await h.app.request("/suites/evsuite-nope");
    expect(missing.status).toBe(404);
  });

  it("partially updates and appends tasks with id-uniqueness enforced", async () => {
    const suite = await createSuite(h.app);
    const res = await h.app.request(`/suites/${suite.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "renamed",
        append_task: { id: "task-2", messages: ["again"] },
      }),
    });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as {
      name: string;
      tasks: Array<{ id: string }>;
      updated_at: string;
      created_at: string;
    };
    expect(updated.name).toBe("renamed");
    expect(updated.tasks.map((t) => t.id)).toEqual(["task-1", "task-2"]);

    const dup = await h.app.request(`/suites/${suite.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ append_task: { id: "task-2", messages: ["dupe"] } }),
    });
    expect(dup.status).toBe(400);
  });

  it("deletes a suite and 404s afterwards", async () => {
    const suite = await createSuite(h.app);
    const res = await h.app.request(`/suites/${suite.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ type: "eval_suite_deleted", id: suite.id });
    expect((await h.app.request(`/suites/${suite.id}`)).status).toBe(404);
  });

  it("501s on every suite route when the runtime has no KV", async () => {
    const noKv = makeHarness({ kv: false });
    for (const [method, path] of [
      ["POST", "/suites"],
      ["GET", "/suites"],
      ["GET", "/suites/evsuite-x"],
      ["POST", "/suites/evsuite-x"],
      ["DELETE", "/suites/evsuite-x"],
      ["POST", "/suites/evsuite-x/run"],
    ] as const) {
      const res = await noKv.app.request(path, {
        method,
        headers: { "content-type": "application/json" },
        body: method === "POST" ? "{}" : undefined,
      });
      expect(res.status).toBe(501);
    }
  });
});

describe("eval tasks — simulation validation", () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
  });

  async function postSuite(tasks: unknown[]) {
    return h.app.request("/suites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "sims", tasks }),
    });
  }

  it("accepts a simulation task without messages, in suites and direct runs", async () => {
    const res = await postSuite([SIM_TASK]);
    expect(res.status).toBe(200);

    const run = await h.app.request("/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent_id: "agent_1", environment_id: "env_1", tasks: [SIM_TASK] }),
    });
    expect(run.status).toBe(200);
    const body = (await run.json()) as { run_id: string; task_count: number };
    expect(body.task_count).toBe(1);
  });

  it("rejects a task with both messages and simulation, or neither", async () => {
    const both = await postSuite([{ ...SIM_TASK, messages: ["hi"] }]);
    expect(both.status).toBe(400);
    const neither = await postSuite([{ id: "t" }]);
    expect(neither.status).toBe(400);
  });

  it("rejects incomplete personas and out-of-range max_turns", async () => {
    const cases = [
      { ...SIM_TASK, simulation: { ...SIM_TASK.simulation, scenario: " " } },
      { ...SIM_TASK, simulation: { ...SIM_TASK.simulation, persona: { ...SIM_TASK.simulation.persona, identity: "" } } },
      { ...SIM_TASK, simulation: { ...SIM_TASK.simulation, persona: { ...SIM_TASK.simulation.persona, goals: [] } } },
      { ...SIM_TASK, simulation: { ...SIM_TASK.simulation, persona: { ...SIM_TASK.simulation.persona, termination: "" } } },
      { ...SIM_TASK, simulation: { ...SIM_TASK.simulation, max_turns: 0 } },
      { ...SIM_TASK, simulation: { ...SIM_TASK.simulation, max_turns: 41 } },
      { ...SIM_TASK, simulation: { ...SIM_TASK.simulation, persona: { ...SIM_TASK.simulation.persona, scripted_messages: [] } } },
    ];
    for (const task of cases) {
      const res = await postSuite([task]);
      expect(res.status, JSON.stringify(task.simulation)).toBe(400);
    }
  });

  it("validates simulation.chaos rules", async () => {
    const withChaos = (chaos) => ({ ...SIM_TASK, simulation: { ...SIM_TASK.simulation, chaos } });
    expect((await postSuite([withChaos({ rules: [{ tool: "web_search", failure_rate: 0.3 }] })])).status).toBe(200);
    expect((await postSuite([withChaos({ rules: [] })])).status).toBe(400);
    expect((await postSuite([withChaos({ rules: [{ tool: "", failure_rate: 0.3 }] })])).status).toBe(400);
    expect((await postSuite([withChaos({ rules: [{ tool: "bash", failure_rate: 2 }] })])).status).toBe(400);
    expect((await postSuite([withChaos({ rules: [{ tool: "bash", failure_rate: 0.5, mode: "explode" }] })])).status).toBe(400);
  });

  it("validates simulation.memory_store and episodes", async () => {
    const withSim = (extra) => ({ ...SIM_TASK, simulation: { ...SIM_TASK.simulation, ...extra } });
    expect((await postSuite([withSim({ memory_store: { fresh: true } })])).status).toBe(200);
    expect((await postSuite([withSim({ memory_store: { store_id: "mem_1", access: "read_only" } })])).status).toBe(200);
    // seed_files only make sense for a fresh per-trial store
    expect((await postSuite([withSim({ memory_store: { store_id: "mem_1",
      seed_files: [{ path: "notes.md", content: "x" }] } })])).status).toBe(400);
    expect((await postSuite([withSim({ memory_store: { fresh: true,
      seed_files: [{ path: "notes.md", content: "x" }] } })])).status).toBe(200);
    // exactly one of store_id | fresh
    expect((await postSuite([withSim({ memory_store: {} })])).status).toBe(400);
    expect((await postSuite([withSim({ memory_store: { store_id: "m", fresh: true } })])).status).toBe(400);
    expect((await postSuite([withSim({ memory_store: { fresh: true, access: "rw" } })])).status).toBe(400);
    // seed paths must be store-relative
    expect((await postSuite([withSim({ memory_store: { fresh: true, seed_files: [{ path: "/abs.md", content: "x" }] } })])).status).toBe(400);
    expect((await postSuite([withSim({ memory_store: { fresh: true, seed_files: [{ path: "../up.md", content: "x" }] } })])).status).toBe(400);
    // episodes need memory_store; bounded; per-episode max_turns validated
    expect((await postSuite([withSim({ episodes: [{ scenario: "later" }] })])).status).toBe(400);
    expect((await postSuite([withSim({ memory_store: { fresh: true }, episodes: [{ scenario: "later" }] })])).status).toBe(200);
    expect((await postSuite([withSim({ memory_store: { fresh: true }, episodes: [] })])).status).toBe(400);
    expect((await postSuite([withSim({ memory_store: { fresh: true }, episodes: [{ max_turns: 0 }] })])).status).toBe(400);
    expect((await postSuite([withSim({ memory_store: { fresh: true }, episodes: Array(6).fill({}) })])).status).toBe(400);
  });

  it("runs a suite containing a simulation task with the standard initial row shape", async () => {
    const suite = await createSuite(h.app, { name: "sims", tasks: [SIM_TASK], agent_id: "agent_1" });
    const res = await h.app.request(`/suites/${suite.id}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ environment_id: "env_1" }),
    });
    expect(res.status).toBe(200);
    const { run_id } = (await res.json()) as { run_id: string };
    const run = await h.app.request(`/runs/${run_id}`);
    const record = (await run.json()) as {
      tasks: Array<{ id: string; spec: { simulation?: unknown }; trials: unknown[] }>;
    };
    expect(record.tasks[0].id).toBe("sim-1");
    expect(record.tasks[0].spec.simulation).toBeDefined();
    expect(record.tasks[0].trials).toHaveLength(1);
  });
});

describe("eval suites — run from suite", () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
  });

  it("creates a run with the same row shape as POST /runs plus suite provenance", async () => {
    const suite = await createSuite(h.app, { agent_id: "agent_1" });
    const res = await h.app.request(`/suites/${suite.id}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ environment_id: "env_1" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { run_id: string; task_count: number; suite_id: string };
    expect(body.task_count).toBe(1);
    expect(body.suite_id).toBe(suite.id);

    const run = await h.app.request(`/runs/${body.run_id}`);
    expect(run.status).toBe(200);
    const record = (await run.json()) as {
      agent_id: string;
      suite_id?: string;
      suite_name?: string;
      tasks: Array<{ id: string; trials: unknown[]; trial_total: number }>;
    };
    expect(record.agent_id).toBe("agent_1");
    expect(record.suite_id).toBe(suite.id);
    expect(record.suite_name).toBe("regression");
    // Same initial task/trial shape POST /runs produces (trials: 2 on TASK).
    expect(record.tasks[0].trial_total).toBe(2);
    expect(record.tasks[0].trials).toHaveLength(2);
  });

  it("uses body.agent_id over the suite's, 400s when neither is set", async () => {
    const unpinned = await createSuite(h.app, { agent_id: undefined });
    const noAgent = await h.app.request(`/suites/${unpinned.id}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ environment_id: "env_1" }),
    });
    expect(noAgent.status).toBe(400);

    const withAgent = await h.app.request(`/suites/${unpinned.id}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent_id: "agent_1", environment_id: "env_1" }),
    });
    expect(withAgent.status).toBe(200);
  });

  it("404s on a missing agent and 400s on an empty suite", async () => {
    const suite = await createSuite(h.app, { agent_id: "agent_missing" });
    const res = await h.app.request(`/suites/${suite.id}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ environment_id: "env_1" }),
    });
    expect(res.status).toBe(404);

    const empty = await createSuite(h.app, { name: "empty", tasks: [], agent_id: "agent_1" });
    const emptyRun = await h.app.request(`/suites/${empty.id}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ environment_id: "env_1" }),
    });
    expect(emptyRun.status).toBe(400);
  });
});
