// Permission grants (Node-PG variant of cf-auth/permission-grants).

import { bigint, index, integer, pgTable, text } from "drizzle-orm/pg-core";

export const permission_grants = pgTable(
  "permission_grants",
  {
    id: text("id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    agent_id: text("agent_id").notNull(),
    principal_type: text("principal_type").notNull(),
    principal_id: text("principal_id"),
    rules: text("rules").notNull(),
    version: integer("version").notNull(),
    enabled: integer("enabled").notNull(),
    proposed_by: text("proposed_by"),
    approved_by: text("approved_by").notNull(),
    created_at: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("idx_permission_grants_key").on(
      t.tenant_id,
      t.agent_id,
      t.principal_type,
      t.principal_id,
      t.version,
    ),
  ],
);
