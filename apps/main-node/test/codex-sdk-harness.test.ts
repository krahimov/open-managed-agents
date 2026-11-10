// CodexSdkHarness — event translation and fail-closed guards, exercised
// through the createCodex test seam (no codex binary spawned).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
    tools: overrides.tools ?? {},
    systemPrompt: "You are a test agent.",
    userMessage: { content: [{ type: "text", text: "hello" }] },
    runtime: {
      broadcast: (e: Record<string, unknown>) => broadcasts.push(e),
      abortSignal: undefined,
      ...((overrides.runtime as object) ?? {}),
    },
  };
  return { ctx: ctx as never, broadcasts };
}

beforeEach(() => {
  process.env.SANDBOX_WORKDIR = mkdtempSync(path.join(tmpdir(), "codex-harness-test-"));
});

afterEach(() => vi.unstubAllEnvs());

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
  it.each(["", "default/agent-other", "other-tenant/agent-1"])("rejects agents outside the operator allowlist %j before starting Codex", async allowed => {
    vi.stubEnv("OMA_CODEX_ALLOWED_AGENTS", allowed);
    const createCodex = vi.fn();
    const h = new CodexSdkHarness({ createCodex });
    const { ctx } = makeCtx({ runtime: { sandbox: { sandboxCapabilities: () => ({ scope: "agent" }) } } });
    await expect(h.run(ctx)).rejects.toThrow("restricted to operator-approved agents");
    expect(createCodex).not.toHaveBeenCalled();
  });

  it("requires an isolated computer even for an allowlisted agent", async () => {
    vi.stubEnv("OMA_CODEX_ALLOWED_AGENTS", "default/agent-1");
    const createCodex = vi.fn();
    const h = new CodexSdkHarness({ createCodex });
    await expect(h.run(makeCtx().ctx)).rejects.toThrow("restricted to operator-approved agents");
    expect(createCodex).not.toHaveBeenCalled();
  });

  it("isolates agent computers from native host tools and forces subscription auth", async () => {
    vi.stubEnv("OMA_CODEX_ALLOWED_AGENTS", "default/agent-other, default/agent-1 ");
    const calls = { started: [] as unknown[], resumed: [] as Array<{ id: string; options: unknown }> };
    let options: any;
    const h = new CodexSdkHarness({ createCodex: o => { options = o; return fakeCodex([], calls); } });
    const { ctx } = makeCtx({ runtime: { sandbox: { sandboxCapabilities: () => ({ scope: "agent" }) } } });
    await h.run(ctx);
    expect(options.config.features.shell_tool).toBe(false);
    expect(options.config.features.view_image).toBe(false);
    expect(options.config.features.plugins).toBe(false);
    expect(options.config.forced_login_method).toBe("chatgpt");
    expect(options.env).not.toHaveProperty("OPENAI_API_KEY");
    expect(options.env).not.toHaveProperty("SANDBOX_WORKDIR");
    expect((calls.started[0] as any).sandboxMode).toBe("read-only");
    expect((calls.started[0] as any).webSearchMode).toBe("disabled");
  });

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

  it("rejects sessions whose MCP servers ask for approval (fail-closed: no per-call hook)", async () => {
    const calls = { started: [] as unknown[], resumed: [] };
    const harness = new CodexSdkHarness({ createCodex: () => fakeCodex([], calls) });
    const { ctx, broadcasts } = makeCtx({
      agent: {
        id: "agent-1",
        model: "gpt-5.2",
        mcp_servers: [{ name: "linear", type: "url", url: "https://mcp.linear.app/mcp" }],
        tools: [{ type: "mcp_toolset", mcp_server_name: "linear", default_config: { enabled: true, permission_policy: { type: "always_ask" } } }],
      },
    });

    await expect(harness.run(ctx)).rejects.toThrow(/linear.*always_ask/);
    expect(broadcasts.some((b) => b.type === "session.error")).toBe(true);
    expect(calls.started).toHaveLength(0);
  });

  it("keeps running agents whose always_ask doesn't touch a tool it exposes", async () => {
    const events: ThreadEvent[] = [
      { type: "thread.started", thread_id: "thr-ok" },
      { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "ok" } },
    ];
    const calls = { started: [] as unknown[], resumed: [] as Array<{ id: string; options: unknown }> };
    const harness = new CodexSdkHarness({ createCodex: () => fakeCodex(events, calls) });
    const { ctx, broadcasts } = makeCtx({
      agent: {
        id: "agent-1",
        model: "gpt-5.2",
        // Built-in-only ask (codex's own tools aren't OMA built-ins), and an
        // ask on a server this agent doesn't declare.
        tools: [
          { type: "agent_toolset_20260401", default_config: { enabled: true, permission_policy: { type: "always_allow" } }, configs: [{ name: "bash", enabled: true, permission_policy: { type: "always_ask" } }] },
          { type: "mcp_toolset", mcp_server_name: "linear", default_config: { enabled: true, permission_policy: { type: "always_ask" } } },
        ],
      },
    });

    await harness.run(ctx);
    expect(broadcasts.some((b) => b.type === "session.error")).toBe(false);
    expect(calls.started).toHaveLength(1);
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
    vi.stubEnv("OMA_CODEX_HOME", path.join(process.env.SANDBOX_WORKDIR!, "setup-auth"));
    vi.stubEnv("OMA_CODEX_AUTH_JSON", "");
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
    expect(codexOptionsSeen[0]?.env).toHaveProperty("CODEX_HOME");
    expect(codexOptionsSeen[0]?.config).toMatchObject({ forced_login_method: "chatgpt", features: { shell_tool: false, view_image: false } });
    expect((calls.started[0] as any).webSearchMode).toBe("disabled");
    const bridgeEntry = config?.mcp_servers?.oma_platform;
    expect(bridgeEntry?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(bridgeEntry?.http_headers.Authorization).toMatch(/^Bearer /);
  });

  // The setup agent must be able to switch memory on from every harness
  // (prod 2026-11-10: nothing in the setup toolset could). The fake codex
  // child calls the bridge the way the real one does — JSON-RPC over HTTP.
  it("setup sessions expose enable_memory over the bridge; working sessions do not", async () => {
    vi.stubEnv("OMA_CODEX_HOME", path.join(process.env.SANDBOX_WORKDIR!, "setup-auth"));
    vi.stubEnv("OMA_CODEX_AUTH_JSON", "");
    const enabledFor: Array<{ tenantId: string; sessionId: string; agentId: string }> = [];
    const seen: { tools: string[]; result: string } = { tools: [], result: "" };
    let bridge: { url: string; http_headers: Record<string, string> } | undefined;
    const rpc = async (method: string, params: Record<string, unknown>) => {
      const res = await fetch(bridge!.url, {
        method: "POST",
        headers: {
          ...bridge!.http_headers,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const text = await res.text();
      const raw = text.startsWith("event:") || text.startsWith("data:")
        ? text.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim() ?? ""
        : text;
      return (JSON.parse(raw) as { result: Record<string, unknown> }).result;
    };
    const makeHarness = (isSetup: boolean) =>
      new CodexSdkHarness({
        createCodex: (options) => {
          bridge = (options as { config?: { mcp_servers?: Record<string, typeof bridge> } }).config
            ?.mcp_servers?.oma_platform;
          return {
            startThread: () => ({
              async runStreamed() {
                const listed = await rpc("tools/list", {});
                seen.tools = (listed.tools as Array<{ name: string }>).map((t) => t.name);
                if (seen.tools.includes("enable_memory")) {
                  const called = await rpc("tools/call", { name: "enable_memory", arguments: {} });
                  seen.result = (called.content as Array<{ text: string }>)[0].text;
                }
                async function* gen(): AsyncGenerator<ThreadEvent> {
                  yield { type: "thread.started", thread_id: "thr-mem" };
                }
                return { events: gen() };
              },
            }),
            resumeThread: () => {
              throw new Error("unexpected resume");
            },
          };
        },
        readSessionMetadata: async () => (isSetup ? { oma_setup: true } : {}),
        updateAgent: async () => ({ id: "agent-1", name: "updated" }) as never,
        requestServiceAccess: async () => ({ request_id: "r", status: "pending" }),
        enableMemory: async (tenantId, sessionId, agentId) => {
          enabledFor.push({ tenantId, sessionId, agentId });
          return {
            enabled: true,
            mode: "shared",
            explicit_off: false,
            newly_enabled: true,
            store: { id: "memstore-1", name: "agent-1-memory" },
          };
        },
      });

    const setup = makeCtx({ session_id: "sess-setup-memory" });
    await makeHarness(true).run(setup.ctx);
    expect(seen.tools).toContain("update_harness");
    expect(seen.tools).toContain("enable_memory");
    expect(enabledFor).toEqual([{ tenantId: "default", sessionId: "sess-setup-memory", agentId: "agent-1" }]);
    expect(seen.result).toContain("Memory is now ON for this agent.");
    expect(seen.result).toContain('Store "agent-1-memory" is attached read-write');

    seen.tools = [];
    await makeHarness(false).run(makeCtx({ session_id: "sess-working" }).ctx);
    expect(seen.tools).toContain("request_access");
    expect(seen.tools).not.toContain("enable_memory");
    expect(enabledFor).toHaveLength(1);
  });
});
