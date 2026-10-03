// Budgets (docs/budgets.md): validation, pricing, log-derived usage, the
// per-run tracker, the stop marker → stop_reason path, the machine's
// wall-clock abort, and the idempotent usage store.

import { describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { BetterSqlite3SqlClient } from "@open-managed-agents/sql-client/adapters/better-sqlite3";
import { InMemoryEventLog, InMemoryStreamRepo } from "@open-managed-agents/event-log/memory";
import type { SandboxExecutor } from "@open-managed-agents/sandbox";
import type { LanguageModel } from "ai";
import type { AgentConfig, SessionEvent, UserMessageEvent } from "@open-managed-agents/shared";
import {
  BudgetTracker,
  SessionStateMachine,
  SqlModelUsageStore,
  budgetStopFromEvents,
  budgetWarningEvent,
  computeStopReason,
  estimateCostUsd,
  parseAgentBudget,
  parseModelPricingOverrides,
  resolveModelPricing,
  usageRowsFromEvents,
  usageSnapshotFromEvents,
  type RuntimeAdapter,
} from "@open-managed-agents/session-runtime";

const span = (id: string, input: number, output: number, extra: Record<string, unknown> = {}) =>
  ({
    type: "span.model_request_end",
    model: "claude-sonnet-4-6",
    model_request_start_id: id,
    model_usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    ...extra,
  }) as unknown as SessionEvent;
const user = (id: string) => ({ type: "user.message", id, content: [{ type: "text", text: "hi" }] }) as unknown as SessionEvent;
const agent = (budget?: unknown, model = "claude-sonnet-4-6") =>
  ({ id: "a", name: "a", model, system: "", tools: [], metadata: budget === undefined ? {} : { budget } }) as unknown as AgentConfig;

describe("parseAgentBudget", () => {
  it("accepts the five fields and treats null as no budget", () => {
    expect(parseAgentBudget(null)).toEqual({ budget: null });
    expect(
      parseAgentBudget({
        max_tokens_per_turn: 1000,
        max_tokens_per_session: 5000,
        max_cost_usd_per_session: 0.5,
        max_turn_wall_clock_seconds: 30,
        max_steps_per_turn: 8,
      }).budget,
    ).toEqual({
      max_tokens_per_turn: 1000,
      max_tokens_per_session: 5000,
      max_cost_usd_per_session: 0.5,
      max_turn_wall_clock_seconds: 30,
      max_steps_per_turn: 8,
    });
  });
  it("rejects unknown keys, non-positive and fractional token counts", () => {
    expect(parseAgentBudget({ max_tokens: 5 }).error).toMatch(/not a budget field/);
    expect(parseAgentBudget({ max_tokens_per_turn: 0 }).error).toMatch(/positive/);
    expect(parseAgentBudget({ max_steps_per_turn: 2.5 }).error).toMatch(/integer/);
    expect(parseAgentBudget("x").error).toMatch(/object/);
  });
});

describe("pricing", () => {
  it("resolves decorated / dated ids to the family price and prices cache reads", () => {
    expect(resolveModelPricing("anthropic/claude-sonnet-4.6")).toMatchObject({ input_per_mtok: 3, output_per_mtok: 15 });
    expect(resolveModelPricing("claude-sonnet-4-5-20250929")).toMatchObject({ input_per_mtok: 3 });
    expect(resolveModelPricing("us.anthropic.claude-opus-4-8")).toMatchObject({ input_per_mtok: 5 });
    expect(resolveModelPricing("some-local-model")).toBeNull();
    const p = resolveModelPricing("claude-haiku-4-5")!;
    // 1M input (half of it cache reads at 0.1x) + 1M output
    expect(
      estimateCostUsd({ input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 500_000 }, p),
    ).toBeCloseTo(0.5 * 1 + 0.5 * 0.1 + 5, 6);
    expect(estimateCostUsd({ input_tokens: 10, output_tokens: 10 }, null)).toBeNull();
  });
  it("lets overrides price unknown models", () => {
    const o = parseModelPricingOverrides('{"my-model":{"input_per_mtok":1,"output_per_mtok":2},"bad":{}}');
    expect(o).toEqual({ "my-model": { input_per_mtok: 1, output_per_mtok: 2 } });
    expect(resolveModelPricing("my-model", o)).toEqual({ input_per_mtok: 1, output_per_mtok: 2 });
  });
});

describe("usage derived from the log", () => {
  it("splits session vs turn usage at the last turn input and dedupes by model_request_start_id", () => {
    const events = [user("u1"), span("m1", 100, 10), span("m1", 100, 10), user("u2"), span("m2", 200, 20)];
    const snap = usageSnapshotFromEvents(events);
    expect(snap.session.tokens).toBe(330);
    expect(snap.turn).toMatchObject({ tokens: 220, steps: 1 });
    expect(snap.last_call?.tokens).toBe(220);
  });
});

describe("BudgetTracker", () => {
  it("stops before the call that would cross max_tokens_per_turn (projection = last call)", () => {
    const t = BudgetTracker.forRun({ agent: agent({ max_tokens_per_turn: 500 }), events: [user("u1")] });
    expect(t.check()).toBeNull();
    t.record({ input_tokens: 200, output_tokens: 50 }); // 250 used, next ≈ 250 → 500 not > 500
    expect(t.check()).toBeNull();
    t.record({ input_tokens: 220, output_tokens: 40 }); // 510 used
    expect(t.check()).toEqual({ type: "budget_exhausted", budget: "max_tokens_per_turn", limit: 500, used: 510 });
  });

  it("counts earlier turns for session limits but not for turn limits", () => {
    const events = [user("u1"), span("m1", 900, 50), user("u2")];
    expect(BudgetTracker.forRun({ agent: agent({ max_tokens_per_turn: 2000 }), events }).check()).toBeNull();
    expect(BudgetTracker.forRun({ agent: agent({ max_tokens_per_session: 1000 }), events }).check()).toMatchObject({
      budget: "max_tokens_per_session",
      used: 950,
    });
  });

  it("enforces cost, steps and tenant caps", () => {
    const cost = BudgetTracker.forRun({ agent: agent({ max_cost_usd_per_session: 0.01 }), events: [user("u")] });
    cost.record({ input_tokens: 2000, output_tokens: 300 }); // 0.006 + 0.0045 = 0.0105
    expect(cost.check()).toMatchObject({ budget: "max_cost_usd_per_session", limit: 0.01 });
    expect(cost.costOf({ input_tokens: 1_000_000, output_tokens: 0 })).toBe(3);

    const steps = BudgetTracker.forRun({ agent: agent({ max_steps_per_turn: 2 }), events: [user("u")] });
    expect(steps.maxSteps).toBe(2);
    steps.record(null);
    expect(steps.check()).toBeNull();
    steps.record(null);
    expect(steps.check()).toEqual({ type: "budget_exhausted", budget: "max_steps_per_turn", limit: 2, used: 2 });

    const tenant = BudgetTracker.forRun({
      agent: agent(),
      events: [user("u")],
      context: { tenant: { limits: { daily_tokens: 1000 }, used: { tokens: 990, cost_usd: 0 } } },
    });
    expect(tenant.check()).toBeNull();
    tenant.record({ input_tokens: 5, output_tokens: 5 });
    expect(tenant.check()).toMatchObject({ budget: "tenant_daily_tokens", used: 1000 });
  });

  it("checkAfter() matches recording the calls", () => {
    const t = BudgetTracker.forRun({ agent: agent({ max_tokens_per_turn: 100 }), events: [user("u")] });
    expect(t.checkAfter([{ input_tokens: 60, output_tokens: 50 }])).toMatchObject({ used: 110 });
    expect(t.check()).toBeNull();
  });

  it("unpriced models never trip cost limits (tokens only)", () => {
    const t = BudgetTracker.forRun({ agent: agent({ max_cost_usd_per_session: 0.0001 }, "local-llm"), events: [user("u")] });
    t.record({ input_tokens: 1_000_000, output_tokens: 1_000_000 });
    expect(t.costOf({ input_tokens: 1, output_tokens: 1 })).toBeNull();
    expect(t.check()).toBeNull();
  });
});

describe("stop marker → stop_reason", () => {
  const stop = { type: "budget_exhausted" as const, budget: "max_tokens_per_turn" as const, limit: 10, used: 12 };
  it("reads the marker of the current turn only", () => {
    expect(budgetStopFromEvents([budgetWarningEvent(stop)])).toEqual(stop);
    expect(budgetStopFromEvents([budgetWarningEvent(stop), user("u2")])).toBeNull();
    expect(budgetStopFromEvents([budgetWarningEvent(stop, "sthr_x")])).toBeNull();
    expect(budgetStopFromEvents([budgetWarningEvent(stop, "sthr_x")], "sthr_x")).toEqual(stop);
  });
  it("computeStopReason prefers requires_action, then budget, then end_turn", () => {
    const pendingCall = { type: "agent.custom_tool_use", id: "c1", name: "deploy", input: {} } as unknown as SessionEvent;
    expect(computeStopReason([budgetWarningEvent(stop)], [])).toEqual(stop);
    expect(computeStopReason([pendingCall, budgetWarningEvent(stop)], ["c1"]).type).toBe("requires_action");
    expect(computeStopReason([], [])).toEqual({ type: "end_turn" });
  });
});

describe("SessionStateMachine wall-clock budget", () => {
  function setup(run: (ctx: { abortSignal: AbortSignal; eventLog: InMemoryEventLog }) => Promise<void>) {
    const log = new InMemoryEventLog(() => {});
    const sandbox: SandboxExecutor = { exec: async () => "", readFile: async () => "", writeFile: async () => "" };
    const adapter: RuntimeAdapter = {
      sql: {} as RuntimeAdapter["sql"],
      eventLog: log,
      streams: new InMemoryStreamRepo(),
      sandbox,
      beginTurn: vi.fn(async () => {}),
      endTurn: vi.fn(async () => {}),
      terminate: vi.fn(async () => {}),
      listOrphanTurns: vi.fn(async () => []),
    };
    const machine = new SessionStateMachine({
      sessionId: "s",
      tenantId: "t",
      adapter,
      sandbox,
      loadAgent: async () => agent({ max_turn_wall_clock_seconds: 0.2 }),
      buildTools: async () => ({}),
      buildModel: async () => ({}) as LanguageModel,
      buildHarness: () => ({ run: (ctx) => run(ctx as never) }),
      buildHarnessContext: async (input) => input,
      publish: () => {},
      abortGraceMs: 200,
    });
    return { machine, log };
  }

  it("aborts the turn, closes the cut-off tool call and ends with budget_exhausted", async () => {
    const { machine, log } = setup(async ({ abortSignal, eventLog }) => {
      eventLog.append({ type: "agent.tool_use", id: "t1", name: "bash", input: { command: "sleep 99" } } as SessionEvent);
      await new Promise<void>((_, reject) =>
        abortSignal.addEventListener("abort", () => reject(abortSignal.reason), { once: true }),
      );
    });
    const started = Date.now();
    const result = await machine.runTurn("a", { type: "user.message", content: [{ type: "text", text: "go" }] } as UserMessageEvent);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.stopReason).toMatchObject({ type: "budget_exhausted", budget: "max_turn_wall_clock_seconds", limit: 0.2 });
    const events = log.getEvents() as Array<Record<string, unknown>>;
    expect(events.find((e) => e.type === "agent.tool_result")).toMatchObject({
      tool_use_id: "t1",
      is_error: true,
      content: expect.stringMatching(/wall-clock budget/),
    });
    expect(events.find((e) => e.type === "session.warning")).toMatchObject({ source: "budget_exhausted" });
    const idle = events.filter((e) => e.type === "session.status_idle").at(-1)!;
    expect(idle.stop_reason).toMatchObject({ type: "budget_exhausted", budget: "max_turn_wall_clock_seconds" });
    expect(events.some((e) => e.type === "session.error")).toBe(false);
  });

  it("a harness-written budget marker becomes the turn's stop_reason", async () => {
    const stop = { type: "budget_exhausted" as const, budget: "max_tokens_per_session" as const, limit: 5, used: 9 };
    const { machine, log } = setup(async ({ eventLog }) => {
      eventLog.append(budgetWarningEvent(stop));
    });
    const result = await machine.runTurn("a", { type: "user.message", content: [{ type: "text", text: "go" }] } as UserMessageEvent);
    expect(result.stopReason).toEqual(stop);
    const idle = (log.getEvents() as Array<Record<string, unknown>>).filter((e) => e.type === "session.status_idle").at(-1)!;
    expect(idle.stop_reason).toEqual(stop);
  });
});

describe("SqlModelUsageStore (sqlite)", () => {
  async function store() {
    const db = new Database(":memory:");
    const sql = new BetterSqlite3SqlClient(db);
    const ddl = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../../../apps/main-node/migrations-sqlite/0006_model_usage_events.sql", import.meta.url), "utf8"),
    );
    for (const stmt of ddl.split("--> statement-breakpoint")) await sql.exec(stmt);
    return { s: new SqlModelUsageStore(sql), db };
  }

  it("is idempotent per model call and backfills only missing rows", async () => {
    const { s, db } = await store();
    const events = [user("u1"), span("m1", 1000, 100, { cost_usd: 0.0045 }), user("u2"), span("m2", 2000, 200, { model: "local" })];
    const ctx = { tenantId: "t", sessionId: "s", agentId: "a" };
    const rows = usageRowsFromEvents(events, ctx);
    expect(rows.map((r) => [r.turn_id, r.cost_usd])).toEqual([["u1", 0.0045], ["u2", null]]);
    expect(await s.record(rows[0])).toBe(true);
    expect(await s.record(rows[0])).toBe(false);
    expect(await s.recordFromEvents(events, ctx)).toBe(1);
    expect(await s.recordFromEvents(events, ctx)).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM model_usage_events").get() as { n: number }).n).toBe(2);

    const report = await s.sessionReport("t", "s", { max_tokens_per_session: 10_000 });
    expect(report.totals).toEqual({
      model_calls: 2,
      input_tokens: 3000,
      output_tokens: 300,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      total_tokens: 3300,
      cost_usd: 0.0045,
      unpriced_calls: 1,
    });
    expect(report.by_model.map((m) => m.model)).toEqual(["claude-sonnet-4-6", "local"]);
    expect(report.budget).toEqual({ max_tokens_per_session: 10_000 });
    expect((await s.agentReport("t", "a")).totals.model_calls).toBe(2);
    expect(await s.tenantTotalsSince("t", 0)).toEqual({ tokens: 3300, cost_usd: 0.0045 });
  });
});
