// The orphan-sandbox sweeper end to end: real SQL lookups, real machine
// store + manager, the real account inventory — only Daytona is faked.
// (The decision rules themselves are pinned in sandbox-sweep-plan.test.ts.)

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createPostgresSqlClient, type SqlClient } from "@open-managed-agents/sql-client";
import { createSqliteAgentService } from "@open-managed-agents/agents-store";
import { createSqliteSessionService } from "@open-managed-agents/sessions-store";
import { AgentMachineManager } from "@open-managed-agents/sandbox/machines/manager";
import { DaytonaBoxInventory } from "@open-managed-agents/sandbox/adapters/daytona-inventory";
import { FakeDaytona, FakeDaytonaHttpError, fakeDaytonaModule } from "../../../packages/sandbox/tests/fake-daytona";
import { NodeAgentMachineStore } from "../src/lib/agent-machine-store";
import { agentComputerSpec } from "../src/lib/agent-computer-config";
import { resolveDeploymentIdentity } from "../src/lib/deployment-identity";
import {
  SANDBOX_SWEEP_DEFAULT_CRON,
  SandboxSweeper,
  sandboxSweepConfigFromEnv,
  sandboxSweepCronFromEnv,
  sandboxSweepSqlLookups,
  type SandboxSweepConfig,
  type SandboxSweeperDeps,
} from "../src/lib/sandbox-sweeper";
import { bootstrapTestDb } from "./_helpers/bootstrap-test-db";

const HERE = "dep_here";
const DAY = 24 * 60 * 60_000;
const spec = { ...agentComputerSpec({}), bootstrapTools: false, browser: false };
const teardown: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const fn of teardown.splice(0).reverse()) await fn(); });

async function setup(config: Partial<SandboxSweepConfig> = {}, overrides: Partial<SandboxSweeperDeps> = {}) {
  const { sql, db, cleanup } = await bootstrapTestDb();
  teardown.push(cleanup);
  const agents = createSqliteAgentService({ db });
  const sessions = createSqliteSessionService({ db });
  const store = new NodeAgentMachineStore({ sql, dialect: "sqlite" });
  await store.ensureSchema();
  const fake = new FakeDaytona();
  // Boxes are "created" two days ago so the creation grace does not apply.
  fake.now = () => Date.now() - 2 * DAY;
  const lookups = sandboxSweepSqlLookups(sql);
  const manager = new AgentMachineManager({
    store, daytonaModule: fakeDaytonaModule(fake), apiKey: "test", tickIntervalMs: 0,
    bootstrap: async () => {}, deploymentId: HERE, agentExists: lookups.agentExists, logger: { warn() {} },
  });
  teardown.push(() => manager.dispose());
  const sweeper = new SandboxSweeper({
    inventory: new DaytonaBoxInventory({ apiKey: "test", daytonaModule: fakeDaytonaModule(fake) }),
    listMachines: () => store.list(),
    destroyMachine: (tenantId, agentId) => manager.destroy(tenantId, agentId, { reason: "agent_missing" }),
    ...lookups,
    deploymentId: HERE,
    config: { ...sandboxSweepConfigFromEnv({}), ...config },
    ...overrides,
  });

  const agentWithComputer = async (tenantId = "tenant-a") => {
    const agent = await agents.create({ tenantId, input: { name: "agent", model: "test-model", tools: [] } });
    const box = (await manager.acquire({ tenantId, agentId: agent.id, spec })).sb;
    return { agentId: agent.id, boxId: box.id };
  };
  /** A session with a per-session box; `idleDays` back-dates its last activity. */
  const sessionWithBox = async (opts: { idleDays?: number; status?: string; labels?: Record<string, string> } = {}) => {
    const { session } = await sessions.create({
      tenantId: "tenant-a", agentId: "agent-x", environmentId: "env-1", vaultIds: [], title: "s",
      agentSnapshot: { id: "agent-x" } as never, environmentSnapshot: { id: "env-1" } as never,
    });
    const at = Date.now() - (opts.idleDays ?? 0) * DAY;
    await sql.prepare(`UPDATE sessions SET status = ?, created_at = ?, updated_at = ? WHERE id = ?`)
      .bind(opts.status ?? "idle", at, at, session.id).run();
    const box = await fake.create({
      labels: opts.labels ?? { "oma-session-id": session.id, "oma-tenant-id": "tenant-a", "oma-deployment-id": HERE },
    });
    return { sessionId: session.id, boxId: box.id };
  };
  return { sql, agents, sessions, store, fake, manager, sweeper, agentWithComputer, sessionWithBox };
}

describe("SandboxSweeper", () => {
  it("deletes exactly the orphans and leaves live, foreign and unlabelled boxes alone", async () => {
    const t = await setup();
    const live = await t.agentWithComputer();
    const orphan = await t.agentWithComputer();
    await t.agents.delete({ tenantId: "tenant-a", agentId: orphan.agentId }); // no cleanup hook ran
    const recent = await t.sessionWithBox({ idleDays: 1 });
    const stale = await t.sessionWithBox({ idleDays: 30 });
    const running = await t.sessionWithBox({ idleDays: 30, status: "running" });
    const deleted = await t.sessionWithBox({ idleDays: 30 });
    await t.sessions.delete({ tenantId: "tenant-a", sessionId: deleted.sessionId });
    const stranger = await t.fake.create({ labels: { purpose: "someone-elses-work" } });
    const otherDeployment = await t.fake.create({ labels: { "oma-session-id": "sess-elsewhere", "oma-deployment-id": "dep_elsewhere" } });
    const unproven = await t.fake.create({ labels: { "oma-session-id": "sess-unknown" } });

    const report = await t.sweeper.run();

    expect([...t.fake.deleteCalls].sort()).toEqual([orphan.boxId, stale.boxId, deleted.boxId].sort());
    for (const kept of [live.boxId, recent.boxId, running.boxId, stranger.id, otherDeployment.id, unproven.id]) {
      expect(t.fake.sandboxes.get(kept)?.state, kept).not.toBe("destroyed");
    }
    expect((await t.store.list()).map((m) => m.agentId)).toEqual([live.agentId]);
    expect(report.skipped).toEqual({ live: 3, not_oma: 1, other_deployment: 1, unproven_owner: 1 });
    expect(report.results.map((r) => [r.action.kind, r.action.reason, r.outcome]).sort()).toEqual([
      ["machine", "agent_missing", "deleted"],
      ["session_box", "session_idle", "deleted"],
      ["session_box", "session_missing", "deleted"],
    ]);

    // A second sweep finds nothing left to do.
    expect((await t.sweeper.run()).results).toEqual([]);
  });

  it("removes a machine row whose agent and box are both gone", async () => {
    const t = await setup();
    const orphan = await t.agentWithComputer();
    await t.agents.delete({ tenantId: "tenant-a", agentId: orphan.agentId });
    t.fake.vanish(orphan.boxId);
    await t.sweeper.run();
    expect(await t.store.list()).toEqual([]);
    expect(t.fake.deleteCalls).toEqual([]);
  });

  it("dry run reports what it would delete and deletes nothing", async () => {
    const t = await setup({ dryRun: true });
    const orphan = await t.agentWithComputer();
    await t.agents.delete({ tenantId: "tenant-a", agentId: orphan.agentId });
    const stale = await t.sessionWithBox({ idleDays: 30 });

    const report = await t.sweeper.run();

    expect(report.dryRun).toBe(true);
    expect(report.results.map((r) => r.outcome)).toEqual(["would_delete", "would_delete"]);
    expect(t.fake.deleteCalls).toEqual([]);
    expect(await t.store.list()).toHaveLength(1);
    expect(t.fake.sandboxes.get(stale.boxId)?.state).not.toBe("destroyed");
  });

  it("re-checks the database right before deleting", async () => {
    const t = await setup();
    const stale = await t.sessionWithBox({ idleDays: 30 });
    const lookups = sandboxSweepSqlLookups(t.sql);
    let calls = 0;
    const sweeper = new SandboxSweeper({
      inventory: new DaytonaBoxInventory({ apiKey: "test", daytonaModule: fakeDaytonaModule(t.fake) }),
      listMachines: () => t.store.list(),
      destroyMachine: async () => {},
      agentExists: lookups.agentExists,
      // The session becomes active between the plan and the delete.
      getSession: async (id) => {
        const session = await lookups.getSession(id);
        return ++calls > 1 && session ? { ...session, status: "running" } : session;
      },
      deploymentId: HERE,
      config: sandboxSweepConfigFromEnv({}),
    });

    const report = await sweeper.run();

    expect(report.results).toEqual([{ action: expect.objectContaining({ boxId: stale.boxId }), outcome: "kept" }]);
    expect(t.fake.deleteCalls).toEqual([]);
  });

  it("does not judge a box that was just created", async () => {
    const t = await setup();
    t.fake.now = () => Date.now() - 5 * 60_000;
    const orphanSession = await t.fake.create({ labels: { "oma-session-id": "sess-gone", "oma-deployment-id": HERE } });
    const report = await t.sweeper.run();
    expect(report.skipped).toEqual({ too_new: 1 });
    expect(t.fake.sandboxes.get(orphanSession.id)?.state).not.toBe("destroyed");
  });

  it("adopts unlabelled orphans only when the operator opted in", async () => {
    const t = await setup({ adoptUnlabelled: true });
    const legacy = await t.fake.create({ labels: { "oma-session-id": "sess-long-gone" } });
    const elsewhere = await t.fake.create({ labels: { "oma-session-id": "sess-elsewhere", "oma-deployment-id": "dep_elsewhere" } });
    await t.sweeper.run();
    expect(t.fake.deleteCalls).toEqual([legacy.id]);
    expect(t.fake.sandboxes.get(elsewhere.id)?.state).not.toBe("destroyed");
  });

  it("caps deletions per sweep and picks up the rest next time", async () => {
    const t = await setup({ maxDeletions: 2 });
    for (let i = 0; i < 3; i++) await t.sessionWithBox({ idleDays: 30 });
    const first = await t.sweeper.run();
    expect(first.results.map((r) => r.outcome).sort()).toEqual(["deferred", "deleted", "deleted"]);
    expect(t.fake.deleteCalls).toHaveLength(2);
    await t.sweeper.run();
    expect(t.fake.deleteCalls).toHaveLength(3);
  });

  it("keeps going when one delete fails, and retries it on the next sweep", async () => {
    const t = await setup();
    const a = await t.sessionWithBox({ idleDays: 30 });
    const b = await t.sessionWithBox({ idleDays: 30 });
    const realDelete = t.fake.delete.bind(t.fake);
    t.fake.delete = async (sb) => {
      if (sb.id === a.boxId) throw new FakeDaytonaHttpError("upstream unavailable", 503);
      return realDelete(sb);
    };

    const report = await t.sweeper.run();

    expect(report.results.map((r) => r.outcome).sort()).toEqual(["deleted", "failed"]);
    expect(t.fake.deleteCalls).toEqual([b.boxId]);
    t.fake.delete = realDelete;
    await t.sweeper.run();
    expect([...t.fake.deleteCalls].sort()).toEqual([a.boxId, b.boxId].sort());
  });

  it("deletes nothing when the provider or the database cannot be read", async () => {
    const t = await setup();
    await t.sessionWithBox({ idleDays: 30 });
    const failing = new SandboxSweeper({
      inventory: new DaytonaBoxInventory({ apiKey: "test", daytonaModule: fakeDaytonaModule(t.fake) }),
      listMachines: () => t.store.list(),
      destroyMachine: async () => {},
      agentExists: async () => true,
      getSession: async () => { throw new Error("database unavailable"); },
      deploymentId: HERE,
      config: sandboxSweepConfigFromEnv({}),
    });
    await expect(failing.run()).rejects.toThrow("database unavailable");

    const listFails = { list: vi.fn(async () => { throw new Error("provider unavailable"); }), delete: vi.fn() };
    const blind = new SandboxSweeper({
      inventory: listFails, listMachines: () => t.store.list(), destroyMachine: async () => {},
      ...sandboxSweepSqlLookups(t.sql), deploymentId: HERE, config: sandboxSweepConfigFromEnv({}),
    });
    await expect(blind.run()).rejects.toThrow("provider unavailable");
    expect(listFails.delete).not.toHaveBeenCalled();
    expect(t.fake.deleteCalls).toEqual([]);
  });

  it("joins a sweep that is already running instead of starting another", async () => {
    const t = await setup();
    await t.sessionWithBox({ idleDays: 30 });
    const [a, b] = await Promise.all([t.sweeper.run(), t.sweeper.run()]);
    expect(a).toBe(b);
    expect(t.fake.deleteCalls).toHaveLength(1);
  });
});

describe("sweep configuration", () => {
  it("defaults to an hourly, real, 7-day sweep that adopts nothing", () => {
    expect(sandboxSweepCronFromEnv({})).toBe(SANDBOX_SWEEP_DEFAULT_CRON);
    expect(SANDBOX_SWEEP_DEFAULT_CRON).toBe("17 * * * *");
    expect(sandboxSweepConfigFromEnv({})).toEqual({
      dryRun: false, sessionMaxAgeMs: 7 * DAY, minBoxAgeMs: 60 * 60_000, adoptUnlabelled: false, maxDeletions: 50,
    });
  });

  it("reads overrides and ignores nonsense rather than becoming more aggressive", () => {
    expect(sandboxSweepConfigFromEnv({
      SANDBOX_SWEEP_DRY_RUN: "true", SANDBOX_SWEEP_SESSION_MAX_AGE_DAYS: "14",
      SANDBOX_SWEEP_ADOPT_UNLABELLED: "1", SANDBOX_SWEEP_MAX_DELETIONS: "5",
    })).toMatchObject({ dryRun: true, sessionMaxAgeMs: 14 * DAY, adoptUnlabelled: true, maxDeletions: 5 });
    expect(sandboxSweepConfigFromEnv({
      SANDBOX_SWEEP_SESSION_MAX_AGE_DAYS: "0", SANDBOX_SWEEP_MAX_DELETIONS: "lots", SANDBOX_SWEEP_ADOPT_UNLABELLED: "maybe",
    })).toMatchObject({ sessionMaxAgeMs: 7 * DAY, maxDeletions: 50, adoptUnlabelled: false });
  });

  it("can be rescheduled or switched off", () => {
    expect(sandboxSweepCronFromEnv({ SANDBOX_SWEEP_CRON: "0 */6 * * *" })).toBe("0 */6 * * *");
    expect(sandboxSweepCronFromEnv({ SANDBOX_SWEEP_CRON: "off" })).toBeNull();
    expect(sandboxSweepCronFromEnv({ SANDBOX_SWEEP_CRON: " " })).toBe(SANDBOX_SWEEP_DEFAULT_CRON);
  });
});

describe("deployment identity", () => {
  it("generates an id once per database and keeps returning it", async () => {
    const { sql, cleanup } = await bootstrapTestDb();
    teardown.push(cleanup);
    const first = await resolveDeploymentIdentity({ sql, dialect: "sqlite", env: {} });
    const second = await resolveDeploymentIdentity({ sql, dialect: "sqlite", env: {} });
    expect(first).toEqual({ id: expect.stringMatching(/^dep_[0-9a-f]{16}$/), source: "database" });
    expect(second).toEqual(first);

    const other = await bootstrapTestDb();
    teardown.push(other.cleanup);
    expect((await resolveDeploymentIdentity({ sql: other.sql, dialect: "sqlite", env: {} })).id).not.toBe(first.id);
  });

  it("prefers a pinned OMA_DEPLOYMENT_ID and rejects an unusable one", async () => {
    const { sql, cleanup } = await bootstrapTestDb();
    teardown.push(cleanup);
    expect(await resolveDeploymentIdentity({ sql, dialect: "sqlite", env: { OMA_DEPLOYMENT_ID: " orrery-prod " } }))
      .toEqual({ id: "orrery-prod", source: "env" });
    await expect(resolveDeploymentIdentity({ sql, dialect: "sqlite", env: { OMA_DEPLOYMENT_ID: "has spaces" } }))
      .rejects.toThrow("OMA_DEPLOYMENT_ID");
  });
});

// ─── postgres (gated) ─────────────────────────────────────────────
//
// Skipped unless PG_TEST_URL is set (same convention as
// agent-machine-store.test.ts). Covers the two things that differ on
// postgres: the deployment-identity upsert and BIGINT epoch columns, which
// the driver returns as strings.

const PG_URL = process.env.PG_TEST_URL ?? "";
const pgEnabled = PG_URL.startsWith("postgres://") || PG_URL.startsWith("postgresql://");
const dpg = pgEnabled ? describe : describe.skip;

dpg("sandbox sweep lookups + deployment identity — postgres", () => {
  const tag = `sweep-${Date.now()}`;
  let pgSql: SqlClient;

  beforeAll(async () => {
    pgSql = await createPostgresSqlClient(PG_URL);
    // Column types as in migrations/0000_consolidated.sql; no-ops on a
    // database that already has the real tables.
    await pgSql.exec(`CREATE TABLE IF NOT EXISTS "agents" ("id" text PRIMARY KEY NOT NULL, "tenant_id" text NOT NULL, "config" text NOT NULL, "version" bigint NOT NULL, "created_at" bigint NOT NULL, "updated_at" bigint, "archived_at" bigint)`);
    await pgSql.exec(`CREATE TABLE IF NOT EXISTS "sessions" ("id" text PRIMARY KEY NOT NULL, "tenant_id" text NOT NULL, "agent_id" text, "environment_id" text, "status" text NOT NULL, "title" text, "vault_ids" text, "agent_snapshot" text, "environment_snapshot" text, "metadata" text, "turn_id" text, "turn_started_at" bigint, "created_at" bigint NOT NULL, "updated_at" bigint, "archived_at" bigint, "terminated_at" bigint)`);
  });

  afterAll(async () => {
    if (!pgSql) return;
    await pgSql.prepare(`DELETE FROM agents WHERE tenant_id = ?`).bind(tag).run();
    await pgSql.prepare(`DELETE FROM sessions WHERE tenant_id = ?`).bind(tag).run();
  });

  it("stores one deployment id and returns it on every boot", async () => {
    const first = await resolveDeploymentIdentity({ sql: pgSql, dialect: "postgres", env: {} });
    const [a, b] = await Promise.all([
      resolveDeploymentIdentity({ sql: pgSql, dialect: "postgres", env: {} }),
      resolveDeploymentIdentity({ sql: pgSql, dialect: "postgres", env: {} }),
    ]);
    expect(first.id).toMatch(/^dep_[0-9a-f]{16}$/);
    expect(a).toEqual(first);
    expect(b).toEqual(first);
  });

  it("looks agents up per tenant and reads session timestamps as numbers", async () => {
    const lookups = sandboxSweepSqlLookups(pgSql);
    const terminatedAt = 1_800_000_000_000; // beyond int4: must survive as a number
    await pgSql.prepare(`INSERT INTO agents (id, tenant_id, config, version, created_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(`${tag}-agent`, tag, "{}", 1, 1_700_000_000_000).run();
    await pgSql.prepare(`INSERT INTO sessions (id, tenant_id, status, created_at, updated_at, terminated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(`${tag}-sess`, tag, "terminated", 1_700_000_000_000, 1_750_000_000_000, terminatedAt).run();

    expect(await lookups.agentExists(tag, `${tag}-agent`)).toBe(true);
    expect(await lookups.agentExists("another-tenant", `${tag}-agent`)).toBe(false);
    expect(await lookups.agentExists(tag, "missing")).toBe(false);
    expect(await lookups.getSession(`${tag}-sess`)).toEqual({
      id: `${tag}-sess`, tenantId: tag, status: "terminated", lastActiveAtMs: terminatedAt,
    });
    expect(await lookups.getSession("missing")).toBeNull();
  });
});
