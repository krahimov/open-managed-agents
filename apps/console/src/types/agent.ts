/**
 * Console-side Agent record. Wider than `@open-managed-agents/api-types`'
 * `AgentConfig` (the wire-format) — adds the runtime metadata the list
 * and detail endpoints return on top of the config (`version`,
 * `created_at`, `archived_at`) plus the `_oma` console extension.
 *
 * Lifted out of AgentDetail.tsx + AgentsList.tsx where two copies had
 * drifted (AgentDetail had `tools`, AgentsList had `_oma`; both had the
 * common metadata fields).
 */
export interface AgentRecord {
  id: string;
  name: string;
  model: string | { id: string; speed?: string };
  system?: string;
  version: number;
  description?: string;
  tools?: unknown[];
  skills?: unknown[];
  mcp_servers?: unknown[];
  metadata?: Record<string, unknown>;
  multiagent?: {
    type: "coordinator";
    agents: Array<{ type: "agent"; id: string; version: number }>;
  } | null;
  created_at: string;
  updated_at?: string;
  archived_at?: string;
  /** Console-only enrichment from the OMA control plane: scratch/aux model
   *  selection, harness binding, appendable prompt presets. Not on the
   *  wire-format AgentConfig (those fields live in OMA-private storage). */
  _oma?: {
    aux_model?: { id: string; speed?: string };
    harness?: string;
    reasoning_level?: import("@open-managed-agents/api-types").ReasoningLevel;
    /** Cross-session memory. Absent = off (and still eligible for the
     *  automatic enable that comes with a first ambient rule). */
    memory?: import("@open-managed-agents/api-types").AgentMemoryConfig;
    /** MCP tool-definition loading. Absent = auto. */
    mcp_tool_loading?: import("@open-managed-agents/api-types").McpToolLoading;
    runtime_binding?: { runtime_id: string; acp_agent_id: string };
    appendable_prompts?: string[];
    default_environment_id?: string;
    default_vault_ids?: string[];
  };
}
