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
 * Composer chip for a session: switches model + reasoning for the following
 * turns of THIS session only. Persisted server-side as the session override
 * (`metadata.model` / `metadata.reasoning_level`, honored by the harness each
 * turn) so it survives reload; the agent's own config is never touched.
 * Picking the agent's own value clears that override key (null = inherit).
 */

interface SessionRow {
  id: string;
  agent?: { id?: string; model?: string | { id: string }; reasoning_level?: ReasoningLevel };
  metadata?: Record<string, unknown>;
}

const MODEL_CARD_PARAMS = { limit: "200" };

function handleOf(model: string | { id: string } | undefined): string {
  return typeof model === "string" ? model : model?.id ?? "";
}

/** Effective session values: override first, then the agent's config. */
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

export function SessionModelPicker({
  sessionId,
  disabled,
}: {
  sessionId: string;
  disabled?: boolean;
}) {
  const { api } = useApi();
  const qc = useQueryClient();
  const sessionPath = `/v1/sessions/${sessionId}`;
  const { data: session } = useApiQuery<SessionRow>(sessionPath);
  const { data: cardsRes } = useApiQuery<{ data: ModelCard[] }>("/v1/model_cards", MODEL_CARD_PARAMS);
  const [optimistic, setOptimistic] = useState<ModelReasoningValue | null>(null);
  const [saving, setSaving] = useState(false);

  if (!session) return null;
  const { value, defaults } = sessionModelValue(session);
  const shown = optimistic ?? value;

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
      qc.setQueryData([sessionPath, {}], updated);
    } catch {
      // api() already toasts the error; the chip snaps back.
    } finally {
      setOptimistic(null);
      setSaving(false);
    }
  };

  return (
    <ModelReasoningPicker
      cards={cardsRes?.data ?? []}
      value={shown}
      defaults={defaults}
      onChange={(next) => void change(next)}
      disabled={disabled}
      saving={saving}
    />
  );
}
