// Memory tables (CF SQLite / D1).
//
// Tables:
//   memory_stores             — store rows. JSON-free.
//   memories                  — content-addressed entries. After the
//                               0010 alignment, content moved to R2
//                               and `etag` (R2 object etag) is the new
//                               CAS handle. NULL until back-fill —
//                               nullable on CF, NOT NULL on PG.
//   memory_versions           — append-only audit log.
//   memory_blob_poller_lease  — per-store advisory lease for the S3
//                               memory poller. Only the inline
//                               applySchema() ships this on CF; no
//                               _archive migration. Included because
//                               the barrel comment lists it.
//
// Sources:
//   apps/main/migrations/_archive/0001_schema.sql                 (base)
//   apps/main/migrations/_archive/0010_memory_anthropic_alignment.sql
//     (memories table rebuilt — drop content + vector_synced_at, add etag,
//      drop idx_memories_unsynced)
//   packages/schema/src/index.ts applyMemoryPollerSchema()        (lease)

import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const memory_stores = sqliteTable(
  "memory_stores",
  {
    id: text("id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at"),
    archived_at: integer("archived_at"),
  },
  (t) => [index("idx_memory_stores_tenant").on(t.tenant_id, t.created_at)],
);

export const memories = sqliteTable(
  "memories",
  {
    id: text("id").primaryKey().notNull(),
    store_id: text("store_id").notNull(),
    path: text("path").notNull(),
    content_sha256: text("content_sha256").notNull(),
    // CF: nullable post-0010 (back-filled by data migration). PG-side
    // intentionally NOT NULL — drift to be reconciled in Phase 3.
    etag: text("etag"),
    size_bytes: integer("size_bytes").notNull(),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("memories_store_id_path_unique").on(t.store_id, t.path),
    index("idx_memories_store_updated").on(t.store_id, t.updated_at),
  ],
);

export const memory_versions = sqliteTable(
  "memory_versions",
  {
    id: text("id").primaryKey().notNull(),
    memory_id: text("memory_id").notNull(),
    store_id: text("store_id").notNull(),
    operation: text("operation").notNull(),
    path: text("path"),
    content: text("content"),
    content_sha256: text("content_sha256"),
    size_bytes: integer("size_bytes"),
    actor_type: text("actor_type").notNull(),
    actor_id: text("actor_id").notNull(),
    created_at: integer("created_at").notNull(),
    // Raw integer 0/1 flag — NOT mode:"boolean" (matches baseline).
    redacted: integer("redacted").notNull().default(0),
  },
  (t) => [
    index("idx_memory_versions_memory").on(t.memory_id, t.created_at),
    index("idx_memory_versions_store").on(t.store_id, t.created_at),
  ],
);

export const memory_blob_poller_lease = sqliteTable("memory_blob_poller_lease", {
  store_id: text("store_id").primaryKey().notNull(),
  owner: text("owner").notNull(),
  expires_at: integer("expires_at").notNull(),
  last_seen_ms: integer("last_seen_ms").notNull().default(0),
});

/**
 * Indexed durable facts extracted from memory files / transcripts
 * (docs/memory-facts-design.md §3). Files stay the source of truth for
 * content; this is the queryable index behind memory_search / memory_get
 * and the per-turn push. Search: SQLite uses an FTS5 external-content
 * table (created in the migration, kept in sync by triggers); PG uses a
 * generated tsvector column. Both are invisible to Drizzle here.
 */
export const memory_facts = sqliteTable(
  "memory_facts",
  {
    id: text("id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    store_id: text("store_id").notNull(),
    agent_id: text("agent_id"),
    /** preference | decision | rule | entity | note */
    kind: text("kind").notNull(),
    subject: text("subject").notNull(),
    statement: text("statement").notNull(),
    applies_when: text("applies_when"),
    confidence: real("confidence").notNull().default(1),
    /** active | superseded | retracted */
    status: text("status").notNull().default("active"),
    supersedes_id: text("supersedes_id"),
    source_path: text("source_path"),
    source_session_id: text("source_session_id"),
    source_event_id: text("source_event_id"),
    observed_at: integer("observed_at").notNull(),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at").notNull(),
  },
  (t) => [
    index("idx_memory_facts_store_status").on(t.store_id, t.status, t.updated_at),
    index("idx_memory_facts_subject").on(t.store_id, t.subject),
    index("idx_memory_facts_source_session").on(t.source_session_id),
  ],
);

