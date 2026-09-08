// Provider tool budget — OpenAI rejects requests carrying more than 128
// tool definitions ("Invalid 'tools': array too long", 400). An agent with
// six MCP servers easily exceeds that (seen live 2026-09-02: 201 MCP tools
// + built-ins = 224 → every turn failed with harness_turn_failed).
//
// Strategy (deterministic, capability-preserving):
//   1. Non-MCP tools (built-ins, platform tools, call_agent_*) always stay.
//   2. MCP servers are kept WHOLE, in harness order, while they fit.
//   3. Servers that don't fit are "deferred": their tools leave the array
//      and become reachable through two meta tools — `search_mcp_tools`
//      (find by keyword, returns names + input schemas) and `call_mcp_tool`
//      (invoke a deferred tool by full name). Same idea as Claude Code's
//      deferred ToolSearch / Anthropic's tool-search: the model can still
//      do everything, it just discovers the long tail on demand.
//
// Pure function of the tool dict + budget, so history replay is stable:
// the same harness produces the same direct/deferred split every turn.

import { tool, type Tool, type ToolSet } from "ai";
import { z } from "zod";

export const OPENAI_MAX_TOOLS = 128;
export const SEARCH_TOOL_NAME = "search_mcp_tools";
export const CALL_TOOL_NAME = "call_mcp_tool";
const META_TOOL_COUNT = 2;

const MCP_PREFIX = "mcp__";

export function mcpServerOf(toolName: string): string | null {
  if (!toolName.startsWith(MCP_PREFIX)) return null;
  const rest = toolName.slice(MCP_PREFIX.length);
  const idx = rest.indexOf("__");
  return idx > 0 ? rest.slice(0, idx) : null;
}

export interface ToolBudgetResult {
  tools: ToolSet;
  /** Deferred tool name → original tool. Empty when everything fit. */
  deferred: Map<string, Tool>;
  /** Server → number of deferred tools (for logging / prompts). */
  deferredByServer: Record<string, number>;
}

function toolDescription(t: Tool): string {
  const d = (t as { description?: unknown }).description;
  return typeof d === "string" ? d : "";
}

function jsonSchemaOf(t: Tool): unknown {
  const schema = (t as { inputSchema?: unknown }).inputSchema;
  if (!schema) return undefined;
  // ai-sdk wraps schemas; zod schemas expose nothing serialisable, but MCP
  // tools carry a `jsonSchema` on the wrapper (ai-sdk's jsonSchema()).
  const js = (schema as { jsonSchema?: unknown }).jsonSchema;
  return js ?? undefined;
}

/**
 * Fit `tools` into `maxTools` entries. Returns the (possibly) reduced tool
 * set plus the deferred map. No-op (same object) when already within budget.
 */
export function applyToolBudget(
  tools: ToolSet,
  opts: { maxTools: number; serverOrder?: string[] },
): ToolBudgetResult {
  const names = Object.keys(tools);
  if (names.length <= opts.maxTools) {
    return { tools, deferred: new Map(), deferredByServer: {} };
  }

  const direct: ToolSet = {};
  const byServer = new Map<string, string[]>();
  for (const name of names) {
    const server = mcpServerOf(name);
    if (!server) {
      direct[name] = tools[name]!;
      continue;
    }
    const list = byServer.get(server) ?? [];
    list.push(name);
    byServer.set(server, list);
  }

  // Harness order first (the agent's declared mcp_servers), then any
  // servers we only know from tool names, in first-seen order.
  const order = [
    ...(opts.serverOrder ?? []).filter((s) => byServer.has(s)),
    ...[...byServer.keys()].filter((s) => !(opts.serverOrder ?? []).includes(s)),
  ];

  const budget = opts.maxTools - META_TOOL_COUNT;
  const deferred = new Map<string, Tool>();
  const deferredByServer: Record<string, number> = {};
  let used = Object.keys(direct).length;
  for (const server of order) {
    const list = byServer.get(server)!;
    if (used + list.length <= budget) {
      for (const name of list) direct[name] = tools[name]!;
      used += list.length;
    } else {
      for (const name of list) deferred.set(name, tools[name]!);
      deferredByServer[server] = list.length;
    }
  }

  if (deferred.size === 0) {
    // Only possible if non-MCP tools alone exceed the budget — nothing we
    // can defer safely; return as-is and let the provider report it.
    return { tools, deferred, deferredByServer };
  }

  const serverSummary = Object.entries(deferredByServer)
    .map(([s, n]) => `${s} (${n} tools)`)
    .join(", ");

  direct[SEARCH_TOOL_NAME] = tool({
    description:
      `Find tools from MCP servers that are NOT loaded directly because this model accepts at most ${opts.maxTools} tools. ` +
      `Deferred servers: ${serverSummary}. Search by keyword (tool name or what it does) and optionally restrict to one server; ` +
      `returns matching tool names with their input schemas. Then invoke one with ${CALL_TOOL_NAME}.`,
    inputSchema: z.object({
      query: z.string().min(1).max(200).describe("Keywords, e.g. \"create issue\", \"list projects\", \"post message\""),
      server: z.string().optional().describe(`Restrict to one deferred server: ${Object.keys(deferredByServer).join(", ")}`),
      limit: z.number().int().min(1).max(40).optional().describe("Max results (default 12)"),
    }),
    execute: async ({ query, server, limit }: { query: string; server?: string; limit?: number }) => {
      const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      const scored: Array<{ name: string; score: number }> = [];
      for (const [name, t] of deferred) {
        const srv = mcpServerOf(name) ?? "";
        if (server && srv !== server) continue;
        const hay = `${name} ${toolDescription(t)}`.toLowerCase();
        let score = 0;
        for (const term of terms) {
          if (name.toLowerCase().includes(term)) score += 3;
          else if (hay.includes(term)) score += 1;
        }
        if (score > 0 || terms.length === 0) scored.push({ name, score });
      }
      scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
      const top = scored.slice(0, limit ?? 12);
      if (top.length === 0) {
        return `No deferred tools matched "${query}"${server ? ` on ${server}` : ""}. Deferred servers: ${serverSummary}.`;
      }
      return JSON.stringify(
        top.map(({ name }) => {
          const t = deferred.get(name)!;
          return {
            name,
            server: mcpServerOf(name),
            description: toolDescription(t).slice(0, 400),
            input_schema: jsonSchemaOf(t) ?? "(see description)",
          };
        }),
        null,
        1,
      );
    },
  });

  direct[CALL_TOOL_NAME] = tool({
    description:
      `Invoke a deferred MCP tool by its full name (as returned by ${SEARCH_TOOL_NAME}, e.g. "mcp__linear__create_issue") ` +
      `with a JSON object of arguments matching its input schema. Deferred servers: ${serverSummary}.`,
    inputSchema: z.object({
      name: z.string().min(1).max(200).describe("Full deferred tool name, e.g. mcp__linear__create_issue"),
      arguments: z.record(z.string(), z.unknown()).optional().describe("Tool arguments (JSON object)"),
    }),
    execute: async (
      { name, arguments: args }: { name: string; arguments?: Record<string, unknown> },
      callOpts: unknown,
    ) => {
      const t = deferred.get(name);
      if (!t) {
        return `Unknown deferred tool "${name}". Use ${SEARCH_TOOL_NAME} to find the exact name. Deferred servers: ${serverSummary}.`;
      }
      const exec = (t as { execute?: (a: unknown, o: unknown) => unknown }).execute;
      if (typeof exec !== "function") return `Tool "${name}" cannot be executed here.`;
      try {
        const out = await exec(args ?? {}, callOpts);
        return typeof out === "string" ? out : JSON.stringify(out);
      } catch (err) {
        return `Tool "${name}" failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });

  return { tools: direct, deferred, deferredByServer };
}
