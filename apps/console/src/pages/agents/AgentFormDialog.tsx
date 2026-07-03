import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import yaml from "js-yaml";
import { CheckIcon, ExternalLinkIcon, RefreshCwIcon, XCircleIcon } from "lucide-react";
import { toast } from "sonner";

import { useApi } from "../../lib/api";
import { useApiQuery } from "../../lib/useApiQuery";
import { Button } from "@/components/ui/button";
import { Select, SelectGroup, SelectGroupLabel, SelectOption } from "../../components/Select";
import { Combobox } from "../../components/Combobox";
import { McpServerPickerModal } from "../../components/McpServerPickerModal";
import { AmbientTriggerControls } from "../../components/AmbientTriggerControls";
import { AGENT_TEMPLATES, type AgentTemplate } from "../../lib/agent-templates";
import {
  COMPOSIO_NOT_CONFIGURED_MESSAGE,
  composioEntriesFromCatalog,
  composioIntegrationIcon,
  filterComposioEntries,
  type ComposioToolkitCatalogResponse,
  type ComposioIntegrationEntry,
  type ComposioStatusResponse,
} from "../../lib/composio-integrations";
import type { ModelCard } from "@open-managed-agents/api-types";
import {
  KNOWN_ACP_AGENTS,
  resolveKnownAgent,
} from "@open-managed-agents/acp-runtime/known-agents";
import type { AgentRecord as Agent } from "../../types/agent";
import { BRAND_NAME } from "../../lib/brand";
import {
  AMBIENT_WAKE_MODES,
  buildAmbientTrigger,
  buildBudget,
  buildDecisionPolicy,
  createDefaultAmbientTriggerDraft,
  type AmbientBudgetPreset,
  type AmbientDecisionPreset,
  type AmbientWakeMode,
} from "../../lib/ambient-controls";

interface McpEntry {
  name: string;
  type: string;
  url: string;
}
interface SkillEntry {
  type: "anthropic" | "custom";
  skill_id: string;
  version?: string;
}
interface CallableEntry {
  type: "agent";
  id: string;
  version: number;
}
interface VaultLite {
  id: string;
  name: string;
  archived_at?: string | null;
}
interface EnvironmentLite {
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
interface SandboxConfig {
  provider: string;
  image?: string | null;
  daytona_api_url_configured?: boolean;
  daytona_api_key_configured?: boolean;
  memory_s3_configured?: boolean;
  memory_s3_endpoint_host?: string | null;
  memory_s3_bucket?: string | null;
  memory_s3_region?: string | null;
}
interface SandboxStorageCheck {
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
type ComposioConnectionState = Record<
  string,
  {
    connectedAccountId: string;
    authConfigId: string;
    status: "pending" | "connected";
    redirectUrl?: string;
  }
>;

const COMPOSIO_MCP_SERVER: McpEntry = {
  name: "composio",
  type: "url",
  url: "https://app.composio.dev/tool_router/v3/session/mcp",
};

const ANTHROPIC_SKILLS = [
  { id: "xlsx", label: "Excel (xlsx)" },
  { id: "pdf", label: "PDF" },
  { id: "pptx", label: "PowerPoint (pptx)" },
  { id: "docx", label: "Word (docx)" },
];

// AMA spec built-in tool names — must match
// `BetaManagedAgentsAgentToolConfig.name` enum in the SDK. Source of
// truth lives in the agent_toolset_20260401 toolset; emitting unknown
// names here would still validate at the API layer but produces a tool
// the runtime never wires.
const BUILTIN_TOOLS: Array<{ name: string; label: string; description: string }> = [
  { name: "bash", label: "bash", description: "Run shell commands in the sandbox" },
  { name: "edit", label: "edit", description: "In-place file edits" },
  { name: "read", label: "read", description: "Read files from the sandbox FS" },
  { name: "write", label: "write", description: "Create or overwrite files" },
  { name: "glob", label: "glob", description: "Pattern-match file paths" },
  { name: "grep", label: "grep", description: "Search file contents" },
  { name: "web_fetch", label: "web_fetch", description: "Fetch a URL → markdown. Default for any web read." },
  { name: "web_search", label: "web_search", description: "Web search via DuckDuckGo. Default for lookups." },
  { name: "schedule", label: "schedule", description: "Wake this session later or on a recurring schedule" },
  { name: "list_schedules", label: "list_schedules", description: "List pending self-wake schedules for this session" },
  { name: "cancel_schedule", label: "cancel_schedule", description: "Cancel a pending self-wake schedule" },
  { name: "browser", label: "browser (opt-in)", description: "Heavy multi-step browser session (navigate / click / screenshot). Off by default — LLMs over-reach for it on simple lookups. Enable only when you need interactive navigation, JS-rendered SPAs, or auth flows." },
];

type ToolOverride = "default" | "always_allow" | "always_ask" | "disabled";

const INITIAL_FORM = {
  name: "",
  model: "",
  system: "",
  description: "",
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

interface AgentFormDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called after the agent is created successfully. Parent uses this
   *  to refresh the list. The dialog handles its own navigation to the
   *  new agent's detail page. */
  onCreated?: () => void;
  /** Data sets the form's pickers pull from. The parent fetches these
   *  on mount (loadAux) and passes them down so the dialog doesn't have
   *  to re-fetch on every open. */
  allAgents: Agent[];
  customSkills: Array<{ id: string; name: string; description: string }>;
  modelCards: ModelCard[];
  runtimes: Array<{
    id: string;
    hostname: string;
    status: string;
    agents: Array<{ id: string }>;
    local_skills?: Record<
      string,
      Array<{ id: string; name?: string; description?: string; source?: string; source_label?: string }>
    >;
  }>;
}

/**
 * Create-agent dialog. Multi-step (template → form) with three editor
 * modes (form / yaml / json). Owns all of its own state — `form`,
 * `createStep`, `createMode`, etc. — so the parent `AgentsList` just
 * mounts it and forwards data lists + an `onCreated` hook for the
 * post-save refresh.
 *
 * Stays hand-rolled rather than wrapping `Modal` because the
 * template→form/yaml/json multi-step header doesn't fit the standard
 * Modal layout. Focus trap, scroll lock, focus restore, and Escape
 * handling are reimplemented inline (mirroring `components/Modal.tsx`
 * behavior) so keyboard + screen-reader users get the same affordances.
 */
export function AgentFormDialog({
  open,
  onClose,
  onCreated,
  allAgents,
  customSkills,
  modelCards,
  runtimes,
}: AgentFormDialogProps) {
  const { api } = useApi();
  const nav = useNavigate();

  const [createError, setCreateError] = useState("");
  const [createStep, setCreateStep] = useState<"template" | "form">("template");
  const [templateSearch, setTemplateSearch] = useState("");
  const [form, setForm] = useState({ ...INITIAL_FORM });
  const [tab, setTab] = useState<
    "basic" | "integrations" | "ambient" | "tools" | "skills" | "sandbox" | "mcp" | "agents"
  >("basic");
  const [createMode, setCreateMode] = useState<"form" | "yaml" | "json">("form");
  const [codeValue, setCodeValue] = useState("");
  const [showMcpPicker, setShowMcpPicker] = useState(false);
  const [integrationSearch, setIntegrationSearch] = useState("");
  const [vaults, setVaults] = useState<VaultLite[]>([]);
  const [environments, setEnvironments] = useState<EnvironmentLite[]>([]);
  const [sandboxConfig, setSandboxConfig] = useState<SandboxConfig | null>(null);
  const [composioConnections, setComposioConnections] =
    useState<ComposioConnectionState>({});
  const [connectingIntegration, setConnectingIntegration] = useState<string | null>(null);
  const {
    data: composioStatus,
    isLoading: composioStatusLoading,
    refetch: refetchComposioStatus,
  } = useApiQuery<ComposioStatusResponse>("/v1/composio/status", undefined, {
    enabled: open,
  });
  const composioConfigured = composioStatus?.configured === true;

  const createDialogRef = useRef<HTMLDivElement>(null);
  const createPreviousFocus = useRef<HTMLElement | null>(null);

  // Pre-select default model card when entering the form step. (tenant_id,
  // model_id) is UNIQUE in DB, so picking a card uniquely determines the
  // model. Skip if user/paste already set model. Re-runs when modelCards
  // arrives if the dialog opened before the aux fetch.
  useEffect(() => {
    if (createStep !== "form") return;
    if (form.modelCardId || form.model) return;
    if (modelCards.length === 0) return;
    const def = modelCards.find((mc) => mc.is_default) ?? modelCards[0];
    setForm((f) => ({ ...f, modelCardId: def.id, model: def.model_id }));
    // Intentionally not depending on form.* — guards above prevent the
    // re-trigger loop and we only want to hydrate on step entry / cards arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createStep, modelCards.length]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    Promise.all([
      api<{ data: VaultLite[] }>("/v1/vaults?status=active&limit=100").catch(() => ({ data: [] })),
      api<{ data: EnvironmentLite[] }>("/v1/environments?limit=100").catch(() => ({ data: [] })),
      api<SandboxConfig>("/v1/sandbox/config").catch(() => ({
        provider: "subprocess",
      })),
    ]).then(([vaultRes, envRes, sandboxRes]) => {
      if (cancelled) return;
      const activeVaults = (vaultRes.data ?? []).filter((v) => !v.archived_at);
      setVaults(activeVaults);
      setEnvironments(envRes.data ?? []);
      setSandboxConfig(sandboxRes);
      setForm((f) => {
        if (f.environmentId || (envRes.data ?? []).length === 0) return f;
        return { ...f, environmentId: envRes.data[0].id };
      });
    });
    return () => {
      cancelled = true;
    };
  }, [api, open]);

  const closeCreate = () => {
    setCreateStep("template");
    setTemplateSearch("");
    setForm({ ...INITIAL_FORM });
    setTab("basic");
    setCreateError("");
    setCreateMode("form");
    setCodeValue("");
    setIntegrationSearch("");
    setComposioConnections({});
    setConnectingIntegration(null);
    onClose();
  };

  // Dialog a11y — focus trap + Escape, scroll lock, focus restore on close.
  // Mirrors components/Modal.tsx behavior so this hand-rolled multi-step
  // dialog is keyboard-equivalent.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closeCreate();
        return;
      }
      if (e.key !== "Tab") return;
      const el = createDialogRef.current;
      if (!el) return;
      const f = el.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        last.focus();
        e.preventDefault();
      } else if (!e.shiftKey && document.activeElement === last) {
        first.focus();
        e.preventDefault();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // closeCreate is stable enough — deps kept tight to avoid re-binding
    // on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    createPreviousFocus.current = document.activeElement as HTMLElement;
    const el = createDialogRef.current;
    el?.querySelector<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    )?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
      createPreviousFocus.current?.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleOAuthMessage = (event: MessageEvent | { data: unknown }) => {
      const data = (
        event as {
          data?: {
            type?: string;
            toolkit?: string;
            connected_account_id?: string;
          };
        }
      ).data;
      if (data?.type !== "composio_auth_complete") return;
      const toolkit = data.toolkit ? normalizeToolkitSlug(data.toolkit) : "";
      setConnectingIntegration(null);
      setComposioConnections((prev) => {
        const next = { ...prev };
        if (toolkit && next[toolkit]) {
          next[toolkit] = { ...next[toolkit], status: "connected" };
        } else {
          for (const slug of Object.keys(next)) {
            if (next[slug].status === "pending") {
              next[slug] = { ...next[slug], status: "connected" };
            }
          }
        }
        return next;
      });
      toast.success("Provider account connected.");
    };
    window.addEventListener("message", handleOAuthMessage);
    let bc: BroadcastChannel | null = null;
    try {
      bc = new BroadcastChannel("openma-oauth");
      bc.addEventListener("message", handleOAuthMessage);
    } catch {
      // BroadcastChannel is best effort for browsers without support.
    }
    return () => {
      window.removeEventListener("message", handleOAuthMessage);
      if (bc) {
        bc.removeEventListener("message", handleOAuthMessage);
        bc.close();
      }
    };
  }, [open]);

  // Serialize the form's tool-policy state into the AMA-shape
  // `tools` array. Always emits exactly one toolset entry of type
  // `agent_toolset_20260401`; per-tool overrides only land in
  // `configs[]` when they differ from the default.
  const buildToolsField = () => {
    const overrides = Object.entries(form.toolOverrides)
      .filter(([, v]) => v !== "default")
      .map(([name, v]) => {
        if (v === "disabled") return { name, enabled: false };
        return {
          name,
          enabled: true,
          permission_policy: { type: v as "always_allow" | "always_ask" },
        };
      });
    // AMA spec: each entry in mcp_servers gets a corresponding mcp_toolset
    // tool that references it by name. Surface them all as always_allow
    // by default — the user already opted in by adding the server.
    const effectiveMcpServers =
      form.composioToolkits.length > 0 && !form.mcpServers.some((m) => isComposioMcpUrl(m.url))
        ? [COMPOSIO_MCP_SERVER, ...form.mcpServers]
        : form.mcpServers;
    const mcpToolsets = effectiveMcpServers
      .filter((m) => m.name)
      .map((m) => ({
        type: "mcp_toolset" as const,
        mcp_server_name: m.name,
        default_config: { permission_policy: { type: "always_allow" as const } },
      }));
    return [
      {
        type: "agent_toolset_20260401",
        default_config: {
          enabled: form.toolDefaultEnabled,
          permission_policy: { type: form.toolDefaultPermission },
        },
        ...(overrides.length > 0 ? { configs: overrides } : {}),
      },
      ...mcpToolsets,
    ];
  };

  const ensureIntegrationVault = async (): Promise<VaultLite> => {
    const preferred = vaults.find((v) => v.name === "Connected Apps") ?? vaults[0];
    if (preferred) return preferred;
    const created = await api<VaultLite>("/v1/vaults", {
      method: "POST",
      body: JSON.stringify({ name: "Connected Apps" }),
    });
    setVaults((prev) => [created, ...prev]);
    return created;
  };

  const connectComposioToolkit = async (entry: ComposioIntegrationEntry) => {
    if (!composioConfigured) {
      toast.error(COMPOSIO_NOT_CONFIGURED_MESSAGE);
      return;
    }
    const slug = normalizeToolkitSlug(entry.slug);
    const popup = window.open("", `composio-${slug}`, "width=600,height=720,popup=yes");
    setConnectingIntegration(slug);
    setForm((f) => ({
      ...f,
      composioToolkits: f.composioToolkits.includes(slug)
        ? f.composioToolkits
        : [...f.composioToolkits, slug],
    }));
    try {
      const vault = await ensureIntegrationVault();
      const callbackUrl = `${window.location.origin}/composio/callback?toolkit=${encodeURIComponent(slug)}`;
      const link = await api<{
        redirect_url: string;
        connected_account_id: string;
        auth_config_id: string;
      }>(`/v1/vaults/${vault.id}/credentials/composio_accounts/link`, {
        method: "POST",
        body: JSON.stringify({ toolkit: slug, callback_url: callbackUrl }),
      });
      setComposioConnections((prev) => ({
        ...prev,
        [slug]: {
          connectedAccountId: link.connected_account_id,
          authConfigId: link.auth_config_id,
          status: "pending",
          redirectUrl: link.redirect_url,
        },
      }));
      if (popup) {
        popup.location.href = link.redirect_url;
      } else {
        window.open(link.redirect_url, `composio-${slug}`, "width=600,height=720,popup=yes");
      }
      setConnectingIntegration(null);
    } catch (err) {
      popup?.close();
      setConnectingIntegration(null);
      toast.error(err instanceof Error ? err.message : "Failed to start provider OAuth");
    }
  };

  const toggleIntegration = (entry: ComposioIntegrationEntry) => {
    const slug = normalizeToolkitSlug(entry.slug);
    setForm((f) => {
      const selected = f.composioToolkits.includes(slug);
      return {
        ...f,
        composioToolkits: selected
          ? f.composioToolkits.filter((s) => s !== slug)
          : [...f.composioToolkits, slug],
      };
    });
  };

  const ensureComposioCredentialForAgent = async (): Promise<string[]> => {
    if (form.composioToolkits.length === 0) return form.defaultVaultIds;
    if (!composioConfigured) {
      throw new Error(COMPOSIO_NOT_CONFIGURED_MESSAGE);
    }
    const missing = form.composioToolkits.filter(
      (slug) => composioConnections[slug]?.status !== "connected",
    );
    if (missing.length > 0) {
      throw new Error(`Connect selected apps first: ${missing.join(", ")}`);
    }
    const vault = await ensureIntegrationVault();
    const linkedEntries = Object.entries(composioConnections).filter(([slug]) =>
      form.composioToolkits.includes(slug),
    );
    await api(`/v1/vaults/${vault.id}/credentials/composio_tool_router_session`, {
      method: "POST",
      body: JSON.stringify({
        display_name: `Composio Tool Router (${form.name || "Agent"})`,
        toolkits: { enable: form.composioToolkits },
        connected_accounts: Object.fromEntries(
          linkedEntries.map(([slug, link]) => [slug, link.connectedAccountId]),
        ),
        auth_configs: Object.fromEntries(
          linkedEntries.map(([slug, link]) => [slug, link.authConfigId]),
        ),
      }),
    });
    return uniqueStrings([...form.defaultVaultIds, vault.id]);
  };

  const mergedMcpServersForCreate = () => {
    if (form.composioToolkits.length === 0) return form.mcpServers;
    const hasComposio = form.mcpServers.some((m) => isComposioMcpUrl(m.url));
    return hasComposio ? form.mcpServers : [COMPOSIO_MCP_SERVER, ...form.mcpServers];
  };

  // After an agent is created, drop the user into its first session in SETUP
  // MODE: the agent reads its own harness (the YAML) and interviews the user to
  // refine it live. Falls back to the agent page if a session can't be started.
  const goToSetup = async (agent: Agent) => {
    try {
      const environmentId =
        form.environmentId ||
        (await api<{ data?: Array<{ id: string }> }>("/v1/environments?limit=1")).data?.[0]?.id;
      const session = await api<{ id: string }>("/v1/sessions", {
        method: "POST",
        body: JSON.stringify({
          agent: agent.id,
          ...(environmentId ? { environment_id: environmentId } : {}),
          metadata: { oma_setup: true },
        }),
      });
      // Kick off the interview so the agent speaks first.
      await api(`/v1/sessions/${session.id}/events`, {
        method: "POST",
        body: JSON.stringify({
          events: [
            {
              type: "user.message",
              content: [
                {
                  type: "text",
                  text:
                    "I just created you from a template. Walk me through setting up your harness — ask me what you should do, and refine your config as we go.",
                },
              ],
            },
          ],
        }),
      });
      nav(`/agents/${agent.id}/setup?session=${session.id}`);
    } catch {
      nav(`/agents/${agent.id}`);
    }
  };

  const create = async () => {
    setCreateError("");
    try {
      const ambientRuleBody = form.ambientEnabled ? buildAmbientRuleBody(form) : null;
      const defaultVaultIds = await ensureComposioCredentialForAgent();
      const mcpServers = mergedMcpServersForCreate();
      const payload: Record<string, unknown> = {
        name: form.name,
        model: form.model,
        system: form.system || undefined,
        description: form.description || undefined,
        tools: buildToolsField(),
      };
      if (mcpServers.length) payload.mcp_servers = mcpServers;
      if (form.skills.length) payload.skills = form.skills;
      if (form.callableAgents.length) {
        payload.multiagent = { type: "coordinator", agents: form.callableAgents };
      }
      const metadata: Record<string, unknown> = {};
      if (form.environmentId) metadata.default_environment_id = form.environmentId;
      if (defaultVaultIds.length > 0) metadata.default_vault_ids = defaultVaultIds;
      if (form.composioToolkits.length > 0) {
        metadata.composio_toolkits = form.composioToolkits;
      }
      if (Object.keys(metadata).length > 0) payload.metadata = metadata;
      if (form.enableGeneralSubagent) {
        payload.enable_general_subagent = true;
      }
      // Local-runtime agent: opt into acp-proxy harness when both runtimeId
      // and acpAgentId are set. Partial config silently falls back to the
      // default cloud loop — same semantics as the CLI flag pair.
      if (form.runtimeId && form.acpAgentId) {
        payload._oma = {
          harness: "acp-proxy",
          runtime_binding: {
            runtime_id: form.runtimeId,
            acp_agent_id: form.acpAgentId,
            ...(form.localSkillBlocklist.length > 0
              ? { local_skill_blocklist: form.localSkillBlocklist }
              : {}),
          },
        };
      }

      const agent = await api<Agent>("/v1/agents", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      if (ambientRuleBody) {
        try {
          await api(`/v1/agents/${agent.id}/ambient-rules`, {
            method: "POST",
            body: JSON.stringify(ambientRuleBody),
          });
        } catch (ambientErr) {
          const message =
            ambientErr instanceof Error
              ? ambientErr.message
              : "Failed to create ambient rule";
          toast.error("Agent created, but ambient setup failed.", {
            description: message,
          });
        }
      }
      closeCreate();
      onCreated?.();
      await goToSetup(agent);
    } catch (e: any) {
      setCreateError(e?.message || "Failed to create agent");
    }
  };

  const addMcp = () =>
    setForm({ ...form, mcpServers: [...form.mcpServers, { name: "", type: "url", url: "" }] });
  const addMcpFromRegistry = (entry: { id: string; name: string; url: string }) => {
    if (form.mcpServers.some((m) => m.url === entry.url)) return;
    setForm({
      ...form,
      mcpServers: [...form.mcpServers, { name: entry.id, type: "url", url: entry.url }],
    });
  };
  const updateMcp = (i: number, field: keyof McpEntry, val: string) => {
    const updated = [...form.mcpServers];
    updated[i] = { ...updated[i], [field]: val };
    setForm({ ...form, mcpServers: updated });
  };
  const removeMcp = (i: number) =>
    setForm({ ...form, mcpServers: form.mcpServers.filter((_, j) => j !== i) });

  const toggleAnthropicSkill = (skillId: string) => {
    const exists = form.skills.find((s) => s.type === "anthropic" && s.skill_id === skillId);
    if (exists) {
      setForm({
        ...form,
        skills: form.skills.filter((s) => !(s.type === "anthropic" && s.skill_id === skillId)),
      });
    } else {
      setForm({
        ...form,
        skills: [...form.skills, { type: "anthropic", skill_id: skillId }],
      });
    }
  };

  const addCallable = (agentId: string) => {
    if (form.callableAgents.find((c) => c.id === agentId)) return;
    setForm({
      ...form,
      callableAgents: [...form.callableAgents, { type: "agent", id: agentId, version: 1 }],
    });
  };
  const removeCallable = (i: number) =>
    setForm({ ...form, callableAgents: form.callableAgents.filter((_, j) => j !== i) });

  const selectTemplate = (tmpl: AgentTemplate) => {
    const baseForm = {
      ...INITIAL_FORM,
      environmentId: form.environmentId || environments[0]?.id || "",
    };
    if (tmpl.id === "blank") {
      setForm(baseForm);
    } else {
      setForm({
        ...baseForm,
        name: tmpl.name,
        model: tmpl.model,
        system: tmpl.system,
        description: tmpl.description,
        mcpServers: tmpl.mcpServers.map((m) => ({ ...m })),
        skills: tmpl.skills.map((s) => ({ ...s } as SkillEntry)),
      });
    }
    setCreateStep("form");
    setTab(tmpl.id === "blank" ? "integrations" : "basic");
  };

  // Convert current form state to a config object
  const formToConfig = () => {
    const config: Record<string, unknown> = {
      name: form.name,
      model: form.model,
    };
    if (form.system) config.system = form.system;
    if (form.description) config.description = form.description;
    config.tools = buildToolsField();
    const mcpServers = mergedMcpServersForCreate();
    if (mcpServers.length) config.mcp_servers = mcpServers;
    if (form.skills.length) config.skills = form.skills;
    if (form.callableAgents.length) {
      config.multiagent = { type: "coordinator", agents: form.callableAgents };
    }
    const metadata: Record<string, unknown> = {};
    if (form.environmentId) metadata.default_environment_id = form.environmentId;
    if (form.defaultVaultIds.length > 0) metadata.default_vault_ids = form.defaultVaultIds;
    if (form.composioToolkits.length > 0) metadata.composio_toolkits = form.composioToolkits;
    if (Object.keys(metadata).length > 0) config.metadata = metadata;
    if (form.enableGeneralSubagent) {
      config.enable_general_subagent = true;
    }
    return config;
  };

  // Switch between form/yaml/json modes
  const switchMode = (mode: "form" | "yaml" | "json") => {
    if (mode === createMode) return;
    if (createMode === "form") {
      // form → code: serialize current form
      const config = formToConfig();
      setCodeValue(
        mode === "yaml" ? yaml.dump(config, { lineWidth: -1 }) : JSON.stringify(config, null, 2),
      );
    } else if (mode === "form") {
      // code → form: try to parse back (best-effort, may lose data)
      try {
        const parsed =
          createMode === "yaml"
            ? (yaml.load(codeValue) as Record<string, unknown>)
            : JSON.parse(codeValue);
        const rb = parsed.runtime_binding as
          | { runtime_id?: string; acp_agent_id?: string; local_skill_blocklist?: string[] }
          | undefined;
        const metadata =
          parsed.metadata && typeof parsed.metadata === "object"
            ? (parsed.metadata as Record<string, unknown>)
            : {};
        // Tool policy round-trip: extract default + per-tool overrides
        // from the first agent_toolset_20260401 entry. Custom tools and
        // MCP toolsets pass through untouched in YAML/JSON view but
        // can't currently be edited in the Form view.
        const toolset = Array.isArray(parsed.tools)
          ? (parsed.tools as Array<Record<string, unknown>>).find(
              (t) => t?.type === "agent_toolset_20260401",
            )
          : undefined;
        const dc = (toolset?.default_config ?? {}) as {
          enabled?: boolean;
          permission_policy?: { type?: string };
        };
        const cfgs = (toolset?.configs ?? []) as Array<{
          name?: string;
          enabled?: boolean;
          permission_policy?: { type?: string };
        }>;
        const overrides: Record<string, ToolOverride> = {};
        for (const c of cfgs) {
          if (!c?.name) continue;
          if (c.enabled === false) overrides[c.name] = "disabled";
          else if (c.permission_policy?.type === "always_ask") overrides[c.name] = "always_ask";
          else if (c.permission_policy?.type === "always_allow") overrides[c.name] = "always_allow";
        }
        setForm({
          ...INITIAL_FORM,
          name: String(parsed.name || ""),
          // Paste-mode fallback: if the pasted config has no model field,
          // claude-sonnet-4-6 is a real, current Anthropic model id (not
          // a placeholder), so it's a reasonable default. The form
          // dropdown does its own dynamic option set from modelCards.
          model: String(parsed.model || "claude-sonnet-4-6"),
          system: String(parsed.system || ""),
          description: String(parsed.description || ""),
          mcpServers: Array.isArray(parsed.mcp_servers)
            ? (parsed.mcp_servers as McpEntry[])
            : [],
          composioToolkits: Array.isArray(metadata.composio_toolkits)
            ? metadata.composio_toolkits.filter((id): id is string => typeof id === "string")
            : [],
          defaultVaultIds: Array.isArray(metadata.default_vault_ids)
            ? metadata.default_vault_ids.filter((id): id is string => typeof id === "string")
            : [],
          environmentId:
            typeof metadata.default_environment_id === "string"
              ? metadata.default_environment_id
              : "",
          skills: Array.isArray(parsed.skills) ? (parsed.skills as SkillEntry[]) : [],
          callableAgents: Array.isArray(parsed.multiagent?.agents)
            ? (parsed.multiagent.agents as CallableEntry[])
            : [],
          runtimeId: rb?.runtime_id ?? "",
          acpAgentId: rb?.acp_agent_id ?? "claude-agent-acp",
          localSkillBlocklist: Array.isArray(rb?.local_skill_blocklist)
            ? rb.local_skill_blocklist
            : [],
          toolDefaultEnabled: dc.enabled ?? true,
          toolDefaultPermission:
            dc.permission_policy?.type === "always_ask" ? "always_ask" : "always_allow",
          toolOverrides: overrides,
          enableGeneralSubagent: parsed.enable_general_subagent === true,
        });
      } catch {
        /* keep current form if parse fails */
      }
    } else {
      // yaml ↔ json: convert between formats
      try {
        const parsed = createMode === "yaml" ? yaml.load(codeValue) : JSON.parse(codeValue);
        setCodeValue(
          mode === "yaml"
            ? yaml.dump(parsed, { lineWidth: -1 })
            : JSON.stringify(parsed, null, 2),
        );
      } catch {
        /* keep current value if parse fails */
      }
    }
    setCreateMode(mode);
  };

  // Create agent from code editor
  const createFromCode = async () => {
    setCreateError("");
    try {
      const parsed =
        createMode === "yaml"
          ? (yaml.load(codeValue) as Record<string, unknown>)
          : JSON.parse(codeValue);
      if (!parsed.name) {
        setCreateError("name is required");
        return;
      }
      if (!parsed.tools) parsed.tools = [{ type: "agent_toolset_20260401" }];
      const agent = await api<Agent>("/v1/agents", {
        method: "POST",
        body: JSON.stringify(parsed),
      });
      closeCreate();
      onCreated?.();
      await goToSetup(agent);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Invalid config";
      setCreateError(msg);
    }
  };

  const filteredTemplates = templateSearch
    ? AGENT_TEMPLATES.filter(
        (t) =>
          t.name.toLowerCase().includes(templateSearch.toLowerCase()) ||
          t.description.toLowerCase().includes(templateSearch.toLowerCase()) ||
          t.tags.some((tag) => tag.toLowerCase().includes(templateSearch.toLowerCase())),
      )
    : AGENT_TEMPLATES;

  const inputCls =
    "w-full border border-border rounded-md px-3 py-2 min-h-11 sm:min-h-0 text-sm bg-bg text-fg outline-none focus:border-brand transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] placeholder:text-fg-subtle";
  const tabCls = (t: string) =>
    `inline-flex items-center justify-center px-3 py-1.5 min-h-11 sm:min-h-0 text-sm rounded-md transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] ${
      tab === t ? "bg-brand text-brand-fg" : "text-fg-muted hover:bg-bg-surface"
    }`;

  // Resolve which card the Model dropdown should highlight: explicit pick
  // wins, otherwise derive from model_id (paste path / pre-select effect).
  // Empty string when nothing matches (e.g. paste mode with an unknown model).
  const selectedCardId =
    form.modelCardId || modelCards.find((mc) => mc.model_id === form.model)?.id || "";

  if (!open) {
    // Render the MCP picker anyway? No — it only makes sense while the
    // form dialog is mounted.
    return null;
  }

  return (
    <>
      <div
        className="fixed inset-0 bg-bg-overlay flex items-center justify-center z-50"
        onClick={closeCreate}
      >
        <div
          ref={createDialogRef}
          role="dialog"
          aria-modal="true"
          aria-label="New Agent"
            className="bg-bg rounded-lg shadow-xl w-full max-w-5xl max-h-[85vh] flex flex-col"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Template selection step */}
          {createStep === "template" && (
            <>
              <div className="px-6 pt-6 pb-4 border-b border-border">
                <h2 className="font-display text-lg font-semibold text-fg">New Agent</h2>
                <p className="text-sm text-fg-muted mt-1">
                  Start from a template or build from scratch.
                </p>
                <input
                  value={templateSearch}
                  onChange={(e) => setTemplateSearch(e.target.value)}
                  className={`${inputCls} mt-3`}
                  placeholder="Search templates..."
                  aria-label="Search templates"
                />
              </div>
              <div className="flex-1 overflow-y-auto px-6 py-4">
                <div className="grid grid-cols-2 gap-3">
                  {filteredTemplates.map((tmpl) => (
                    <button
                      key={tmpl.id}
                      onClick={() => selectTemplate(tmpl)}
                      className="text-left border border-border rounded-lg p-4 hover:border-brand hover:bg-bg-surface transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
                    >
                      <div className="font-medium text-sm text-fg">{tmpl.name}</div>
                      <div className="text-xs text-fg-muted mt-1 line-clamp-2">
                        {tmpl.description}
                      </div>
                      {tmpl.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-2">
                          {tmpl.tags.map((tag) => (
                            <span
                              key={tag}
                              className="px-1.5 py-0.5 bg-bg-surface text-fg-muted rounded text-[10px]"
                            >
                              {tag}
                            </span>
                          ))}
                        </div>
                      )}
                    </button>
                  ))}
                </div>
                {filteredTemplates.length === 0 && (
                  <div className="text-center py-8 text-fg-subtle text-sm">
                    No templates match your search.
                  </div>
                )}
              </div>
              <div className="px-6 py-4 border-t border-border flex justify-end">
                <button
                  onClick={closeCreate}
                  className="inline-flex items-center min-h-11 sm:min-h-0 px-4 py-2 text-sm text-fg-muted hover:text-fg"
                >
                  Cancel
                </button>
              </div>
            </>
          )}

          {/* Form step */}
          {createStep === "form" && (
            <>
              <div className="px-6 pt-6 pb-4 border-b border-border">
                <div className="flex items-center justify-between mb-1">
                  <button
                    onClick={() => {
                      setCreateStep("template");
                      setTemplateSearch("");
                      setCreateMode("form");
                    }}
                    className="inline-flex items-center min-h-11 sm:min-h-0 text-sm text-fg-subtle hover:text-fg transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
                  >
                    &larr; Templates
                  </button>
                  <div className="flex items-center gap-0.5 bg-bg-surface rounded-md p-0.5">
                    {(["form", "yaml", "json"] as const).map((m) => (
                      <button
                        key={m}
                        onClick={() => switchMode(m)}
                        className={`inline-flex items-center justify-center px-2 py-1 min-h-11 sm:min-h-0 text-xs rounded transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] ${
                          createMode === m
                            ? "bg-bg text-fg font-medium shadow-sm"
                            : "text-fg-muted hover:text-fg"
                        }`}
                      >
                        {m === "form" ? "Form" : m.toUpperCase()}
                      </button>
                    ))}
                  </div>
                </div>
                <h2 className="font-display text-lg font-semibold text-fg">New Agent</h2>
                {createMode === "form" && (
                  <div
                    role="tablist"
                    aria-label="Agent configuration sections"
                    className="flex flex-wrap gap-1 mt-3"
                  >
                    <button
                      role="tab"
                      aria-selected={tab === "basic"}
                      tabIndex={tab === "basic" ? 0 : -1}
                      onClick={() => setTab("basic")}
                      className={tabCls("basic")}
                    >
                      Basic
                    </button>
                    <button
                      role="tab"
                      aria-selected={tab === "integrations"}
                      tabIndex={tab === "integrations" ? 0 : -1}
                      onClick={() => setTab("integrations")}
                      className={tabCls("integrations")}
                    >
                      Integrations{" "}
                      {form.composioToolkits.length > 0 && (
                        <span className="ml-1 text-xs opacity-60">
                          ({form.composioToolkits.length})
                        </span>
                      )}
                    </button>
                    <button
                      role="tab"
                      aria-selected={tab === "ambient"}
                      tabIndex={tab === "ambient" ? 0 : -1}
                      onClick={() => setTab("ambient")}
                      className={tabCls("ambient")}
                    >
                      Ambient{" "}
                      {form.ambientEnabled && (
                        <span className="ml-1 text-xs opacity-60">(1)</span>
                      )}
                    </button>
                    <button
                      role="tab"
                      aria-selected={tab === "tools"}
                      tabIndex={tab === "tools" ? 0 : -1}
                      onClick={() => setTab("tools")}
                      className={tabCls("tools")}
                    >
                      Tools{" "}
                      {Object.keys(form.toolOverrides).length > 0 && (
                        <span className="ml-1 text-xs opacity-60">
                          ({Object.keys(form.toolOverrides).length})
                        </span>
                      )}
                    </button>
                    <button
                      role="tab"
                      aria-selected={tab === "sandbox"}
                      tabIndex={tab === "sandbox" ? 0 : -1}
                      onClick={() => setTab("sandbox")}
                      className={tabCls("sandbox")}
                    >
                      Sandbox
                    </button>
                    <button
                      role="tab"
                      aria-selected={tab === "skills"}
                      tabIndex={tab === "skills" ? 0 : -1}
                      onClick={() => setTab("skills")}
                      className={tabCls("skills")}
                    >
                      Skills{" "}
                      {form.skills.length > 0 && (
                        <span className="ml-1 text-xs opacity-60">({form.skills.length})</span>
                      )}
                    </button>
                    <button
                      role="tab"
                      aria-selected={tab === "mcp"}
                      tabIndex={tab === "mcp" ? 0 : -1}
                      onClick={() => setTab("mcp")}
                      className={tabCls("mcp")}
                    >
                      MCP Servers{" "}
                      {form.mcpServers.length > 0 && (
                        <span className="ml-1 text-xs opacity-60">
                          ({form.mcpServers.length})
                        </span>
                      )}
                    </button>
                    <button
                      role="tab"
                      aria-selected={tab === "agents"}
                      tabIndex={tab === "agents" ? 0 : -1}
                      onClick={() => setTab("agents")}
                      className={tabCls("agents")}
                    >
                      Multi-Agent{" "}
                      {form.callableAgents.length > 0 && (
                        <span className="ml-1 text-xs opacity-60">
                          ({form.callableAgents.length})
                        </span>
                      )}
                    </button>
                  </div>
                )}
              </div>

              <div className="flex-1 overflow-y-auto px-6 py-4">
                {/* Code editor mode (YAML/JSON) */}
                {createMode !== "form" && (
                  <div className="space-y-3 h-full flex flex-col">
                    {createError && (
                      <div className="text-sm text-danger bg-danger-subtle border border-danger/30 rounded-lg px-3 py-2">
                        {createError}
                      </div>
                    )}
                    <textarea
                      value={codeValue}
                      onChange={(e) => setCodeValue(e.target.value)}
                      className={`${inputCls} flex-1 resize-none font-mono text-xs leading-relaxed min-h-[300px]`}
                      spellCheck={false}
                    />
                  </div>
                )}
                {/* Form mode */}
                {createMode === "form" && tab === "basic" && (
                  <BasicTab
                    form={form}
                    setForm={setForm}
                    createError={createError}
                    inputCls={inputCls}
                    modelCards={modelCards}
                    runtimes={runtimes}
                    selectedCardId={selectedCardId}
                  />
                )}

                {createMode === "form" && tab === "integrations" && (
                  <IntegrationsTab
                    form={form}
                    search={integrationSearch}
                    setSearch={setIntegrationSearch}
                    connections={composioConnections}
                    connecting={connectingIntegration}
                    composioConfigured={composioConfigured}
                    composioStatusLoading={composioStatusLoading}
                    onComposioConnected={() => void refetchComposioStatus()}
                    onToggle={toggleIntegration}
                    onConnect={(entry) => void connectComposioToolkit(entry)}
                  />
                )}

                {createMode === "form" && tab === "ambient" && (
                  <AmbientTab
                    form={form}
                    setForm={setForm}
                    inputCls={inputCls}
                    createError={createError}
                  />
                )}

                {createMode === "form" && tab === "tools" && (
                  <ToolsTab form={form} setForm={setForm} createError={createError} />
                )}

                {createMode === "form" && tab === "skills" && (
                  <SkillsTab
                    form={form}
                    setForm={setForm}
                    customSkills={customSkills}
                    toggleAnthropicSkill={toggleAnthropicSkill}
                  />
                )}

                {createMode === "form" && tab === "mcp" && (
                  <McpTab
                    form={form}
                    inputCls={inputCls}
                    onPickFromRegistry={() => setShowMcpPicker(true)}
                    addMcp={addMcp}
                    updateMcp={updateMcp}
                    removeMcp={removeMcp}
                  />
                )}

                {createMode === "form" && tab === "sandbox" && (
                  <SandboxTab
                    form={form}
                    setForm={setForm}
                    environments={environments}
                    sandboxConfig={sandboxConfig}
                    inputCls={inputCls}
                  />
                )}

                {createMode === "form" && tab === "agents" && (
                  <AgentsTab
                    form={form}
                    setForm={setForm}
                    allAgents={allAgents}
                    addCallable={addCallable}
                    removeCallable={removeCallable}
                  />
                )}
              </div>

              <div className="px-6 py-4 border-t border-border flex justify-between items-center">
                <div className="text-xs text-fg-subtle">
                  {createMode === "form" && (
                    <>
                      {form.composioToolkits.length > 0 && (
                        <span className="mr-3">{form.composioToolkits.length} apps</span>
                      )}
                      {form.environmentId && (
                        <span className="mr-3">sandbox selected</span>
                      )}
                      {form.ambientEnabled && (
                        <span className="mr-3">ambient rule</span>
                      )}
                      {form.skills.length > 0 && (
                        <span className="mr-3">{form.skills.length} skills</span>
                      )}
                      {form.mcpServers.length > 0 && (
                        <span className="mr-3">{form.mcpServers.length} MCP</span>
                      )}
                      {form.callableAgents.length > 0 && (
                        <span>{form.callableAgents.length} agents</span>
                      )}
                    </>
                  )}
                  {createMode !== "form" && <span>{createMode.toUpperCase()} editor</span>}
                </div>
                <div className="flex gap-2">
                  <Button variant="ghost" onClick={closeCreate}>
                    Cancel
                  </Button>
                  {createMode === "form" ? (
                    <Button onClick={create} disabled={!form.name}>
                      Create Agent
                    </Button>
                  ) : (
                    <Button onClick={createFromCode} disabled={!codeValue.trim()}>
                      Create Agent
                    </Button>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* MCP server registry picker — same MCP_REGISTRY the vault page uses */}
      <McpServerPickerModal
        open={showMcpPicker}
        onClose={() => setShowMcpPicker(false)}
        alreadyAddedUrls={form.mcpServers.map((m) => m.url)}
        onPick={addMcpFromRegistry}
      />
    </>
  );
}

type FormState = typeof INITIAL_FORM;
type FormSetter = React.Dispatch<React.SetStateAction<FormState>>;

function buildAmbientRuleBody(form: FormState): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: form.ambientRuleName.trim() || `${form.name.trim()} heartbeat`,
    enabled: form.ambientRuleActive,
    trigger: buildAmbientTrigger(form.ambientTrigger),
    wake_mode: form.ambientWakeMode,
  };
  const description = form.ambientRuleDescription.trim();
  if (description) body.description = description;
  const policy = buildDecisionPolicy(form.ambientDecisionPreset);
  if (policy) body.decision_policy = policy;
  const budget = buildBudget(form.ambientBudgetPreset);
  if (budget) body.budget = budget;
  if (form.ambientNextWakeAt) {
    const nextWakeAt = new Date(form.ambientNextWakeAt);
    if (Number.isNaN(nextWakeAt.getTime())) {
      throw new Error("Next wake must be a valid date and time");
    }
    body.next_wake_at = nextWakeAt.toISOString();
  }
  return body;
}

function AmbientTab({
  form,
  setForm,
  inputCls,
  createError,
}: {
  form: FormState;
  setForm: FormSetter;
  inputCls: string;
  createError: string;
}) {
  return (
    <div className="space-y-4">
      {createError && (
        <div className="text-sm text-danger bg-danger-subtle border border-danger/30 rounded-lg px-3 py-2">
          {createError}
        </div>
      )}

      <div className="rounded-md border border-border bg-bg-surface px-3 py-3">
        <label className="flex items-start gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={form.ambientEnabled}
            onChange={(e) => setForm({ ...form, ambientEnabled: e.target.checked })}
            className="accent-brand mt-0.5"
          />
          <div>
            <div className="font-medium text-fg">Create an ambient rule</div>
            <p className="text-xs text-fg-subtle mt-0.5">
              Attach the agent's first wake rule during creation.
            </p>
          </div>
        </label>
      </div>

      {form.ambientEnabled && (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <AmbientField label="Rule name">
              <input
                value={form.ambientRuleName}
                onChange={(e) => setForm({ ...form, ambientRuleName: e.target.value })}
                className={inputCls}
                placeholder={`${form.name || "Agent"} heartbeat`}
              />
            </AmbientField>
            <AmbientField label="Next wake">
              <input
                type="datetime-local"
                value={form.ambientNextWakeAt}
                onChange={(e) => setForm({ ...form, ambientNextWakeAt: e.target.value })}
                className={inputCls}
              />
            </AmbientField>
          </div>

          <AmbientField label="Description">
            <input
              value={form.ambientRuleDescription}
              onChange={(e) => setForm({ ...form, ambientRuleDescription: e.target.value })}
              className={inputCls}
              placeholder="Check for new pull requests every hour"
            />
          </AmbientField>

          <AmbientTriggerControls
            value={form.ambientTrigger}
            onChange={(ambientTrigger) => setForm({ ...form, ambientTrigger })}
            inputClassName={inputCls}
          />

          <div className="grid gap-3 sm:grid-cols-3">
            <AmbientField label="Wake mode">
              <select
                value={form.ambientWakeMode}
                onChange={(e) =>
                  setForm({ ...form, ambientWakeMode: e.target.value as AmbientWakeMode })
                }
                className={inputCls}
              >
                {AMBIENT_WAKE_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {mode}
                  </option>
                ))}
              </select>
            </AmbientField>
            <AmbientField label="Status">
              <label className="inline-flex w-full items-center gap-2 rounded-md border border-border bg-bg px-3 py-2 min-h-11 sm:min-h-0 text-sm text-fg-muted">
                <input
                  type="checkbox"
                  checked={form.ambientRuleActive}
                  onChange={(e) => setForm({ ...form, ambientRuleActive: e.target.checked })}
                  className="accent-brand"
                />
                Active
              </label>
            </AmbientField>
            <AmbientField label="Decision">
              <select
                value={form.ambientDecisionPreset}
                onChange={(e) =>
                  setForm({
                    ...form,
                    ambientDecisionPreset: e.target.value as AmbientDecisionPreset,
                  })
                }
                className={inputCls}
              >
                <option value="always">Always wake</option>
                <option value="new_signal">Only for new signal</option>
                <option value="approval_required">Ask before acting</option>
              </select>
            </AmbientField>
            <AmbientField label="Budget">
              <select
                value={form.ambientBudgetPreset}
                onChange={(e) =>
                  setForm({
                    ...form,
                    ambientBudgetPreset: e.target.value as AmbientBudgetPreset,
                  })
                }
                className={inputCls}
              >
                <option value="conservative">Conservative</option>
                <option value="standard">Standard</option>
                <option value="intensive">High frequency</option>
              </select>
            </AmbientField>
          </div>
        </div>
      )}
    </div>
  );
}

function AmbientField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block text-sm text-fg-muted">
      <span className="block mb-1">{label}</span>
      {children}
    </label>
  );
}

interface BasicTabProps {
  form: FormState;
  setForm: FormSetter;
  createError: string;
  inputCls: string;
  modelCards: ModelCard[];
  runtimes: AgentFormDialogProps["runtimes"];
  selectedCardId: string;
}

function BasicTab({
  form,
  setForm,
  createError,
  inputCls,
  modelCards,
  runtimes,
  selectedCardId,
}: BasicTabProps) {
  const runtimeRows = Array.isArray(runtimes) ? runtimes : [];
  return (
    <div className="space-y-3">
      {createError && (
        <div className="text-sm text-danger bg-danger-subtle border border-danger/30 rounded-lg px-3 py-2">
          {createError}
        </div>
      )}
      <div>
        <label htmlFor="agent-name" className="text-sm text-fg-muted block mb-1">
          Name *
        </label>
        <input
          id="agent-name"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          className={inputCls}
          placeholder="Coding Assistant"
        />
      </div>
      {/* Model picker — see comments at the original call site. */}
      {!form.runtimeId &&
        (modelCards.length === 0 ? (
          <p className="text-xs text-fg-subtle bg-bg-surface px-3 py-2 rounded-lg">
            No model cards configured. Cloud agents need at least one card to provide LLM
            credentials.{" "}
            <a href="/model-cards" className="underline hover:text-fg-muted">
              Add one
            </a>
            .
          </p>
        ) : (
          <div>
            <label className="text-sm text-fg-muted block mb-1">Model</label>
            <Combobox<ModelCard>
              value={selectedCardId}
              onValueChange={(v, item) => {
                setForm({ ...form, modelCardId: v, model: item?.model_id ?? v });
              }}
              endpoint="/v1/model_cards"
              getValue={(mc) => mc.id}
              getLabel={(mc) => (
                <span>
                  {mc.is_default ? "★ " : ""}
                  {mc.model_id}
                  {mc.model !== mc.model_id && (
                    <span className="text-fg-subtle text-[12px]"> ({mc.model})</span>
                  )}
                </span>
              )}
              getTextLabel={(mc) =>
                `${mc.is_default ? "★ " : ""}${mc.model_id}${
                  mc.model !== mc.model_id ? ` (${mc.model})` : ""
                }`
              }
              placeholder={
                !selectedCardId && form.model
                  ? `⚠ ${form.model} — no matching card, pick one`
                  : "Select a model card..."
              }
            />
          </div>
        ))}
      {form.runtimeId && (
        <p className="text-xs text-fg-subtle bg-bg-surface px-3 py-2 rounded-lg">
          Model is determined by the ACP child on the runtime ({form.acpAgentId || "—"}) — it
          uses its own LLM credentials.
        </p>
      )}
      <div>
        <label htmlFor="agent-description" className="text-sm text-fg-muted block mb-1">
          Description
        </label>
        <input
          id="agent-description"
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          className={inputCls}
          placeholder="A coding assistant that writes clean code..."
        />
      </div>
      <div>
        <label htmlFor="agent-system" className="text-sm text-fg-muted block mb-1">
          System Prompt
        </label>
        <textarea
          id="agent-system"
          value={form.system}
          onChange={(e) => setForm({ ...form, system: e.target.value })}
          rows={5}
          className={`${inputCls} resize-none font-mono text-xs leading-relaxed`}
          placeholder="You are a helpful assistant..."
        />
      </div>
      {/* Local Runtime — bind agent's loop to a user-registered machine
          instead of OMA's cloud SessionDO. The "no runtime" option is the
          default cloud agent. */}
      <div>
        <label className="text-sm text-fg-muted block mb-1">
          Local Runtime
          <span className="ml-1 text-xs text-fg-subtle">(optional)</span>
        </label>
        {runtimeRows.length === 0 ? (
          <p className="text-xs text-fg-subtle bg-bg-surface px-3 py-2 rounded-lg">
            No runtimes registered.{" "}
            <a href="/runtimes" className="underline hover:text-fg-muted">
              Connect a machine
            </a>{" "}
            to delegate this agent's loop to your own Claude Code (or other ACP) child.
          </p>
        ) : (
          <>
            <Select
              value={form.runtimeId || "__cloud__"}
              onValueChange={(v) => {
                const rid = v === "__cloud__" ? "" : v;
                // Auto-pick the first detected ACP agent on the chosen runtime —
                // user doesn't have to know what strings the daemon emits.
                const first = runtimeRows.find((r) => r.id === rid)?.agents?.[0]?.id;
                setForm({
                  ...form,
                  runtimeId: rid,
                  acpAgentId: rid && first ? first : form.acpAgentId,
                });
              }}
              placeholder={`— Cloud (run on ${BRAND_NAME}) —`}
            >
              <SelectOption value="__cloud__">
                — Cloud (run on {BRAND_NAME}) —
              </SelectOption>
              {runtimeRows.map((r) => (
                <SelectOption key={r.id} value={r.id} disabled={r.status !== "online"}>
                  {r.hostname} ({r.status}
                  {r.status === "online" && r.agents?.length
                    ? ` · ${r.agents.length} agents`
                    : ""}
                  )
                </SelectOption>
              ))}
            </Select>
            {form.runtimeId && (
              <AcpAgentPicker form={form} setForm={setForm} runtimes={runtimeRows} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function AcpAgentPicker({
  form,
  setForm,
  runtimes,
}: {
  form: FormState;
  setForm: FormSetter;
  runtimes: AgentFormDialogProps["runtimes"];
}) {
  const detectedAgents = runtimes.find((r) => r.id === form.runtimeId)?.agents ?? [];
  // OMA promotes 4 agents as "first class" in the UI (overlay's
  // `featured` flag). Featured-detected render on top so the common
  // case is one click. Anything not detected by the daemon is
  // intentionally hidden — users must install via cli first.
  const featuredIds = new Set(KNOWN_ACP_AGENTS.filter((e) => e.featured).map((e) => e.id));
  const featuredDetected = detectedAgents.filter((a) => featuredIds.has(a.id));
  const otherDetected = detectedAgents.filter((a) => !featuredIds.has(a.id));

  // Canonicalize first: form.acpAgentId may be a legacy alias on stale
  // rows ("claude-code-acp"), but the daemon emits local_skills under the
  // canonical key ("claude-agent-acp"). Without resolving here the
  // blocklist would silently show empty even though skills exist.
  const canonicalId = resolveKnownAgent(form.acpAgentId)?.id ?? form.acpAgentId;
  const localSkills =
    runtimes.find((r) => r.id === form.runtimeId)?.local_skills?.[canonicalId] ?? [];

  return (
    <div className="mt-2">
      <label className="text-xs text-fg-subtle block mb-1">ACP agent on this machine</label>
      <Select
        value={form.acpAgentId}
        onValueChange={(v) =>
          setForm({ ...form, acpAgentId: v, localSkillBlocklist: [] })
        }
      >
        {featuredDetected.length > 0 && (
          <SelectGroup>
            <SelectGroupLabel>★ Featured</SelectGroupLabel>
            {featuredDetected.map((a) => (
              <SelectOption key={a.id} value={a.id}>
                {a.id}
              </SelectOption>
            ))}
          </SelectGroup>
        )}
        {otherDetected.length > 0 && (
          <SelectGroup>
            <SelectGroupLabel>Other detected on this runtime</SelectGroupLabel>
            {otherDetected.map((a) => (
              <SelectOption key={a.id} value={a.id}>
                {a.id}
              </SelectOption>
            ))}
          </SelectGroup>
        )}
      </Select>
      <p className="text-xs text-fg-subtle mt-1">
        Each turn spawns this ACP child on the runtime. Model + skills come from the
        daemon-fetched bundle.
      </p>

      {/* Local-skill blocklist — multi-select fed by what the daemon
          reported in hello.local_skills[acpAgentId]. */}
      {localSkills.length > 0 && (
        <LocalSkillBlocklist form={form} setForm={setForm} localSkills={localSkills} />
      )}
    </div>
  );
}

function LocalSkillBlocklist({
  form,
  setForm,
  localSkills,
}: {
  form: FormState;
  setForm: FormSetter;
  localSkills: Array<{
    id: string;
    name?: string;
    description?: string;
    source?: string;
    source_label?: string;
  }>;
}) {
  const allowed = new Set(localSkills.map((s) => s.id));
  for (const id of form.localSkillBlocklist) allowed.delete(id);
  return (
    <div className="mt-3 border border-border rounded-md p-2.5 bg-bg-surface">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs text-fg-muted">
          Local skills ({allowed.size}/{localSkills.length} visible)
        </span>
        <button
          type="button"
          onClick={() => setForm({ ...form, localSkillBlocklist: [] })}
          className="inline-flex items-center min-h-11 sm:min-h-0 px-1 text-[10px] text-fg-subtle hover:text-fg underline"
        >
          reset
        </button>
      </div>
      <div className="space-y-0.5 max-h-40 overflow-y-auto">
        {localSkills.map((s) => {
          const blocked = form.localSkillBlocklist.includes(s.id);
          return (
            <label
              key={s.id}
              className="flex items-start gap-2 text-xs cursor-pointer hover:bg-bg rounded px-1.5 py-0.5"
            >
              <input
                type="checkbox"
                checked={!blocked}
                onChange={(e) => {
                  const next = new Set(form.localSkillBlocklist);
                  if (e.target.checked) next.delete(s.id);
                  else next.add(s.id);
                  setForm({ ...form, localSkillBlocklist: [...next] });
                }}
                className="mt-0.5 accent-brand"
              />
              <span className="font-mono text-fg flex-shrink-0">{s.id}</span>
              <span className="text-fg-subtle">
                ({s.source ?? "global"}
                {s.source_label ? `:${s.source_label}` : ""})
              </span>
              {s.name && s.name !== s.id && (
                <span className="text-fg-muted truncate">— {s.name}</span>
              )}
            </label>
          );
        })}
      </div>
      <p className="text-[10px] text-fg-subtle mt-1.5">
        Unchecked = hidden from the ACP child (daemon won't symlink the dir into the spawn
        cwd).
      </p>
    </div>
  );
}

function IntegrationsTab({
  form,
  search,
  setSearch,
  connections,
  connecting,
  composioConfigured,
  composioStatusLoading,
  onComposioConnected,
  onToggle,
  onConnect,
}: {
  form: FormState;
  search: string;
  setSearch: (value: string) => void;
  connections: ComposioConnectionState;
  connecting: string | null;
  composioConfigured: boolean;
  composioStatusLoading: boolean;
  onComposioConnected: () => void;
  onToggle: (entry: ComposioIntegrationEntry) => void;
  onConnect: (entry: ComposioIntegrationEntry) => void;
}) {
  const { api } = useApi();
  const [composioKeyInput, setComposioKeyInput] = useState("");
  const [savingComposioKey, setSavingComposioKey] = useState(false);

  const saveComposioKey = async () => {
    const apiKey = composioKeyInput.trim();
    if (!apiKey) return;
    setSavingComposioKey(true);
    try {
      await api(`/v1/composio/key`, {
        method: "PUT",
        body: JSON.stringify({ api_key: apiKey }),
      });
      setComposioKeyInput("");
      toast.success("Composio connected — loading the app catalog");
      onComposioConnected();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save Composio key");
    } finally {
      setSavingComposioKey(false);
    }
  };
  const { data: catalogRes, isLoading: catalogLoading } =
    useApiQuery<ComposioToolkitCatalogResponse>("/v1/composio/toolkits?limit=500", undefined, {
      enabled: composioConfigured,
    });
  const catalogEntries = useMemo(() => composioEntriesFromCatalog(catalogRes), [catalogRes]);
  const filtered = useMemo(
    () => filterComposioEntries(catalogEntries, search),
    [catalogEntries, search],
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-fg">Connected apps</div>
          <div className="text-xs text-fg-subtle">
            {form.composioToolkits.length} selected
            {composioStatusLoading || (composioConfigured && catalogLoading)
              ? " · loading catalog"
              : ` · ${catalogEntries.length} available`}
          </div>
        </div>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search apps..."
          className="w-full sm:w-64 border border-border rounded-md px-3 py-2 min-h-11 sm:min-h-0 text-sm bg-bg text-fg outline-none focus:border-brand placeholder:text-fg-subtle"
        />
      </div>

      {!composioStatusLoading && !composioConfigured && (
        <div className="rounded-md border border-border bg-bg-surface p-3 shadow-sm">
          <div className="text-sm font-medium text-fg">Connect Composio</div>
          <p className="mt-1 text-[13px] leading-relaxed text-fg-muted">
            Integrations are powered by Composio. Paste an API key from{" "}
            <a
              href="https://app.composio.dev"
              target="_blank"
              rel="noreferrer"
              className="text-brand hover:underline"
            >
              app.composio.dev
            </a>{" "}
            — stored encrypted in your workspace, used only for your agents.
          </p>
          <div className="mt-2.5 flex gap-2">
            <input
              type="password"
              value={composioKeyInput}
              onChange={(e) => setComposioKeyInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void saveComposioKey();
                }
              }}
              placeholder="Composio API key"
              autoComplete="off"
              className="flex-1 border border-border rounded-md px-3 py-1.5 text-sm bg-bg text-fg outline-none focus:border-brand transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] placeholder:text-fg-subtle font-mono"
            />
            <Button
              type="button"
              size="sm"
              onClick={() => void saveComposioKey()}
              disabled={savingComposioKey || !composioKeyInput.trim()}
            >
              {savingComposioKey ? "Verifying…" : "Connect"}
            </Button>
          </div>
        </div>
      )}

      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {filtered.map((entry) => {
          const selected = form.composioToolkits.includes(entry.slug);
          const connection = connections[entry.slug];
          const connected = connection?.status === "connected";
          const pending = connection?.status === "pending";
          return (
            <div
              key={entry.slug}
              className={`border rounded-md p-3 bg-bg flex flex-col gap-3 ${
                selected ? "border-brand" : "border-border"
              }`}
            >
              <div className="flex items-start gap-3 min-w-0">
                <img
                  src={composioIntegrationIcon(entry)}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  className="w-7 h-7 rounded shrink-0"
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = "none";
                  }}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="font-medium text-sm text-fg truncate">{entry.name}</div>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-surface text-fg-subtle shrink-0">
                      {entry.category}
                    </span>
                  </div>
                  <div className="text-xs text-fg-subtle mt-1 line-clamp-2">
                    {entry.description}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2 mt-auto">
                <button
                  type="button"
                  onClick={() => onToggle(entry)}
                  className={`inline-flex items-center justify-center gap-1.5 min-h-11 sm:min-h-0 px-3 py-1.5 rounded-md text-xs border ${
                    selected
                      ? "border-brand bg-brand text-brand-fg"
                      : "border-border text-fg-muted hover:text-fg"
                  }`}
                >
                  {selected && <CheckIcon className="w-3 h-3" />}
                  {selected ? "Selected" : "Select"}
                </button>
                <Button
                  type="button"
                  variant={connected ? "outline" : "default"}
                  size="sm"
                  onClick={() => {
                    if (pending && connection?.redirectUrl) {
                      window.open(
                        connection.redirectUrl,
                        `composio-${entry.slug}`,
                        "width=600,height=720,popup=yes",
                      );
                    } else {
                      onConnect(entry);
                    }
                  }}
                  disabled={!composioConfigured || !!connecting}
                  className="gap-1.5"
                >
                  {connected ? <CheckIcon className="w-3.5 h-3.5" /> : <ExternalLinkIcon className="w-3.5 h-3.5" />}
                  {connected
                    ? "Connected"
                    : pending
                      ? "Open auth"
                    : connecting === entry.slug
                      ? "Opening"
                      : "Connect"}
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SandboxTab({
  form,
  setForm,
  environments,
  sandboxConfig,
  inputCls,
}: {
  form: FormState;
  setForm: FormSetter;
  environments: EnvironmentLite[];
  sandboxConfig: SandboxConfig | null;
  inputCls: string;
}) {
  const { api } = useApi();
  const selected = environments.find((env) => env.id === form.environmentId);
  const provider = sandboxConfig?.provider ?? "subprocess";
  const [checkingStorage, setCheckingStorage] = useState(false);
  const [storageCheck, setStorageCheck] = useState<SandboxStorageCheck | null>(null);
  const storageOk = storageCheck?.ok ?? sandboxConfig?.memory_s3_configured ?? false;
  const storageMessage = storageCheck
    ? storageCheck.ok
      ? `Verified ${storageCheck.checks.s3_write_read_delete.duration_ms ?? 0}ms`
      : storageCheck.checks.s3_write_read_delete.error ?? "Storage check failed"
    : sandboxConfig?.memory_s3_configured
      ? "Configured, not yet verified"
      : "Not configured";
  const runStorageCheck = async () => {
    setCheckingStorage(true);
    try {
      const result = await api<SandboxStorageCheck>("/v1/sandbox/storage-check", {
        method: "POST",
        body: "{}",
      });
      setStorageCheck(result);
      if (result.ok) {
        toast.success("Remote sandbox storage verified.");
      } else {
        toast.warning(result.checks.s3_write_read_delete.error ?? "Remote storage check failed.");
      }
    } catch {
      // useApi already surfaced the API error.
    } finally {
      setCheckingStorage(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="border border-border rounded-md p-3">
          <div className="text-xs text-fg-subtle">Provider</div>
          <div className="text-sm font-medium text-fg mt-1">{providerLabel(provider)}</div>
        </div>
        <div className="border border-border rounded-md p-3">
          <div className="text-xs text-fg-subtle">Image</div>
          <div className="text-sm font-mono text-fg mt-1">
            {sandboxConfig?.image || "default"}
          </div>
        </div>
        <div className="border border-border rounded-md p-3">
          <div className="text-xs text-fg-subtle">Remote storage</div>
          <div className="text-sm font-medium text-fg mt-1 flex items-center gap-1.5">
            {storageOk ? (
              <CheckIcon className="w-3.5 h-3.5 text-success" />
            ) : (
              <XCircleIcon className="w-3.5 h-3.5 text-danger" />
            )}
            {storageOk ? "S3 ready" : "Not ready"}
          </div>
        </div>
      </div>

      <div className="border border-border rounded-md p-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="text-sm font-medium text-fg">Daytona persistence</div>
            <div className="text-xs text-fg-subtle mt-1">
              {storageMessage}
            </div>
            {(sandboxConfig?.memory_s3_endpoint_host || sandboxConfig?.memory_s3_bucket) && (
              <div className="text-xs text-fg-subtle mt-2 font-mono break-all">
                {sandboxConfig.memory_s3_bucket ?? "bucket?"}
                {sandboxConfig.memory_s3_endpoint_host ? ` @ ${sandboxConfig.memory_s3_endpoint_host}` : ""}
                {sandboxConfig.memory_s3_region ? ` (${sandboxConfig.memory_s3_region})` : ""}
              </div>
            )}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void runStorageCheck()}
            disabled={checkingStorage}
            className="gap-1.5 shrink-0"
          >
            <RefreshCwIcon className={`w-3.5 h-3.5 ${checkingStorage ? "animate-spin" : ""}`} />
            {checkingStorage ? "Checking" : "Check storage"}
          </Button>
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-sm font-medium text-fg">Default environment</label>
          <a href="/environments" className="text-xs text-brand hover:underline">
            Manage environments
          </a>
        </div>
        {environments.length === 0 ? (
          <div className="border border-border rounded-md px-3 py-4 text-sm text-fg-subtle">
            No environments registered.
          </div>
        ) : (
          <Select
            value={form.environmentId}
            onValueChange={(v) => setForm({ ...form, environmentId: v })}
            placeholder="Select environment..."
          >
            {environments.map((env) => (
              <SelectOption key={env.id} value={env.id}>
                {env.name} ({env.id})
              </SelectOption>
            ))}
          </Select>
        )}
      </div>

      {selected && (
        <div className="border border-border rounded-md p-3 text-sm">
          <div className="font-medium text-fg">{selected.name}</div>
          {selected.description && (
            <div className="text-xs text-fg-subtle mt-1">{selected.description}</div>
          )}
          <div className="grid gap-2 sm:grid-cols-3 mt-3">
            <div>
              <div className="text-xs text-fg-subtle">Network</div>
              <div className="text-fg">{selected.config?.networking?.type ?? "default"}</div>
            </div>
            <div>
              <div className="text-xs text-fg-subtle">MCP</div>
              <div className="text-fg">
                {selected.config?.networking?.allow_mcp_servers === false ? "Blocked" : "Allowed"}
              </div>
            </div>
            <div>
              <div className="text-xs text-fg-subtle">Package managers</div>
              <div className="text-fg">
                {selected.config?.networking?.allow_package_managers === false
                  ? "Blocked"
                  : "Allowed"}
              </div>
            </div>
          </div>
        </div>
      )}

      {provider === "daytona" && !sandboxConfig?.daytona_api_key_configured && (
        <div className="text-sm text-danger bg-danger-subtle border border-danger/30 rounded-md px-3 py-2">
          DAYTONA_API_KEY is not configured.
        </div>
      )}

      <div>
        <label className="text-sm font-medium text-fg block mb-1">
          Default vault IDs
        </label>
        <input
          value={form.defaultVaultIds.join(", ")}
          onChange={(e) =>
            setForm({
              ...form,
              defaultVaultIds: e.target.value
                .split(/[,\s]+/)
                .map((v) => v.trim())
                .filter(Boolean),
            })
          }
          className={inputCls}
          placeholder="vault-..."
        />
      </div>
    </div>
  );
}

function ToolsTab({
  form,
  setForm,
  createError,
}: {
  form: FormState;
  setForm: FormSetter;
  createError: string;
}) {
  return (
    <div className="space-y-5">
      {createError && (
        <div className="text-sm text-danger bg-danger-subtle border border-danger/30 rounded-lg px-3 py-2">
          {createError}
        </div>
      )}

      <p className="text-xs text-fg-subtle leading-relaxed">
        Built-in toolset (AMA <span className="font-mono">agent_toolset_20260401</span>).
        Multi-agent delegation lives in its own tab and is a separate AMA field{" "}
        <span className="font-mono">multiagent</span> — not part of this toolset. External MCP
        tools live in the MCP Servers tab.
      </p>

      <div className="rounded-md border border-border bg-bg-surface px-3 py-3">
        <div className="text-sm font-medium text-fg mb-1">Default policy</div>
        <p className="text-xs text-fg-subtle mb-3">
          Applies to every tool below that's set to{" "}
          <span className="font-mono">default</span>.
        </p>
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.toolDefaultEnabled}
              onChange={(e) => setForm({ ...form, toolDefaultEnabled: e.target.checked })}
              className="accent-brand"
            />
            Enable tools
          </label>
          <div className="flex items-center gap-2 text-sm">
            <span className="text-fg-muted">Permission:</span>
            <select
              value={form.toolDefaultPermission}
              disabled={!form.toolDefaultEnabled}
              onChange={(e) =>
                setForm({
                  ...form,
                  toolDefaultPermission: e.target.value as "always_allow" | "always_ask",
                })
              }
              className="border border-border rounded-md px-2 py-1 text-sm bg-bg text-fg outline-none focus:border-brand disabled:opacity-40"
            >
              <option value="always_allow">always_allow</option>
              <option value="always_ask">always_ask</option>
            </select>
          </div>
        </div>
      </div>

      <div>
        <label className="text-sm font-medium text-fg block mb-2">Per-tool overrides</label>
        <p className="text-xs text-fg-subtle mb-3">
          Each row's effective state is shown in the dropdown. Pick{" "}
          <span className="font-mono">default</span> to inherit the policy above; pick a
          specific value to override. <span className="font-mono">always_ask</span> emits a{" "}
          <span className="font-mono">user.tool_confirmation</span> event the client must
          approve before each call.
        </p>
        <div className="border border-border rounded-md divide-y divide-border">
          {BUILTIN_TOOLS.map((bt) => {
            const current = form.toolOverrides[bt.name] ?? "default";
            const effectiveLabel = !form.toolDefaultEnabled
              ? "disabled"
              : form.toolDefaultPermission;
            const isOff =
              current === "disabled" || (current === "default" && !form.toolDefaultEnabled);
            return (
              <div
                key={bt.name}
                className={`flex items-center justify-between px-3 py-2 gap-3 ${
                  isOff ? "opacity-50" : ""
                }`}
              >
                <div className="min-w-0">
                  <div className="text-sm font-mono text-fg">{bt.label}</div>
                  <div className="text-xs text-fg-subtle truncate">{bt.description}</div>
                </div>
                <select
                  value={current}
                  onChange={(e) => {
                    const v = e.target.value as ToolOverride;
                    const next = { ...form.toolOverrides };
                    if (v === "default") delete next[bt.name];
                    else next[bt.name] = v;
                    setForm({ ...form, toolOverrides: next });
                  }}
                  className="border border-border rounded-md px-2 py-1 min-h-11 sm:min-h-0 text-xs bg-bg text-fg outline-none focus:border-brand shrink-0"
                >
                  <option value="default">default ({effectiveLabel})</option>
                  <option value="always_allow">always_allow</option>
                  <option value="always_ask">always_ask</option>
                  <option value="disabled">disabled</option>
                </select>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function SkillsTab({
  form,
  setForm,
  customSkills,
  toggleAnthropicSkill,
}: {
  form: FormState;
  setForm: FormSetter;
  customSkills: AgentFormDialogProps["customSkills"];
  toggleAnthropicSkill: (id: string) => void;
}) {
  // Hide skills that are already surfaced under Anthropic Skills above
  // (xlsx/pdf/pptx/docx — their backend rows show up in the same list as
  // user-registered skills, otherwise we duplicate).
  const anthropicIds = new Set(ANTHROPIC_SKILLS.map((s) => s.id));
  const filtered = customSkills.filter((cs) => !anthropicIds.has(cs.id));

  return (
    <div className="space-y-4">
      <div>
        <label className="text-sm font-medium text-fg block mb-2">Anthropic Skills</label>
        <div className="grid grid-cols-2 gap-2">
          {ANTHROPIC_SKILLS.map((s) => {
            const active = form.skills.some(
              (sk) => sk.type === "anthropic" && sk.skill_id === s.id,
            );
            return (
              <button
                key={s.id}
                onClick={() => toggleAnthropicSkill(s.id)}
                className={`flex items-center gap-2 px-3 py-2.5 rounded-md border text-sm text-left transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] ${
                  active
                    ? "border-brand bg-brand text-brand-fg"
                    : "border-border hover:border-border-strong"
                }`}
              >
                <span
                  className={`w-4 h-4 rounded border flex items-center justify-center text-xs ${
                    active
                      ? "bg-brand-fg text-brand border-brand-fg"
                      : "border-border-strong"
                  }`}
                >
                  {active && "✓"}
                </span>
                {s.label}
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <label className="text-sm font-medium text-fg block mb-2">Custom Skills</label>
        {filtered.length > 0 ? (
          <div className="space-y-2">
            {filtered.map((cs) => {
              const active = form.skills.some(
                (sk) => sk.type === "custom" && sk.skill_id === cs.id,
              );
              return (
                <button
                  key={cs.id}
                  onClick={() => {
                    if (active) {
                      setForm({
                        ...form,
                        skills: form.skills.filter(
                          (sk) => !(sk.type === "custom" && sk.skill_id === cs.id),
                        ),
                      });
                    } else {
                      setForm({
                        ...form,
                        skills: [
                          ...form.skills,
                          { type: "custom", skill_id: cs.id, version: "latest" },
                        ],
                      });
                    }
                  }}
                  className={`flex items-center gap-2 w-full px-3 py-2.5 rounded-md border text-sm text-left transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] ${
                    active
                      ? "border-brand bg-brand text-brand-fg"
                      : "border-border hover:border-border-strong"
                  }`}
                >
                  <span
                    className={`w-4 h-4 rounded border flex items-center justify-center text-xs shrink-0 ${
                      active
                        ? "bg-brand-fg text-brand border-brand-fg"
                        : "border-border-strong"
                    }`}
                  >
                    {active && "✓"}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium">{cs.name}</div>
                    <div
                      className={`text-xs truncate ${
                        active ? "text-brand-fg/70" : "text-fg-subtle"
                      }`}
                    >
                      {cs.description}
                    </div>
                  </div>
                  <span
                    className={`text-xs font-mono shrink-0 ${
                      active ? "text-brand-fg/60" : "text-fg-subtle"
                    }`}
                  >
                    {cs.id}
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <p className="text-xs text-fg-subtle">
            No custom skills registered.{" "}
            <a href="/skills" className="underline hover:text-fg-muted">
              Create one
            </a>
            .
          </p>
        )}
      </div>
    </div>
  );
}

function McpTab({
  form,
  inputCls,
  onPickFromRegistry,
  addMcp,
  updateMcp,
  removeMcp,
}: {
  form: FormState;
  inputCls: string;
  onPickFromRegistry: () => void;
  addMcp: () => void;
  updateMcp: (i: number, field: keyof McpEntry, val: string) => void;
  removeMcp: (i: number) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between mb-1">
        <label className="text-sm font-medium text-fg">MCP Servers</label>
        <div className="flex items-center gap-3">
          <button
            onClick={onPickFromRegistry}
            className="inline-flex items-center min-h-11 sm:min-h-0 text-xs text-fg-muted hover:text-fg transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
          >
            + Pick known
          </button>
          <button
            onClick={addMcp}
            className="inline-flex items-center min-h-11 sm:min-h-0 text-xs text-fg-muted hover:text-fg transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
          >
            + Custom URL
          </button>
        </div>
      </div>
      {form.mcpServers.map((mcp, i) => (
        <div key={i} className="border border-border rounded-lg p-3 space-y-2">
          <div className="flex gap-2">
            <div className="flex-1">
              <label htmlFor={`mcp-name-${i}`} className="text-xs text-fg-muted block mb-0.5">
                Name
              </label>
              <input
                id={`mcp-name-${i}`}
                value={mcp.name}
                onChange={(e) => updateMcp(i, "name", e.target.value)}
                className={inputCls}
                placeholder="github"
              />
            </div>
            <div className="w-24">
              <label className="text-xs text-fg-muted block mb-0.5">Type</label>
              <Select value={mcp.type} onValueChange={(v) => updateMcp(i, "type", v)}>
                <SelectOption value="url">url</SelectOption>
                <SelectOption value="sse">sse</SelectOption>
                <SelectOption value="stdio">stdio</SelectOption>
              </Select>
            </div>
            <button
              onClick={() => removeMcp(i)}
              aria-label={`Remove MCP server ${mcp.name || i + 1}`}
              className="self-end inline-flex items-center justify-center min-w-11 min-h-11 sm:min-w-0 sm:min-h-0 px-2 py-2 text-fg-subtle hover:text-danger transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
            >
              ×
            </button>
          </div>
          <div>
            <label htmlFor={`mcp-url-${i}`} className="text-xs text-fg-muted block mb-0.5">
              URL
            </label>
            <input
              id={`mcp-url-${i}`}
              value={mcp.url}
              onChange={(e) => updateMcp(i, "url", e.target.value)}
              className={inputCls}
              placeholder="https://mcp.github.com/sse"
            />
          </div>
        </div>
      ))}
      {form.mcpServers.length === 0 && (
        <div className="text-center py-8 text-fg-subtle">
          <p className="text-sm">No MCP servers configured.</p>
          <p className="text-xs mt-1">
            MCP servers provide external tools via the Model Context Protocol.
          </p>
        </div>
      )}
    </div>
  );
}

function AgentsTab({
  form,
  setForm,
  allAgents,
  addCallable,
  removeCallable,
}: {
  form: FormState;
  setForm: FormSetter;
  allAgents: Agent[];
  addCallable: (agentId: string) => void;
  removeCallable: (i: number) => void;
}) {
  return (
    <div className="space-y-5">
      {/* Built-in general sub-agent — opt-in. */}
      <div className="rounded-md border border-border bg-bg-surface px-3 py-3">
        <label className="flex items-start gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={form.enableGeneralSubagent}
            onChange={(e) => setForm({ ...form, enableGeneralSubagent: e.target.checked })}
            className="accent-brand mt-0.5"
          />
          <div>
            <div className="font-medium text-fg">Enable general sub-agent</div>
            <p className="text-xs text-fg-subtle mt-0.5">
              Exposes a built-in{" "}
              <span className="font-mono">general_subagent(task)</span> tool. Spawns a
              generic sub-agent thread (reserved id{" "}
              <span className="font-mono">general</span>) inheriting this agent's model +
              sandbox, with a safe built-in tool subset
              (bash/read/write/edit/grep/glob). No roster setup needed.
            </p>
          </div>
        </label>
      </div>

      <div>
        <label className="text-sm font-medium text-fg block">Callable Agents</label>
        <p className="text-xs text-fg-subtle mb-2">
          Specific agents this agent can delegate to via{" "}
          <span className="font-mono">call_agent_&lt;id&gt;</span> tools.
        </p>
      </div>

      {form.callableAgents.map((ca, i) => {
        const agentInfo = allAgents.find((a) => a.id === ca.id);
        return (
          <div
            key={i}
            className="flex items-center gap-2 px-3 py-2 border border-border rounded-lg"
          >
            <div className="flex-1">
              <div className="text-sm font-medium text-fg">{agentInfo?.name || ca.id}</div>
              <div className="text-xs text-fg-subtle font-mono">{ca.id}</div>
            </div>
            <button
              onClick={() => removeCallable(i)}
              className="inline-flex items-center justify-center min-w-11 min-h-11 sm:min-w-0 sm:min-h-0 px-2 text-fg-subtle hover:text-danger transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
            >
              ×
            </button>
          </div>
        );
      })}

      <div>
        <label className="text-xs text-fg-muted block mb-1">Add agent</label>
        <Combobox<Agent>
          value=""
          onValueChange={(v) => {
            if (v) addCallable(v);
          }}
          endpoint="/v1/agents"
          getValue={(a) => a.id}
          getLabel={(a) => (
            <span>
              {a.name} <span className="text-fg-subtle text-[12px]">({a.id})</span>
            </span>
          )}
          getTextLabel={(a) => `${a.name} (${a.id})`}
          placeholder="Select an agent..."
          excludeIds={form.callableAgents.map((c) => c.id)}
        />
      </div>

      {form.callableAgents.length === 0 && allAgents.length === 0 && (
        <p className="text-xs text-fg-subtle">
          Create other agents first to enable multi-agent delegation.
        </p>
      )}
    </div>
  );
}

function normalizeToolkitSlug(slug: string): string {
  return slug.trim().toLowerCase();
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function isComposioMcpUrl(url?: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, "");
    return (
      (parsed.hostname === "app.composio.dev" || parsed.hostname === "backend.composio.dev") &&
      path.includes("/tool_router/") &&
      path.endsWith("/mcp")
    );
  } catch {
    return false;
  }
}

function providerLabel(provider: string): string {
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
