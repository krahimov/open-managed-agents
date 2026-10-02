// End-to-end Node turn pipeline over in-memory SQLite: NodeSessionRouter →
// NodeSessionWorkQueue (pending queue + leases) → SessionStateMachine →
// NodeHarnessRuntime. The harness is scripted; everything else is the
// production code path.
//
// Covers the regressions this pipeline had:
//   - a user.message sent mid-turn landed in the log immediately and leaked
//     into the running turn's context (now: pending until its turn starts)
//   - user.tool_confirmation / user.custom_tool_result were appended and
//     never resumed the session
//   - user.interrupt didn't abort anything

import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { BetterSqlite3SqlClient } from "@open-managed-agents/sql-client/adapters/better-sqlite3";
import type { SqlClient } from "@open-managed-agents/sql-client";
import {
  SqlEventLog,
  SqlStreamRepo,
  ensureSchema as ensureEventLogSchema,
} from "@open-managed-agents/event-log/sql";
import {
  RuntimeAdapterImpl,
  SessionStateMachine,
  type SessionMachineDeps,
} from "@open-managed-agents/session-runtime";
import { MockLanguageModelV3 } from "ai/test";
import { createNodeOutcomeRunner } from "../src/lib/node-outcome";
import type { AgentConfig, SessionEvent } from "@open-managed-agents/shared";
import type { SandboxExecutor } from "@open-managed-agents/sandbox";
import { InProcessEventStreamHub } from "../src/lib/event-stream-hub";
import { NodeHarnessRuntime } from "../src/lib/node-harness-runtime";
import { NodeSessionRouter } from "../src/lib/node-session-router";
import { NodeSessionWorkQueue } from "../src/lib/node-session-work-queue";
import type { SessionRegistry } from "../src/registry";

const SID = "sess_pipeline";

type Script = (rt: NodeHarnessRuntime, turn: number) => Promise<void>;

async function setup(
  script: Script,
  opts: { runOutcome?: SessionMachineDeps["runOutcome"] } = {},
) {
  const db = new Database(":memory:");
  const sql: SqlClient = new BetterSqlite3SqlClient(db);
  await ensureEventLogSchema(sql, "sqlite");
  await sql.exec(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY, tenant_id TEXT, agent_id TEXT, status TEXT,
    turn_id TEXT, turn_started_at INTEGER, updated_at INTEGER, terminated_at INTEGER)`);
  await sql.prepare(`INSERT INTO sessions (id, tenant_id, agent_id, status) VALUES (?, 't', 'ag', 'idle')`).bind(SID).run();

  const hub = new InProcessEventStreamHub();
  const published: Array<Record<string, unknown>> = [];
  hub.attach(SID, { closed: false, write: (e) => published.push(e as never), close: () => {} });
  const newEventLog = (sid: string) =>
    new SqlEventLog(sql, sid, (e) => {
      (e as { id?: string }).id ??= `sevt-${Math.random().toString(36).slice(2)}`;
    });
  const eventLog = newEventLog(SID);
  const sandbox: SandboxExecutor = { exec: async () => "", readFile: async () => "", writeFile: async () => "" };
  let turn = 0;
  const machine = new SessionStateMachine({
    sessionId: SID,
    tenantId: "t",
    adapter: new RuntimeAdapterImpl({ sql, eventLog, streams: new SqlStreamRepo(sql, SID), sandbox }),
    sandbox,
    loadAgent: async () => ({ id: "ag", name: "a", model: "m", system: "", tools: [] }) as unknown as AgentConfig,
    buildTools: async () => ({}),
    buildModel: async () => ({}) as never,
    buildHarness: () => ({
      run: async (ctx) => {
        await script((ctx as { runtime: NodeHarnessRuntime }).runtime, ++turn);
      },
    }),
    buildHarnessContext: async (input) => {
      const runtime = new NodeHarnessRuntime({
        sessionId: SID,
        log: input.eventLog as SqlEventLog,
        hub,
        sandbox,
        abortSignal: input.abortSignal,
      });
      await runtime.refreshHistory();
      return { runtime };
    },
    publish: (e) => hub.publish(SID, e),
    ...(opts.runOutcome ? { runOutcome: opts.runOutcome } : {}),
  });
  const workQueue = new NodeSessionWorkQueue({
    sql,
    dialect: "sqlite",
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
  const log = async () => (await eventLog.getEventsAsync()) as Array<Record<string, unknown>>;
  const drained = () => workQueue.wake(SID);
  return { router, log, published, drained, machine, workQueue };
}

const text = (e: Record<string, unknown>) =>
  ((e.content as Array<{ text?: string }> | undefined) ?? []).map((b) => b.text ?? "").join("");

const userMsg = (t: string) =>
  ({ type: "user.message", content: [{ type: "text", text: t }] }) as unknown as SessionEvent;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition not reached");
}

describe("Node turn pipeline", () => {
  it("holds a mid-turn user.message as pending and runs it as the next turn", async () => {
    const gate = deferred();
    const seenUsers: string[][] = [];
    let started = false;
    const p = await setup(async (rt, turn) => {
      seenUsers.push(
        rt.history.getEvents().filter((e) => e.type === "user.message").map((e) => text(e as never)),
      );
      if (turn === 1) {
        started = true;
        await gate.promise;
      }
      rt.broadcast({ type: "agent.message", content: [{ type: "text", text: `reply ${turn}` }] } as SessionEvent);
    });

    await p.router.appendEvent(SID, userMsg("first"));
    await until(() => started);
    await p.router.appendEvent(SID, userMsg("second"));

    // Not in the log yet — only in the pending queue (+ outbox frame).
    expect((await p.log()).map(text)).not.toContain("second");
    const pending = JSON.parse((await p.router.getPending(SID)).body) as { data: Array<{ data: unknown }> };
    expect(pending.data.map((r) => text(r.data as never))).toEqual(["second"]);
    expect(p.published.some((e) => e.type === "system.user_message_pending")).toBe(true);

    gate.resolve();
    await until(async () => (await p.log()).filter((e) => e.type === "session.status_idle").length === 2);

    const events = await p.log();
    expect(events.map((e) => (e.type === "user.message" || e.type === "agent.message" ? `${e.type}:${text(e)}` : e.type))).toEqual([
      "user.message:first",
      "session.status_running",
      "agent.message:reply 1",
      "session.status_idle",
      "user.message:second",
      "session.status_running",
      "agent.message:reply 2",
      "session.status_idle",
    ]);
    // The running turn never saw the queued message.
    expect(seenUsers).toEqual([["first"], ["first", "second"]]);
    // Seqs are contiguous and published rows carry them.
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const promoted = p.published.filter((e) => e.type === "system.user_message_promoted");
    expect(promoted.map((e) => e.seq)).toEqual([1, 5]);
    expect(JSON.parse((await p.router.getPending(SID)).body).data).toEqual([]);
  });

  it("resumes the session after user.tool_confirmation", async () => {
    const p = await setup(async (rt, turn) => {
      if (turn === 1) {
        rt.broadcast({
          type: "agent.tool_use",
          id: "toolu_1",
          name: "bash",
          input: { command: "rm -rf /tmp/x" },
          evaluated_permission: "ask",
        } as unknown as SessionEvent);
        rt.pendingConfirmations.push("toolu_1");
        return;
      }
      rt.broadcast({ type: "agent.message", content: [{ type: "text", text: "ok, skipped" }] } as SessionEvent);
    });

    await p.router.appendEvent(SID, userMsg("clean up"));
    await until(async () => (await p.log()).some((e) => e.type === "session.status_idle"));
    expect((await p.log()).at(-1)).toMatchObject({
      type: "session.status_idle",
      stop_reason: { type: "requires_action", action_type: "tool_confirmation", event_ids: ["toolu_1"] },
    });

    await p.router.appendEvent(SID, {
      type: "user.tool_confirmation",
      tool_use_id: "toolu_1",
      result: "deny",
    } as unknown as SessionEvent);
    await until(async () => (await p.log()).filter((e) => e.type === "session.status_idle").length === 2);

    const events = await p.log();
    expect(events.map((e) => e.type)).toEqual([
      "user.message",
      "session.status_running",
      "agent.tool_use",
      "session.status_idle",
      "user.tool_confirmation",
      "session.status_running",
      "agent.tool_result",
      "agent.message",
      "session.status_idle",
    ]);
    expect(events.at(-1)).toMatchObject({ stop_reason: { type: "end_turn" } });
  });

  it("user.interrupt aborts the running turn and flushes queued input", async () => {
    let started = false;
    const p = await setup(async (rt) => {
      started = true;
      await new Promise<void>((_, reject) =>
        rt.abortSignal.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        }),
      );
    });

    await p.router.appendEvent(SID, userMsg("long task"));
    await until(() => started);
    await p.router.appendEvent(SID, userMsg("queued"));
    await p.router.appendEvent(SID, { type: "user.interrupt" } as SessionEvent);
    await p.drained();

    const events = await p.log();
    expect(events.map((e) => e.type)).toEqual([
      "user.message",
      "session.status_running",
      "user.interrupt",
      "session.status_idle",
    ]);
    expect(events.at(-1)).toMatchObject({ stop_reason: { type: "end_turn" } });
    expect(events.map(text)).not.toContain("queued");
    expect(p.published.filter((e) => e.type === "system.user_message_cancelled")).toHaveLength(1);
    expect(p.machine.hasInflightTurn()).toBe(false);
  });

  it("records user.define_outcome with a minted id and rejects it without a rubric", async () => {
    const p = await setup(async () => {});
    const bad = await p.router.appendEvent(SID, { type: "user.define_outcome", description: "x" } as unknown as SessionEvent);
    expect(bad.status).toBe(400);
    const ok = await p.router.appendEvent(SID, {
      type: "user.define_outcome",
      description: "tests pass",
      rubric: "all green",
    } as unknown as SessionEvent);
    expect(ok.status).toBe(202);
    const [ev] = await p.log();
    expect(ev).toMatchObject({ type: "user.define_outcome" });
    expect(String(ev.outcome_id)).toMatch(/^outc_/);
  });

  it("grades the turn against a defined outcome and runs a revision turn", async () => {
    const verdicts = [
      { result: "needs_revision", explanation: "missing the summary" },
      { result: "satisfied", explanation: "looks good" },
    ];
    const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
    const judge = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: "text", text: JSON.stringify(verdicts.shift()) }],
        finishReason: { unified: "stop", raw: "stop" },
        usage,
        warnings: [],
      }),
    });
    const runner = createNodeOutcomeRunner({
      resolveJudgeModel: async () => ({ model: judge, modelId: "judge" }),
      loadRubricFile: async () => null,
      runExec: async () => ({ exit_code: 0, output: "" }),
    });
    const p = await setup(
      async (rt, turn) => {
        rt.broadcast({ type: "agent.message", content: [{ type: "text", text: `attempt ${turn}` }] } as SessionEvent);
      },
      { runOutcome: (input) => runner({ ...input, tenantId: "t", sessionId: SID }) },
    );
    await p.router.appendEvent(SID, {
      type: "user.define_outcome",
      description: "write a report",
      rubric: "has a summary",
    } as unknown as SessionEvent);
    await p.router.appendEvent(SID, userMsg("write it"));
    await p.drained();

    const events = await p.log();
    const ends = events.filter((e) => e.type === "span.outcome_evaluation_end");
    expect(ends.map((e) => e.result)).toEqual(["needs_revision", "satisfied"]);
    expect(events.filter((e) => e.type === "agent.message").map(text)).toEqual(["attempt 1", "attempt 2"]);
    expect(events.at(-1)).toMatchObject({ type: "session.status_idle", stop_reason: { type: "end_turn" } });
  });
});
