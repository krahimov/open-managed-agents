import type { InfiniteData, QueryClient } from "@tanstack/react-query";

import type { useApi } from "../../lib/api";
import { loadAgentMachine, type MachineResponse } from "../../components/AgentComputerPanel";
import type { AgentRecord as Agent } from "../../types/agent";

/**
 * Deleting an agent, shared by its page and the agents list: ask whether a
 * computer goes with it (for the confirmation), then clear it out of the
 * cache so no list shows it and nothing asks the server about it again.
 */

/** True for every cached query about one agent: its own record and the
 *  paths under it (/v1/agents/:id/…, /v1/integrations/…/agents/:id/…). */
const isAgentQuery = (agentId: string) => ({ queryKey }: { queryKey: readonly unknown[] }) => {
  const path = queryKey[0];
  return typeof path === "string" && (path === `/v1/agents/${agentId}` || path.includes(`/agents/${agentId}/`));
};

/** After a delete: take the agent out of the cached agent lists (so a list
 *  does not show it while it refetches), mark every agent list stale, and
 *  stop any fetch about the agent in flight. Its own cached queries are
 *  dropped by `dropAgentQueries` once nothing on screen observes them. */
export function forgetDeletedAgent(qc: QueryClient, agentId: string) {
  qc.setQueriesData<InfiniteData<{ data: Agent[] }>>(
    { queryKey: ["/v1/agents", "infinite"] },
    (old) =>
      old && {
        ...old,
        pages: old.pages.map((page) => ({ ...page, data: (page.data ?? []).filter((a) => a.id !== agentId) })),
      },
  );
  void qc.invalidateQueries({ queryKey: ["/v1/agents"] });
  void qc.cancelQueries({ predicate: isAgentQuery(agentId) });
}

/** Drop a deleted agent's cached queries. Only once the components that
 *  observe them have unmounted: a mounted observer would recreate the query
 *  and ask for a record that is gone. */
export function dropAgentQueries(qc: QueryClient, agentId: string) {
  qc.removeQueries({ predicate: isAgentQuery(agentId) });
}

/** How long the delete confirmation waits to learn whether a computer goes
 *  with the agent before it opens saying it could not tell. */
const MACHINE_CHECK_MS = 4_000;

/** Whether the agent has a computer, asked of the server now; null when that
 *  could not be found out in time. */
export async function checkAgentMachine(
  qc: QueryClient,
  api: ReturnType<typeof useApi>["api"],
  agentId: string,
): Promise<MachineResponse | null> {
  return Promise.race([
    loadAgentMachine(qc, api, agentId).catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), MACHINE_CHECK_MS)),
  ]);
}
