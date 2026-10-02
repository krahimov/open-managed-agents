// Durability contracts for the Node turn pipeline:
//   - SqlEventLog.appendAsync returns the stored row, fences on a guard,
//     and surfaces write failures
//   - NodeSessionWorkQueue leases: heartbeat keeps a long turn owned,
//     a stale epoch can neither complete nor write events, repeated
//     orphaning dead-letters, user.interrupt cancels queued rows and
//     reaches the running turn through the lease.

import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { BetterSqlite3SqlClient } from "@open-managed-agents/sql-client/adapters/better-sqlite3";
import type { SqlClient } from "@open-managed-agents/sql-client";
import {
  SqlEventLog,
  ensureSchema as ensureEventLogSchema,
} from "@open-managed-agents/event-log/sql";
import type { SessionEvent, UserMessageEvent } from "@open-managed-agents/shared";
import {
  NodeSessionWorkQueue,
  type NodeSessionWorkItem,
  type NodeSessionRunContext,
} from "../src/lib/node-session-work-queue";

const SID = "sess_lease";

function stamp(e: SessionEvent) {
  (e as { id?: string }).id ??= `sevt-${Math.random().toString(36).slice(2)}`;
}

async function setup() {
  const db = new Database(":memory:");
  const sql: SqlClient = new BetterSqlite3SqlClient(db);
  await ensureEventLogSchema(sql, "sqlite");
  return { db, sql, log: new SqlEventLog(sql, SID, stamp) };
}

const msg = (id: string): UserMessageEvent =>
  ({ type: "user.message", id, content: [{ type: "text", text: id }] }) as unknown as UserMessageEvent;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("SqlEventLog.appendAsync", () => {
  it("returns the stored event with its seq and supports id lookup", async () => {
    const { log } = await setup();
    const a = await log.appendAsync({ type: "agent.message", content: [] } as unknown as SessionEvent);
    const b = await log.appendAsync({ type: "agent.message", id: "sevt-b", content: [] } as unknown as SessionEvent);
    expect((a as { seq?: number }).seq).toBe(1);
    expect(b).toMatchObject({ seq: 2, id: "sevt-b", type: "agent.message", session_thread_id: "sthr_primary" });
    expect(await log.findEventByIdAsync("sevt-b")).toMatchObject({ seq: 2 });
    expect(await log.hasEventAsync("nope")).toBe(false);
  });

  it("rejects writes whose guard no longer holds", async () => {
    const { sql, log } = await setup();
    await sql.exec(`CREATE TABLE fence (id TEXT PRIMARY KEY, epoch INTEGER)`);
    await sql.prepare(`INSERT INTO fence VALUES ('w', 1)`).run();
    const fenced = log.withGuard({ clause: `SELECT 1 FROM fence WHERE id = ? AND epoch = ?`, params: ["w", 1] });
    await fenced.appendAsync({ type: "agent.message", content: [] } as unknown as SessionEvent);
    await sql.prepare(`UPDATE fence SET epoch = 2`).run();
    await expect(
      fenced.appendAsync({ type: "agent.message", content: [] } as unknown as SessionEvent),
    ).rejects.toMatchObject({ code: "append_rejected" });
    expect(await log.getEventsAsync()).toHaveLength(1);
  });

  it("propagates driver failures from appendAsync and from sync append via flush", async () => {
    const { db, log } = await setup();
    db.exec(`DROP TABLE session_events`);
    await expect(
      log.appendAsync({ type: "agent.message", content: [] } as unknown as SessionEvent),
    ).rejects.toThrow(/session_events/);
    log.append({ type: "agent.message", content: [] } as unknown as SessionEvent);
    await expect(log.flush()).rejects.toThrow(/session_events/);
  });
});

describe("NodeSessionWorkQueue leases", () => {
  const queues: NodeSessionWorkQueue[] = [];
  afterEach(() => {
    for (const q of queues.splice(0)) q.stop();
  });

  function queue(
    sql: SqlClient,
    run: (item: NodeSessionWorkItem, ctx: NodeSessionRunContext) => Promise<void>,
    extra: Partial<ConstructorParameters<typeof NodeSessionWorkQueue>[0]> = {},
  ) {
    const q = new NodeSessionWorkQueue({ sql, dialect: "sqlite", run, ...extra });
    queues.push(q);
    return q;
  }

  it("heartbeats keep a turn longer than the lease owned by its worker", async () => {
    const { sql } = await setup();
    let runs = 0;
    const slow = async () => {
      runs++;
      await sleep(700);
    };
    const a = queue(sql, slow, { workerId: "A", staleAfterMs: 200, heartbeatMs: 40 });
    const b = queue(sql, slow, { workerId: "B", staleAfterMs: 200, heartbeatMs: 40 });
    await a.ensureSchema();
    await a.enqueue({ tenantId: "t", sessionId: SID, agentId: "ag", event: msg("m1") });

    const running = a.wake(SID);
    // Another replica keeps trying to claim well past the lease timeout.
    for (let i = 0; i < 5; i++) {
      await sleep(120);
      await b.wake(SID);
    }
    await running;
    expect(runs).toBe(1);
    const row = await sql
      .prepare(`SELECT status, attempts FROM session_work_items`)
      .first<{ status: string; attempts: number }>();
    expect(row).toEqual({ status: "done", attempts: 1 });
  });

  it("a stale epoch can neither complete the item nor write events", async () => {
    const { sql, log } = await setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let staleWrite: Promise<unknown> | null = null;
    let bRuns = 0;
    // Worker A: no heartbeat (it's "frozen"), so its lease expires.
    const a = queue(
      sql,
      async (_item, ctx) => {
        await gate;
        staleWrite = log
          .withGuard(ctx.guard)
          .appendAsync({ type: "agent.message", content: [] } as unknown as SessionEvent)
          .catch((err) => err);
      },
      { workerId: "A", staleAfterMs: 100, heartbeatMs: 60_000 },
    );
    const b = queue(
      sql,
      async (_item, ctx) => {
        bRuns++;
        await log
          .withGuard(ctx.guard)
          .appendAsync({ type: "agent.message", id: "sevt-from-b", content: [] } as unknown as SessionEvent);
      },
      { workerId: "B", staleAfterMs: 100, heartbeatMs: 20 },
    );
    await a.ensureSchema();
    await a.enqueue({ tenantId: "t", sessionId: SID, agentId: "ag", event: msg("m1") });

    const aRunning = a.wake(SID);
    await sleep(150);
    await b.wake(SID); // reclaims the stale lease (epoch 2) and finishes
    release();
    await aRunning;

    expect(bRuns).toBe(1);
    expect(await staleWrite).toMatchObject({ code: "append_rejected" });
    const events = await log.getEventsAsync();
    expect(events.map((e) => (e as { id?: string }).id)).toEqual(["sevt-from-b"]);
    const row = await sql
      .prepare(`SELECT status, attempts, lease_epoch FROM session_work_items`)
      .first<{ status: string; attempts: number; lease_epoch: number }>();
    // B completed it; A's completion (epoch 1) was a no-op.
    expect(row).toEqual({ status: "done", attempts: 2, lease_epoch: 2 });
  });

  it("dead-letters an item whose worker keeps dying after maxAttempts", async () => {
    const { sql } = await setup();
    const abandoned: Array<{ id: string; reason: string; attempts: number }> = [];
    const q = queue(sql, async () => {}, {
      staleAfterMs: 50,
      maxAttempts: 3,
      onAbandoned: (item, reason) => {
        abandoned.push({ id: item.eventId, reason, attempts: item.attempts });
      },
    });
    await q.ensureSchema();
    await q.enqueue({ tenantId: "t", sessionId: SID, agentId: "ag", event: msg("m1") });
    await q.enqueue({ tenantId: "t", sessionId: SID, agentId: "ag", event: msg("m2") });
    // Simulate three crashed attempts at m1: claimed, never heartbeated.
    await sql
      .prepare(
        `UPDATE session_work_items SET status='running', attempts=3, lease_epoch=3, locked_at=?
          WHERE event_id='m1'`,
      )
      .bind(Date.now() - 10_000)
      .run();

    await q.sweep();

    expect(abandoned).toEqual([{ id: "m1", reason: "dead", attempts: 3 }]);
    const rows = await sql
      .prepare(`SELECT event_id, status FROM session_work_items ORDER BY event_id`)
      .all<{ event_id: string; status: string }>();
    // The queue moved on to the next item.
    expect(rows.results).toEqual([
      { event_id: "m1", status: "dead" },
      { event_id: "m2", status: "done" },
    ]);
  });

  it("re-runs a stale item below the attempt cap (auto-resume)", async () => {
    const { sql } = await setup();
    const seen: number[] = [];
    const q = queue(sql, async (item) => {
      seen.push(item.attempts);
    }, { staleAfterMs: 50 });
    await q.ensureSchema();
    await q.enqueue({ tenantId: "t", sessionId: SID, agentId: "ag", event: msg("m1") });
    await sql
      .prepare(`UPDATE session_work_items SET status='running', attempts=1, lease_epoch=1, locked_at=?`)
      .bind(Date.now() - 10_000)
      .run();
    await q.sweep();
    expect(seen).toEqual([2]);
  });

  it("interrupt cancels queued rows and aborts the running turn via its lease", async () => {
    const { sql } = await setup();
    let reason: unknown = null;
    const runner = queue(
      sql,
      async (_item, ctx) => {
        await new Promise<void>((resolve) =>
          ctx.signal.addEventListener("abort", () => {
            reason = ctx.signal.reason;
            resolve();
          }),
        );
      },
      { workerId: "A", heartbeatMs: 20 },
    );
    // The interrupt arrives at a different replica (no local turn there).
    const other = queue(sql, async () => {}, { workerId: "B" });
    await runner.ensureSchema();
    await runner.enqueue({ tenantId: "t", sessionId: SID, agentId: "ag", event: msg("m1") });
    await runner.enqueue({ tenantId: "t", sessionId: SID, agentId: "ag", event: msg("m2") });
    expect((await runner.listPending(SID)).map((r) => r.event_id)).toEqual(["m1", "m2"]);

    const running = runner.wake(SID);
    await sleep(30);
    expect((await runner.listPending(SID)).map((r) => r.event_id)).toEqual(["m2"]);

    const res = await other.requestCancel(SID);
    expect(res.cancelled.map((r) => r.event_id)).toEqual(["m2"]);
    expect(res.runningCount).toBe(1);
    await running;
    expect(reason).toEqual({ kind: "user_interrupt" });
    expect(await runner.listPending(SID)).toEqual([]);
    expect(
      (await runner.listPending(SID, { includeCancelled: true })).map((r) => r.event_id),
    ).toEqual(["m2"]);
  });

  it("adds the lease columns to a pre-existing table idempotently", async () => {
    const { sql } = await setup();
    await sql.exec(`
      CREATE TABLE session_work_items (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL, event_id TEXT NOT NULL, event_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        locked_by TEXT, locked_at INTEGER, last_error TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, processed_at INTEGER)`);
    const q = queue(sql, async () => {});
    await q.ensureSchema();
    await q.ensureSchema();
    const cols = await sql.prepare(`PRAGMA table_info(session_work_items)`).all<{ name: string }>();
    expect(cols.results.map((c) => c.name)).toEqual(
      expect.arrayContaining(["lease_epoch", "pending_seq", "cancel_requested_at"]),
    );
  });
});
