import type { AgentRecord } from "../types/agent";

/**
 * CONTRACT (step 0 baseline). Owner: C6b. Mounted by C6a on the agent's
 * Overview tab (the Model row). Renders nothing yet.
 *
 * Port of main's components/AgentModelSwitcher.tsx. A quick model +
 * reasoning chip (C6b's ModelReasoningPicker, fed by GET /v1/model_cards
 * limit=200). Each change saves a new agent version through the normal
 * update API (POST /v1/agents/:id with `version`), sending only what
 * changed: the default reasoning level (api-types DEFAULT_REASONING_LEVEL,
 * "medium") is stored as unset, a `{id, speed}` model keeps its speed.
 * Optimistic while saving, snaps back on failure (api() already reports
 * it). Calls `onSaved` with the saved agent.
 */
export interface AgentModelSwitcherProps {
  agent: AgentRecord;
  /** Called with the saved agent after a change was stored. The caller
   *  invalidates `/v1/agents/:id` and `/v1/agents/:id/versions`. */
  onSaved?: (agent: AgentRecord) => void;
}

export function AgentModelSwitcher(_props: AgentModelSwitcherProps) {
  return null;
}
