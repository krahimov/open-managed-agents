// Deleting an agent's computer (AgentMachineManager.destroy) and the guard
// that stops a deleted agent's leftover session from provisioning a new one.

import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentMachineManager } from "../src/machines/manager";
import { AgentDeletedError, InMemoryAgentMachineStore } from "../src/machines/ports";
import type { AgentMachineSpec } from "../src/machines/ports";
import { FakeDaytona, FakeDaytonaHttpError, fakeDaytonaModule } from "./fake-daytona";

const spec: AgentMachineSpec = {
  image: "node:22-bookworm", workdir: "/workspace", aptPackages: [],
  bootstrapTools: false, browser: false, idleStopMinutes: 30, sdkMode: "tools_only",
};
const managers: AgentMachineManager[] = [];
afterEach(async () => { await Promise.all(managers.splice(0).map((m) => m.dispose())); });

function fixture(opts: { deploymentId?: string; agentExists?: (tenantId: string, agentId: string) => Promise<boolean> } = {}) {
  const store = new InMemoryAgentMachineStore();
  const fake = new FakeDaytona();
  const warn = vi.fn();
  const manager = new AgentMachineManager({
    store, daytonaModule: fakeDaytonaModule(fake), apiKey: "test", tickIntervalMs: 0,
    bootstrap: async () => {}, logger: { warn }, ...opts,
  });
  managers.push(manager);
  const acquire = (tenantId = "tenant-a", agentId = "agent-a") =>
    manager.provider({ tenantId, agentId, sessionId: `sess-${tenantId}-${agentId}`, spec }).acquire();
  return { store, fake, manager, acquire, warn };
}

describe("AgentMachineManager.destroy", () => {
  it("deletes the provider box, the row and its attachments", async () => {
    const { manager, acquire, fake, store } = fixture();
    const box = await acquire();
    const row = (await manager.get("tenant-a", "agent-a"))!;
    expect(await store.liveAttachments(row.id, Date.now())).toHaveLength(1);

    const result = await manager.destroy("tenant-a", "agent-a");

    expect(result).toEqual({ machineId: row.id, providerRefs: [box.sb.id] });
    expect(fake.deleteCalls).toEqual([box.sb.id]);
    expect(await manager.get("tenant-a", "agent-a")).toBeNull();
    expect(await store.liveAttachments(row.id, Date.now())).toEqual([]);
    // The audit trail outlives the row.
    expect((await store.listEvents(row.id))[0]).toMatchObject({ kind: "deleted", detail: { reason: "agent_deleted", provider_refs: [box.sb.id] } });
  });

  it("is idempotent: no computer, or a second call, is a no-op", async () => {
    const { manager, acquire, fake } = fixture();
    expect(await manager.destroy("tenant-a", "agent-a")).toEqual({ machineId: null, providerRefs: [] });
    await acquire();
    await manager.destroy("tenant-a", "agent-a");
    expect(await manager.destroy("tenant-a", "agent-a")).toEqual({ machineId: null, providerRefs: [] });
    expect(fake.deleteCalls).toHaveLength(1);
  });

  it("tolerates a box the provider already deleted", async () => {
    const { manager, acquire, fake } = fixture();
    const box = await acquire();
    fake.vanish(box.sb.id);
    await expect(manager.destroy("tenant-a", "agent-a")).resolves.toMatchObject({ providerRefs: [] });
    expect(await manager.get("tenant-a", "agent-a")).toBeNull();
  });

  it("tolerates a box that disappears between lookup and delete", async () => {
    const { manager, acquire, fake } = fixture();
    const box = await acquire();
    fake.delete = async () => { throw new FakeDaytonaHttpError(`Sandbox with ID ${box.sb.id} not found`, 404); };
    await expect(manager.destroy("tenant-a", "agent-a")).resolves.toMatchObject({ providerRefs: [box.sb.id] });
    expect(await manager.get("tenant-a", "agent-a")).toBeNull();
  });

  it("keeps the row, marked deleting, when the provider is down — and a retry finishes the job", async () => {
    const { manager, acquire, fake, store } = fixture();
    const box = await acquire();
    const realDelete = fake.delete.bind(fake);
    fake.delete = async () => { throw new FakeDaytonaHttpError("upstream unavailable", 503); };

    await expect(manager.destroy("tenant-a", "agent-a")).rejects.toThrow("upstream unavailable");

    const row = (await manager.get("tenant-a", "agent-a"))!;
    expect(row).toMatchObject({ state: "deleting", desiredState: "stopped", providerRef: box.sb.id, errorCount: 1 });
    expect(row.errorReason).toContain("upstream unavailable");
    expect((await store.listEvents(row.id))[0]).toMatchObject({ kind: "delete_failed" });
    expect(fake.sandboxes.get(box.sb.id)?.state).not.toBe("destroyed");

    fake.delete = realDelete;
    await manager.destroy("tenant-a", "agent-a");
    expect(fake.deleteCalls).toEqual([box.sb.id]);
    expect(await manager.get("tenant-a", "agent-a")).toBeNull();
  });

  it("only deletes the named tenant's computer", async () => {
    const { manager, acquire, fake } = fixture();
    const a = await acquire("tenant-a", "agent-a");
    const b = await acquire("tenant-b", "agent-a");
    await manager.destroy("tenant-b", "agent-a");
    expect(fake.deleteCalls).toEqual([b.sb.id]);
    expect((await manager.get("tenant-a", "agent-a"))?.providerRef).toBe(a.sb.id);
  });

  it("also removes a box whose id was lost in a crash, found by its labels", async () => {
    const { manager, acquire, fake, store } = fixture();
    const box = await acquire();
    const row = (await manager.get("tenant-a", "agent-a"))!;
    await store.update(row.id, { providerRef: null }, Date.now());
    await manager.destroy("tenant-a", "agent-a");
    expect(fake.deleteCalls).toEqual([box.sb.id]);
  });

  it("leaves a recorded box that does not carry this machine's labels", async () => {
    const { manager, acquire, fake, warn } = fixture();
    const box = await acquire();
    await box.sb.setLabels({ "oma-machine-id": "someone-else", "oma-tenant-id": "tenant-a" });
    await manager.destroy("tenant-a", "agent-a");
    expect(fake.deleteCalls).toEqual([]);
    expect(await manager.get("tenant-a", "agent-a")).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("leaving it"), undefined);
  });

  it("leaves a box claimed by another deployment", async () => {
    const { manager, acquire, fake } = fixture({ deploymentId: "dep_here" });
    const box = await acquire();
    await box.sb.setLabels({ ...box.sb.labels, "oma-deployment-id": "dep_elsewhere" });
    await manager.destroy("tenant-a", "agent-a");
    expect(fake.deleteCalls).toEqual([]);
  });
});

describe("agent machines of a deleted agent", () => {
  it("does not create a computer for an agent that no longer exists", async () => {
    const exists = vi.fn(async () => false);
    const { acquire, fake, manager } = fixture({ agentExists: exists });
    await expect(acquire()).rejects.toBeInstanceOf(AgentDeletedError);
    expect(fake.createCalls).toEqual([]);
    expect(await manager.get("tenant-a", "agent-a")).toBeNull();
    expect(exists).toHaveBeenCalledWith("tenant-a", "agent-a");
  });

  it("does not re-create the computer after it was destroyed with its agent", async () => {
    let alive = true;
    const { acquire, fake, manager } = fixture({ agentExists: async () => alive });
    await acquire();
    alive = false;
    await manager.destroy("tenant-a", "agent-a");
    await expect(acquire()).rejects.toMatchObject({ code: "agent_deleted" });
    expect(fake.createCalls).toHaveLength(1);
  });

  it("does not resume a computer whose deletion is pending a retry", async () => {
    const { acquire, fake, manager } = fixture();
    await acquire();
    fake.delete = async () => { throw new FakeDaytonaHttpError("upstream unavailable", 503); };
    await expect(manager.destroy("tenant-a", "agent-a")).rejects.toThrow();
    await expect(acquire()).rejects.toBeInstanceOf(AgentDeletedError);
    expect((await manager.get("tenant-a", "agent-a"))?.state).toBe("deleting");
  });

  it("keeps serving an existing computer without asking whether the agent exists", async () => {
    const exists = vi.fn(async () => true);
    const { acquire } = fixture({ agentExists: exists });
    await acquire();
    exists.mockClear();
    await acquire();
    expect(exists).not.toHaveBeenCalled();
  });
});

describe("deployment label on agent machines", () => {
  it("stamps new boxes with the deployment id", async () => {
    const { acquire, fake } = fixture({ deploymentId: "dep_here" });
    await acquire();
    expect(fake.createCalls[0]).toMatchObject({
      labels: { "oma-tenant-id": "tenant-a", "oma-agent-id": "agent-a", "oma-deployment-id": "dep_here" },
    });
  });

  it("claims an older unlabelled box it owns, and never re-labels a claimed one", async () => {
    const legacy = fixture();
    const box = await legacy.acquire();
    expect(box.sb.labels?.["oma-deployment-id"]).toBeUndefined();

    const upgraded = new AgentMachineManager({
      store: legacy.store, daytonaModule: fakeDaytonaModule(legacy.fake), apiKey: "test", tickIntervalMs: 0,
      bootstrap: async () => {}, deploymentId: "dep_here",
    });
    managers.push(upgraded);
    const again = await upgraded.acquire({ tenantId: "tenant-a", agentId: "agent-a", spec });
    expect(again.sb.id).toBe(box.sb.id);
    expect(again.sb.labels).toMatchObject({ "oma-machine-id": expect.any(String), "oma-tenant-id": "tenant-a", "oma-deployment-id": "dep_here" });

    const other = new AgentMachineManager({
      store: legacy.store, daytonaModule: fakeDaytonaModule(legacy.fake), apiKey: "test", tickIntervalMs: 0,
      bootstrap: async () => {}, deploymentId: "dep_other",
    });
    managers.push(other);
    await other.acquire({ tenantId: "tenant-a", agentId: "agent-a", spec });
    expect(again.sb.labels?.["oma-deployment-id"]).toBe("dep_here");
  });
});
