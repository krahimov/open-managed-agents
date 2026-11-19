import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createInMemoryAmbientRuleService } from "@open-managed-agents/agents-store/test-fakes";
import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";
import { buildAgentRoutes } from "../../../packages/http-routes/src/agents";
import type { RouteServices } from "../../../packages/http-routes/src/types";

async function fixture(opts?: { runScheduleRuleNow?: (input: any) => Promise<{ session_id: string | null }> }) {
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
  app.route("/v1/agents", buildAgentRoutes({
    services, sessionsApp: () => inner,
    ...(opts?.runScheduleRuleNow ? { runScheduleRuleNow: opts.runScheduleRuleNow } : {}),
  }));
  };
  restart();
  const path = `/v1/agents/a1/ambient-rules/${rule.id}/events`;
  const post = (eventId = "incident-1", data: unknown = { window_id: "w05" }, tenant = "t1") => app.request(path, {
    method: "POST", headers: { "content-type": "application/json", "x-tenant": tenant },
    body: JSON.stringify({ event_id: eventId, data }),
  });
  const update = (input: any) => ambientRules.update({ tenantId: "t1", agentId: "a1", ruleId: rule.id, input });
  const run = (body?: unknown) => app.request(`/v1/agents/a1/ambient-rules/${rule.id}/run`, {
    method: "POST", headers: { "content-type": "application/json", "x-tenant": "t1" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const getRule = () => ambientRules.get({ tenantId: "t1", agentId: "a1", ruleId: rule.id });
  return { post, run, update, getRule, rule, created, messages, sessions, restart, failSend: () => { failSend = true; } };
}

describe("ambient webhook", () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => { f = await fixture(); });
  it("creates a normal session, carries provenance, and deduplicates persistent event IDs", async () => {
    expect((await f.post()).status).toBe(202);
    expect(f.created[0]).toMatchObject({ agent: "a1", metadata: { ambient: { source_event_id: "incident-1" } } });
    // A distinct title per delivery, named by its event.
    expect(f.created[0].title).toBe("Regression · incident-1");
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

describe("ambient webhook attribution", () => {
  it("marks the wake message as sent by the rule, keeping the prompt in the log", async () => {
    const f = await fixture();
    expect((await f.post()).status).toBe(202);
    const event = f.messages[0].events[0];
    expect(event.type).toBe("user.message");
    expect(event.content[0].text).toContain("[Ambient webhook: Regression]");
    expect(event.metadata).toMatchObject({
      kind: "ambient_wake",
      ambient: { rule_id: f.rule.id, rule_name: "Regression", source: "webhook", event_id: "incident-1", wake_mode: "act" },
    });
    expect(event.metadata.ambient.manual).toBeUndefined();
    expect(f.created[0].metadata.ambient).toMatchObject({ rule_name: "Regression", source: "webhook" });
  });
});

describe("POST …/ambient-rules/:ruleId/run", () => {
  it("sends a webhook rule a test event with a generated event_id and the given data", async () => {
    const f = await fixture();
    const res = await f.run({ data: { window_id: "w09" } });
    expect(res.status).toBe(202);
    const out = await res.json() as { event_id: string; session_id: string };
    expect(out.session_id).toBe("s1");
    expect(out.event_id).toMatch(/^test-[0-9a-f]{12}$/);
    expect(f.created[0].title).toBe(`Regression · ${out.event_id}`);
    const event = f.messages[0].events[0];
    expect(event.content[0].text).toContain('"window_id":"w09"');
    expect(event.metadata.ambient).toMatchObject({ manual: true, event_id: out.event_id, source: "webhook" });
    expect((await f.getRule())?.last_decision).toMatchObject({ outcome: "create_session", session_id: "s1" });
  });

  it("accepts an empty body and is idempotent on a given event_id", async () => {
    const f = await fixture();
    expect((await f.run()).status).toBe(202);
    f.sessions.get("s1").completed = true;
    expect((await f.run({ event_id: "demo-1" })).status).toBe(202);
    const again = await f.run({ event_id: "demo-1" });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ duplicate: true, session_id: "s2" });
    expect(f.created).toHaveLength(2);
  });

  it("is held to the rule's budget", async () => {
    const f = await fixture();
    expect((await f.run()).status).toBe(202);
    // One run at a time by default: the first has not finished yet.
    const busy = await f.run();
    expect(busy.status).toBe(429);
    expect((await busy.json() as { error: string }).error).toMatch(/run budget/);
  });

  it("refuses a paused rule, bad input, and sources nothing fires", async () => {
    const f = await fixture();
    expect((await f.run({ data: "nope" })).status).toBe(400);
    expect((await f.run(["x"])).status).toBe(400);
    await f.update({ enabled: false });
    expect((await f.run()).status).toBe(409);
    await f.update({ enabled: true, trigger: { source: "slack", config: {} } });
    expect((await f.run()).status).toBe(409);
    expect(f.created).toHaveLength(0);
  });

  it("answers 501 for a schedule rule where no schedule dispatcher is wired (Cloudflare)", async () => {
    const f = await fixture();
    await f.update({ trigger: { source: "schedule", config: { cron: "0 9 * * *" } } });
    expect((await f.run()).status).toBe(501);
  });

  it("runs a schedule rule through the dispatcher, leaving its cadence", async () => {
    const calls: any[] = [];
    const f = await fixture({
      runScheduleRuleNow: async (input) => { calls.push(input); return { session_id: "sess_sched" }; },
    });
    await f.update({ trigger: { source: "schedule", config: { cron: "0 9 * * *", timezone: "UTC" } } });
    const armed = (await f.getRule())?.next_wake_at;
    const res = await f.run();
    expect(res.status).toBe(202);
    const out = await res.json() as { event_id: string; session_id: string };
    expect(out.session_id).toBe("sess_sched");
    expect(out.event_id).toMatch(/^run-[0-9a-f]{12}$/);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ tenantId: "t1", runId: out.event_id, rule: { id: f.rule.id } });
    expect((await f.getRule())?.next_wake_at).toBe(armed);
    // Schedule rules take no event data.
    expect((await f.run({ data: { a: 1 } })).status).toBe(400);
  });

  it("frees the slot of a run that failed after its session exists once that session settles", async () => {
    let attempt = 0;
    const f = await fixture({
      runScheduleRuleNow: async () => {
        attempt++;
        if (attempt === 1) {
          f.sessions.set("sess_failed", { id: "sess_failed", status: "idle", completed: false });
          throw Object.assign(new Error("append failed"), { session_id: "sess_failed" });
        }
        return { session_id: `sess_ok${attempt}` };
      },
    });
    await f.update({ trigger: { source: "schedule", config: { cron: "0 9 * * *" } } });
    const failed = await f.run();
    expect(failed.status).toBe(502);
    expect((await failed.json() as { session_id: string }).session_id).toBe("sess_failed");
    // The message may have landed: the slot stays taken while that session could still run…
    expect((await f.run()).status).toBe(429);
    // …and frees once it has settled, instead of blocking Run now for good.
    f.sessions.get("sess_failed").completed = true;
    expect((await f.run()).status).toBe(202);
  });

  it("counts the schedule's own running sweep run toward one-at-a-time", async () => {
    const f = await fixture({ runScheduleRuleNow: async () => ({ session_id: "sess_manual" }) });
    f.sessions.set("sess_sweep", { id: "sess_sweep", status: "running", completed: false });
    await f.update({
      trigger: { source: "schedule", config: { cron: "0 * * * *" } },
      last_decision: { outcome: "create_session", decided_at: new Date().toISOString(), session_id: "sess_sweep" },
    });
    const busy = await f.run();
    expect(busy.status).toBe(429);
    f.sessions.set("sess_sweep", { id: "sess_sweep", status: "idle", completed: true });
    expect((await f.run()).status).toBe(202);
    // A rule's last decision that is a Run now (already tracked) is not counted twice.
    await f.update({ budget: { max_concurrent_sessions: 2 },
      last_decision: { outcome: "create_session", decided_at: new Date().toISOString(), session_id: "sess_manual" } });
    f.sessions.set("sess_manual", { id: "sess_manual", status: "running", completed: false });
    expect((await f.run()).status).toBe(202);
  });

  it("frees the slot when a schedule run fails before any session exists", async () => {
    let fail = true;
    const f = await fixture({
      runScheduleRuleNow: async () => {
        if (fail) throw new Error("environment unavailable");
        return { session_id: "sess_ok" };
      },
    });
    await f.update({ trigger: { source: "schedule", config: { cron: "0 9 * * *" } } });
    const res = await f.run();
    expect(res.status).toBe(502);
    expect((await res.json() as { error: string }).error).toMatch(/environment unavailable/);
    fail = false;
    expect((await f.run()).status).toBe(202);
  });
});
