// Human-in-the-loop helpers shared by the session runtimes.
//
// Everything here is a pure function over the event log so the runtime
// doesn't need side state (CF keeps `pending_tool_calls` in DO state; the
// Node runtime has no equivalent and derives the same facts from events):
//
//   - which tool uses are still waiting for a result
//   - which of them the last `session.status_idle` asked the client about
//     (stop_reason.requires_action.event_ids)
//   - the stop_reason a turn should end with
//   - an agent config variant with `always_ask` / policy-ask lifted, used
//     to rebuild a tool WITH its execute function once the user allowed it
//
// Pairing mirrors findOrphanToolUses (tool-classification.ts):
// agent.tool_result closes agent.tool_use / agent.custom_tool_use by
// `tool_use_id` (user.custom_tool_result by `custom_tool_use_id`);
// agent.mcp_tool_result closes agent.mcp_tool_use by `mcp_tool_use_id`.

import type { AgentConfig, SessionEvent } from "@open-managed-agents/shared";

export type ToolUseEventType =
  | "agent.tool_use"
  | "agent.mcp_tool_use"
  | "agent.custom_tool_use";

export interface UnresolvedToolUse {
  id: string;
  type: ToolUseEventType;
  name: string;
  input: Record<string, unknown>;
  /** "ask" when the harness emitted the call without an execute fn. */
  evaluated_permission?: string;
  /** Stamped by the default harness (docs/durable-execution.md). */
  execution_class?: string;
  idempotency_key?: string;
}

export type TurnStopReason =
  | { type: "end_turn" }
  | {
      type: "requires_action";
      action_type: "tool_confirmation" | "custom_tool_result";
      event_ids: string[];
    };

/** Tool uses in `events` with no matching result, in log order. */
export function findUnresolvedToolUses(events: SessionEvent[]): UnresolvedToolUse[] {
  const uses = new Map<string, UnresolvedToolUse>();
  for (const e of events) {
    const ev = e as unknown as Record<string, unknown> & { type: string };
    if (ev.cancelled_at_ms != null) continue;
    switch (ev.type) {
      case "agent.tool_use":
      case "agent.mcp_tool_use":
      case "agent.custom_tool_use":
        if (typeof ev.id === "string") {
          uses.set(ev.id, {
            id: ev.id,
            type: ev.type as ToolUseEventType,
            name: String(ev.name ?? ""),
            input: (ev.input ?? {}) as Record<string, unknown>,
            ...(typeof ev.evaluated_permission === "string"
              ? { evaluated_permission: ev.evaluated_permission }
              : {}),
            ...(typeof ev.execution_class === "string" ? { execution_class: ev.execution_class } : {}),
            ...(typeof ev.idempotency_key === "string" ? { idempotency_key: ev.idempotency_key } : {}),
          });
        }
        break;
      case "agent.tool_result":
        if (typeof ev.tool_use_id === "string") uses.delete(ev.tool_use_id);
        break;
      case "agent.mcp_tool_result":
        if (typeof ev.mcp_tool_use_id === "string") uses.delete(ev.mcp_tool_use_id);
        break;
      case "user.custom_tool_result":
        // Same pairing as findOrphanToolUses (tool-classification.ts).
        if (typeof ev.custom_tool_use_id === "string") uses.delete(ev.custom_tool_use_id);
        break;
    }
  }
  return [...uses.values()];
}

/**
 * Tool-use ids the most recent `session.status_idle` handed to the client
 * as requires_action, minus any that have since been resolved. This is
 * the "is everything the client owes us in?" check for resuming a turn.
 */
export function outstandingRequiredActions(events: SessionEvent[]): string[] {
  let asked: string[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i] as unknown as {
      type: string;
      stop_reason?: { type?: string; event_ids?: string[] };
    };
    if (ev.type !== "session.status_idle") continue;
    if (ev.stop_reason?.type === "requires_action") asked = ev.stop_reason.event_ids ?? [];
    break;
  }
  if (asked.length === 0) return [];
  const unresolved = new Set(findUnresolvedToolUses(events).map((u) => u.id));
  return asked.filter((id) => unresolved.has(id));
}

/**
 * Stop reason for a finished turn. `pendingIds` are the tool calls the
 * harness left without a result (HarnessRuntime.pendingConfirmations);
 * when the harness doesn't report them we fall back to the calls that are
 * structurally waiting on the client (custom tools, `ask`-gated tools).
 */
export function computeStopReason(
  events: SessionEvent[],
  pendingIds?: string[] | null,
): TurnStopReason {
  const unresolved = findUnresolvedToolUses(events);
  const waiting = pendingIds
    ? unresolved.filter((u) => pendingIds.includes(u.id))
    : unresolved.filter(
        (u) => u.type === "agent.custom_tool_use" || u.evaluated_permission === "ask",
      );
  if (waiting.length === 0) return { type: "end_turn" };
  return {
    type: "requires_action",
    action_type: waiting.some((u) => u.type === "agent.custom_tool_use")
      ? "custom_tool_result"
      : "tool_confirmation",
    event_ids: waiting.map((u) => u.id),
  };
}

/** Result event closing `use` (tool_result vs mcp_tool_result shape). */
export function toolResultEventFor(
  use: Pick<UnresolvedToolUse, "id" | "type">,
  content: string,
  isError = false,
): SessionEvent {
  if (use.type === "agent.mcp_tool_use") {
    return {
      type: "agent.mcp_tool_result",
      mcp_tool_use_id: use.id,
      content,
      ...(isError ? { is_error: true } : {}),
      parent_event_id: use.id,
    } as unknown as SessionEvent;
  }
  return {
    type: "agent.tool_result",
    tool_use_id: use.id,
    content,
    // v1-additive (docs/trajectory-v1-spec.md "Causality"): the matching
    // tool_use's EventBase.id IS the tool_use_id.
    parent_event_id: use.id,
  } as unknown as SessionEvent;
}

/**
 * Agent config with every ask-gate lifted: toolset permission policies
 * dropped (getToolPermission falls back to always_allow) and `ask` rules
 * removed from the pinned effective policy. `deny` rules stay, so a tool
 * the policy hides can't be resurrected by a forged confirmation. Only
 * used to rebuild the tool dict for executing a call the user allowed.
 */
export function withAskGatesLifted(agent: AgentConfig): AgentConfig {
  const tools = (agent.tools ?? []).map((t) => {
    if ((t as { type?: string }).type === "custom") return t;
    const ts = t as unknown as {
      default_config?: Record<string, unknown>;
      configs?: Array<Record<string, unknown>>;
    };
    const strip = (c?: Record<string, unknown>) => {
      if (!c) return c;
      const { permission_policy: _drop, ...rest } = c;
      return rest;
    };
    return {
      ...ts,
      ...(ts.default_config ? { default_config: strip(ts.default_config) } : {}),
      ...(ts.configs ? { configs: ts.configs.map((c) => strip(c)!) } : {}),
    } as unknown as (typeof agent.tools)[number];
  });
  const policy = (agent as { effective_policy?: { rules?: Array<{ effect?: string }> } })
    .effective_policy;
  return {
    ...agent,
    tools,
    ...(policy?.rules
      ? {
          effective_policy: {
            ...policy,
            rules: policy.rules.filter((r) => r.effect !== "ask"),
          },
        }
      : {}),
  } as AgentConfig;
}
