// Agent memory mode: turning memory on (store provisioned + mode pinned,
// idempotent), the ambient-rule default, and attaching the agent's store to
// its sessions. Real services over the consolidated SQLite schema.
//
// Prod 2026-11-10: a "Competitor watch" agent was told to remember what it
// reported; nothing could switch memory on, so a later session knew nothing.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  autoEnableMemoryForAmbientRule,
  buildAgentMemoryRoutes,
  describeAmbientMemory,
  describeMemoryEnabled,
  disableAgentMemory,
  enableAgentMemory,
  getAgentMemoryState,
  sharedStoreName,
} from "../src/lib/agent-memory-mode";
import { buildMemoryRig, TENANT, type MemoryRig } from "./_helpers/memory-rig";

let rig: MemoryRig;
beforeEach(async () => {
  rig = await buildMemoryRig();
});
afterEach(() => rig.cleanup());

const activeStores = () => rig.memoryService.listStores({ tenantId: TENANT, status: "active" });

describe("enableAgentMemory", () => {
  it("creates the agent's store, sets mode shared, and pins the store on the agent", async () => {
    const agent = await rig.createAgent();
    expect(agent.memory).toBeUndefined();

    const result = await enableAgentMemory(rig.deps, { tenantId: TENANT, agentId: agent.id });

    expect(result).toMatchObject({ enabled: true, mode: "shared", newly_enabled: true });
    const stores = await activeStores();
    expect(stores).toHaveLength(1);
    expect(stores[0].name).toBe(sharedStoreName(agent.id));
    expect(stores[0].description).toContain("Competitor watch");
    expect(result.store).toEqual({ id: stores[0].id, name: stores[0].name });
    const saved = await rig.agents.get({ tenantId: TENANT, agentId: agent.id });
    expect(saved?.memory).toEqual({ mode: "shared", store_id: stores[0].id });
  });

  it("is idempotent: a second call creates nothing and does not bump the agent version", async () => {
    const agent = await rig.createAgent();
    const first = await enableAgentMemory(rig.deps, { tenantId: TENANT, agentId: agent.id });
    const versionAfterFirst = (await rig.agents.get({ tenantId: TENANT, agentId: agent.id }))!.version;

    const second = await enableAgentMemory(rig.deps, { tenantId: TENANT, agentId: agent.id });

    expect(second.newly_enabled).toBe(false);
    expect(second.store).toEqual(first.store);
    expect(await activeStores()).toHaveLength(1);
    expect((await rig.agents.get({ tenantId: TENANT, agentId: agent.id }))!.version).toBe(versionAfterFirst);
  });

  it("adopts a same-named store instead of minting a second one (concurrent first use)", async () => {
    const agent = await rig.createAgent();
    const existing = await rig.memoryService.createStore({ tenantId: TENANT, name: sharedStoreName(agent.id) });

    const result = await enableAgentMemory(rig.deps, { tenantId: TENANT, agentId: agent.id });

    expect(result.store?.id).toBe(existing.id);
    expect(await activeStores()).toHaveLength(1);
  });

  it("re-enabling after an explicit off reuses the same store and its notes", async () => {
    const agent = await rig.createAgent();
    const on = await enableAgentMemory(rig.deps, { tenantId: TENANT, agentId: agent.id });

    const off = await disableAgentMemory(rig.deps, { tenantId: TENANT, agentId: agent.id });
    expect(off).toMatchObject({ enabled: false, mode: "off", explicit_off: true });
    expect(off.store?.id).toBe(on.store!.id);

    const again = await enableAgentMemory(rig.deps, { tenantId: TENANT, agentId: agent.id });
    expect(again.newly_enabled).toBe(true);
    expect(again.store?.id).toBe(on.store!.id);
    expect(await activeStores()).toHaveLength(1);
  });

  it("provisions a fresh store when the pinned one was archived", async () => {
    const agent = await rig.createAgent();
    const on = await enableAgentMemory(rig.deps, { tenantId: TENANT, agentId: agent.id });
    await rig.memoryService.archiveStore({ tenantId: TENANT, storeId: on.store!.id });

    const again = await enableAgentMemory(rig.deps, { tenantId: TENANT, agentId: agent.id });

    expect(again.store?.id).not.toBe(on.store!.id);
    expect((await rig.agents.get({ tenantId: TENANT, agentId: agent.id }))?.memory?.store_id).toBe(again.store!.id);
  });
});

describe("tool-result wording states only what is true", () => {
  it("says ON with the store when newly enabled, and 'already' on a repeat", async () => {
    const agent = await rig.createAgent();
    const first = describeMemoryEnabled(await enableAgentMemory(rig.deps, { tenantId: TENANT, agentId: agent.id }));
    expect(first).toContain("Memory is now ON for this agent.");
    expect(first).toContain(`Store "${sharedStoreName(agent.id)}" is attached read-write to every new working session (including scheduled runs)`);
    // The path differs per harness; the working session is told its own.
    expect(first).not.toContain("/mnt/memory");

    const second = describeMemoryEnabled(await enableAgentMemory(rig.deps, { tenantId: TENANT, agentId: agent.id }));
    expect(second).toContain("Memory was already ON for this agent — nothing changed.");
  });
});

describe("ambient-rule default", () => {
  it("switches memory on for an agent that never had it configured", async () => {
    const agent = await rig.createAgent();
    const r = await autoEnableMemoryForAmbientRule(rig.deps, { tenantId: TENANT, agentId: agent.id });
    expect(r.action).toBe("enabled");
    expect((await rig.agents.get({ tenantId: TENANT, agentId: agent.id }))?.memory?.mode).toBe("shared");
    expect(describeAmbientMemory(r)).toContain("Memory was switched ON automatically for this agent");
    expect(describeAmbientMemory(r)).toContain("each scheduled run is a fresh session");
  });

  it("reports already_on without changing anything when memory is on", async () => {
    const agent = await rig.createAgent();
    await enableAgentMemory(rig.deps, { tenantId: TENANT, agentId: agent.id });
    const r = await autoEnableMemoryForAmbientRule(rig.deps, { tenantId: TENANT, agentId: agent.id });
    expect(r.action).toBe("already_on");
    expect(await activeStores()).toHaveLength(1);
    expect(describeAmbientMemory(r)).toContain("Memory is ON for this agent");
  });

  it("never overrides an explicit off, and says runs will not remember", async () => {
    const agent = await rig.createAgent("Stateless pinger", { memory: { mode: "off" } });
    const r = await autoEnableMemoryForAmbientRule(rig.deps, { tenantId: TENANT, agentId: agent.id });
    expect(r.action).toBe("left_off");
    expect((await rig.agents.get({ tenantId: TENANT, agentId: agent.id }))?.memory).toEqual({ mode: "off" });
    expect(await activeStores()).toHaveLength(0);
    expect(describeAmbientMemory(r)).toContain("Memory is OFF for this agent");
    expect(describeAmbientMemory(r)).toContain("each scheduled run starts with no memory of earlier runs");
  });
});

describe("attaching the agent's store to sessions", () => {
  it("attaches nothing while memory is off (existing agents unchanged)", async () => {
    const agent = await rig.createAgent();
    const session = await rig.createSession(agent.id);
    expect(await rig.memoryStoreIdsOf(session.id)).toEqual([]);
    expect(await activeStores()).toHaveLength(0);
  });

  it("attaches the store read-write to every new working session, once", async () => {
    const agent = await rig.createAgent();
    const on = await enableAgentMemory(rig.deps, { tenantId: TENANT, agentId: agent.id });

    const a = await rig.createSession(agent.id);
    const b = await rig.createSession(agent.id);
    expect(await rig.memoryStoreIdsOf(a.id)).toEqual([on.store!.id]);
    expect(await rig.memoryStoreIdsOf(b.id)).toEqual([on.store!.id]);
    const [resource] = (await rig.sessions.listResourcesBySession({ sessionId: a.id })).map((r) => r.resource);
    expect(resource).toMatchObject({ type: "memory_store", access: "read_write" });

    // The hook running twice for one session must not double-attach.
    const snapshot = (await rig.agents.get({ tenantId: TENANT, agentId: agent.id }))!;
    await rig.attachAgentMemory({ tenantId: TENANT, sessionId: a.id, agentId: agent.id, agentSnapshot: snapshot });
    expect(await rig.memoryStoreIdsOf(a.id)).toEqual([on.store!.id]);
  });

  it("skips setup sessions", async () => {
    const agent = await rig.createAgent();
    await enableAgentMemory(rig.deps, { tenantId: TENANT, agentId: agent.id });
    const setup = await rig.createSession(agent.id, { oma_setup: true });
    expect(await rig.memoryStoreIdsOf(setup.id)).toEqual([]);
  });

  it("provisions and pins the store when the mode was set straight through the agents API", async () => {
    const agent = await rig.createAgent("API-configured", { memory: { mode: "shared" } });
    const session = await rig.createSession(agent.id);
    const [storeId] = await rig.memoryStoreIdsOf(session.id);
    expect(storeId).toBeTruthy();
    expect((await rig.agents.get({ tenantId: TENANT, agentId: agent.id }))?.memory).toEqual({
      mode: "shared",
      store_id: storeId,
    });
  });

  it("per_user gives each principal its own store and anonymous callers a separate bucket", async () => {
    const agent = await rig.createAgent("Per-user", { memory: { mode: "per_user" } });
    const snapshot = (await rig.agents.get({ tenantId: TENANT, agentId: agent.id }))!;
    const attachFor = async (principalId?: string) => {
      const { session } = await rig.sessions.create({
        tenantId: TENANT,
        agentId: agent.id,
        environmentId: "env_local_runtime",
        agentSnapshot: snapshot,
      });
      await rig.attachAgentMemory({
        tenantId: TENANT,
        sessionId: session.id,
        agentId: agent.id,
        agentSnapshot: snapshot,
        principalId,
      });
      return (await rig.memoryStoreIdsOf(session.id))[0];
    };
    const alice1 = await attachFor("user-alice");
    const alice2 = await attachFor("user-alice");
    const bob = await attachFor("user-bob");
    const anon = await attachFor(undefined);
    expect(alice2).toBe(alice1);
    expect(new Set([alice1, bob, anon]).size).toBe(3);
  });
});

describe("GET/PUT /v1/agents/:id/memory", () => {
  const app = () => {
    const a = new Hono<{ Variables: { tenant_id: string } }>();
    a.use("*", async (c, next) => {
      c.set("tenant_id", TENANT);
      await next();
    });
    a.route("/v1/agents", buildAgentMemoryRoutes({ memory: rig.deps }));
    return a;
  };
  const put = (agentId: string, body: unknown) =>
    app().request(`/v1/agents/${agentId}/memory`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("reports off for a new agent, then on with the store after the toggle", async () => {
    const agent = await rig.createAgent();
    const before = await (await app().request(`/v1/agents/${agent.id}/memory`)).json();
    expect(before).toMatchObject({ enabled: false, mode: "off", explicit_off: false, store: null });

    const res = await put(agent.id, { enabled: true });
    expect(res.status).toBe(200);
    const on = (await res.json()) as { enabled: boolean; store: { id: string; name: string; note_count: number } };
    expect(on.enabled).toBe(true);
    expect(on.store.name).toBe(sharedStoreName(agent.id));
    expect(on.store.note_count).toBe(0);
    expect(on).not.toHaveProperty("newly_enabled");

    await rig.memoryService.writeByPath({
      tenantId: TENANT,
      storeId: on.store.id,
      path: "reports/2026-11-10.md",
      content: "reported: competitor A launched X",
      actor: { type: "agent_session", id: "sess-1" },
    });
    const after = (await (await app().request(`/v1/agents/${agent.id}/memory`)).json()) as {
      store: { note_count: number; last_written_at: string | null };
    };
    expect(after.store.note_count).toBe(1);
    expect(after.store.last_written_at).toBeTruthy();
  });

  it("counts a file once when two writers indexed it under both path spellings", async () => {
    const agent = await rig.createAgent();
    const on = (await (await put(agent.id, { enabled: true })).json()) as { store: { id: string } };
    const content = "reported: competitor A launched X";
    await rig.memoryService.writeByPath({
      tenantId: TENANT,
      storeId: on.store.id,
      path: "reports/2026-11-10.md",
      content,
      actor: { type: "agent_session", id: "sess-1" },
    });
    // What the local fs watcher records for the same file.
    await rig.memoryRepo.upsertFromEvent({
      storeId: on.store.id,
      path: "/reports/2026-11-10.md",
      contentSha256: "sha",
      etag: "sha",
      sizeBytes: content.length,
      actor: { type: "agent_session", id: "fs-watcher" },
      nowMs: Date.now(),
      versionId: "memver-test",
      content,
    });
    const state = (await (await app().request(`/v1/agents/${agent.id}/memory`)).json()) as {
      store: { note_count: number };
    };
    expect(state.store.note_count).toBe(1);
  });

  it("turning it off is explicit and keeps the store", async () => {
    const agent = await rig.createAgent();
    await put(agent.id, { enabled: true });
    const off = (await (await put(agent.id, { enabled: false })).json()) as {
      enabled: boolean;
      explicit_off: boolean;
      store: { id: string } | null;
    };
    expect(off).toMatchObject({ enabled: false, explicit_off: true });
    expect(off.store).not.toBeNull();
    expect(await getAgentMemoryState(rig.deps, { tenantId: TENANT, agentId: agent.id })).toMatchObject({
      enabled: false,
      explicit_off: true,
    });
  });

  it("validates the body and 404s unknown agents", async () => {
    const agent = await rig.createAgent();
    expect((await put(agent.id, { enabled: "yes" })).status).toBe(400);
    expect((await put("agent-missing", { enabled: true })).status).toBe(404);
    expect((await app().request("/v1/agents/agent-missing/memory")).status).toBe(404);
  });
});
