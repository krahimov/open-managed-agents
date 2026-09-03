import { and, asc, eq, gte, lt } from "drizzle-orm";
import {
  asBuilder,
  atomicWrite,
  getAll,
  getOne,
  type OmaDb,
  type OmaDbBuilder,
  runOnce,
} from "@open-managed-agents/db-schema";
import {
  memories,
  memory_versions,
} from "@open-managed-agents/db-schema/cf-auth";
import { generateMemoryId } from "@open-managed-agents/shared";
import type {
  MemoryRepo,
  MemoryUpdateFields,
  NewMemoryRow,
  NewMemoryVersionInput,
} from "../ports";
import type { Actor, MemoryRow } from "../types";


/**
 * Drizzle implementation of {@link MemoryRepo}. Owns the SQL against
 * the `memories` (index only — no content column, see migration 0010) and
 * `memory_versions` tables.
 *
 * The `*WithVersion` methods batch the index update + audit row so they're
 * atomic in a single transaction. The `upsertFromEvent` / `deleteFromEvent`
 * methods are the queue consumer's entry points and must be idempotent
 * (R2 events deliver at-least-once).
 */
export type MemoryFileWrittenListener = (info: {
  storeId: string;
  path: string;
  actor: Actor;
}) => void;

export class SqlMemoryRepo implements MemoryRepo {
  private readonly db: OmaDbBuilder;
  private readonly writeListeners: MemoryFileWrittenListener[] = [];
  constructor(db: OmaDb) {
    this.db = asBuilder(db);
  }

  /**
   * Observe file writes that actually changed the index (memory-facts-design
   * §4 trigger B). Every reflection path — REST writeByPath, chokidar
   * watcher, CF queue consumer, S3 poller — converges on this repo, so one
   * listener covers them all. Listeners are fire-and-forget; errors are
   * swallowed so observability never blocks a write.
   */
  onFileWritten(listener: MemoryFileWrittenListener): () => void {
    this.writeListeners.push(listener);
    return () => {
      const i = this.writeListeners.indexOf(listener);
      if (i >= 0) this.writeListeners.splice(i, 1);
    };
  }

  private notifyWritten(info: { storeId: string; path: string; actor: Actor }): void {
    for (const l of this.writeListeners) {
      try {
        l(info);
      } catch {
        // observers never block writes
      }
    }
  }

  async createWithVersion(memory: NewMemoryRow, version: NewMemoryVersionInput): Promise<MemoryRow> {
    const insertMemoryQ = this.db.insert(memories).values({
      id: memory.id,
      store_id: memory.storeId,
      path: memory.path,
      content_sha256: memory.contentSha256,
      etag: memory.etag,
      size_bytes: memory.sizeBytes,
      created_at: memory.createdAt,
      updated_at: memory.updatedAt,
    });
    const insertVersionQ = versionInsertQuery(this.db, version);
    await atomicWrite(this.db, [insertMemoryQ, insertVersionQ]);

    const row = await this.findById(memory.storeId, memory.id);
    if (!row) throw new Error("memory vanished after createWithVersion");
    this.notifyWritten({ storeId: version.storeId, path: version.path, actor: version.actor });
    return row;
  }

  async updateWithVersion(
    memoryId: string,
    update: MemoryUpdateFields,
    version: NewMemoryVersionInput,
  ): Promise<MemoryRow> {
    const set: Record<string, unknown> = { updated_at: update.updatedAt };
    if (update.path !== undefined) set.path = update.path;
    if (update.contentSha256 !== undefined) set.content_sha256 = update.contentSha256;
    if (update.etag !== undefined) set.etag = update.etag;
    if (update.sizeBytes !== undefined) set.size_bytes = update.sizeBytes;

    const updateQ = this.db.update(memories).set(set).where(eq(memories.id, memoryId));
    const insertVersionQ = versionInsertQuery(this.db, version);
    await atomicWrite(this.db, [updateQ, insertVersionQ]);

    const row = await this.findById(version.storeId, memoryId);
    if (!row) throw new Error("memory vanished after updateWithVersion");
    if (version.operation !== "deleted") this.notifyWritten({ storeId: version.storeId, path: version.path, actor: version.actor });
    return row;
  }

  async deleteWithVersion(memoryId: string, version: NewMemoryVersionInput): Promise<void> {
    const deleteQ = this.db.delete(memories).where(eq(memories.id, memoryId));
    const insertVersionQ = versionInsertQuery(this.db, version);
    await atomicWrite(this.db, [deleteQ, insertVersionQ]);
  }

  async findByPath(storeId: string, path: string): Promise<MemoryRow | null> {
    const row = await getOne<typeof memories.$inferSelect>(
      this.db
        .select()
        .from(memories)
        .where(and(eq(memories.store_id, storeId), eq(memories.path, path))),
    );
    return row ? toRow(row) : null;
  }

  async findById(storeId: string, memoryId: string): Promise<MemoryRow | null> {
    const row = await getOne<typeof memories.$inferSelect>(
      this.db
        .select()
        .from(memories)
        .where(and(eq(memories.id, memoryId), eq(memories.store_id, storeId))),
    );
    return row ? toRow(row) : null;
  }

  async list(storeId: string, opts: { pathPrefix?: string }): Promise<MemoryRow[]> {
    const conds = [eq(memories.store_id, storeId)];
    if (opts.pathPrefix) {
      // SQLite range over UNIQUE(store_id, path) — uses the index, O(matched).
      const prefix = opts.pathPrefix;
      const upper =
        prefix.slice(0, -1) +
        String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
      conds.push(gte(memories.path, prefix));
      conds.push(lt(memories.path, upper));
    }
    const rows = await getAll<typeof memories.$inferSelect>(
      this.db.select().from(memories).where(and(...conds)).orderBy(asc(memories.path)),
    );
    return rows.map(toRow);
  }

  async upsertFromEvent(input: {
    storeId: string;
    path: string;
    contentSha256: string;
    etag: string;
    sizeBytes: number;
    actor: Actor;
    nowMs: number;
    versionId: string;
    content: string;
    memoryId?: string;
  }): Promise<{ wrote: boolean; row: MemoryRow | null }> {
    const existing = await this.findByPath(input.storeId, input.path);

    // Dedupe: same etag = same R2 object = same logical write. R2 events are
    // at-least-once; this guards against double-insert on redelivery.
    if (existing && existing.etag === input.etag) {
      return { wrote: false, row: existing };
    }

    if (existing) {
      const row = await this.updateWithVersion(
        existing.id,
        {
          contentSha256: input.contentSha256,
          etag: input.etag,
          sizeBytes: input.sizeBytes,
          updatedAt: input.nowMs,
        },
        {
          id: input.versionId,
          memoryId: existing.id,
          storeId: input.storeId,
          operation: "modified",
          path: input.path,
          content: input.content,
          contentSha256: input.contentSha256,
          sizeBytes: input.sizeBytes,
          actor: input.actor,
          createdAt: input.nowMs,
        },
      );
      this.notifyWritten({ storeId: input.storeId, path: input.path, actor: input.actor });
    return { wrote: true, row };
    }

    const memoryId = input.memoryId ?? generateMemoryId();
    const row = await this.createWithVersion(
      {
        id: memoryId,
        storeId: input.storeId,
        path: input.path,
        contentSha256: input.contentSha256,
        etag: input.etag,
        sizeBytes: input.sizeBytes,
        createdAt: input.nowMs,
        updatedAt: input.nowMs,
      },
      {
        id: input.versionId,
        memoryId,
        storeId: input.storeId,
        operation: "created",
        path: input.path,
        content: input.content,
        contentSha256: input.contentSha256,
        sizeBytes: input.sizeBytes,
        actor: input.actor,
        createdAt: input.nowMs,
      },
    );
    this.notifyWritten({ storeId: input.storeId, path: input.path, actor: input.actor });
    return { wrote: true, row };
  }

  async deleteFromEvent(input: {
    storeId: string;
    path: string;
    actor: Actor;
    nowMs: number;
    versionId: string;
  }): Promise<{ wrote: boolean }> {
    const existing = await this.findByPath(input.storeId, input.path);
    if (!existing) return { wrote: false };
    await this.deleteWithVersion(existing.id, {
      id: input.versionId,
      memoryId: existing.id,
      storeId: input.storeId,
      operation: "deleted",
      path: input.path,
      content: "",
      contentSha256: existing.content_sha256,
      sizeBytes: existing.size_bytes,
      actor: input.actor,
      createdAt: input.nowMs,
    });
    return { wrote: true };
  }
}

function versionInsertQuery(db: OmaDbBuilder, v: NewMemoryVersionInput) {
  return db.insert(memory_versions).values({
    id: v.id,
    memory_id: v.memoryId,
    store_id: v.storeId,
    operation: v.operation,
    path: v.path,
    content: v.content,
    content_sha256: v.contentSha256,
    size_bytes: v.sizeBytes,
    actor_type: v.actor.type,
    actor_id: v.actor.id,
    created_at: v.createdAt,
    redacted: 0,
  });
}

function msToIso(ms: number): string {
  return new Date(ms).toISOString();
}

function toRow(r: typeof memories.$inferSelect): MemoryRow {
  return {
    id: r.id,
    store_id: r.store_id,
    path: r.path,
    content_sha256: r.content_sha256,
    etag: r.etag ?? "",
    size_bytes: r.size_bytes,
    created_at: msToIso(r.created_at),
    updated_at: msToIso(r.updated_at),
  };
}
