import { useEffect, useState } from "react";
import type { ModelCard } from "@open-managed-agents/api-types";

import { useApi } from "../../lib/api";
import type { AgentRecord } from "../../types/agent";
import type { RuntimeLite, SkillLite } from "./form/model";

type RuntimesResponse = { runtimes?: RuntimeLite[]; data?: RuntimeLite[] };

/**
 * What AgentFormDialog's pickers choose from (agents to delegate to, custom
 * skills, model keys, local runtimes), for a caller that does not already
 * hold them: the agent page's "All settings". `enabled` defers the reads
 * until the form is opened.
 *
 * A failed secondary read (skills, model keys, runtimes) leaves that picker
 * empty rather than blocking the form.
 */
export function useAgentFormAux(enabled = true) {
  const { api } = useApi();
  const [allAgents, setAllAgents] = useState<AgentRecord[]>([]);
  const [customSkills, setCustomSkills] = useState<SkillLite[]>([]);
  const [modelCards, setModelCards] = useState<ModelCard[]>([]);
  const [runtimes, setRuntimes] = useState<RuntimeLite[]>([]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const quiet = { silentErrors: true } as const;
    void Promise.allSettled([
      api<{ data: AgentRecord[] }>("/v1/agents?limit=200&status=any", quiet).then((r) => {
        if (!cancelled) setAllAgents(r.data ?? []);
      }),
      api<{ data: SkillLite[] }>("/v1/skills", quiet).then((r) => {
        if (!cancelled) setCustomSkills(r.data ?? []);
      }),
      api<{ data: ModelCard[] }>("/v1/model_cards?limit=200", quiet).then((r) => {
        if (!cancelled) setModelCards(r.data ?? []);
      }),
      api<RuntimesResponse>("/v1/runtimes", quiet).then((r) => {
        const rows = Array.isArray(r.runtimes) ? r.runtimes : Array.isArray(r.data) ? r.data : [];
        if (!cancelled) setRuntimes(rows);
      }),
    ]);
    return () => {
      cancelled = true;
    };
  }, [api, enabled]);

  return { allAgents, customSkills, modelCards, runtimes };
}
