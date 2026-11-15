// MCP tool results and deferred MCP tools through the real buildTools()
// + @ai-sdk/mcp client (fake servers behind mcpBinding), the DefaultHarness
// and the approval path.
//
//   - What the model saw in-turn is what history replays, byte for byte
//     (the raw CallToolResult used to be persisted as a JSON envelope, so
//     later turns sent a bigger, differently shaped tool result and the
//     provider prompt cache broke from there on).
//   - MCP results are capped like built-ins.
//   - Deferred tools stay behind the permission gates: denied ones are
//     unreachable through call_mcp_tool, ask-gated ones park and run only
//     after approval.
//   - The MCP clients a tool dict opened are closed by releaseTools().

import { describe, expect, it, vi } from "vitest";
import type { ToolSet } from "ai";
import { releaseTools, resolveConfirmedToolCall, type AgentConfig } from "@open-managed-agents/shared";
import { withAskGatesLifted } from "@open-managed-agents/session-runtime";
import { buildTools } from "@open-managed-agents/agent/harness/tools";
import { CALL_TOOL_NAME, SEARCH_TOOL_NAME, applyAgentToolBudget } from "@open-managed-agents/agent/harness/tool-budget";
import {
  DEFAULT_MCP_RESULT_PREVIEW_CHARS,
  MAX_TOOL_RESULT_CHARS,
  mcpModelOutput,
  mcpResultForModel,
  mcpResultPreviewChars,
  mcpResultWithSpill,
  mcpWireText,
} from "@open-managed-agents/agent/harness/mcp-output";
import { eventsToMessages } from "@open-managed-agents/agent/runtime/history";
import { fakeMcpBinding, syntheticMcpTool, type FakeMcpBinding } from "./_helpers/fake-mcp";

const sandbox = { exec: async () => "", readFile: async () => "", writeFile: async () => "" } as never;

// A small server (loads directly) and a ~50k-token one (deferred in auto).
function servers(call?: (name: string, args: Record<string, unknown>) => unknown) {
  return fakeMcpBinding({
    sentry: {
      tools: [
        { name: "get_issue", description: "Get a Sentry issue", inputSchema: { type: "object", properties: { id: { type: "string" } } } },
      ],
      call,
    },
    notion: {
      tools: Array.from({ length: 40 }, (_, i) => syntheticMcpTool(i === 0 ? "create_page" : i === 1 ? "delete_page" : `op_${i}`, 1250)),
      call,
    },
  });
}

function agentConfig(extra: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "agent_mcp",
    name: "mcp",
    model: "claude-opus-5-5",
    system: "",
    tools: [{ type: "agent_toolset_20260401" }],
    mcp_servers: [
      { name: "notion", type: "url", url: "https://mcp.notion.test/mcp" },
      { name: "sentry", type: "url", url: "https://mcp.sentry.test/mcp" },
    ],
    version: 1,
    created_at: "2026-11-10T00:00:00Z",
    ...extra,
  } as AgentConfig;
}

const build = (agent: AgentConfig, binding: FakeMcpBinding) =>
  buildTools(agent, sandbox, { mcpBinding: binding, tenantId: "tn_test", sessionId: "sess_mcp" });

describe("mcpResultForModel", () => {
  it("text-only results become one string; structuredContent duplicates are dropped", () => {
    expect(mcpResultForModel({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }], structuredContent: { a: 1 } })).toBe("a\nb");
    // structuredContent only when there is no content at all.
    expect(mcpResultForModel({ content: [], structuredContent: { a: 1 } })).toBe('{"a":1}');
    expect(mcpResultForModel({ toolResult: { legacy: true } })).toBe('{"legacy":true}');
    expect(mcpResultForModel({ content: [{ type: "resource", resource: { uri: "x://y", text: "t" } }] })).toBe(
      '{"type":"resource","resource":{"uri":"x://y","text":"t"}}',
    );
  });

  it("keeps the error signal in the text", () => {
    expect(mcpResultForModel({ content: [{ type: "text", text: "not found" }], isError: true })).toBe("Error: not found");
    expect(mcpResultForModel({ content: [{ type: "text", text: "Error: not found" }], isError: true })).toBe("Error: not found");
  });

  it("caps results at the built-in limit", () => {
    const out = mcpResultForModel({ content: [{ type: "text", text: "y".repeat(120_000) }] }) as string;
    expect(out.length).toBeLessThan(MAX_TOOL_RESULT_CHARS + 100);
    expect(out).toMatch(/\.\.\.\(truncated, total 120000 chars\)$/);
  });

  it("images stay content blocks for the model; the mcp_tool_result copy keeps a placeholder", () => {
    const blocks = mcpResultForModel({ content: [{ type: "text", text: "shot" }, { type: "image", data: "AAAA", mimeType: "image/png" }] });
    expect(blocks).toEqual([
      { type: "text", text: "shot" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
    ]);
    expect(mcpModelOutput({ output: blocks })).toEqual({
      type: "content",
      value: [{ type: "text", text: "shot" }, { type: "image-data", data: "AAAA", mediaType: "image/png" }],
    });
    expect(mcpWireText(blocks as never)).toMatch(/^shot\n\[image image\/png returned by the tool/);
    expect(mcpModelOutput({ output: "plain" })).toEqual({ type: "text", value: "plain" });
  });
});

describe("MCP tools from buildTools", () => {
  it("execute returns the model-facing string, capped, and the dict's release closes the clients", async () => {
    const binding = servers((name) =>
      name === "get_issue"
        ? { content: [{ type: "text", text: "z".repeat(80_000) }], structuredContent: { big: "z".repeat(80_000) } }
        : undefined,
    );
    const tools = (await build(agentConfig(), binding)) as Record<string, any>;
    expect(Object.keys(tools).filter((n) => n.startsWith("mcp__notion__"))).toHaveLength(40);
    const out = await tools.mcp__sentry__get_issue.execute({ id: "1" }, { toolCallId: "c1", messages: [] });
    expect(typeof out).toBe("string");
    expect(out.length).toBeLessThan(MAX_TOOL_RESULT_CHARS + 100);
    expect(await tools.mcp__sentry__get_issue.toModelOutput({ toolCallId: "c1", input: {}, output: out })).toEqual({ type: "text", value: out });

    expect(binding.closed).toEqual([]);
    await releaseTools(tools);
    expect(binding.closed.sort()).toEqual(["notion", "sentry"]);
    await releaseTools(tools); // idempotent
    expect(binding.closed).toHaveLength(2);
  });
});

// Oversized results: a result is re-read on every later model call, so a
// text result over the preview limit goes to the sandbox in full and the
// model keeps its head plus a pointer (decided once, at insertion).
describe("oversized MCP results → sandbox file + preview", () => {
  const spillTo = (files: Map<string, string>, maxChars = 1_000) => ({
    maxChars,
    readers: ["read", "grep"],
    write: async (path: string, content: string) => void files.set(path, content),
  });

  it("writes a JSON result pretty-printed and returns its head plus a note naming the file", async () => {
    const files = new Map<string, string>();
    const rows = Array.from({ length: 200 }, (_, i) => ({ id: i, name: `deal ${i}`, amount: i * 100 }));
    const raw = { content: [{ type: "text", text: JSON.stringify({ results: rows }) }] };
    const out = (await mcpResultWithSpill(raw, "call_Ab9/x", spillTo(files))) as string;
    const path = "/workspace/.tool-results/call_Ab9_x.json";
    expect(JSON.parse(files.get(path)!)).toEqual({ results: rows });
    expect(files.get(path)).toContain('\n  "results": [');
    expect(out.startsWith(JSON.stringify({ results: rows }).slice(0, 1_000))).toBe(true);
    expect(out).toContain(`The full output is saved at ${path} (pretty-printed JSON, ${files.get(path)!.split("\n").length} lines)`);
    expect(out).toContain("with read / grep instead of calling the tool again");
    expect(out.length).toBeLessThan(1_000 + 400);
    // Pure for the same input: replay and the prompt cache see the same bytes.
    expect(await mcpResultWithSpill(raw, "call_Ab9/x", spillTo(new Map()))).toBe(out);
  });

  it("cuts text at a line end near the limit and saves it as .txt", async () => {
    const files = new Map<string, string>();
    const text = Array.from({ length: 100 }, (_, i) => `line ${i} ${"-".repeat(40)}`).join("\n");
    const out = (await mcpResultWithSpill(text, "c2", spillTo(files))) as string;
    expect(files.get("/workspace/.tool-results/c2.txt")).toBe(text);
    const head = out.slice(0, out.indexOf("\n...[output truncated"));
    expect(text.startsWith(head)).toBe(true);
    expect(text[head.length]).toBe("\n");
    expect(out).toContain(`showing the first ${head.length} of ${text.length} chars`);
  });

  it("short results, images, no spill config and a failed write keep the plain cap", async () => {
    expect(await mcpResultWithSpill({ content: [{ type: "text", text: "small" }] }, "c3", spillTo(new Map()))).toBe("small");
    const blocks = { content: [{ type: "text", text: "x".repeat(5_000) }, { type: "image", data: "AAAA", mimeType: "image/png" }] };
    expect(await mcpResultWithSpill(blocks, "c3", spillTo(new Map()))).toEqual(mcpResultForModel(blocks));
    const huge = { content: [{ type: "text", text: "y".repeat(120_000) }] };
    expect(await mcpResultWithSpill(huge, "c3", undefined)).toBe(mcpResultForModel(huge));
    expect(await mcpResultWithSpill(huge, undefined, spillTo(new Map()))).toBe(mcpResultForModel(huge));
    const failing = { ...spillTo(new Map()), write: async () => { throw new Error("disk full"); } };
    expect(await mcpResultWithSpill(huge, "c3", failing)).toBe(mcpResultForModel(huge));
  });

  it("metadata.mcp_result_max_chars sets the preview length; 0 turns spilling off", () => {
    expect(mcpResultPreviewChars(undefined)).toBe(DEFAULT_MCP_RESULT_PREVIEW_CHARS);
    expect(mcpResultPreviewChars({ mcp_result_max_chars: 8_000 })).toBe(8_000);
    expect(mcpResultPreviewChars({ mcp_result_max_chars: 0 })).toBe(0);
    expect(mcpResultPreviewChars({ mcp_result_max_chars: 10 })).toBe(1_000);
    expect(mcpResultPreviewChars({ mcp_result_max_chars: "big" })).toBe(DEFAULT_MCP_RESULT_PREVIEW_CHARS);
  });

  it("buildTools spills through the sandbox only when the agent has a file tool to read it back", async () => {
    const big = "r".repeat(DEFAULT_MCP_RESULT_PREVIEW_CHARS * 2);
    const run = async (extra: Partial<AgentConfig>) => {
      const writes: Array<[string, string]> = [];
      const sb = { exec: async () => "", readFile: async () => "", writeFile: async (p: string, c: string) => { writes.push([p, c]); return p; } } as never;
      const tools = (await buildTools(agentConfig(extra), sb, {
        mcpBinding: servers(() => ({ content: [{ type: "text", text: big }] })),
        tenantId: "tn_test",
        sessionId: "sess_mcp",
      })) as Record<string, any>;
      const out = await tools.mcp__sentry__get_issue.execute({ id: "1" }, { toolCallId: "call_big", messages: [] });
      await releaseTools(tools);
      return { out: out as string, writes };
    };

    const spilled = await run({});
    expect(spilled.writes).toEqual([["/workspace/.tool-results/call_big.txt", big]]);
    expect(spilled.out.length).toBeLessThan(DEFAULT_MCP_RESULT_PREVIEW_CHARS + 400);
    expect(spilled.out).toContain("with read / grep / bash");

    for (const extra of [
      { metadata: { mcp_result_max_chars: 0 } },
      { tools: [{ type: "agent_toolset_20260401", default_config: { enabled: false }, configs: [] }] },
    ] as Array<Partial<AgentConfig>>) {
      const legacy = await run(extra);
      expect(legacy.writes).toEqual([]);
      expect(legacy.out).toBe(mcpResultForModel({ content: [{ type: "text", text: big }] }));
    }
  });
});

// ── DefaultHarness ────────────────────────────────────────────────────

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const finish = (unified: string) => ({ type: "finish", finishReason: { unified, raw: unified }, usage });
const stream = (parts: unknown[]) => new ReadableStream({ start(c) { parts.forEach((p) => c.enqueue(p)); c.close(); } });
const toolCall = (id: string, toolName: string, input: unknown) => [
  { type: "stream-start", warnings: [] },
  { type: "tool-call", toolCallId: id, toolName, input: JSON.stringify(input) },
  finish("tool-calls"),
];
const text = (t: string) => [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: t },
  { type: "text-end", id: "t" },
  finish("stop"),
];

function harnessRuntime(events: Array<Record<string, any>>) {
  const noop = vi.fn(async () => {});
  return {
    history: { getEvents: () => events.slice() },
    broadcast: vi.fn((e: Record<string, any>) => void events.push(e)),
    persist: vi.fn(async (e: Record<string, any>) => void events.push(e)),
    broadcastStreamStart: noop, broadcastStreamEnd: noop, broadcastChunk: noop,
    broadcastThinkingStart: noop, broadcastThinkingChunk: noop, broadcastThinkingEnd: noop,
    broadcastToolInputStart: noop, broadcastToolInputChunk: noop, broadcastToolInputEnd: noop,
    pendingConfirmations: [] as string[],
  };
}

/** Run turns against a scripted model (one stream per model call). */
async function runScripted(opts: {
  provider: string;
  modelId: string;
  script: unknown[][];
  agent: AgentConfig;
  binding: FakeMcpBinding;
  turns: number;
  /** Event log of an interrupted turn: the first run resumes it (its last
   *  user.message, no new one). */
  resume?: Array<Record<string, any>>;
}) {
  const { MockLanguageModelV3 } = await import("ai/test");
  const { DefaultHarness } = await import("@open-managed-agents/agent/harness/default-loop");
  let n = 0;
  const model = new MockLanguageModelV3({
    provider: opts.provider,
    modelId: opts.modelId,
    doStream: async () => ({ stream: stream(opts.script[n++] ?? text("done")) }) as never,
  });
  const events: Array<Record<string, any>> = opts.resume ?? [];
  const runtimes: ReturnType<typeof harnessRuntime>[] = [];
  for (let i = 0; i < opts.turns; i++) {
    let userMessage: Record<string, any> | undefined;
    if (i === 0 && opts.resume) userMessage = events.findLast((e) => e.type === "user.message");
    if (!userMessage) {
      userMessage = { type: "user.message", content: [{ type: "text", text: `turn ${i}` }] };
      events.push(userMessage);
    }
    const runtime = harnessRuntime(events);
    runtimes.push(runtime);
    const tools = await build(opts.agent, opts.binding);
    await new DefaultHarness().run({
      agent: opts.agent,
      model, systemPrompt: "Test", env: {}, session_id: "sess_mcp",
      userMessage, tools, runtime,
    } as never);
    await releaseTools(tools);
  }
  return { calls: model.doStreamCalls, events, runtimes };
}

type PromptMsg = { role: string; content: Array<Record<string, any>> };
const toolResultIn = (prompt: unknown, toolCallId: string) =>
  (prompt as PromptMsg[])
    .filter((m) => m.role === "tool")
    .flatMap((m) => m.content)
    .find((p) => p.type === "tool-result" && p.toolCallId === toolCallId);
const toolCallIn = (prompt: unknown, toolCallId: string) =>
  (prompt as PromptMsg[])
    .filter((m) => m.role === "assistant")
    .flatMap((m) => m.content)
    .find((p) => p.type === "tool-call" && p.toolCallId === toolCallId);
/** The prompt without providerOptions (Anthropic cache breakpoints move to
 *  the newest messages every call; they are not part of the cached text). */
const withoutCacheMarkers = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(withoutCacheMarkers)
  : v && typeof v === "object"
    ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== "providerOptions").map(([k, x]) => [k, withoutCacheMarkers(x)]))
    : v;

describe("persisted MCP output = what the model saw", () => {
  for (const [provider, modelId] of [["anthropic.messages", "claude-opus-5-5"], ["openai.responses", "gpt-6.1-sol"]] as const) {
    it(`${provider}: a direct MCP call replays byte for byte on the next turn`, async () => {
      const binding = servers(() => ({
        content: [{ type: "text", text: "Issue SENTRY-1: TypeError" }],
        structuredContent: { id: "SENTRY-1", title: "TypeError" },
      }));
      const { calls, events } = await runScripted({
        provider, modelId, binding, agent: agentConfig(), turns: 2,
        script: [toolCall("toolu_1", "mcp__sentry__get_issue", { id: "SENTRY-1" }), text("found it"), text("still there")],
      });
      // calls[1] = turn 1 after the tool ran; calls[2] = turn 2 (replay).
      const inTurn = toolResultIn(calls[1].prompt, "toolu_1");
      const replayed = toolResultIn(calls[2].prompt, "toolu_1");
      expect(inTurn?.output).toEqual({ type: "text", value: "Issue SENTRY-1: TypeError" });
      expect(JSON.stringify(replayed?.output)).toBe(JSON.stringify(inTurn?.output));
      // The tool-call part and the result's toolName replay as the model
      // called them (history used to rebuild "mcp__sentry__get_call").
      expect(toolCallIn(calls[2].prompt, "toolu_1")).toEqual(toolCallIn(calls[1].prompt, "toolu_1"));
      expect(toolCallIn(calls[2].prompt, "toolu_1")).toMatchObject({ toolName: "mcp__sentry__get_issue" });
      expect(replayed?.toolName).toBe("mcp__sentry__get_issue");
      // Whole request prefix: turn 2 starts with exactly what turn 1's
      // second call sent (cache markers aside), so the provider cache hits.
      const turn1 = withoutCacheMarkers(calls[1].prompt) as unknown[];
      expect(JSON.stringify((withoutCacheMarkers(calls[2].prompt) as unknown[]).slice(0, turn1.length))).toBe(JSON.stringify(turn1));
      const stored = events.find((e) => e.type === "agent.mcp_tool_result" && e.mcp_tool_use_id === "toolu_1");
      expect(stored?.content).toBe("Issue SENTRY-1: TypeError");
      expect(events.find((e) => e.type === "agent.mcp_tool_use")).toMatchObject({ mcp_server_name: "sentry" });
    });
  }

  it("a deferred tool via call_mcp_tool replays byte for byte too (agent.tool_result)", async () => {
    const binding = servers((name) => ({ content: [{ type: "text", text: `${name} done` }] }));
    const { calls, events } = await runScripted({
      provider: "anthropic.messages", modelId: "claude-opus-5-5", binding, agent: agentConfig(), turns: 2,
      script: [
        toolCall("toolu_c", CALL_TOOL_NAME, { name: "mcp__notion__create_page", arguments: { field_0: "x" } }),
        text("created"),
        text("ok"),
      ],
    });
    expect(binding.calls).toEqual([{ server: "notion", name: "create_page", args: { field_0: "x" } }]);
    const inTurn = toolResultIn(calls[1].prompt, "toolu_c");
    expect(inTurn?.output).toEqual({ type: "text", value: "create_page done" });
    expect(JSON.stringify(toolResultIn(calls[2].prompt, "toolu_c")?.output)).toBe(JSON.stringify(inTurn?.output));
    expect(events.find((e) => e.type === "agent.tool_result" && e.tool_use_id === "toolu_c")?.content).toBe("create_page done");
  });

  it("old events (raw JSON envelope) stay readable and replay unchanged", () => {
    const legacy = JSON.stringify({ content: [{ type: "text", text: "old" }], isError: false });
    const msgs = eventsToMessages([
      { type: "user.message", content: [{ type: "text", text: "hi" }] },
      { type: "agent.mcp_tool_use", id: "c_old", name: "mcp__sentry__get_issue", input: {}, mcp_server_name: "sentry" },
      { type: "agent.mcp_tool_result", mcp_tool_use_id: "c_old", content: legacy },
    ] as never);
    expect(toolResultIn(msgs, "c_old")?.output).toEqual({ type: "text", value: legacy });
  });
});

describe("deferred MCP tools stay behind the permission gates", () => {
  it("a denied tool is unreachable: not searchable, call_mcp_tool can't run it, an approval can't resurrect it", async () => {
    const binding = servers();
    const agent = agentConfig({
      effective_policy: { rules: [{ selector: "mcp__notion__delete_page", effect: "deny" }] },
    } as Partial<AgentConfig>);
    const built = (await build(agent, binding)) as ToolSet;
    expect(built).not.toHaveProperty("mcp__notion__delete_page");
    const { tools, deferred } = applyAgentToolBudget(built, agent);
    expect(deferred.has("mcp__notion__create_page")).toBe(true);
    expect(deferred.has("mcp__notion__delete_page")).toBe(false);

    const search = JSON.parse(await (tools[SEARCH_TOOL_NAME] as any).execute({ query: "delete page", limit: 40 }, {}));
    expect(search.map((r: { name: string }) => r.name)).not.toContain("mcp__notion__delete_page");
    const out = await (tools[CALL_TOOL_NAME] as any).execute({ name: "mcp__notion__delete_page", arguments: { field_0: "x" } }, {});
    expect(out).toMatch(/Unknown deferred tool/);

    const lifted = (await build(withAskGatesLifted(agent), binding)) as Record<string, unknown>;
    expect(resolveConfirmedToolCall(lifted, CALL_TOOL_NAME, { name: "mcp__notion__delete_page", arguments: {} }).tool).toBeUndefined();
    expect(binding.calls).toEqual([]);
    await releaseTools(built);
    await releaseTools(lifted);
  });

  it("an ask-gated deferred tool parks in the harness and runs only after approval", async () => {
    const binding = servers((name, args) => ({ content: [{ type: "text", text: `${name} ${JSON.stringify(args)}` }] }));
    const agent = agentConfig({
      tools: [
        { type: "agent_toolset_20260401" },
        { type: "mcp_toolset", mcp_server_name: "notion", default_config: { permission_policy: { type: "always_ask" } } },
      ] as never,
    });
    const { events, runtimes } = await runScripted({
      provider: "anthropic.messages", modelId: "claude-opus-5-5", binding, agent, turns: 1,
      script: [toolCall("toolu_ask", CALL_TOOL_NAME, { name: "mcp__notion__create_page", arguments: { field_0: "Plan" } })],
    });
    const use = events.find((e) => e.id === "toolu_ask");
    expect(use).toMatchObject({ type: "agent.tool_use", name: CALL_TOOL_NAME, evaluated_permission: "ask" });
    expect(runtimes[0].pendingConfirmations).toEqual(["toolu_ask"]);
    expect(events.some((e) => e.type === "agent.tool_result" && e.tool_use_id === "toolu_ask")).toBe(false);
    expect(binding.calls).toEqual([]);

    // Approval (session-runtime machine.applyClientToolResult): rebuild with
    // ask gates lifted, run the TARGET with its arguments.
    const lifted = (await build(withAskGatesLifted(agent), binding)) as Record<string, any>;
    const target = resolveConfirmedToolCall(lifted, use!.name, use!.input);
    expect(target.name).toBe("mcp__notion__create_page");
    const result = await target.tool.execute(target.input, { toolCallId: "toolu_ask", messages: [] });
    expect(result).toBe('create_page {"field_0":"Plan"}');
    expect(binding.calls).toEqual([{ server: "notion", name: "create_page", args: { field_0: "Plan" } }]);
    await releaseTools(lifted);
  });
});

describe("deferred MCP calls keep their target's crash-recovery class", () => {
  // Deferred (~50k tokens) server with one read-only tool, as Notion's search is.
  const notionOnly = agentConfig({ mcp_servers: [{ name: "notion", type: "url", url: "https://mcp.notion.test/mcp" }] } as Partial<AgentConfig>);
  const readOnlyServers = (call?: (name: string, args: Record<string, unknown>) => unknown) =>
    fakeMcpBinding({
      notion: {
        tools: [
          { ...syntheticMcpTool("search", 1250), annotations: { readOnlyHint: true } },
          ...Array.from({ length: 39 }, (_, i) => syntheticMcpTool(i === 0 ? "create_page" : `op_${i}`, 1250)),
        ],
        call,
      },
    });

  it("call_mcp_tool is stamped by its target's annotations: a deferred read is idempotent, a write side_effect", async () => {
    const binding = readOnlyServers();
    const { events } = await runScripted({
      provider: "anthropic.messages", modelId: "claude-opus-5-5", binding, agent: notionOnly, turns: 1,
      script: [
        toolCall("toolu_read", CALL_TOOL_NAME, { name: "mcp__notion__search", arguments: { field_0: "roadmap" } }),
        toolCall("toolu_write", CALL_TOOL_NAME, { name: "mcp__notion__create_page", arguments: { field_0: "x" } }),
      ],
    });
    expect(events.find((e) => e.id === "toolu_read")).toMatchObject({ type: "agent.tool_use", execution_class: "idempotent" });
    expect(events.find((e) => e.id === "toolu_write")).toMatchObject({ type: "agent.tool_use", execution_class: "side_effect" });
  });

  it("an interrupted idempotent call_mcp_tool is re-run through its target on the next turn", async () => {
    const binding = readOnlyServers((name, args) => ({ content: [{ type: "text", text: `${name} found ${String(args.field_0)}` }] }));
    const interrupted: Array<Record<string, any>> = [
      { type: "user.message", content: [{ type: "text", text: "find the roadmap" }] },
      {
        type: "agent.tool_use",
        id: "toolu_orphan",
        name: CALL_TOOL_NAME,
        input: { name: "mcp__notion__search", arguments: { field_0: "roadmap" } },
        execution_class: "idempotent",
        idempotency_key: "sess_mcp:toolu_orphan",
      },
    ];
    const { events } = await runScripted({
      provider: "anthropic.messages", modelId: "claude-opus-5-5", binding, agent: notionOnly, turns: 1,
      resume: interrupted, script: [text("found it")],
    });
    expect(binding.calls).toEqual([{ server: "notion", name: "search", args: { field_0: "roadmap" } }]);
    expect(events.find((e) => e.type === "agent.tool_result" && e.tool_use_id === "toolu_orphan")).toMatchObject({
      content: "search found roadmap",
    });
    expect(events.find((e) => e.type === "session.warning" && e.source === "tool_call_recovered")?.details).toMatchObject({
      reexecuted: ["toolu_orphan"],
      injected: [],
    });
  });
});
