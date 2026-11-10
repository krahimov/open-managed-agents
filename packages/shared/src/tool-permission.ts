// Toolset permission resolution — which `permission_policy` governs a tool.
//
// An agent's `tools` array holds one entry per toolset: the built-in
// `agent_toolset_*` and one `mcp_toolset` per MCP server (keyed by
// `mcp_server_name`), each with an optional `default_config` and per-tool
// `configs`. A tool is governed by the toolset it belongs to
// (resolveOwningToolsetPermission):
//
//   mcp__<server>__<tool>  → the mcp_toolset whose mcp_server_name is
//                            <server>; its per-tool config (bare or full
//                            name) beats its default_config. An explicit
//                            per-tool always_ask naming the full tool in
//                            any toolset also applies. When the owner
//                            declares nothing, the built-in toolset's
//                            policy applies.
//   anything else          → the non-MCP toolsets in order; per-tool
//                            config, then default_config.
//
// Unset → always_allow. The previous resolver returned the FIRST toolset's
// policy for every tool, so an agent with GitHub on always_allow and
// Linear on always_ask never asked for Linear.
//
// Migration (restrict-only ratchet): the DefaultHarness gate
// (resolveToolPermission) asks when EITHER the owning toolset asks OR the
// previous first-toolset rule asked. The console writes every mcp_toolset
// as always_allow whatever the user picked, and stored config can't tell
// that default from a deliberate choice — so honoring it would silently
// stop asking for every MCP tool on agents whose built-in default is
// always_ask. With the ratchet the fix only ADDS ask gates; no existing
// agent goes from asking to not asking. Loosening stays an explicit,
// separate change (e.g. a console migration that writes real intent).
//
// The SDK harnesses never asked (no confirmation round-trip) and refuse
// what they can't ask for; they use the owning-toolset rule only, so a
// console agent's auto-written always_allow servers keep working there.

import type { ToolConfig, ToolsetConfig } from "@open-managed-agents/api-types";

export type ToolPermission = "always_allow" | "always_ask";

/** Meta tool that invokes a deferred MCP tool by full name (see
 *  apps/agent/src/harness/tool-budget.ts). Its permission is the target's. */
export const CALL_MCP_TOOL_NAME = "call_mcp_tool";

const MCP_TOOL_PREFIX = "mcp__";

/** Split `mcp__<server>__<tool>`; null for non-MCP names. */
export function parseMcpToolName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith(MCP_TOOL_PREFIX)) return null;
  const rest = name.slice(MCP_TOOL_PREFIX.length);
  const idx = rest.indexOf("__");
  if (idx <= 0) return null;
  return { server: rest.slice(0, idx), tool: rest.slice(idx + 2) };
}

type Toolset = ToolsetConfig & { mcp_server_name?: string };

function isMcpToolset(t: Toolset): boolean {
  return typeof t.type === "string" && t.type.startsWith("mcp_toolset");
}

function toolsetsOf(tools: ToolConfig[] | undefined): Toolset[] {
  return (tools ?? []).filter((t) => t && t.type !== "custom") as Toolset[];
}

function policyOf(c: { permission_policy?: { type?: string } } | undefined): ToolPermission | null {
  const type = c?.permission_policy?.type;
  return type === "always_ask" || type === "always_allow" ? type : null;
}

/** Legacy order over the given toolsets: first per-tool match, else first
 *  toolset that declares a default. */
function fromToolsets(toolsets: Toolset[], names: string[]): ToolPermission | null {
  for (const ts of toolsets) {
    const perTool = policyOf(ts.configs?.find((c) => names.includes(c.name)));
    if (perTool) return perTool;
    const dflt = policyOf(ts.default_config);
    if (dflt) return dflt;
  }
  return null;
}

/** Policy of the toolset `toolName` belongs to (see header). */
export function resolveOwningToolsetPermission(
  tools: ToolConfig[] | undefined,
  toolName: string,
): ToolPermission {
  const toolsets = toolsetsOf(tools);
  const builtin = toolsets.filter((t) => !isMcpToolset(t));
  const mcp = parseMcpToolName(toolName);
  if (mcp) {
    const owner = toolsets.find((t) => isMcpToolset(t) && t.mcp_server_name === mcp.server);
    const ownPerTool = owner ? policyOf(owner.configs?.find((c) => c.name === mcp.tool || c.name === toolName)) : null;
    if (ownPerTool) return ownPerTool;
    // An operator who named this exact tool always_ask anywhere meant it.
    if (toolsets.some((ts) => ts.configs?.some((c) => c.name === toolName && policyOf(c) === "always_ask"))) {
      return "always_ask";
    }
    const ownDefault = owner ? policyOf(owner.default_config) : null;
    if (ownDefault) return ownDefault;
    return fromToolsets(builtin, [toolName]) ?? "always_allow";
  }
  return fromToolsets(builtin, [toolName]) ?? "always_allow";
}

/** The pre-fix rule: first toolset with a matching per-tool config or a
 *  default wins, for every tool. Kept only as the ratchet's floor. */
function legacyFirstToolsetPermission(tools: ToolConfig[] | undefined, toolName: string): ToolPermission {
  return fromToolsets(toolsetsOf(tools), [toolName]) ?? "always_allow";
}

/**
 * Permission gate for the DefaultHarness: always_ask when the owning
 * toolset asks or the previous first-toolset rule asked (restrict-only
 * ratchet — see header).
 */
export function resolveToolPermission(
  tools: ToolConfig[] | undefined,
  toolName: string,
): ToolPermission {
  return resolveOwningToolsetPermission(tools, toolName) === "always_ask" ||
    legacyFirstToolsetPermission(tools, toolName) === "always_ask"
    ? "always_ask"
    : "always_allow";
}

/**
 * Can any tool of MCP server `server` be always_ask under its OWN toolset
 * (or the built-in default it inherits when it declares none)? Used by
 * harnesses that can only fail closed per session (codex-sdk).
 */
export function mcpServerMayAsk(tools: ToolConfig[] | undefined, server: string): boolean {
  const toolsets = toolsetsOf(tools);
  const owner = toolsets.find((t) => isMcpToolset(t) && t.mcp_server_name === server);
  if (owner?.configs?.some((c) => policyOf(c) === "always_ask")) return true;
  const prefix = `${MCP_TOOL_PREFIX}${server}__`;
  if (toolsets.some((ts) => ts.configs?.some((c) => c.name.startsWith(prefix) && policyOf(c) === "always_ask"))) {
    return true;
  }
  // A name no per-tool config matches → the server's default resolution.
  return resolveOwningToolsetPermission(tools, `${prefix}\u0000`) === "always_ask";
}

/**
 * Permission for one concrete call: `call_mcp_tool` carries the deferred
 * tool's full name in `input.name`, and that tool's policy is what counts.
 */
export function resolveToolCallPermission(
  tools: ToolConfig[] | undefined,
  toolName: string,
  input: unknown,
): ToolPermission {
  if (toolName === CALL_MCP_TOOL_NAME) {
    const target = (input as { name?: unknown } | null | undefined)?.name;
    if (typeof target === "string" && parseMcpToolName(target)) {
      return resolveToolPermission(tools, target);
    }
  }
  return resolveToolPermission(tools, toolName);
}

/** True when any toolset declares always_ask anywhere (default or per tool). */
export function anyToolsetAsks(tools: ToolConfig[] | undefined): boolean {
  return toolsetsOf(tools).some(
    (ts) =>
      policyOf(ts.default_config) === "always_ask" ||
      (ts.configs ?? []).some((c) => policyOf(c) === "always_ask"),
  );
}

/**
 * The tool + input an APPROVED call should actually run. A pending
 * call_mcp_tool resolves to the deferred MCP tool it names — the dict
 * rebuilt for the approval holds that tool directly (call_mcp_tool itself
 * only exists after per-turn budgeting) — with its `arguments`. Anything
 * else runs as recorded. `error` set → don't run it; report that instead.
 */
export function resolveConfirmedToolCall<T>(
  built: Record<string, T | undefined> | null | undefined,
  name: string,
  input: Record<string, unknown>,
): { tool: T | undefined; name: string; input: Record<string, unknown>; error?: string } {
  if (name === CALL_MCP_TOOL_NAME) {
    const target = typeof input?.name === "string" ? input.name : "";
    if (!parseMcpToolName(target)) return { tool: undefined, name, input };
    const args = parseCallMcpArguments(input.arguments);
    if (!args) return { tool: undefined, name: target, input: {}, error: CALL_MCP_BAD_ARGUMENTS };
    return { tool: lookupBuilt(built, target), name: target, input: args };
  }
  return { tool: lookupBuilt(built, name), name, input };
}

type ParkableEvent = {
  type: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  mcp_tool_use_id?: string;
  custom_tool_use_id?: string;
  cancelled_at_ms?: number | null;
};
const PARKABLE_TYPES = new Set(["agent.tool_use", "agent.mcp_tool_use", "agent.custom_tool_use"]);

/** Ids of tool uses that already have a result in `events` — same pairing
 *  as findUnresolvedToolUses (session-runtime/tool-actions.ts). */
function resolvedToolUseIds(events: readonly ParkableEvent[]): Set<string> {
  const done = new Set<string>();
  for (const e of events) {
    if (e.cancelled_at_ms != null) continue;
    const id =
      e.type === "agent.tool_result" ? e.tool_use_id
      : e.type === "agent.mcp_tool_result" ? e.mcp_tool_use_id
      : e.type === "user.custom_tool_result" ? e.custom_tool_use_id
      : undefined;
    if (typeof id === "string") done.add(id);
  }
  return done;
}

/**
 * A delegated (sub-agent) run that stopped on calls only a user could
 * resolve — approval, or a client-side tool result. Sub-agent threads have
 * no requires_action path, so those calls would sit unresolved forever and
 * the delegation would come back empty. Returns the parked tool_use events
 * (to close out) and the notice the delegating agent gets instead, or null
 * when nothing parked. A pending id that already has a result (a sibling
 * call whose tool threw is pending to the harness but has its is_error
 * result in the log) ran — it is neither closed again nor named.
 */
export function subAgentParkedCalls(
  events: readonly ParkableEvent[],
  pendingIds: readonly string[],
): { parked: Array<{ id: string; type: string; name: string }>; notice: string } | null {
  if (!pendingIds.length) return null;
  const ids = new Set(pendingIds);
  const resolved = resolvedToolUseIds(events);
  const parked = events
    .filter(
      (e): e is ParkableEvent & { id: string } =>
        PARKABLE_TYPES.has(e.type) &&
        e.cancelled_at_ms == null &&
        typeof e.id === "string" &&
        ids.has(e.id) &&
        !resolved.has(e.id),
    )
    .map((e) => {
      const target = e.name === CALL_MCP_TOOL_NAME ? (e.input as { name?: unknown } | undefined)?.name : undefined;
      return { id: e.id, type: e.type, name: typeof target === "string" ? target : e.name ?? "tool" };
    });
  if (!parked.length) return null;
  const names = [...new Set(parked.map((p) => p.name))];
  const many = names.length > 1;
  return {
    parked,
    notice:
      `[sub-agent stopped] ${names.join(", ")} ${many ? "need" : "needs"} the user's approval (or a client-side result), which a delegated agent can't ask for, ` +
      `so ${many ? "they were" : "it was"} not run. Do this step in the main conversation (where the user can approve it), ` +
      `or set ${many ? "those tools" : "that tool"} to always_allow on the delegated agent.`,
  };
}

/** Look a tool up by its recorded name. On OpenAI, names over 64 chars are
 *  shortened on the wire (openAiSafeToolName) and the tool_use event
 *  carries the short name, while the rebuilt dict is keyed by originals. */
function lookupBuilt<T>(built: Record<string, T | undefined> | null | undefined, name: string): T | undefined {
  if (!built) return undefined;
  if (built[name] !== undefined) return built[name];
  if (name.length !== OPENAI_MAX_TOOL_NAME) return undefined;
  const original = Object.keys(built).find((k) => k.length > OPENAI_MAX_TOOL_NAME && openAiSafeToolName(k) === name);
  return original ? built[original] : undefined;
}

/** call_mcp_tool's `arguments`: an object, or a JSON-encoded object (some
 *  models stringify it); absent → {}. Anything else (a string that isn't
 *  JSON, an array, a number) → null: running the tool with {} instead
 *  would drop the model's filters — or run something other than what the
 *  user approved. */
export function parseCallMcpArguments(args: unknown): Record<string, unknown> | null {
  if (args === undefined || args === null) return {};
  let v = args;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export const CALL_MCP_BAD_ARGUMENTS =
  "`arguments` must be a JSON object of the tool's arguments (or a string holding one); the tool was not run.";

// ─── OpenAI tool-name shortening ──────────────────────────────────────────
//
// OpenAI hard-caps function names at 64 chars. The mangle is a pure
// function of the name (prefix + fnv1a suffix), so the harness (wire
// names) and the approval path (lookupBuilt) agree without shared state.

export const OPENAI_MAX_TOOL_NAME = 64;

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Deterministically shorten a tool name to ≤64 chars (identity when it
 *  already fits): 56-char prefix + "_" + 7-char base36 fnv1a suffix. */
export function openAiSafeToolName(name: string): string {
  if (name.length <= OPENAI_MAX_TOOL_NAME) return name;
  const suffix = fnv1a(name).toString(36).padStart(7, "0").slice(0, 7);
  return `${name.slice(0, OPENAI_MAX_TOOL_NAME - 8)}_${suffix}`;
}
