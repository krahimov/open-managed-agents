/**
 * NodeUsageTracker — per-model-call token usage + estimated API cost for the
 * self-host analytics dashboard (console /usage).
 *
 * One row per model call (DefaultHarness step) or per vendor turn (SDK
 * harnesses). Cost is an API-price ESTIMATE from the static PRICING table —
 * on the subscription harnesses (claude-agent-sdk, codex-sdk) nothing is
 * actually billed per token, but the estimate shows what the same traffic
 * would have cost on API keys (same framing as T3 Code's usage page).
 * cache_savings_usd = what prompt caching saved vs paying the full input
 * rate for the cached tokens.
 *
 * Sources:
 *   - DefaultHarness: span.model_request_end events (model + model_usage
 *     buckets) tapped via NodeHarnessRuntime.onModelUsage.
 *   - claude-agent-sdk: the SDK result message's modelUsage map (per-model,
 *     includes the SDK's own costUSD when present).
 *   - codex-sdk: turn.completed usage.
 *
 * Schema follows the ensureSchema-owns-its-DDL convention
 * (node-session-wakeups.ts) — no drizzle migration.
 */

import { randomUUID } from "node:crypto";
import type { SqlClient } from "@open-managed-agents/sql-client";

export type UsageProvider = "anthropic" | "openai" | "other";

export interface UsageBuckets {
  /** UNCACHED input tokens (cached portion excluded). */
  input_tokens: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens: number;
  reasoning_tokens?: number;
}

export interface UsageRecordInput {
  tenantId: string;
  sessionId: string;
  agentId: string;
  harness: string;
  model: string;
  usage: UsageBuckets;
  /** Actual cost when the vendor reports one (claude SDK costUSD); otherwise
   *  estimated from PRICING. */
  costUsd?: number;
}

/** Per-MTok USD rates. cachedInput/cacheWrite default to 0.1x / 1.25x input
 *  when omitted. First match wins — keep more specific patterns first. */
interface PricingRule {
  match: RegExp;
  provider: UsageProvider;
  input: number;
  output: number;
  cachedInput?: number;
  cacheWrite?: number;
}

const PRICING: PricingRule[] = [
  // Anthropic (per docs, 2026-08)
  { match: /^claude-fable/i, provider: "anthropic", input: 10, output: 50 },
  { match: /^claude-opus/i, provider: "anthropic", input: 5, output: 25 },
  { match: /^claude-sonnet/i, provider: "anthropic", input: 3, output: 15 },
  { match: /^claude-haiku/i, provider: "anthropic", input: 1, output: 5 },
  { match: /^claude/i, provider: "anthropic", input: 5, output: 25 },
  // OpenAI (per published rates, 2026-08; sol promo pricing)
  { match: /^gpt-5\.\d+-sol/i, provider: "openai", input: 4, output: 20, cachedInput: 0.5 },
  { match: /^gpt-5\.\d+-terra/i, provider: "openai", input: 2, output: 12 },
  { match: /^gpt-5\.\d+-(luna|mini|nano)/i, provider: "openai", input: 0.2, output: 1.2 },
  { match: /^(gpt-|codex)/i, provider: "openai", input: 4, output: 20, cachedInput: 0.5 },
  { match: /^o[0-9]/i, provider: "openai", input: 2, output: 12 },
];

export function providerForModel(model: string): UsageProvider {
  return PRICING.find((p) => p.match.test(model))?.provider ?? "other";
}

/** Returns { cost, savings } in USD, or nulls when the model has no rule.
 *  savings = (full input rate − cached rate) × cached tokens; cache writes
 *  bill at a premium and count against cost, not savings. */
export function estimateCostUsd(
  model: string,
  u: UsageBuckets,
): { cost: number | null; savings: number | null } {
  const rule = PRICING.find((p) => p.match.test(model));
  if (!rule) return { cost: null, savings: null };
  const cachedRate = rule.cachedInput ?? rule.input * 0.1;
  const writeRate = rule.cacheWrite ?? rule.input * 1.25;
  const cached = u.cached_input_tokens ?? 0;
  const written = u.cache_write_input_tokens ?? 0;
  // Reasoning tokens bill as output on both providers; vendor output counts
  // already include them, so they are informational only here.
  const cost =
    (u.input_tokens * rule.input +
      cached * cachedRate +
      written * writeRate +
      u.output_tokens * rule.output) /
    1_000_000;
  const savings = (cached * Math.max(0, rule.input - cachedRate)) / 1_000_000;
  return { cost, savings };
}

export interface UsageReport {
  range: { since: number; until: number };
  totals: {
    cost_usd: number;
    cache_savings_usd: number;
    processed_tokens: number;
    uncached_input_tokens: number;
    cached_input_tokens: number;
    cache_write_input_tokens: number;
    output_tokens: number;
    reasoning_tokens: number;
    calls: number;
    sessions: number;
  };
  providers: Array<{
    provider: string;
    cost_usd: number;
    tokens: number;
    sessions: number;
  }>;
  /** Per UTC day per provider — the chart series. */
  daily: Array<{ day: string; provider: string; cost_usd: number; tokens: number }>;
  models: Array<{ model: string; provider: string; cost_usd: number; tokens: number }>;
  harnesses: Array<{ harness: string; cost_usd: number; tokens: number; sessions: number }>;
}

export interface NodeUsageTrackerDeps {
  sql: SqlClient;
  dialect: "sqlite" | "postgres";
  now?: () => number;
}

export class NodeUsageTracker {
  constructor(private deps: NodeUsageTrackerDeps) {}

  async ensureSchema(): Promise<void> {
    const int = this.deps.dialect === "postgres" ? "BIGINT" : "INTEGER";
    const real = this.deps.dialect === "postgres" ? "DOUBLE PRECISION" : "REAL";
    await this.deps.sql.exec(`
      CREATE TABLE IF NOT EXISTS usage_turns (
        id TEXT PRIMARY KEY,
        ts ${int} NOT NULL,
        tenant_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        harness TEXT NOT NULL,
        model TEXT NOT NULL,
        provider TEXT NOT NULL,
        input_tokens ${int} NOT NULL DEFAULT 0,
        cached_input_tokens ${int} NOT NULL DEFAULT 0,
        cache_write_input_tokens ${int} NOT NULL DEFAULT 0,
        output_tokens ${int} NOT NULL DEFAULT 0,
        reasoning_tokens ${int} NOT NULL DEFAULT 0,
        cost_usd ${real},
        cache_savings_usd ${real}
      );
      CREATE INDEX IF NOT EXISTS idx_usage_turns_tenant_ts ON usage_turns(tenant_id, ts);
      CREATE INDEX IF NOT EXISTS idx_usage_turns_session ON usage_turns(session_id);
    `);
  }

  /** Best-effort — callers must not let a failed insert fail the turn. */
  async record(rec: UsageRecordInput): Promise<void> {
    const u = rec.usage;
    const total =
      (u.input_tokens ?? 0) +
      (u.cached_input_tokens ?? 0) +
      (u.cache_write_input_tokens ?? 0) +
      (u.output_tokens ?? 0);
    if (total <= 0) return; // nothing to record (empty/failed call)
    const provider = providerForModel(rec.model);
    const est = estimateCostUsd(rec.model, u);
    const cost = rec.costUsd ?? est.cost;
    await this.deps.sql
      .prepare(
        `INSERT INTO usage_turns (
           id, ts, tenant_id, session_id, agent_id, harness, model, provider,
           input_tokens, cached_input_tokens, cache_write_input_tokens,
           output_tokens, reasoning_tokens, cost_usd, cache_savings_usd
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        `usg_${randomUUID()}`,
        (this.deps.now ?? Date.now)(),
        rec.tenantId,
        rec.sessionId,
        rec.agentId,
        rec.harness,
        rec.model,
        provider,
        u.input_tokens ?? 0,
        u.cached_input_tokens ?? 0,
        u.cache_write_input_tokens ?? 0,
        u.output_tokens ?? 0,
        u.reasoning_tokens ?? 0,
        cost,
        est.savings,
      )
      .run();
  }

  async report(tenantId: string, since: number, until: number): Promise<UsageReport> {
    const bind = [tenantId, since, until] as const;
    const where = `tenant_id = ? AND ts >= ? AND ts < ?`;
    const tokensExpr = `input_tokens + cached_input_tokens + cache_write_input_tokens + output_tokens`;

    const totals = await this.deps.sql
      .prepare(
        `SELECT COALESCE(SUM(cost_usd),0) AS cost_usd,
                COALESCE(SUM(cache_savings_usd),0) AS cache_savings_usd,
                COALESCE(SUM(${tokensExpr}),0) AS processed_tokens,
                COALESCE(SUM(input_tokens),0) AS uncached_input_tokens,
                COALESCE(SUM(cached_input_tokens),0) AS cached_input_tokens,
                COALESCE(SUM(cache_write_input_tokens),0) AS cache_write_input_tokens,
                COALESCE(SUM(output_tokens),0) AS output_tokens,
                COALESCE(SUM(reasoning_tokens),0) AS reasoning_tokens,
                COUNT(*) AS calls,
                COUNT(DISTINCT session_id) AS sessions
           FROM usage_turns WHERE ${where}`,
      )
      .bind(...bind)
      .first<Record<string, number>>();

    const providers = await this.deps.sql
      .prepare(
        `SELECT provider, COALESCE(SUM(cost_usd),0) AS cost_usd,
                COALESCE(SUM(${tokensExpr}),0) AS tokens,
                COUNT(DISTINCT session_id) AS sessions
           FROM usage_turns WHERE ${where}
          GROUP BY provider ORDER BY cost_usd DESC`,
      )
      .bind(...bind)
      .all<{ provider: string; cost_usd: number; tokens: number; sessions: number }>();

    // Integer day bucket (UTC): both dialects do integer division on int/int.
    const daily = await this.deps.sql
      .prepare(
        `SELECT (ts / 86400000) AS day_idx, provider,
                COALESCE(SUM(cost_usd),0) AS cost_usd,
                COALESCE(SUM(${tokensExpr}),0) AS tokens
           FROM usage_turns WHERE ${where}
          GROUP BY day_idx, provider ORDER BY day_idx ASC`,
      )
      .bind(...bind)
      .all<{ day_idx: number; provider: string; cost_usd: number; tokens: number }>();

    const models = await this.deps.sql
      .prepare(
        `SELECT model, provider, COALESCE(SUM(cost_usd),0) AS cost_usd,
                COALESCE(SUM(${tokensExpr}),0) AS tokens
           FROM usage_turns WHERE ${where}
          GROUP BY model, provider ORDER BY cost_usd DESC`,
      )
      .bind(...bind)
      .all<{ model: string; provider: string; cost_usd: number; tokens: number }>();

    const harnesses = await this.deps.sql
      .prepare(
        `SELECT harness, COALESCE(SUM(cost_usd),0) AS cost_usd,
                COALESCE(SUM(${tokensExpr}),0) AS tokens,
                COUNT(DISTINCT session_id) AS sessions
           FROM usage_turns WHERE ${where}
          GROUP BY harness ORDER BY cost_usd DESC`,
      )
      .bind(...bind)
      .all<{ harness: string; cost_usd: number; tokens: number; sessions: number }>();

    const dayIso = (idx: number) =>
      new Date(idx * 86400000).toISOString().slice(0, 10);

    const t = totals ?? {};
    return {
      range: { since, until },
      totals: {
        cost_usd: Number(t.cost_usd ?? 0),
        cache_savings_usd: Number(t.cache_savings_usd ?? 0),
        processed_tokens: Number(t.processed_tokens ?? 0),
        uncached_input_tokens: Number(t.uncached_input_tokens ?? 0),
        cached_input_tokens: Number(t.cached_input_tokens ?? 0),
        cache_write_input_tokens: Number(t.cache_write_input_tokens ?? 0),
        output_tokens: Number(t.output_tokens ?? 0),
        reasoning_tokens: Number(t.reasoning_tokens ?? 0),
        calls: Number(t.calls ?? 0),
        sessions: Number(t.sessions ?? 0),
      },
      providers: (providers.results ?? []).map((r) => ({
        provider: r.provider,
        cost_usd: Number(r.cost_usd),
        tokens: Number(r.tokens),
        sessions: Number(r.sessions),
      })),
      daily: (daily.results ?? []).map((r) => ({
        day: dayIso(Number(r.day_idx)),
        provider: r.provider,
        cost_usd: Number(r.cost_usd),
        tokens: Number(r.tokens),
      })),
      models: (models.results ?? []).map((r) => ({
        model: r.model,
        provider: r.provider,
        cost_usd: Number(r.cost_usd),
        tokens: Number(r.tokens),
      })),
      harnesses: (harnesses.results ?? []).map((r) => ({
        harness: r.harness,
        cost_usd: Number(r.cost_usd),
        tokens: Number(r.tokens),
        sessions: Number(r.sessions),
      })),
    };
  }
}
