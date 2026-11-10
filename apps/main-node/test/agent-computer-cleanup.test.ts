// What happens to an agent's cloud computer when the agent is deleted or
// archived — through the real agent routes, the SQL machine store and the
// AgentMachineManager, with only Daytona faked.

import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { buildAgentRoutes } from "@open-managed-agents/http-routes";
import { createSqliteAgentService } from "@open-managed-agents/agents-store";
import { AgentMachineManager } from "@open-managed-agents/sandbox/machines/manager";
import { DaytonaBoxInventory } from "@open-managed-agents/sandbox/adapters/daytona-inventory";
import { FakeDaytona, FakeDaytonaHttpError, fakeDaytonaModule } from "../../../packages/sandbox/tests/fake-daytona";
import { NodeAgentMachineStore } from "../src/lib/agent-machine-store";
import { agentComputerSpec } from "../src/lib/agent-computer-config";
import { createAgentComputerCleanup } from "../src/lib/agent-computer-cleanup";
import { SandboxSweeper, sandboxSweepConfigFromEnv, sandboxSweepSqlLookups } from "../src/lib/sandbox-sweeper";
import { bootstrapTestDb } from "./_helpers/bootstrap-test-db";

const spec = { ...agentComputerSpec({}), bootstrapTools: false, browser: false };
const teardown: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const fn of teardown.splice(0).reverse()) await fn(); });

async function setup(opts: { waitMs?: number } = {}) {
  const { sql, db, cleanup } = await bootstrapTestDb();
  teardown.push(cleanup);
  const agents = createSqliteAgentService({ db });
  const store = new NodeAgentMachineStore({ sql, dialect: "sqlite" });
  await store.ensureSchema();
  const fake = new FakeDaytona();
  const lookups = sandboxSweepSqlLookups(sql);
  const manager = new AgentMachineManager({
    store, daytonaModule: fakeDaytonaModule(fake), apiKey: "test", tickIntervalMs: 0,
    bootstrap: async () => {}, deploymentId: "dep_test", agentExists: lookups.agentExists, logger: { warn() {} },
  });
  teardown.push(() => manager.dispose());
  const cleanupHooks = createAgentComputerCleanup({ machines: manager, waitMs: opts.waitMs });

  const app = new Hono<{ Variables: { tenant_id: string } }>();
  app.use("*", async (c, next) => { c.set("tenant_id", c.req.header("x-test-tenant") ?? "tenant-a"); await next(); });
  app.route("/agents", buildAgentRoutes({
    services: { agents } as never,
    onAgentDeleted: cleanupHooks.onAgentDeleted,
    onAgentArchived: cleanupHooks.onAgentArchived,
  }));

  const createAgent = async (tenantId = "tenant-a") =>
    (await agents.create({ tenantId, input: { name: "Invoice auditor", model: "test-model", tools: [] } })).id;
  const startComputer = async (agentId: string, tenantId = "tenant-a") =>
    (await manager.acquire({ tenantId, agentId, spec })).sb;
  const sweeper = new SandboxSweeper({
    inventory: new DaytonaBoxInventory({ apiKey: "test", daytonaModule: fakeDaytonaModule(fake) }),
    listMachines: () => store.list(),
    destroyMachine: (tenantId, agentId) => manager.destroy(tenantId, agentId, { reason: "agent_missing" }),
    ...lookups,
    deploymentId: "dep_test",
    config: { ...sandboxSweepConfigFromEnv({}), minBoxAgeMs: 0 },
  });
  return { app, agents, store, fake, manager, sweeper, createAgent, startComputer };
}

describe("DELETE /v1/agents/:id", () => {
  it("deletes the agent's computer: the provider box and the machine row", async () => {
    const { app, agents, store, fake, createAgent, startComputer } = await setup();
    const agentId = await createAgent();
    const box = await startComputer(agentId);

    const res = await app.request(`/agents/${agentId}`, { method: "DELETE" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ type: "agent_deleted", id: agentId });
    expect(await agents.get({ tenantId: "tenant-a", agentId })).toBeNull();
    expect(fake.deleteCalls).toEqual([box.id]);
    expect(await store.list()).toEqual([]);
  });

  it("works for an agent that never had a computer, without calling the provider", async () => {
    const { app, fake, createAgent } = await setup();
    const agentId = await createAgent();
    const res = await app.request(`/agents/${agentId}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(fake.clientConfigs).toEqual([]);
  });

  it("is tenant-checked: another tenant cannot delete the agent or its computer", async () => {
    const { app, agents, store, fake, createAgent, startComputer } = await setup();
    const agentId = await createAgent();
    await startComputer(agentId);

    const res = await app.request(`/agents/${agentId}`, { method: "DELETE", headers: { "x-test-tenant": "tenant-b" } });

    expect(res.status).toBe(404);
    expect(await agents.get({ tenantId: "tenant-a", agentId })).not.toBeNull();
    expect(fake.deleteCalls).toEqual([]);
    expect(await store.list()).toHaveLength(1);
  });

  it("still deletes the agent when Daytona is down, and the sweeper finishes the cleanup later", async () => {
    const { app, agents, store, fake, sweeper, createAgent, startComputer } = await setup();
    const agentId = await createAgent();
    const box = await startComputer(agentId);
    const realDelete = fake.delete.bind(fake);
    fake.delete = async () => { throw new FakeDaytonaHttpError("upstream unavailable", 503); };

    const res = await app.request(`/agents/${agentId}`, { method: "DELETE" });

    expect(res.status).toBe(200);
    expect(await agents.get({ tenantId: "tenant-a", agentId })).toBeNull();
    // The failure is on record: the row stays, marked for deletion.
    const [row] = await store.list();
    expect(row).toMatchObject({ agentId, state: "deleting", providerRef: box.id });
    expect(row.errorReason).toContain("upstream unavailable");

    fake.delete = realDelete;
    const report = await sweeper.run();

    expect(report.results).toEqual([
      { action: expect.objectContaining({ kind: "machine", agentId, reason: "agent_missing" }), outcome: "deleted" },
    ]);
    expect(fake.deleteCalls).toEqual([box.id]);
    expect(await store.list()).toEqual([]);
  });

  it("does not wait on a hanging provider", async () => {
    const { app, fake, createAgent, startComputer } = await setup({ waitMs: 30 });
    const agentId = await createAgent();
    await startComputer(agentId);
    let release!: () => void;
    fake.delete = () => new Promise<void>((resolve) => { release = resolve; });

    const started = Date.now();
    const res = await app.request(`/agents/${agentId}`, { method: "DELETE" });

    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(2_000);
    release();
  });
});

describe("POST /v1/agents/:id/archive", () => {
  it("stops the computer and keeps it", async () => {
    const { app, store, fake, createAgent, startComputer } = await setup();
    const agentId = await createAgent();
    const box = await startComputer(agentId);

    const res = await app.request(`/agents/${agentId}/archive`, { method: "POST" });

    expect(res.status).toBe(200);
    expect((await res.json() as { archived_at: string | null }).archived_at).not.toBeNull();
    expect(fake.deleteCalls).toEqual([]);
    expect(fake.sandboxes.get(box.id)?.state).toBe("stopped");
    expect(await store.list()).toEqual([expect.objectContaining({ agentId, state: "stopped", providerRef: box.id })]);
  });

  it("archives even when the computer cannot be stopped", async () => {
    const { app, store, fake, createAgent, startComputer } = await setup();
    const agentId = await createAgent();
    const box = await startComputer(agentId);
    const [row] = await store.list();
    await store.upsertAttachment({
      sessionId: "sess-busy", machineId: row.id, tenantId: "tenant-a", workerId: "w", generation: row.generation,
      turnActive: true, bgProcesses: 0, viewers: 0, now: Date.now(),
    });

    const res = await app.request(`/agents/${agentId}/archive`, { method: "POST" });

    expect(res.status).toBe(200);
    expect(fake.sandboxes.get(box.id)?.state).toBe("started");
  });

  it("is not treated as deletion by the sweeper", async () => {
    const { app, fake, sweeper, createAgent, startComputer } = await setup();
    const agentId = await createAgent();
    await startComputer(agentId);
    await app.request(`/agents/${agentId}/archive`, { method: "POST" });
    const report = await sweeper.run();
    expect(report.results).toEqual([]);
    expect(report.skipped).toEqual({ live: 1 });
    expect(fake.deleteCalls).toEqual([]);
  });
});
