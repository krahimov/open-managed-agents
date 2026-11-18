// What happens to a session's own Daytona sandbox when the session is
// deleted — the label rules (pure), the hook over the real account inventory,
// and SessionRegistry.destroy after a server restart, with only Daytona faked.

import { afterEach, describe, expect, it, vi } from "vitest";
import { generateEventId, type SessionEvent } from "@open-managed-agents/shared";
import { SqlEventLog, ensureSchema as ensureEventLogSchema } from "@open-managed-agents/event-log/sql";
import type { SandboxExecutor } from "@open-managed-agents/sandbox";
import type { SandboxOrchestrator } from "@open-managed-agents/sandbox/orchestrator";
import { DaytonaBoxInventory, type ProviderBox } from "@open-managed-agents/sandbox/adapters/daytona-inventory";
import { createSqliteAgentService } from "@open-managed-agents/agents-store";
import { createSqliteSessionService } from "@open-managed-agents/sessions-store";
import { createSqliteMemoryStoreService } from "@open-managed-agents/memory-store";
import { FakeDaytona, FakeDaytonaHttpError, fakeDaytonaModule } from "../../../packages/sandbox/tests/fake-daytona";
import { SessionRegistry } from "../src/registry";
import { createSessionSandboxCleanup, planSessionBoxDeletion } from "../src/lib/session-sandbox-cleanup";
import { bootstrapTestDb } from "./_helpers/bootstrap-test-db";

const HERE = "dep_here";
const TENANT = "tenant-a";
const teardown: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const fn of teardown.splice(0).reverse()) await fn(); });

let seq = 0;
function box(labels: Record<string, string>, extra: Partial<ProviderBox> = {}): ProviderBox {
  return { id: `box-${++seq}`, state: "started", labels, createdAtMs: Date.now(), ...extra };
}
const target = { tenantId: TENANT, sessionId: "sess-1", deploymentId: HERE };

describe("planSessionBoxDeletion", () => {
  it("deletes this session's boxes, pinning the labels the decision relied on", () => {
    const labelled = box({ "oma-session-id": "sess-1", "oma-tenant-id": TENANT, "oma-deployment-id": HERE });
    const preLabel = box({ "oma-session-id": "sess-1" });
    expect(planSessionBoxDeletion([labelled, preLabel], target)).toEqual({
      deletes: [
        {
          boxId: labelled.id,
          expectLabels: { "oma-session-id": "sess-1", "oma-tenant-id": TENANT, "oma-machine-id": null, "oma-deployment-id": HERE },
        },
        { boxId: preLabel.id, expectLabels: { "oma-session-id": "sess-1", "oma-machine-id": null, "oma-deployment-id": null } },
      ],
      skipped: [],
    });
  });

  it("never touches an agent computer, another deployment's or another tenant's box", () => {
    const computer = box({ "oma-session-id": "sess-1", "oma-machine-id": "amch-1", "oma-tenant-id": TENANT, "oma-deployment-id": HERE });
    const foreign = box({ "oma-session-id": "sess-1", "oma-tenant-id": TENANT, "oma-deployment-id": "dep_elsewhere" });
    const otherTenant = box({ "oma-session-id": "sess-1", "oma-tenant-id": "tenant-b", "oma-deployment-id": HERE });
    const deleting = box({ "oma-session-id": "sess-1", "oma-deployment-id": HERE }, { state: "destroying" });
    const otherSession = box({ "oma-session-id": "sess-2", "oma-deployment-id": HERE });
    expect(planSessionBoxDeletion([computer, foreign, otherTenant, deleting, otherSession], target)).toEqual({
      deletes: [],
      skipped: [
        { boxId: computer.id, reason: "agent_computer" },
        { boxId: foreign.id, reason: "other_deployment" },
        { boxId: otherTenant.id, reason: "label_mismatch" },
        { boxId: deleting.id, reason: "deleting" },
      ],
    });
  });
});

function setupCleanup(opts: { waitMs?: number } = {}) {
  const fake = new FakeDaytona();
  const inventory = new DaytonaBoxInventory({ apiKey: "test", daytonaModule: fakeDaytonaModule(fake) });
  const cleanup = createSessionSandboxCleanup({ inventory, deploymentId: HERE, waitMs: opts.waitMs });
  return { fake, inventory, cleanup };
}

describe("createSessionSandboxCleanup", () => {
  it("deletes only the deleted session's own boxes", async () => {
    const { fake, cleanup } = setupCleanup();
    const mine = await fake.create({ labels: { "oma-session-id": "sess-1", "oma-tenant-id": TENANT, "oma-deployment-id": HERE } });
    const preRestart = await fake.create({ labels: { "oma-session-id": "sess-1", "oma-tenant-id": TENANT } });
    const computer = await fake.create({
      labels: { "oma-machine-id": "amch-1", "oma-tenant-id": TENANT, "oma-agent-id": "agent-a", "oma-deployment-id": HERE },
    });
    const foreign = await fake.create({ labels: { "oma-session-id": "sess-1", "oma-deployment-id": "dep_elsewhere" } });
    const sibling = await fake.create({ labels: { "oma-session-id": "sess-2", "oma-tenant-id": TENANT, "oma-deployment-id": HERE } });
    const unrelated = await fake.create({ labels: { team: "data" } });

    await cleanup.onSessionDeleted(TENANT, "sess-1");

    expect(fake.deleteCalls.sort()).toEqual([mine.id, preRestart.id].sort());
    for (const sb of [computer, foreign, sibling, unrelated]) expect(sb.state).not.toBe("destroyed");
  });

  it("never rejects: a provider failure is logged and left to the sweeper", async () => {
    const { fake, inventory, cleanup } = setupCleanup();
    const a = await fake.create({ labels: { "oma-session-id": "sess-1", "oma-deployment-id": HERE } });
    const b = await fake.create({ labels: { "oma-session-id": "sess-1", "oma-deployment-id": HERE } });
    const realDelete = fake.delete.bind(fake);
    fake.delete = async (sb, timeout) => {
      if (sb.id === a.id) throw new FakeDaytonaHttpError("upstream unavailable", 503);
      return realDelete(sb, timeout);
    };
    await expect(cleanup.onSessionDeleted(TENANT, "sess-1")).resolves.toBeUndefined();
    expect(a.state).not.toBe("destroyed");
    expect(b.state).toBe("destroyed");

    vi.spyOn(inventory, "list").mockRejectedValueOnce(new Error("socket hang up"));
    await expect(cleanup.onSessionDeleted(TENANT, "sess-1")).resolves.toBeUndefined();
  });

  it("does not hold the request longer than waitMs", async () => {
    const { inventory, cleanup } = setupCleanup({ waitMs: 20 });
    vi.spyOn(inventory, "list").mockReturnValue(new Promise(() => {}));
    const started = Date.now();
    await cleanup.onSessionDeleted(TENANT, "sess-1");
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("SessionRegistry.destroy", () => {
  async function setupRegistry(opts: { withCleanup?: boolean; buildSandbox?: () => Promise<SandboxExecutor> } = {}) {
    const { sql, db, cleanup: dropDb } = await bootstrapTestDb();
    teardown.push(dropDb);
    await ensureEventLogSchema(sql);
    const agents = createSqliteAgentService({ db });
    const sessions = createSqliteSessionService({ db });
    const { fake, cleanup } = setupCleanup();
    const agent = await agents.create({ tenantId: TENANT, input: { name: "agent", model: "test-model", tools: [] } });
    const { session } = await sessions.create({
      tenantId: TENANT, agentId: agent.id, environmentId: "env-1", vaultIds: [], title: "s",
      agentSnapshot: agent, environmentSnapshot: { id: "env-1", runtime: "local", sandbox_template: null } as never,
    });
    // Built the way main-node builds it at boot: a fresh process holds no
    // sandbox for any session.
    const registry = new SessionRegistry({
      sql,
      hub: { attach: () => () => {}, publish: () => {}, closeSession: () => {} } as never,
      agentsService: agents,
      sessionsService: sessions,
      memoryService: createSqliteMemoryStoreService({ db }),
      sandboxOrchestrator: noopOrchestrator,
      newEventLog: (sessionId) =>
        new SqlEventLog(sql, sessionId, (event: SessionEvent) => {
          (event as { id?: string }).id ??= generateEventId();
        }),
      buildSandbox: opts.buildSandbox ?? (async () => noopSandbox),
      ...(opts.withCleanup === false ? {} : { deleteSessionBoxes: cleanup.onSessionDeleted }),
      sandboxWorkdirRoot: "/tmp/oma-session-cleanup-test",
      buildModel: async () => ({}) as never,
      buildTools: async () => ({}),
      buildHarness: () => ({ run: async () => {} }),
      buildHarnessContext: async (input) => input,
    });
    const sessionBox = () =>
      fake.create({ labels: { "oma-session-id": session.id, "oma-tenant-id": TENANT, "oma-deployment-id": HERE } });
    return { registry, fake, sessionId: session.id, sessionBox };
  }

  it("frees the session's box after a restart, when no sandbox is held in memory", async () => {
    const { registry, fake, sessionId, sessionBox } = await setupRegistry();
    const sb = await sessionBox(); // created by the process before the restart
    const computer = await fake.create({
      labels: { "oma-machine-id": "amch-1", "oma-tenant-id": TENANT, "oma-agent-id": "agent-a", "oma-deployment-id": HERE },
    });

    await registry.destroy(sessionId);

    expect(fake.deleteCalls).toEqual([sb.id]);
    expect(computer.state).not.toBe("destroyed");
  });

  it("also frees a pre-restart box the session replaced, after tearing down the live one", async () => {
    let fake!: FakeDaytona;
    let live: Awaited<ReturnType<FakeDaytona["create"]>> | null = null;
    const destroyLive = vi.fn(async () => { if (live) await fake.delete(live); });
    const setup = await setupRegistry({ buildSandbox: async () => ({ ...noopSandbox, destroy: destroyLive }) });
    fake = setup.fake;
    const old = await setup.sessionBox();
    await setup.registry.getOrCreate(setup.sessionId, TENANT);
    live = await setup.sessionBox();

    await setup.registry.destroy(setup.sessionId);

    expect(destroyLive).toHaveBeenCalledTimes(1);
    expect(fake.deleteCalls.sort()).toEqual([live.id, old.id].sort());
  });

  it("is a no-op for provider boxes when the install has no provider account", async () => {
    const { registry, fake, sessionId, sessionBox } = await setupRegistry({ withCleanup: false });
    const sb = await sessionBox();
    await registry.destroy(sessionId);
    expect(fake.deleteCalls).toEqual([]);
    expect(sb.state).not.toBe("destroyed");
  });
});

const noopOrchestrator: SandboxOrchestrator = {
  capabilities: () => ({}) as never,
  provision: async () => {},
  snapshotWorkspaceNow: async () => null,
  renewActivityTimeout: async () => {},
};

const noopSandbox: SandboxExecutor = {
  exec: async () => "",
  readFile: async () => "",
  writeFile: async () => "",
};
