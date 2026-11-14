/**
 * CONTRACT (step 0 baseline). Owner: C6b. Rendered by C4 in the chip slot
 * of SessionComposer, and by C6b in SessionChat. Renders nothing yet.
 *
 * Port of main's components/SessionModelPicker.tsx. A model + reasoning
 * chip for one running session. Reads `GET /v1/sessions/:id` (the agent's
 * snapshot model and reasoning_level are the defaults; `metadata.model` /
 * `metadata.reasoning_level` are the session's overrides) and
 * GET /v1/model_cards (limit=200). A change posts
 * `POST /v1/sessions/:id { metadata: { model, reasoning_level } }`, writing
 * null for a value equal to the default; it applies from the next turn.
 * Optimistic while saving, snaps back on failure. Renders nothing until the
 * session has loaded. Unset reasoning means "inherit" (medium on main),
 * never "Instant".
 */
export interface SessionModelPickerProps {
  sessionId: string;
  /** For example while a turn is being sent. */
  disabled?: boolean;
}

export function SessionModelPicker(_props: SessionModelPickerProps) {
  return null;
}
