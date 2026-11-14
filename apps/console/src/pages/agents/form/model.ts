import type { Dispatch, SetStateAction } from "react";
import type { ModelCard } from "@open-managed-agents/api-types";

import type { MemoryMode } from "../../../components/MemoryModeControl";
import {
  createDefaultAmbientTriggerDraft,
  type AmbientBudgetPreset,
  type AmbientDecisionPreset,
  type AmbientWakeMode,
} from "../../../lib/ambient-controls";

/**
 * The new-agent form's data model: the shapes it edits, its constants and
 * its initial state. The dialog (`../AgentFormDialog`) owns the state and
 * the create flow; the sections in this folder render and edit it.
 */

export interface McpEntry {
  name: string;
  type: string;
  url: string;
}
export interface SkillEntry {
  type: "anthropic" | "custom";
  skill_id: string;
  version?: string;
}
export interface CallableEntry {
  type: "agent";
  id: string;
  version: number;
}
export interface VaultLite {
  id: string;
  name: string;
  archived_at?: string | null;
}
export interface EnvironmentLite {
  id: string;
  name: string;
  description?: string | null;
  config?: {
    networking?: {
      type?: string;
      allow_mcp_servers?: boolean;
      allow_package_managers?: boolean;
    };
    packages?: { npm?: string[]; pip?: string[] };
  };
}
export interface SandboxConfig {
  provider: string;
  image?: string | null;
  daytona_api_url_configured?: boolean;
  daytona_api_key_configured?: boolean;
  memory_s3_configured?: boolean;
  memory_s3_endpoint_host?: string | null;
  memory_s3_bucket?: string | null;
  memory_s3_region?: string | null;
}
export interface SandboxStorageCheck {
  ok: boolean;
  configured: boolean;
  provider: string;
  checked_at: string;
  endpoint_host?: string | null;
  bucket?: string | null;
  region?: string | null;
  key?: string;
  checks: {
    s3_write_read_delete: {
      ok: boolean;
      duration_ms?: number;
      bytes?: number;
      error?: string;
    };
  };
}
export type ComposioConnectionState = Record<
  string,
  {
    connectedAccountId: string;
    authConfigId: string;
    status: "pending" | "connected";
    redirectUrl?: string;
  }
>;
export interface ComposioAuthCompletion {
  toolkit?: string;
  connectedAccountId?: string;
  authConfigId?: string;
}
export interface ComposioConnectedAccountItem {
  id: string;
  status?: string;
  auth_config?: { id?: string };
}
export interface ComposioConnectedAccountsResponse {
  items?: ComposioConnectedAccountItem[];
}
export interface VaultCredentialLite {
  id: string;
  archived_at?: string | null;
  auth?: {
    type?: string;
    composio_toolkits?: string[];
  };
}
export interface VaultCredentialsResponse {
  data?: VaultCredentialLite[];
}

export const COMPOSIO_MCP_SERVER: McpEntry = {
  name: "composio",
  type: "url",
  url: "https://app.composio.dev/tool_router/v3/session/mcp",
};

export const ANTHROPIC_SKILLS = [
  { id: "xlsx", label: "Excel", description: "Read and build spreadsheets (.xlsx)" },
  { id: "pdf", label: "PDF", description: "Read, fill and create PDF files" },
  { id: "pptx", label: "PowerPoint", description: "Read and build slide decks (.pptx)" },
  { id: "docx", label: "Word", description: "Read and write documents (.docx)" },
];

// AMA spec built-in tool names — must match
// `BetaManagedAgentsAgentToolConfig.name` enum in the SDK. Source of
// truth lives in the agent_toolset_20260401 toolset; emitting unknown
// names here would still validate at the API layer but produces a tool
// the runtime never wires.
export type BuiltinToolGroup = "files" | "web" | "schedule" | "triggers";

export const BUILTIN_TOOL_GROUPS: Array<{ id: BuiltinToolGroup; label: string }> = [
  { id: "files", label: "Files and shell" },
  { id: "web", label: "Web" },
  { id: "schedule", label: "Scheduling" },
  { id: "triggers", label: "Triggers" },
];

export const BUILTIN_TOOLS: Array<{ name: string; group: BuiltinToolGroup; description: string }> = [
  { name: "bash", group: "files", description: "Run shell commands in the sandbox" },
  { name: "read", group: "files", description: "Read files from the sandbox" },
  { name: "write", group: "files", description: "Create or overwrite files" },
  { name: "edit", group: "files", description: "Edit files in place" },
  { name: "glob", group: "files", description: "Find files by path pattern" },
  { name: "grep", group: "files", description: "Search file contents" },
  { name: "web_fetch", group: "web", description: "Fetch a page as markdown. The default for reading the web." },
  { name: "web_search", group: "web", description: "Search the web. The default for lookups." },
  {
    name: "browser",
    group: "web",
    description:
      "A full browser session for multi-step navigation, JavaScript-heavy pages and sign-in flows. Heavy, so models tend to over-use it; turn it on only when needed.",
  },
  { name: "schedule", group: "schedule", description: "Wake this session later, or on a repeating schedule" },
  { name: "list_schedules", group: "schedule", description: "List this session's pending wake-ups" },
  { name: "cancel_schedule", group: "schedule", description: "Cancel a pending wake-up" },
  { name: "create_ambient_rule", group: "triggers", description: "Let the agent create its own triggers from a conversation" },
  { name: "list_ambient_rules", group: "triggers", description: "List this agent's triggers" },
  { name: "delete_ambient_rule", group: "triggers", description: "Delete one of this agent's triggers" },
];

export type ToolOverride = "default" | "always_allow" | "always_ask" | "disabled";

export type ReasoningLevelValue = "instant" | "low" | "medium" | "high" | "max";

export const REASONING_LEVEL_OPTIONS: Array<{ value: ReasoningLevelValue; label: string; hint: string }> = [
  { value: "instant", label: "Instant", hint: "No reasoning. Fastest and cheapest." },
  { value: "low", label: "Low", hint: "Brief reasoning." },
  { value: "medium", label: "Medium", hint: "Moderate reasoning." },
  { value: "high", label: "High", hint: "Deep reasoning. Slowest." },
  { value: "max", label: "Max", hint: "Maximum reasoning, for judges and the hardest tasks." },
];

/** Reasoning level only applies where the harness can map it: official
 *  OpenAI reasoning models (gpt-5*, o-series → reasoning_effort) and
 *  Anthropic Claude (→ extended-thinking budget). Hidden for gateways
 *  (oai-compatible / ant-compatible) and non-reasoning models (gpt-4o). */
export function cardSupportsReasoningLevel(card: ModelCard | undefined): boolean {
  if (!card) return false;
  if (card.provider === "oai") return /^(o[1-9]|gpt-5)/i.test(card.model);
  if (card.provider === "ant") return card.model.startsWith("claude-");
  return false;
}

export const INITIAL_FORM = {
  name: "",
  model: "",
  /** Execution loop. "default" = platform loop with model-card billing;
   *  the SDK harnesses run headless Claude Code / Codex on the server host
   *  and bill the host's subscription (self-host only, env-gated).
   *  acp-proxy is not offered here — it's driven by the runtime binding. */
  harness: "default" as "default" | "claude-agent-sdk" | "codex-sdk",
  reasoningLevel: "instant" as ReasoningLevelValue,
  /** `_oma.memory.mode`; "off" is the server default and is never sent. */
  memoryMode: "off" as MemoryMode,
  system: "",
  description: "",
  /** The avatar a person chose or a template carried, as stored in
   *  `metadata.avatar`. Empty = automatic: read from the name. */
  avatar: "",
  modelCardId: "",
  mcpServers: [] as McpEntry[],
  skills: [] as SkillEntry[],
  callableAgents: [] as CallableEntry[],
  composioToolkits: [] as string[],
  defaultVaultIds: [] as string[],
  environmentId: "",
  // When set, agent uses harness:"acp-proxy" — its loop runs on a user-
  // registered local runtime via `oma bridge daemon` instead of OMA's cloud
  // SessionDO loop. Both fields must be set together; partial = fall back to
  // default cloud agent.
  runtimeId: "",
  acpAgentId: "claude-agent-acp",
  /** Local skill ids to HIDE from this agent's ACP child. Empty = all
   *  detected local skills are visible (the daemon's default). */
  localSkillBlocklist: [] as string[],
  // Built-in tool policy. `agent_toolset_20260401` toolset's
  // `default_config` controls fallback enabled/permission for any
  // tool without a specific override. `toolOverrides` is a per-tool
  // 4-state: "default" (no entry emitted in configs[]), "always_allow",
  // "always_ask", or "disabled" (enabled=false).
  toolDefaultEnabled: true,
  toolDefaultPermission: "always_allow" as "always_allow" | "always_ask",
  toolOverrides: {} as Record<string, ToolOverride>,
  // Opt-in to the built-in `general_subagent` tool.
  enableGeneralSubagent: false,
  // Long-running capability: sessions on this agent can carry a goal
  // contract ("run until done") driven by the mission supervisor.
  longRunning: false,
  ambientEnabled: false,
  ambientRuleName: "",
  ambientRuleDescription: "",
  ambientRuleActive: true,
  ambientTrigger: createDefaultAmbientTriggerDraft("schedule"),
  ambientWakeMode: "decide" as AmbientWakeMode,
  ambientNextWakeAt: "",
  ambientDecisionPreset: "new_signal" as AmbientDecisionPreset,
  ambientBudgetPreset: "standard" as AmbientBudgetPreset,
};

export type FormState = typeof INITIAL_FORM;
export type FormSetter = Dispatch<SetStateAction<FormState>>;

/** The sections of the form, as the dialog's side navigation lists them. */
export type FormTab =
  | "basic"
  | "model"
  | "tools"
  | "skills"
  | "integrations"
  | "mcp"
  | "agents"
  | "sandbox"
  | "vaults"
  | "ambient";

/** A local runtime as `/v1/runtimes` reports it. */
export interface RuntimeLite {
  id: string;
  hostname: string;
  status: string;
  agents: Array<{ id: string }>;
  local_skills?: Record<
    string,
    Array<{ id: string; name?: string; description?: string; source?: string; source_label?: string }>
  >;
}

export interface SkillLite {
  id: string;
  name: string;
  description: string;
}

export function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

export function providerLabel(provider: string): string {
  switch (provider) {
    case "daytona":
      return "Daytona";
    case "e2b":
      return "E2B";
    case "litebox":
    case "boxlite":
      return "BoxLite";
    case "subprocess":
      return "Local subprocess";
    default:
      return provider;
  }
}
