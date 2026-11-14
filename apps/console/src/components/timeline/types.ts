import type { Event } from "../../lib/events";

/**
 * Layout constants, in pixels. The waterfall does its own arithmetic
 * (label column + chart + duration column), so these are the single source
 * of truth for both the styles and the maths.
 */
export const LABEL_COL_W = 272;
export const DURATION_COL_W = 76;
export const SIDE_PANEL_W = 420;
export const ROW_H = 34;

/**
 * One row in the timeline waterfall. A span can be an instant marker
 * (durationMs === 0) or a paired range (start + end events). Rendering
 * consumes only this shape; deriveSpans converts raw event streams to
 * Span[].
 */
export interface Span {
  key: string;
  family: SpanFamily;
  label: string;
  detail?: string;
  /** ms since the first event */
  startMs: number;
  /** 0 for instants */
  durationMs: number;
  /** Optional: ms from this span's start to first-token (model spans only).
   *  Used to render a TTFT divider inside the bar. */
  ttftMs?: number;
  /** App / MCP server name for mcp spans, shown before the label. */
  source?: string;
  /** The span failed (tool error, model error). */
  failed?: boolean;
  /** The label is words ("Asked PR Reviewer"), not a tool's name: set it in the text face. */
  plain?: boolean;
  /** Source events that contributed to this span (1 for instants,
   *  2 for paired spans, possibly more for tool calls with streaming
   *  input chunks). Click-to-expand renders the raw JSON of these. */
  events: Event[];
}

export type SpanFamily =
  | "model"
  | "tool"
  | "mcp"
  | "custom_tool"
  | "user"
  | "agent"
  | "system"
  | "warn"
  | "error"
  | "schedule"     // schedule tool's "waiting for alarm" window (10s, 1h, …)
  | "wakeup"       // user.message synthesized by onScheduledWakeup
  | "compaction"   // span.compaction_summarize_*
  | "outcome"      // span.outcome_evaluation_*
  | "thread"       // sub-agent thread lifecycle / messages
  | "aux"          // aux.model_call (web_fetch summarizer etc.)
  | "thinking"     // agent.thinking marker
  | "approval"     // a tool call waiting on a person
  | "marker";      // catch-all for unrecognized event types

/**
 * Colour by KIND of work, fixed across the product (DESIGN.md 9.3). Values
 * are CSS colours so bars, dots and legend swatches share one source.
 *
 * The three kinds of work wear the category family (index.css --kind-*),
 * which no provider and no status uses: apricot and teal mean Anthropic and
 * OpenAI on the model badges beside this chart, so they can never also mean
 * "scheduled wait" or "tools" here. The family is stepped in lightness, so
 * the kinds stay apart for colour-blind readers too; every row also carries
 * its icon and name.
 *
 *   model      plum     the model is generating
 *   tool       indigo   a built-in or custom tool is running
 *   mcp        lilac    a call to a connected app
 *   schedule   neutral  asleep until a scheduled wake-up (not work: no hue)
 *   approval   amber    waiting on a person          (status colour)
 *   error      red      something failed             (status colour)
 *   everything else is a neutral marker
 */
export type SpanKind = "model" | "tool" | "mcp" | "schedule" | "approval" | "error" | "thinking" | "message" | "system";

export const KIND_COLOR: Record<SpanKind, string> = {
  model: "var(--kind-model)",
  tool: "var(--kind-tool)",
  mcp: "var(--kind-app)",
  schedule: "var(--kind-wait)",
  approval: "var(--warning-solid)",
  error: "var(--danger-solid)",
  thinking: "var(--chart-other)",
  message: "var(--fg)",
  system: "var(--fg-faint)",
};

export const KIND_LABEL: Record<SpanKind, string> = {
  model: "Model",
  tool: "Tools",
  mcp: "Apps",
  schedule: "Scheduled wait",
  approval: "Waiting for approval",
  error: "Error",
  thinking: "Thinking",
  message: "Messages",
  system: "System",
};

export const FAMILY_KIND: Record<SpanFamily, SpanKind> = {
  model: "model",
  tool: "tool",
  custom_tool: "tool",
  mcp: "mcp",
  user: "message",
  agent: "message",
  wakeup: "message",
  system: "system",
  warn: "approval",
  error: "error",
  schedule: "schedule",
  compaction: "system",
  outcome: "model",
  thread: "system",
  aux: "model",
  thinking: "thinking",
  approval: "approval",
  marker: "system",
};

/**
 * A "turn" is the unit of agent work between a user trigger event
 * (user.message / user.tool_confirmation / user.custom_tool_result) and
 * the next session.status_idle / .status_terminated / .error. This is the
 * same definition the harness uses internally (see drainEventQueue in
 * apps/agent/src/runtime/session-do.ts) and matches Conversation view's
 * notion of a turn — so a Timeline burst card lines up 1:1 with a chat
 * exchange.
 */
export type TurnTriggerKind =
  | "user_message"
  | "wakeup"
  | "tool_confirmation"
  | "custom_tool_result"
  | "init";

/**
 * `approval`: the turn stopped to ask a person, and nobody has answered yet.
 * `awaiting_client`: the turn stopped for a custom tool's result, which the
 * app that runs the session sends back. Neither has completed: the next
 * turn starts with the answer.
 */
export type TurnStatus = "completed" | "running" | "errored" | "terminated" | "approval" | "awaiting_client";

export interface Turn {
  id: string;
  triggerKind: TurnTriggerKind;
  trigger?: Event;
  /** Wall-clock ms epoch of the trigger (or first event for init turn). */
  triggerTs: number;
  /** Inclusive: trigger event + everything until the closing status event. */
  events: Event[];
  status: TurnStatus;
  /** Wall-clock ms epoch when the turn closed; undefined while still running. */
  endedAt?: number;
}

export const TRIGGER_LABEL: Record<TurnTriggerKind, string> = {
  user_message: "You",
  wakeup: "Scheduled wake-up",
  tool_confirmation: "Approval decision",
  custom_tool_result: "Tool result returned",
  init: "Session start",
};

/**
 * What's currently selected for the side detail panel. Lifted up to
 * TimelineView so a click in any TurnCard updates one shared panel.
 */
export interface TimelineSelection {
  turnId: string;
  span: Span;
}
