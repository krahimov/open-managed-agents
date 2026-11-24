// ClaudeAgentSdkHarness sandbox mode: Claude Code as the model loop only,
// every tool on the session's cloud sandbox. Exercised through the `query`
// test seam (no Claude Code spawned); the bridge and its tools are real.
//
// Why it exists: host mode hands Claude Code Bash on the API server with the
// server's whole environment. A hosted deployment that turns the engine on
// (OMA_CLAUDE_ALLOWED_AGENTS) must give no agent that.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { jsonSchema } from "ai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  ClaudeAgentSdkHarness,
  claudeSdkAllowed,
  claudeSdkToolsOn,
  isolatedClaudeEnv,
} from "../src/lib/claude-agent-sdk-harness.js";

type Options = Record<string, any>;
type FakeMessage = Record<string, unknown>;

const daytona = { sandboxCapabilities: () => ({ scope: "session" }) };
const computer = { sandboxCapabilities: () => ({ scope: "agent" }) };

/** A `query` that records its options and plays `script` (which may use the
 *  options, e.g. to call the bridge the way Claude Code would). */
function fakeQuery(script: (options: Options) => AsyncGenerator<FakeMessage> | FakeMessage[]) {
  const seen: { options?: Options; prompt?: unknown; calls: number } = { calls: 0 };
  const query = ((input: { prompt: unknown; options: Options }) => {
    seen.calls++;
    seen.options = input.options;
    seen.prompt = input.prompt;
    const out = script(input.options);
    return Array.isArray(out)
      ? (async function* () { for (const m of out) yield m; })()
      : out;
  }) as never;
  return { query, seen };
}

const success = { type: "result", subtype: "success" };
/** Claude Code's first message: the tools it offers the model. */
const init = (tools: unknown, sessionId = "sdk-1") => ({ type: "system", subtype: "init", session_id: sessionId, tools });

function makeCtx(overrides: { agent?: object; tools?: object; sandbox?: object | null; tenant?: string } = {}) {
  const broadcasts: Array<Record<string, any>> = [];
  const ctx = {
    agent: { id: "agent-1", model: "claude-opus-5-5", ...(overrides.agent ?? {}) },
    session_id: `sess-${Math.random().toString(36).slice(2)}`,
    tenant_id: overrides.tenant ?? "tnt-1",
    tools: overrides.tools ?? {},
    systemPrompt: "You process loans.",
    userMessage: { content: [{ type: "text", text: "hello" }] },
    runtime: {
      broadcast: (e: Record<string, any>) => broadcasts.push(e),
      broadcastStreamStart: async () => {},
      broadcastChunk: async () => {},
      broadcastStreamEnd: async () => {},
      abortSignal: undefined,
      sandbox: overrides.sandbox === undefined ? daytona : overrides.sandbox,
    },
  };
  return { ctx: ctx as never, broadcasts };
}

/** Call the bridge the way Claude Code does: list, then call one tool. */
async function overBridge<T>(options: Options, fn: (client: Client) => Promise<T>): Promise<T> {
  const server = options.mcpServers.oma;
  const client = new Client({ name: "fake-claude-code", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } }));
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

beforeEach(() => {
  process.env.SANDBOX_WORKDIR = mkdtempSync(path.join(tmpdir(), "claude-harness-test-"));
});
afterEach(() => vi.unstubAllEnvs());

describe("claudeSdkToolsOn", () => {
  it("host tools only where there is no remote sandbox, or nobody restricted the engine", () => {
    expect(claudeSdkToolsOn(null, {})).toBe("host");
    expect(claudeSdkToolsOn({}, { OMA_CLAUDE_ALLOWED_AGENTS: "tnt-1/*" })).toBe("host");
    // Single operator on Daytona: unchanged.
    expect(claudeSdkToolsOn(daytona, {})).toBe("host");
  });

  it("the sandbox for an agent computer, and for any remote sandbox once the engine is restricted", () => {
    expect(claudeSdkToolsOn(computer, {})).toBe("sandbox");
    expect(claudeSdkToolsOn(daytona, { OMA_CLAUDE_ALLOWED_AGENTS: "tnt-1/*" })).toBe("sandbox");
    expect(claudeSdkToolsOn(daytona, { OMA_CLAUDE_ALLOWED_AGENTS: "" })).toBe("sandbox");
  });
});

describe("claudeSdkAllowed", () => {
  it("unset allows everyone; empty allows nobody", () => {
    expect(claudeSdkAllowed({}, "tnt-1", "agent-1")).toBe(true);
    expect(claudeSdkAllowed({ OMA_CLAUDE_ALLOWED_AGENTS: "" }, "tnt-1", "agent-1")).toBe(false);
  });

  it("matches tenant/agent pairs and tenant/* exactly", () => {
    const env = { OMA_CLAUDE_ALLOWED_AGENTS: " tnt-1/agent-1 , tnt-2/* " };
    expect(claudeSdkAllowed(env, "tnt-1", "agent-1")).toBe(true);
    expect(claudeSdkAllowed(env, "tnt-1", "agent-2")).toBe(false);
    expect(claudeSdkAllowed(env, "tnt-2", "anything")).toBe(true);
    expect(claudeSdkAllowed(env, "tnt-3", "agent-1")).toBe(false);
    // No prefix games: tnt-2 does not approve tnt-22, and "*" is not an agent id.
    expect(claudeSdkAllowed(env, "tnt-22", "x")).toBe(false);
    expect(claudeSdkAllowed(env, "tnt", "agent-1")).toBe(false);
    expect(claudeSdkAllowed(env, undefined, "agent-1")).toBe(false);
    expect(claudeSdkAllowed(env, "tnt-1", "")).toBe(false);
  });

  it("without an agent id, says whether the workspace has any entry", () => {
    const env = { OMA_CLAUDE_ALLOWED_AGENTS: "tnt-1/agent-1,tnt-2/*" };
    expect(claudeSdkAllowed(env, "tnt-1")).toBe(true);
    expect(claudeSdkAllowed(env, "tnt-2")).toBe(true);
    expect(claudeSdkAllowed(env, "tnt-3")).toBe(false);
    expect(claudeSdkAllowed(env, "tnt")).toBe(false);
  });
});

describe("isolatedClaudeEnv", () => {
  it("keeps what Claude Code needs to start and sign in, and none of the server's secrets", () => {
    const env = isolatedClaudeEnv({
      PATH: "/bin",
      HOME: "/home/node",
      CLAUDE_CODE_OAUTH_TOKEN: "sub-token",
      DATABASE_URL: "postgres://secret",
      PLATFORM_ROOT_SECRET: "secret",
      BETTER_AUTH_SECRET: "secret",
      DAYTONA_API_KEY: "secret",
      COMPOSIO_API_KEY: "secret",
      OMA_CODEX_AUTH_JSON: "secret",
      ANTHROPIC_API_KEY: "sk-ant",
      ANTHROPIC_BASE_URL: "https://proxy",
      SANDBOX_WORKDIR: "/data",
    });
    expect(env).toEqual({ PATH: "/bin", HOME: "/home/node", CLAUDE_CODE_OAUTH_TOKEN: "sub-token" });
  });
});

describe("ClaudeAgentSdkHarness — operator restriction", () => {
  it.each(["", "tnt-1/agent-other", "other-tenant/agent-1", "other-tenant/*"])(
    "rejects an agent outside the allowlist %j before Claude Code starts",
    async (allowed) => {
      vi.stubEnv("OMA_CLAUDE_ALLOWED_AGENTS", allowed);
      const { query, seen } = fakeQuery(() => [success]);
      const { ctx, broadcasts } = makeCtx();
      await expect(new ClaudeAgentSdkHarness({ query }).run(ctx)).rejects.toThrow("restricted to operator-approved agents");
      expect(seen.calls).toBe(0);
      expect(broadcasts.some((b) => b.type === "session.error")).toBe(true);
    },
  );

  it("an approved agent without a cloud sandbox is refused: it would get host tools", async () => {
    vi.stubEnv("OMA_CLAUDE_ALLOWED_AGENTS", "tnt-1/*");
    const { query, seen } = fakeQuery(() => [success]);
    const { ctx } = makeCtx({ sandbox: null });
    await expect(new ClaudeAgentSdkHarness({ query }).run(ctx)).rejects.toThrow("needs a cloud sandbox");
    expect(seen.calls).toBe(0);
  });

  describe("an approved agent's setup session", () => {
    const setupHarness = (query: never, extra: object = {}) =>
      new ClaudeAgentSdkHarness({
        query,
        readSessionMetadata: async () => ({ oma_setup: true }),
        updateAgent: async () => ({}) as never,
        requestServiceAccess: vi.fn(),
        ...extra,
      });
    const setupAgent = {
      mcp_servers: [{ name: "linear", type: "url", url: "https://mcp.linear.app/mcp" }],
      skills: [{ type: "custom", skill_id: "s1" }],
    };

    it("needs no sandbox, and gets nothing of this host: no built-in, no tenant skill, no upstream MCP server", async () => {
      vi.stubEnv("OMA_CLAUDE_ALLOWED_AGENTS", "tnt-1/agent-1");
      vi.stubEnv("DATABASE_URL", "postgres://secret");
      const { query, seen } = fakeQuery(() => [init(["mcp__oma_setup__update_harness", "mcp__oma_platform__request_access"]), success]);
      const resolveMcpTarget = vi.fn();
      // A skill is the tenant's own text; Claude Code can run shell lines in one.
      const resolveSkills = vi.fn(async () => [{ name: "evil", content: "!`env`" }]);
      await setupHarness(query, { resolveMcpTarget, resolveSkills }).run(makeCtx({ sandbox: null, agent: setupAgent }).ctx);

      const o = seen.options!;
      expect(o.tools).toEqual([]);
      expect(o.disallowedTools).toEqual(expect.arrayContaining(["Bash", "Read", "RemoteTrigger", "Skill", "Agent"]));
      expect(o.strictMcpConfig).toBe(true);
      expect(o.settingSources).toEqual([]);
      expect(o.skills).toBeUndefined();
      expect(o.permissionMode).toBe("default");
      expect(o.env).not.toHaveProperty("DATABASE_URL");
      expect(Object.keys(o.mcpServers).sort()).toEqual(["oma_platform", "oma_setup"]);
      expect(resolveMcpTarget).not.toHaveBeenCalled();
      expect(resolveSkills).not.toHaveBeenCalled();
      // Only the setup tools can be called.
      const can = o.canUseTool as (name: string, input: object) => Promise<{ behavior: string }>;
      expect((await can("mcp__oma_setup__update_harness", {})).behavior).toBe("allow");
      expect((await can("mcp__oma_platform__request_access", {})).behavior).toBe("allow");
      expect((await can("RemoteTrigger", {})).behavior).toBe("deny");
      expect((await can("Bash", { command: "env" })).behavior).toBe("deny");
      expect((await can("mcp__linear__list_issues", {})).behavior).toBe("deny");
    });

    it("is stopped, like a working session, if Claude Code still offers a built-in (RemoteTrigger)", async () => {
      vi.stubEnv("OMA_CLAUDE_ALLOWED_AGENTS", "tnt-1/*");
      const { query, seen } = fakeQuery(() => [init(["mcp__oma_setup__update_harness", "RemoteTrigger"]), success]);
      await expect(setupHarness(query).run(makeCtx({ sandbox: null }).ctx)).rejects.toThrow(/outside this session's own \(RemoteTrigger\)/);
      expect(seen.options!.abortController.signal.aborted).toBe(true);
    });

    it("on a single-operator deployment is what it was (host skills and MCP servers stay)", async () => {
      const { query, seen } = fakeQuery(() => [success]);
      const resolveSkills = vi.fn(async () => [{ name: "xlsx", content: "# xlsx" }]);
      await setupHarness(query, { resolveSkills }).run(makeCtx({ sandbox: null, agent: setupAgent }).ctx);
      expect(resolveSkills).toHaveBeenCalled();
      expect(seen.options!.settingSources).toEqual(["project"]);
      expect(seen.options!.permissionMode).toBe("bypassPermissions");
      expect(seen.options!.disallowedTools).toBeUndefined();
      expect(seen.options!.env.PATH).toBeDefined();
    });
  });
});

describe("ClaudeAgentSdkHarness — sandbox mode", () => {
  const tools = () => {
    const ran: Array<Record<string, unknown>> = [];
    return {
      ran,
      set: {
        bash: {
          description: "Run a command on the sandbox",
          inputSchema: jsonSchema({ type: "object", properties: { command: { type: "string" } }, required: ["command"] }),
          execute: async (input: Record<string, unknown>) => {
            ran.push(input);
            return "ran on the sandbox";
          },
        },
        // What buildTools hands over for an always_ask tool: no execute.
        mcp__linear__delete_issue: { description: "delete", inputSchema: jsonSchema({ type: "object", properties: {} }) },
      },
    };
  };

  it("gives Claude Code no host tool, no settings from disk and none of the server's environment", async () => {
    vi.stubEnv("OMA_CLAUDE_ALLOWED_AGENTS", "tnt-1/*");
    vi.stubEnv("DATABASE_URL", "postgres://secret");
    vi.stubEnv("PLATFORM_ROOT_SECRET", "secret");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "sub-token");
    const t = tools();
    const { query, seen } = fakeQuery(() => [init(["mcp__oma__bash"]), success]);
    const resolveMcpTarget = vi.fn();
    const resolveSkills = vi.fn(async () => [{ name: "xlsx", content: "# xlsx" }]);
    const harness = new ClaudeAgentSdkHarness({ query, resolveMcpTarget, resolveSkills, requestServiceAccess: vi.fn() });
    const { ctx } = makeCtx({
      tools: t.set,
      agent: { mcp_servers: [{ name: "linear", type: "url", url: "https://mcp.linear.app/mcp" }], skills: [{ type: "custom", skill_id: "s1" }] },
    });
    await harness.run(ctx);

    const o = seen.options!;
    expect(o.tools).toEqual([]);
    // `tools: []` alone left RemoteTrigger on offer (live, 0.3.170 with a
    // subscription token), so every built-in is also removed by name.
    expect(o.disallowedTools).toEqual(expect.arrayContaining(["Bash", "Read", "Write", "WebFetch", "Agent", "RemoteTrigger", "CronCreate"]));
    expect(o.strictMcpConfig).toBe(true);
    expect(o.settingSources).toEqual([]);
    expect(o.skills).toBeUndefined();
    expect(o.permissionMode).toBe("default");
    expect(o.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sub-token");
    for (const secret of ["DATABASE_URL", "PLATFORM_ROOT_SECRET", "ANTHROPIC_API_KEY", "SANDBOX_WORKDIR", "OMA_CLAUDE_ALLOWED_AGENTS"]) {
      expect(o.env).not.toHaveProperty(secret);
    }
    // One MCP server: the bridge. The agent's own servers and the in-process
    // platform server are not mounted in Claude Code (they ride ctx.tools).
    expect(Object.keys(o.mcpServers)).toEqual(["oma"]);
    expect(o.mcpServers.oma).toMatchObject({ type: "http", alwaysLoad: true });
    expect(new URL(o.mcpServers.oma.url).hostname).toBe("127.0.0.1");
    expect(resolveMcpTarget).not.toHaveBeenCalled();
    expect(resolveSkills).not.toHaveBeenCalled();
    // The agent's own prompt, not the claude_code preset.
    expect(typeof o.systemPrompt).toBe("string");
    expect(o.systemPrompt).toContain("You process loans.");
    expect(o.systemPrompt).toContain("mcp__oma__");
  });

  it("serves the session's tools over the bridge, runs them where ctx.tools runs them, and closes the bridge", async () => {
    vi.stubEnv("OMA_CLAUDE_ALLOWED_AGENTS", "tnt-1/agent-1");
    const t = tools();
    let listed: string[] = [];
    let result: unknown;
    let early: any;
    const { query, seen } = fakeQuery(async function* (options) {
      // Before Claude Code has reported its tools, the bridge runs nothing.
      await overBridge(options, async (client) => {
        early = await client.callTool({ name: "bash", arguments: { command: "id" } });
      });
      yield init(["mcp__oma__bash"]);
      await overBridge(options, async (client) => {
        listed = (await client.listTools()).tools.map((x) => x.name);
        result = (await client.callTool({ name: "bash", arguments: { command: "ls" } })).content;
      });
      yield {
        type: "assistant",
        session_id: "sdk-1",
        message: { content: [{ type: "tool_use", id: "tu_1", name: "mcp__oma__bash", input: { command: "ls" } }] },
      };
      yield success;
    });
    const { ctx, broadcasts } = makeCtx({ tools: t.set });
    await new ClaudeAgentSdkHarness({ query }).run(ctx);

    // The ask-gated tool (no execute) is not offered.
    expect(listed).toEqual(["bash"]);
    expect(early.isError).toBe(true);
    expect(t.ran).toEqual([{ command: "ls" }]);
    expect(result).toEqual([{ type: "text", text: "ran on the sandbox" }]);
    // Recorded under the platform's own name, as the DefaultHarness does.
    expect(broadcasts.find((b) => b.type === "agent.tool_use")).toMatchObject({ name: "bash", input: { command: "ls" } });
    expect(broadcasts.some((b) => b.type === "session.error")).toBe(false);
    await expect(fetch(seen.options!.mcpServers.oma.url, { method: "POST", body: "{}" })).rejects.toThrow();
  });

  it("refuses every call that is not a bridged tool, and a bridged tool the pinned policy denies", async () => {
    vi.stubEnv("OMA_CLAUDE_ALLOWED_AGENTS", "tnt-1/*");
    const t = tools();
    const { query, seen } = fakeQuery(() => [init(["mcp__oma__bash", "mcp__oma__read"]), success]);
    const { ctx, broadcasts } = makeCtx({
      tools: { ...t.set, read: { ...t.set.bash, description: "Read a file" } },
      agent: { effective_policy: { rules: [{ selector: "bash", effect: "deny" }] } },
    });
    await new ClaudeAgentSdkHarness({ query }).run(ctx);
    const can = seen.options!.canUseTool as (name: string, input: object) => Promise<{ behavior: string }>;
    expect((await can("Bash", { command: "env" })).behavior).toBe("deny");
    expect((await can("Read", { file_path: "/proc/1/environ" })).behavior).toBe("deny");
    expect((await can("mcp__other__bash", {})).behavior).toBe("deny");
    expect((await can("mcp__oma__bash", { command: "ls" })).behavior).toBe("deny");
    expect(broadcasts.find((b) => b.type === "system.policy_decision")).toMatchObject({ tool_name: "bash", effect: "deny" });
    expect((await can("mcp__oma__read", { path: "/workspace/a" })).behavior).toBe("allow");
    // A name under the bridge's prefix that the bridge does not serve.
    expect((await can("mcp__oma__not_a_tool", {})).behavior).toBe("deny");
  });

  it.each([
    ["a built-in next to the bridged tools", ["mcp__oma__bash", "Bash"], /outside this session's own \(Bash\)/],
    ["a tool under the bridge's prefix that the bridge does not serve", ["mcp__oma__bash", "mcp__oma__extra"], /outside this session's own/],
    ["no tool list at all", undefined, /did not report its tools/],
    ["a tool list that is not a list", "mcp__oma__bash", /did not report its tools/],
    ["a tool that is not a name", ["mcp__oma__bash", { name: "Bash" }], /outside this session's own/],
  ])("stops the turn when Claude Code's init reports %s", async (_what, offered, message) => {
    vi.stubEnv("OMA_CLAUDE_ALLOWED_AGENTS", "tnt-1/*");
    const t = tools();
    let lateCall: any;
    const { query, seen } = fakeQuery(async function* (options) {
      yield init(offered, "sdk-rejected");
      // If the harness kept reading, this is what a tool call would do.
      await overBridge(options, async (client) => {
        lateCall = await client.callTool({ name: "bash", arguments: { command: "id" } });
      });
      yield success;
    });
    const { ctx, broadcasts } = makeCtx({ tools: t.set });
    const harness = new ClaudeAgentSdkHarness({ query });
    await expect(harness.run(ctx)).rejects.toThrow(message);
    expect(seen.options!.abortController.signal.aborted).toBe(true);
    expect(broadcasts.some((b) => b.type === "session.error")).toBe(true);
    expect(lateCall).toBeUndefined();
    expect(t.ran).toEqual([]);

    // The rejected Claude Code session is never resumed by the next turn.
    const next = fakeQuery(() => [init(["mcp__oma__bash"], "sdk-ok"), success]);
    await new ClaudeAgentSdkHarness({ query: next.query }).run(ctx);
    expect(next.seen.options!.resume).toBeUndefined();
    const third = fakeQuery(() => [init(["mcp__oma__bash"]), success]);
    await new ClaudeAgentSdkHarness({ query: third.query }).run(ctx);
    expect(third.seen.options!.resume).toBe("sdk-ok");
  });

  it.each([
    ["an assistant message", { type: "assistant", session_id: "sdk-x", message: { content: [{ type: "text", text: "hi" }] } }],
    ["a result", { type: "result", subtype: "success" }],
  ])("stops the turn when %s comes before the init, and when there is no init at all", async (_what, first) => {
    vi.stubEnv("OMA_CLAUDE_ALLOWED_AGENTS", "tnt-1/*");
    const t = tools();
    const { query, seen } = fakeQuery(() => [first, init(["mcp__oma__bash"]), success]);
    const { ctx, broadcasts } = makeCtx({ tools: t.set });
    await expect(new ClaudeAgentSdkHarness({ query }).run(ctx)).rejects.toThrow(/before reporting its tools/);
    expect(seen.options!.abortController.signal.aborted).toBe(true);
    expect(broadcasts.some((b) => b.type === "agent.message")).toBe(false);

    const silent = fakeQuery(() => []);
    await expect(new ClaudeAgentSdkHarness({ query: silent.query }).run(makeCtx({ tools: t.set }).ctx)).rejects.toThrow(
      /ended without reporting its tools/,
    );
  });

  it("a tool call still running when the turn fails is cancelled and finished before the bridge closes", async () => {
    vi.stubEnv("OMA_CLAUDE_ALLOWED_AGENTS", "tnt-1/*");
    const events: string[] = [];
    let callSignal: AbortSignal | undefined;
    const slow = {
      description: "A long command",
      inputSchema: jsonSchema({ type: "object", properties: {} }),
      execute: (_input: unknown, opts: { abortSignal?: AbortSignal }) =>
        new Promise<string>((resolve) => {
          callSignal = opts.abortSignal;
          events.push("call started");
          opts.abortSignal?.addEventListener("abort", () => {
            events.push("call cancelled");
            resolve("stopped");
          });
        }),
    };
    const { query, seen } = fakeQuery(async function* (options) {
      yield init(["mcp__oma__bash"]);
      // Claude Code dispatches the call and does not wait for it here.
      void overBridge(options, (client) => client.callTool({ name: "bash", arguments: {} })).catch(() => {});
      while (!events.includes("call started")) await new Promise((r) => setTimeout(r, 5));
      yield { type: "result", subtype: "error_during_execution" };
    });
    const { ctx } = makeCtx({ tools: { bash: slow } });
    await expect(new ClaudeAgentSdkHarness({ query }).run(ctx)).rejects.toThrow(/turn failed/);
    events.push("run returned");
    expect(events).toEqual(["call started", "call cancelled", "run returned"]);
    // Cancelled by the turn's own signal, the one Claude Code was given.
    expect(callSignal).toBe(seen.options!.abortController.signal);
    await expect(fetch(seen.options!.mcpServers.oma.url, { method: "POST", body: "{}" })).rejects.toThrow();
  });

  it("an agent computer gets sandbox tools even where nobody restricted the engine", async () => {
    const t = tools();
    const { query, seen } = fakeQuery(() => [init(["mcp__oma__bash"]), success]);
    await new ClaudeAgentSdkHarness({ query }).run(makeCtx({ tools: t.set, sandbox: computer }).ctx);
    expect(seen.options!.tools).toEqual([]);
    expect(Object.keys(seen.options!.mcpServers)).toEqual(["oma"]);
  });

  it("fails the session, as Codex computers do, when a tool needs an approval this path cannot ask for", async () => {
    vi.stubEnv("OMA_CLAUDE_ALLOWED_AGENTS", "tnt-1/*");
    const { query, seen } = fakeQuery(() => [success]);
    const { ctx } = makeCtx({
      tools: { bash: { description: "x", inputSchema: jsonSchema({ type: "object", properties: {} }), execute: async () => "x", needsApproval: true } },
    });
    await expect(new ClaudeAgentSdkHarness({ query }).run(ctx)).rejects.toThrow(/cannot enforce approval for bash/);
    expect(seen.calls).toBe(0);
  });
});

describe("ClaudeAgentSdkHarness — host mode is unchanged", () => {
  it("a single-operator deployment keeps Claude Code's own tools and the claude_code preset", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant");
    vi.stubEnv("SOME_OPERATOR_VAR", "kept");
    const { query, seen } = fakeQuery(() => [success]);
    // Daytona configured, engine not restricted: host tools, as before.
    await new ClaudeAgentSdkHarness({ query }).run(makeCtx({ tools: { bash: {} } }).ctx);
    const o = seen.options!;
    expect(o.tools).toBeUndefined();
    expect(o.disallowedTools).toBeUndefined();
    expect(o.strictMcpConfig).toBeUndefined();
    expect(o.permissionMode).toBe("bypassPermissions");
    expect(o.canUseTool).toBeUndefined();
    expect(o.systemPrompt).toMatchObject({ type: "preset", preset: "claude_code" });
    expect(o.env.SOME_OPERATOR_VAR).toBe("kept");
    expect(o.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(o.mcpServers).toBeUndefined();
  });
});
