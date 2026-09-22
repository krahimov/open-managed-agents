import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createInMemoryAmbientRuleService } from "@open-managed-agents/agents-store/test-fakes";
import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";
import { buildAgentRoutes } from "../../../packages/http-routes/src/agents";
import type { RouteServices } from "../../../packages/http-routes/src/types";

async function fixture() {
  const sql = await createBetterSqlite3SqlClient(":memory:");
  const { service: ambientRules } = createInMemoryAmbientRuleService();
  const rule = await ambientRules.create({ tenantId: "t1", agentId: "a1", input: {
    name: "Regression", trigger: { source: "webhook", config: { prompt: "Inspect the window." } }, wake_mode: "act",
  } });
  const created: any[] = [];
  const messages: any[] = [];
  const sessions = new Map<string, any>();
  let failSend = false;
  const inner = new Hono();
  inner.post("/", async (c) => {
    expect(c.get("tenant_id" as never)).toBe("t1");
    created.push(await c.req.json());
    const session = { id: `s${created.length}`, status: "idle", completed: false };
    sessions.set(session.id, session);
    return c.json(session, 201);
  });
  inner.post("/:id/events", async (c) => {
    messages.push(await c.req.json());
    if (failSend) return c.json({ error: "ambiguous dispatch" }, 500);
    return c.body(null, 202);
  });
  inner.get("/:id/events", (c) => c.json({ data: [
    { type: sessions.get(c.req.param("id"))?.completed ? "session.status_idle" : "user.message" },
  ] }));
  const services = {
    sql, ambientRules,
    agents: { get: async ({ tenantId, agentId }: any) => tenantId === "t1" && agentId === "a1" ? { id: "a1" } : null },
    sessions: { get: async ({ sessionId }: any) => sessions.get(sessionId) ?? null },
  } as unknown as RouteServices;
  let app: Hono;
  const restart = () => {
  app = new Hono();
  app.use("*", async (c, next) => { c.set("tenant_id" as never, (c.req.header("x-tenant") ?? "t1") as never); await next(); });
  app.route("/v1/agents", buildAgentRoutes({ services, sessionsApp: () => inner }));
  };
  restart();
  const path = `/v1/agents/a1/ambient-rules/${rule.id}/events`;
  const post = (eventId = "incident-1", data: unknown = { window_id: "w05" }, tenant = "t1") => app.request(path, {
    method: "POST", headers: { "content-type": "application/json", "x-tenant": tenant },
    body: JSON.stringify({ event_id: eventId, data }),
  });
  const update = (input: any) => ambientRules.update({ tenantId: "t1", agentId: "a1", ruleId: rule.id, input });
  return { post, update, created, messages, sessions, restart, failSend: () => { failSend = true; } };
}

describe("ambient webhook", () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => { f = await fixture(); });
  it("creates a normal session, carries provenance, and deduplicates persistent event IDs", async () => {
    expect((await f.post()).status).toBe(202);
    expect(f.created[0]).toMatchObject({ agent: "a1", metadata: { ambient: { source_event_id: "incident-1" } } });
    expect(f.messages[0].events[0].content[0].text).toContain('"window_id":"w05"');
    f.restart();
    expect((await f.post()).status).toBe(200);
    expect((await f.post("incident-1", { window_id: "w06" })).status).toBe(409);
    expect(f.created).toHaveLength(1);
  });
  it("enforces tenant, enabled rule, source and input validation", async () => {
    expect((await f.post("x", {}, "t2")).status).toBe(404);
    expect((await f.post("", {})).status).toBe(400);
    expect((await f.post("x", "no")).status).toBe(400);
    expect((await f.post("x", { data: "x".repeat(65536) })).status).toBe(413);
    await f.update({ enabled: false });
    expect((await f.post()).status).toBe(409);
    await f.update({ enabled: true, trigger: { source: "schedule" } });
    expect((await f.post()).status).toBe(409);
    expect(f.created).toHaveLength(0);
  });
  it("records observe without running and refuses unsupported approval policies", async () => {
    await f.update({ wake_mode: "observe" });
    expect((await f.post()).status).toBe(202);
    expect(f.created).toHaveLength(0);
    await f.update({ wake_mode: "act", decision_policy: { approval: "required_before_action" } });
    expect((await f.post("new")).status).toBe(422);
  });
  it("serializes concurrent admission and releases slots only after completion", async () => {
    const responses = await Promise.all([f.post("one"), f.post("two"), f.post("three")]);
    expect(responses.map((r) => r.status).sort()).toEqual([202, 429, 429]);
    expect((await f.post("four")).status).toBe(429);
    f.sessions.get("s1").completed = true;
    expect((await f.post("four")).status).toBe(202);
    expect(f.created).toHaveLength(2);
  });
  it("enforces the daily limit even after a session finishes", async () => {
    await f.update({ budget: { max_runs_per_day: 1, max_concurrent_sessions: 1 } });
    expect((await f.post()).status).toBe(202);
    f.sessions.get("s1").completed = true;
    expect((await f.post("tomorrow")).status).toBe(429);
    expect((await f.post()).status).toBe(200);
  });
  it("does not repeat execution after ambiguous dispatch failure", async () => {
    f.failSend();
    expect((await f.post()).status).toBe(502);
    expect((await f.post()).status).toBe(409);
    expect(f.messages).toHaveLength(1);
    expect((await f.post("new")).status).toBe(429);
  });
});
