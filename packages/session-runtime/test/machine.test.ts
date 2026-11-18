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
import { attachToolsRelease } from "@open-managed-agents/shared";
import {
  SessionStateMachine,
  sessionErrorAlreadyEmitted,
  activeOutcomeFromEvents,
  findOrphanToolUses,
  findUnresolvedToolUses,
  TurnLeaseLostError,
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

  it("a repeated confirmation for a call the turn already went past does not resume the model", async () => {
    // Clients that re-send ids an intermediate idle still listed (their
    // first answers were queued) must not trigger a second model run over
    // the whole context once the turn has finished.
    const h = gatedToolHarness(["toolu_1"]);
    const execute = vi.fn(async () => "hi\n");
    const f = createMachine(h.run, {
      runtime: () => ({ pendingConfirmations: [] }),
      tools: (agent) => ({ bash: JSON.stringify(agent.tools).includes("always_ask") ? {} : { execute } }),
    });
    await f.machine.runTurn("agent_test", userMessage);
    const confirm = { type: "user.tool_confirmation", tool_use_id: "toolu_1", result: "allow" } as never;
    await f.machine.runTurn("agent_test", confirm);
    expect(h.calls()).toBe(2);

    const again = await f.machine.runTurn("agent_test", { ...(confirm as object) } as never);
    expect(again.status).toBe("completed");
    expect(h.calls()).toBe(2);
    expect(execute).toHaveBeenCalledTimes(1);
    expect((f.log.getEvents() as SessionEvent[]).filter((e) => e.type === "agent.message")).toHaveLength(1);
    expect(lastIdle(f.log).stop_reason).toEqual({ type: "end_turn" });
  });

  it("a confirmation naming no tool call of the session does not resume the model", async () => {
    // pi regression eval (2026-11): an answer arriving after the turn's
    // end_turn re-ran the model, which redid the whole job (~15 more tool
    // calls and a second, different final answer).
    const h = gatedToolHarness(["toolu_1"]);
    const execute = vi.fn(async () => "hi\n");
    const f = createMachine(h.run, {
      runtime: () => ({ pendingConfirmations: [] }),
      tools: (agent) => ({ bash: JSON.stringify(agent.tools).includes("always_ask") ? {} : { execute } }),
    });
    await f.machine.runTurn("agent_test", userMessage);
    await f.machine.runTurn("agent_test", {
      type: "user.tool_confirmation",
      tool_use_id: "toolu_1",
      result: "allow",
    } as never);
    expect(h.calls()).toBe(2);

    const unknown = await f.machine.runTurn("agent_test", {
      type: "user.tool_confirmation",
      tool_use_id: "toolu_nope",
      result: "allow",
    } as never);
    expect(unknown.status).toBe("completed");
    expect(h.calls()).toBe(2);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(lastIdle(f.log).stop_reason).toEqual({ type: "end_turn" });
  });

  it("an unknown id while another call waits hands the outstanding call back and leaves it answerable", async () => {
    const h = gatedToolHarness(["toolu_1"]);
    const f = createMachine(h.run, { runtime: () => ({ pendingConfirmations: [] }) });
    await f.machine.runTurn("agent_test", userMessage);

    await f.machine.runTurn("agent_test", {
      type: "user.custom_tool_result",
      custom_tool_use_id: "ctu_nope",
      content: [{ type: "text", text: "?" }],
    } as never);
    expect(h.calls()).toBe(1);
    expect(lastIdle(f.log).stop_reason).toEqual({
      type: "requires_action",
      action_type: "tool_confirmation",
      event_ids: ["toolu_1"],
    });
    expect((f.log.getEvents() as SessionEvent[]).some((e) => e.type === "agent.tool_result")).toBe(false);

    await f.machine.runTurn("agent_test", {
      type: "user.tool_confirmation",
      tool_use_id: "toolu_1",
      result: "deny",
    } as never);
    expect(h.calls()).toBe(2);
    expect(lastIdle(f.log).stop_reason).toEqual({ type: "end_turn" });
  });

  it("a confirmation for a call that was never gated neither runs it nor resumes the model", async () => {
    // A cut-off, ungated call stays unresolved (no orphan recovery here);
    // "allow" for it must not execute it outside the harness.
    let calls = 0;
    const execute = vi.fn(async () => "ran\n");
    const f = createMachine(
      async (ctx) => {
        calls++;
        ctx.eventLog.append({
          type: "agent.tool_use",
          id: "toolu_free",
          name: "bash",
          input: { command: "echo hi" },
        } as unknown as SessionEvent);
      },
      { runtime: () => ({ pendingConfirmations: [] }), tools: () => ({ bash: { execute } }) },
    );
    await f.machine.runTurn("agent_test", userMessage);
    expect(lastIdle(f.log).stop_reason).toEqual({ type: "end_turn" });

    await f.machine.runTurn("agent_test", {
      type: "user.tool_confirmation",
      tool_use_id: "toolu_free",
      result: "allow",
    } as never);
    expect(calls).toBe(1);
    expect(execute).not.toHaveBeenCalled();
    expect(lastIdle(f.log).stop_reason).toEqual({ type: "end_turn" });
  });

  it("an answer re-sent after its turn failed still retries the turn", async () => {
    // The tool result is in, but the model call after it failed (idle
    // without stop_reason): the client re-sending the answer is the retry.
    let calls = 0;
    const execute = vi.fn(async () => "hi\n");
    const f = createMachine(
      async (ctx) => {
        calls++;
        if (calls === 1) {
          ctx.eventLog.append({
            type: "agent.tool_use",
            id: "toolu_1",
            name: "bash",
            input: { command: "echo hi" },
            evaluated_permission: "ask",
          } as unknown as SessionEvent);
          ctx.runtime?.pendingConfirmations?.push("toolu_1");
          return;
        }
        if (calls === 2) throw new Error("provider 500");
        ctx.eventLog.append({ type: "agent.message", content: [{ type: "text", text: "done" }] } as SessionEvent);
      },
      {
        runtime: () => ({ pendingConfirmations: [] }),
        tools: (agent) => ({ bash: JSON.stringify(agent.tools).includes("always_ask") ? {} : { execute } }),
      },
    );
    await f.machine.runTurn("agent_test", userMessage);
    const confirm = { type: "user.tool_confirmation", tool_use_id: "toolu_1", result: "allow" };
    await f.machine.runTurn("agent_test", confirm as never).catch(() => {});
    expect(calls).toBe(2);

    await f.machine.runTurn("agent_test", { ...confirm } as never);
    expect(calls).toBe(3);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(lastIdle(f.log).stop_reason).toEqual({ type: "end_turn" });
  });

  it("an approved call_mcp_tool runs the deferred MCP tool it names, with its arguments", async () => {
    let calls = 0;
    const run = async (ctx: HarnessInput) => {
      calls++;
      if (calls > 1) {
        ctx.eventLog.append({ type: "agent.message", content: [{ type: "text", text: "done" }] } as SessionEvent);
        return;
      }
      ctx.eventLog.append({
        type: "agent.tool_use",
        id: "toolu_meta",
        name: "call_mcp_tool",
        input: { name: "mcp__linear__create_issue", arguments: { title: "Bug" } },
        evaluated_permission: "ask",
      } as unknown as SessionEvent);
      ctx.runtime?.pendingConfirmations?.push("toolu_meta");
    };
    const target = vi.fn(async () => "ISS-1");
    const f = createMachine(run, {
      runtime: () => ({ pendingConfirmations: [] }),
      // The rebuilt dict has no call_mcp_tool (it only exists after
      // per-turn budgeting) — just the deferred tool itself.
      tools: () => ({ mcp__linear__create_issue: { execute: target } }),
    });
    await f.machine.runTurn("agent_test", userMessage);
    expect(lastIdle(f.log).stop_reason).toMatchObject({ action_type: "tool_confirmation", event_ids: ["toolu_meta"] });

    await f.machine.runTurn("agent_test", {
      type: "user.tool_confirmation",
      tool_use_id: "toolu_meta",
      result: "allow",
    } as never);

    expect(target).toHaveBeenCalledWith({ title: "Bug" }, expect.objectContaining({ toolCallId: "toolu_meta" }));
    const toolResult = (f.log.getEvents() as Array<Record<string, unknown>>).find((e) => e.type === "agent.tool_result");
    expect(toolResult).toMatchObject({ tool_use_id: "toolu_meta", content: "ISS-1" });
  });

  it("an approved MCP image result is stored like the in-turn one: placeholder on mcp_tool_result, blocks on tool_result", async () => {
    const png = "A".repeat(1_400_000); // ~1 MB screenshot, base64
    const blocks = [
      { type: "text", text: "Screenshot of the dashboard" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: png } },
    ];
    const run = async (ctx: HarnessInput) => {
      if ((ctx.eventLog.getEvents() as SessionEvent[]).some((e) => e.type === "agent.mcp_tool_use")) return;
      ctx.eventLog.append({
        type: "agent.mcp_tool_use",
        id: "toolu_img",
        name: "mcp__browser__screenshot",
        mcp_server_name: "browser",
        input: {},
        evaluated_permission: "ask",
      } as unknown as SessionEvent);
      ctx.eventLog.append({
        type: "agent.tool_use",
        id: "toolu_img2",
        name: "call_mcp_tool",
        input: { name: "mcp__browser__screenshot", arguments: {} },
        evaluated_permission: "ask",
      } as unknown as SessionEvent);
      ctx.runtime?.pendingConfirmations?.push("toolu_img", "toolu_img2");
    };
    // MCP tools return the model-facing form: ContentBlock[] for images.
    const f = createMachine(run, {
      runtime: () => ({ pendingConfirmations: [] }),
      tools: () => ({ mcp__browser__screenshot: { execute: async () => blocks } }),
    });
    await f.machine.runTurn("agent_test", userMessage);
    for (const id of ["toolu_img", "toolu_img2"]) {
      await f.machine.runTurn("agent_test", { type: "user.tool_confirmation", tool_use_id: id, result: "allow" } as never);
    }
    const events = f.log.getEvents() as Array<Record<string, unknown>>;
    const direct = events.find((e) => e.type === "agent.mcp_tool_result");
    expect(direct?.content).toBe(
      "Screenshot of the dashboard\n[image image/png returned by the tool — shown when it ran, not kept in history]",
    );
    // agent.tool_result carries ContentBlock[] — the same blocks call_mcp_tool stores in-turn.
    expect(events.find((e) => e.type === "agent.tool_result")).toMatchObject({ tool_use_id: "toolu_img2", content: blocks });
  });

  it("releases each tool dict it built (MCP clients) once the turn or the approval is done with it", async () => {
    let calls = 0;
    const run = async (ctx: HarnessInput) => {
      calls++;
      if (calls > 1) return;
      ctx.eventLog.append({
        type: "agent.tool_use",
        id: "toolu_rel",
        name: "call_mcp_tool",
        input: { name: "mcp__linear__create_issue", arguments: { title: "Bug" } },
        evaluated_permission: "ask",
      } as unknown as SessionEvent);
      ctx.runtime?.pendingConfirmations?.push("toolu_rel");
    };
    const released: string[] = [];
    const openWhileRunning: boolean[] = [];
    let built = 0;
    const f = createMachine(run, {
      runtime: () => ({ pendingConfirmations: [] }),
      tools: () => {
        const id = `dict${++built}`;
        const dict = {
          mcp__linear__create_issue: {
            execute: async () => {
              // Still open while the approved call runs.
              openWhileRunning.push(!released.includes(id));
              return "ISS-2";
            },
          },
        };
        attachToolsRelease(dict, async () => void released.push(id));
        return dict;
      },
    });
    const settle = () => new Promise((r) => setTimeout(r, 0));
    await f.machine.runTurn("agent_test", userMessage);
    await settle();
    expect(released).toEqual(["dict1"]);
    await f.machine.runTurn("agent_test", {
      type: "user.tool_confirmation",
      tool_use_id: "toolu_rel",
      result: "allow",
    } as never);
    await settle();
    // dict2 = the confirmation turn's dict, dict3 = the approval rebuild.
    expect(released.sort()).toEqual(["dict1", "dict2", "dict3"]);
    expect(openWhileRunning).toEqual([true]);
    expect((f.log.getEvents() as Array<Record<string, unknown>>).find((e) => e.type === "agent.tool_result"))
      .toMatchObject({ tool_use_id: "toolu_rel", content: "ISS-2" });
  });

  it("an approved call_mcp_tool with unparseable arguments errors instead of running the target with {}", async () => {
    let calls = 0;
    const run = async (ctx: HarnessInput) => {
      if (++calls > 1) return;
      ctx.eventLog.append({
        type: "agent.tool_use",
        id: "toolu_meta",
        name: "call_mcp_tool",
        input: { name: "mcp__linear__delete_issue", arguments: '{"id":"ISS-1"' },
        evaluated_permission: "ask",
      } as unknown as SessionEvent);
      ctx.runtime?.pendingConfirmations?.push("toolu_meta");
    };
    const target = vi.fn(async () => "deleted");
    const f = createMachine(run, {
      runtime: () => ({ pendingConfirmations: [] }),
      tools: () => ({ mcp__linear__delete_issue: { execute: target } }),
    });
    await f.machine.runTurn("agent_test", userMessage);
    await f.machine.runTurn("agent_test", { type: "user.tool_confirmation", tool_use_id: "toolu_meta", result: "allow" } as never);
    expect(target).not.toHaveBeenCalled();
    const toolResult = (f.log.getEvents() as Array<Record<string, unknown>>).find((e) => e.type === "agent.tool_result");
    expect(toolResult).toMatchObject({ tool_use_id: "toolu_meta", is_error: true });
    expect(String(toolResult?.content)).toMatch(/must be a JSON object/);
  });

  it("an approved call_mcp_tool never resolves to a non-MCP tool", async () => {
    let calls = 0;
    const run = async (ctx: HarnessInput) => {
      if (++calls > 1) return;
      ctx.eventLog.append({
        type: "agent.tool_use",
        id: "toolu_meta",
        name: "call_mcp_tool",
        input: { name: "bash", arguments: { command: "rm -rf /" } },
        evaluated_permission: "ask",
      } as unknown as SessionEvent);
      ctx.runtime?.pendingConfirmations?.push("toolu_meta");
    };
    const bash = vi.fn(async () => "ran");
    const meta = vi.fn(async () => "ran");
    const f = createMachine(run, {
      runtime: () => ({ pendingConfirmations: [] }),
      // Even if the rebuilt dict carried call_mcp_tool itself, an approval
      // must neither run it nor let it reach a built-in.
      tools: () => ({ bash: { execute: bash }, call_mcp_tool: { execute: meta } }),
    });
    await f.machine.runTurn("agent_test", userMessage);
    await f.machine.runTurn("agent_test", { type: "user.tool_confirmation", tool_use_id: "toolu_meta", result: "allow" } as never);
    expect(bash).not.toHaveBeenCalled();
    expect(meta).not.toHaveBeenCalled();
    const toolResult = (f.log.getEvents() as Array<Record<string, unknown>>).find((e) => e.type === "agent.tool_result");
    expect(toolResult).toMatchObject({ tool_use_id: "toolu_meta", is_error: true });
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

  it("re-runs an approved call_mcp_tool whose deferred target is read-only (its annotations, not call_mcp_tool's)", async () => {
    const parked = (target: string) => async (ctx: HarnessInput) => {
      if ((ctx.eventLog.getEvents() as SessionEvent[]).some((e) => e.type === "agent.tool_use")) return;
      ctx.eventLog.append({
        type: "agent.tool_use",
        id: "toolu_ro",
        name: "call_mcp_tool",
        input: { name: target, arguments: { query: "roadmap" } },
        evaluated_permission: "ask",
        execution_class: "client",
      } as unknown as SessionEvent);
      ctx.runtime?.pendingConfirmations?.push("toolu_ro");
    };
    const execute = vi.fn(async () => "3 pages");
    const tools = () => ({
      mcp__notion__search: { execute, annotations: { readOnlyHint: true } },
      mcp__notion__create_pages: { execute },
    });
    for (const [target, reruns] of [["mcp__notion__search", true], ["mcp__notion__create_pages", false]] as const) {
      execute.mockClear();
      const f = createMachine(parked(target), { runtime: () => ({ pendingConfirmations: [] }), tools });
      withIdLookup(f.log);
      await f.machine.runTurn("agent_test", userMessage);
      const confirmation = { type: "user.tool_confirmation", id: "sevt-c", tool_use_id: "toolu_ro", result: "allow" } as never;
      f.log.append({ ...(confirmation as object), processed_at: "x" } as SessionEvent);
      await f.machine.runTurn("agent_test", confirmation);

      const result = (f.log.getEvents() as Array<Record<string, unknown>>).find((e) => e.type === "agent.tool_result");
      if (reruns) {
        expect(execute).toHaveBeenCalledWith({ query: "roadmap" }, expect.objectContaining({ toolCallId: "toolu_ro" }));
        expect(result).toMatchObject({ tool_use_id: "toolu_ro", content: "3 pages" });
      } else {
        expect(execute).not.toHaveBeenCalled();
        expect(String(result?.content)).toMatch(/MAY have taken effect/);
      }
    }
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

describe("SessionStateMachine batched client answers", () => {
  const confirm = (id: string, extra: Record<string, unknown> = {}) =>
    ({ type: "user.tool_confirmation", id: `sevt-${id}-${Math.random()}`, tool_use_id: id, result: "allow", ...extra }) as never;
  const idles = (log: InMemoryEventLog) =>
    (log.getEvents() as Array<Record<string, unknown>>).filter((e) => e.type === "session.status_idle");
  const gatedTools = (execute: ReturnType<typeof vi.fn>) => (agent: AgentConfig) => ({
    bash: JSON.stringify(agent.tools).includes("always_ask") ? {} : { execute },
  });
  /** takeQueuedClientResults stub handing out one batch per call. */
  const queue = (...batches: unknown[][]) => {
    const take = vi.fn(async () => (batches.shift() ?? []).map((event) => ({ event }) as never));
    return take;
  };

  it("applies the answers queued behind a confirmation in the same turn: one running/idle, no idle listing a queued id", async () => {
    // 2026-11 evals: three confirmations POSTed together ran as three
    // turns; the idles in between listed the ids still queued, so the
    // client re-sent them.
    const h = gatedToolHarness(["toolu_1", "toolu_2", "toolu_3"]);
    const execute = vi.fn(async () => "hi\n");
    const f = createMachine(h.run, { runtime: () => ({ pendingConfirmations: [] }), tools: gatedTools(execute) });
    await f.machine.runTurn("agent_test", userMessage);
    const turnStart = f.log.getEvents().length;

    const take = queue([confirm("toolu_2"), confirm("toolu_3")]);
    await f.machine.runTurn("agent_test", confirm("toolu_1"), { takeQueuedClientResults: take });

    const turn = (f.log.getEvents() as Array<Record<string, unknown>>).slice(turnStart);
    expect(turn.map((e) => e.type)).toEqual([
      "user.tool_confirmation",
      "session.status_running",
      "agent.tool_result",
      "user.tool_confirmation",
      "agent.tool_result",
      "user.tool_confirmation",
      "agent.tool_result",
      "agent.message",
      "session.status_idle",
    ]);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(h.calls()).toBe(2);
    expect(idles(f.log)).toHaveLength(2);
    expect(lastIdle(f.log).stop_reason).toEqual({ type: "end_turn" });
  });

  it("takes answers that arrived while the batch was applied before handing control back", async () => {
    const h = gatedToolHarness(["toolu_1", "toolu_2"]);
    const execute = vi.fn(async () => "hi\n");
    const f = createMachine(h.run, { runtime: () => ({ pendingConfirmations: [] }), tools: gatedTools(execute) });
    await f.machine.runTurn("agent_test", userMessage);

    const take = queue([], [confirm("toolu_2")]);
    await f.machine.runTurn("agent_test", confirm("toolu_1"), { takeQueuedClientResults: take });

    expect(take).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(h.calls()).toBe(2);
    expect(idles(f.log)).toHaveLength(2);
    expect(lastIdle(f.log).stop_reason).toEqual({ type: "end_turn" });
  });

  it("a repeat answer neither builds tools nor toggles the session status", async () => {
    const h = gatedToolHarness(["toolu_1"]);
    const execute = vi.fn(async () => "hi\n");
    const f = createMachine(h.run, { runtime: () => ({ pendingConfirmations: [] }), tools: gatedTools(execute) });
    await f.machine.runTurn("agent_test", userMessage);
    await f.machine.runTurn("agent_test", confirm("toolu_1"));
    const built = f.buildTools.mock.calls.length;
    const before = f.log.getEvents().length;
    vi.mocked(f.adapter.beginTurn).mockClear();

    const again = await f.machine.runTurn("agent_test", confirm("toolu_1"));

    expect(again).toMatchObject({ status: "completed", stopReason: { type: "end_turn" } });
    expect(f.buildTools.mock.calls.length).toBe(built);
    expect(f.adapter.beginTurn).not.toHaveBeenCalled();
    const added = (f.log.getEvents() as Array<Record<string, unknown>>).slice(before);
    // Recorded (processed, with why it was ignored) — nothing else.
    expect(added).toEqual([
      expect.objectContaining({
        type: "user.tool_confirmation",
        tool_use_id: "toolu_1",
        processed_at: expect.any(String),
        metadata: { _oma_ignored: "already resolved" },
      }),
    ]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(h.calls()).toBe(2);
  });

  it("a repeat ahead of a step's answers is recorded and the step is answered in one turn", async () => {
    // The eval pattern: a repeat for the previous step sits at the head of
    // the queue, the new step's answers right behind it.
    let calls = 0;
    const execute = vi.fn(async () => "hi\n");
    const f = createMachine(
      async (ctx) => {
        calls++;
        const ids = calls === 1 ? ["toolu_a"] : calls === 2 ? ["toolu_b1", "toolu_b2"] : [];
        if (ids.length === 0) {
          ctx.eventLog.append({ type: "agent.message", content: [{ type: "text", text: "done" }] } as SessionEvent);
          return;
        }
        for (const id of ids) {
          ctx.eventLog.append({
            type: "agent.tool_use",
            id,
            name: "bash",
            input: { command: "echo hi" },
            evaluated_permission: "ask",
          } as unknown as SessionEvent);
        }
        ctx.runtime?.pendingConfirmations?.push(...ids);
      },
      { runtime: () => ({ pendingConfirmations: [] }), tools: gatedTools(execute) },
    );
    await f.machine.runTurn("agent_test", userMessage);
    await f.machine.runTurn("agent_test", confirm("toolu_a"));
    expect(lastIdle(f.log).stop_reason).toMatchObject({ event_ids: ["toolu_b1", "toolu_b2"] });

    const take = queue([confirm("toolu_b1"), confirm("toolu_b1"), confirm("toolu_b2")]);
    await f.machine.runTurn("agent_test", confirm("toolu_a"), { takeQueuedClientResults: take });

    expect(calls).toBe(3);
    expect(execute).toHaveBeenCalledTimes(3); // a, b1, b2 — once each
    const confirmations = (f.log.getEvents() as Array<Record<string, unknown>>).filter(
      (e) => e.type === "user.tool_confirmation",
    );
    expect(confirmations.map((e) => [e.tool_use_id, (e.metadata as { _oma_ignored?: string } | undefined)?._oma_ignored])).toEqual([
      ["toolu_a", undefined],
      ["toolu_a", "already resolved"],
      ["toolu_b1", undefined],
      ["toolu_b1", "answered earlier in this turn"],
      ["toolu_b2", undefined],
    ]);
    expect(idles(f.log)).toHaveLength(3);
    expect(lastIdle(f.log).stop_reason).toEqual({ type: "end_turn" });
  });

  it("a retried item whose answer was recorded as ignored is acknowledged without a turn", async () => {
    const h = gatedToolHarness(["toolu_1"]);
    const f = createMachine(h.run, { runtime: () => ({ pendingConfirmations: [] }) });
    Object.assign(f.log, {
      findEventByIdAsync: async (id: string) =>
        (f.log.getEvents() as SessionEvent[]).find((e) => (e as { id?: string }).id === id) ?? null,
    });
    await f.machine.runTurn("agent_test", userMessage);
    await f.machine.runTurn("agent_test", confirm("toolu_1", { result: "deny" }));
    const repeat = confirm("toolu_1");
    await f.machine.runTurn("agent_test", repeat);
    const before = f.log.getEvents().length;

    // The worker died after recording it, before the queue acknowledged.
    const retried = await f.machine.runTurn("agent_test", repeat);

    expect(retried).toMatchObject({ status: "completed", alreadyCompleted: true });
    expect(f.log.getEvents().length).toBe(before);
    expect(h.calls()).toBe(2);
  });

  it.each(["ignored", "_oma_ignored"])(
    "a client's own metadata.%s doesn't make a retried answer count as ignored",
    async (key) => {
      // Only the machine marks an answer ignored. A real confirmation whose
      // worker lost its lease mid-resume must resume on the retry.
      let calls = 0;
      const execute = vi.fn(async () => "hi\n");
      const f = createMachine(
        async (ctx) => {
          calls++;
          if (calls === 1) {
            ctx.eventLog.append({
              type: "agent.tool_use",
              id: "toolu_1",
              name: "bash",
              input: { command: "echo hi" },
              evaluated_permission: "ask",
            } as unknown as SessionEvent);
            ctx.runtime?.pendingConfirmations?.push("toolu_1");
            return;
          }
          if (calls === 2) throw new TurnLeaseLostError("lease lost mid-resume");
          ctx.eventLog.append({ type: "agent.message", content: [{ type: "text", text: "done" }] } as SessionEvent);
        },
        { runtime: () => ({ pendingConfirmations: [] }), tools: gatedTools(execute) },
      );
      Object.assign(f.log, {
        findEventByIdAsync: async (id: string) =>
          (f.log.getEvents() as SessionEvent[]).find((e) => (e as { id?: string }).id === id) ?? null,
      });
      await f.machine.runTurn("agent_test", userMessage);
      const answer = confirm("toolu_1", { metadata: { [key]: "client data" } });
      await expect(f.machine.runTurn("agent_test", answer)).rejects.toThrow(/lease lost/);

      const retried = await f.machine.runTurn("agent_test", answer);

      expect(retried).toMatchObject({ status: "completed", stopReason: { type: "end_turn" } });
      expect(retried.alreadyCompleted).toBeUndefined();
      expect(calls).toBe(3);
      expect(execute).toHaveBeenCalledTimes(1);
      const stored = (f.log.getEvents() as Array<Record<string, unknown>>).find(
        (e) => e.id === (answer as { id: string }).id,
      );
      // The client's own key is kept; the machine's marker never comes from a client.
      expect((stored?.metadata as Record<string, unknown> | undefined)?.[key]).toBe(
        key === "ignored" ? "client data" : undefined,
      );
    },
  );

  it("an ignored custom tool result doesn't resolve its call: the next user.message still closes it", async () => {
    // An ask-gated call whose turn failed was never handed to the client,
    // so a custom result for it is ignored — and must not count as its
    // result, or the model history keeps a tool_use with none.
    let calls = 0;
    const f = createMachine(async (ctx) => {
      calls++;
      if (calls === 1) {
        ctx.eventLog.append({
          type: "agent.tool_use",
          id: "toolu_x",
          name: "bash",
          input: {},
          evaluated_permission: "ask",
        } as unknown as SessionEvent);
        throw new Error("provider 500");
      }
      ctx.eventLog.append({ type: "agent.message", content: [{ type: "text", text: "ok" }] } as SessionEvent);
    });
    await expect(f.machine.runTurn("agent_test", userMessage)).rejects.toThrow(/provider 500/);
    await f.machine.runTurn("agent_test", {
      type: "user.custom_tool_result",
      id: "sevt-ctr",
      custom_tool_use_id: "toolu_x",
      content: [{ type: "text", text: "client output" }],
    } as never);
    const events = () => f.log.getEvents() as Array<Record<string, unknown>>;
    expect(findUnresolvedToolUses(events() as unknown as SessionEvent[]).map((u) => u.id)).toEqual(["toolu_x"]);
    expect(findOrphanToolUses(events() as unknown as SessionEvent[]).map((o) => o.tool_use_id)).toEqual(["toolu_x"]);
    expect(events().find((e) => e.id === "sevt-ctr")?.metadata).toEqual({
      _oma_ignored: "the call is not waiting on the client",
    });

    await f.machine.runTurn("agent_test", { ...userMessage, id: "sevt-next" } as UserMessageEvent);

    const results = events().filter((e) => e.type === "agent.tool_result" && e.tool_use_id === "toolu_x");
    expect(results).toHaveLength(1);
    expect(JSON.stringify(results[0].content)).toMatch(/not executed/);
    expect(calls).toBe(2);
  });

  it("an answer withdrawn from the queue after it was handed out is neither recorded nor applied", async () => {
    // A user.interrupt on another replica cancels the queued rows; this
    // turn learns of it only on its next heartbeat.
    const h = gatedToolHarness(["toolu_1", "toolu_2"]);
    const execute = vi.fn(async () => "hi\n");
    const f = createMachine(h.run, { runtime: () => ({ pendingConfirmations: [] }), tools: gatedTools(execute) });
    await f.machine.runTurn("agent_test", userMessage);
    const withdrawn = confirm("toolu_2");
    const claim = vi.fn(async () => false);
    const take = vi.fn(async () => (take.mock.calls.length === 1 ? [{ event: withdrawn, claim }] : []) as never);

    await f.machine.runTurn("agent_test", confirm("toolu_1"), { takeQueuedClientResults: take });

    expect(claim).toHaveBeenCalledTimes(1);
    const events = f.log.getEvents() as Array<Record<string, unknown>>;
    expect(events.some((e) => e.id === (withdrawn as { id: string }).id)).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(h.calls()).toBe(1);
    expect(lastIdle(f.log).stop_reason).toMatchObject({ type: "requires_action", event_ids: ["toolu_2"] });
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
