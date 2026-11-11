// Measurement: estimated tool-definition tokens per model request, before
// and after the size budget, for a realistic agent — the real built-ins
// from buildTools() plus a ~50k-token MCP server (Notion-sized, the prod
// case) and a small one, through the real @ai-sdk/mcp client.
//
//   pnpm --filter @open-managed-agents/main-node exec vitest run test/tool-budget-measure.test.ts
//
// prints the table; the assertions pin the shape so a regression shows.

import { describe, expect, it } from "vitest";
import type { ToolSet } from "ai";
import { releaseTools, type AgentConfig } from "@open-managed-agents/shared";
import { buildTools } from "@open-managed-agents/agent/harness/tools";
import {
  DEFAULT_MCP_TOOL_TOKEN_BUDGET,
  applyAgentToolBudget,
  estimateToolSetTokens,
} from "@open-managed-agents/agent/harness/tool-budget";
import { fakeMcpBinding, syntheticMcpTool } from "./_helpers/fake-mcp";

const sandbox = { exec: async () => "", readFile: async () => "", writeFile: async () => "" } as never;
const hooks = {
  scheduleWakeup: async () => ({}) as never,
  cancelWakeup: async () => ({}) as never,
  listWakeups: async () => [],
  createAmbientRule: async () => ({}) as never,
  listAmbientRules: async () => [],
  deleteAmbientRule: async () => ({ deleted: true }),
  requestServiceAccess: async () => ({}) as never,
  findSkills: async () => [],
  requestSkill: async () => ({}) as never,
};

describe("tool-definition tokens per request (measurement)", () => {
  it("17 built-ins + a ~50k-token MCP server + a small one", async () => {
    const binding = fakeMcpBinding({
      notion: { tools: Array.from({ length: 40 }, (_, i) => syntheticMcpTool(`notion_op_${i}`, 1250)) },
      sentry: {
        tools: Array.from({ length: 4 }, (_, i) => syntheticMcpTool(`sentry_op_${i}`, 350)),
      },
    });
    const agent = {
      id: "agent_measure",
      name: "measure",
      model: "gpt-6.1-sol",
      system: "",
      tools: [{ type: "agent_toolset_20260401" }],
      mcp_servers: [
        { name: "notion", type: "url", url: "https://mcp.notion.test/mcp" },
        { name: "sentry", type: "url", url: "https://mcp.sentry.test/mcp" },
      ],
      version: 1,
      created_at: "2026-11-10T00:00:00Z",
    } as AgentConfig;
    const tools = (await buildTools(agent, sandbox, {
      ...hooks,
      mcpBinding: binding,
      tenantId: "tn_measure",
      sessionId: "sess_measure",
    } as never)) as ToolSet;

    const builtinNames = Object.keys(tools).filter((n) => !n.startsWith("mcp__"));
    const of = (pred: (n: string) => boolean, set: ToolSet) =>
      estimateToolSetTokens(Object.fromEntries(Object.entries(set).filter(([n]) => pred(n))) as ToolSet);
    const before = estimateToolSetTokens(tools);
    const budget = applyAgentToolBudget(tools, agent);
    const after = estimateToolSetTokens(budget.tools);
    const rows = [
      ["built-ins", builtinNames.length, of((n) => !n.startsWith("mcp__"), tools), of((n) => !n.startsWith("mcp__") && !n.endsWith("_mcp_tools") && n !== "call_mcp_tool", budget.tools)],
      ["mcp notion", 40, of((n) => n.startsWith("mcp__notion__"), tools), of((n) => n.startsWith("mcp__notion__"), budget.tools)],
      ["mcp sentry", 4, of((n) => n.startsWith("mcp__sentry__"), tools), of((n) => n.startsWith("mcp__sentry__"), budget.tools)],
      ["search/call meta", 2, 0, of((n) => n === "search_mcp_tools" || n === "call_mcp_tool", budget.tools)],
      ["total", Object.keys(tools).length, before, after],
    ] as const;
    console.log(
      "\nestimated tool-definition tokens per model request (chars/4)\n" +
        rows.map(([k, n, b, a]) => `  ${String(k).padEnd(18)} ${String(n).padStart(3)} tools  before ${String(b).padStart(6)}  after ${String(a).padStart(6)}`).join("\n") +
        `\n  deferred: ${JSON.stringify(budget.deferredByServer)}  (budget ${DEFAULT_MCP_TOOL_TOKEN_BUDGET})\n`,
    );

    expect(builtinNames).toHaveLength(17);
    expect(budget.deferredByServer).toEqual({ notion: 40 });
    expect(before).toBeGreaterThan(50_000);
    expect(after).toBeLessThan(before / 5);
    await releaseTools(tools);
  });
});
