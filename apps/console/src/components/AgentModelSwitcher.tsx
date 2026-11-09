import { useState } from "react";
import { toast } from "sonner";
import {
  DEFAULT_REASONING_LEVEL,
  type ModelCard,
  type ReasoningLevel,
} from "@open-managed-agents/api-types";
import { useApi } from "../lib/api";
import { useApiQuery } from "../lib/useApiQuery";
import type { AgentRecord as Agent } from "../types/agent";
import { ModelReasoningPicker, type ModelReasoningValue } from "./ModelReasoningPicker";

/**
 * Quick model + reasoning switcher for the agent page. Each change saves a
 * new agent version through the normal update API (POST /v1/agents/:id) —
 * the same path the full edit form uses — so running sessions keep their
 * snapshot and new sessions pick the change up.
 */

const MODEL_CARD_PARAMS = { limit: "200" };

function handleOf(model: Agent["model"]): string {
  return typeof model === "string" ? model : model?.id ?? "";
}

/** Update body for a switcher change: only the fields that changed. The
 *  default level is stored as unset; a `{id, speed}` model keeps its speed. */
export function agentModelPatch(
  agent: Pick<Agent, "model" | "version" | "_oma">,
  next: ModelReasoningValue,
): Record<string, unknown> | null {
  const body: Record<string, unknown> = {};
  if (next.model !== handleOf(agent.model)) {
    body.model =
      typeof agent.model === "object" && agent.model?.speed
        ? { id: next.model, speed: agent.model.speed }
        : next.model;
  }
  const current: ReasoningLevel = agent._oma?.reasoning_level ?? DEFAULT_REASONING_LEVEL;
  const desired: ReasoningLevel = next.level ?? DEFAULT_REASONING_LEVEL;
  if (desired !== current) {
    body._oma = { reasoning_level: desired === DEFAULT_REASONING_LEVEL ? null : desired };
  }
  if (Object.keys(body).length === 0) return null;
  body.version = agent.version;
  return body;
}

export function AgentModelSwitcher({
  agent,
  onSaved,
}: {
  agent: Agent;
  onSaved?: (agent: Agent) => void;
}) {
  const { api } = useApi();
  const { data: cardsRes } = useApiQuery<{ data: ModelCard[] }>("/v1/model_cards", MODEL_CARD_PARAMS);
  const [optimistic, setOptimistic] = useState<ModelReasoningValue | null>(null);
  const [saving, setSaving] = useState(false);
  // Local-runtime agents bring their own model — nothing to switch.
  if (agent._oma?.runtime_binding) return <span>{handleOf(agent.model)}</span>;

  const value: ModelReasoningValue = {
    model: handleOf(agent.model),
    level: agent._oma?.reasoning_level,
  };

  const change = async (next: ModelReasoningValue) => {
    const body = agentModelPatch(agent, next);
    if (!body || saving) return;
    setOptimistic(next);
    setSaving(true);
    try {
      const saved = await api<Agent>(`/v1/agents/${agent.id}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      toast.success(`Saved — version ${saved.version}`);
      onSaved?.(saved);
    } catch {
      // api() already toasts the error.
    } finally {
      setOptimistic(null);
      setSaving(false);
    }
  };

  return (
    <ModelReasoningPicker
      cards={cardsRes?.data ?? []}
      value={optimistic ?? value}
      onChange={(next) => void change(next)}
      saving={saving}
      disabled={saving}
      side="bottom"
      align="start"
      className="-ml-2"
    />
  );
}
