// @ts-nocheck
// Budgets on the Cloudflare runtime (SessionDO, docs/budgets.md):
//   - a harness-written budget marker becomes the turn's
//     stop_reason { type: "budget_exhausted", ... }
//   - span.model_request_end usage lands in model_usage_events (tenant D1)
//     and is served by GET /v1/sessions/:id/usage
//   - max_turn_wall_clock_seconds aborts the turn via the thread abort
//     controller and ends it cleanly (cut-off tool call closed, no error)
//   - metadata.budget is validated on agent create
import { env, exports } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { registerHarness } from "../../apps/agent/src/harness/registry";
import { budgetWarningEvent } from "@open-managed-agents/session-runtime";

registerHarness("budget-marker", () => ({
  async run(ctx) {
    ctx.runtime.broadcast({ type: "span.model_request_start", id: "mrs_budget_1", model: "claude-sonnet-4-6" });
    ctx.runtime.broadcast({
      type: "span.model_request_end",
      model: "claude-sonnet-4-6",
      model_request_start_id: "mrs_budget_1",
      model_usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      cost_usd: 0.0045,
      finish_reason: "tool-calls",
      is_error: false,
    });
    await ctx.runtime.persist(
      budgetWarningEvent({ type: "budget_exhausted", budget: "max_tokens_per_turn", limit: 1500, used: 1100 }),
    );
  },
}));

registerHarness("budget-hang", () => ({
  async run(ctx) {
    await ctx.runtime.persist({ type: "agent.tool_use", id: "tc_hang", name: "bash", input: { command: "sleep 600" } });
    await new Promise((_, reject) => {
      const s = ctx.runtime.abortSignal;
      if (s.aborted) reject(s.reason);
      s.addEventListener("abort", () => reject(s.reason), { once: true });
    });
  },
}));

const H = { "x-api-key": "test-key", "Content-Type": "application/json" };
const api = (path: string, init?: RequestInit) => exports.default.fetch(new Request(`http://localhost${path}`, init));
const post = (path: string, body: unknown) => api(path, { method: "POST", headers: H, body: JSON.stringify(body) });

async function createSession(harness: string, metadata?: Record<string, unknown>) {
  const a = await post("/v1/agents", {
    name: `Budget-${harness}-${Date.now()}-${Math.random()}`,
    model: "claude-sonnet-4-6",
    _oma: { harness },
    ...(metadata ? { metadata } : {}),
  });
  expect(a.status).toBe(201);
  const e = await post("/v1/environments", { name: `env-${Date.now()}`, config: { type: "cloud" } });
  const s = await post("/v1/sessions", { agent: ((await a.json()) as any).id, environment_id: ((await e.json()) as any).id });
  return ((await s.json()) as any).id as string;
}

async function replay(sessionId: string, waitMs = 150): Promise<any[]> {
  const stub = env.SESSION_DO!.get(env.SESSION_DO!.idFromName(sessionId));
  const res = await stub.fetch(new Request("http://internal/ws", { headers: { Upgrade: "websocket", "x-oma-replay": "1", "x-oma-include": "chunks" } }));
  const ws = res.webSocket!;
  ws.accept();
  const events: any[] = [];
  return new Promise((resolve) => {
    ws.addEventListener("message", (m) => events.push(JSON.parse(m.data as string)));
    setTimeout(() => {
      ws.close();
      resolve(events);
    }, waitMs);
  });
}

async function waitForIdleEvent(sessionId: string, maxMs = 6000): Promise<any[]> {
  for (let waited = 0; waited < maxMs; waited += 250) {
    await new Promise((r) => setTimeout(r, 250));
    const evs = await replay(sessionId, 50);
    if (evs.some((e) => e.type === "session.status_idle")) return evs;
  }
  return replay(sessionId);
}

const send = (sessionId: string) =>
  post(`/v1/sessions/${sessionId}/events`, { events: [{ type: "user.message", content: [{ type: "text", text: "go" }] }] });

describe("budgets on SessionDO", () => {
  it("rejects an invalid metadata.budget on agent create", async () => {
    const res = await post("/v1/agents", {
      name: `Budget-bad-${Date.now()}`,
      model: "claude-sonnet-4-6",
      metadata: { budget: { max_tokens_per_turn: -1 } },
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toMatch(/max_tokens_per_turn/);
  });

  it("ends the turn with stop_reason budget_exhausted and records usage rows", async () => {
    const sessionId = await createSession("budget-marker", { budget: { max_tokens_per_turn: 1500 } });
    await send(sessionId);
    const events = await waitForIdleEvent(sessionId);
    const idle = events.filter((e) => e.type === "session.status_idle").at(-1);
    expect(idle.stop_reason).toEqual({ type: "budget_exhausted", budget: "max_tokens_per_turn", limit: 1500, used: 1100 });
    expect(events.find((e) => e.type === "session.warning" && e.source === "budget_exhausted")).toBeTruthy();

    let report: any = null;
    for (let i = 0; i < 20; i++) {
      const res = await api(`/v1/sessions/${sessionId}/usage`, { headers: H });
      expect(res.status).toBe(200);
      report = await res.json();
      if (report.totals.model_calls > 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(report.totals).toMatchObject({ model_calls: 1, input_tokens: 1000, output_tokens: 100, total_tokens: 1100, cost_usd: 0.0045 });
    expect(report.budget).toEqual({ max_tokens_per_turn: 1500 });
  });

  it("aborts a turn on max_turn_wall_clock_seconds without an error", async () => {
    const sessionId = await createSession("budget-hang", { budget: { max_turn_wall_clock_seconds: 0.3 } });
    await send(sessionId);
    const events = await waitForIdleEvent(sessionId);
    const idle = events.filter((e) => e.type === "session.status_idle").at(-1);
    expect(idle.stop_reason).toMatchObject({ type: "budget_exhausted", budget: "max_turn_wall_clock_seconds", limit: 0.3 });
    expect(events.find((e) => e.type === "agent.tool_result" && e.tool_use_id === "tc_hang")).toMatchObject({ is_error: true });
    expect(events.some((e) => e.type === "session.error")).toBe(false);
    expect(events.find((e) => e.type === "session.warning" && e.source === "budget_exhausted")).toBeTruthy();
  });
});
