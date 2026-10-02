// Regressions from the PR #30 external QA review (Codex QA_REPORT.md),
// exercised through the production Node pipeline over SQLite:
// NodeSessionRouter → NodeSessionWorkQueue → SessionStateMachine →
// NodeHarnessRuntime (→ DefaultHarness + real bash tool + LocalSubprocess
// sandbox for F6).
//
//   F2  a completed turn re-ran after a crash before queue acknowledgement
//   F5  two workers could own one session (late-committing enqueue)
//   F6  user.interrupt didn't stop a running bash command

import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV3 } from "ai/test";
import { BetterSqlite3SqlClient } from "@open-managed-agents/sql-client/adapters/better-sqlite3";
import { createPostgresSqlClient, type SqlClient } from "@open-managed-agents/sql-client";
import {
  SqlEventLog,
  SqlStreamRepo,
  ensureSchema as ensureEventLogSchema,
} from "@open-managed-agents/event-log/sql";
import { RuntimeAdapterImpl, SessionStateMachine } from "@open-managed-agents/session-runtime";
import type { AgentConfig, SessionEvent, UserMessageEvent } from "@open-managed-agents/shared";
import type { SandboxExecutor } from "@open-managed-agents/sandbox";
import { LocalSubprocessSandbox } from "@open-managed-agents/sandbox/adapters/local-subprocess";
import { DefaultHarness } from "../../agent/src/harness/default-loop";
import { buildTools } from "../../agent/src/harness/tools";
import type { HarnessContext } from "../../agent/src/harness/interface";
import { InProcessEventStreamHub } from "../src/lib/event-stream-hub";
import { NodeHarnessRuntime } from "../src/lib/node-harness-runtime";
import { NodeSessionRouter } from "../src/lib/node-session-router";
import { NodeSessionWorkQueue } from "../src/lib/node-session-work-queue";
import type { SessionRegistry } from "../src/registry";

const SID = "sess_qa30";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean | Promise<boolean>, tries = 500) {
  for (let i = 0; i < tries; i++) {
    if (await check()) return;
    await sleep(10);
  }
  throw new Error("condition not reached");
}

async function sqliteDb() {
  const db = new Database(":memory:");
  const sql: SqlClient = new BetterSqlite3SqlClient(db);
  await ensureEventLogSchema(sql, "sqlite");
  await sql.exec(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY, tenant_id TEXT, agent_id TEXT, status TEXT,
    turn_id TEXT, turn_started_at INTEGER, updated_at INTEGER, terminated_at INTEGER)`);
  await sql.prepare(`INSERT INTO sessions (id, tenant_id, agent_id, status) VALUES (?, 't', 'ag', 'idle')`).bind(SID).run();
  return sql;
}

type HarnessFn = (input: {
  runtime: NodeHarnessRuntime;
  tools: unknown;
  model: unknown;
  agent: AgentConfig;
  userMessage: UserMessageEvent;
}) => Promise<void>;

async function pipeline(opts: {
  harness: HarnessFn;
  sandbox?: SandboxExecutor;
  agent?: AgentConfig;
  buildTools?: (agent: AgentConfig, sandbox: SandboxExecutor) => Promise<unknown>;
  model?: unknown;
  staleAfterMs?: number;
}) {
  const sql = await sqliteDb();
  const hub = new InProcessEventStreamHub();
  const newEventLog = (sid: string) =>
    new SqlEventLog(sql, sid, (e) => {
      (e as { id?: string }).id ??= `sevt-${Math.random().toString(36).slice(2)}`;
    });
  const eventLog = newEventLog(SID);
  const sandbox: SandboxExecutor =
    opts.sandbox ?? { exec: async () => "", readFile: async () => "", writeFile: async () => "" };
  const agent =
    opts.agent ?? ({ id: "ag", name: "a", model: "m", system: "", tools: [] } as unknown as AgentConfig);
  let harnessRuns = 0;
  const machine = new SessionStateMachine({
    sessionId: SID,
    tenantId: "t",
    adapter: new RuntimeAdapterImpl({ sql, eventLog, streams: new SqlStreamRepo(sql, SID), sandbox }),
    sandbox,
    loadAgent: async () => agent,
    buildTools: opts.buildTools ?? (async () => ({})),
    buildModel: async () => (opts.model ?? {}) as never,
    buildHarness: () => ({
      run: async (ctx) => {
        harnessRuns++;
        const c = ctx as { runtime: NodeHarnessRuntime; tools: unknown; model: unknown; agent: AgentConfig; userMessage: UserMessageEvent };
        await opts.harness(c);
      },
    }),
    buildHarnessContext: async (input) => {
      const runtime = new NodeHarnessRuntime({
        sessionId: SID,
        log: input.eventLog as SqlEventLog,
        hub,
        sandbox: input.sandbox,
        abortSignal: input.abortSignal,
      });
      await runtime.refreshHistory();
      return { runtime, tools: input.tools, model: input.model, agent: input.agent, userMessage: input.userMessage };
    },
    publish: (e) => hub.publish(SID, e),
    logger: { warn: () => {}, log: () => {} },
  });
  const workQueue = new NodeSessionWorkQueue({
    sql,
    dialect: "sqlite",
    ...(opts.staleAfterMs ? { staleAfterMs: opts.staleAfterMs } : {}),
    run: (item, ctx) =>
      machine
        .runTurn(item.agentId, item.event, {
          signal: ctx.signal,
          eventLog: eventLog.withGuard(ctx.guard),
          pendingSeq: item.pendingSeq,
          recoverOrphans: true,
        })
        .then(() => undefined),
  });
  await workQueue.ensureSchema();
  const registry = {
    getOrCreate: async () => ({ machine, sandbox, eventLog }),
    interrupt: async () => machine.interrupt(),
    destroy: async () => {},
  } as unknown as SessionRegistry;
  const router = new NodeSessionRouter({ sql, hub, registry, newEventLog, workQueue });
  const log = async () => (await eventLog.getEventsAsync()) as unknown as Array<Record<string, unknown>>;
  return { sql, router, log, machine, workQueue, drained: () => workQueue.wake(SID), harnessRuns: () => harnessRuns };
}

const userMsg = (t: string) =>
  ({ type: "user.message", content: [{ type: "text", text: t }] }) as unknown as SessionEvent;

// ─────────────────────────────────────────────────────────────────────────

describe("F2: reclaimed work item whose turn already completed", () => {
  it("is acknowledged without calling the model again", async () => {
    const p = await pipeline({
      harness: async ({ runtime }) => {
        runtime.broadcast({ type: "agent.message", content: [{ type: "text", text: "purchased" }] } as SessionEvent);
      },
    });
    await p.router.appendEvent(SID, userMsg("buy it"));
    await p.drained();
    expect(p.harnessRuns()).toBe(1);

    // Crash window: session.status_idle is durable, but the process died
    // (browser dispose / sandbox deactivate / Slack mirror) before markDone.
    await p.sql
      .prepare(`UPDATE session_work_items SET status='running', locked_at=?, locked_by='dead-worker'`)
      .bind(Date.now() - 10 * 60_000)
      .run();
    await p.workQueue.sweep();

    expect(p.harnessRuns()).toBe(1);
    const events = await p.log();
    expect(events.filter((e) => e.type === "agent.message")).toHaveLength(1);
    expect(events.filter((e) => e.type === "session.status_idle")).toHaveLength(1);
    expect(events.filter((e) => e.type === "user.message")).toHaveLength(1);
    const row = await p.sql
      .prepare(`SELECT status, attempts FROM session_work_items`)
      .first<{ status: string; attempts: number }>();
    expect(row).toEqual({ status: "done", attempts: 2 });
  });
});

// ─────────────────────────────────────────────────────────────────────────

describe("F5: at most one running work item per session", () => {
  const queues: NodeSessionWorkQueue[] = [];
  afterEach(() => {
    for (const q of queues.splice(0)) q.stop();
  });
  const input = (id: string) => ({
    tenantId: "t",
    sessionId: SID,
    agentId: "a",
    event: { type: "user.message", id, content: [] } as unknown as SessionEvent,
  });

  async function sharedDb() {
    const db = new Database(":memory:");
    return new BetterSqlite3SqlClient(db) as SqlClient;
  }

  it("a late-committing enqueue that sorts ahead can't start while another item runs", async () => {
    const sql = await sharedDb();
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const seen: string[] = [];
    const a = new NodeSessionWorkQueue({
      sql,
      dialect: "sqlite",
      workerId: "A",
      run: async (item) => {
        seen.push(`start ${item.eventId}`);
        if (item.eventId === "committed-first") await hold;
        seen.push(`end ${item.eventId}`);
      },
    });
    const b = new NodeSessionWorkQueue({
      sql,
      dialect: "sqlite",
      workerId: "B",
      run: async (item) => {
        seen.push(`start ${item.eventId}`);
        seen.push(`end ${item.eventId}`);
      },
    });
    queues.push(a, b);
    await a.ensureSchema();
    await b.ensureSchema(); // idempotent, incl. the partial unique index

    await a.enqueue(input("committed-first"));
    const runningA = a.wake(SID);
    await until(() => seen.length > 0);
    await b.enqueue(input("late-commit"));
    // Emulate a concurrent Postgres INSERT that took its MAX(pending_seq)
    // snapshot before the first row committed (same seq) and an earlier
    // created_at, then committed after the first row was claimed.
    await sql.prepare(`UPDATE session_work_items SET pending_seq=1, created_at=1 WHERE event_id='late-commit'`).run();

    await b.wake(SID);
    expect(seen).toEqual(["start committed-first"]);

    release();
    await runningA;
    await a.wake(SID);
    await b.wake(SID);
    expect(seen).toEqual(["start committed-first", "end committed-first", "start late-commit", "end late-commit"]);
    const rows = await sql
      .prepare(`SELECT event_id, status FROM session_work_items ORDER BY event_id`)
      .all<{ event_id: string; status: string }>();
    expect(rows.results).toEqual([
      { event_id: "committed-first", status: "done" },
      { event_id: "late-commit", status: "done" },
    ]);
  });

  it("the partial unique index rejects a second running row for the session", async () => {
    const sql = await sharedDb();
    const q = new NodeSessionWorkQueue({ sql, dialect: "sqlite", run: async () => {} });
    queues.push(q);
    await q.ensureSchema();
    await q.ensureSchema();
    await q.enqueue(input("x1"));
    await q.enqueue(input("x2"));
    await q.enqueue({ ...input("other"), sessionId: "sess_other" });
    await sql.prepare(`UPDATE session_work_items SET status='running' WHERE event_id='x1'`).run();
    await expect(
      sql.prepare(`UPDATE session_work_items SET status='running' WHERE event_id='x2'`).run(),
    ).rejects.toThrow(/UNIQUE/i);
    // Other sessions are unaffected.
    await sql.prepare(`UPDATE session_work_items SET status='running' WHERE event_id='other'`).run();
  });

  it("orders ties deterministically by (pending_seq, created_at, id)", async () => {
    const sql = await sharedDb();
    const order: string[] = [];
    const q = new NodeSessionWorkQueue({ sql, dialect: "sqlite", run: async (item) => void order.push(item.eventId) });
    queues.push(q);
    await q.ensureSchema();
    await q.enqueue(input("b"));
    await q.enqueue(input("a"));
    // Colliding pending_seq + created_at (Postgres concurrent enqueue).
    await sql.prepare(`UPDATE session_work_items SET pending_seq=1, created_at=5`).run();
    const ids = await sql
      .prepare(`SELECT id, event_id FROM session_work_items ORDER BY id`)
      .all<{ id: string; event_id: string }>();
    await q.wake(SID);
    expect(order).toEqual(ids.results!.map((r) => r.event_id));
  });
});

// Same invariant on a live Postgres (skipped unless PG_TEST_URL is set).
const PG_URL = process.env.PG_TEST_URL ?? "";
const pgEnabled = PG_URL.startsWith("postgres://") || PG_URL.startsWith("postgresql://");
(pgEnabled ? describe : describe.skip)("F5 on Postgres", () => {
  it("ensureSchema is idempotent and two running rows per session are rejected", async () => {
    const sql = await createPostgresSqlClient(PG_URL);
    const sid = `sess_pg_${Date.now()}`;
    const q = new NodeSessionWorkQueue({ sql, dialect: "postgres", run: async () => {} });
    await q.ensureSchema();
    await q.ensureSchema();
    try {
      await q.enqueue({ tenantId: "t", sessionId: sid, agentId: "a", event: { type: "user.message", id: "p1", content: [] } as never });
      await q.enqueue({ tenantId: "t", sessionId: sid, agentId: "a", event: { type: "user.message", id: "p2", content: [] } as never });
      await sql.prepare(`UPDATE session_work_items SET status='running' WHERE session_id=? AND event_id='p1'`).bind(sid).run();
      await expect(
        sql.prepare(`UPDATE session_work_items SET status='running' WHERE session_id=? AND event_id='p2'`).bind(sid).run(),
      ).rejects.toThrow();
    } finally {
      await sql.prepare(`DELETE FROM session_work_items WHERE session_id=?`).bind(sid).run();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────

describe("F6: user.interrupt stops a running bash command", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("kills `sleep 30; touch marker`, records an interrupted result, idles promptly", async () => {
    dir = mkdtempSync(join(tmpdir(), "oma-qa30-"));
    const workdir = join(dir, "work");
    const marker = join(dir, "marker");
    const childMarker = join(dir, "child-marker");
    const sandbox = new LocalSubprocessSandbox({ workdir, logger: { warn: () => {}, log: () => {} } });
    const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
    const stream = (parts: unknown[]) =>
      new ReadableStream({ start(c) { parts.forEach((x) => c.enqueue(x)); c.close(); } });
    let modelCalls = 0;
    const command = `(sleep 1; touch ${childMarker}) & sleep 30; touch ${marker}`;
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: stream(
          ++modelCalls === 1
            ? [
                { type: "stream-start", warnings: [] },
                { type: "tool-call", toolCallId: "toolu_sleep", toolName: "bash", input: JSON.stringify({ command }) },
                { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage },
              ]
            : [
                { type: "stream-start", warnings: [] },
                { type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "should not run" }, { type: "text-end", id: "t" },
                { type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage },
              ],
        ),
      }),
    });
    const agent = {
      id: "ag",
      name: "a",
      model: "m",
      system: "",
      tools: [{ type: "agent_toolset_20260401", default_config: { enabled: false }, configs: [{ name: "bash", enabled: true }] }],
    } as unknown as AgentConfig;

    const p = await pipeline({
      sandbox,
      agent,
      model,
      buildTools: (a, sb) => buildTools(a, sb),
      harness: async ({ runtime, tools, model: m, agent: a, userMessage }) => {
        await new DefaultHarness().run({
          agent: a,
          userMessage,
          session_id: SID,
          tenant_id: "t",
          tools,
          model: m,
          systemPrompt: "test",
          env: {},
          runtime,
        } as unknown as HarnessContext);
      },
    });

    await p.router.appendEvent(SID, userMsg("run the long command"));
    const drained = p.drained();
    await until(async () => (await p.log()).some((e) => e.type === "agent.tool_use"));
    await sleep(300); // the command is running

    const t0 = Date.now();
    await p.router.appendEvent(SID, { type: "user.interrupt" } as SessionEvent);
    await drained;
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeLessThan(5_000);
    const events = await p.log();
    expect(events.at(-1)).toMatchObject({ type: "session.status_idle", stop_reason: { type: "end_turn" } });
    const results = events.filter((e) => e.type === "agent.tool_result");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ tool_use_id: "toolu_sleep", is_error: true });
    expect(JSON.stringify(results[0].content)).toMatch(/interrupt/i);
    expect(events.map((e) => e.type)).not.toContain("session.error");
    expect(modelCalls).toBe(1);

    // Past the backgrounded child's sleep: neither side effect happened.
    await sleep(1_500);
    expect(existsSync(childMarker)).toBe(false);
    expect(existsSync(marker)).toBe(false);
  }, 20_000);
});
