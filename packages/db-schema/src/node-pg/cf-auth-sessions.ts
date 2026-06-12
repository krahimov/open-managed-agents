// Sessions (Node-PG variant of cf-auth/sessions).

import { sql } from "drizzle-orm";
import { bigint, index, pgTable, primaryKey, text } from "drizzle-orm/pg-core";

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    // Mirror packages/schema/src/index.ts which leaves agent_id /
    // environment_id NULLABLE on the Node-PG path. CF SQLite forces
    // NOT NULL — Phase 3 reconciliation will pick a winner.
    agent_id: text("agent_id"),
    environment_id: text("environment_id"),
    status: text("status").notNull(),
    title: text("title"),
    vault_ids: text("vault_ids"),
    agent_snapshot: text("agent_snapshot"),
    environment_snapshot: text("environment_snapshot"),
    metadata: text("metadata"),
    turn_id: text("turn_id"),
    turn_started_at: bigint("turn_started_at", { mode: "number" }),
    created_at: bigint("created_at", { mode: "number" }).notNull(),
    updated_at: bigint("updated_at", { mode: "number" }),
    archived_at: bigint("archived_at", { mode: "number" }),
    terminated_at: bigint("terminated_at", { mode: "number" }),
  },
  (t) => [
    index("idx_sessions_status").on(t.status, t.tenant_id),
    index("idx_sessions_tenant_archived").on(t.tenant_id, t.archived_at),
    index("idx_sessions_running").on(t.tenant_id, t.id).where(sql`"status" = 'running'`),
    index("idx_sessions_terminated")
      .on(t.tenant_id, t.terminated_at)
      .where(sql`"terminated_at" IS NOT NULL`),
  ],
);

export const session_resources = pgTable(
  "session_resources",
  {
    // Reconciled with cf-auth/sessions (2026-06-13): the shared
    // sql-session-repo reads/writes a single JSON `config` blob — the old
    // exploded-typed-columns PG shape 42703'd every resource insert, so
    // attaching files/repos/memory stores to sessions never worked on PG.
    id: text("id").primaryKey().notNull(),
    session_id: text("session_id").notNull(),
    type: text("type").notNull(),
    config: text("config").notNull(),
    created_at: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("idx_session_resources_session").on(t.session_id, t.created_at),
    index("idx_session_resources_session_type").on(t.session_id, t.type),
  ],
);

export const session_memory_stores = pgTable(
  "session_memory_stores",
  {
    session_id: text("session_id").notNull(),
    store_id: text("store_id").notNull(),
    access: text("access").notNull().default("read_write"),
    created_at: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.session_id, t.store_id] })],
);
