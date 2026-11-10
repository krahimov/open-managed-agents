import { describe, expect, it } from "vitest";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import {
  anyToolsetAsks,
  mcpServerMayAsk,
  openAiSafeToolName,
  resolveConfirmedToolCall,
  resolveOwningToolsetPermission,
  resolveToolCallPermission,
  resolveToolPermission,
  type ToolConfig,
} from "@open-managed-agents/shared";
import { getEnabledTools, getToolPermission } from "@open-managed-agents/agent/harness/tools";
import {
  applyToolBudget,
  toolCallNeedsApproval,
  CALL_TOOL_NAME,
  SEARCH_TOOL_NAME,
} from "@open-managed-agents/agent/harness/tool-budget";

// QA 2026-11-09: getToolPermission returned the FIRST toolset's policy for
// every tool, so GitHub on always_allow + Linear on always_ask never asked
// for Linear. Each tool now resolves against the toolset it belongs to.

const agentToolset = (dflt?: "always_allow" | "always_ask", configs: Array<{ name: string; policy?: "always_allow" | "always_ask" }> = []) =>
  ({
    type: "agent_toolset_20260401",
    ...(dflt ? { default_config: { enabled: true, permission_policy: { type: dflt } } } : {}),
    ...(configs.length
      ? { configs: configs.map((c) => ({ name: c.name, enabled: true, ...(c.policy ? { permission_policy: { type: c.policy } } : {}) })) }
      : {}),
  }) as ToolConfig;

const mcpToolset = (server: string, dflt?: "always_allow" | "always_ask", configs: Array<{ name: string; policy: "always_allow" | "always_ask"; enabled?: boolean }> = []) =>
  ({
    type: "mcp_toolset",
    mcp_server_name: server,
    ...(dflt ? { default_config: { enabled: true, permission_policy: { type: dflt } } } : {}),
    ...(configs.length
      ? { configs: configs.map((c) => ({ name: c.name, enabled: c.enabled ?? true, permission_policy: { type: c.policy } })) }
      : {}),
  }) as unknown as ToolConfig;

describe("resolveToolPermission", () => {
  it("per-server always_ask is honored even when an earlier toolset is always_allow (the QA bug)", () => {
    const tools = [mcpToolset("github", "always_allow"), mcpToolset("linear", "always_ask")];
    expect(resolveToolPermission(tools, "mcp__github__create_issue")).toBe("always_allow");
    expect(resolveToolPermission(tools, "mcp__linear__create_issue")).toBe("always_ask");
  });

  it("a later agent toolset's policy governs built-ins regardless of order", () => {
    const tools = [mcpToolset("github", "always_allow"), agentToolset("always_ask")];
    expect(resolveToolPermission(tools, "bash")).toBe("always_ask");
    expect(resolveToolPermission(tools, "mcp__github__list")).toBe("always_allow");
  });

  it("owning toolset: an MCP toolset's policy doesn't govern built-ins", () => {
    const tools = [mcpToolset("linear", "always_ask"), agentToolset("always_allow")];
    expect(resolveOwningToolsetPermission(tools, "bash")).toBe("always_allow");
    expect(resolveOwningToolsetPermission([mcpToolset("linear", "always_ask")], "bash")).toBe("always_allow");
  });

  it("ratchet: anything the old first-toolset rule asked for still asks", () => {
    // Old rule: first toolset (linear, always_ask) governed bash too.
    expect(resolveToolPermission([mcpToolset("linear", "always_ask"), agentToolset("always_allow")], "bash")).toBe("always_ask");
  });

  it("console-shaped agent (built-in default always_ask + auto-written always_allow servers) keeps asking for MCP tools", () => {
    // AgentFormDialog writes every mcp_toolset as always_allow whatever the
    // user picked; on main the first (agent) toolset's always_ask governed
    // MCP calls too. That must not silently stop on deploy.
    const tools = [agentToolset("always_ask"), mcpToolset("linear", "always_allow"), mcpToolset("slack", "always_allow")];
    expect(resolveToolPermission(tools, "mcp__linear__save_issue")).toBe("always_ask");
    expect(resolveToolPermission(tools, "mcp__slack__post_message")).toBe("always_ask");
    expect(resolveToolPermission(tools, "bash")).toBe("always_ask");
    // The owning rule (used by the SDK harnesses, which never asked) honors the server's entry.
    expect(resolveOwningToolsetPermission(tools, "mcp__linear__save_issue")).toBe("always_allow");
  });

  it("the ratchet never loosens: nothing that asked on main stops asking", () => {
    const shapes: ToolConfig[][] = [
      [agentToolset("always_ask"), mcpToolset("a", "always_allow")],
      [mcpToolset("a", "always_ask"), agentToolset("always_allow")],
      [mcpToolset("a", "always_allow"), mcpToolset("b", "always_ask")],
      [agentToolset("always_allow", [{ name: "bash", policy: "always_ask" }]), mcpToolset("a")],
      [mcpToolset("a", "always_allow", [{ name: "x", policy: "always_ask" }]), agentToolset("always_ask")],
    ];
    const names = ["bash", "read", "mcp__a__x", "mcp__a__y", "mcp__b__x", "mcp__c__x"];
    // The pre-fix resolver, verbatim.
    const legacy = (tools: ToolConfig[], name: string) => {
      for (const t of tools as Array<any>) {
        if (t.type === "custom") continue;
        const cfg = t.configs?.find((c: any) => c.name === name);
        if (cfg?.permission_policy?.type) return cfg.permission_policy.type;
        if (t.default_config?.permission_policy?.type) return t.default_config.permission_policy.type;
      }
      return "always_allow";
    };
    for (const tools of shapes) {
      for (const name of names) {
        if (legacy(tools, name) === "always_ask") expect(resolveToolPermission(tools, name), `${name} in ${JSON.stringify(tools)}`).toBe("always_ask");
      }
    }
  });

  it("per-tool config beats the toolset default — bare or full MCP name", () => {
    const tools = [
      mcpToolset("linear", "always_allow", [{ name: "delete_issue", policy: "always_ask" }]),
      mcpToolset("slack", "always_ask", [{ name: "mcp__slack__search", policy: "always_allow" }]),
      agentToolset("always_allow", [{ name: "bash", policy: "always_ask" }]),
    ];
    expect(resolveToolPermission(tools, "mcp__linear__delete_issue")).toBe("always_ask");
    expect(resolveToolPermission(tools, "mcp__linear__list_issues")).toBe("always_allow");
    expect(resolveToolPermission(tools, "mcp__slack__search")).toBe("always_allow");
    expect(resolveToolPermission(tools, "mcp__slack__post_message")).toBe("always_ask");
    expect(resolveToolPermission(tools, "bash")).toBe("always_ask");
    expect(resolveToolPermission(tools, "read")).toBe("always_allow");
  });

  it("an MCP tool whose toolset declares nothing inherits the agent toolset's gate (no silent loosening)", () => {
    expect(resolveToolPermission([agentToolset("always_ask"), mcpToolset("github")], "mcp__github__x")).toBe("always_ask");
    expect(resolveToolPermission([agentToolset("always_ask")], "mcp__notion__search")).toBe("always_ask");
  });

  it("owning toolset: another server's policy doesn't govern a server without its own toolset", () => {
    expect(resolveOwningToolsetPermission([mcpToolset("linear", "always_ask")], "mcp__github__x")).toBe("always_allow");
  });

  it("server names with underscores resolve to the right toolset", () => {
    const tools = [mcpToolset("my", "always_allow"), mcpToolset("my_server", "always_ask")];
    expect(resolveToolPermission(tools, "mcp__my_server__do_thing")).toBe("always_ask");
    expect(resolveToolPermission(tools, "mcp__my__do_thing")).toBe("always_allow");
  });

  it("an explicit per-tool always_ask naming the full MCP tool wins from any toolset", () => {
    const tools = [agentToolset("always_allow", [{ name: "mcp__linear__delete_issue", policy: "always_ask" }]), mcpToolset("linear", "always_allow")];
    expect(resolveOwningToolsetPermission(tools, "mcp__linear__delete_issue")).toBe("always_ask");
    expect(resolveOwningToolsetPermission(tools, "mcp__linear__list_issues")).toBe("always_allow");
  });

  it("mcpServerMayAsk: per server, by its own toolset (or inherited default)", () => {
    expect(mcpServerMayAsk([agentToolset("always_ask"), mcpToolset("linear", "always_allow")], "linear")).toBe(false);
    expect(mcpServerMayAsk([mcpToolset("linear", "always_allow", [{ name: "delete_issue", policy: "always_ask" }])], "linear")).toBe(true);
    expect(mcpServerMayAsk([mcpToolset("linear", "always_ask")], "linear")).toBe(true);
    expect(mcpServerMayAsk([mcpToolset("linear", "always_ask")], "github")).toBe(false);
    expect(mcpServerMayAsk([agentToolset("always_ask")], "github")).toBe(true); // no own policy → inherits
    expect(mcpServerMayAsk([agentToolset("always_allow", [{ name: "bash", policy: "always_ask" }])], "github")).toBe(false);
  });

  it("defaults to always_allow; custom tools are ignored", () => {
    expect(resolveToolPermission(undefined, "bash")).toBe("always_allow");
    expect(resolveToolPermission([{ type: "custom", name: "x", description: "", input_schema: {} }], "x")).toBe("always_allow");
  });

  it("call_mcp_tool takes the policy of the deferred tool it names", () => {
    const tools = [mcpToolset("github", "always_allow"), mcpToolset("linear", "always_ask")];
    expect(resolveToolCallPermission(tools, "call_mcp_tool", { name: "mcp__linear__create_issue" })).toBe("always_ask");
    expect(resolveToolCallPermission(tools, "call_mcp_tool", { name: "mcp__github__create_issue" })).toBe("always_allow");
  });

  it("anyToolsetAsks sees defaults and per-tool configs", () => {
    expect(anyToolsetAsks([agentToolset("always_allow"), mcpToolset("github", "always_allow")])).toBe(false);
    expect(anyToolsetAsks([mcpToolset("linear", "always_allow", [{ name: "x", policy: "always_ask" }])])).toBe(true);
    expect(anyToolsetAsks(undefined)).toBe(false);
  });
});

describe("DefaultHarness tool config", () => {
  const agent = (tools: ToolConfig[]) => ({ tools }) as never;

  it("getToolPermission delegates to the per-toolset resolver", () => {
    const a = agent([mcpToolset("github", "always_allow"), mcpToolset("linear", "always_ask")]);
    expect(getToolPermission(a, "mcp__linear__save_issue")).toBe("always_ask");
    expect(getToolPermission(a, "mcp__github__get_file")).toBe("always_allow");
  });

  it("getEnabledTools ignores mcp_toolset configs (they name server tools, not built-ins)", () => {
    const off = { type: "mcp_toolset", mcp_server_name: "github", default_config: { enabled: false }, configs: [] } as unknown as ToolConfig;
    const enabled = getEnabledTools([off, agentToolset(undefined, [{ name: "browser" }])]);
    expect(enabled.has("bash")).toBe(true);
    expect(enabled.has("browser")).toBe(true);
  });
});

describe("call_mcp_tool respects the deferred tool's permission", () => {
  const exec = async () => "ran";
  // 6 tools, cap 5 (3 after the two meta tools): built-in + github fit, linear is deferred.
  function budgeted() {
    const tools: ToolSet = {
      a: tool({ inputSchema: z.object({}), execute: exec }),
      mcp__github__get: tool({ inputSchema: z.object({}), execute: exec }),
      mcp__github__list: tool({ inputSchema: z.object({}), execute: exec }),
      // always_ask → buildTools stripped execute
      mcp__linear__create_issue: tool({ description: "Create a Linear issue", inputSchema: z.object({ title: z.string() }) }),
      mcp__linear__list_issues: tool({ description: "List Linear issues", inputSchema: z.object({}), execute: exec }),
      mcp__linear__get_team: tool({ description: "Get a Linear team", inputSchema: z.object({}), execute: exec }),
    };
    return applyToolBudget(tools, { maxTools: 5, serverOrder: ["github", "linear"] });
  }

  it("needsApproval only for gated targets", () => {
    const { tools, deferred } = budgeted();
    expect([...deferred.keys()]).toEqual(["mcp__linear__create_issue", "mcp__linear__list_issues", "mcp__linear__get_team"]);
    const call = tools[CALL_TOOL_NAME];
    expect(toolCallNeedsApproval(call, { name: "mcp__linear__create_issue", arguments: { title: "x" } })).toBe(true);
    expect(toolCallNeedsApproval(call, { name: "mcp__linear__list_issues" })).toBe(false);
    expect(toolCallNeedsApproval(call, { name: "mcp__nope__x" })).toBe(false);
    expect(toolCallNeedsApproval(tools.a, {})).toBe(false);
  });

  it("never executes a gated target unasked, even if a harness ignores needsApproval", async () => {
    const { tools } = budgeted();
    const out = await (tools[CALL_TOOL_NAME] as any).execute({ name: "mcp__linear__create_issue", arguments: { title: "x" } }, {});
    expect(out).toMatch(/requires user approval/);
    expect(await (tools[CALL_TOOL_NAME] as any).execute({ name: "mcp__linear__list_issues", arguments: {} }, {})).toBe("ran");
  });

  it("search_mcp_tools flags gated tools", async () => {
    const { tools } = budgeted();
    const out = JSON.parse(await (tools[SEARCH_TOOL_NAME] as any).execute({ query: "linear issue" }, {}));
    const byName = Object.fromEntries(out.map((r: { name: string }) => [r.name, r]));
    expect(byName.mcp__linear__create_issue.requires_approval).toBe(true);
    expect(byName.mcp__linear__list_issues.requires_approval).toBeUndefined();
  });

  it("call_mcp_tool accepts arguments as a JSON string (some models stringify them)", async () => {
    const seen: unknown[] = [];
    const { tools } = applyToolBudget(
      {
        a: tool({ inputSchema: z.object({}), execute: exec }),
        b: tool({ inputSchema: z.object({}), execute: exec }),
        c: tool({ inputSchema: z.object({}), execute: exec }),
        d: tool({ inputSchema: z.object({}), execute: exec }),
        mcp__linear__list_issues: tool({
          inputSchema: z.object({ team: z.string() }),
          execute: async (args) => void seen.push(args) ?? "ran",
        }),
      },
      { maxTools: 4 },
    );
    await (tools[CALL_TOOL_NAME] as any).execute({ name: "mcp__linear__list_issues", arguments: '{"team":"t1"}' }, {});
    expect(seen).toEqual([{ team: "t1" }]);
    expect(resolveConfirmedToolCall({ mcp__linear__x: 1 }, "call_mcp_tool", { name: "mcp__linear__x", arguments: '{"a":1}' }).input).toEqual({ a: 1 });
    expect(resolveConfirmedToolCall({ mcp__linear__x: 1 }, "call_mcp_tool", { name: "mcp__linear__x", arguments: "not json" }).input).toEqual({});
  });

  it("an approval of a tool whose name was shortened for OpenAI finds the original", () => {
    const long = "mcp__composio_gmail_googlecalendar_notion__COMPOSIO_MULTI_EXECUTE_TOOL";
    const short = openAiSafeToolName(long);
    expect(short.length).toBe(64);
    const built = { [long]: { execute: exec } };
    expect(resolveConfirmedToolCall(built, short, {}).tool).toBe(built[long]);
    expect(resolveConfirmedToolCall(built, "x".repeat(64), {}).tool).toBeUndefined();
  });

  it("an approval resolves call_mcp_tool to the target tool + its arguments", () => {
    const built = { mcp__linear__create_issue: { execute: exec }, bash: { execute: exec } };
    expect(
      resolveConfirmedToolCall(built, "call_mcp_tool", { name: "mcp__linear__create_issue", arguments: { title: "x" } }),
    ).toEqual({ tool: built.mcp__linear__create_issue, name: "mcp__linear__create_issue", input: { title: "x" } });
    // Only MCP targets — a forged name can't reach a built-in.
    expect(resolveConfirmedToolCall(built, "call_mcp_tool", { name: "bash", arguments: {} }).tool).toBeUndefined();
    expect(resolveConfirmedToolCall(built, "bash", { command: "ls" })).toEqual({ tool: built.bash, name: "bash", input: { command: "ls" } });
  });
});

describe("DefaultHarness tool_use events for gated calls", () => {
  it("an ask-gated MCP call carries evaluated_permission: ask (recovery/console key on it)", async () => {
    const { toolCallEvents } = await import("@open-managed-agents/agent/harness/default-loop");
    const [ev] = toolCallEvents({ toolCallId: "c1", toolName: "mcp__linear__create_issue", input: {} }, { pending: true });
    expect(ev).toMatchObject({ type: "agent.mcp_tool_use", evaluated_permission: "ask" });
    const [allowed] = toolCallEvents({ toolCallId: "c2", toolName: "mcp__github__get", input: {} }, { pending: false });
    expect(allowed).not.toHaveProperty("evaluated_permission");
  });

  it("the tool-budget meta tools are server-side tools, not client custom tools", async () => {
    const { toolCallEvents, isBuiltinTool } = await import("@open-managed-agents/agent/harness/default-loop");
    expect(isBuiltinTool(CALL_TOOL_NAME)).toBe(true);
    expect(isBuiltinTool(SEARCH_TOOL_NAME)).toBe(true);
    const [ev] = toolCallEvents(
      { toolCallId: "c3", toolName: CALL_TOOL_NAME, input: { name: "mcp__linear__create_issue" } },
      { pending: true },
    );
    expect(ev).toMatchObject({ type: "agent.tool_use", evaluated_permission: "ask" });
  });
});

describe("claude-agent-sdk harness toolset gate", () => {
  it("matches Claude Code's normalized server names, and treats NotebookEdit as edit", async () => {
    const { sdkToolsetGate } = await import("../src/lib/claude-agent-sdk-harness");
    const gate = sdkToolsetGate({
      tools: [mcpToolset("linear.app", "always_ask"), agentToolset("always_allow", [{ name: "edit", policy: "always_ask" }])],
      mcp_servers: [{ name: "linear.app", type: "url" }],
    } as never);
    expect(gate.asks("mcp__linear_app__save_issue")).toBe(true);
    expect(gate.asks("NotebookEdit")).toBe(true);
    expect(gate.disallowedTools.sort()).toEqual(["Edit", "MultiEdit", "NotebookEdit"]);
  });

  it("console-shaped agent: built-ins refused, auto-written always_allow servers keep working", async () => {
    const { sdkToolsetGate } = await import("../src/lib/claude-agent-sdk-harness");
    const gate = sdkToolsetGate({
      tools: [agentToolset("always_ask"), mcpToolset("linear", "always_allow")],
      mcp_servers: [{ name: "linear", type: "url" }],
    } as never);
    expect(gate.asks("mcp__linear__save_issue")).toBe(false);
    expect(gate.disallowedTools).toContain("Bash");
  });

  it("refuses always_ask MCP servers per call, allows the rest", async () => {
    const { sdkToolsetGate } = await import("../src/lib/claude-agent-sdk-harness");
    const gate = sdkToolsetGate({
      tools: [mcpToolset("github", "always_allow"), mcpToolset("linear", "always_ask"), agentToolset("always_allow")],
      mcp_servers: [{ name: "github", type: "url" }, { name: "linear", type: "url" }],
    } as never);
    expect(gate.active).toBe(true);
    expect(gate.asks("mcp__linear__save_issue")).toBe(true);
    expect(gate.asks("mcp__github__get_file")).toBe(false);
    expect(gate.asks("Bash")).toBe(false);
    expect(gate.disallowedTools).toEqual([]);
  });

  it("removes always_ask built-ins statically (default mode auto-approves read-only tools)", async () => {
    const { sdkToolsetGate } = await import("../src/lib/claude-agent-sdk-harness");
    const gate = sdkToolsetGate({
      tools: [agentToolset("always_allow", [{ name: "read", policy: "always_ask" }, { name: "bash", policy: "always_ask" }])],
    } as never);
    expect(gate.disallowedTools.sort()).toEqual(["Bash", "Read"]);
    expect(gate.asks("Bash")).toBe(true);
    expect(gate.asks("Write")).toBe(false);
  });

  it("never gates Claude Code internals or the platform's in-process servers", async () => {
    const { sdkToolsetGate } = await import("../src/lib/claude-agent-sdk-harness");
    const gate = sdkToolsetGate({ tools: [agentToolset("always_ask")], mcp_servers: [] } as never);
    expect(gate.asks("ToolSearch")).toBe(false);
    expect(gate.asks("TodoWrite")).toBe(false);
    expect(gate.asks("mcp__oma_platform__request_access")).toBe(false);
    expect(gate.asks("mcp__oma_setup__update_harness")).toBe(false);
    expect(gate.asks("Bash")).toBe(true);
  });

  it("is inactive when nothing asks (sessions keep bypassPermissions)", async () => {
    const { sdkToolsetGate } = await import("../src/lib/claude-agent-sdk-harness");
    expect(sdkToolsetGate({ tools: [agentToolset("always_allow"), mcpToolset("github", "always_allow")] } as never).active).toBe(false);
  });
});
