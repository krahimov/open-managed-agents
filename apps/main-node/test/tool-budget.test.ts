import { describe, expect, it } from "vitest";
import { tool } from "ai";
import { z } from "zod";
import {
  applyToolBudget,
  mcpServerOf,
  CALL_TOOL_NAME,
  SEARCH_TOOL_NAME,
} from "@open-managed-agents/agent/harness/tool-budget";

// OpenAI: max 128 tools per request. 6 MCP servers → 224 → 400 every turn
// (2026-09-02). Budget keeps built-ins + whole servers, defers the rest
// behind search/call meta tools.

function mk(desc: string, fn: (a: Record<string, unknown>) => unknown = (a) => ({ ok: true, a })) {
  return tool({ description: desc, inputSchema: z.object({ q: z.string().optional() }), execute: async (a) => fn(a) });
}
function server(name: string, n: number, descPrefix = name) {
  const out: Record<string, ReturnType<typeof mk>> = {};
  for (let i = 0; i < n; i++) out[`mcp__${name}__tool_${i}`] = mk(`${descPrefix} tool number ${i}`);
  return out;
}

describe("applyToolBudget", () => {
  it("is a no-op within budget", () => {
    const tools = { bash: mk("shell"), ...server("sentry", 9) };
    const r = applyToolBudget(tools, { maxTools: 128 });
    expect(r.tools).toBe(tools);
    expect(r.deferred.size).toBe(0);
  });

  it("keeps built-ins and whole servers in harness order, defers the rest behind two meta tools", () => {
    const builtins = Object.fromEntries(Array.from({ length: 23 }, (_, i) => [`builtin_${i}`, mk("b")]));
    const tools = {
      ...builtins,
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
