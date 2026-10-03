// Node wiring for model usage recording + tenant budget inputs
// (docs/budgets.md).
//
// Per harness run:
//   - backfill model_usage_events rows the log implies but the table lacks
//     (crash between the span event persist and the row insert);
//   - record one row per span.model_request_end as it is persisted
//     (NodeHarnessRuntime.onPersisted — idempotent on model_request_start_id);
//   - hand the harness its budget context: tenant daily caps with today's
//     usage, and pricing overrides.

import type { SessionEvent } from "@open-managed-agents/shared";
import {
  SqlModelUsageStore,
  currentTurnIdOf,
  isUsageSpanEvent,
  parseModelPricingOverrides,
  startOfUtcDayMs,
  usageRowFromEvent,
  type HarnessBudgetContext,
  type ModelPricing,
} from "@open-managed-agents/session-runtime";
import type { SqlClient } from "@open-managed-agents/sql-client";
import { getLogger } from "@open-managed-agents/observability";

const log = getLogger("model-usage");

export interface NodeBudgetConfig {
  /** OMA_TENANT_DAILY_TOKEN_LIMIT — tokens per tenant per UTC day. */
  tenantDailyTokens: number | null;
  /** OMA_TENANT_DAILY_COST_USD_LIMIT — estimated USD per tenant per UTC day. */
  tenantDailyCostUsd: number | null;
  /** OMA_MODEL_PRICING — JSON `{ "<model>": { input_per_mtok, output_per_mtok, … } }`. */
  pricing: Record<string, ModelPricing> | null;
}

function positive(raw: string | undefined): number | null {
  if (!raw || !raw.trim()) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function resolveNodeBudgetConfig(env: NodeJS.ProcessEnv): NodeBudgetConfig {
  return {
    tenantDailyTokens: positive(env.OMA_TENANT_DAILY_TOKEN_LIMIT),
    tenantDailyCostUsd: positive(env.OMA_TENANT_DAILY_COST_USD_LIMIT),
    pricing: parseModelPricingOverrides(env.OMA_MODEL_PRICING),
  };
}

export interface ModelUsageRunHooks {
  /** Wire into NodeHarnessRuntime({ onPersisted }). */
  onPersisted(stored: SessionEvent): Promise<void>;
  /** HarnessContext.budget. */
  budget: HarnessBudgetContext;
}

export class NodeModelUsage {
  readonly store: SqlModelUsageStore;

  constructor(sql: SqlClient, private readonly config: NodeBudgetConfig) {
    this.store = new SqlModelUsageStore(sql);
  }

  /**
   * Backfill: insert every usage row the log implies that the table lacks
   * (crash between a usage span's persist and its row insert). Idempotent;
   * never throws. Runs at the start of every harness run (prepareRun) and
   * from SessionStateMachine.reconcileUsage when a turn is finalized from
   * the log without running the harness.
   */
  async reconcile(input: {
    tenantId: string;
    sessionId: string;
    agentId: string | null;
    events: SessionEvent[];
  }): Promise<number> {
    try {
      if (!input.events.some(isUsageSpanEvent)) return 0;
      const n = await this.store.recordFromEvents(input.events, {
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        agentId: input.agentId,
        pricing: this.config.pricing,
      });
      if (n > 0) {
        log.info({ op: "model_usage.backfill", session_id: input.sessionId, rows: n }, "backfilled model usage rows");
      }
      return n;
    } catch (err) {
      log.warn({ err, op: "model_usage.backfill_failed", session_id: input.sessionId }, "model usage backfill failed");
      return 0;
    }
  }

  async prepareRun(input: {
    tenantId: string;
    sessionId: string;
    agentId: string | null;
    /** The session log as the run starts (turn input already promoted). */
    events: SessionEvent[];
    threadId?: string;
  }): Promise<ModelUsageRunHooks> {
    const ctx = {
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      agentId: input.agentId,
      pricing: this.config.pricing,
    };
    await this.reconcile(input);
    const turnId = currentTurnIdOf(input.events, input.threadId ?? "sthr_primary");

    let tenant: HarnessBudgetContext["tenant"] = null;
    if (this.config.tenantDailyTokens !== null || this.config.tenantDailyCostUsd !== null) {
      try {
        tenant = {
          limits: {
            daily_tokens: this.config.tenantDailyTokens,
            daily_cost_usd: this.config.tenantDailyCostUsd,
          },
          used: await this.store.tenantTotalsSince(input.tenantId, startOfUtcDayMs()),
        };
      } catch (err) {
        log.warn({ err, op: "model_usage.tenant_totals_failed" }, "tenant usage lookup failed; daily caps skipped this turn");
      }
    }

    return {
      onPersisted: async (stored) => {
        if (!isUsageSpanEvent(stored)) return;
        const row = usageRowFromEvent(stored, { ...ctx, turnId });
        if (row) await this.store.record(row);
      },
      budget: { tenant, pricing: this.config.pricing },
    };
  }
}
