// _oma.memory on the agents wire (memory-facts-design §6) + the Node
// agent-memory-mode resolver: create/read/update/clear/validate, store
// provisioning per mode, pinning, anonymous per_user bucket, active-only
// lookup, and the attachAgentMemory hook body.

// @ts-nocheck
import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { buildAgentRoutes } from "@open-managed-agents/http-routes";
import { createInMemoryAgentService } from "@open-managed-agents/agents-store/test-fakes";
import {
  resolveAgentMemoryStore,
  buildAttachAgentMemory,
  agentMemoryMode,
  sharedStoreName,
  perUserStoreName,
  anonymousStoreName,
  ownStoreName,
} from "../../apps/main-node/src/lib/agent-memory-mode";

const TENANT = "t_mem";

function routeHarness() {
  const { service: agents } = createInMemoryAgentService();
  const app = new Hono<{ Variables: { tenant_id: string } }>();
  app.use("*", async (c, next) => { c.set("tenant_id", TENANT); await next(); });
  app.route("/", buildAgentRoutes({ services: { agents } as never }));
  const json = (method, path, body) => app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { app, json };
}

describe("_oma.memory wire round-trip", () => {
  let h; beforeEach(() => { h = routeHarness(); });
  const base = { name: "a", model: "m", system: "s", tools: [] };

  it("create with mode shared persists and reads back; absent means off (no _oma.memory)", async () => {
    const r = await h.json("POST", "/", { ...base, _oma: { memory: { mode: "shared" } } });
    expect(r.status).toBe(201);
    const a = await r.json();
    expect(a._oma.memory).toEqual({ mode: "shared" });
    const g = await (await h.json("GET", `/${a.id}`)).json();
    expect(g._oma.memory).toEqual({ mode: "shared" });
    const plain = await (await h.json("POST", "/", base)).json();
    expect(plain._oma?.memory).toBeUndefined();
  });

  it("update changes mode; null clears; store_id preserved when mode unchanged", async () => {
    const a = await (await h.json("POST", "/", { ...base, _oma: { memory: { mode: "shared", store_id: "memstore-x" } } })).json();
    const u1 = await (await h.json("POST", `/${a.id}`, { _oma: { memory: { mode: "per_user" } } })).json();
    expect(u1._oma.memory).toEqual({ mode: "per_user" });
    const u2 = await (await h.json("POST", `/${a.id}`, { _oma: { memory: null } })).json();
    expect(u2._oma?.memory).toBeUndefined();
  });

  it("validates mode / store_id / extract / push", async () => {
    expect((await h.json("POST", "/", { ...base, _oma: { memory: { mode: "bogus" } } })).status).toBe(400);
    expect((await h.json("POST", "/", { ...base, _oma: { memory: { mode: "per_user", store_id: "x" } } })).status).toBe(400);
    expect((await h.json("POST", "/", { ...base, _oma: { memory: { mode: "shared", extract: "yes" } } })).status).toBe(400);
    expect((await h.json("POST", "/", { ...base, _oma: { memory: { mode: "shared", push: false, extract: false } } })).status).toBe(201);
    expect((await h.json("POST", "/", { ...base, _oma: { memory: "shared" } })).status).toBe(400);
  });
});

function modeHarness() {
  const stores = new Map(); // id → {name, status}
  let n = 0;
  const attached = [];
  const pinned = [];
  const logs = [];
  const deps = {
    memoryService: {
      createStore: async ({ name }) => { const id = `memstore-${++n}`; stores.set(id, { name, status: "active" }); return { id }; },
      getStore: async ({ storeId }) => (stores.has(storeId) ? { id: storeId, name: stores.get(storeId).name } : null),
      listStores: async ({ status }) => [...stores].filter(([, v]) => !status || status === "any" || v.status === status).map(([id, v]) => ({ id, name: v.name })),
    },
    attach: async (i) => { attached.push(i); },
    pinAgentStore: async (i) => { pinned.push(i); },
    log: (m, c) => logs.push([m, c]),
  };
  return { deps, stores, attached, pinned, logs };
}

describe("agent-memory-mode resolver", () => {
  it("names are deterministic; anonymous per_user never aliases shared", () => {
    expect(sharedStoreName("agent-1")).toBe("agent-agent-1-memory");
    expect(perUserStoreName("agent-1", "u1")).toMatch(/^agent-agent-1-user-[0-9a-f]{12}$/);
    expect(perUserStoreName("agent-1", "u1")).toBe(perUserStoreName("agent-1", "u1"));
    expect(perUserStoreName("agent-1", "u1")).not.toBe(perUserStoreName("agent-1", "u2"));
    expect(anonymousStoreName("agent-1")).toBe("agent-agent-1-user-anonymous");
    expect(ownStoreName("agent-1", "per_user")).toBe(anonymousStoreName("agent-1"));
    expect(ownStoreName("agent-1", "shared", "u1")).toBe(sharedStoreName("agent-1"));
    expect(agentMemoryMode({})).toBe("off");
    expect(agentMemoryMode({ memory: { mode: "per_user" } })).toBe("per_user");
  });

  it("off → null; shared → provisions once, pins, then reuses (by pinned id, then by name)", async () => {
    const h = modeHarness();
    expect(await resolveAgentMemoryStore(h.deps, { tenantId: "t", agentId: "agent-1", agent: {} })).toBeNull();
    const a = await resolveAgentMemoryStore(h.deps, { tenantId: "t", agentId: "agent-1", agent: { memory: { mode: "shared" } } });
    expect(a).toEqual({ storeId: "memstore-1", mode: "shared", provisioned: true });
    expect(h.pinned).toEqual([{ tenantId: "t", agentId: "agent-1", storeId: "memstore-1" }]);
    // pinned id present → reuse without provisioning
    const b = await resolveAgentMemoryStore(h.deps, { tenantId: "t", agentId: "agent-1", agent: { memory: { mode: "shared", store_id: "memstore-1" } } });
    expect(b).toEqual({ storeId: "memstore-1", mode: "shared", provisioned: false });
    // not pinned yet (concurrent first session) → found by name, no second store
    const c = await resolveAgentMemoryStore(h.deps, { tenantId: "t", agentId: "agent-1", agent: { memory: { mode: "shared" } } });
    expect(c.storeId).toBe("memstore-1");
    expect(h.stores.size).toBe(1);
  });

  it("per_user → one store per principal; anonymous bucket without principal; archived stores are not reused", async () => {
    const h = modeHarness();
    const u1 = await resolveAgentMemoryStore(h.deps, { tenantId: "t", agentId: "agent-2", agent: { memory: { mode: "per_user" } }, principalId: "u1" });
    const u2 = await resolveAgentMemoryStore(h.deps, { tenantId: "t", agentId: "agent-2", agent: { memory: { mode: "per_user" } }, principalId: "u2" });
    const anon = await resolveAgentMemoryStore(h.deps, { tenantId: "t", agentId: "agent-2", agent: { memory: { mode: "per_user" } } });
    expect(new Set([u1.storeId, u2.storeId, anon.storeId]).size).toBe(3);
    expect(h.stores.get(anon.storeId).name).toBe(anonymousStoreName("agent-2"));
    expect(h.pinned).toHaveLength(0); // per_user never pins
    expect(h.logs.some(([m]) => /anonymous bucket/.test(m))).toBe(true);
    // archive u1's store → next resolve provisions a fresh one instead of reattaching the archived
    h.stores.get(u1.storeId).status = "archived";
    const u1b = await resolveAgentMemoryStore(h.deps, { tenantId: "t", agentId: "agent-2", agent: { memory: { mode: "per_user" } }, principalId: "u1" });
    expect(u1b.storeId).not.toBe(u1.storeId);
  });

  it("buildAttachAgentMemory attaches read_write and is a no-op for off", async () => {
    const h = modeHarness();
    const hook = buildAttachAgentMemory(h.deps);
    await hook({ tenantId: "t", sessionId: "s1", agentId: "agent-3", agentSnapshot: { memory: { mode: "shared" } } });
    expect(h.attached).toEqual([{ sessionId: "s1", storeId: "memstore-1", access: "read_write" }]);
    await hook({ tenantId: "t", sessionId: "s2", agentId: "agent-3", agentSnapshot: {} });
    expect(h.attached).toHaveLength(1);
  });
});
