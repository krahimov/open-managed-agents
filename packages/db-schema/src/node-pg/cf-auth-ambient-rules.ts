// Ambient rules (Node-PG variant of cf-auth/ambient-rules).

import { bigint, index, integer, pgTable, text } from "drizzle-orm/pg-core";

export const ambient_rules = pgTable(
  "ambient_rules",
  {
    id: text("id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    agent_id: text("agent_id").notNull(),
    config: text("config").notNull(),
    enabled: integer("enabled").notNull(),
    trigger_source: text("trigger_source").notNull(),
    wake_mode: text("wake_mode").notNull(),
    created_at: bigint("created_at", { mode: "number" }).notNull(),
    updated_at: bigint("updated_at", { mode: "number" }),
    next_wake_at: bigint("next_wake_at", { mode: "number" }),
    last_wake_at: bigint("last_wake_at", { mode: "number" }),
    deleted_at: bigint("deleted_at", { mode: "number" }),
  },
  (t) => [
    index("idx_ambient_rules_tenant_agent").on(t.tenant_id, t.agent_id, t.deleted_at),
    index("idx_ambient_rules_due").on(t.tenant_id, t.enabled, t.next_wake_at),
    index("idx_ambient_rules_source").on(t.tenant_id, t.trigger_source, t.enabled),
  ],
);
