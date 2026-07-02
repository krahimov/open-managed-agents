// NodeSessionWakeups — durable schedule/cancel/list wakeups for Node
// sessions. Parity port of SessionDO.scheduleWakeup/cancelWakeup/listWakeups
// (apps/agent/src/runtime/session-do.ts) where the agents framework's DO
// alarms do the firing. On Node there is no alarm primitive, so wakeups
// live in a `session_wakeups` table and a scheduler job calls pump()
// every few seconds to fire due rows.
//
// Firing = enqueue a synthetic user.message through the session work
// queue (the same path POST /v1/sessions/:id/events takes), so ordering,
// crash recovery, and turn serialization all come for free. The event id
// is DETERMINISTIC (`sevt_wk_<row>_<fireAtMs>`), and the work queue has a
// unique (session_id, event_id) index — pump() enqueues FIRST and claims
// the row AFTER, so a crash between the two steps re-enqueues the same
// event id on the next tick and dedupes to exactly-once delivery.
//
// Cron rows never terminate: each claim advances fire_at to the next
// croner occurrence (fired_at records the last fire). One-shot rows set
// fired_at once. cancelled_at wins over everything. All schema shapes
// mirror node-session-work-queue.ts (ensureSchema owns its own DDL —
// no drizzle migration required).

import { nanoid } from "nanoid";
import { Cron } from "croner";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type { SessionEvent, UserMessageEvent } from "@open-managed-agents/shared";
import { generateEventId } from "@open-managed-agents/shared";
import { getLogger } from "@open-managed-agents/observability";

const log = getLogger("node-session-wakeups");

/** Same failsafe as SessionDO — cap pending wakeups per session so a cron
 *  misuse loop can't pile up unbounded schedules. */
export const MAX_PENDING_WAKEUPS = 20;

export interface ScheduleWakeupArgs {
  tenantId: string;
  sessionId: string;
  agentId: string;
  delay_seconds?: number;
  at?: string;
  cron?: string;
  prompt: string;
}

export interface WakeupRow {
  id: string;
  tenant_id: string;
  session_id: string;
  agent_id: string;
  kind: "one_shot" | "cron";
  cron: string | null;
  prompt: string;
  parent_event_id: string | null;
  fire_at: number;
  scheduled_at: number;
  fired_at: number | null;
  cancelled_at: number | null;
  fire_count: number;
}

export interface NodeSessionWakeupsDeps {
  sql: SqlClient;
  dialect: "sqlite" | "postgres";
  /** Enqueue a synthetic user.message into the session work queue and wake
   *  the drain. Must be idempotent on (sessionId, event.id). */
  enqueue(item: {
    tenantId: string;
    sessionId: string;
    agentId: string;
    event: UserMessageEvent;
  }): Promise<void>;
  /** Persist + publish a trajectory event (span.wakeup_scheduled). Optional
   *  so tests can skip event-log wiring. */
  persistEvent?(sessionId: string, event: SessionEvent): Promise<void>;
  /** Injectable clock for tests. */
  now?(): number;
  maxPending?: number;
}

export class NodeSessionWakeups {
  constructor(private readonly deps: NodeSessionWakeupsDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  async ensureSchema(): Promise<void> {
    const int = this.deps.dialect === "postgres" ? "BIGINT" : "INTEGER";
    await this.deps.sql.exec(`
      CREATE TABLE IF NOT EXISTS session_wakeups (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        cron TEXT,
        prompt TEXT NOT NULL,
        parent_event_id TEXT,
        fire_at ${int} NOT NULL,
        scheduled_at ${int} NOT NULL,
        fired_at ${int},
        cancelled_at ${int},
        fire_count ${int} NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_session_wakeups_due
        ON session_wakeups(cancelled_at, fire_at);
      CREATE INDEX IF NOT EXISTS idx_session_wakeups_session
        ON session_wakeups(session_id, cancelled_at);
    `);
  }

  /** Mirror of SessionDO.scheduleWakeup — same arg validation, same error
   *  strings (the schedule tool's description references them), same
   *  return shape, same span.wakeup_scheduled trajectory event. */
  async schedule(args: ScheduleWakeupArgs): Promise<{
    id: string;
    fire_at?: string;
    cron?: string;
    kind: "one_shot" | "cron";
  }> {
    const provided = [args.delay_seconds, args.at, args.cron].filter((x) => x != null);
    if (provided.length !== 1) {
      throw new Error("must provide exactly one of delay_seconds | at | cron");
    }
    if (!args.prompt || !args.prompt.trim()) {
      throw new Error("prompt is required");
    }

    const pending = await this.countPending(args.sessionId);
    const cap = this.deps.maxPending ?? MAX_PENDING_WAKEUPS;
    if (pending >= cap) {
      throw new Error(
        `pending wakeup cap reached (${pending}/${cap}); ` +
          `call list_schedules to inspect, cancel_schedule to free a slot`,
      );
    }

    const nowMs = this.now();
    let fireAt: number;
    let kind: "one_shot" | "cron";
    if (typeof args.delay_seconds === "number") {
      fireAt = nowMs + Math.max(1, Math.floor(args.delay_seconds)) * 1000;
      kind = "one_shot";
    } else if (args.at) {
      const d = new Date(args.at);
      if (Number.isNaN(d.getTime())) throw new Error(`invalid 'at' timestamp: ${args.at}`);
      fireAt = d.getTime();
      kind = "one_shot";
    } else {
      fireAt = nextCronFire(args.cron!, nowMs);
      kind = "cron";
    }

    const id = `swk_${nanoid(14)}`;
    const parentEventId = generateEventId();
    await this.deps.sql
      .prepare(
        `INSERT INTO session_wakeups
          (id, tenant_id, session_id, agent_id, kind, cron, prompt, parent_event_id, fire_at, scheduled_at, fire_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .bind(
        id,
        args.tenantId,
        args.sessionId,
        args.agentId,
        kind,
        kind === "cron" ? args.cron! : null,
        args.prompt,
        parentEventId,
        fireAt,
        nowMs,
      )
      .run();

    const fireAtIso = new Date(fireAt).toISOString();
    await this.deps.persistEvent?.(args.sessionId, {
      type: "span.wakeup_scheduled",
      id: parentEventId,
      schedule_id: id,
      fire_at: fireAtIso,
      cron: kind === "cron" ? args.cron : undefined,
      kind,
    } as unknown as SessionEvent);

    return {
      id,
      fire_at: fireAtIso,
      cron: kind === "cron" ? args.cron : undefined,
      kind,
    };
  }

  /** Mirror of SessionDO.cancelWakeup — false when unknown / already fired
   *  (one-shot) / already cancelled. */
  async cancel(sessionId: string, id: string): Promise<{ cancelled: boolean }> {
    if (!id) return { cancelled: false };
    const res = await this.deps.sql
      .prepare(
        `UPDATE session_wakeups SET cancelled_at = ?
         WHERE id = ? AND session_id = ? AND cancelled_at IS NULL
           AND (kind = 'cron' OR fired_at IS NULL)`,
      )
      .bind(this.now(), id, sessionId)
      .run();
    return { cancelled: (res.meta.changes ?? 0) > 0 };
  }

  /** Mirror of SessionDO.listWakeups. */
  async list(sessionId: string): Promise<
    Array<{ id: string; fire_at?: string; cron?: string; prompt: string; kind: "one_shot" | "cron" }>
  > {
    const r = await this.deps.sql
      .prepare(
        `SELECT id, kind, cron, prompt, fire_at FROM session_wakeups
         WHERE session_id = ? AND cancelled_at IS NULL
           AND (kind = 'cron' OR fired_at IS NULL)
         ORDER BY fire_at ASC`,
      )
      .bind(sessionId)
      .all<Pick<WakeupRow, "id" | "kind" | "cron" | "prompt" | "fire_at">>();
    return (r.results ?? []).map((row) => ({
      id: row.id,
      fire_at: new Date(row.fire_at).toISOString(),
      cron: row.cron ?? undefined,
      prompt: row.prompt,
      kind: row.kind,
    }));
  }

  private async countPending(sessionId: string): Promise<number> {
    const r = await this.deps.sql
      .prepare(
        `SELECT COUNT(*) AS n FROM session_wakeups
         WHERE session_id = ? AND cancelled_at IS NULL
           AND (kind = 'cron' OR fired_at IS NULL)`,
      )
      .bind(sessionId)
      .first<{ n: number }>();
    return Number(r?.n ?? 0);
  }

  /**
   * Fire every due wakeup. Called by the scheduler every few seconds.
   * Enqueue-first + optimistic claim on (id, fire_at) makes each fire
   * exactly-once even across replicas or a crash mid-tick (see header).
   * Returns the number of fires enqueued this tick.
   */
  async pump(limit = 50): Promise<number> {
    const nowMs = this.now();
    const due = await this.deps.sql
      .prepare(
        `SELECT id, tenant_id, session_id, agent_id, kind, cron, prompt, parent_event_id,
                fire_at, scheduled_at, fired_at, cancelled_at, fire_count
         FROM session_wakeups
         WHERE cancelled_at IS NULL AND fire_at <= ?
           AND (kind = 'cron' OR fired_at IS NULL)
         ORDER BY fire_at ASC
         LIMIT ?`,
      )
      .bind(nowMs, limit)
      .all<WakeupRow>();

    let fired = 0;
    for (const row of due.results ?? []) {
      try {
        const event: UserMessageEvent = {
          type: "user.message",
          // Deterministic per (row, occurrence) — the work queue's unique
          // (session_id, event_id) index turns retries into no-ops.
          id: `sevt_wk_${row.id}_${row.fire_at}`,
          content: [{ type: "text", text: row.prompt }],
          ...(row.parent_event_id ? { parent_event_id: row.parent_event_id } : {}),
          metadata: {
            harness: "schedule",
            kind: "wakeup",
            wakeup_kind: row.kind,
            scheduled_at: new Date(row.scheduled_at).toISOString(),
            fired_at: new Date(nowMs).toISOString(),
          },
        } as UserMessageEvent;

        await this.deps.enqueue({
          tenantId: row.tenant_id,
          sessionId: row.session_id,
          agentId: row.agent_id,
          event,
        });

        // Claim AFTER enqueue: optimistic on fire_at so two replicas racing
        // the same occurrence resolve to one advance; the loser's enqueue was
        // already deduped by event id.
        const claim =
          row.kind === "cron"
            ? await this.deps.sql
                .prepare(
                  `UPDATE session_wakeups
                   SET fire_at = ?, fired_at = ?, fire_count = fire_count + 1
                   WHERE id = ? AND fire_at = ? AND cancelled_at IS NULL`,
                )
                .bind(nextCronFire(row.cron!, nowMs), nowMs, row.id, row.fire_at)
                .run()
            : await this.deps.sql
                .prepare(
                  `UPDATE session_wakeups
                   SET fired_at = ?, fire_count = fire_count + 1
                   WHERE id = ? AND fire_at = ? AND fired_at IS NULL AND cancelled_at IS NULL`,
                )
                .bind(nowMs, row.id, row.fire_at)
                .run();
        if ((claim.meta.changes ?? 0) > 0) fired += 1;
      } catch (err) {
        log.warn(
          { err, op: "node_session_wakeups.fire_failed", wakeup_id: row.id, session_id: row.session_id },
          "wakeup fire failed; row stays due and retries next tick",
        );
      }
    }
    return fired;
  }
}

/** Next occurrence strictly after `afterMs`. Throws on unparseable cron —
 *  same failure surface the schedule tool's zod layer reports to the model. */
function nextCronFire(expr: string, afterMs: number): number {
  const next = new Cron(expr).nextRun(new Date(afterMs + 1000));
  if (!next) throw new Error(`cron expression never fires: ${expr}`);
  return next.getTime();
}
