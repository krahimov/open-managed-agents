import { nanoid } from "nanoid";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type { SessionEvent, UserMessageEvent } from "@open-managed-agents/shared";
import { getLogger } from "@open-managed-agents/observability";

const log = getLogger("node-session-work-queue");

export interface NodeSessionWorkItem {
  id: string;
  tenantId: string;
  sessionId: string;
  agentId: string;
  eventId: string;
  event: UserMessageEvent;
  attempts: number;
}

export interface NodeSessionWorkQueueDeps {
  sql: SqlClient;
  dialect: "sqlite" | "postgres";
  workerId?: string;
  staleAfterMs?: number;
  run(item: NodeSessionWorkItem): Promise<void>;
  onError?(item: NodeSessionWorkItem, err: unknown): Promise<void> | void;
}

export class NodeSessionWorkQueue {
  private readonly workerId: string;
  private readonly staleAfterMs: number;
  private readonly active = new Map<string, Promise<void>>();

  constructor(private readonly deps: NodeSessionWorkQueueDeps) {
    this.workerId = deps.workerId ?? `node_${process.pid}_${nanoid(8)}`;
    this.staleAfterMs = deps.staleAfterMs ?? 30_000;
  }

  async ensureSchema(): Promise<void> {
    if (this.deps.dialect === "postgres") {
      await this.deps.sql.exec(`
        CREATE TABLE IF NOT EXISTS session_work_items (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          event_id TEXT NOT NULL,
          event_json TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          attempts BIGINT NOT NULL DEFAULT 0,
          locked_by TEXT,
          locked_at BIGINT,
          last_error TEXT,
          created_at BIGINT NOT NULL,
          updated_at BIGINT NOT NULL,
          processed_at BIGINT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_session_work_items_event
          ON session_work_items(session_id, event_id);
        CREATE INDEX IF NOT EXISTS idx_session_work_items_pending
          ON session_work_items(status, session_id, created_at);
      `);
      return;
    }

    await this.deps.sql.exec(`
      CREATE TABLE IF NOT EXISTS session_work_items (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        event_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        locked_by TEXT,
        locked_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        processed_at INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_session_work_items_event
        ON session_work_items(session_id, event_id);
      CREATE INDEX IF NOT EXISTS idx_session_work_items_pending
        ON session_work_items(status, session_id, created_at);
    `);
  }

  async enqueue(input: {
    tenantId: string;
    sessionId: string;
    agentId: string;
    event: UserMessageEvent | SessionEvent;
  }): Promise<void> {
    const eventId = eventIdentity(input.event);
    const now = Date.now();
    const id = `sw_${nanoid(20)}`;
    const eventJson = JSON.stringify(input.event);

    if (this.deps.dialect === "postgres") {
      await this.deps.sql
        .prepare(
          `INSERT INTO session_work_items
            (id, tenant_id, session_id, agent_id, event_id, event_json, status, attempts, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
           ON CONFLICT (session_id, event_id) DO NOTHING`,
        )
        .bind(id, input.tenantId, input.sessionId, input.agentId, eventId, eventJson, now, now)
        .run();
    } else {
      await this.deps.sql
        .prepare(
          `INSERT OR IGNORE INTO session_work_items
            (id, tenant_id, session_id, agent_id, event_id, event_json, status, attempts, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
        )
        .bind(id, input.tenantId, input.sessionId, input.agentId, eventId, eventJson, now, now)
        .run();
    }
  }

  wake(sessionId: string): Promise<void> {
    const existing = this.active.get(sessionId);
    if (existing) return existing;
    const running = this.drain(sessionId).finally(() => {
      this.active.delete(sessionId);
    });
    this.active.set(sessionId, running);
    return running;
  }

  async wakeAll(): Promise<void> {
    const rows = await this.deps.sql
      .prepare(
        `SELECT DISTINCT session_id FROM session_work_items
         WHERE status IN ('pending', 'running')`,
      )
      .all<{ session_id: string }>();
    await Promise.all((rows.results ?? []).map((row) => this.wake(row.session_id)));
  }

  private async drain(sessionId: string): Promise<void> {
    while (true) {
      const item = await this.claimNext(sessionId);
      if (!item) return;
      try {
        await this.deps.run(item);
        await this.markDone(item.id);
      } catch (err) {
        log.error(
          { err, op: "node_session_work_queue.item_failed", session_id: item.sessionId, work_id: item.id },
          "session work item failed",
        );
        await this.markFailed(item.id, err);
        await this.deps.onError?.(item, err);
      }
    }
  }

  private async claimNext(sessionId: string): Promise<NodeSessionWorkItem | null> {
    const now = Date.now();
    const staleBefore = now - this.staleAfterMs;
    await this.deps.sql
      .prepare(
        `UPDATE session_work_items
         SET status='pending', locked_by=NULL, locked_at=NULL, updated_at=?
         WHERE session_id = ? AND status='running' AND locked_at IS NOT NULL AND locked_at < ?`,
      )
      .bind(now, sessionId, staleBefore)
      .run();

    for (let i = 0; i < 3; i++) {
      const row = await this.deps.sql
        .prepare(
          `SELECT id, tenant_id, session_id, agent_id, event_id, event_json, attempts
           FROM session_work_items
           WHERE session_id = ? AND status='pending'
           ORDER BY created_at ASC, id ASC
           LIMIT 1`,
        )
        .bind(sessionId)
        .first<WorkItemRow>();
      if (!row) return null;

      const claimed = await this.deps.sql
        .prepare(
          `UPDATE session_work_items
           SET status='running', attempts=attempts + 1, locked_by=?, locked_at=?, updated_at=?
           WHERE id = ? AND status='pending'`,
        )
        .bind(this.workerId, now, now, row.id)
        .run();
      if ((claimed.meta.changes ?? 0) === 0) continue;
      return toWorkItem(row);
    }

    return null;
  }

  private async markDone(id: string): Promise<void> {
    const now = Date.now();
    await this.deps.sql
      .prepare(
        `UPDATE session_work_items
         SET status='done', locked_by=NULL, locked_at=NULL, updated_at=?, processed_at=?
         WHERE id = ?`,
      )
      .bind(now, now, id)
      .run();
  }

  private async markFailed(id: string, err: unknown): Promise<void> {
    const now = Date.now();
    await this.deps.sql
      .prepare(
        `UPDATE session_work_items
         SET status='failed', locked_by=NULL, locked_at=NULL, updated_at=?, processed_at=?, last_error=?
         WHERE id = ?`,
      )
      .bind(now, now, errorMessage(err), id)
      .run();
  }
}

interface WorkItemRow {
  id: string;
  tenant_id: string;
  session_id: string;
  agent_id: string;
  event_id: string;
  event_json: string;
  attempts: number;
}

function toWorkItem(row: WorkItemRow): NodeSessionWorkItem {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    sessionId: row.session_id,
    agentId: row.agent_id,
    eventId: row.event_id,
    event: JSON.parse(row.event_json) as UserMessageEvent,
    attempts: Number(row.attempts ?? 0) + 1,
  };
}

function eventIdentity(event: SessionEvent | UserMessageEvent): string {
  const withMeta = event as SessionEvent & { id?: string; seq?: number };
  if (withMeta.id) return withMeta.id;
  if (typeof withMeta.seq === "number") return `seq:${withMeta.seq}`;
  return `event:${nanoid(20)}`;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 4000);
  return String(err).slice(0, 4000);
}
