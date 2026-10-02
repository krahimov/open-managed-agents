// NodeSessionWorkQueue — durable per-session turn queue for the Node runtime.
//
// Every queue-input event (user.message / user.tool_confirmation /
// user.custom_tool_result) becomes one row in `session_work_items`. The
// table doubles as the AMA pending queue: rows in status='pending' are
// what GET /v1/sessions/:id/pending lists, and the event only enters the
// session event log when its turn starts (SessionStateMachine promotes
// it) — so a message sent mid-turn can't interleave into the previous
// answer. Mirrors the CF pending_events design (ORDERING_DESIGN.md,
// DUAL_TABLE_DESIGN.md).
//
// Leases:
//   - Only the HEAD of a session's queue (oldest row that is pending or
//     running) may run. A claim is a conditional UPDATE of that head from
//     pending → running that also requires no OTHER running row for the
//     session; a partial unique index (one running row per session_id)
//     enforces that atomically even when two replicas see different heads
//     (Postgres late commits). A losing claim is simply "not claimable".
//   - Each claim bumps `lease_epoch` (fencing token). The running worker
//     heartbeats `locked_at` every heartbeatMs; completion/failure and
//     every event-log write (SqlEventLog.withGuard(appendGuardFor(item)))
//     are conditional on the epoch, so a worker whose lease was reclaimed
//     can neither complete the item nor append to the session history.
//   - A heartbeat that finds its lease gone aborts the local turn
//     ({kind:"lease_lost"}); one that finds `cancel_requested_at` set
//     (user.interrupt handled on another replica) aborts it as an
//     interrupt.
//
// Recovery policy (single, coherent — registry.bootstrap defers to it):
//   A running row whose lease went stale (process death, deploy overlap)
//   is reset to pending and re-run: the resumed turn reconciles the orphan
//   turn first (placeholders for cut-off streams/tools, via
//   SessionStateMachine recoverOrphans), finds its promoted event already
//   in the log, and continues. After `maxAttempts` claims the row is
//   dead-lettered (status='dead') and onAbandoned emits session.error.
//   A harness failure is NOT retried (status='failed'): the machine has
//   already surfaced session.error and the client decides.
//
// A periodic sweep (start()) reclaims stale leases across all sessions and
// wakes any session with runnable work, so recovery doesn't depend on a
// process restart or a new incoming event.

import { nanoid } from "nanoid";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type { SessionEvent } from "@open-managed-agents/shared";
import { generateEventId } from "@open-managed-agents/shared";
import type { AppendGuard } from "@open-managed-agents/event-log/sql";
import type { TurnAbortReason, TurnInputEvent } from "@open-managed-agents/session-runtime";
import { isTurnLeaseLost } from "@open-managed-agents/session-runtime";
import { getLogger } from "@open-managed-agents/observability";

const log = getLogger("node-session-work-queue");

export interface NodeSessionWorkItem {
  id: string;
  tenantId: string;
  sessionId: string;
  agentId: string;
  eventId: string;
  event: TurnInputEvent;
  /** Claims so far, including the current one. */
  attempts: number;
  /** Fencing token of the current claim. */
  leaseEpoch: number;
  pendingSeq: number;
}

export interface NodeSessionRunContext {
  /** Aborts on user.interrupt (local or cross-replica) and lease loss. */
  signal: AbortSignal;
  /** Fence for event-log writes made on behalf of this claim. */
  guard: AppendGuard;
}

export interface PendingWorkRow {
  pending_seq: number;
  enqueued_at: number;
  session_thread_id: string;
  type: string;
  event_id: string;
  cancelled_at: number | null;
  event: SessionEvent;
}

export interface NodeSessionWorkQueueDeps {
  sql: SqlClient;
  dialect: "sqlite" | "postgres";
  workerId?: string;
  /** Lease timeout; a running row not heartbeated for this long is stale. */
  staleAfterMs?: number;
  /** Heartbeat period. Default staleAfterMs / 6 (5s at the 30s default). */
  heartbeatMs?: number;
  /** Claims before a repeatedly-orphaned row is dead-lettered. Default 5. */
  maxAttempts?: number;
  /** Periodic stale-lease sweep period for start(). Default staleAfterMs / 2. */
  sweepIntervalMs?: number;
  run(item: NodeSessionWorkItem, ctx: NodeSessionRunContext): Promise<void>;
  onError?(item: NodeSessionWorkItem, err: unknown): Promise<void> | void;
  /** A row was given up on: dead-lettered after maxAttempts, or its
   *  interrupted owner died before finishing. Emit session.error /
   *  reconcile the session row here. */
  onAbandoned?(item: NodeSessionWorkItem, reason: "dead" | "cancelled"): Promise<void> | void;
}

const ITEM_COLUMNS =
  "id, tenant_id, session_id, agent_id, event_id, event_json, attempts, lease_epoch, pending_seq, status";

export class NodeSessionWorkQueue {
  private readonly workerId: string;
  private readonly staleAfterMs: number;
  private readonly heartbeatMs: number;
  private readonly maxAttempts: number;
  private readonly sweepIntervalMs: number;
  private readonly active = new Map<string, Promise<void>>();
  /** Abort handle of the item this process is running, per session. */
  private readonly running = new Map<string, AbortController>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  /** Set by stop(): no new claims (graceful shutdown). */
  private stopped = false;

  constructor(private readonly deps: NodeSessionWorkQueueDeps) {
    this.workerId = deps.workerId ?? `node_${process.pid}_${nanoid(8)}`;
    this.staleAfterMs = deps.staleAfterMs ?? 30_000;
    this.heartbeatMs = deps.heartbeatMs ?? Math.max(50, Math.floor(this.staleAfterMs / 6));
    this.maxAttempts = Math.max(1, deps.maxAttempts ?? 5);
    this.sweepIntervalMs = deps.sweepIntervalMs ?? Math.max(100, Math.floor(this.staleAfterMs / 2));
  }

  async ensureSchema(): Promise<void> {
    const big = this.deps.dialect === "postgres" ? "BIGINT" : "INTEGER";
    await this.deps.sql.exec(`
      CREATE TABLE IF NOT EXISTS session_work_items (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        event_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts ${big} NOT NULL DEFAULT 0,
        locked_by TEXT,
        locked_at ${big},
        last_error TEXT,
        created_at ${big} NOT NULL,
        updated_at ${big} NOT NULL,
        processed_at ${big},
        lease_epoch ${big} NOT NULL DEFAULT 0,
        pending_seq ${big},
        cancel_requested_at ${big}
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_session_work_items_event
        ON session_work_items(session_id, event_id);
      CREATE INDEX IF NOT EXISTS idx_session_work_items_pending
        ON session_work_items(status, session_id, created_at);
    `);
    // Idempotent column adds for tables created before leases/fencing.
    // Neither dialect has ADD COLUMN IF NOT EXISTS in our supported
    // versions; probe the catalog (same approach as event-log ensureSchema).
    const cols = await this.readColumns();
    if (!cols.has("lease_epoch")) {
      await this.deps.sql.exec(
        `ALTER TABLE session_work_items ADD COLUMN lease_epoch ${big} NOT NULL DEFAULT 0`,
      );
    }
    if (!cols.has("pending_seq")) {
      await this.deps.sql.exec(`ALTER TABLE session_work_items ADD COLUMN pending_seq ${big}`);
    }
    if (!cols.has("cancel_requested_at")) {
      await this.deps.sql.exec(
        `ALTER TABLE session_work_items ADD COLUMN cancel_requested_at ${big}`,
      );
    }
    // Session ownership invariant: at most ONE running item per session.
    // Claims also check it inline (NOT EXISTS), but under Postgres READ
    // COMMITTED two concurrent claims of different rows can both pass that
    // check; the partial unique index makes the second one fail (handled
    // as "not claimable" in claimNext). Both dialects support partial
    // indexes and IF NOT EXISTS.
    try {
      await this.deps.sql.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_session_work_items_one_running
           ON session_work_items(session_id) WHERE status = 'running'`,
      );
    } catch (err) {
      // Pre-existing duplicate running rows (only possible from the bug
      // this index prevents) block the build. Claims still enforce the
      // invariant via NOT EXISTS; the index is retried on next startup,
      // after the stale-lease sweep has reset the duplicates.
      log.warn(
        { err, op: "node_session_work_queue.running_index_failed" },
        "could not create one-running-item-per-session index; relying on claim-time check",
      );
    }
  }

  /**
   * Queue an event. Idempotent on (session_id, event id). Returns the
   * queue row's pending_seq / enqueue time for the pending notification,
   * and whether this call created the row.
   */
  async enqueue(input: {
    tenantId: string;
    sessionId: string;
    agentId: string;
    event: TurnInputEvent | SessionEvent;
  }): Promise<{ created: boolean; pendingSeq: number; enqueuedAt: number; eventId: string }> {
    const eventId = eventIdentity(input.event);
    const now = Date.now();
    const id = `sw_${nanoid(20)}`;
    // The queued copy carries the id the machine will promote it under, so
    // the log row and the queue row always agree.
    const eventJson = JSON.stringify({ ...input.event, id: eventId });

    // pending_seq = per-session MAX+1. Concurrent enqueues on Postgres can
    // mint the same value (and a late commit can sort ahead of a row that
    // already started); it's display/correlation metadata only — ordering
    // is the deterministic (pending_seq, created_at, id), and session
    // ownership never depends on it: claimNext only starts an item when no
    // other item of the session is running (NOT EXISTS + partial unique
    // index idx_session_work_items_one_running).
    const res = await this.deps.sql
      .prepare(
        `INSERT INTO session_work_items
          (id, tenant_id, session_id, agent_id, event_id, event_json, status, attempts,
           created_at, updated_at, lease_epoch, pending_seq)
         SELECT ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, 0, COALESCE(MAX(pending_seq), 0) + 1
           FROM session_work_items WHERE session_id = ?
         ON CONFLICT (session_id, event_id) DO NOTHING`,
      )
      .bind(id, input.tenantId, input.sessionId, input.agentId, eventId, eventJson, now, now, input.sessionId)
      .run();
    const row = await this.deps.sql
      .prepare(
        `SELECT id, pending_seq, created_at FROM session_work_items
          WHERE session_id = ? AND event_id = ?`,
      )
      .bind(input.sessionId, eventId)
      .first<{ id: string; pending_seq: number | null; created_at: number }>();
    return {
      created: (res.meta.changes ?? 0) > 0 && row?.id === id,
      pendingSeq: Number(row?.pending_seq ?? 0),
      enqueuedAt: Number(row?.created_at ?? now),
      eventId,
    };
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

  /** Reclaim stale leases everywhere, then wake every session with work. */
  async sweep(): Promise<void> {
    await this.reclaimStale(null);
    await this.wakeAll();
  }

  /** Start the periodic sweep (idempotent). The timer is unref'd. */
  start(): void {
    this.stopped = false;
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      void this.sweep().catch((err) =>
        log.warn({ err, op: "node_session_work_queue.sweep_failed" }, "work queue sweep failed"),
      );
    }, this.sweepIntervalMs);
    this.sweepTimer.unref?.();
  }

  /** Stop sweeping and claiming. Turns already running finish normally. */
  stop(): void {
    this.stopped = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  /**
   * user.interrupt: cancel every queued (not yet started) row for the
   * session and flag the running one so its owner aborts — immediately
   * when that's this process, on its next heartbeat otherwise.
   */
  async requestCancel(sessionId: string): Promise<{
    cancelled: PendingWorkRow[];
    runningCount: number;
  }> {
    const now = Date.now();
    const cancelledRows = await this.deps.sql
      .prepare(
        `UPDATE session_work_items
            SET status='cancelled', updated_at=?, processed_at=?
          WHERE session_id = ? AND status='pending'
          RETURNING event_id, event_json, pending_seq, created_at`,
      )
      .bind(now, now, sessionId)
      .all<{ event_id: string; event_json: string; pending_seq: number | null; created_at: number }>();
    const flagged = await this.deps.sql
      .prepare(
        `UPDATE session_work_items
            SET cancel_requested_at=?, updated_at=?
          WHERE session_id = ? AND status='running'`,
      )
      .bind(now, now, sessionId)
      .run();
    const local = this.running.get(sessionId);
    if (local) local.abort({ kind: "user_interrupt" } satisfies TurnAbortReason);
    return {
      cancelled: (cancelledRows.results ?? []).map((r) =>
        toPendingRow({ ...r, status: "cancelled", updated_at: now }),
      ),
      runningCount: flagged.meta.changes ?? 0,
    };
  }

  /** Rows not yet started (AMA GET /pending), oldest first. */
  async listPending(
    sessionId: string,
    opts: { includeCancelled?: boolean } = {},
  ): Promise<PendingWorkRow[]> {
    const statuses = opts.includeCancelled ? `('pending', 'cancelled')` : `('pending')`;
    const rows = await this.deps.sql
      .prepare(
        `SELECT event_id, event_json, pending_seq, created_at, status, updated_at
           FROM session_work_items
          WHERE session_id = ? AND status IN ${statuses}
          ORDER BY COALESCE(pending_seq, 0) ASC, created_at ASC, id ASC`,
      )
      .bind(sessionId)
      .all<{
        event_id: string;
        event_json: string;
        pending_seq: number | null;
        created_at: number;
        status: string;
        updated_at: number;
      }>();
    return (rows.results ?? []).map(toPendingRow);
  }

  /** True when a row for this event id exists (any status). */
  async hasEvent(sessionId: string, eventId: string): Promise<boolean> {
    const row = await this.deps.sql
      .prepare(`SELECT 1 AS one FROM session_work_items WHERE session_id = ? AND event_id = ?`)
      .bind(sessionId, eventId)
      .first<{ one: number }>();
    return !!row;
  }

  /** Fence clause for SqlEventLog.withGuard: holds while this claim does. */
  appendGuardFor(item: Pick<NodeSessionWorkItem, "id" | "leaseEpoch">): AppendGuard {
    return {
      clause: `SELECT 1 FROM session_work_items WHERE id = ? AND lease_epoch = ? AND status = 'running'`,
      params: [item.id, item.leaseEpoch],
    };
  }

  // ── internals ──────────────────────────────────────────────────────

  private async drain(sessionId: string): Promise<void> {
    while (true) {
      const item = await this.claimNext(sessionId);
      if (!item) return;
      const controller = new AbortController();
      this.running.set(sessionId, controller);
      const heartbeat = this.startHeartbeat(item, controller);
      try {
        await this.deps.run(item, { signal: controller.signal, guard: this.appendGuardFor(item) });
        heartbeat.stop();
        if (!(await this.markDone(item))) {
          log.warn(
            { op: "node_session_work_queue.lease_lost_on_complete", session_id: sessionId, work_id: item.id, epoch: item.leaseEpoch },
            "work item lease lost before completion; result discarded",
          );
          return;
        }
      } catch (err) {
        heartbeat.stop();
        if (isTurnLeaseLost(err) || isLeaseAbort(controller.signal)) {
          // Another worker owns the row now (or it will be reclaimed after
          // shutdown) — don't touch it, stop draining this session here.
          log.warn(
            { err, op: "node_session_work_queue.lease_lost", session_id: sessionId, work_id: item.id },
            "work item lease lost mid-turn",
          );
          return;
        }
        log.error(
          { err, op: "node_session_work_queue.item_failed", session_id: item.sessionId, work_id: item.id },
          "session work item failed",
        );
        if (await this.markFailed(item, err)) {
          await this.deps.onError?.(item, err);
        }
      } finally {
        heartbeat.stop();
        if (this.running.get(sessionId) === controller) this.running.delete(sessionId);
      }
    }
  }

  private startHeartbeat(
    item: NodeSessionWorkItem,
    controller: AbortController,
  ): { stop(): void } {
    let inFlight = false;
    let stopped = false;
    const beat = async () => {
      if (inFlight || stopped) return;
      inFlight = true;
      try {
        const now = Date.now();
        const row = await this.deps.sql
          .prepare(
            `UPDATE session_work_items SET locked_at=?, updated_at=?
              WHERE id = ? AND lease_epoch = ? AND status='running'
              RETURNING cancel_requested_at`,
          )
          .bind(now, now, item.id, item.leaseEpoch)
          .first<{ cancel_requested_at: number | null }>();
        if (stopped) return;
        if (!row) controller.abort({ kind: "lease_lost" } satisfies TurnAbortReason);
        else if (row.cancel_requested_at != null && !controller.signal.aborted) {
          controller.abort({ kind: "user_interrupt" } satisfies TurnAbortReason);
        }
      } catch (err) {
        // Transient DB hiccup: keep the turn; staleness is judged by the
        // next successful beat (or the lease expiring).
        log.warn({ err, op: "node_session_work_queue.heartbeat_failed", work_id: item.id }, "heartbeat failed");
      } finally {
        inFlight = false;
      }
    };
    const timer = setInterval(() => void beat(), this.heartbeatMs);
    timer.unref?.();
    return {
      stop: () => {
        stopped = true;
        clearInterval(timer);
      },
    };
  }

  /**
   * Stale-lease reclaim for one session (or all when null):
   *   - interrupted rows whose owner died → cancelled (the user asked to stop)
   *   - rows at the attempt cap → dead
   *   - the rest → pending (re-run by the next claim)
   */
  private async reclaimStale(sessionId: string | null): Promise<void> {
    const now = Date.now();
    const staleBefore = now - this.staleAfterMs;
    const scope = sessionId ? " AND session_id = ?" : "";
    const scoped = (...params: unknown[]) => (sessionId ? [...params, sessionId] : params);

    const cancelled = await this.deps.sql
      .prepare(
        `UPDATE session_work_items
            SET status='cancelled', locked_by=NULL, locked_at=NULL, updated_at=?, processed_at=?,
                last_error='owner died after user.interrupt'
          WHERE status='running' AND locked_at IS NOT NULL AND locked_at < ?
            AND cancel_requested_at IS NOT NULL${scope}
          RETURNING ${ITEM_COLUMNS}`,
      )
      .bind(...scoped(now, now, staleBefore))
      .all<WorkItemRow>();
    const dead = await this.deps.sql
      .prepare(
        `UPDATE session_work_items
            SET status='dead', locked_by=NULL, locked_at=NULL, updated_at=?, processed_at=?,
                last_error=?
          WHERE status='running' AND locked_at IS NOT NULL AND locked_at < ?
            AND attempts >= ?${scope}
          RETURNING ${ITEM_COLUMNS}`,
      )
      .bind(
        ...scoped(now, now, `lease expired after ${this.maxAttempts} attempt(s)`, staleBefore, this.maxAttempts),
      )
      .all<WorkItemRow>();
    await this.deps.sql
      .prepare(
        `UPDATE session_work_items
            SET status='pending', locked_by=NULL, locked_at=NULL, updated_at=?
          WHERE status='running' AND locked_at IS NOT NULL AND locked_at < ?${scope}`,
      )
      .bind(...scoped(now, staleBefore))
      .run();

    for (const row of cancelled.results ?? []) await this.abandon(toWorkItem(row), "cancelled");
    for (const row of dead.results ?? []) await this.abandon(toWorkItem(row), "dead");
  }

  private async abandon(item: NodeSessionWorkItem, reason: "dead" | "cancelled"): Promise<void> {
    log.error(
      { op: "node_session_work_queue.abandoned", session_id: item.sessionId, work_id: item.id, attempts: item.attempts, reason },
      "session work item abandoned",
    );
    try {
      await this.deps.onAbandoned?.(item, reason);
    } catch (err) {
      log.warn({ err, op: "node_session_work_queue.on_abandoned_failed", work_id: item.id }, "onAbandoned failed");
    }
  }

  private async claimNext(sessionId: string): Promise<NodeSessionWorkItem | null> {
    if (this.stopped) return null;
    await this.reclaimStale(sessionId);

    for (let i = 0; i < 5; i++) {
      // Head of the session queue. Only the head may run; if it's already
      // running (here or on another replica) there's nothing to claim.
      const head = await this.deps.sql
        .prepare(
          `SELECT ${ITEM_COLUMNS}
             FROM session_work_items
            WHERE session_id = ? AND status IN ('pending', 'running')
            ORDER BY COALESCE(pending_seq, 0) ASC, created_at ASC, id ASC
            LIMIT 1`,
        )
        .bind(sessionId)
        .first<WorkItemRow>();
      if (!head || head.status !== "pending") return null;

      const now = Date.now();
      if (Number(head.attempts ?? 0) >= this.maxAttempts) {
        const r = await this.deps.sql
          .prepare(
            `UPDATE session_work_items
                SET status='dead', updated_at=?, processed_at=?, last_error=?
              WHERE id = ? AND status='pending'`,
          )
          .bind(now, now, `gave up after ${head.attempts} attempt(s)`, head.id)
          .run();
        if ((r.meta.changes ?? 0) > 0) await this.abandon(toWorkItem(head), "dead");
        continue;
      }

      // Conditional on no OTHER running item for the session: sort order
      // alone can't guarantee single ownership (a late-committing enqueue
      // can sort ahead of a row that's already running). The partial
      // unique index backs this up atomically on Postgres.
      let claimed: { attempts: number; lease_epoch: number } | null;
      try {
        claimed = await this.deps.sql
          .prepare(
            `UPDATE session_work_items
                SET status='running', attempts=attempts + 1, lease_epoch=lease_epoch + 1,
                    locked_by=?, locked_at=?, updated_at=?, cancel_requested_at=NULL
              WHERE id = ? AND status='pending'
                AND NOT EXISTS (
                  SELECT 1 FROM session_work_items other
                   WHERE other.session_id = ? AND other.status = 'running' AND other.id <> ?
                )
              RETURNING attempts, lease_epoch`,
          )
          .bind(this.workerId, now, now, head.id, sessionId, head.id)
          .first<{ attempts: number; lease_epoch: number }>();
      } catch (err) {
        if (isUniqueViolation(err)) return null; // another item just started running
        throw err;
      }
      if (!claimed) {
        if (await this.hasRunning(sessionId)) return null;
        continue;
      }
      return {
        ...toWorkItem(head),
        attempts: Number(claimed.attempts),
        leaseEpoch: Number(claimed.lease_epoch),
      };
    }

    return null;
  }

  private async hasRunning(sessionId: string): Promise<boolean> {
    const row = await this.deps.sql
      .prepare(
        `SELECT 1 AS one FROM session_work_items WHERE session_id = ? AND status = 'running' LIMIT 1`,
      )
      .bind(sessionId)
      .first<{ one: number }>();
    return !!row;
  }

  private async markDone(item: NodeSessionWorkItem): Promise<boolean> {
    const now = Date.now();
    const r = await this.deps.sql
      .prepare(
        `UPDATE session_work_items
         SET status='done', locked_by=NULL, locked_at=NULL, updated_at=?, processed_at=?
         WHERE id = ? AND lease_epoch = ? AND status='running'`,
      )
      .bind(now, now, item.id, item.leaseEpoch)
      .run();
    return (r.meta.changes ?? 0) > 0;
  }

  private async markFailed(item: NodeSessionWorkItem, err: unknown): Promise<boolean> {
    const now = Date.now();
    const r = await this.deps.sql
      .prepare(
        `UPDATE session_work_items
         SET status='failed', locked_by=NULL, locked_at=NULL, updated_at=?, processed_at=?, last_error=?
         WHERE id = ? AND lease_epoch = ? AND status='running'`,
      )
      .bind(now, now, errorMessage(err), item.id, item.leaseEpoch)
      .run();
    return (r.meta.changes ?? 0) > 0;
  }

  private async readColumns(): Promise<Set<string>> {
    const cols = new Set<string>();
    const r =
      this.deps.dialect === "postgres"
        ? await this.deps.sql
            .prepare(
              `SELECT column_name AS name FROM information_schema.columns
                WHERE table_name = 'session_work_items'`,
            )
            .all<{ name: string }>()
        : await this.deps.sql.prepare(`PRAGMA table_info(session_work_items)`).all<{ name: string }>();
    for (const row of r.results ?? []) cols.add(row.name);
    return cols;
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
  lease_epoch: number;
  pending_seq: number | null;
  status: string;
}

function toWorkItem(row: WorkItemRow): NodeSessionWorkItem {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    sessionId: row.session_id,
    agentId: row.agent_id,
    eventId: row.event_id,
    event: JSON.parse(row.event_json) as TurnInputEvent,
    attempts: Number(row.attempts ?? 0),
    leaseEpoch: Number(row.lease_epoch ?? 0),
    pendingSeq: Number(row.pending_seq ?? 0),
  };
}

function toPendingRow(row: {
  event_id: string;
  event_json: string;
  pending_seq: number | null;
  created_at: number;
  status: string;
  updated_at: number;
}): PendingWorkRow {
  let event: SessionEvent;
  try {
    event = JSON.parse(row.event_json) as SessionEvent;
  } catch {
    event = { type: "user.message", content: [] } as unknown as SessionEvent;
  }
  return {
    pending_seq: Number(row.pending_seq ?? 0),
    enqueued_at: Number(row.created_at),
    session_thread_id:
      (event as { session_thread_id?: string }).session_thread_id ?? "sthr_primary",
    type: event.type,
    event_id: row.event_id,
    cancelled_at: row.status === "cancelled" ? Number(row.updated_at) : null,
    event,
  };
}

/** Unique-constraint violation from either driver (SQLite / Postgres 23505). */
function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown; cause?: unknown } | null;
  if (!e || typeof e !== "object") return false;
  if (e.code === "23505" || e.code === "SQLITE_CONSTRAINT_UNIQUE") return true;
  const msg = typeof e.message === "string" ? e.message : "";
  if (/UNIQUE constraint failed|duplicate key value violates unique constraint/i.test(msg)) return true;
  return e.cause !== undefined && e.cause !== err ? isUniqueViolation(e.cause) : false;
}

function isLeaseAbort(signal: AbortSignal): boolean {
  if (!signal.aborted) return false;
  const kind = (signal.reason as { kind?: string } | undefined)?.kind;
  return kind === "lease_lost" || kind === "shutdown";
}

function eventIdentity(event: SessionEvent | TurnInputEvent): string {
  const withMeta = event as SessionEvent & { id?: string; seq?: number };
  if (withMeta.id) return withMeta.id;
  if (typeof withMeta.seq === "number") return `seq:${withMeta.seq}`;
  return generateEventId();
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 4000);
  return String(err).slice(0, 4000);
}
