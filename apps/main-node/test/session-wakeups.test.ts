// NodeSessionWakeups — unit tests over an in-memory better-sqlite3 client.
// Covers the SessionDO parity surface (validation, cap, cancel/list) plus
// the Node-only pump semantics: due selection, cron advance, exactly-once
// enqueue via deterministic event ids, and crash-retry dedupe.

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { BetterSqlite3SqlClient } from "@open-managed-agents/sql-client/adapters/better-sqlite3";
import type { UserMessageEvent } from "@open-managed-agents/shared";
import {
  NodeSessionWakeups,
  MAX_PENDING_WAKEUPS,
} from "../src/lib/node-session-wakeups";

interface EnqueuedItem {
  tenantId: string;
  sessionId: string;
  agentId: string;
  event: UserMessageEvent;
}

function build(opts?: { failEnqueue?: () => boolean }) {
  const db = new Database(":memory:");
  const sql = new BetterSqlite3SqlClient(db);
  let nowMs = 1_000_000_000_000;
  const enqueued: EnqueuedItem[] = [];
  const seenEventIds = new Set<string>();
  // Fake event log — pump must append the wakeup user.message here BEFORE
  // enqueuing (DefaultHarness reads context from the log, not the item).
  const logged = new Map<string, Array<{ id?: string; type: string }>>();
  const wakeups = new NodeSessionWakeups({
    sql,
    dialect: "sqlite",
    now: () => nowMs,
    persistEvent: async (sessionId, event) => {
      const list = logged.get(sessionId) ?? [];
      list.push(event as { id?: string; type: string });
      logged.set(sessionId, list);
    },
    hasEvent: async (sessionId, eventId) =>
      (logged.get(sessionId) ?? []).some((e) => e.id === eventId),
    enqueue: async (item) => {
      if (opts?.failEnqueue?.()) throw new Error("enqueue exploded");
      // Mirror the work queue's (session_id, event_id) dedupe.
      const key = `${item.sessionId}:${item.event.id}`;
      if (seenEventIds.has(key)) return;
      seenEventIds.add(key);
      enqueued.push(item);
    },
  });
  return {
    wakeups,
    enqueued,
    logged,
    advance: (ms: number) => {
      nowMs += ms;
    },
    now: () => nowMs,
  };
}

const CTX = { tenantId: "default", sessionId: "sess-test-1", agentId: "agent-test-1" };

describe("NodeSessionWakeups", () => {
  let t: ReturnType<typeof build>;

  beforeEach(async () => {
    t = build();
    await t.wakeups.ensureSchema();
  });

  it("rejects zero or multiple time selectors and empty prompts", async () => {
    await expect(t.wakeups.schedule({ ...CTX, prompt: "x" })).rejects.toThrow(
      /exactly one of delay_seconds \| at \| cron/,
    );
    await expect(
      t.wakeups.schedule({ ...CTX, delay_seconds: 60, cron: "0 9 * * *", prompt: "x" }),
    ).rejects.toThrow(/exactly one/);
    await expect(t.wakeups.schedule({ ...CTX, delay_seconds: 60, prompt: "  " })).rejects.toThrow(
      /prompt is required/,
    );
    await expect(t.wakeups.schedule({ ...CTX, at: "not-a-date", prompt: "x" })).rejects.toThrow(
      /invalid 'at' timestamp/,
    );
  });

  it("schedules one_shot via delay_seconds and fires exactly once", async () => {
    const res = await t.wakeups.schedule({ ...CTX, delay_seconds: 120, prompt: "heartbeat-check" });
    expect(res.kind).toBe("one_shot");
    expect(res.id).toMatch(/^swk_/);

    // Not due yet.
    expect(await t.wakeups.pump()).toBe(0);
    expect(t.enqueued).toHaveLength(0);

    t.advance(121_000);
    expect(await t.wakeups.pump()).toBe(1);
    expect(t.enqueued).toHaveLength(1);
    const ev = t.enqueued[0].event;
    expect(ev.type).toBe("user.message");
    expect(ev.content).toEqual([{ type: "text", text: "heartbeat-check" }]);
    const meta = (ev as { metadata?: Record<string, unknown> }).metadata!;
    expect(meta.harness).toBe("schedule");
    expect(meta.kind).toBe("wakeup");
    expect(meta.wakeup_kind).toBe("one_shot");
    expect((ev as { parent_event_id?: string }).parent_event_id).toBeTruthy();

    // Fired rows never refire, and drop out of list().
    t.advance(60_000);
    expect(await t.wakeups.pump()).toBe(0);
    expect(await t.wakeups.list(CTX.sessionId)).toHaveLength(0);
  });

  it("cron rows advance and refire until cancelled", async () => {
    const res = await t.wakeups.schedule({
      ...CTX,
      cron: "*/5 * * * *",
      prompt: "scan_channel C123",
    });
    expect(res.kind).toBe("cron");
    expect(res.cron).toBe("*/5 * * * *");

    t.advance(5 * 60_000 + 1000);
    expect(await t.wakeups.pump()).toBe(1);
    t.advance(5 * 60_000 + 1000);
    expect(await t.wakeups.pump()).toBe(1);
    expect(t.enqueued).toHaveLength(2);
    // Distinct occurrences get distinct deterministic event ids.
    expect(t.enqueued[0].event.id).not.toBe(t.enqueued[1].event.id);

    // Cron stays listed after firing, then cancel stops it.
    expect(await t.wakeups.list(CTX.sessionId)).toHaveLength(1);
    const cancelled = await t.wakeups.cancel(CTX.sessionId, res.id);
    expect(cancelled.cancelled).toBe(true);
    t.advance(10 * 60_000);
    expect(await t.wakeups.pump()).toBe(0);
  });

  it("cancel is scoped to the session and refuses fired one-shots", async () => {
    const res = await t.wakeups.schedule({ ...CTX, delay_seconds: 30, prompt: "x" });
    expect((await t.wakeups.cancel("sess-other", res.id)).cancelled).toBe(false);
    t.advance(31_000);
    await t.wakeups.pump();
    expect((await t.wakeups.cancel(CTX.sessionId, res.id)).cancelled).toBe(false);
    expect((await t.wakeups.cancel(CTX.sessionId, "swk_unknown")).cancelled).toBe(false);
  });

  it("enforces the pending cap with the SessionDO error message", async () => {
    for (let i = 0; i < MAX_PENDING_WAKEUPS; i++) {
      await t.wakeups.schedule({ ...CTX, delay_seconds: 3600 + i, prompt: `w${i}` });
    }
    await expect(t.wakeups.schedule({ ...CTX, delay_seconds: 60, prompt: "over" })).rejects.toThrow(
      /pending wakeup cap reached \(20\/20\)/,
    );
    // Other sessions are unaffected by this session's cap.
    await expect(
      t.wakeups.schedule({ ...CTX, sessionId: "sess-test-2", delay_seconds: 60, prompt: "ok" }),
    ).resolves.toMatchObject({ kind: "one_shot" });
  });

  it("a failed enqueue leaves the row due — retried next tick without double-fire", async () => {
    let fail = true;
    t = build({ failEnqueue: () => fail });
    await t.wakeups.ensureSchema();
    await t.wakeups.schedule({ ...CTX, delay_seconds: 10, prompt: "retry-me" });
    t.advance(11_000);

    // Enqueue throws → no claim, row stays due.
    expect(await t.wakeups.pump()).toBe(0);
    expect(t.enqueued).toHaveLength(0);

    // Next tick succeeds; deterministic id means a partially-delivered prior
    // attempt would have deduped instead of double-firing.
    fail = false;
    expect(await t.wakeups.pump()).toBe(1);
    expect(t.enqueued).toHaveLength(1);
    expect(t.enqueued[0].event.id).toMatch(/^sevt_wk_swk_/);
  });

  it("fires append the user.message to the event log before enqueuing", async () => {
    const res = await t.wakeups.schedule({ ...CTX, delay_seconds: 10, prompt: "wake up" });
    // schedule itself logs the span.wakeup_scheduled trajectory event.
    const spanEvents = (t.logged.get(CTX.sessionId) ?? []).filter(
      (e) => e.type === "span.wakeup_scheduled",
    );
    expect(spanEvents).toHaveLength(1);

    t.advance(11_000);
    await t.wakeups.pump();
    const userMsgs = (t.logged.get(CTX.sessionId) ?? []).filter((e) => e.type === "user.message");
    expect(userMsgs).toHaveLength(1);
    expect(t.enqueued).toHaveLength(1);
    // Same event object lands in the log and the queue — DefaultHarness
    // reads the log; the queue item just triggers the turn.
    expect(userMsgs[0].id).toBe(t.enqueued[0].event.id);
    expect(res.kind).toBe("one_shot");
  });

  it("a crash-retry does not append the wakeup user.message twice", async () => {
    let fail = true;
    t = build({ failEnqueue: () => fail });
    await t.wakeups.ensureSchema();
    await t.wakeups.schedule({ ...CTX, delay_seconds: 10, prompt: "retry-me" });
    t.advance(11_000);

    // First tick: append succeeds, enqueue throws → row stays due.
    await t.wakeups.pump();
    expect(
      (t.logged.get(CTX.sessionId) ?? []).filter((e) => e.type === "user.message"),
    ).toHaveLength(1);

    // Retry tick: hasEvent guard skips the second append; enqueue succeeds.
    fail = false;
    expect(await t.wakeups.pump()).toBe(1);
    expect(
      (t.logged.get(CTX.sessionId) ?? []).filter((e) => e.type === "user.message"),
    ).toHaveLength(1);
    expect(t.enqueued).toHaveLength(1);
  });

  it("list returns pending wakeups in fire order with ISO timestamps", async () => {
    await t.wakeups.schedule({ ...CTX, delay_seconds: 300, prompt: "later" });
    await t.wakeups.schedule({ ...CTX, delay_seconds: 60, prompt: "sooner" });
    const listed = await t.wakeups.list(CTX.sessionId);
    expect(listed.map((w) => w.prompt)).toEqual(["sooner", "later"]);
    expect(listed[0].fire_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
