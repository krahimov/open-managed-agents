// Usage events (CF SQLite / D1).
//
// Raw resource-usage event log. OSS owns this table; the hosted billing
// worker reads via /v1/internal/usage_events, applies its rate map,
// debits credit_ledger, then POSTs ack to flip billed_at.
//
// Source: apps/main/migrations/_archive/0017_usage_events.sql.

import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// Per-model-call token usage + estimated cost (docs/budgets.md). One row
// per span.model_request_end; idempotent on (session_id,
// model_request_start_id). Written by both runtimes via
// packages/session-runtime/src/usage-store.ts.
//
// Source: apps/main/migrations/0020_model_usage_events.sql.
export const model_usage_events = sqliteTable(
  "model_usage_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tenant_id: text("tenant_id").notNull(),
    session_id: text("session_id").notNull(),
    agent_id: text("agent_id"),
    thread_id: text("thread_id").notNull(),
    turn_id: text("turn_id"),
    model_request_start_id: text("model_request_start_id").notNull(),
    model: text("model").notNull(),
    input_tokens: integer("input_tokens").notNull(),
    output_tokens: integer("output_tokens").notNull(),
    cache_read_input_tokens: integer("cache_read_input_tokens").notNull(),
    cache_creation_input_tokens: integer("cache_creation_input_tokens").notNull(),
    cost_usd: real("cost_usd"),
    created_at: integer("created_at").notNull(),
    billed_at: integer("billed_at"),
  },
  (t) => [
    uniqueIndex("idx_model_usage_events_call").on(t.session_id, t.model_request_start_id),
    index("idx_model_usage_events_tenant").on(t.tenant_id, t.created_at),
    index("idx_model_usage_events_agent").on(t.tenant_id, t.agent_id, t.created_at),
  ],
);

export const usage_events = sqliteTable(
  "usage_events",
  {
    // INTEGER PRIMARY KEY AUTOINCREMENT.
    id: integer("id").primaryKey({ autoIncrement: true }),
    tenant_id: text("tenant_id").notNull(),
    session_id: text("session_id").notNull(),
    agent_id: text("agent_id"),
    kind: text("kind").notNull(),
    value: integer("value").notNull(),
    created_at: integer("created_at").notNull(),
    billed_at: integer("billed_at"),
  },
  (t) => [
    // Partial: keeps the listUnbilled scan O(unbilled).
    index("idx_usage_events_unbilled")
      .on(t.tenant_id, t.id)
      .where(sql`"billed_at" IS NULL`),
    index("idx_usage_events_session").on(t.session_id),
  ],
);
