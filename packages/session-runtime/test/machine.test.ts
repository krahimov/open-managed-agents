import { describe, expect, it, vi } from "vitest";
import {
  InMemoryEventLog,
  InMemoryStreamRepo,
} from "@open-managed-agents/event-log/memory";
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
} from "@open-managed-agents/session-runtime";
import type { RuntimeAdapter } from "@open-managed-agents/session-runtime";

function createMachine(harnessRun: () => Promise<void>): {
  machine: SessionStateMachine;
  log: InMemoryEventLog;
  published: SessionEvent[];
  adapter: RuntimeAdapter;
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
      }) as unknown as AgentConfig,
    buildTools: async () => ({}),
    buildModel: async () => ({}) as LanguageModel,
    buildHarness: () => ({ run: harnessRun }),
    buildHarnessContext: async () => ({}),
    publish: (event) => published.push(event),
  });
  return { machine, log, published, adapter };
}

const userMessage = {
  type: "user.message",
  content: [{ type: "text", text: "hello" }],
  session_thread_id: "sthr_primary",
} as unknown as UserMessageEvent;

describe("SessionStateMachine lifecycle events", () => {
  it("emits running and idle events around a successful turn", async () => {
    const f = createMachine(async () => {});

    await f.machine.runHarnessTurn("agent_test", userMessage);

    const events = f.log.getEvents() as SessionEvent[];
    expect(events.map((event) => event.type)).toEqual([
      "session.status_running",
      "session.status_idle",
    ]);
    expect((events[1] as { stop_reason?: { type: string } }).stop_reason).toEqual({
      type: "end_turn",
    });
    expect(events.every((event) => (event as { id?: string }).id)).toBe(true);
    expect(f.published.map((event) => event.type)).toEqual(
      events.map((event) => event.type),
    );
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
    expect(events.map((event) => event.type)).toEqual([
      "session.status_running",
      "session.error",
      "session.status_idle",
    ]);
    expect((events[1] as { message?: string }).message).toBe("boom");
    expect((events[2] as { stop_reason?: unknown }).stop_reason).toBeUndefined();
    expect(sessionErrorAlreadyEmitted(err)).toBe(true);
    expect(f.published.map((event) => event.type)).toEqual(
      events.map((event) => event.type),
    );
  });
});
