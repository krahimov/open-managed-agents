/**
 * Deferred MCP servers (apps/agent/src/harness/tool-budget.ts) sit behind
 * two meta tools instead of their own tool definitions:
 *
 *   search_mcp_tools { query, server?, limit? }        find a deferred tool
 *   call_mcp_tool    { name: "mcp__<server>__<tool>",  run one
 *                      arguments: {...} | "<json>" }
 *
 * Both reach the event log as plain agent.tool_use events, so the console
 * unwraps them here to present the real service and tool.
 */

export const CALL_MCP_TOOL = "call_mcp_tool";
export const SEARCH_MCP_TOOLS = "search_mcp_tools";

const MCP_PREFIX = "mcp__";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** "mcp__linear__create_issue" → { server: "linear", tool: "create_issue" }.
 *  The server ends at the first "__" after the prefix (as in the harness's
 *  mcpServerOf); the tool keeps any later "__". Null when malformed. */
export function parseMcpToolName(name: unknown): { server: string; tool: string } | null {
  if (typeof name !== "string" || !name.startsWith(MCP_PREFIX)) return null;
  const rest = name.slice(MCP_PREFIX.length);
  const idx = rest.indexOf("__");
  if (idx <= 0) return null;
  const tool = rest.slice(idx + 2);
  return tool ? { server: rest.slice(0, idx), tool } : null;
}

export interface DeferredMcpCall {
  /** Full target name, "mcp__<server>__<tool>". */
  name: string;
  server: string;
  tool: string;
  /** The target's input: `arguments`, JSON-decoded when sent as a string. */
  arguments: Record<string, unknown>;
}

/** Arguments as the target sees them. Anything that isn't an object (bad
 *  JSON, an array) is kept under `arguments` rather than dropped, so an
 *  approver still sees exactly what was sent. */
function targetArguments(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (isRecord(raw)) return raw;
  if (typeof raw === "string") {
    if (!raw.trim()) return {};
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isRecord(parsed)) return parsed;
    } catch {
      // not JSON — shown as sent
    }
  }
  return { arguments: raw };
}

/** The deferred target of a call_mcp_tool call; null for any other tool or
 *  when `input.name` is missing / not an mcp__<server>__<tool> name. */
export function unwrapCallMcpTool(name: unknown, input: unknown): DeferredMcpCall | null {
  if (name !== CALL_MCP_TOOL || !isRecord(input)) return null;
  const target = parseMcpToolName(input.name);
  if (!target) return null;
  return { name: input.name as string, ...target, arguments: targetArguments(input.arguments) };
}

/** search_mcp_tools' query and optional server; null for any other tool or
 *  without a query. */
export function parseSearchMcpTools(name: unknown, input: unknown): { query: string; server?: string } | null {
  if (name !== SEARCH_MCP_TOOLS || !isRecord(input)) return null;
  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (!query) return null;
  const server = typeof input.server === "string" && input.server.trim() ? input.server.trim() : undefined;
  return server ? { query, server } : { query };
}
