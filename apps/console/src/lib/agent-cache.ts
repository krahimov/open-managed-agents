import type { QueryClient } from "@tanstack/react-query";

/**
 * After a trigger (ambient rule) is created. The server may switch the
 * agent's shared memory on with it (each run is a fresh session, so memory
 * is its only continuity), and that saves a new agent version. Every read
 * of the agent is then stale, and an edit opened from one is refused as a
 * version conflict (409). Refetch them.
 */
export async function refreshAgentAfterTriggerCreated(qc: QueryClient, agentId: string): Promise<void> {
  await Promise.all([
    qc.invalidateQueries({ queryKey: [`/v1/agents/${agentId}`] }),
    qc.invalidateQueries({ queryKey: [`/v1/agents/${agentId}/versions`] }),
    qc.invalidateQueries({ queryKey: [`/v1/agents/${agentId}/memory`] }),
    qc.invalidateQueries({ queryKey: [`/v1/agents/${agentId}/ambient-rules`] }),
    qc.invalidateQueries({ queryKey: ["/v1/agents"] }),
  ]);
}
