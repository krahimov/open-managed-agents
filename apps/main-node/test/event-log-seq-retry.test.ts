// Regression coverage for the session_events seq race.
//
// SqlEventLog mints seq via `SELECT COALESCE(MAX(seq), 0) + 1` inside the
// INSERT. On Postgres (READ COMMITTED, concurrent pooled connections) two
// writers can read the same MAX and collide on the (session_id, seq)
// PRIMARY KEY — the production symptom is a turn failing with
// `duplicate key value violates unique constraint "session_events_pkey"`.
// appendAsync now treats a unique violation as "lost the seq race" and
// retries the INSERT (which recomputes MAX+1 against committed rows).
//
// A live Postgres race is non-deterministic, so the retry contract is
// asserted with a fake SqlClient that throws driver-shaped unique-violation
// errors on the first N attempts. The PG-gated end-to-end concurrency test
// lives in pg-fanout.test.ts. The SQLite section here is a sanity pass that
// the retry path doesn't disturb normal appends on the real driver.

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBetterSqlite3SqlClient,
  type SqlClient,
  type SqlStatement,
  type SqlRunResult,
  type SqlSelectResult,
} from "@open-managed-agents/sql-client";
import {
  SqlEventLog,
  ensureSchema as ensureEventLogSchema,
} from "@open-managed-agents/event-log/sql";
import type { SessionEvent } from "@open-managed-agents/shared";

/** postgres.js shape: PostgresError has .code "23505". */
function pgUniqueViolation(): Error {
  return Object.assign(
    new Error(
      'duplicate key value violates unique constraint "session_events_pkey"',
    ),
    { code: "23505" },
  );
}

/** better-sqlite3 shape: SqliteError has .code SQLITE_CONSTRAINT_*. */
function sqliteUniqueViolation(): Error {
  return Object.assign(
    new Error(
      "UNIQUE constraint failed: session_events.session_id, session_events.seq",
    ),
    { code: "SQLITE_CONSTRAINT_PRIMARYKEY" },
  );
}

/**
 * SqlClient whose INSERTs throw `failures.shift()` until the queue drains,
 * then succeed. Tracks total INSERT attempts.
 */
function fakeClient(failures: Error[]): { sql: SqlClient; attempts: () => number } {
  let attempts = 0;
  const stmt: SqlStatement = {
    bind: () => stmt,
    run: async <T>(): Promise<SqlRunResult<T>> => {
      attempts++;
      const err = failures.shift();
      if (err) throw err;
      return { meta: { changes: 1 }, success: true };
    },
    first: async <T>(): Promise<T | null> => null,
    all: async <T>(): Promise<SqlSelectResult<T>> => ({
      results: [],
      meta: { changes: 0 },
    }),
  };
  const sql: SqlClient = {
    prepare: () => stmt,
    batch: async () => [],
    exec: async () => {},
  };
  return { sql, attempts: () => attempts };
}

const userMessage = {
  type: "user.message",
  content: [{ type: "text", text: "hi" }],
} as SessionEvent;

describe("SqlEventLog appendAsync seq-collision retry", () => {
  it("retries past pg unique violations and resolves", async () => {
    const { sql, attempts } = fakeClient([pgUniqueViolation(), pgUniqueViolation()]);
    const log = new SqlEventLog(sql, "sess-retry", () => {});
    await log.appendAsync(userMessage);
    expect(attempts()).toBe(3);
  });

  it("retries past sqlite/D1 unique violations too", async () => {
    const { sql, attempts } = fakeClient([sqliteUniqueViolation()]);
    const log = new SqlEventLog(sql, "sess-retry-sqlite", () => {});
    await log.appendAsync(userMessage);
    expect(attempts()).toBe(2);
  });

  it("rethrows non-unique-violation errors without retrying", async () => {
    const boom = Object.assign(new Error('relation "session_events" does not exist'), {
      code: "42P01",
    });
    const { sql, attempts } = fakeClient([boom]);
    const log = new SqlEventLog(sql, "sess-no-retry", () => {});
    await expect(log.appendAsync(userMessage)).rejects.toBe(boom);
    expect(attempts()).toBe(1);
  });

  it("gives up after bounded attempts when the violation persists", async () => {
    const { sql, attempts } = fakeClient(
      Array.from({ length: 50 }, () => pgUniqueViolation()),
    );
    const log = new SqlEventLog(sql, "sess-exhaust", () => {});
    await expect(log.appendAsync(userMessage)).rejects.toMatchObject({
      code: "23505",
    });
    // MAX_APPEND_ATTEMPTS in packages/event-log/src/sql/index.ts.
    expect(attempts()).toBe(20);
  });
});

describe("SqlEventLog appendAsync on real sqlite", () => {
  it("interleaved appends from independent instances mint contiguous seq", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "oma-evlog-seq-"));
    try {
      const sql = await createBetterSqlite3SqlClient(join(tmpDir, "test.db"));
      await ensureEventLogSchema(sql, "sqlite");
      const sid = "sess-concurrent";
      // Three independent SqlEventLog instances (machine / harness /
      // router each construct their own in production) appending
      // interleaved without awaiting each other.
      const logs = [0, 1, 2].map(() => new SqlEventLog(sql, sid, () => {}));
      await Promise.all(
        Array.from({ length: 21 }, (_, i) =>
          logs[i % 3].appendAsync({
            type: "agent.message",
            content: [{ type: "text", text: `n${i}` }],
          } as SessionEvent),
        ),
      );
      const events = await logs[0].getEventsAsync();
      const seqs = events.map((e) => (e as { seq?: number }).seq);
      expect(seqs).toEqual(Array.from({ length: 21 }, (_, i) => i + 1));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
