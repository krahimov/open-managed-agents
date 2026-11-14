import type { Dispatch, SetStateAction } from "react";
import {
  DEFAULT_REASONING_LEVEL,
  REASONING_LEVEL_LABELS,
  UI_REASONING_LEVELS,
  modelSupportsReasoning,
  type McpToolLoading,
  type ModelCard,
  type ReasoningLevel,
} from "@open-managed-agents/api-types";

import { harnessLabel } from "../../../lib/agents";
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
    /** `scope: "agent"` gives the agent a persistent computer of its own. */
    sandbox?: { scope?: string | null; [key: string]: unknown } | null;
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

export type ReasoningLevelValue = ReasoningLevel;

const REASONING_LEVEL_HINTS: Record<ReasoningLevel, string> = {
  instant: "An older setting: the least reasoning the model allows.",
  low: "Brief reasoning. The fastest.",
  medium: "Balanced. What an agent uses unless told otherwise.",
  high: "Deep reasoning.",
  xhigh: "Deeper than High.",
  max: "The most reasoning. The slowest, for the hardest tasks.",
};

/** The levels a reasoning field offers: the five the server knows
 *  (api-types UI_REASONING_LEVELS), plus the legacy "Instant" only while
 *  the agent being edited still carries it. */
export function reasoningLevelOptions(current: ReasoningLevelValue): Array<{ value: ReasoningLevelValue; label: string; hint: string }> {
  const levels: ReasoningLevel[] = current === "instant" ? ["instant", ...UI_REASONING_LEVELS] : [...UI_REASONING_LEVELS];
  return levels.map((value) => ({
    value,
    label: value === DEFAULT_REASONING_LEVEL ? `${REASONING_LEVEL_LABELS[value]} (default)` : REASONING_LEVEL_LABELS[value],
    hint: REASONING_LEVEL_HINTS[value],
  }));
}

/** The wire value for a level: the default is what unset means, so it is
 *  not stored. */
export function reasoningLevelForWire(level: ReasoningLevelValue): ReasoningLevel | null {
  return level === DEFAULT_REASONING_LEVEL ? null : level;
}

/** Reasoning only applies where the harness can map it: official OpenAI
 *  reasoning models (o-series, gpt-5 and later → reasoning effort) and
 *  Anthropic Claude (→ thinking effort or budget). Hidden for gateways
 *  (oai-compatible / ant-compatible) and models that do not reason. */
export function cardSupportsReasoningLevel(card: ModelCard | undefined): boolean {
  return !!card && modelSupportsReasoning(card.provider, card.model);
}

/** Engines that run the platform's tools and bill one of the workspace's
 *  model keys, so they take a model key, a reasoning level and memory. */
export const MODEL_KEY_HARNESSES = ["default", "pi"] as const;
/** Engines that run headless Claude Code / Codex on the server and bill its
 *  subscription (self-host only, env-gated). */
export const SUBSCRIPTION_HARNESSES = ["claude-agent-sdk", "codex-sdk"] as const;
export type HarnessValue = (typeof MODEL_KEY_HARNESSES)[number] | (typeof SUBSCRIPTION_HARNESSES)[number];

/** An engine by its name. `pi` is named here until lib/agents' harnessLabel
 *  knows it. */
export function engineLabel(harness: string | null | undefined): string {
  return harness === "pi" ? "Pi agent" : harnessLabel(harness);
}

export function isSubscriptionHarness(harness: string): boolean {
  return (SUBSCRIPTION_HARNESSES as readonly string[]).includes(harness);
}

export const INITIAL_FORM = {
  name: "",
  model: "",
  /** Execution loop. "default" = platform loop with model-card billing;
   *  the SDK harnesses run headless Claude Code / Codex on the server host
   *  and bill the host's subscription (self-host only, env-gated).
   *  acp-proxy is not offered here — it's driven by the runtime binding. */
  harness: "default" as HarnessValue,
  reasoningLevel: DEFAULT_REASONING_LEVEL as ReasoningLevelValue,
  /** `_oma.memory.mode` as the person chose it. */
  memoryMode: "off" as MemoryMode,
  /** False until the person picks a memory mode. An agent nobody chose for
   *  is created without `_oma.memory`: off, and switched on by the server
   *  with its first trigger (each run is a fresh session). A chosen mode,
   *  Off included, is written as chosen. */
  memoryChosen: false,
  /** `_oma.mcp_tool_loading` (auto | eager | deferred). No form control:
   *  carried through the YAML/JSON view and edits so it is never dropped.
   *  "" = unset (auto). */
  mcpToolLoading: "" as McpToolLoading | "",
  /** `_oma.vault_mcp_servers`. No form control: carried so the code view
   *  and edits keep it ("all" = the legacy vault-implied servers). */
  vaultMcpServers: "declared" as "declared" | "all",
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
