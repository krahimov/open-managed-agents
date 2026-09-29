import { useEffect, useState } from "react";
import type { ModelCard } from "@open-managed-agents/api-types";
import { useApi } from "../../lib/api";
import type { AgentRecord as Agent } from "../../types/agent";

type Runtime = {
  id: string;
  hostname: string;
  status: string;
  agents: Array<{ id: string }>;
  /** Skills daemon detected locally on the user's machine, keyed by acp
   *  agent id. Source for the blocklist multi-select that appears when
   *  the user picks an acp agent. */
  local_skills?: Record<
    string,
    Array<{
      id: string;
      name?: string;
      description?: string;
      source?: string;
      source_label?: string;
    }>
  >;
};
type RuntimesResponse = { runtimes?: Runtime[]; data?: Runtime[] };

/**
 * Data sets AgentFormDialog's pickers pull from (callable agents, custom
 * skills, model cards, local runtimes). Shared by the agents list (create)
 * and the agent page (edit); `enabled` defers the fetch until needed.
 *
 * Pulls all agents (for the callable-agents dropdown) separately so it isn't
 * constrained by a list page size. Failures of the secondary fetches
 * (skills / model cards / runtimes) are tolerated and logged: missing data
 * degrades a dropdown but shouldn't block agent CRUD. Failures of the primary
 * `/v1/agents` call surface via the toast that `useApi` raises automatically.
 */
export function useAgentFormAux(enabled = true) {
  const { api } = useApi();
  const [allAgents, setAllAgents] = useState<Agent[]>([]);
  const [customSkills, setCustomSkills] = useState<
    Array<{ id: string; name: string; description: string }>
  >([]);
  const [modelCards, setModelCards] = useState<ModelCard[]>([]);
  const [runtimes, setRuntimes] = useState<Runtime[]>([]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void (async () => {
      const all = await api<{ data: Agent[] }>("/v1/agents?limit=200&status=any");
      if (cancelled) return;
      setAllAgents(all.data);
      await Promise.allSettled([
        (async () => {
          const sk = await api<{
            data: Array<{ id: string; name: string; description: string }>;
          }>("/v1/skills");
          if (!cancelled) setCustomSkills(sk.data);
        })().catch((e) => console.warn("[agent-form] /v1/skills aux fetch failed", e)),
        (async () => {
          const mc = await api<{ data: ModelCard[] }>("/v1/model_cards?limit=200");
          if (!cancelled) setModelCards(mc.data);
        })().catch((e) => console.warn("[agent-form] /v1/model_cards aux fetch failed", e)),
        (async () => {
          const rt = await api<RuntimesResponse>("/v1/runtimes");
          const rows = Array.isArray(rt.runtimes)
            ? rt.runtimes
            : Array.isArray(rt.data)
              ? rt.data
              : [];
          if (!cancelled) setRuntimes(rows);
        })().catch((e) => console.warn("[agent-form] /v1/runtimes aux fetch failed", e)),
      ]);
    })().catch(() => {
      /* api() surfaces the error */
    });
    return () => {
      cancelled = true;
    };
  }, [api, enabled]);

  return { allAgents, customSkills, modelCards, runtimes };
}
