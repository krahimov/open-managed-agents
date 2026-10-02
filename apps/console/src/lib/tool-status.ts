import type { Event } from "./events";

/**
 * Derived lifecycle of one tool call, shared by the Conversation view
 * (Tool cards + human-in-the-loop controls) and the Timeline (span
 * detail). Pure function of the event log so a reload reproduces exactly
 * what the live stream showed.
 *
 *   running            no result yet and nothing owed by the client
 *   awaiting_approval  session idled with requires_action/tool_confirmation
 *                      for this call (always_ask / policy-ask tools)
 *   awaiting_client    session idled with requires_action for a custom
 *                      tool; the client must post user.custom_tool_result
 *   responded          the client answered (allow / custom result) and the
 *                      runtime hasn't persisted the tool result yet
 *   completed          result present, not an error
 *   failed             result present with `is_error: true` (tool error,
 *                      crash-recovery placeholder, interrupted call, ...)
 *   denied             the user denied the call (user.tool_confirmation
 *                      result "deny"); the result carries the reason
 */
export type ToolCallStatus =
  | "running"
  | "awaiting_approval"
  | "awaiting_client"
  | "responded"
  | "completed"
  | "failed"
  | "denied";

export interface ToolCallInfo {
  status: ToolCallStatus;
  result?: Event;
  /** Denial reason (from the user.tool_confirmation) when status=denied. */
  denyMessage?: string;
}

export interface ToolCallIndex {
  info(toolUseId: string | undefined): ToolCallInfo;
  /** Tool-use ids the client currently owes an answer for. */
  awaiting: Map<string, "tool_confirmation" | "custom_tool_result">;
}

const USE_TYPES = new Set(["agent.tool_use", "agent.custom_tool_use", "agent.mcp_tool_use"]);

export function isErrorResult(result: Event | undefined): boolean {
  return Boolean(result && (result as { is_error?: unknown }).is_error === true);
}

export function buildToolCallIndex(events: Event[]): ToolCallIndex {
  const uses = new Map<string, Event>();
  const results = new Map<string, Event>();
  const confirmations = new Map<string, { result?: string; deny_message?: string }>();
  const customResults = new Set<string>();
  let lastStatus: Event | undefined;

  for (const e of events) {
    if (USE_TYPES.has(e.type) && typeof e.id === "string") uses.set(e.id, e);
    else if (e.type === "agent.tool_result" && e.tool_use_id) results.set(e.tool_use_id, e);
    else if (e.type === "agent.mcp_tool_result" && e.mcp_tool_use_id) results.set(e.mcp_tool_use_id, e);
    else if (e.type === "user.tool_confirmation" && e.tool_use_id) {
      confirmations.set(e.tool_use_id, e as { result?: string; deny_message?: string });
    } else if (e.type === "user.custom_tool_result") {
      const cid = (e as { custom_tool_use_id?: unknown }).custom_tool_use_id;
      if (typeof cid === "string") customResults.add(cid);
    } else if (
      e.type === "session.status_idle" ||
      e.type === "session.status_running" ||
      e.type === "session.status_rescheduled" ||
      e.type === "session.status_terminated"
    ) {
      lastStatus = e;
    }
  }

  const answered = (id: string) =>
    results.has(id) || confirmations.has(id) || customResults.has(id);

  // Only the most recent status matters: once the session runs again (or
  // terminates), the earlier requires_action no longer stands.
  const awaiting = new Map<string, "tool_confirmation" | "custom_tool_result">();
  const stop = lastStatus?.type === "session.status_idle"
    ? (lastStatus.stop_reason as { type?: string; action_type?: string; event_ids?: unknown } | undefined)
    : undefined;
  if (stop?.type === "requires_action") {
    let ids = Array.isArray(stop.event_ids)
      ? stop.event_ids.filter((x): x is string => typeof x === "string")
      : [];
    // Some emitters omit event_ids; fall back to calls that structurally
    // wait on the client (custom tools, ask-gated tools).
    if (ids.length === 0) {
      ids = [...uses.values()]
        .filter((u) => u.type === "agent.custom_tool_use" || u.evaluated_permission === "ask")
        .map((u) => u.id as string);
    }
    for (const id of ids) {
      if (answered(id)) continue;
      const use = uses.get(id);
      // Custom tools are always `agent.custom_tool_use`; built-in and MCP
      // calls owed by the client are ask-gated (needs confirmation). The
      // turn-level action_type only decides when the use event is unknown
      // (e.g. not loaded yet) since it reports one kind for mixed turns.
      const kind = use
        ? use.type === "agent.custom_tool_use" ? "custom_tool_result" : "tool_confirmation"
        : stop.action_type === "custom_tool_result" ? "custom_tool_result" : "tool_confirmation";
      awaiting.set(id, kind);
    }
  }

  return {
    awaiting,
    info(toolUseId) {
      if (!toolUseId) return { status: "running" };
      const result = results.get(toolUseId);
      const confirmation = confirmations.get(toolUseId);
      if (result) {
        if (confirmation?.result === "deny") {
          return {
            status: "denied",
            result,
            ...(confirmation.deny_message ? { denyMessage: confirmation.deny_message } : {}),
          };
        }
        return { status: isErrorResult(result) ? "failed" : "completed", result };
      }
      const owed = awaiting.get(toolUseId);
      if (owed) return { status: owed === "custom_tool_result" ? "awaiting_client" : "awaiting_approval" };
      if (confirmation || customResults.has(toolUseId)) return { status: "responded" };
      return { status: "running" };
    },
  };
}

/** Human label for timeline span details / tooltips. */
export const TOOL_STATUS_LABEL: Record<ToolCallStatus, string> = {
  running: "no result",
  awaiting_approval: "awaiting approval",
  awaiting_client: "waiting for client result",
  responded: "responded, awaiting result",
  completed: "completed",
  failed: "failed",
  denied: "denied",
};
