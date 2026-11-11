import { describe, expect, it, vi } from "vitest";
import { jsonSchema, tool, type ToolSet } from "ai";
import { z } from "zod";
import {
  applyAgentToolBudget,
  applyToolBudget,
  estimateToolTokens,
  mcpServerOf,
  toolBudgetWarning,
  CALL_TOOL_NAME,
  DEFAULT_MCP_TOOL_TOKEN_BUDGET,
  DEFAULT_SEARCH_LIMIT,
  SEARCH_TOOL_NAME,
} from "@open-managed-agents/agent/harness/tool-budget";
import { reasoningProviderOptions } from "@open-managed-agents/agent/harness/provider";

// Two limits decide which MCP definitions ride every request:
//   - count: OpenAI accepts at most 128 tools. 6 MCP servers → 224 → 400
//     every turn (2026-09-02).
//   - size (every provider): prod sent ~63k input tokens on a trivial
//     gpt-6.1-sol turn, ~59k of them one server's (Notion) schemas.
// Whole servers that don't fit are deferred behind search/call meta tools.

function mk(desc: string, fn: (a: Record<string, unknown>) => unknown = (a) => ({ ok: true, a })) {
  return tool({ description: desc, inputSchema: z.object({ q: z.string().optional() }), execute: async (a) => fn(a) });
}
function server(name: string, n: number, descPrefix = name) {
  const out: Record<string, ReturnType<typeof mk>> = {};
  for (let i = 0; i < n; i++) out[`mcp__${name}__tool_${i}`] = mk(`${descPrefix} tool number ${i}`);
  return out;
}
/** MCP-shaped tool (jsonSchema wrapper, like @ai-sdk/mcp) of ~`tokens` tokens. */
function bigTool(name: string, tokens: number, execute?: (a: unknown) => unknown) {
  const desc = "x".repeat(Math.max(0, tokens * 4 - 80));
  return tool({
    description: `${name}: ${desc}`,
    inputSchema: jsonSchema({ type: "object", properties: { id: { type: "string" } } }),
    ...(execute ? { execute: async (a: unknown) => execute(a) } : {}),
  } as never);
}
function bigServer(name: string, n: number, tokensEach: number) {
  const out: ToolSet = {};
  for (let i = 0; i < n; i++) out[`mcp__${name}__op_${i}`] = bigTool(`${name} op ${i}`, tokensEach, () => `${name} op ${i} ran`);
  return out;
}
const builtins = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`builtin_${i}`, mk("b")]));

describe("applyToolBudget — count cap", () => {
  it("is a no-op within budget", () => {
    const tools = { bash: mk("shell"), ...server("sentry", 9) };
    const r = applyToolBudget(tools, { maxTools: 128 });
    expect(r.tools).toBe(tools);
    expect(r.deferred.size).toBe(0);
    expect(r.reasons).toEqual([]);
  });

  it("keeps built-ins and whole servers in harness order, defers the rest behind two meta tools", () => {
    const tools = {
      ...builtins(23),
      ...server("github", 44),
      ...server("linear", 57),
      ...server("notion", 41),
      ...server("railway", 42),
      ...server("sentry", 9),
      ...server("slack", 8),
    };
    expect(Object.keys(tools)).toHaveLength(224);
    const r = applyToolBudget(tools, {
      maxTools: 128,
      // ~55 tokens each: the servers that make the count cut also fit
      // the size budget, so the split is the count cap's.
      serverOrder: ["sentry", "linear", "slack", "github", "railway", "notion"],
    });
    const names = Object.keys(r.tools);
    expect(names.length).toBeLessThanOrEqual(128);
    // harness order: sentry(9) + linear(57) + slack(8) + github(44) = 118 + 23 builtins = 141 > 126 → github deferred;
    // railway(42) also doesn't fit; notion(41) doesn't fit either.
    expect(names.filter((n) => n.startsWith("mcp__sentry__"))).toHaveLength(9);
    expect(names.filter((n) => n.startsWith("mcp__linear__"))).toHaveLength(57);
    expect(names.filter((n) => n.startsWith("mcp__slack__"))).toHaveLength(8);
    expect(names.filter((n) => n.startsWith("mcp__github__"))).toHaveLength(0);
    expect(names.filter((n) => n.startsWith("builtin_"))).toHaveLength(23);
    expect(names).toContain(SEARCH_TOOL_NAME);
    expect(names).toContain(CALL_TOOL_NAME);
    expect(r.deferredByServer).toEqual({ github: 44, railway: 42, notion: 41 });
    expect(r.deferred.size).toBe(127);
    // 201 definitions are also over the size budget in total.
    expect(r.reasons).toEqual(["tool_count", "token_budget"]);
  });

  it("search finds deferred tools by keyword and call executes them", async () => {
    const tools = {
      ...Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`b${i}`, mk("b")])),
      mcp__github__create_pull_request: mk("Open a pull request"),
      mcp__github__list_repos: mk("List repositories"),
      mcp__linear__create_issue: mk("Create a Linear issue", (a) => `issue created with ${JSON.stringify(a)}`),
      mcp__linear__list_issues: mk("List Linear issues"),
      mcp__linear__update_issue: mk("Update a Linear issue"),
    };
    // 10 tools, budget 9 → 7 direct slots: builtins(5) + github(2) fit, linear(3) is deferred.
    const r = applyToolBudget(tools, { maxTools: 9, serverOrder: ["github", "linear"] });
    expect(r.deferredByServer).toEqual({ linear: 3 });
    expect(Object.keys(r.tools)).toHaveLength(9);
    const search = r.tools[SEARCH_TOOL_NAME] as { execute: (a: unknown, o: unknown) => Promise<string> };
    const found = JSON.parse(await search.execute({ query: "create issue" }, {})) as Array<{ name: string; server: string }>;
    expect(found[0].name).toBe("mcp__linear__create_issue");
    expect(found[0].server).toBe("linear");
    const call = r.tools[CALL_TOOL_NAME] as { execute: (a: unknown, o: unknown) => Promise<string> };
    expect(await call.execute({ name: "mcp__linear__create_issue", arguments: { q: "x" } }, {})).toContain("issue created");
    expect(await call.execute({ name: "mcp__nope__x" }, {})).toContain("Unknown deferred tool");
    expect(await search.execute({ query: "zzzz-nothing" }, {})).toContain("No deferred tools matched");
  });

  it("parses server names from tool names", () => {
    expect(mcpServerOf("mcp__linear__create_issue")).toBe("linear");
    expect(mcpServerOf("bash")).toBeNull();
  });
});

describe("applyToolBudget — size budget (every provider)", () => {
  it("estimates a definition as serialized chars / 4", () => {
    const t = bigTool("x", 500);
    const tokens = estimateToolTokens("mcp__s__x", t);
    expect(tokens).toBeGreaterThan(480);
    expect(tokens).toBeLessThan(520);
    expect(estimateToolTokens("mcp__s__x", t)).toBe(tokens);
  });

  it("defers a server whose definitions exceed the token budget, without any count cap", () => {
    // ~50k-token server declared first, ~1.5k-token server second.
    const tools = { ...builtins(17), ...bigServer("notion", 40, 1250), ...bigServer("sentry", 3, 500) };
    const r = applyToolBudget(tools, { serverOrder: ["notion", "sentry"] });
    expect(r.reasons).toEqual(["token_budget"]);
    expect(r.deferredByServer).toEqual({ notion: 40 });
    const names = Object.keys(r.tools);
    // Later, smaller servers still load directly.
    expect(names.filter((n) => n.startsWith("mcp__sentry__"))).toHaveLength(3);
    expect(names.filter((n) => n.startsWith("builtin_"))).toHaveLength(17);
    expect(names).toEqual(expect.arrayContaining([SEARCH_TOOL_NAME, CALL_TOOL_NAME]));
    expect(r.mcpTokens.total).toBeGreaterThan(50_000);
    expect(r.mcpTokens.direct).toBeLessThanOrEqual(DEFAULT_MCP_TOOL_TOKEN_BUDGET);
    expect(r.mcpTokens.byServer.notion).toBeGreaterThan(49_000);
  });

  it("keeps whole servers in declared order while they fit, then skips to smaller ones", () => {
    const tools = { ...bigServer("a", 4, 1500), ...bigServer("b", 4, 1500), ...bigServer("c", 1, 500) };
    // a = 6k fits; b = 6k would make 12k > 8k → deferred; c = 0.5k still fits.
    const r = applyToolBudget(tools, { serverOrder: ["a", "b", "c"] });
    expect(r.deferredByServer).toEqual({ b: 4 });
  });

  it("is a no-op (same object) when MCP definitions fit the budget", () => {
    const tools = { ...builtins(17), ...bigServer("sentry", 3, 500) };
    expect(applyToolBudget(tools).tools).toBe(tools);
  });

  it("eager never defers for size; deferred defers every server; both keep the count cap", () => {
    const tools = { ...builtins(3), ...bigServer("notion", 40, 1250), ...bigServer("sentry", 2, 100) };
    const eager = applyToolBudget(tools, { mode: "eager", serverOrder: ["notion", "sentry"] });
    expect(eager.tools).toBe(tools);
    const eagerCapped = applyToolBudget(tools, { mode: "eager", maxTools: 30, serverOrder: ["notion", "sentry"] });
    expect(eagerCapped.deferredByServer).toEqual({ notion: 40 });
    expect(eagerCapped.reasons).toEqual(["tool_count"]);

    const small = { ...builtins(3), ...bigServer("sentry", 2, 100) };
    const deferred = applyToolBudget(small, { mode: "deferred" });
    expect(deferred.deferredByServer).toEqual({ sentry: 2 });
    expect(deferred.reasons).toEqual(["mode_deferred"]);
    expect(Object.keys(deferred.tools)).toEqual(["builtin_0", "builtin_1", "builtin_2", SEARCH_TOOL_NAME, CALL_TOOL_NAME]);
    // No MCP tools → nothing to defer, whatever the mode.
    expect(applyToolBudget(builtins(3), { mode: "deferred" }).deferred.size).toBe(0);
  });

  it("applyAgentToolBudget reads _oma.mcp_tool_loading and the declared server order", () => {
    const tools = { ...bigServer("a", 1, 100), ...bigServer("b", 1, 100) };
    const agent = (mode?: "auto" | "eager" | "deferred") => ({
      mcp_tool_loading: mode,
      mcp_servers: [{ name: "b", type: "url" }, { name: "a", type: "url" }],
    });
    expect(applyAgentToolBudget(tools, agent()).deferred.size).toBe(0);
    expect(applyAgentToolBudget(tools, agent("deferred")).deferredByServer).toEqual({ b: 1, a: 1 });
    // Unknown values fall back to auto.
    expect(applyAgentToolBudget(tools, agent("bogus" as never)).deferred.size).toBe(0);
  });

  it("is deterministic: equal tool lists give the same split and byte-identical meta tools every turn", async () => {
    const build = () => ({ ...builtins(17), ...bigServer("notion", 40, 1250), ...bigServer("sentry", 3, 500) });
    const serialize = async (r: ReturnType<typeof applyToolBudget>) =>
      JSON.stringify(
        await Promise.all(
          Object.entries(r.tools).map(async ([name, t]) => [
            name,
            (t as { description?: string }).description,
            await (await import("ai")).asSchema((t as { inputSchema: never }).inputSchema).jsonSchema,
          ]),
        ),
      );
    const turn1 = applyToolBudget(build(), { serverOrder: ["notion", "sentry"] });
    const turn2 = applyToolBudget(build(), { serverOrder: ["notion", "sentry"] });
    expect(await serialize(turn1)).toBe(await serialize(turn2));
  });

  it("search returns at most 5 results unless the model asks for more", async () => {
    const r = applyToolBudget({ ...bigServer("notion", 12, 1000) });
    const search = r.tools[SEARCH_TOOL_NAME] as { execute: (a: unknown, o: unknown) => Promise<string> };
    expect(DEFAULT_SEARCH_LIMIT).toBe(5);
    expect(JSON.parse(await search.execute({ query: "notion op" }, {}))).toHaveLength(5);
    expect(JSON.parse(await search.execute({ query: "notion op", limit: 9 }, {}))).toHaveLength(9);
  });

  it("warns once per session and split, naming the deferred servers", () => {
    const r = applyToolBudget({ ...bigServer("notion", 40, 1250) });
    const w = toolBudgetWarning(r, "sess-warn") as { type: string; source: string; message: string; details: Record<string, unknown> };
    expect(w).toMatchObject({ type: "session.warning", source: "tool_budget" });
    expect(w.message).toMatch(/Deferred MCP servers notion \(40 tools, ~50\.\dk tokens\)/);
    expect(w.message).toContain(SEARCH_TOOL_NAME);
    expect(w.details).toMatchObject({ deferred_servers: { notion: 40 }, reasons: ["token_budget"] });
    expect(toolBudgetWarning(r, "sess-warn")).toBeNull();
    expect(toolBudgetWarning(r, "sess-other")).not.toBeNull();
    expect(toolBudgetWarning(applyToolBudget(builtins(2)), "sess-none")).toBeNull();
  });
});

// A Notion-shaped deferred server: generic words ("page") sit in many tool
// names, and the definitions that matter carry long usage rules.
const CREATE_PAGES_RULES =
  "Creates one or more Notion pages with the specified properties and content. " +
  "Content uses Notion-flavored markdown: callouts are <callout icon=…>, toggles are <details>, no raw HTML. " +
  "When the parent is a data source, set parent.data_source_id and pass properties that match its schema. " +
  "Property formats: title and text properties are strings; number properties are numbers; checkboxes are \"__YES__\" / \"__NO__\". " +
  "Date properties are expanded into three keys: \"date:<Property>:start\", \"date:<Property>:end\" and \"date:<Property>:is_datetime\" — " +
  "e.g. \"date:Due Date:start\": \"2026-11-12\", \"date:Due Date:is_datetime\": 0. A plain \"Due Date\": \"2026-11-12\" is rejected.";
const NOTION_TOOLS: Record<string, string> = {
  "notion-search": "Search the Notion workspace and connected sources for pages, databases and their content.",
  "notion-fetch": "Retrieve a Notion page or database by URL or ID and return its full content as Notion-flavored markdown.",
  "notion-create-pages": CREATE_PAGES_RULES,
  "notion-update-page": "Update a page's properties or content.",
  "notion-move-pages": "Move pages to a new parent.",
  "notion-duplicate-page": "Duplicate a page.",
  "notion-delete-pages": "Move pages to the trash.",
  "notion-restore-pages": "Restore pages from the trash.",
  "notion-list-private-pages": "List the user's private pages.",
  "notion-list-recent-pages": "List recently visited pages.",
  "notion-create-database": "Create a database with a schema.",
  "notion-update-data-source": "Update a data source's schema.",
  "notion-query-data-sources": "Query rows of one or more data sources with filters.",
  "notion-create-comment": "Add a comment to a page.",
  "notion-get-comments": "List the comments on a page.",
  "notion-get-users": "List workspace users.",
  "notion-get-teams": "List teamspaces.",
  "notion-get-self": "Who the integration is.",
};
function notionServer(): ToolSet {
  const out: ToolSet = {};
  for (const [name, desc] of Object.entries(NOTION_TOOLS)) {
    out[`mcp__notion__${name}`] = tool({
      description: desc,
      inputSchema: jsonSchema({ type: "object", properties: { id: { type: "string" } } }),
      execute: async () => `${name} ran`,
    } as never);
  }
  return out;
}
type Hit = { name: string; description: string };
async function searchNotion(args: Record<string, unknown>) {
  const r = applyToolBudget({ ...builtins(3), ...notionServer() }, { mode: "deferred" });
  const search = r.tools[SEARCH_TOOL_NAME] as { description: string; execute: (a: unknown, o: unknown) => Promise<string> };
  return { r, search, out: await search.execute(args, {}) };
}
const hitNames = (out: string) => (JSON.parse(out) as Hit[]).map((h) => h.name.replace("mcp__notion__", ""));

describe("search_mcp_tools — finding the right deferred tool", () => {
  it("lists every deferred tool name in its own description (stable across turns)", async () => {
    const { search } = await searchNotion({ query: "x" });
    expect(search.description).toContain("notion: notion-search, notion-fetch, notion-create-pages");
    expect(search.description).toContain("notion-get-self");
    expect(search.description).toMatch(/exact name to get its FULL description/);
    const again = applyToolBudget({ ...builtins(3), ...notionServer() }, { mode: "deferred" });
    expect((again.tools[SEARCH_TOOL_NAME] as { description: string }).description).toBe(search.description);
  });

  it("caps the name list in the description and says how many are left out", () => {
    const many: ToolSet = {};
    for (let i = 0; i < 400; i++) many[`mcp__composio__COMPOSIO_TOOLKIT_ACTION_NUMBER_${i}`] = mk("x");
    const r = applyToolBudget(many, { mode: "deferred" });
    const d = (r.tools[SEARCH_TOOL_NAME] as { description: string }).description;
    expect(d.length).toBeLessThan(5_000);
    expect(d).toMatch(/\(\+\d+ more — search by keyword\)/);
  });

  it("an exact tool name returns its full description — the usage rules survive deferral", async () => {
    for (const query of ["mcp__notion__notion-create-pages", "notion-create-pages", " Notion-Create-Pages "]) {
      const { out } = await searchNotion({ query });
      const hits = JSON.parse(out) as Hit[];
      expect(hits).toHaveLength(1);
      expect(hits[0].name).toBe("mcp__notion__notion-create-pages");
      expect(hits[0].description).toBe(CREATE_PAGES_RULES);
      expect(hits[0].description).toContain("date:Due Date:start");
    }
  });

  it("keyword hits are cut at 400 chars and say how to get the rest; a single hit is whole", async () => {
    const { out } = await searchNotion({ query: "create", limit: 5 });
    const cut = (JSON.parse(out) as Hit[]).find((h) => h.name === "mcp__notion__notion-create-pages")!;
    expect(cut.description).not.toContain("date:Due Date:start");
    expect(cut.description).toContain('truncated — search "mcp__notion__notion-create-pages" for the full description');
    const single = JSON.parse((await searchNotion({ query: "create pages", limit: 1 })).out) as Hit[];
    expect(single.map((h) => h.description)).toEqual([CREATE_PAGES_RULES]);
  });

  it("a miss names the deferred tools instead of only the server", async () => {
    const { out } = await searchNotion({ query: "roadmap" });
    expect(out).toMatch(/No deferred tools matched "roadmap"/);
    expect(out).toContain("notion-fetch");
    expect(out).toContain("notion-search");
    const scoped = (await searchNotion({ query: "roadmap", server: "notion" })).out;
    expect(scoped).toContain("notion-fetch");
  });

  it("server names and stopwords don't score; name words beat description words", async () => {
    // "notion" is in every bare name and "the"/"find" in many descriptions.
    expect(hitNames((await searchNotion({ query: "find the notion search" })).out)[0]).toBe("notion-search");
    expect(hitNames((await searchNotion({ query: "fetch" })).out)).toEqual(["notion-fetch"]);
    // Whole word in the name (comments) ranks above a description mention.
    expect(hitNames((await searchNotion({ query: "comments" })).out).slice(0, 2)).toEqual([
      "notion-get-comments",
      "notion-create-comment",
    ]);
    // "query" names a tool; it is not dropped as filler.
    expect(hitNames((await searchNotion({ query: "query data sources" })).out)[0]).toBe("notion-query-data-sources");
  });
});

describe("promptCacheKey", () => {
  const model = (provider: string, modelId: string) => ({ provider, modelId, specificationVersion: "v3" }) as never;
  it("is set per agent on the OpenAI Responses path only", () => {
    const oai = reasoningProviderOptions(model("openai.responses", "gpt-6.1-sol"), "gpt-6.1-sol", undefined, true, {
      promptCacheKey: "agent_123",
    });
    expect(oai).toMatchObject({ openai: { promptCacheKey: "agent_123" } });
    expect((oai as { openai: Record<string, unknown> }).openai).not.toHaveProperty("promptCacheRetention");
    // chat/completions (gateways) and Anthropic never get it.
    const chat = reasoningProviderOptions(model("openai.chat", "gpt-6.1-sol"), "gpt-6.1-sol", undefined, true, {
      promptCacheKey: "agent_123",
    });
    expect(JSON.stringify(chat ?? {})).not.toContain("promptCacheKey");
    const ant = reasoningProviderOptions(model("anthropic.messages", "claude-opus-5-5"), "claude-opus-5-5", undefined, true, {
      promptCacheKey: "agent_123",
    });
    expect(JSON.stringify(ant ?? {})).not.toContain("promptCacheKey");
    // No key passed → unchanged shape.
    expect(reasoningProviderOptions(model("openai.responses", "gpt-6.1-sol"), "gpt-6.1-sol", undefined, true)).toEqual({
      openai: { reasoningEffort: "medium", forceReasoning: true, store: false },
    });
  });
});

// ── DefaultHarness end to end ─────────────────────────────────────────

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const finish = (unified: string) => ({ type: "finish", finishReason: { unified, raw: unified }, usage });
const stream = (parts: unknown[]) => new ReadableStream({ start(c) { parts.forEach((p) => c.enqueue(p)); c.close(); } });
const textReply = (text: string) => [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: text },
  { type: "text-end", id: "t1" },
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

async function runTurns(provider: string, modelId: string, turns: number, sessionId: string) {
  const { MockLanguageModelV3 } = await import("ai/test");
  const { DefaultHarness } = await import("@open-managed-agents/agent/harness/default-loop");
  const model = new MockLanguageModelV3({
    provider,
    modelId,
    doStream: async () => ({ stream: stream(textReply("hi")) }) as never,
  });
  const tools = () => ({ ...builtins(17), ...bigServer("notion", 40, 1250), ...bigServer("sentry", 3, 500) });
  const events: Array<Record<string, any>> = [];
  for (let i = 0; i < turns; i++) {
    const userMessage = { type: "user.message", content: [{ type: "text", text: `turn ${i}` }] };
    events.push(userMessage);
    await new DefaultHarness().run({
      agent: {
        id: "agent_budget",
        model: modelId,
        tools: [],
        mcp_servers: [{ name: "notion", type: "url", url: "https://mcp.notion.test" }, { name: "sentry", type: "url", url: "https://mcp.sentry.test" }],
      },
      model, systemPrompt: "Test", env: {}, session_id: sessionId,
      userMessage,
      tools: tools(), runtime: harnessRuntime(events),
    } as never);
  }
  return { calls: model.doStreamCalls, events };
}

describe("DefaultHarness applies the size budget for every provider", () => {
  for (const [provider, modelId] of [["openai.responses", "gpt-6.1-sol"], ["anthropic.messages", "claude-opus-5-5"]] as const) {
    it(`${provider}: the large server is deferred, the small one stays, the split is stable across turns`, async () => {
      const { calls, events } = await runTurns(provider, modelId, 2, `sess-${provider}`);
      expect(calls).toHaveLength(2);
      const names = (calls[0].tools ?? []).map((t) => (t as { name: string }).name);
      expect(names.some((n) => n.startsWith("mcp__notion__"))).toBe(false);
      expect(names.filter((n) => n.startsWith("mcp__sentry__"))).toHaveLength(3);
      expect(names).toEqual(expect.arrayContaining([SEARCH_TOOL_NAME, CALL_TOOL_NAME]));
      // Byte-identical tool block on the next turn (prefix-cache stable).
      expect(JSON.stringify(calls[1].tools)).toBe(JSON.stringify(calls[0].tools));
      // One warning naming the deferred server, not one per turn.
      const warnings = events.filter((e) => e.type === "session.warning" && e.source === "tool_budget");
      expect(warnings).toHaveLength(1);
      expect(warnings[0].message).toMatch(/notion \(40 tools/);

      const openai = (calls[0].providerOptions as Record<string, any> | undefined)?.openai;
      if (provider.startsWith("openai")) {
        expect(openai?.promptCacheKey).toBe("agent_budget");
      } else {
        expect(openai).toBeUndefined();
        // Anthropic's tool breakpoint lands on the last tool actually sent.
        const last = calls[0].tools!.at(-1) as { name: string; providerOptions?: Record<string, any> };
        expect(last.name).toBe(CALL_TOOL_NAME);
        expect(last.providerOptions?.anthropic?.cacheControl).toEqual({ type: "ephemeral" });
      }
    });
  }
});
