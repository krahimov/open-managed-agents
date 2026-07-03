// Ambient rules (CF SQLite / D1).
//
// Rules describe when an agent may wake in the background: schedules,
// webhooks, app events, and future observation feeds. The config JSON is the
// source of truth; hot columns keep scheduler and list queries indexed.

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const ambient_rules = sqliteTable(
  "ambient_rules",
  {
    id: text("id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    agent_id: text("agent_id").notNull(),
    config: text("config").notNull(),
    enabled: integer("enabled").notNull(),
    trigger_source: text("trigger_source").notNull(),
    wake_mode: text("wake_mode").notNull(),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at"),
    next_wake_at: integer("next_wake_at"),
    last_wake_at: integer("last_wake_at"),
    deleted_at: integer("deleted_at"),
  },
  (t) => [
    index("idx_ambient_rules_tenant_agent").on(t.tenant_id, t.agent_id, t.deleted_at),
    index("idx_ambient_rules_due").on(t.tenant_id, t.enabled, t.next_wake_at),
    index("idx_ambient_rules_source").on(t.tenant_id, t.trigger_source, t.enabled),
  ],
);
