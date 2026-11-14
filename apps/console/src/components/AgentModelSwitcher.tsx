import { useState } from "react";
import { toast } from "sonner";
import { DEFAULT_REASONING_LEVEL, type ModelCard, type ReasoningLevel } from "@open-managed-agents/api-types";

import { useApi } from "../lib/api";
import { useApiQuery } from "../lib/useApiQuery";
import type { AgentRecord } from "../types/agent";
import { ModelReasoningPicker, type ModelReasoningValue } from "./ModelReasoningPicker";

/**
 * The quick model and reasoning switcher on the agent page (the Model row
 * of Overview). Each change saves a new agent version through the normal
 * update (POST /v1/agents/:id, guarded by `version`), so sessions already
 * running keep what they started with and new ones pick the change up.
 *
 * Only what changed is sent: the default reasoning level is stored as
 * unset, and a `{ id, speed }` model keeps its speed. While saving the chip
 * shows the new choice; a failure puts it back (api() reports why).
 */

export interface AgentModelSwitcherProps {
  agent: AgentRecord;
  /** Called with the saved agent after a change was stored. The caller
   *  invalidates `/v1/agents/:id` and `/v1/agents/:id/versions`. */
  onSaved?: (agent: AgentRecord) => void;
}

const MODEL_CARD_PARAMS = { limit: "200" };

function handleOf(model: AgentRecord["model"]): string {
  return typeof model === "string" ? model : (model?.id ?? "");
}

/** The update body for a switcher change: only the fields that changed,
 *  with the version guard. Null when nothing changed. */
export function agentModelPatch(
  agent: Pick<AgentRecord, "model" | "version" | "_oma">,
  next: ModelReasoningValue,
): Record<string, unknown> | null {
  const body: Record<string, unknown> = {};
  if (next.model !== handleOf(agent.model)) {
    body.model =
      typeof agent.model === "object" && agent.model?.speed ? { id: next.model, speed: agent.model.speed } : next.model;
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

export function AgentModelSwitcher({ agent, onSaved }: AgentModelSwitcherProps) {
  const { api } = useApi();
  const { data: cardsRes } = useApiQuery<{ data: ModelCard[] }>("/v1/model_cards", MODEL_CARD_PARAMS);
  const [optimistic, setOptimistic] = useState<ModelReasoningValue | null>(null);
  const [saving, setSaving] = useState(false);

  // An agent on a local runtime brings its own model: nothing to switch.
  if (agent._oma?.runtime_binding) {
    return <span className="text-small text-fg-muted">Chosen by the agent on its machine</span>;
  }

  const value: ModelReasoningValue = { model: handleOf(agent.model), level: agent._oma?.reasoning_level };

  const change = async (next: ModelReasoningValue) => {
    const body = agentModelPatch(agent, next);
    if (!body || saving) return;
    setOptimistic(next);
    setSaving(true);
    try {
      const saved = await api<AgentRecord>(`/v1/agents/${agent.id}`, { method: "POST", body: JSON.stringify(body) });
      toast.success(`Saved as version ${saved.version}`);
      onSaved?.(saved);
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
      onChange={(next) => void change(next)}
      saving={saving}
      disabled={saving}
      side="bottom"
      align="start"
      className="-ml-3"
    />
  );
}
