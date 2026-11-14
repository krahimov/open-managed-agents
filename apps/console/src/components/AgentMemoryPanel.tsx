/**
 * CONTRACT (step 0 baseline). Owner: C6b. Mounted by C6a on the agent's
 * Overview tab. Renders nothing yet.
 *
 * Port of main's components/AgentMemoryPanel.tsx. Reads
 * `GET /v1/agents/:id/memory` (AgentMemoryResponse) and shows whether this
 * agent carries anything from one session to the next, which store holds
 * it (link by name, note count, last written), and a switch that writes
 * `PUT /v1/agents/:id/memory` ({ mode }); turning it off writes mode "off"
 * and keeps the store. A placeholder under its heading while loading.
 * Renders nothing when the endpoint is not on the server (404 /
 * not_on_server), so the page is unchanged there. Invalidates the agent
 * query after a change.
 */

/** GET/PUT /v1/agents/:id/memory (main-node). */
export interface AgentMemoryResponse {
  enabled: boolean;
  mode: "off" | "shared" | "per_user";
  explicit_off: boolean;
  store: {
    id: string;
    name: string;
    note_count?: number;
    last_written_at?: string | null;
  } | null;
}

export interface AgentMemoryPanelProps {
  agentId: string;
}

export function AgentMemoryPanel(_props: AgentMemoryPanelProps) {
  return null;
}
