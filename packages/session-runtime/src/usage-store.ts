// Durable per-model-call usage rows (`model_usage_events`), one per
// `span.model_request_end` that carries `model_usage`. Shared by both
// runtimes over the SqlClient port (D1 / better-sqlite3 / postgres).
//
// Idempotency: rows are keyed by (session_id, model_request_start_id) and
// written with INSERT … ON CONFLICT DO NOTHING, so a crash/resume, a
// reconcile pass over the log, or a duplicate hook call never double
// counts. The event log stays the source of truth: recordFromEvents()
// backfills any row whose write was lost (crash between the event persist
// and the row insert).
//
// Separate from the resource-seconds `usage_events` table (hosted billing
// reads that one with its own rate map); this table carries tokens + an
// estimated cost and also has a billed_at column for the same reconcile
// pattern.

import type { SqlClient } from "@open-managed-agents/sql-client";
import type {
  AgentBudget,
  ModelUsageReport,
  ModelUsageTotals,
  SessionEvent,
} from "@open-managed-agents/shared";
import {
  estimateCostUsd,
  isTurnInputEvent,
  resolveModelPricing,
  spanUsageOf,
  type ModelPricing,
  type UsageTotals,
} from "./budget";

export interface ModelUsageRow {
  tenant_id: string;
  session_id: string;
  agent_id: string | null;
  thread_id: string;
  /** Id of the client input event that started the turn (null if unknown). */
  turn_id: string | null;
  model_request_start_id: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  cost_usd: number | null;
  created_at: number;
}

export interface UsageRowContext {
  tenantId: string;
  sessionId: string;
  agentId?: string | null;
  pricing?: Readonly<Record<string, ModelPricing>> | null;
}

function threadOf(e: SessionEvent): string {
  return (e as { session_thread_id?: string }).session_thread_id ?? "sthr_primary";
}

function timeOf(e: SessionEvent): number {
  const t = Date.parse(String((e as { processed_at?: string }).processed_at ?? ""));
  return Number.isFinite(t) ? t : Date.now();
}

/** Usage row for one span event. `turnId` = the turn's input event id. */
export function usageRowFromEvent(
  e: SessionEvent,
  ctx: UsageRowContext & { turnId?: string | null },
): ModelUsageRow | null {
  const u = spanUsageOf(e);
  if (!u || !u.model_request_start_id) return null;
  const model = u.model ?? "";
  const cost =
    typeof u.cost_usd === "number"
      ? u.cost_usd
      : u.cost_usd === null
        ? null
        : estimateCostUsd(u, resolveModelPricing(model, ctx.pricing));
  return {
    tenant_id: ctx.tenantId,
    session_id: ctx.sessionId,
    agent_id: ctx.agentId ?? null,
    thread_id: threadOf(e),
    turn_id: ctx.turnId ?? null,
    model_request_start_id: u.model_request_start_id,
    model,
    input_tokens: u.input_tokens,
    output_tokens: u.output_tokens,
    cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
    cost_usd: cost,
    created_at: timeOf(e),
  };
}

/** Every usage row the log implies, with turn ids resolved per thread. */
export function usageRowsFromEvents(events: SessionEvent[], ctx: UsageRowContext): ModelUsageRow[] {
  const turnByThread = new Map<string, string>();
  const out: ModelUsageRow[] = [];
  const seen = new Set<string>();
  for (const e of events) {
    if (isTurnInputEvent(e)) {
      const id = (e as { id?: string }).id;
      if (id) turnByThread.set(threadOf(e), id);
      continue;
    }
    const row = usageRowFromEvent(e, { ...ctx, turnId: turnByThread.get(threadOf(e)) ?? null });
    if (!row || seen.has(row.model_request_start_id)) continue;
    seen.add(row.model_request_start_id);
    out.push(row);
  }
  return out;
}

/** The current turn's input event id on `threadId` (last one in the log). */
export function currentTurnIdOf(events: SessionEvent[], threadId = "sthr_primary"): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (isTurnInputEvent(e) && threadOf(e) === threadId) return (e as { id?: string }).id ?? null;
  }
  return null;
}

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v) || 0);

interface AggRow {
  model?: string;
  model_calls: unknown;
  input_tokens: unknown;
  output_tokens: unknown;
  cache_read_input_tokens: unknown;
  cache_creation_input_tokens: unknown;
  cost_usd: unknown;
  priced_calls: unknown;
}

function totalsOf(r: AggRow | null | undefined): ModelUsageTotals {
  const calls = num(r?.model_calls);
  const priced = num(r?.priced_calls);
  const input = num(r?.input_tokens);
  const output = num(r?.output_tokens);
  return {
    model_calls: calls,
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: num(r?.cache_read_input_tokens),
    cache_creation_input_tokens: num(r?.cache_creation_input_tokens),
    total_tokens: input + output,
    cost_usd: priced > 0 ? Math.round(num(r?.cost_usd) * 1e6) / 1e6 : null,
    unpriced_calls: calls - priced,
  };
}

const AGG_COLUMNS = `COUNT(*) AS model_calls,
  SUM(input_tokens) AS input_tokens,
  SUM(output_tokens) AS output_tokens,
  SUM(cache_read_input_tokens) AS cache_read_input_tokens,
  SUM(cache_creation_input_tokens) AS cache_creation_input_tokens,
  SUM(cost_usd) AS cost_usd,
  COUNT(cost_usd) AS priced_calls`;

export class SqlModelUsageStore {
  constructor(private readonly sql: SqlClient) {}

  /** Insert one row; false when it already existed (idempotent). */
  async record(row: ModelUsageRow): Promise<boolean> {
    const r = await this.sql
      .prepare(
        `INSERT INTO model_usage_events
           (tenant_id, session_id, agent_id, thread_id, turn_id, model_request_start_id, model,
            input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
            cost_usd, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (session_id, model_request_start_id) DO NOTHING`,
      )
      .bind(
        row.tenant_id,
        row.session_id,
        row.agent_id,
        row.thread_id,
        row.turn_id,
        row.model_request_start_id,
        row.model,
        Math.max(0, Math.floor(row.input_tokens)),
        Math.max(0, Math.floor(row.output_tokens)),
        Math.max(0, Math.floor(row.cache_read_input_tokens)),
        Math.max(0, Math.floor(row.cache_creation_input_tokens)),
        row.cost_usd,
        row.created_at,
      )
      .run();
    const changes = (r as { meta?: { changes?: number } }).meta?.changes;
    return changes === undefined ? true : changes > 0;
  }

  /**
   * Backfill: insert every row the log implies that isn't stored yet.
   * One SELECT of the session's keys, then inserts for the missing ones.
   * Returns the number of rows inserted.
   */
  async recordFromEvents(events: SessionEvent[], ctx: UsageRowContext): Promise<number> {
    const rows = usageRowsFromEvents(events, ctx);
    if (rows.length === 0) return 0;
    const existing = await this.sql
      .prepare(`SELECT model_request_start_id FROM model_usage_events WHERE session_id = ?`)
      .bind(ctx.sessionId)
      .all<{ model_request_start_id: string }>();
    const have = new Set((existing.results ?? []).map((r) => r.model_request_start_id));
    let inserted = 0;
    for (const row of rows) {
      if (have.has(row.model_request_start_id)) continue;
      if (await this.record(row)) inserted++;
    }
    return inserted;
  }

  async sessionReport(tenantId: string, sessionId: string, budget?: AgentBudget | null): Promise<ModelUsageReport> {
    return this.report(`tenant_id = ? AND session_id = ?`, [tenantId, sessionId], { session_id: sessionId }, budget);
  }

  async agentReport(
    tenantId: string,
    agentId: string,
    opts: { sinceMs?: number; budget?: AgentBudget | null } = {},
  ): Promise<ModelUsageReport> {
    const since = opts.sinceMs ?? 0;
    return this.report(
      `tenant_id = ? AND agent_id = ? AND created_at >= ?`,
      [tenantId, agentId, since],
      { agent_id: agentId, ...(since > 0 ? { since: new Date(since).toISOString() } : {}) },
      opts.budget,
    );
  }

  /** Tenant usage since `sinceMs` (tenant daily caps). */
  async tenantTotalsSince(tenantId: string, sinceMs: number): Promise<UsageTotals> {
    const r = await this.sql
      .prepare(`SELECT ${AGG_COLUMNS} FROM model_usage_events WHERE tenant_id = ? AND created_at >= ?`)
      .bind(tenantId, sinceMs)
      .first<AggRow>();
    const t = totalsOf(r);
    return { tokens: t.total_tokens, cost_usd: t.cost_usd ?? 0 };
  }

  private async report(
    where: string,
    params: unknown[],
    scope: ModelUsageReport["scope"],
    budget?: AgentBudget | null,
  ): Promise<ModelUsageReport> {
    const total = await this.sql
      .prepare(`SELECT ${AGG_COLUMNS} FROM model_usage_events WHERE ${where}`)
      .bind(...params)
      .first<AggRow>();
    const byModel = await this.sql
      .prepare(`SELECT model, ${AGG_COLUMNS} FROM model_usage_events WHERE ${where} GROUP BY model ORDER BY model`)
      .bind(...params)
      .all<AggRow>();
    return {
      type: "model_usage",
      scope,
      totals: totalsOf(total),
      by_model: (byModel.results ?? []).map((r) => ({ model: String(r.model ?? ""), ...totalsOf(r) })),
      ...(budget !== undefined ? { budget } : {}),
    };
  }
}

/** Start of the current UTC day (tenant daily caps). */
export function startOfUtcDayMs(now = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
