import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  DEFAULT_REASONING_LEVEL,
  isReasoningLevel,
  type ModelCard,
  type ReasoningLevel,
} from "@open-managed-agents/api-types";

import { useApi } from "../lib/api";
import { useApiQuery } from "../lib/useApiQuery";
import { ModelReasoningPicker, type ModelReasoningValue } from "./ModelReasoningPicker";

/**
 * The model and reasoning chip of one session's composer. A change applies
 * to the next turns of this session only: it is saved on the session
 * (`metadata.model` / `metadata.reasoning_level`, read by the harness each
 * turn), so it survives a reload, and the agent itself is never changed.
 * Choosing the agent's own value clears that override (null = follow the
 * agent). Unset reasoning follows the agent, and Medium when the agent has
 * none, never "Instant".
 *
 * Renders nothing until the session has loaded.
 */

export interface SessionModelPickerProps {
  sessionId: string;
  /** For example while a turn is being sent. */
  disabled?: boolean;
}

interface SessionRow {
  id: string;
  agent?: { id?: string; model?: string | { id: string }; reasoning_level?: ReasoningLevel };
  metadata?: Record<string, unknown>;
}

const MODEL_CARD_PARAMS = { limit: "200" };

function handleOf(model: string | { id: string } | undefined): string {
  return typeof model === "string" ? model : (model?.id ?? "");
}

/** What the session runs with (its override, else the agent's config), and
 *  the agent's own values as the defaults. */
export function sessionModelValue(session: SessionRow | undefined): {
  value: ModelReasoningValue;
  defaults: ModelReasoningValue;
} {
  const agentModel = handleOf(session?.agent?.model);
  const agentLevel = session?.agent?.reasoning_level;
  const meta = session?.metadata ?? {};
  const model = typeof meta.model === "string" && meta.model ? meta.model : agentModel;
  const level = isReasoningLevel(meta.reasoning_level) ? meta.reasoning_level : agentLevel;
  return {
    value: { model, level },
    defaults: { model: agentModel, level: agentLevel ?? DEFAULT_REASONING_LEVEL },
  };
}

export function SessionModelPicker({ sessionId, disabled }: SessionModelPickerProps) {
  const { api } = useApi();
  const qc = useQueryClient();
  const sessionPath = `/v1/sessions/${sessionId}`;
  const { data: session } = useApiQuery<SessionRow>(sessionPath);
  const { data: cardsRes } = useApiQuery<{ data: ModelCard[] }>("/v1/model_cards", MODEL_CARD_PARAMS);
  const [optimistic, setOptimistic] = useState<ModelReasoningValue | null>(null);
  const [saving, setSaving] = useState(false);

  if (!session) return null;
  const { value, defaults } = sessionModelValue(session);

  const change = async (next: ModelReasoningValue) => {
    setOptimistic(next);
    setSaving(true);
    try {
      const nextLevel = next.level ?? DEFAULT_REASONING_LEVEL;
      const updated = await api<SessionRow>(sessionPath, {
        method: "POST",
        body: JSON.stringify({
          metadata: {
            model: next.model === defaults.model ? null : next.model,
            reasoning_level: nextLevel === (defaults.level ?? DEFAULT_REASONING_LEVEL) ? null : nextLevel,
          },
        }),
      });
      qc.setQueryData([sessionPath, {}], (prev: SessionRow | undefined) => ({ ...(prev ?? {}), ...updated }));
    } catch {
      // api() already reports the failure; the chip goes back.
    } finally {
      setOptimistic(null);
      setSaving(false);
    }
  };

  return (
    <ModelReasoningPicker
      cards={cardsRes?.data ?? []}
      value={optimistic ?? value}
      defaults={defaults}
      onChange={(next) => void change(next)}
      disabled={disabled}
      saving={saving}
    />
  );
}
