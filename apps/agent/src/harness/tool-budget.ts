// Tool budget — which MCP tool definitions ride every model request.
//
// Two limits, every provider:
//   - size: MCP tool schemas are resent on every model call (up to 100
//     steps per turn). One Notion server is ~59k tokens of definitions —
//     on prod a trivial gpt-6.1-sol turn sent ~63k input tokens, ~59k of
//     them Notion's schemas. When the MCP definitions exceed
//     maxMcpTokens (default DEFAULT_MCP_TOOL_TOKEN_BUDGET, estimated as
//     serialized chars / 4) servers are deferred.
//   - count: OpenAI rejects requests carrying more than 128 tool
//     definitions ("Invalid 'tools': array too long", 400). Seen live
//     2026-09-02: 201 MCP tools + built-ins = 224 → every turn failed with
//     harness_turn_failed. Callers pass maxTools for providers with a cap.
//
// Strategy (deterministic, capability-preserving):
//   1. Non-MCP tools (built-ins, platform tools, call_agent_*) always stay.
//   2. MCP servers are kept WHOLE, in declared order, while they fit both
//      limits; a server that doesn't fit is skipped and later (smaller)
//      servers are still tried.
//   3. Servers that don't fit are "deferred": their tools leave the array
//      and become reachable through two meta tools — `search_mcp_tools`
//      (find by keyword, returns names + input schemas) and `call_mcp_tool`
//      (invoke a deferred tool by full name). Same idea as Claude Code's
//      deferred ToolSearch / Anthropic's tool-search: the model can still
//      do everything, it just discovers the long tail on demand — at the
//      cost of one extra round trip the first time it needs such a tool.
//   Per-agent override (`_oma.mcp_tool_loading`): "eager" never defers for
//   size (the provider's count cap still applies), "deferred" defers every
//   MCP server.
//
// Permissions: this runs on the dict buildTools returned, i.e. AFTER the
// gates — denied tools are already gone (so neither search nor call can
// reach them), and always_ask / policy-ask tools have no `execute`. A
// deferred tool like that must still ASK, not become unreachable — so
// call_mcp_tool carries `needsApproval` for exactly those targets: the AI
// SDK leaves the call pending, the harness records it as an ask-gated
// tool_use, and an approval re-runs the TARGET tool directly
// (session-runtime unwraps call_mcp_tool via resolveConfirmedToolCall in
// packages/shared/src/tool-permission.ts).
//
// Pure function of the tool dict + options, so history replay and the
// provider prompt cache are stable: the same tool list produces the same
// direct/deferred split, the same meta-tool descriptions, every turn.

import { asSchema, jsonSchema, tool, type Tool, type ToolSet } from "ai";
import { z } from "zod";
import type { AgentConfig, McpToolLoading, SessionEvent } from "@open-managed-agents/shared";
import {
  CALL_MCP_BAD_ARGUMENTS,
  CALL_MCP_TOOL_NAME,
  MCP_TOOL_LOADING_MODES,
  parseCallMcpArguments,
} from "@open-managed-agents/shared";
import { isContentBlockArray, mcpModelOutput, truncateResult } from "./mcp-output";

export const OPENAI_MAX_TOOLS = 128;
/** MCP tool definitions above this (estimated tokens) get deferred in "auto". */
export const DEFAULT_MCP_TOOL_TOKEN_BUDGET = 8_000;
/** search_mcp_tools results per call unless the model passes `limit`. Each
 *  result carries a full input schema (~1k tokens for Notion's), and the
 *  result stays in history — 12 made one search cost ~15k tokens. */
export const DEFAULT_SEARCH_LIMIT = 5;
export const SEARCH_TOOL_NAME = "search_mcp_tools";
export const CALL_TOOL_NAME = CALL_MCP_TOOL_NAME;
const META_TOOL_COUNT = 2;

const callMcpToolInput = z.object({
  name: z.string().min(1).max(200),
  // Some models send the arguments JSON-encoded; accept both.
  arguments: z.union([z.record(z.string(), z.unknown()), z.string()]).optional(),
});
type CallMcpToolInput = z.infer<typeof callMcpToolInput>;
const CALL_MCP_TOOL_WIRE_SCHEMA = {
  type: "object" as const,
  properties: {
    name: { type: "string" as const, minLength: 1, maxLength: 200, description: "Full deferred tool name, e.g. mcp__linear__create_issue" },
    arguments: {
      description: "Tool arguments (JSON object)",
      anyOf: [{ type: "object" as const, additionalProperties: true }, { type: "string" as const }],
    },
  },
  required: ["name"],
  additionalProperties: false,
};

const MCP_PREFIX = "mcp__";

export function mcpServerOf(toolName: string): string | null {
  if (!toolName.startsWith(MCP_PREFIX)) return null;
  const rest = toolName.slice(MCP_PREFIX.length);
  const idx = rest.indexOf("__");
  return idx > 0 ? rest.slice(0, idx) : null;
}

export type ToolBudgetReason = "tool_count" | "token_budget" | "mode_deferred";

export interface ToolBudgetOptions {
  /** Provider cap on the number of tool definitions (OpenAI: 128). Unset = no count cap. */
  maxTools?: number;
  /** Estimated-token budget for MCP definitions sent directly ("auto" only).
   *  Default DEFAULT_MCP_TOOL_TOKEN_BUDGET. */
  maxMcpTokens?: number;
  /** Per-agent `_oma.mcp_tool_loading`. Default "auto". */
  mode?: McpToolLoading;
  /** The agent's declared mcp_servers order. */
  serverOrder?: string[];
}

export interface ToolBudgetResult {
  tools: ToolSet;
  /** Deferred tool name → original tool. Empty when everything fit. */
  deferred: Map<string, Tool>;
  /** Server → number of deferred tools (for logging / prompts). */
  deferredByServer: Record<string, number>;
  /** Why servers were deferred (empty when nothing was). */
  reasons: ToolBudgetReason[];
  /** Estimated MCP definition tokens: all servers, and what is still sent directly. */
  mcpTokens: { total: number; direct: number; byServer: Record<string, number> };
}

function toolDescription(t: Tool): string {
  const d = (t as { description?: unknown }).description;
  return typeof d === "string" ? d : "";
}

function hasExecute(t: Tool | undefined): boolean {
  return typeof (t as { execute?: unknown } | undefined)?.execute === "function";
}

/**
 * True when this concrete call must wait for user approval: the tool has a
 * synchronous `needsApproval` (call_mcp_tool) that says so for `input`.
 * The harness uses it to stamp the write-ahead tool_use as ask-gated.
 */
export function toolCallNeedsApproval(t: unknown, input: unknown): boolean {
  const na = (t as { needsApproval?: unknown } | undefined)?.needsApproval;
  if (na === true) return true;
  if (typeof na !== "function") return false;
  try {
    return (na as (i: unknown) => unknown)(input) === true;
  } catch {
    return false;
  }
}

function jsonSchemaOf(t: Tool): unknown {
  const schema = (t as { inputSchema?: unknown; parameters?: unknown }).inputSchema ??
    (t as { parameters?: unknown }).parameters;
  if (!schema) return undefined;
  // MCP tools carry ai-sdk jsonSchema() wrappers; zod schemas (tests,
  // built-ins) convert through asSchema. Both are synchronous here.
  try {
    const js = asSchema(schema as Parameters<typeof asSchema>[0]).jsonSchema;
    if (js && typeof (js as { then?: unknown }).then === "function") return undefined;
    return js ?? undefined;
  } catch {
    return undefined;
  }
}

/** Cheap, deterministic token estimate of one tool definition as a
 *  provider serializes it (name + description + input schema), chars / 4. */
export function estimateToolTokens(name: string, t: Tool): number {
  const chars = JSON.stringify({ name, description: toolDescription(t), input_schema: jsonSchemaOf(t) ?? {} }).length;
  return Math.ceil(chars / 4);
}

/** Estimated tokens of every tool definition in `tools` (whole dict). */
export function estimateToolSetTokens(tools: ToolSet): number {
  let n = 0;
  for (const [name, t] of Object.entries(tools)) n += estimateToolTokens(name, t as Tool);
  return n;
}

export function normalizeMcpToolLoading(v: unknown): McpToolLoading {
  return typeof v === "string" && (MCP_TOOL_LOADING_MODES as readonly string[]).includes(v)
    ? (v as McpToolLoading)
    : "auto";
}

/**
 * Fit `tools` into the budget. Returns the (possibly) reduced tool set plus
 * the deferred map. No-op (same object) when already within budget.
 */
export function applyToolBudget(tools: ToolSet, opts: ToolBudgetOptions = {}): ToolBudgetResult {
  const names = Object.keys(tools);
  const mode = normalizeMcpToolLoading(opts.mode);
  const maxTools = opts.maxTools ?? Number.POSITIVE_INFINITY;
  const maxMcpTokens =
    mode === "eager" ? Number.POSITIVE_INFINITY
    : mode === "deferred" ? 0
    : (opts.maxMcpTokens ?? DEFAULT_MCP_TOOL_TOKEN_BUDGET);

  const direct: ToolSet = {};
  const byServer = new Map<string, string[]>();
  const tokensByServer: Record<string, number> = {};
  let totalMcpTokens = 0;
  for (const name of names) {
    const server = mcpServerOf(name);
    if (!server) {
      direct[name] = tools[name]!;
      continue;
    }
    const list = byServer.get(server) ?? [];
    list.push(name);
    byServer.set(server, list);
    const tok = estimateToolTokens(name, tools[name] as Tool);
    tokensByServer[server] = (tokensByServer[server] ?? 0) + tok;
    totalMcpTokens += tok;
  }
  const mcpTokens = { total: totalMcpTokens, direct: totalMcpTokens, byServer: tokensByServer };

  const overCount = names.length > maxTools;
  const overTokens = byServer.size > 0 && totalMcpTokens > maxMcpTokens;
  if (!overCount && !overTokens) {
    return { tools, deferred: new Map(), deferredByServer: {}, reasons: [], mcpTokens };
  }

  // Declared order first (the agent's mcp_servers), then any servers we
  // only know from tool names, in first-seen order.
  const order = [
    ...(opts.serverOrder ?? []).filter((s) => byServer.has(s)),
    ...[...byServer.keys()].filter((s) => !(opts.serverOrder ?? []).includes(s)),
  ];

  const countBudget = maxTools - META_TOOL_COUNT;
  const deferred = new Map<string, Tool>();
  const deferredByServer: Record<string, number> = {};
  let used = Object.keys(direct).length;
  let usedTokens = 0;
  for (const server of order) {
    const list = byServer.get(server)!;
    const tok = tokensByServer[server] ?? 0;
    if (used + list.length <= countBudget && usedTokens + tok <= maxMcpTokens) {
      for (const name of list) direct[name] = tools[name]!;
      used += list.length;
      usedTokens += tok;
    } else {
      for (const name of list) deferred.set(name, tools[name]!);
      deferredByServer[server] = list.length;
    }
  }

  if (deferred.size === 0) {
    // Only possible if non-MCP tools alone exceed the count cap — nothing
    // we can defer safely; return as-is and let the provider report it.
    return { tools, deferred, deferredByServer, reasons: [], mcpTokens };
  }

  const reasons: ToolBudgetReason[] =
    mode === "deferred" ? ["mode_deferred"]
    : [...(overCount ? ["tool_count" as const] : []), ...(overTokens ? ["token_budget" as const] : [])];
  mcpTokens.direct = usedTokens;

  const serverSummary = Object.entries(deferredByServer)
    .map(([s, n]) => `${s} (${n} tools)`)
    .join(", ");
  const why =
    mode === "deferred" ? "this agent loads MCP tools on demand"
    : overCount && Number.isFinite(maxTools) ? `this model accepts at most ${maxTools} tools`
    : "their definitions are too large to send with every request";

  direct[SEARCH_TOOL_NAME] = tool({
    description:
      `Find tools from MCP servers that are NOT loaded directly because ${why}. ` +
      `Deferred servers: ${serverSummary}. Search by keyword (tool name or what it does) and optionally restrict to one server; ` +
      `returns matching tool names with their input schemas. Then invoke one with ${CALL_TOOL_NAME}.`,
    inputSchema: z.object({
      query: z.string().min(1).max(200).describe("Keywords, e.g. \"create issue\", \"list projects\", \"post message\""),
      server: z.string().optional().describe(`Restrict to one deferred server: ${Object.keys(deferredByServer).join(", ")}`),
      limit: z.number().int().min(1).max(40).optional().describe(`Max results (default ${DEFAULT_SEARCH_LIMIT})`),
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
      const top = scored.slice(0, limit ?? DEFAULT_SEARCH_LIMIT);
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
            ...(hasExecute(t) ? {} : { requires_approval: true }),
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
    // Wire schema spelled out, validated with zod: the AI SDK's zod
    // conversion closes every object (additionalProperties:false), which
    // declared `arguments` as an object that allows NO keys — the model
    // was told that, and the pi harness (validating against the JSON
    // schema) refused every call with object arguments.
    inputSchema: jsonSchema<CallMcpToolInput>(CALL_MCP_TOOL_WIRE_SCHEMA, {
      validate: (value) => {
        const r = callMcpToolInput.safeParse(value);
        return r.success ? { success: true, value: r.data } : { success: false, error: r.error };
      },
    }),
    // Deferred always_ask / policy-ask tools (no execute) ask the user
    // first; everything else runs immediately.
    // Malformed arguments never park: execute hands the error back so the
    // model retries, instead of the user approving a call that can't run.
    needsApproval: ({ name, arguments: args }: { name: string; arguments?: unknown }) => {
      const t = deferred.get(name);
      return !!t && !hasExecute(t) && parseCallMcpArguments(args) !== null;
    },
    // MCP targets already return the model-facing form (string, or
    // ContentBlock[] with images — see mcp-output.ts); shown and persisted
    // (agent.tool_result) as is.
    toModelOutput: mcpModelOutput,
    execute: async (
      { name, arguments: args }: { name: string; arguments?: Record<string, unknown> | string },
      callOpts: unknown,
    ) => {
      const t = deferred.get(name);
      if (!t) {
        return `Unknown deferred tool "${name}". Use ${SEARCH_TOOL_NAME} to find the exact name. Deferred servers: ${serverSummary}.`;
      }
      const parsed = parseCallMcpArguments(args);
      if (!parsed) return `Invalid arguments for "${name}": ${CALL_MCP_BAD_ARGUMENTS}`;
      const exec = (t as { execute?: (a: unknown, o: unknown) => unknown }).execute;
      // needsApproval normally parks these before execute; a harness that
      // ignores it (or a replay) must still not run a gated tool unasked.
      if (typeof exec !== "function") return `Tool "${name}" requires user approval and was not run.`;
      try {
        const out = await exec(parsed, callOpts);
        if (typeof out === "string" || isContentBlockArray(out)) return out;
        return truncateResult(out == null ? "" : JSON.stringify(out));
      } catch (err) {
        return `Tool "${name}" failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });

  return { tools: direct, deferred, deferredByServer, reasons, mcpTokens };
}

/**
 * The per-turn budget both harnesses apply: the agent's declared server
 * order and `_oma.mcp_tool_loading`, plus the provider's count cap.
 */
export function applyAgentToolBudget(
  tools: ToolSet,
  agent: Pick<AgentConfig, "mcp_servers" | "mcp_tool_loading">,
  opts: { maxTools?: number; maxMcpTokens?: number } = {},
): ToolBudgetResult {
  return applyToolBudget(tools, {
    ...opts,
    mode: agent.mcp_tool_loading,
    serverOrder: (agent.mcp_servers ?? []).map((srv) => srv.name).filter(Boolean) as string[],
  });
}

// One warning per (session, deferred split): the split is the same every
// turn for an unchanged agent, and the event log is append-only. Capped
// like policyDenyAudited in tools.ts — eviction only repeats a warning.
const MAX_WARNED_SESSIONS = 2000;
const warnedSplitBySession = new Map<string, string>();

/**
 * session.warning (source "tool_budget") naming the deferred servers, or
 * null when nothing was deferred / this session was already told about
 * this exact split.
 */
export function toolBudgetWarning(budget: ToolBudgetResult, sessionId?: string): SessionEvent | null {
  if (budget.deferred.size === 0) return null;
  const servers = Object.keys(budget.deferredByServer);
  const signature = `${budget.reasons.join(",")}|${servers.map((s) => `${s}:${budget.deferredByServer[s]}`).join(",")}`;
  if (sessionId) {
    if (warnedSplitBySession.get(sessionId) === signature) return null;
    warnedSplitBySession.delete(sessionId);
    warnedSplitBySession.set(sessionId, signature);
    if (warnedSplitBySession.size > MAX_WARNED_SESSIONS) {
      warnedSplitBySession.delete(warnedSplitBySession.keys().next().value!);
    }
  }
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const why = budget.reasons
    .map((r) =>
      r === "tool_count" ? "the model's tool-count limit"
      : r === "token_budget" ? `the ~${k(DEFAULT_MCP_TOOL_TOKEN_BUDGET)}-token MCP definition budget`
      : "mcp_tool_loading: deferred",
    )
    .join(" and ");
  return {
    type: "session.warning",
    source: "tool_budget",
    message:
      `Deferred MCP servers ${servers
        .map((s) => `${s} (${budget.deferredByServer[s]} tools, ~${k(budget.mcpTokens.byServer[s] ?? 0)} tokens)`)
        .join(", ")} — ${why}. ` +
      `Their tools stay reachable via ${SEARCH_TOOL_NAME} / ${CALL_TOOL_NAME}.`,
    details: {
      deferred_servers: budget.deferredByServer,
      reasons: budget.reasons,
      estimated_mcp_tokens: budget.mcpTokens.total,
      estimated_mcp_tokens_direct: budget.mcpTokens.direct,
    },
  } as SessionEvent;
}
