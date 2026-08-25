// Regression for the prod session_events_pkey collision: SqlEventLog mints
// seq via MAX(seq)+1 inside the INSERT, which is racy on Postgres (pooled
// connections, snapshot reads). Two defenses under test here:
//   1. appendAsync serialises per session at module scope, so concurrent
//      appends from SEPARATE SqlEventLog instances (the prod shape —
//      newEventLog() builds a fresh instance per call) never interleave.
//   2. insert retries on unique violation, so a genuinely cross-process
//      collision resolves instead of failing the turn.
// The fake below mimics PG read-committed semantics: the MAX read and the
// row write are split by an await, and a duplicate (session_id, seq) throws
// SQLSTATE 23505 like postgres.js does.

import { describe, it, expect } from "vitest";
import { SqlEventLog } from "@open-managed-agents/event-log/sql";
import type { SessionEvent } from "@open-managed-agents/shared";

interface Row {
  session_id: string;
  seq: number;
  type: string;
  data: string;
  ts: number;
  processed_at: number | null;
  cancelled_at: number | null;
  session_thread_id: string | null;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 1));

/** In-memory session_events with PG-like interleaving on insert. */
function pgLikeFake(opts?: { stealSeqOnce?: string }) {
  const rows: Row[] = [];
  let stealArmed = Boolean(opts?.stealSeqOnce);
  const maxSeq = (sid: string) =>
    rows.reduce((m, r) => (r.session_id === sid && r.seq > m ? r.seq : m), 0);

  const client = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return {
            async run() {
              if (!sql.includes("INSERT INTO session_events")) {
                throw new Error(`fake: unexpected write: ${sql}`);
              }
              const [sessionId, type, data, ts, processedAt, threadId] =
                params as [string, string, string, number, number | null, string];
              // Snapshot read of MAX(seq), then yield — the window where a
              // concurrent insert on another connection lands.
              const seq = maxSeq(sessionId) + 1;
              await tick();
              if (stealArmed && sessionId === opts?.stealSeqOnce) {
                // Another process wins the slot between our read and write.
                stealArmed = false;
                rows.push({
                  session_id: sessionId, seq, type: "system.other_process",
                  data: "{}", ts, processed_at: ts, cancelled_at: null,
                  session_thread_id: "sthr_primary",
                });
              }
              if (rows.some((r) => r.session_id === sessionId && r.seq === seq)) {
                const err = new Error(
                  'duplicate key value violates unique constraint "session_events_pkey"',
                ) as Error & { code: string };
                err.code = "23505";
                throw err;
              }
              rows.push({
                session_id: sessionId, seq, type, data, ts,
                processed_at: processedAt, cancelled_at: null,
                session_thread_id: threadId,
              });
              return { success: true };
            },
            async all<T>() {
              const [sessionId] = params as [string];
              const results = rows
                .filter((r) => r.session_id === sessionId)
                .sort((a, b) => a.seq - b.seq);
              return { results: results as unknown as T[] };
            },
            async first<T>() {
              const r = await this.all<T>();
              return r.results[0] ?? null;
            },
          };
        },
      };
    },
  };
  return { client, rows };
}

const newLog = (client: unknown, sid: string) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  new SqlEventLog(client as any, sid, () => {});

const ev = (i: number): SessionEvent =>
  ({ type: "agent.message", content: [{ type: "text", text: `m${i}` }] }) as unknown as SessionEvent;

describe("SqlEventLog seq minting under concurrency", () => {
  it("serialises concurrent appends across separate instances of one session", async () => {
    const { client, rows } = pgLikeFake();
    // Prod shape: every writer gets its own instance via newEventLog(sid).
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => newLog(client, "s1").appendAsync(ev(i))),
    );
    const seqs = rows.filter((r) => r.session_id === "s1").map((r) => r.seq).sort((a, b) => a - b);
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("does not serialise across sessions (independent partitions)", async () => {
    const { client, rows } = pgLikeFake();
    await Promise.all([
      newLog(client, "a").appendAsync(ev(1)),
      newLog(client, "b").appendAsync(ev(2)),
      newLog(client, "a").appendAsync(ev(3)),
      newLog(client, "b").appendAsync(ev(4)),
    ]);
    expect(rows.filter((r) => r.session_id === "a").map((r) => r.seq)).toEqual([1, 2]);
    expect(rows.filter((r) => r.session_id === "b").map((r) => r.seq)).toEqual([1, 2]);
  });

  it("retries past a cross-process seq steal instead of failing the append", async () => {
    const { client, rows } = pgLikeFake({ stealSeqOnce: "s1" });
    await newLog(client, "s1").appendAsync(ev(1));
    const ours = rows.filter((r) => r.session_id === "s1" && r.type === "agent.message");
    expect(ours).toHaveLength(1);
    expect(ours[0]!.seq).toBe(2); // slot 1 went to the "other process"
  });

  it("a failed append does not poison subsequent appends on the chain", async () => {
    const { client, rows } = pgLikeFake();
    const bad = {
      prepare: () => ({
        bind: () => ({
          run: async () => {
            throw new Error("connection reset");
          },
        }),
      }),
    };
    await expect(newLog(bad, "s1").appendAsync(ev(0))).rejects.toThrow("connection reset");
    await newLog(client, "s1").appendAsync(ev(1));
    expect(rows.filter((r) => r.session_id === "s1")).toHaveLength(1);
  });
});
