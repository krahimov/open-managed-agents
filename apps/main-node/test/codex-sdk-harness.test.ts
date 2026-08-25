// CodexSdkHarness — event translation and fail-closed guards, exercised
// through the createCodex test seam (no codex binary spawned).

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CodexSdkHarness,
  codexModelFor,
  curatedCodexEnv,
  type CodexLike,
} from "../src/lib/codex-sdk-harness.js";
import type { ThreadEvent } from "@openai/codex-sdk";

function fakeCodex(events: ThreadEvent[], calls: { started: unknown[]; resumed: Array<{ id: string; options: unknown }> }): CodexLike {
  const thread = {
    async runStreamed() {
      async function* gen() {
        for (const e of events) yield e;
      }
      return { events: gen() };
    },
  };
  return {
    startThread(options) {
      calls.started.push(options);
      return thread;
    },
    resumeThread(id, options) {
      calls.resumed.push({ id, options });
      return thread;
    },
  };
}

function makeCtx(overrides: Record<string, unknown> = {}) {
  const broadcasts: Array<Record<string, unknown>> = [];
  const ctx = {
    agent: { id: "agent-1", model: "gpt-5.2", ...((overrides.agent as object) ?? {}) },
    session_id: (overrides.session_id as string) ?? `sess-${Math.random().toString(36).slice(2)}`,
    tenant_id: "default",
    systemPrompt: "You are a test agent.",
    userMessage: { content: [{ type: "text", text: "hello" }] },
    runtime: {
      broadcast: (e: Record<string, unknown>) => broadcasts.push(e),
      abortSignal: undefined,
    },
  };
  return { ctx: ctx as never, broadcasts };
}

beforeEach(() => {
  process.env.SANDBOX_WORKDIR = mkdtempSync(path.join(tmpdir(), "codex-harness-test-"));
});

describe("codexModelFor", () => {
  it("passes bare OpenAI ids through and drops everything else", () => {
    expect(codexModelFor("gpt-5.2")).toBe("gpt-5.2");
    expect(codexModelFor("o4-mini")).toBe("o4-mini");
    expect(codexModelFor("codex-large")).toBe("codex-large");
    expect(codexModelFor("claude-opus-5")).toBeUndefined();
    expect(codexModelFor("my-model-card")).toBeUndefined();
    expect(codexModelFor(undefined)).toBeUndefined();
  });
});

describe("curatedCodexEnv", () => {
  it("strips every API-credit billing path but keeps the rest", () => {
    const env = curatedCodexEnv({
      HOME: "/home/u",
      OPENAI_API_KEY: "sk-x",
      CODEX_API_KEY: "sk-y",
      OPENAI_BASE_URL: "https://proxy",
      PATH: "/bin",
    });
    expect(env.HOME).toBe("/home/u");
    expect(env.PATH).toBe("/bin");
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
    expect(env).not.toHaveProperty("CODEX_API_KEY");
    expect(env).not.toHaveProperty("OPENAI_BASE_URL");
  });
});

describe("CodexSdkHarness.run", () => {
  it("translates the codex event stream into OMA session events", async () => {
    const events: ThreadEvent[] = [
      { type: "thread.started", thread_id: "thr-1" },
      { type: "turn.started" },
      {
        type: "item.started",
        item: { id: "item_0", type: "command_execution", command: "ls", aggregated_output: "", status: "in_progress" },
      },
      {
        type: "item.completed",
        item: { id: "item_0", type: "command_execution", command: "ls", aggregated_output: "a.txt", exit_code: 0, status: "completed" },
      },
      { type: "item.completed", item: { id: "item_1", type: "reasoning", text: "thinking it over" } },
      { type: "item.completed", item: { id: "item_2", type: "agent_message", text: "done!" } },
      {
        type: "turn.completed",
        usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
      },
    ];
    const calls = { started: [] as unknown[], resumed: [] as Array<{ id: string; options: unknown }> };
    const harness = new CodexSdkHarness({ createCodex: () => fakeCodex(events, calls) });
    const { ctx, broadcasts } = makeCtx();

    await harness.run(ctx);

    const types = broadcasts.map((b) => b.type);
    expect(types).toEqual(["agent.tool_use", "agent.tool_result", "agent.thinking", "agent.message"]);

    const toolUse = broadcasts[0];
    const toolResult = broadcasts[1];
    expect(toolUse.name).toBe("shell");
    expect(toolUse.input).toEqual({ command: "ls" });
    // tool_use / tool_result pair through the same minted OMA id (codex item
    // ids restart every turn, so they must not be used directly).
    expect(toolResult.tool_use_id).toBe(toolUse.id);
    expect(toolUse.id).not.toBe("item_0");
    expect(toolResult.content).toBe("a.txt");

    expect(broadcasts[2].text).toBe("thinking it over");
    expect(broadcasts[3].content).toEqual([{ type: "text", text: "done!" }]);

    // First turn starts a fresh thread with the passed-through model.
    expect(calls.resumed).toHaveLength(0);
    expect(calls.started).toHaveLength(1);
    expect((calls.started[0] as { model?: string }).model).toBe("gpt-5.2");
    expect((calls.started[0] as { approvalPolicy?: string }).approvalPolicy).toBe("never");
  });

  it("resumes the same codex thread on the next turn of the session", async () => {
    const events: ThreadEvent[] = [
      { type: "thread.started", thread_id: "thr-keep" },
      { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "hi" } },
    ];
    const calls = { started: [] as unknown[], resumed: [] as Array<{ id: string; options: unknown }> };
    const harness = new CodexSdkHarness({ createCodex: () => fakeCodex(events, calls) });
    const { ctx } = makeCtx({ session_id: "sess-resume" });

    await harness.run(ctx);
    await harness.run(ctx);

    expect(calls.started).toHaveLength(1);
    expect(calls.resumed).toHaveLength(1);
    expect(calls.resumed[0].id).toBe("thr-keep");
  });

  it("fails the turn and broadcasts session.error on turn.failed", async () => {
    const events: ThreadEvent[] = [
      { type: "thread.started", thread_id: "thr-2" },
      { type: "turn.failed", error: { message: "usage limit reached" } },
    ];
    const calls = { started: [] as unknown[], resumed: [] };
    const harness = new CodexSdkHarness({ createCodex: () => fakeCodex(events, calls) });
    const { ctx, broadcasts } = makeCtx();

    await expect(harness.run(ctx)).rejects.toThrow(/usage limit reached/);
    expect(broadcasts.some((b) => b.type === "session.error")).toBe(true);
  });

  it("rejects sessions with a pinned access policy (fail-closed)", async () => {
    const calls = { started: [] as unknown[], resumed: [] };
    const harness = new CodexSdkHarness({ createCodex: () => fakeCodex([], calls) });
    const { ctx, broadcasts } = makeCtx({
      agent: { id: "agent-1", model: "gpt-5.2", effective_policy: { rules: [{ selector: "*", effect: "deny" }] } },
    });

    await expect(harness.run(ctx)).rejects.toThrow(/access policy/);
    expect(broadcasts.some((b) => b.type === "session.error")).toBe(true);
    expect(calls.started).toHaveLength(0); // never reached the codex child
  });

  it("maps reasoning_level onto codex modelReasoningEffort", async () => {
    const events: ThreadEvent[] = [
      { type: "thread.started", thread_id: "thr-r" },
      { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "ok" } },
    ];
    const calls = { started: [] as unknown[], resumed: [] as Array<{ id: string; options: unknown }> };
    const harness = new CodexSdkHarness({ createCodex: () => fakeCodex(events, calls) });
    const { ctx } = makeCtx({ agent: { id: "agent-1", model: "gpt-5.2", reasoning_level: "max" } });

    await harness.run(ctx);
    expect((calls.started[0] as { modelReasoningEffort?: string }).modelReasoningEffort).toBe("xhigh");
  });

  it("runs setup sessions over the MCP bridge (read-only sandbox, oma_platform server)", async () => {
    const events: ThreadEvent[] = [
      { type: "thread.started", thread_id: "thr-setup" },
      { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "let's configure you" } },
    ];
    const calls = { started: [] as unknown[], resumed: [] as Array<{ id: string; options: unknown }> };
    const codexOptionsSeen: Array<Record<string, unknown>> = [];
    const harness = new CodexSdkHarness({
      createCodex: (options) => {
        codexOptionsSeen.push(options as Record<string, unknown>);
        return fakeCodex(events, calls);
      },
      readSessionMetadata: async () => ({ oma_setup: true }),
      updateAgent: async () => ({ id: "agent-1", name: "updated" }) as never,
    });
    const { ctx, broadcasts } = makeCtx();

    await harness.run(ctx);

    expect(broadcasts.some((b) => b.type === "session.error")).toBe(false);
    expect((calls.started[0] as { sandboxMode?: string }).sandboxMode).toBe("read-only");
    const config = codexOptionsSeen[0]?.config as
      | { mcp_servers?: Record<string, { url: string; http_headers: Record<string, string> }> }
      | undefined;
    const bridgeEntry = config?.mcp_servers?.oma_platform;
    expect(bridgeEntry?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(bridgeEntry?.http_headers.Authorization).toMatch(/^Bearer /);
  });
});
