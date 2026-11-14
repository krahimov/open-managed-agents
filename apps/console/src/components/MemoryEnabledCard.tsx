import type { Event } from "../lib/events";

/**
 * CONTRACT (step 0 baseline). Owner: C6b. Rendered by C3 (ConversationView,
 * card kind `memory_enabled`) and C6b (SessionChat). Renders nothing yet.
 *
 * Port of main's components/MemoryEnabledCard.tsx in Muse's card family
 * (the same EventCard family as the ambient-rule card it usually lands
 * under). For a `system.memory_enabled` event: memory was just switched on
 * for the agent, by its enable_memory setup tool or automatically with a
 * new schedule. Shows the store (link to /memory/:store_id by name), what
 * it applies to (`per_user`: "every new session, one store per user";
 * otherwise "every new session of this agent, scheduled runs included"),
 * and, when `source === "ambient_rule"`, why ("turned on with the
 * schedule, each run is a fresh session"). Ends with a plain sentence that
 * it can be turned off on the agent page.
 *
 * Event fields read: mode, store_id, store_name, source.
 */
export interface MemoryEnabledCardProps {
  /** The `system.memory_enabled` event. */
  event: Event;
}

export function MemoryEnabledCard(_props: MemoryEnabledCardProps) {
  return null;
}
