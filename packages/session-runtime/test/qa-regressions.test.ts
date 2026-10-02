// Regressions from the PR #30 external QA review (Codex QA_REPORT.md).
// Each block turns one of its reproducers into an assertion:
//
//   F2  a completed turn re-ran after a crash before queue acknowledgement
//   F3  crash recovery lost a promoted user.custom_tool_result
//   F6  an aborted turn waited for a tool that ignored the abort
//   F8  toolResultEventFor dropped is_error on agent.tool_result
//   recovery warnings were only published, never persisted

import { describe, expect, it, vi } from "vitest";
import {
  InMemoryEventLog,
  InMemoryStreamRepo,
} from "@open-managed-agents/event-log/memory";
import type { EventLogRepo } from "@open-managed-agents/event-log";
import type { SandboxExecutor } from "@open-managed-agents/sandbox";
import type { LanguageModel } from "ai";
import type { AgentConfig, SessionEvent, UserMessageEvent } from "@open-managed-agents/shared";
import {
  SessionStateMachine,
  toolResultEventFor,
  findUnresolvedToolUses,
  type RuntimeAdapter,
  type OrphanTurn,
} from "@open-managed-agents/session-runtime";

interface HarnessInput {
  abortSignal: AbortSignal;
  eventLog: EventLogRepo;
  runtime?: { close?: () => void; flush?: () => Promise<void> };
}

function createMachine(
  harnessRun: (ctx: HarnessInput) => Promise<void>,
  opts: {
    orphans?: () => OrphanTurn[];
    runtime?: () => HarnessInput["runtime"];
    abortGraceMs?: number;
  } = {},
) {
  const log = new InMemoryEventLog(() => {});
  // Production logs (SqlEventLog) support id lookup; it's what makes a
  // retried work item a resume.
  Object.assign(log, {
    findEventByIdAsync: async (id: string) =>
      (log.getEvents() as SessionEvent[]).find((e) => (e as { id?: string }).id === id) ?? null,
  });
  const streams = new InMemoryStreamRepo();
  const sandbox: SandboxExecutor = {
    exec: async () => "",
    readFile: async () => "",
    writeFile: async () => "",
  };
  const published: SessionEvent[] = [];
  const adapter: RuntimeAdapter = {
    sql: {} as RuntimeAdapter["sql"],
    eventLog: log,
    streams,
    sandbox,
    beginTurn: vi.fn(async () => {}),
    endTurn: vi.fn(async () => {}),
    terminate: vi.fn(async () => {}),
    listOrphanTurns: vi.fn(async () => opts.orphans?.() ?? []),
    hintTurnInFlight: vi.fn(),
  };
  let harnessRuns = 0;
  const machine = new SessionStateMachine({
    sessionId: "sess_qa",
    tenantId: "tn_qa",
    adapter,
    sandbox,
    loadAgent: async () =>
      ({ id: "agent_qa", name: "QA", model: "m", system: "", tools: [] }) as unknown as AgentConfig,
    buildTools: async () => ({}),
    buildModel: async () => ({}) as LanguageModel,
    buildHarness: () => ({
      run: async (ctx) => {
        harnessRuns++;
        await harnessRun(ctx as HarnessInput);
      },
    }),
    buildHarnessContext: async (input) => ({ ...input, runtime: opts.runtime?.() }),
    publish: (event) => published.push(event),
    ...(opts.abortGraceMs !== undefined ? { abortGraceMs: opts.abortGraceMs } : {}),
    logger: { warn: () => {}, log: () => {} },
  });
  return { machine, log, published, adapter, harnessRuns: () => harnessRuns };
}

const all = (log: InMemoryEventLog) => log.getEvents() as unknown as Array<Record<string, unknown>>;
const types = (log: InMemoryEventLog) => all(log).map((e) => e.type);

describe("F2: completed turn is not re-run after a crash before queue ack", () => {
  it("acknowledges an already-completed input without calling the harness again", async () => {
    const f = createMachine(async (ctx) => {
      ctx.eventLog.append({ type: "agent.message", content: [{ type: "text", text: "done" }] } as SessionEvent);
    });
    const event = { type: "user.message", id: "one-input", content: [{ type: "text", text: "do work" }] } as unknown as UserMessageEvent;

    const first = await f.machine.runTurn("agent_qa", event, { recoverOrphans: true });
    // The queue owner died after the durable session.status_idle, before
    // markDone: the reclaimed work item replays the same input.
    const second = await f.machine.runTurn("agent_qa", event, { recoverOrphans: true });

    expect(f.harnessRuns()).toBe(1);
    expect(types(f.log)).toEqual([
      "user.message",
      "session.status_running",
      "agent.message",
      "session.status_idle",
    ]);
    expect(first).toMatchObject({ status: "completed", stopReason: { type: "end_turn" } });
    expect(second).toMatchObject({ status: "completed", alreadyCompleted: true, stopReason: { type: "end_turn" } });
    expect(f.adapter.beginTurn).toHaveBeenCalledTimes(1);
  });

  it("still resumes an input whose turn never reached its terminal idle", async () => {
    const f = createMachine(async (ctx) => {
      ctx.eventLog.append({ type: "agent.message", content: [{ type: "text", text: "resumed" }] } as SessionEvent);
    });
    const event = { type: "user.message", id: "half-done", content: [{ type: "text", text: "go" }] } as unknown as UserMessageEvent;
    // First attempt promoted the input and started, then died mid-turn.
    f.log.append({ ...event, processed_at: "x" } as unknown as SessionEvent);
    f.log.append({ type: "session.status_running" } as SessionEvent);

    const result = await f.machine.runTurn("agent_qa", event, { recoverOrphans: true });

    expect(f.harnessRuns()).toBe(1);
    expect(result.alreadyCompleted).toBeUndefined();
    expect(types(f.log).filter((t) => t === "user.message")).toHaveLength(1);
    expect(types(f.log).at(-1)).toBe("session.status_idle");
  });

  it("an idle from an earlier turn (before the promotion) doesn't count", async () => {
    const f = createMachine(async () => {});
    f.log.append({ type: "session.status_idle", stop_reason: { type: "end_turn" } } as SessionEvent);
    const event = { type: "user.message", id: "after-idle", content: [] } as unknown as UserMessageEvent;
    f.log.append({ ...event } as unknown as SessionEvent);

    await f.machine.runTurn("agent_qa", event);
    expect(f.harnessRuns()).toBe(1);
  });

  it("returns the original requires_action stop_reason for a completed client-tool turn", async () => {
    const f = createMachine(async () => {});
    const event = { type: "user.message", id: "asks", content: [] } as unknown as UserMessageEvent;
    const stop = { type: "requires_action", action_type: "custom_tool_result", event_ids: ["c1"] };
    f.log.append({ ...event } as unknown as SessionEvent);
    f.log.append({ type: "agent.custom_tool_use", id: "c1", name: "x", input: {} } as unknown as SessionEvent);
    f.log.append({ type: "session.status_idle", stop_reason: stop } as unknown as SessionEvent);

    const result = await f.machine.runTurn("agent_qa", event);
    expect(f.harnessRuns()).toBe(0);
    expect(result).toMatchObject({ alreadyCompleted: true, stopReason: stop });
  });
});

describe("F3: promoted custom-tool result survives a crash before materialization", () => {
  it("materializes agent.tool_result when only the client input was promoted", async () => {
    const f = createMachine(async (ctx) => {
      ctx.eventLog.append({ type: "agent.message", content: [{ type: "text", text: "done" }] } as SessionEvent);
    });
    const event = {
      type: "user.custom_tool_result",
      id: "client-result-event",
      custom_tool_use_id: "custom-call",
      content: [{ type: "text", text: "CLIENT_OUTPUT" }],
    } as never;
    f.log.append({ type: "agent.custom_tool_use", id: "custom-call", name: "custom", input: {} } as unknown as SessionEvent);
    f.log.append({
      type: "session.status_idle",
      stop_reason: { type: "requires_action", action_type: "custom_tool_result", event_ids: ["custom-call"] },
    } as unknown as SessionEvent);
    // Crash after promotion, before the agent.tool_result write.
    f.log.append({ ...(event as object) } as SessionEvent);

    await f.machine.runTurn("agent_qa", event, { recoverOrphans: true });

    const results = all(f.log).filter((e) => e.type === "agent.tool_result");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ tool_use_id: "custom-call", content: "CLIENT_OUTPUT" });
    expect(results[0].is_error).toBeUndefined();
    expect(types(f.log).filter((t) => t === "user.custom_tool_result")).toHaveLength(1);
    // Result precedes the resumed harness output.
    const order = types(f.log);
    expect(order.indexOf("agent.tool_result")).toBeLessThan(order.indexOf("agent.message"));
    expect(f.harnessRuns()).toBe(1);
  });

  it("is idempotent: no second result when the output already exists", async () => {
    const f = createMachine(async () => {});
    const event = {
      type: "user.custom_tool_result",
      id: "cr2",
      custom_tool_use_id: "c2",
      content: [{ type: "text", text: "OUT" }],
      is_error: true,
    } as never;
    f.log.append({ type: "agent.custom_tool_use", id: "c2", name: "custom", input: {} } as unknown as SessionEvent);
    f.log.append({
      type: "session.status_idle",
      stop_reason: { type: "requires_action", action_type: "custom_tool_result", event_ids: ["c2"] },
    } as unknown as SessionEvent);
    f.log.append({ ...(event as object) } as SessionEvent);
    f.log.append(toolResultEventFor({ id: "c2", type: "agent.custom_tool_use" }, "OUT", true));

    await f.machine.runTurn("agent_qa", event);
    expect(all(f.log).filter((e) => e.type === "agent.tool_result")).toHaveLength(1);
  });

  it("first attempt carries the client's is_error onto the result", async () => {
    const f = createMachine(async () => {});
    f.log.append({ type: "agent.custom_tool_use", id: "c3", name: "custom", input: {} } as unknown as SessionEvent);
    f.log.append({
      type: "session.status_idle",
      stop_reason: { type: "requires_action", action_type: "custom_tool_result", event_ids: ["c3"] },
    } as unknown as SessionEvent);
    await f.machine.runTurn("agent_qa", {
      type: "user.custom_tool_result",
      custom_tool_use_id: "c3",
      content: [{ type: "text", text: "boom" }],
      is_error: true,
    } as never);
    expect(all(f.log).find((e) => e.type === "agent.tool_result")).toMatchObject({
      tool_use_id: "c3",
      is_error: true,
    });
  });

  it("findUnresolvedToolUses can require the output event", () => {
    const events = [
      { type: "agent.custom_tool_use", id: "c", name: "x", input: {} },
      { type: "user.custom_tool_result", custom_tool_use_id: "c", content: [] },
    ] as unknown as SessionEvent[];
    expect(findUnresolvedToolUses(events)).toEqual([]);
    expect(findUnresolvedToolUses(events, { clientInputResolves: false }).map((u) => u.id)).toEqual(["c"]);
  });
});

describe("F6: an aborted turn ends promptly even if the harness doesn't unwind", () => {
  it("stops waiting after the grace period, closes the runtime, records the interrupted call", async () => {
    const close = vi.fn();
    let started!: () => void;
    const startedP = new Promise<void>((r) => (started = r));
    const f = createMachine(
      async (ctx) => {
        ctx.eventLog.append({ type: "agent.tool_use", id: "toolu_stuck", name: "bash", input: {} } as unknown as SessionEvent);
        started();
        await new Promise(() => {}); // a tool that ignores the abort
      },
      { runtime: () => ({ close }), abortGraceMs: 50 },
    );
    const turn = f.machine.runTurn("agent_qa", { type: "user.message", content: [] } as unknown as UserMessageEvent);
    await startedP;
    const t0 = Date.now();
    f.machine.interrupt();
    const result = await turn;

    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(result.status).toBe("interrupted");
    expect(close).toHaveBeenCalledOnce();
    expect(all(f.log).find((e) => e.type === "agent.tool_result")).toMatchObject({
      tool_use_id: "toolu_stuck",
      is_error: true,
      content: "(interrupted by user)",
    });
    expect(types(f.log).at(-1)).toBe("session.status_idle");
    expect(types(f.log)).not.toContain("session.error");
  });

  it("lease loss takes the same path and unwinds silently", async () => {
    const external = new AbortController();
    const close = vi.fn();
    const f = createMachine(async () => new Promise(() => {}), { runtime: () => ({ close }), abortGraceMs: 20 });
    const turn = f.machine.runTurn("agent_qa", { type: "user.message", content: [] } as unknown as UserMessageEvent, {
      signal: external.signal,
    });
    await new Promise((r) => setTimeout(r, 0));
    external.abort({ kind: "lease_lost" });
    await expect(turn).rejects.toMatchObject({ code: "lease_lost" });
    expect(close).toHaveBeenCalledOnce();
    expect(types(f.log)).not.toContain("session.status_idle");
  });
});

describe("F8: toolResultEventFor keeps is_error on both shapes", () => {
  it("agent.tool_result and agent.mcp_tool_result", () => {
    expect(toolResultEventFor({ id: "a", type: "agent.tool_use" }, "Denied: no", true)).toMatchObject({
      type: "agent.tool_result",
      tool_use_id: "a",
      is_error: true,
    });
    expect(toolResultEventFor({ id: "c", type: "agent.custom_tool_use" }, "x", true)).toMatchObject({
      type: "agent.tool_result",
      is_error: true,
    });
    expect(toolResultEventFor({ id: "m", type: "agent.mcp_tool_use" }, "x", true)).toMatchObject({
      type: "agent.mcp_tool_result",
      is_error: true,
    });
    expect("is_error" in (toolResultEventFor({ id: "a", type: "agent.tool_use" }, "ok") as object)).toBe(false);
  });

  it("a denied confirmation is stored with is_error", async () => {
    const f = createMachine(async () => {});
    f.log.append({ type: "agent.tool_use", id: "toolu_d", name: "bash", input: {}, evaluated_permission: "ask" } as unknown as SessionEvent);
    f.log.append({
      type: "session.status_idle",
      stop_reason: { type: "requires_action", action_type: "tool_confirmation", event_ids: ["toolu_d"] },
    } as unknown as SessionEvent);
    await f.machine.runTurn("agent_qa", {
      type: "user.tool_confirmation",
      tool_use_id: "toolu_d",
      result: "deny",
      deny_message: "QA denial test",
    } as never);
    expect(all(f.log).find((e) => e.type === "agent.tool_result")).toMatchObject({
      tool_use_id: "toolu_d",
      content: "Denied: QA denial test",
      is_error: true,
    });
  });
});

describe("recovery warnings are persisted, not just published", () => {
  it("writes session.warning to the event log during orphan recovery", async () => {
    let orphaned = true;
    const f = createMachine(async () => {}, {
      orphans: () => (orphaned ? [{ session_id: "sess_qa", turn_id: "dead", turn_started_at: Date.now() - 1000 }] : []),
    });
    f.adapter.endTurn = vi.fn(async () => {
      orphaned = false;
    });
    f.log.append({ type: "user.message", id: "u0", content: [] } as unknown as SessionEvent);
    f.log.append({
      type: "agent.tool_use",
      id: "toolu_cut",
      name: "bash",
      input: { command: "deploy" },
      execution_class: "side_effect",
    } as unknown as SessionEvent);

    await f.machine.runTurn("agent_qa", { type: "user.message", content: [] } as unknown as UserMessageEvent, {
      recoverOrphans: true,
    });

    const warning = all(f.log).find((e) => e.type === "session.warning");
    expect(warning).toMatchObject({ source: "tool_call_interrupted", tool_use_id: "toolu_cut" });
    expect(typeof warning?.message).toBe("string");
    // Published as the stored row (persist-before-broadcast).
    expect(f.published.some((e) => e.type === "session.warning")).toBe(true);
  });
});

// ── Round 2 (QA_REPORT_v2.md) ───────────────────────────────────────────

describe("N1: crash after the final reply but before idle doesn't call the model again", () => {
  const msg = (text: string, step?: string, final = false) =>
    ({
      type: "agent.message",
      content: [{ type: "text", text }],
      ...(step ? { model_request_start_id: step } : {}),
      ...(final ? { step_final: true } : {}),
    }) as unknown as SessionEvent;

  it("finalizes from the log when the last step was text-only", async () => {
    const f = createMachine(async () => {});
    const event = { type: "user.message", id: "final-reply", content: [] } as unknown as UserMessageEvent;
    // First attempt: promoted, ran a tool step, then a final text step —
    // and died right after persisting that final agent.message.
    f.log.append({ ...event, processed_at: "x" } as unknown as SessionEvent);
    f.log.append({ type: "session.status_running" } as SessionEvent);
    f.log.append({ type: "agent.tool_use", id: "t1", name: "bash", input: {}, model_request_start_id: "s1" } as unknown as SessionEvent);
    f.log.append({ type: "agent.tool_result", tool_use_id: "t1", content: "ok" } as unknown as SessionEvent);
    f.log.append(msg("all done", "s2", true));

    const result = await f.machine.runTurn("agent_qa", event, { recoverOrphans: true });

    expect(f.harnessRuns()).toBe(0);
    expect(result).toMatchObject({ status: "completed", stopReason: { type: "end_turn" } });
    expect(types(f.log).filter((t) => t === "agent.message")).toHaveLength(1);
    expect(types(f.log).at(-1)).toBe("session.status_idle");
  });

  it("still resumes when the last message's step also issued tool calls", async () => {
    const f = createMachine(async () => {});
    const event = { type: "user.message", id: "mid-step", content: [] } as unknown as UserMessageEvent;
    f.log.append({ ...event, processed_at: "x" } as unknown as SessionEvent);
    f.log.append({ type: "agent.tool_use", id: "t1", name: "read", input: {}, model_request_start_id: "s1" } as unknown as SessionEvent);
    f.log.append({ type: "agent.tool_result", tool_use_id: "t1", content: "ok" } as unknown as SessionEvent);
    f.log.append(msg("let me check", "s1"));

    await f.machine.runTurn("agent_qa", event, { recoverOrphans: true });
    expect(f.harnessRuns()).toBe(1);
  });

  it("R1: text written ahead of a tool call that never got saved is NOT final", async () => {
    // Write-ahead persists a step's leading text before its tool_use; a
    // crash in between leaves text with no tool_use and no marker.
    const f = createMachine(async () => {});
    const event = { type: "user.message", id: "prefix", content: [] } as unknown as UserMessageEvent;
    f.log.append({ ...event, processed_at: "x" } as unknown as SessionEvent);
    f.log.append(msg("I will check with a tool.", "s1"));

    await f.machine.runTurn("agent_qa", event, { recoverOrphans: true });
    expect(f.harnessRuns()).toBe(1);
  });

  it("R2: an empty reply is never treated as final (silent_stop must still run)", async () => {
    const f = createMachine(async () => {});
    const event = { type: "user.message", id: "empty", content: [] } as unknown as UserMessageEvent;
    f.log.append({ ...event, processed_at: "x" } as unknown as SessionEvent);
    f.log.append(msg("", "s1"));

    await f.machine.runTurn("agent_qa", event, { recoverOrphans: true });
    expect(f.harnessRuns()).toBe(1);
  });

  it("legacy messages without a step id keep the old resume behaviour", async () => {
    const f = createMachine(async () => {});
    const event = { type: "user.message", id: "legacy", content: [] } as unknown as UserMessageEvent;
    f.log.append({ ...event, processed_at: "x" } as unknown as SessionEvent);
    f.log.append(msg("no step id"));

    await f.machine.runTurn("agent_qa", event, { recoverOrphans: true });
    expect(f.harnessRuns()).toBe(1);
  });
});

describe("N4: a turn that already failed stays failed when its work item is reclaimed", () => {
  it("re-raises instead of acknowledging the input as completed", async () => {
    let calls = 0;
    const f = createMachine(async () => {
      calls++;
      throw new Error("temporary provider failure");
    });
    const event = { type: "user.message", id: "fails", content: [] } as unknown as UserMessageEvent;

    await expect(f.machine.runTurn("agent_qa", event, { recoverOrphans: true })).rejects.toThrow(/temporary provider failure/);
    // Crash between the error idle and markFailed: the queue replays it.
    await expect(f.machine.runTurn("agent_qa", event, { recoverOrphans: true })).rejects.toThrow(
      /already failed before the crash: temporary provider failure/,
    );

    expect(calls).toBe(1);
    // No second session.error / idle pair for the replay.
    expect(types(f.log).filter((t) => t === "session.error")).toHaveLength(1);
    expect(types(f.log).filter((t) => t === "session.status_idle")).toHaveLength(1);
  });
});
