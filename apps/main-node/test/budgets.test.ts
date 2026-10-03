// Budgets + model usage recording on the Node runtime (docs/budgets.md).
//
// Production path end to end: SessionStateMachine → NodeHarnessRuntime
// (SqlEventLog) → DefaultHarness / PiHarness, with NodeModelUsage writing
// model_usage_events through the real migrations. SQLite always; Postgres
// too when PG_TEST_URL is set (fresh database per run recommended).

import { afterAll, describe, expect, it, vi } from "vitest";
import { tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createPostgresSqlClient, type SqlClient } from "@open-managed-agents/sql-client";
import {
  SqlEventLog,
  SqlStreamRepo,
  ensureSchema as ensureEventLogSchema,
} from "@open-managed-agents/event-log/sql";
import { RuntimeAdapterImpl, SessionStateMachine } from "@open-managed-agents/session-runtime";
import type { AgentConfig, SessionEvent, UserMessageEvent } from "@open-managed-agents/shared";
import type { SandboxExecutor } from "@open-managed-agents/sandbox";
import { DefaultHarness } from "../../agent/src/harness/default-loop";
import { PiHarness, type ResolvedPiModel } from "../../agent/src/harness/pi/index";
import { resetInflightToolCallsForTest } from "../../agent/src/harness/durable-tools";
import { InProcessEventStreamHub } from "../src/lib/event-stream-hub";
import { NodeHarnessRuntime } from "../src/lib/node-harness-runtime";
import { NodeModelUsage, resolveNodeBudgetConfig, type NodeBudgetConfig } from "../src/lib/node-model-usage";
import { bootstrapTestDb } from "./_helpers/bootstrap-test-db";

type Ev = Record<string, any>;

// ─── backends ────────────────────────────────────────────────────────────

const PG_URL = process.env.PG_TEST_URL ?? "";
const pgEnabled = PG_URL.startsWith("postgres://") || PG_URL.startsWith("postgresql://");
const cleanups: Array<() => Promise<void> | void> = [];
afterAll(async () => {
  for (const c of cleanups) await c();
});

let pgReady: Promise<SqlClient> | null = null;
async function pgBackend(): Promise<SqlClient> {
  pgReady ??= (async () => {
    const postgres = (await import("postgres")).default;
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    const client = postgres(PG_URL, { max: 1, onnotice: () => {} });
    await migrate(drizzle(client as never) as never, {
      migrationsFolder: new URL("../migrations", import.meta.url).pathname,
    });
    await client.end();
    const sql = await createPostgresSqlClient(PG_URL);
    await ensureEventLogSchema(sql, "postgres");
    return sql;
  })();
  return pgReady;
}

async function backend(kind: "sqlite" | "postgres"): Promise<{ sql: SqlClient; dialect: "sqlite" | "postgres" }> {
  if (kind === "postgres") return { sql: await pgBackend(), dialect: "postgres" };
  const db = await bootstrapTestDb();
  cleanups.push(db.cleanup);
  await ensureEventLogSchema(db.sql, "sqlite");
  return { sql: db.sql, dialect: "sqlite" };
}

// ─── pipeline ────────────────────────────────────────────────────────────

const sandbox: SandboxExecutor = { exec: async () => "", readFile: async () => "", writeFile: async () => "" };
let seq = 0;

function agentWith(budget?: Record<string, number>, harness?: string): AgentConfig {
  return {
    id: "agent_budget",
    name: "budget agent",
    model: "claude-sonnet-4-6",
    system: "",
    tools: [],
    ...(harness ? { harness } : {}),
    metadata: budget ? { budget } : {},
  } as unknown as AgentConfig;
}

async function pipeline(opts: {
  kind: "sqlite" | "postgres";
  agent: AgentConfig;
  harness: { run: (ctx: unknown) => Promise<void> };
  model?: unknown;
  tools?: Record<string, unknown>;
  config?: Partial<NodeBudgetConfig>;
  abortGraceMs?: number;
}) {
  const { sql, dialect } = await backend(opts.kind);
  const sid = `sess_budget_${Date.now()}_${++seq}`;
  const tenantId = `tn_budget_${sid}`;
  const log = new SqlEventLog(sql, sid, (e) => {
    const ev = e as Ev;
    ev.id ??= `sevt_${Math.random().toString(36).slice(2)}`;
    ev.processed_at ??= new Date().toISOString();
  });
  const hub = new InProcessEventStreamHub();
  const usage = new NodeModelUsage(sql, {
    tenantDailyTokens: null,
    tenantDailyCostUsd: null,
    pricing: null,
    ...opts.config,
  });
  const state = { agent: opts.agent };
  const machine = new SessionStateMachine({
    sessionId: sid,
    tenantId,
    adapter: new RuntimeAdapterImpl({ sql, eventLog: log, streams: new SqlStreamRepo(sql, sid, dialect), sandbox }),
    sandbox,
    loadAgent: async () => state.agent,
    buildTools: async () => opts.tools ?? {},
    buildModel: async () => (opts.model ?? {}) as never,
    buildHarness: () => opts.harness,
    buildHarnessContext: async (input) => {
      let hooks: Awaited<ReturnType<NodeModelUsage["prepareRun"]>> | null = null;
      const runtime = new NodeHarnessRuntime({
        sessionId: sid,
        log: input.eventLog as SqlEventLog,
        hub,
        sandbox,
        abortSignal: input.abortSignal,
        onPersisted: (e) => hooks?.onPersisted(e),
      });
      await runtime.refreshHistory();
      hooks = await usage.prepareRun({
        tenantId,
        sessionId: sid,
        agentId: input.agent.id,
        events: runtime.history.getEvents(),
      });
      return {
        agent: input.agent,
        userMessage: input.userMessage,
        session_id: sid,
        tenant_id: tenantId,
        tools: input.tools,
        model: input.model,
        systemPrompt: "Test agent.",
        env: { ANTHROPIC_API_KEY: "" },
        budget: hooks.budget,
        runtime,
      };
    },
    publish: () => {},
    abortGraceMs: opts.abortGraceMs ?? 300,
  });
  let turn = 0;
  const send = (text = "go") =>
    machine.runTurn(state.agent.id, {
      type: "user.message",
      id: `u_${sid}_${++turn}`,
      content: [{ type: "text", text }],
    } as UserMessageEvent);
  const events = async () => (await log.getEventsAsync()) as Ev[];
  const rows = async () =>
    (
      await sql
        .prepare(
          `SELECT model_request_start_id, turn_id, agent_id, model, input_tokens, output_tokens, cost_usd
             FROM model_usage_events WHERE session_id = ? ORDER BY id`,
        )
        .bind(sid)
        .all<Ev>()
    ).results ?? [];
  return { sql, sid, tenantId, machine, send, events, rows, usage, state };
}

const lastIdle = (evs: Ev[]) => evs.filter((e) => e.type === "session.status_idle").at(-1);
const spans = (evs: Ev[]) => evs.filter((e) => e.type === "span.model_request_end");

// ─── default harness (AI SDK) ────────────────────────────────────────────

const USAGE = { inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 100, text: 100, reasoning: 0 } };
function stream(parts: unknown[]) {
  return new ReadableStream({ start(c) { parts.forEach((p) => c.enqueue(p)); c.close(); } });
}
/** Every call: 1000 input + 100 output tokens. `final(n)` decides when the
 *  model answers with text instead of calling `bash` again. */
function scriptedModel(final: (call: number) => boolean = () => false) {
  let call = 0;
  const model = new MockLanguageModelV3({
    modelId: "claude-sonnet-4-6",
    doStream: async () => {
      const n = ++call;
      return {
        stream: stream(
          final(n)
            ? [
                { type: "stream-start", warnings: [] },
                { type: "text-start", id: `t${n}` },
                { type: "text-delta", id: `t${n}`, delta: `answer ${n}` },
                { type: "text-end", id: `t${n}` },
                { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: USAGE },
              ]
            : [
                { type: "stream-start", warnings: [] },
                { type: "tool-call", toolCallId: `call_${n}_${Math.random().toString(36).slice(2, 6)}`, toolName: "bash", input: '{"command":"ls"}' },
                { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage: USAGE },
              ],
        ),
      };
    },
  });
  return { model, calls: () => call };
}
const bashTool = () => ({ bash: tool({ inputSchema: z.object({ command: z.string() }), execute: async () => "ok" }) });

const kinds: Array<"sqlite" | "postgres"> = pgEnabled ? ["sqlite", "postgres"] : ["sqlite"];

describe.each(kinds)("model usage recording (%s)", (kind) => {
  it("records one row per model call with tokens, cost and turn id; no budget → end_turn", async () => {
    resetInflightToolCallsForTest();
    const m = scriptedModel((n) => n === 3);
    const p = await pipeline({ kind, agent: agentWith(), harness: new DefaultHarness(), model: m.model, tools: bashTool() });
    const r = await p.send();
    expect(r.stopReason).toEqual({ type: "end_turn" });
    expect(m.calls()).toBe(3);
    const evs = await p.events();
    expect(spans(evs).map((s) => s.cost_usd)).toEqual([0.0045, 0.0045, 0.0045]);
    const rows = await p.rows();
    expect(rows).toHaveLength(3);
    const turnInput = evs.find((e) => e.type === "user.message")!.id;
    for (const row of rows) {
      expect(row).toMatchObject({
        turn_id: turnInput,
        agent_id: "agent_budget",
        model: "claude-sonnet-4-6",
        input_tokens: 1000,
        output_tokens: 100,
      });
      expect(Number(row.cost_usd)).toBeCloseTo(0.0045, 9);
    }
    expect(rows.map((x) => x.model_request_start_id).sort()).toEqual(spans(evs).map((s) => s.model_request_start_id).sort());

    const report = await p.usage.store.sessionReport(p.tenantId, p.sid);
    expect(report.totals).toMatchObject({ model_calls: 3, total_tokens: 3300, unpriced_calls: 0 });
    expect(report.totals.cost_usd).toBeCloseTo(0.0135, 9);
  });

  it("a lost row write is backfilled from the log once, never double counted", async () => {
    resetInflightToolCallsForTest();
    const m = scriptedModel((n) => n % 2 === 0);
    const p = await pipeline({ kind, agent: agentWith(), harness: new DefaultHarness(), model: m.model, tools: bashTool() });
    // The first row insert "crashes" (process died between the span persist and the insert).
    const record = p.usage.store.record.bind(p.usage.store);
    const spy = vi.spyOn(p.usage.store, "record").mockImplementationOnce(async () => {
      throw new Error("simulated crash before the usage row was written");
    });
    await p.send();
    expect(await p.rows()).toHaveLength(1);
    spy.mockImplementation(record);

    // Next turn (= the resumed/next run) backfills from the log, then records its own calls.
    await p.send();
    const evs = await p.events();
    expect(spans(evs)).toHaveLength(4);
    expect(await p.rows()).toHaveLength(4);
    // Replaying the whole log again (another resume) inserts nothing.
    expect(await p.usage.store.recordFromEvents(evs as SessionEvent[], { tenantId: p.tenantId, sessionId: p.sid })).toBe(0);
    // Duplicate hook delivery of the same span is a no-op too.
    const hooks = await p.usage.prepareRun({ tenantId: p.tenantId, sessionId: p.sid, agentId: "agent_budget", events: evs as SessionEvent[] });
    await hooks.onPersisted(spans(evs)[0] as SessionEvent);
    expect(await p.rows()).toHaveLength(4);
  });
});

describe("budgets — default harness", () => {
  it("max_tokens_per_turn stops before the call that would exceed it", async () => {
    resetInflightToolCallsForTest();
    const m = scriptedModel();
    const p = await pipeline({ kind: "sqlite", agent: agentWith({ max_tokens_per_turn: 3000 }), harness: new DefaultHarness(), model: m.model, tools: bashTool() });
    const r = await p.send();
    // 1100 + 1100 used; the third call (≈1100 more) would cross 3000.
    expect(m.calls()).toBe(2);
    const stop = { type: "budget_exhausted", budget: "max_tokens_per_turn", limit: 3000, used: 2200 };
    expect(r.stopReason).toEqual(stop);
    const evs = await p.events();
    expect(lastIdle(evs)!.stop_reason).toEqual(stop);
    expect(evs.filter((e) => e.type === "session.warning" && e.source === "budget_exhausted")).toHaveLength(1);
    // Terminal and clean: every tool call has its result, no error.
    const uses = evs.filter((e) => e.type === "agent.tool_use").map((e) => e.id);
    const results = evs.filter((e) => e.type === "agent.tool_result").map((e) => e.tool_use_id);
    expect(uses).toHaveLength(2);
    expect(results.sort()).toEqual(uses.sort());
    expect(evs.some((e) => e.type === "session.error")).toBe(false);
    expect(await p.rows()).toHaveLength(2);

    // A new turn gets a fresh per-turn allowance.
    await p.send();
    expect(m.calls()).toBe(4);
  });

  it("max_tokens_per_session counts earlier turns and blocks the first call once exhausted", async () => {
    resetInflightToolCallsForTest();
    const m = scriptedModel((n) => n === 1);
    const p = await pipeline({ kind: "sqlite", agent: agentWith({ max_tokens_per_session: 2500 }), harness: new DefaultHarness(), model: m.model, tools: bashTool() });
    expect((await p.send()).stopReason).toEqual({ type: "end_turn" });
    const r2 = await p.send();
    expect(m.calls()).toBe(2);
    expect(r2.stopReason).toEqual({ type: "budget_exhausted", budget: "max_tokens_per_session", limit: 2500, used: 2200 });
    // Exhausted: the next turn makes no model call at all.
    const r3 = await p.send();
    expect(m.calls()).toBe(2);
    expect(r3.stopReason).toMatchObject({ type: "budget_exhausted", budget: "max_tokens_per_session", used: 2200 });
  });

  it("max_cost_usd_per_session uses the pricing table", async () => {
    resetInflightToolCallsForTest();
    const m = scriptedModel();
    const p = await pipeline({ kind: "sqlite", agent: agentWith({ max_cost_usd_per_session: 0.01 }), harness: new DefaultHarness(), model: m.model, tools: bashTool() });
    const r = await p.send();
    expect(m.calls()).toBe(2); // $0.0045 per call; a third would pass $0.01
    expect(r.stopReason).toEqual({ type: "budget_exhausted", budget: "max_cost_usd_per_session", limit: 0.01, used: 0.009 });
  });

  it("max_steps_per_turn replaces the default 100-step cap", async () => {
    resetInflightToolCallsForTest();
    const m = scriptedModel();
    const p = await pipeline({ kind: "sqlite", agent: agentWith({ max_steps_per_turn: 3 }), harness: new DefaultHarness(), model: m.model, tools: bashTool() });
    const r = await p.send();
    expect(m.calls()).toBe(3);
    expect(r.stopReason).toEqual({ type: "budget_exhausted", budget: "max_steps_per_turn", limit: 3, used: 3 });
  });

  it("tenant daily token cap (OMA_TENANT_DAILY_TOKEN_LIMIT) spans turns", async () => {
    resetInflightToolCallsForTest();
    expect(resolveNodeBudgetConfig({ OMA_TENANT_DAILY_TOKEN_LIMIT: "2000" } as NodeJS.ProcessEnv).tenantDailyTokens).toBe(2000);
    const m = scriptedModel();
    const p = await pipeline({ kind: "sqlite", agent: agentWith(), harness: new DefaultHarness(), model: m.model, tools: bashTool(), config: { tenantDailyTokens: 2000 } });
    const r = await p.send();
    expect(m.calls()).toBe(1);
    expect(r.stopReason).toEqual({ type: "budget_exhausted", budget: "tenant_daily_tokens", limit: 2000, used: 1100 });
    await p.send();
    expect(m.calls()).toBe(1);
  });

  it("max_turn_wall_clock_seconds aborts a hung turn through the machine abort path", async () => {
    resetInflightToolCallsForTest();
    const m = scriptedModel();
    const hang = tool({
      inputSchema: z.object({ command: z.string() }),
      execute: (_input, { abortSignal }) =>
        new Promise<string>((_, reject) => abortSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })),
    });
    const p = await pipeline({
      kind: "sqlite",
      agent: agentWith({ max_turn_wall_clock_seconds: 0.5 }),
      harness: new DefaultHarness(),
      model: m.model,
      tools: { bash: hang },
    });
    const t0 = Date.now();
    const r = await p.send();
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.stopReason).toMatchObject({ type: "budget_exhausted", budget: "max_turn_wall_clock_seconds", limit: 0.5 });
    const evs = await p.events();
    const use = evs.find((e) => e.type === "agent.tool_use")!;
    const results = evs.filter((e) => e.type === "agent.tool_result" && e.tool_use_id === use.id);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ is_error: true });
    expect(evs.find((e) => e.type === "session.warning" && e.source === "budget_exhausted")).toBeTruthy();
    expect(lastIdle(evs)!.stop_reason).toMatchObject({ type: "budget_exhausted", budget: "max_turn_wall_clock_seconds" });
    expect(evs.some((e) => e.type === "session.error")).toBe(false);
  });
});

// ─── Pi harness (pi-ai faux provider) ────────────────────────────────────

function fauxPi(responses: Parameters<ReturnType<typeof createFauxCore>["setResponses"]>[0]) {
  const faux = createFauxCore({ models: [{ id: "faux-1" }] });
  faux.setResponses(responses);
  const resolved: ResolvedPiModel = {
    model: faux.getModel() as never,
    streamFn: (m, c, o) => faux.streamSimple(m as never, c, o),
    apiKey: "faux",
    openAiToolNames: false,
  };
  return { faux, harness: new PiHarness({ resolveModel: () => resolved }) };
}
const loop = (n: number) =>
  Array.from({ length: n }, (_, i) => fauxAssistantMessage([fauxText(`step ${i}`), fauxToolCall("bash", { command: "ls" }, { id: `pi_${i}_${Math.random().toString(36).slice(2, 6)}` })], { stopReason: "toolUse" }));
const tokensOf = (s: Ev) => s.model_usage.input_tokens + s.model_usage.output_tokens;

describe("budgets — Pi harness", () => {
  it("records usage rows and stops on max_steps_per_turn", async () => {
    resetInflightToolCallsForTest();
    const { faux, harness } = fauxPi(loop(6));
    const p = await pipeline({ kind: "sqlite", agent: agentWith({ max_steps_per_turn: 2 }, "pi"), harness, tools: bashTool() });
    const r = await p.send();
    expect(faux.state.callCount).toBe(2);
    expect(r.stopReason).toEqual({ type: "budget_exhausted", budget: "max_steps_per_turn", limit: 2, used: 2 });
    const evs = await p.events();
    expect(spans(evs)).toHaveLength(2);
    expect(await p.rows()).toHaveLength(2);
    const uses = evs.filter((e) => e.type === "agent.tool_use").map((e) => e.id);
    expect(evs.filter((e) => e.type === "agent.tool_result").map((e) => e.tool_use_id).sort()).toEqual(uses.sort());
  });

  it("stops on max_tokens_per_turn after the call that reached it", async () => {
    resetInflightToolCallsForTest();
    const { faux, harness } = fauxPi(loop(6));
    const p = await pipeline({ kind: "sqlite", agent: agentWith({ max_tokens_per_turn: 1 }, "pi"), harness, tools: bashTool() });
    const r = await p.send();
    expect(faux.state.callCount).toBe(1);
    const evs = await p.events();
    expect(r.stopReason).toEqual({ type: "budget_exhausted", budget: "max_tokens_per_turn", limit: 1, used: tokensOf(spans(evs)[0]) });
    expect(lastIdle(evs)!.stop_reason).toEqual(r.stopReason);
  });

  it("max_tokens_per_session blocks the first call of a later turn; cost is null for unpriced models", async () => {
    resetInflightToolCallsForTest();
    const { faux, harness } = fauxPi([fauxAssistantMessage("hello there"), fauxAssistantMessage("never sent")]);
    const p = await pipeline({ kind: "sqlite", agent: agentWith(undefined, "pi"), harness });
    expect((await p.send()).stopReason).toEqual({ type: "end_turn" });
    const used = tokensOf(spans(await p.events())[0]);
    expect(spans(await p.events())[0].cost_usd).toBeNull(); // faux-1 has no price
    p.state.agent = agentWith({ max_tokens_per_session: used }, "pi");
    const r = await p.send();
    expect(faux.state.callCount).toBe(1);
    expect(r.stopReason).toEqual({ type: "budget_exhausted", budget: "max_tokens_per_session", limit: used, used });
    const rows = await p.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0].cost_usd).toBeNull();
  });
});
