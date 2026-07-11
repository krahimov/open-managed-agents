// Permission grants (CF SQLite / D1).
//
// Versioned, append-only access-policy documents per agent (and, from
// Phase 3, per principal). Every change writes a NEW row with version+1 —
// mirrors agent_versions so approvals have immutable lineage (who approved
// which rules, when). "Current" = highest version for the
// (tenant, agent, principal) key; a disabled current version means no
// policy (legacy allow-all). The rules JSON is the source of truth; hot
// columns keep resolution queries indexed.

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const permission_grants = sqliteTable(
  "permission_grants",
  {
    id: text("id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    agent_id: text("agent_id").notNull(),
    /** "baseline" | "role" | "user" — Phase 1 writes baseline only. */
    principal_type: text("principal_type").notNull(),
    /** Role name or user id; null for the baseline layer. */
    principal_id: text("principal_id"),
    /** JSON PermissionRule[] (see @open-managed-agents/api-types policy). */
    rules: text("rules").notNull(),
    version: integer("version").notNull(),
    enabled: integer("enabled").notNull(),
    /** Session id when the version came from an agent proposal (Phase 2). */
    proposed_by: text("proposed_by"),
    /** User id that ratified this version. Required on every write. */
    approved_by: text("approved_by").notNull(),
    created_at: integer("created_at").notNull(),
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
