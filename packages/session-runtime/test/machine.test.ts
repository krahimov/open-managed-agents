import { describe, expect, it, vi } from "vitest";
import {
  InMemoryEventLog,
  InMemoryStreamRepo,
} from "@open-managed-agents/event-log/memory";
import type { EventLogRepo } from "@open-managed-agents/event-log";
import type { SandboxExecutor } from "@open-managed-agents/sandbox";
import type { LanguageModel } from "ai";
import type {
  AgentConfig,
  SessionEvent,
  UserMessageEvent,
} from "@open-managed-agents/shared";
import {
  SessionStateMachine,
  sessionErrorAlreadyEmitted,
  activeOutcomeFromEvents,
} from "@open-managed-agents/session-runtime";
import type { RuntimeAdapter } from "@open-managed-agents/session-runtime";

interface HarnessInput {
  abortSignal: AbortSignal;
  eventLog: EventLogRepo;
  userMessage: UserMessageEvent;
  runtime?: { pendingConfirmations?: string[]; flush?: () => Promise<void> };
}

function createMachine(
  harnessRun: (ctx: HarnessInput) => Promise<void>,
  opts: {
    tools?: (agent: AgentConfig) => Record<string, unknown>;
    runtime?: () => HarnessInput["runtime"];
  } = {},
): {
  machine: SessionStateMachine;
  log: InMemoryEventLog;
  published: SessionEvent[];
  adapter: RuntimeAdapter;
  buildTools: ReturnType<typeof vi.fn>;
} {
  const log = new InMemoryEventLog(() => {});
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
    listOrphanTurns: vi.fn(async () => []),
    hintTurnInFlight: vi.fn(),
  };
  const buildTools = vi.fn(async (agent: AgentConfig) => opts.tools?.(agent) ?? {});

  const machine = new SessionStateMachine({
    sessionId: "sess_test",
    tenantId: "tn_test",
    adapter,
    sandbox,
    loadAgent: async () =>
      ({
        id: "agent_test",
        name: "Test Agent",
        model: "test-model",
        system: "You are a test agent.",
        tools: [
          {
            type: "agent_toolset_20260401",
            configs: [{ name: "bash", enabled: true, permission_policy: { type: "always_ask" } }],
          },
        ],
      }) as unknown as AgentConfig,
    buildTools,
    buildModel: async () => ({}) as LanguageModel,
    buildHarness: () => ({ run: (ctx) => harnessRun(ctx as HarnessInput) }),
    buildHarnessContext: async (input) => ({ ...input, runtime: opts.runtime?.() }),
    publish: (event) => published.push(event),
  });
  return { machine, log, published, adapter, buildTools };
}

const userMessage = {
  type: "user.message",
  content: [{ type: "text", text: "hello" }],
  session_thread_id: "sthr_primary",
} as unknown as UserMessageEvent;

const types = (log: InMemoryEventLog) =>
  (log.getEvents() as SessionEvent[]).map((event) => event.type);

const lastIdle = (log: InMemoryEventLog) =>
  (log.getEvents() as SessionEvent[])
    .filter((e) => e.type === "session.status_idle")
    .at(-1) as unknown as { stop_reason?: Record<string, unknown> };

describe("SessionStateMachine lifecycle events", () => {
  it("promotes the user message and emits running and idle events around a successful turn", async () => {
    const f = createMachine(async () => {});

    await f.machine.runHarnessTurn("agent_test", userMessage);

    const events = f.log.getEvents() as SessionEvent[];
    expect(types(f.log)).toEqual([
      "user.message",
      "session.status_running",
      "session.status_idle",
    ]);
    expect((events[0] as { processed_at?: string }).processed_at).toBeTruthy();
    expect((events[2] as { stop_reason?: { type: string } }).stop_reason).toEqual({
      type: "end_turn",
    });
    expect(events.every((event) => (event as { id?: string }).id)).toBe(true);
    // Promotion notification is broadcast-only (not persisted).
    expect(f.published.map((event) => event.type)).toEqual([
      "user.message",
      "system.user_message_promoted",
      "session.status_running",
      "session.status_idle",
    ]);
    expect(f.adapter.endTurn).toHaveBeenCalledWith("sess_test", expect.any(String), "idle");
  });

  it("emits error and idle events when the harness throws", async () => {
    const err = new Error("boom");
    const f = createMachine(async () => {
      throw err;
    });

    await expect(f.machine.runHarnessTurn("agent_test", userMessage)).rejects.toThrow(
      "boom",
    );

    const events = f.log.getEvents() as SessionEvent[];
    expect(types(f.log)).toEqual([
      "user.message",
      "session.status_running",
      "session.error",
      "session.status_idle",
    ]);
    expect((events[2] as { message?: string }).message).toBe("boom");
    expect((events[3] as { stop_reason?: unknown }).stop_reason).toBeUndefined();
    expect(sessionErrorAlreadyEmitted(err)).toBe(true);
  });

  it("does not promote the same event twice when a turn is retried", async () => {
    const f = createMachine(async () => {});
    const withId = { ...userMessage, id: "sevt-fixed" } as UserMessageEvent;
    // Simulate the first attempt having promoted the row already.
    f.log.append({ ...withId } as SessionEvent);
    const findEventByIdAsync = async (id: string) =>
      (f.log.getEvents() as SessionEvent[]).find((e) => (e as { id?: string }).id === id) ?? null;
    Object.assign(f.log, { findEventByIdAsync });

    await f.machine.runTurn("agent_test", withId);

    expect(types(f.log).filter((t) => t === "user.message")).toHaveLength(1);
  });
});

/** Harness that asks for a gated bash call (no result → pending). */
function gatedToolHarness(ids: string[], kind: "agent.tool_use" | "agent.custom_tool_use" = "agent.tool_use") {
  let calls = 0;
  const run = async (ctx: HarnessInput) => {
    calls++;
    if (calls > 1) {
      ctx.eventLog.append({ type: "agent.message", content: [{ type: "text", text: "done" }] } as SessionEvent);
      return;
    }
    for (const id of ids) {
      ctx.eventLog.append({
        type: kind,
        id,
        name: kind === "agent.tool_use" ? "bash" : "send_email",
        input: { command: "echo hi" },
        ...(kind === "agent.tool_use" ? { evaluated_permission: "ask" } : {}),
      } as unknown as SessionEvent);
    }
    ctx.runtime?.pendingConfirmations?.push(...ids);
  };
  return { run, calls: () => calls };
}

describe("SessionStateMachine human-in-the-loop", () => {
  it("ends with requires_action and resumes after an allowed tool confirmation", async () => {
    const h = gatedToolHarness(["toolu_1"]);
    const execute = vi.fn(async () => "hi\n");
    const f = createMachine(h.run, {
      runtime: () => ({ pendingConfirmations: [] }),
      // buildTools strips execute for always_ask tools; only the lifted
      // config (no permission_policy) gets the executable tool.
      tools: (agent) => {
        const gated = JSON.stringify(agent.tools).includes("always_ask");
        return { bash: gated ? {} : { execute } };
      },
    });

    await f.machine.runTurn("agent_test", userMessage);
    expect(lastIdle(f.log).stop_reason).toEqual({
      type: "requires_action",
      action_type: "tool_confirmation",
      event_ids: ["toolu_1"],
    });

    const result = await f.machine.runTurn("agent_test", {
      type: "user.tool_confirmation",
      tool_use_id: "toolu_1",
      result: "allow",
    } as never);

    expect(result.status).toBe("completed");
    expect(execute).toHaveBeenCalledWith(
      { command: "echo hi" },
      expect.objectContaining({ toolCallId: "toolu_1" }),
    );
    const events = f.log.getEvents() as Array<Record<string, unknown>>;
    const toolResult = events.find((e) => e.type === "agent.tool_result");
    expect(toolResult).toMatchObject({ tool_use_id: "toolu_1", content: "hi\n" });
    expect(h.calls()).toBe(2); // harness resumed
    expect(events.at(-2)).toMatchObject({ type: "agent.message" });
    expect(lastIdle(f.log).stop_reason).toEqual({ type: "end_turn" });
  });

  it("records a denial and resumes the harness", async () => {
    const h = gatedToolHarness(["toolu_1"]);
    const f = createMachine(h.run, { runtime: () => ({ pendingConfirmations: [] }) });
    await f.machine.runTurn("agent_test", userMessage);

    await f.machine.runTurn("agent_test", {
      type: "user.tool_confirmation",
      tool_use_id: "toolu_1",
      result: "deny",
      deny_message: "not today",
    } as never);

    const toolResult = (f.log.getEvents() as Array<Record<string, unknown>>).find(
      (e) => e.type === "agent.tool_result",
    );
    expect(toolResult).toMatchObject({ tool_use_id: "toolu_1", content: "Denied: not today" });
    expect(h.calls()).toBe(2);
    expect(lastIdle(f.log).stop_reason).toEqual({ type: "end_turn" });
  });

  it("waits for every custom tool result before resuming", async () => {
    const h = gatedToolHarness(["ctu_1", "ctu_2"], "agent.custom_tool_use");
    const f = createMachine(h.run, { runtime: () => ({ pendingConfirmations: [] }) });
    await f.machine.runTurn("agent_test", userMessage);
    expect(lastIdle(f.log).stop_reason).toMatchObject({
      action_type: "custom_tool_result",
      event_ids: ["ctu_1", "ctu_2"],
    });

    await f.machine.runTurn("agent_test", {
      type: "user.custom_tool_result",
      custom_tool_use_id: "ctu_1",
      content: [{ type: "text", text: "sent" }],
    } as never);
    expect(h.calls()).toBe(1); // still waiting on ctu_2
    expect(lastIdle(f.log).stop_reason).toEqual({
      type: "requires_action",
      action_type: "custom_tool_result",
      event_ids: ["ctu_2"],
    });

    await f.machine.runTurn("agent_test", {
      type: "user.custom_tool_result",
      custom_tool_use_id: "ctu_2",
      content: [{ type: "text", text: "sent too" }],
    } as never);
    expect(h.calls()).toBe(2);
    const results = (f.log.getEvents() as Array<Record<string, unknown>>).filter(
      (e) => e.type === "agent.tool_result",
    );
    expect(results.map((r) => r.content)).toEqual(["sent", "sent too"]);
    expect(lastIdle(f.log).stop_reason).toEqual({ type: "end_turn" });
  });

  it("closes unresolved tool calls before a new user message", async () => {
    const h = gatedToolHarness(["toolu_1"]);
    const f = createMachine(h.run, { runtime: () => ({ pendingConfirmations: [] }) });
    await f.machine.runTurn("agent_test", userMessage);
    await f.machine.runTurn("agent_test", { ...userMessage, id: "sevt-second" } as UserMessageEvent);

    const events = f.log.getEvents() as Array<Record<string, unknown>>;
    const resultIdx = events.findIndex((e) => e.type === "agent.tool_result");
    const secondIdx = events.findIndex((e) => e.id === "sevt-second");
    expect(resultIdx).toBeGreaterThan(-1);
    expect(resultIdx).toBeLessThan(secondIdx);
  });
});

describe("SessionStateMachine resume (retried work item)", () => {
  function withIdLookup(log: InMemoryEventLog) {
    Object.assign(log, {
      findEventByIdAsync: async (id: string) =>
        (log.getEvents() as SessionEvent[]).find((e) => (e as { id?: string }).id === id) ?? null,
    });
  }

  it("does not re-execute an approved side-effect call whose first attempt died", async () => {
    const h = gatedToolHarness(["toolu_1"]);
    const execute = vi.fn(async () => "ran");
    const f = createMachine(h.run, {
      runtime: () => ({ pendingConfirmations: [] }),
      tools: () => ({ bash: { execute } }),
    });
    withIdLookup(f.log);
    await f.machine.runTurn("agent_test", userMessage);
    const confirmation = {
      type: "user.tool_confirmation",
      id: "sevt-confirm",
      tool_use_id: "toolu_1",
      result: "allow",
    } as never;
    // First attempt promoted the confirmation, then the worker died.
    f.log.append({ ...(confirmation as object), processed_at: "x" } as SessionEvent);

    await f.machine.runTurn("agent_test", confirmation);

    expect(execute).not.toHaveBeenCalled();
    const result = (f.log.getEvents() as Array<Record<string, unknown>>).find(
      (e) => e.type === "agent.tool_result",
    );
    expect(result).toMatchObject({ tool_use_id: "toolu_1", is_error: true });
    expect(String(result?.content)).toMatch(/MAY have taken effect/);
  });

  it("leaves the turn's own unresolved calls to the harness when resuming a user.message", async () => {
    const f = createMachine(async () => {});
    withIdLookup(f.log);
    const msg = { ...userMessage, id: "sevt-resume" } as UserMessageEvent;
    f.log.append({ ...msg } as SessionEvent);
    f.log.append({ type: "agent.tool_use", id: "toolu_read", name: "read", input: {} } as unknown as SessionEvent);

    await f.machine.runTurn("agent_test", msg);

    expect(types(f.log)).not.toContain("agent.tool_result");
    expect(types(f.log).filter((t) => t === "user.message")).toHaveLength(1);
  });
});

describe("SessionStateMachine interrupt", () => {
  it("aborts a running turn and ends it idle without a session.error", async () => {
    let seenSignal: AbortSignal | null = null;
    let started!: () => void;
    const startedP = new Promise<void>((r) => (started = r));
    const f = createMachine(async (ctx) => {
      seenSignal = ctx.abortSignal;
      ctx.eventLog.append({
        type: "agent.tool_use",
        id: "toolu_run",
        name: "bash",
        input: {},
      } as unknown as SessionEvent);
      started();
      await new Promise<void>((_, reject) => {
        ctx.abortSignal.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      });
    });

    const turn = f.machine.runTurn("agent_test", userMessage);
    await startedP;
    expect(f.machine.hasInflightTurn()).toBe(true);
    expect(f.machine.interrupt()).toBe(true);
    const result = await turn;

    expect(result.status).toBe("interrupted");
    expect(seenSignal!.aborted).toBe(true);
    expect(types(f.log)).not.toContain("session.error");
    expect(lastIdle(f.log).stop_reason).toEqual({ type: "end_turn" });
    // The cut-off tool call was closed so the next model call is valid.
    expect(
      (f.log.getEvents() as Array<Record<string, unknown>>).find((e) => e.type === "agent.tool_result"),
    ).toMatchObject({ tool_use_id: "toolu_run" });
    expect(f.machine.hasInflightTurn()).toBe(false);
    expect(f.machine.interrupt()).toBe(false);
  });

  it("unwinds silently (no turn-end events) when the lease is lost", async () => {
    const external = new AbortController();
    const f = createMachine(async (ctx) => {
      await new Promise<void>((_, reject) =>
        ctx.abortSignal.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    });
    const turn = f.machine.runTurn("agent_test", userMessage, { signal: external.signal });
    await new Promise((r) => setTimeout(r, 0));
    external.abort({ kind: "lease_lost" });
    await expect(turn).rejects.toMatchObject({ code: "lease_lost" });
    expect(types(f.log)).toEqual(["user.message", "session.status_running"]);
    expect(f.adapter.endTurn).not.toHaveBeenCalled();
  });

  it("surfaces a harness-runtime persistence failure as the turn failure", async () => {
    const f = createMachine(async () => {}, {
      runtime: () => ({
        flush: async () => {
          throw new Error("disk full");
        },
      }),
    });
    await expect(f.machine.runTurn("agent_test", userMessage)).rejects.toThrow("disk full");
    expect(types(f.log)).toContain("session.error");
  });
});

describe("activeOutcomeFromEvents", () => {
  it("derives the active outcome and the next iteration from the log", () => {
    const define = {
      type: "user.define_outcome",
      outcome_id: "outc_1",
      description: "tests pass",
      rubric: "all green",
    } as unknown as SessionEvent;
    const end = (iteration: number, result: string) =>
      ({ type: "span.outcome_evaluation_end", outcome_id: "outc_1", iteration, result }) as unknown as SessionEvent;

    expect(activeOutcomeFromEvents([])).toBeNull();
    expect(activeOutcomeFromEvents([define])).toMatchObject({
      outcome: { outcome_id: "outc_1", rubric: "all green" },
      iteration: 0,
    });
    expect(activeOutcomeFromEvents([define, end(0, "needs_revision")])?.iteration).toBe(1);
    expect(activeOutcomeFromEvents([define, end(0, "needs_revision"), end(1, "satisfied")])).toBeNull();
  });
});
