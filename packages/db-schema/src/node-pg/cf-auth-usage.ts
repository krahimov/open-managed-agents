// Usage events (Node-PG variant of cf-auth/usage).
//
// On PG, INTEGER PRIMARY KEY AUTOINCREMENT becomes BIGSERIAL.

import { sql } from "drizzle-orm";
import { bigint, bigserial, doublePrecision, index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

// Per-model-call token usage (PG variant of cf-auth/usage model_usage_events).
// Source: apps/main-node/migrations/0009_model_usage_events.sql.
export const model_usage_events = pgTable(
  "model_usage_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    session_id: text("session_id").notNull(),
    agent_id: text("agent_id"),
    thread_id: text("thread_id").notNull(),
    turn_id: text("turn_id"),
    model_request_start_id: text("model_request_start_id").notNull(),
    model: text("model").notNull(),
    input_tokens: bigint("input_tokens", { mode: "number" }).notNull(),
    output_tokens: bigint("output_tokens", { mode: "number" }).notNull(),
    cache_read_input_tokens: bigint("cache_read_input_tokens", { mode: "number" }).notNull(),
    cache_creation_input_tokens: bigint("cache_creation_input_tokens", { mode: "number" }).notNull(),
    cost_usd: doublePrecision("cost_usd"),
    created_at: bigint("created_at", { mode: "number" }).notNull(),
    billed_at: bigint("billed_at", { mode: "number" }),
  },
  (t) => [
    uniqueIndex("idx_model_usage_events_call").on(t.session_id, t.model_request_start_id),
    index("idx_model_usage_events_tenant").on(t.tenant_id, t.created_at),
    index("idx_model_usage_events_agent").on(t.tenant_id, t.agent_id, t.created_at),
  ],
);

export const usage_events = pgTable(
  "usage_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    session_id: text("session_id").notNull(),
    agent_id: text("agent_id"),
    kind: text("kind").notNull(),
    value: bigint("value", { mode: "number" }).notNull(),
    created_at: bigint("created_at", { mode: "number" }).notNull(),
    billed_at: bigint("billed_at", { mode: "number" }),
  },
  (t) => [
    index("idx_usage_events_unbilled")
      .on(t.tenant_id, t.id)
      .where(sql`"billed_at" IS NULL`),
    index("idx_usage_events_session").on(t.session_id),
  ],
);
