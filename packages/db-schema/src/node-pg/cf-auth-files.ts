// Files + workspace_backups (Node-PG variant of cf-auth/files).
//
// workspace_backups reconciled with CF migration 0011 (2026-06-13): the
// shared node-workspace-backup code INSERTs (tenant_id, environment_id,
// backup_handle, created_at, expires_at, source_session_id) relying on an
// autoincrement id, and SELECTs backup_handle — the pre-0011 PG shape
// (text id, session_id, blob_key, size_bytes) 42703'd every backup query
// on Postgres, which failed session starts on prod. `files` was already
// aligned with cf-auth/files.

import { bigint, bigserial, index, pgTable, text } from "drizzle-orm/pg-core";

export const files = pgTable(
  "files",
  {
    id: text("id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    session_id: text("session_id"),
    scope: text("scope").notNull(),
    filename: text("filename").notNull(),
    media_type: text("media_type").notNull(),
    size_bytes: bigint("size_bytes", { mode: "number" }).notNull(),
    // Integer flag (NOT boolean) to mirror CF / source SQL.
    downloadable: bigint("downloadable", { mode: "number" }).notNull().default(0),
    r2_key: text("r2_key").notNull(),
    created_at: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("idx_files_tenant_created").on(t.tenant_id, t.created_at),
    index("idx_files_tenant_session_created").on(t.tenant_id, t.session_id, t.created_at),
    index("idx_files_session").on(t.session_id),
  ],
);

export const workspace_backups = pgTable(
  "workspace_backups",
  {
    id: bigserial("id", { mode: "number" }).primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    environment_id: text("environment_id").notNull(),
    // JSON: { id, dir, localBucket? } sandbox backup handle, stored as TEXT.
    backup_handle: text("backup_handle").notNull(),
    created_at: bigint("created_at", { mode: "number" }).notNull(),
    expires_at: bigint("expires_at", { mode: "number" }).notNull(),
    source_session_id: text("source_session_id"),
  },
  (t) => [
    index("idx_workspace_backups_scope_recent").on(
      t.tenant_id,
      t.environment_id,
      t.created_at,
    ),
    index("idx_workspace_backups_expires").on(t.expires_at),
  ],
);
