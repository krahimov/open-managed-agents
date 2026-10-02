// Tool side-effect classification + idempotency-key contract for durable
// tool execution. Shared by the default harness (apps/agent — stamps the
// class + key on write-ahead `agent.tool_use` events) and crash recovery
// (./recovery.ts — decides what to do with a tool_use whose result never
// landed). Pure functions, no runtime deps, so CF and Node agree byte-for-
// byte. See docs/durable-execution.md for the contract tool authors rely on.

import type { SessionEvent, ToolExecutionClass } from "@open-managed-agents/shared";

export type { ToolExecutionClass };

/**
 * Built-in tools that are read-only (or whose repetition has no additional
 * effect), so recovery may re-execute them after a crash. Everything not
 * listed here defaults to `side_effect` — the safe assumption for an
 * unknown tool is "it might have changed something".
 */
export const IDEMPOTENT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "read",
  "glob",
  "grep",
  "web_fetch",
  "web_search",
  "list_schedules",
  "list_ambient_rules",
  "find_skill",
  // tool-budget.ts discovery shim (lists deferred MCP tools; no effect)
  "search_mcp_tools",
  // browser-harness read-only ops
  "browser_screenshot",
  "browser_get_text",
]);

/** MCP tool annotations (MCP spec 2025-03-26+ `ToolAnnotations`). */
export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  idempotentHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
}

export interface ClassifyToolOptions {
  /** False when the tool has no server-side `execute` (custom tools,
   *  permission-gated `always_ask` tools) → `client`. */
  hasExecute?: boolean;
  /** MCP annotations advertised by the server in tools/list. */
  annotations?: McpToolAnnotations | null;
}

/**
 * Classify a tool call for crash recovery.
 *
 *   - no server-side execute → `client` (custom tool / awaiting confirmation;
 *     the result is user-driven and must never be invented)
 *   - built-in read-only tools → `idempotent`
 *   - MCP tools → `idempotent` only when the server annotates them
 *     `readOnlyHint: true` or `idempotentHint: true`; otherwise `side_effect`
 *   - everything else (bash, write, edit, schedule, cancel_schedule,
 *     call_agent_*, unannotated MCP, …) → `side_effect`
 */
export function classifyTool(name: string, opts: ClassifyToolOptions = {}): ToolExecutionClass {
  if (opts.hasExecute === false) return "client";
  if (IDEMPOTENT_TOOL_NAMES.has(name)) return "idempotent";
  const a = opts.annotations;
  if (a && (a.readOnlyHint === true || a.idempotentHint === true)) return "idempotent";
  return "side_effect";
}

/**
 * Idempotency key for one tool call: `${sessionId}:${toolCallId}`. Stable
 * across in-process retries, crash recovery and turn resume because the
 * toolCallId is minted by the model once and persisted in the write-ahead
 * `agent.tool_use` event before the tool runs. Falls back to the bare
 * toolCallId when the caller has no session id (tests, legacy callers).
 */
export function idempotencyKeyFor(sessionId: string | undefined | null, toolCallId: string): string {
  return sessionId ? `${sessionId}:${toolCallId}` : toolCallId;
}

type ToolUseType = "agent.tool_use" | "agent.mcp_tool_use" | "agent.custom_tool_use";

/** A tool_use event (any flavor) with no matching result in the log. */
export interface OrphanToolUse {
  tool_use_id: string;
  event_type: ToolUseType;
  name?: string;
  input?: Record<string, unknown>;
  execution_class: ToolExecutionClass;
  idempotency_key?: string;
  session_thread_id?: string;
}

/**
 * Resolve the recovery class of a persisted tool_use event. Events written
 * by the durable harness carry `execution_class`; older events fall back
 * to the name-based table (and legacy semantics for custom tool uses).
 * `evaluated_permission: "ask"` means the call is parked awaiting a
 * `user.tool_confirmation` — client-owned, never auto-resolved.
 */
export function executionClassOf(event: {
  type: string;
  name?: string;
  execution_class?: ToolExecutionClass;
  evaluated_permission?: string;
}): ToolExecutionClass {
  if (event.evaluated_permission === "ask") return "client";
  if (event.execution_class) return event.execution_class;
  if (event.type === "agent.custom_tool_use") return "client";
  if (event.type === "agent.mcp_tool_use") return "side_effect";
  return classifyTool(event.name ?? "");
}

/**
 * Scan an event list for tool_use events that never got a result. Pairing
 * key is always the use's own `id` (see default-loop emitToolCallEvent):
 *   agent.tool_use / agent.custom_tool_use → agent.tool_result.tool_use_id
 *                                            or user.custom_tool_result.custom_tool_use_id
 *   agent.mcp_tool_use                     → agent.mcp_tool_result.mcp_tool_use_id
 * Returned in log order.
 */
export function findOrphanToolUses(events: readonly SessionEvent[]): OrphanToolUse[] {
  const uses = new Map<string, OrphanToolUse>();
  const resolved = new Set<string>();
  for (const e of events) {
    const ev = e as unknown as {
      type: string;
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
      tool_use_id?: string;
      mcp_tool_use_id?: string;
      custom_tool_use_id?: string;
      execution_class?: ToolExecutionClass;
      evaluated_permission?: string;
      idempotency_key?: string;
      session_thread_id?: string;
    };
    switch (ev.type) {
      case "agent.tool_use":
      case "agent.mcp_tool_use":
      case "agent.custom_tool_use":
        if (ev.id) {
          uses.set(ev.id, {
            tool_use_id: ev.id,
            event_type: ev.type,
            name: ev.name,
            input: ev.input,
            execution_class: executionClassOf(ev),
            ...(ev.idempotency_key ? { idempotency_key: ev.idempotency_key } : {}),
            ...(ev.session_thread_id ? { session_thread_id: ev.session_thread_id } : {}),
          });
        }
        break;
      case "agent.tool_result":
        if (ev.tool_use_id) resolved.add(ev.tool_use_id);
        break;
      case "agent.mcp_tool_result":
        if (ev.mcp_tool_use_id) resolved.add(ev.mcp_tool_use_id);
        break;
      case "user.custom_tool_result":
        if (ev.custom_tool_use_id) resolved.add(ev.custom_tool_use_id);
        // Legacy rows keyed the result by the event's own id.
        if (ev.id) resolved.add(ev.id);
        break;
    }
  }
  return [...uses.values()].filter((u) => !resolved.has(u.tool_use_id));
}

/**
 * Build the result event recovery appends for an interrupted tool call.
 * Always `is_error: true` — the model must not mistake it for real output.
 *
 *   side_effect → "started but crashed before completion; it MAY have taken
 *                 effect; verify state before retrying" + idempotency key
 *   idempotent  → "interrupted before it returned; safe to re-run"
 *
 * Returns null for `client` calls (never fabricated).
 */
export function buildInterruptedToolResult(orphan: OrphanToolUse): SessionEvent | null {
  if (orphan.execution_class === "client") return null;
  const name = orphan.name ?? "unknown";
  const keyNote = orphan.idempotency_key ? ` (idempotency_key=${orphan.idempotency_key})` : "";
  const content = orphan.execution_class === "idempotent"
    ? `Tool call "${name}" was interrupted by an agent process restart before it returned${keyNote}. ` +
      `It is read-only/idempotent, so it is safe to call it again if you still need the result.`
    : `Tool call "${name}" was interrupted: it was started but the agent process crashed before it completed${keyNote}. ` +
      `It MAY have taken effect. Verify the current state (e.g. inspect files, list resources, ` +
      `check the remote system) before retrying — do not blindly repeat it.` +
      (orphan.idempotency_key
        ? ` If you retry and the target system supports idempotency keys, reuse ${orphan.idempotency_key}.`
        : "");
  const thread = orphan.session_thread_id ? { session_thread_id: orphan.session_thread_id } : {};
  if (orphan.event_type === "agent.mcp_tool_use") {
    return {
      type: "agent.mcp_tool_result",
      mcp_tool_use_id: orphan.tool_use_id,
      content,
      is_error: true,
      parent_event_id: orphan.tool_use_id,
      ...thread,
    } as SessionEvent;
  }
  return {
    type: "agent.tool_result",
    tool_use_id: orphan.tool_use_id,
    content,
    is_error: true,
    parent_event_id: orphan.tool_use_id,
    ...thread,
  } as SessionEvent;
}
