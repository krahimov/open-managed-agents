// Usage analytics — the usage_turns tracker behind GET /v1/usage, and the
// taps that feed it (NodeHarnessRuntime for DefaultHarness/Pi, the
// claude-agent-sdk result message).
//
// The tracker suite runs on in-memory SQLite always, and on Postgres too
// when PG_TEST_URL is set (postgres://…): the DDL uses BIGINT/DOUBLE there,
// SUM/COUNT come back as strings, and the day bucket is BIGINT division.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { BetterSqlite3SqlClient } from "@open-managed-agents/sql-client/adapters/better-sqlite3";
import { createPostgresSqlClient, type SqlClient } from "@open-managed-agents/sql-client";
import type { SessionEvent } from "@open-managed-agents/shared";
import type { SqlEventLog } from "@open-managed-agents/event-log/sql";
import type { SandboxExecutor } from "@open-managed-agents/sandbox";
import {
  NodeUsageTracker,
  estimateCostUsd,
  providerForModel,
} from "../src/lib/node-usage-tracker";
import { NodeHarnessRuntime } from "../src/lib/node-harness-runtime";
import { InProcessEventStreamHub } from "../src/lib/event-stream-hub";
import { usageFromSdkResult } from "../src/lib/claude-agent-sdk-harness";

const DAY = 86_400_000;
// 2026-11-10T12:00:00Z and the next day.
const T0 = Date.UTC(2026, 10, 10, 12);
const T1 = T0 + DAY;

const PG_URL = process.env.PG_TEST_URL ?? "";
const pgEnabled = PG_URL.startsWith("postgres://") || PG_URL.startsWith("postgresql://");

type Dialect = "sqlite" | "postgres";

function suite(dialect: Dialect, open: () => Promise<{ sql: SqlClient; close: () => Promise<void> }>) {
  const d = dialect === "postgres" && !pgEnabled ? describe.skip : describe;
  d(`NodeUsageTracker on ${dialect}`, () => {
    let sql: SqlClient;
    let close: () => Promise<void>;
    let now = T0;
    let tracker: NodeUsageTracker;
    // Unique per run so a shared PG database never mixes runs.
    const tenant = `ten_usage_${dialect}_${Date.now()}`;
    const other = `${tenant}_other`;

    beforeAll(async () => {
      ({ sql, close } = await open());
      tracker = new NodeUsageTracker({ sql, dialect, now: () => now });
      await tracker.ensureSchema();
      await tracker.ensureSchema(); // idempotent

      now = T0;
      await tracker.record({
        tenantId: tenant, sessionId: "s1", agentId: "a1", harness: "default",
        model: "claude-sonnet-4-6",
        usage: { input_tokens: 1_000_000, cached_input_tokens: 1_000_000, output_tokens: 100_000 },
      });
      await tracker.record({
        tenantId: tenant, sessionId: "s1", agentId: "a1", harness: "default",
        model: "anthropic/claude-haiku-4-5",
        usage: { input_tokens: 1_000_000, output_tokens: 0 },
      });
      now = T1;
      await tracker.record({
        tenantId: tenant, sessionId: "s2", agentId: "a2", harness: "codex-sdk",
        model: "gpt-5.5",
        usage: { input_tokens: 500_000, cached_input_tokens: 0, output_tokens: 50_000, reasoning_tokens: 20_000 },
      });
      // Reported cost wins over the estimate (claude-agent-sdk costUSD).
      await tracker.record({
        tenantId: tenant, sessionId: "s3", agentId: "a1", harness: "claude-agent-sdk",
        model: "claude-opus-4-6", costUsd: 0.5,
        usage: { input_tokens: 10, output_tokens: 10 },
      });
      // Unpriced model: tokens count, cost stays out of the sums.
      await tracker.record({
        tenantId: tenant, sessionId: "s3", agentId: "a1", harness: "default",
        model: "my-local-llama",
        usage: { input_tokens: 40, output_tokens: 60 },
      });
      // Empty call: not recorded.
      await tracker.record({
        tenantId: tenant, sessionId: "s4", agentId: "a1", harness: "default",
        model: "claude-sonnet-4-6", usage: { input_tokens: 0, output_tokens: 0 },
      });
      // Another tenant: never in this tenant's report.
      await tracker.record({
        tenantId: other, sessionId: "sx", agentId: "ax", harness: "default",
        model: "claude-sonnet-4-6", usage: { input_tokens: 999, output_tokens: 999 },
      });
    });

    afterAll(async () => {
      if (!sql) return;
      if (dialect === "postgres") {
        await sql.prepare(`DELETE FROM usage_turns WHERE tenant_id IN (?, ?)`).bind(tenant, other).run();
      }
      await close();
    });

    it("reports totals as plain numbers for the window", async () => {
      const r = await tracker.report(tenant, T0 - DAY, T1 + DAY);
      expect(r.range).toEqual({ since: T0 - DAY, until: T1 + DAY });
      // sonnet: 1M×3 + 1M×0.3 + 0.1M×15 = 4.8; haiku: 1M×1 = 1;
      // gpt-5.5: 0.5M×4 + 0.05M×20 = 3; opus: reported 0.5; llama: unpriced.
      expect(r.totals.cost_usd).toBeCloseTo(9.3, 6);
      expect(r.totals.cache_savings_usd).toBeCloseTo(2.7, 6); // sonnet: 1M × (3 − 0.3)
      expect(r.totals.processed_tokens).toBe(1_000_000 + 1_000_000 + 100_000 + 1_000_000 + 550_000 + 20 + 100);
      expect(r.totals.uncached_input_tokens).toBe(1_000_000 + 1_000_000 + 500_000 + 10 + 40);
      expect(r.totals.cached_input_tokens).toBe(1_000_000);
      expect(r.totals.output_tokens).toBe(100_000 + 50_000 + 10 + 60);
      expect(r.totals.reasoning_tokens).toBe(20_000);
      expect(r.totals.calls).toBe(5);
      expect(r.totals.sessions).toBe(3);
      for (const v of Object.values(r.totals)) expect(typeof v).toBe("number");
    });

    it("splits by provider, day, model and harness", async () => {
      const r = await tracker.report(tenant, T0 - DAY, T1 + DAY);
      const byProvider = Object.fromEntries(r.providers.map((p) => [p.provider, p]));
      expect(Object.keys(byProvider).sort()).toEqual(["anthropic", "openai", "other"]);
      expect(byProvider.anthropic!.cost_usd).toBeCloseTo(6.3, 6);
      expect(byProvider.anthropic!.sessions).toBe(2);
      expect(byProvider.openai!.tokens).toBe(550_000);
      expect(byProvider.other!.cost_usd).toBe(0);
      expect(r.providers[0]!.provider).toBe("anthropic"); // most expensive first

      expect(r.daily.map((d) => d.day)).toEqual(
        expect.arrayContaining(["2026-11-10", "2026-11-11"]),
      );
      const firstDay = r.daily.filter((d) => d.day === "2026-11-10");
      expect(firstDay).toHaveLength(1);
      expect(firstDay[0]).toMatchObject({ provider: "anthropic", tokens: 3_100_000 });
      expect(firstDay[0]!.cost_usd).toBeCloseTo(5.8, 6);
      for (const d of r.daily) {
        expect(typeof d.cost_usd).toBe("number");
        expect(typeof d.tokens).toBe("number");
      }

      expect(r.models.map((m) => m.model)).toContain("anthropic/claude-haiku-4-5");
      expect(r.models.find((m) => m.model === "anthropic/claude-haiku-4-5")!.provider).toBe("anthropic");
      const harness = Object.fromEntries(r.harnesses.map((h) => [h.harness, h]));
      expect(harness.default!.sessions).toBe(2);
      expect(harness["claude-agent-sdk"]!.cost_usd).toBeCloseTo(0.5, 6);
    });

    it("honours the window and the tenant", async () => {
      const day1 = await tracker.report(tenant, T0 - DAY, T0 + DAY / 2);
      expect(day1.totals.calls).toBe(2);
      const none = await tracker.report(tenant, 1, 2);
      expect(none.totals).toMatchObject({ cost_usd: 0, processed_tokens: 0, calls: 0, sessions: 0 });
      expect(none.providers).toEqual([]);
      expect(none.daily).toEqual([]);
      const theirs = await tracker.report(other, T0 - DAY, T1 + DAY);
      expect(theirs.totals.calls).toBe(1);
    });
  });
}

suite("sqlite", async () => {
  const db = new Database(":memory:");
  return { sql: new BetterSqlite3SqlClient(db), close: async () => db.close() };
});

suite("postgres", async () => {
  const sql = await createPostgresSqlClient(PG_URL);
  return { sql, close: async () => (sql as { close?: () => Promise<void> }).close?.() };
});

describe("pricing", () => {
  it("maps models to providers, routed ids included", () => {
    expect(providerForModel("claude-sonnet-4-6")).toBe("anthropic");
    expect(providerForModel("anthropic/claude-opus-4-6")).toBe("anthropic");
    expect(providerForModel("gpt-5.5-mini")).toBe("openai");
    expect(providerForModel("openai/gpt-5.5")).toBe("openai");
    expect(providerForModel("llama-3")).toBe("other");
  });

  it("returns null cost for a model it cannot price", () => {
    expect(estimateCostUsd("llama-3", { input_tokens: 10, output_tokens: 10 })).toEqual({ cost: null, savings: null });
  });
});

describe("NodeHarnessRuntime usage tap", () => {
  function runtime(onModelUsage: NonNullable<ConstructorParameters<typeof NodeHarnessRuntime>[0]["onModelUsage"]>) {
    const log = {
      appendAsync: async (e: SessionEvent) => ({ ...e, seq: 1 }),
      getEventsAsync: async () => [],
    } as unknown as SqlEventLog;
    return new NodeHarnessRuntime({
      sessionId: "sess_tap",
      log,
      hub: new InProcessEventStreamHub(),
      sandbox: {} as SandboxExecutor,
      onModelUsage,
    });
  }

  it("passes model_request_end and compaction usage through, and nothing else", async () => {
    const seen: unknown[] = [];
    const rt = runtime((info) => seen.push(info));
    const usage = { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 };
    rt.broadcast({ type: "span.model_request_end", model: "claude-sonnet-4-6", model_usage: usage } as unknown as SessionEvent);
    rt.broadcast({ type: "span.compaction_summarize_end", model: "claude-haiku-4-5", model_usage: usage } as unknown as SessionEvent);
    // An errored call carries no usage; other events never count.
    rt.broadcast({ type: "span.model_request_end", model: "claude-sonnet-4-6", is_error: true } as unknown as SessionEvent);
    rt.broadcast({ type: "agent.message", content: [] } as unknown as SessionEvent);
    await rt.persist({ type: "span.model_request_end", model: "gpt-5.5", model_usage: usage } as unknown as SessionEvent);
    await rt.flush();
    expect(seen).toEqual([
      { model: "claude-sonnet-4-6", usage },
      { model: "claude-haiku-4-5", usage },
      { model: "gpt-5.5", usage },
    ]);
  });

  it("never lets a throwing tap break the event write", async () => {
    const rt = runtime(() => {
      throw new Error("db down");
    });
    rt.broadcast({ type: "span.model_request_end", model: "m", model_usage: { input_tokens: 1, output_tokens: 1 } } as unknown as SessionEvent);
    await expect(rt.flush()).resolves.toBeUndefined();
    expect(rt.abortSignal.aborted).toBe(false);
  });
});

describe("claude-agent-sdk result usage", () => {
  it("records one row per model from the modelUsage map, with the SDK's cost", () => {
    const rows = usageFromSdkResult(
      {
        type: "result",
        subtype: "success",
        modelUsage: {
          "claude-sonnet-4-6": { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 300, cacheCreationInputTokens: 40, costUSD: 0.12 },
          "claude-haiku-4-5": { inputTokens: 5, outputTokens: 6 },
        },
        usage: { input_tokens: 999, output_tokens: 999 },
      },
      "claude-sonnet-4-6",
    );
    expect(rows).toEqual([
      { model: "claude-sonnet-4-6", costUsd: 0.12, usage: { input_tokens: 10, cached_input_tokens: 300, cache_write_input_tokens: 40, output_tokens: 20 } },
      { model: "claude-haiku-4-5", costUsd: undefined, usage: { input_tokens: 5, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 6 } },
    ]);
  });

  it("falls back to the aggregate usage, then to nothing", () => {
    expect(usageFromSdkResult({ usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3 }, total_cost_usd: 0.01 }, undefined)).toEqual([
      { model: "claude-default", costUsd: 0.01, usage: { input_tokens: 1, cached_input_tokens: 3, cache_write_input_tokens: 0, output_tokens: 2 } },
    ]);
    expect(usageFromSdkResult({ modelUsage: {} }, "claude-opus-4-6")).toEqual([]);
    expect(usageFromSdkResult(null, undefined)).toEqual([]);
  });
});
