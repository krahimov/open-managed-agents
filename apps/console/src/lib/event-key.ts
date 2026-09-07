import type { Event } from "./events";

/** Stable identity across initial history, live events, and SSE replay. */
export function eventKey(event: Event): string {
  if (event.id) return event.id;
  // Node tool results can lack an event id. Their call id survives both
  // REST and live delivery, even when only REST includes the sequence.
  const callId = event.tool_use_id ?? event.mcp_tool_use_id;
  if (callId) return `${event.type}:tool:${callId}`;
  if (event.seq !== undefined) return `seq:${event.seq}`;
  // Legacy events: retain time and the complete payload. Identical output
  // prefixes are common for screenshots and repeated shell commands.
  return `${event.type}:${JSON.stringify([event.ts, event.parent_event_id, event.content, event.error, event.message])}`;
}
