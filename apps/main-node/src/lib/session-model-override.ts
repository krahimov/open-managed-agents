// Per-session model / reasoning override.
//
// `session.metadata.model` (a model-card model_id) and
// `session.metadata.reasoning_level` beat the agent's configured values
// for THAT session only — the console composer picker writes them via
// POST /v1/sessions/:id { metadata }. The agent row is never touched.
//
// The registry overlays this on loadAgent's result every turn, so
// buildModel (card lookup + endpoint routing), buildTools and every
// harness (providerOptions, codex effort, claude-agent-sdk effort) see the
// effective values with no extra plumbing. Read fresh each turn, so a
// mid-session change applies on the next message.

import { isReasoningLevel, type AgentConfig } from "@open-managed-agents/shared";

export interface SessionModelOverride {
  model?: string;
  reasoning_level?: AgentConfig["reasoning_level"];
}

/** Pull the valid override fields out of a session metadata blob. Invalid
 *  values are ignored (never kill a turn over a bad metadata write). */
export function readSessionModelOverride(
  metadata: Record<string, unknown> | null | undefined,
): SessionModelOverride {
  if (!metadata) return {};
  const out: SessionModelOverride = {};
  if (isReasoningLevel(metadata.reasoning_level)) out.reasoning_level = metadata.reasoning_level;
  if (typeof metadata.model === "string" && metadata.model.trim()) out.model = metadata.model.trim();
  return out;
}

function handleOf(model: AgentConfig["model"]): string {
  return typeof model === "string" ? model : model.id;
}

/**
 * Overlay the session override on the agent config. `isKnownModel` guards
 * the model override: only a model the tenant actually has a card for is
 * honored, so a stray `metadata.model` (user tags, a deleted card) can't
 * break every turn — the agent's own model keeps running instead.
 */
export async function applySessionModelOverride(
  agent: AgentConfig,
  metadata: Record<string, unknown> | null | undefined,
  isKnownModel?: (modelId: string) => Promise<boolean>,
): Promise<AgentConfig> {
  const o = readSessionModelOverride(metadata);
  let next = agent;
  if (o.model && o.model !== handleOf(agent.model)) {
    const known = isKnownModel ? await isKnownModel(o.model).catch(() => false) : true;
    if (known) next = { ...next, model: o.model };
  }
  if (o.reasoning_level && o.reasoning_level !== next.reasoning_level) {
    next = { ...next, reasoning_level: o.reasoning_level };
  }
  return next;
}
