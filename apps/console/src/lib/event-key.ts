import type { Event } from "./events";

/** Pending-queue notifications (`system.user_message_pending` /
 *  `_promoted` / `_cancelled`). Neither runtime gives these frames a
 *  top-level `id`; they identify the queued input via `event_id` (plus a
 *  nested `event` on pending frames). CF promoted frames carry the promoted
 *  row's `seq`, which must not be used as their identity: it is the seq of
 *  the user event itself, not of the notification. */
const PENDING_QUEUE_FRAME = /^system\.user_message_(pending|promoted|cancelled)$/;

/** Stable identity across initial history, live events, and SSE replay. */
export function eventKey(event: Event): string {
  if (PENDING_QUEUE_FRAME.test(event.type)) {
    const nested = event.event as { id?: unknown } | undefined;
    const target =
      (typeof event.event_id === "string" && event.event_id) ||
      (typeof nested?.id === "string" && nested.id) ||
      "";
    if (target) return `${event.type}:${target}`;
    // No identity at all (legacy CF backfill emits event_id ""): fall back
    // to the queue position, then the full payload, so distinct frames
    // never collapse into one.
    if (event.pending_seq !== undefined) return `${event.type}:pending_seq:${String(event.pending_seq)}`;
    if (event.seq !== undefined) return `${event.type}:seq:${event.seq}`;
    return `${event.type}:${JSON.stringify(event)}`;
  }
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
