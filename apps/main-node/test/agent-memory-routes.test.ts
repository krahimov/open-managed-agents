// `_oma.memory` on the agents API, and the memory default for ambient rules
// created over REST (the console's Ambient panel) — the same default the
// create_ambient_rule tool applies.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { buildAgentRoutes } from "@open-managed-agents/http-routes";
import { autoEnableMemoryForAmbientRule } from "../src/lib/agent-memory-mode";
import { buildMemoryRig, TENANT, type MemoryRig } from "./_helpers/memory-rig";

let rig: MemoryRig;
let app: Hono<{ Variables: { tenant_id: string } }>;

beforeEach(async () => {
  rig = await buildMemoryRig();
  app = new Hono<{ Variables: { tenant_id: string } }>();
  app.use("*", async (c, next) => {
    c.set("tenant_id", TENANT);
    await next();
  });
  app.route(
    "/v1/agents",
    buildAgentRoutes({
      services: { agents: rig.agents, sessions: rig.sessions, ambientRules: rig.ambientRules } as never,
      onAmbientRuleCreated: async ({ tenantId, agentId }) => {
        await autoEnableMemoryForAmbientRule(rig.deps, { tenantId, agentId });
      },
    }),
  );
});
afterEach(() => rig.cleanup());

const json = (method: string, path: string, body: unknown) =>
  app.request(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

type AgentBody = { id: string; version: number; _oma?: { memory?: { mode: string; store_id?: string } } };

describe("_oma.memory on the agents API", () => {
  it("is absent by default, persists on create and update, and is returned under _oma", async () => {
    const created = (await (await json("POST", "/v1/agents", { name: "a", model: "m" })).json()) as AgentBody;
    expect(created._oma?.memory).toBeUndefined();
    expect(created).not.toHaveProperty("memory");

    const withMode = (await (
      await json("POST", "/v1/agents", { name: "b", model: "m", _oma: { memory: { mode: "shared" } } })
    ).json()) as AgentBody;
    expect(withMode._oma?.memory).toEqual({ mode: "shared" });

    const res = await json("PUT", `/v1/agents/${created.id}`, { _oma: { memory: { mode: "off" } } });
    expect(res.status).toBe(200);
    const updated = (await (await app.request(`/v1/agents/${created.id}`)).json()) as AgentBody;
    expect(updated._oma?.memory).toEqual({ mode: "off" });
  });

  it("rejects malformed memory blocks", async () => {
    const bad = async (memory: unknown) =>
      (await json("POST", "/v1/agents", { name: "x", model: "m", _oma: { memory } })).status;
    expect(await bad({ mode: "always" })).toBe(400);
    expect(await bad("on")).toBe(400);
    expect(await bad({ mode: "shared", store_id: "" })).toBe(400);
    expect(await bad({ mode: "per_user", store_id: "memstore-1" })).toBe(400);
    // "off" may keep its store pinned (that is how re-enabling finds the notes).
    expect(await bad({ mode: "off", store_id: "memstore-1" })).toBe(201);
  });
});

describe("POST /v1/agents/:id/ambient-rules", () => {
  const rule = {
    name: "Monday brief",
    trigger: { source: "schedule", config: { cron: "0 9 * * 1", prompt: "Produce this week's brief." } },
    wake_mode: "act",
  };

  it("switches memory on for an agent that never had it configured", async () => {
    const agent = await rig.createAgent();
    const res = await json("POST", `/v1/agents/${agent.id}/ambient-rules`, rule);
    expect(res.status).toBe(201);
    const saved = await rig.agents.get({ tenantId: TENANT, agentId: agent.id });
    expect(saved?.memory?.mode).toBe("shared");
    expect(saved?.memory?.store_id).toBeTruthy();
    // A scheduled run's session then carries the store.
    const run = await rig.createSession(agent.id);
    expect(await rig.memoryStoreIdsOf(run.id)).toEqual([saved!.memory!.store_id]);
  });

  it("leaves an explicit off alone", async () => {
    const agent = await rig.createAgent("Stateless", { memory: { mode: "off" } });
    expect((await json("POST", `/v1/agents/${agent.id}/ambient-rules`, rule)).status).toBe(201);
    expect((await rig.agents.get({ tenantId: TENANT, agentId: agent.id }))?.memory).toEqual({ mode: "off" });
  });

  it("a failing hook does not fail the rule create", async () => {
    const failing = new Hono<{ Variables: { tenant_id: string } }>();
    failing.use("*", async (c, next) => {
      c.set("tenant_id", TENANT);
      await next();
    });
    failing.route(
      "/v1/agents",
      buildAgentRoutes({
        services: { agents: rig.agents, sessions: rig.sessions, ambientRules: rig.ambientRules } as never,
        onAmbientRuleCreated: async () => {
          throw new Error("memory service down");
        },
      }),
    );
    const agent = await rig.createAgent();
    const res = await failing.request(`/v1/agents/${agent.id}/ambient-rules`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(rule),
    });
    expect(res.status).toBe(201);
    expect(await rig.ambientRules.listByAgent({ tenantId: TENANT, agentId: agent.id })).toHaveLength(1);
  });
});
