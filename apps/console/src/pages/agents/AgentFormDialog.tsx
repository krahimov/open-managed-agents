import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import yaml from "js-yaml";
import {
  ArrowLeftIcon,
  BoxIcon,
  CalendarClockIcon,
  CheckIcon,
  CpuIcon,
  IdCardIcon,
  LayoutGridIcon,
  NetworkIcon,
  PlugIcon,
  PuzzleIcon,
  WrenchIcon,
} from "lucide-react";

import { VaultIcon } from "@/components/icons";
import { toast } from "sonner";

import { getActiveTenantId, readApiErrorMessage, useApi } from "../../lib/api";
import { useApiQuery } from "../../lib/useApiQuery";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { buildTriggerRuleBody } from "../../components/agents/TriggerFields";
import { Callout } from "../../components/Callout";
import { parseMemoryMode } from "../../components/MemoryModeControl";
import { SegmentedControl } from "../../components/SegmentedControl";
import { Steps } from "../../components/Steps";
import { Tip } from "../../components/Tip";
import { SearchInput } from "../../components/Toolbar";
import { FACE_METADATA_KEY, formatFace, parseFace } from "../../lib/agent-face";
import { type AgentTemplate } from "../../lib/agent-templates";
import {
  COMPOSIO_NOT_CONFIGURED_MESSAGE,
  type ComposioIntegrationEntry,
  type ComposioStatusResponse,
} from "../../lib/composio-integrations";
import type { ModelCard } from "@open-managed-agents/api-types";
import type { AgentRecord as Agent } from "../../types/agent";
import { BasicsSection, ModelSection } from "./form/BasicsSections";
import { AppsSection, DelegationSection, McpSection, SkillsSection, ToolsSection } from "./form/CapabilitySections";
import {
  COMPOSIO_MCP_SERVER,
  INITIAL_FORM,
  uniqueStrings,
  type CallableEntry,
  type ComposioAuthCompletion,
  type ComposioConnectedAccountItem,
  type ComposioConnectedAccountsResponse,
  type ComposioConnectionState,
  type EnvironmentLite,
  type FormState,
  type FormTab,
  type McpEntry,
  type ReasoningLevelValue,
  type RuntimeLite,
  type SandboxConfig,
  type SkillEntry,
  type SkillLite,
  type ToolOverride,
  type VaultCredentialLite,
  type VaultCredentialsResponse,
  type VaultLite,
} from "./form/model";
import { SandboxSection, TriggersSection, VaultsSection, formToTriggerDraft } from "./form/RuntimeSections";
import { TemplateStep } from "./form/TemplateStep";
import { ScrollFade } from "../../components/agents/ScrollFade";

interface AgentFormDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called after the agent is created successfully. Parent uses this
   *  to refresh the list. The dialog handles its own navigation to the
   *  new agent's setup chat. */
  onCreated?: () => void;
  /** Data sets the form's pickers pull from. The parent fetches these
   *  on mount (loadAux) and passes them down so the dialog doesn't have
   *  to re-fetch on every open. */
  allAgents: Agent[];
  customSkills: SkillLite[];
  modelCards: ModelCard[];
  runtimes: RuntimeLite[];
}

type NavItem = {
  id: FormTab;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** A count of what is configured, or `true` for "set". */
  mark?: number | boolean;
};

/**
 * New-agent dialog. Two steps: choose a starting point (a template or a
 * blank agent), then configure. The configure step is a form with a side
 * navigation of sections, grouped by what they decide:
 *
 *   Agent         Basics · Model and engine
 *   Capabilities  Tools · Skills · Apps · MCP servers · Delegation
 *   Runtime       Sandbox · Vaults
 *   Automation    Triggers
 *
 * The same configuration can be edited as YAML or JSON (the editor switch
 * in the header). This component owns all of the state and the create
 * flow (including the Composio OAuth hand-off); the sections under
 * `./form` render and edit it. The shell is the shared Radix dialog, so
 * focus trapping, Escape, scroll lock and focus restore come from there.
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
  const [tab, setTab] = useState<FormTab>("basic");
  const [templateName, setTemplateName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createMode, setCreateMode] = useState<"form" | "yaml" | "json">("form");
  const [codeValue, setCodeValue] = useState("");
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

  const bodyRef = useRef<HTMLDivElement>(null);
  const composioConnectionsRef = useRef<ComposioConnectionState>({});
  const composioAuthWaitersRef = useRef<
    Map<string, Set<(completion: ComposioAuthCompletion) => void>>
  >(new Map());
  const composioAuthFailureWaitersRef = useRef<Map<string, Set<(err: Error) => void>>>(
    new Map(),
  );

  const setComposioConnectionsSynced = useCallback(
    (
      updater:
        | ComposioConnectionState
        | ((prev: ComposioConnectionState) => ComposioConnectionState),
    ) => {
      const next =
        typeof updater === "function"
          ? updater(composioConnectionsRef.current)
          : updater;
      composioConnectionsRef.current = next;
      setComposioConnections(next);
    },
    [],
  );

  const markComposioConnected = useCallback(
    (completion: ComposioAuthCompletion) => {
      const toolkit = completion.toolkit ? normalizeToolkitSlug(completion.toolkit) : "";
      setComposioConnectionsSynced((prev) => {
        const next = { ...prev };
        const targetSlugs =
          toolkit && next[toolkit]
            ? [toolkit]
            : Object.keys(next).filter((slug) => next[slug].status === "pending");
        for (const slug of targetSlugs) {
          const current = next[slug];
          next[slug] = {
            ...current,
            connectedAccountId: completion.connectedAccountId || current.connectedAccountId,
            authConfigId: completion.authConfigId || current.authConfigId,
            status: "connected",
          };
        }
        return next;
      });
    },
    [setComposioConnectionsSynced],
  );

  const notifyComposioAuthComplete = useCallback(
    (completion: ComposioAuthCompletion) => {
      const toolkit = completion.toolkit ? normalizeToolkitSlug(completion.toolkit) : "";
      const notify = (slug: string) => {
        const waiters = composioAuthWaitersRef.current.get(slug);
        if (!waiters) return;
        composioAuthWaitersRef.current.delete(slug);
        for (const waiter of waiters) waiter(completion);
      };
      if (toolkit) notify(toolkit);
      else {
        for (const slug of Array.from(composioAuthWaitersRef.current.keys())) notify(slug);
      }
      markComposioConnected(completion);
    },
    [markComposioConnected],
  );

  const notifyComposioAuthFailed = useCallback((toolkit: string | undefined, error: string) => {
    const slug = toolkit ? normalizeToolkitSlug(toolkit) : "";
    const err = new Error(`Provider OAuth failed: ${error}`);
    const notify = (key: string) => {
      const waiters = composioAuthFailureWaitersRef.current.get(key);
      if (!waiters) return;
      composioAuthFailureWaitersRef.current.delete(key);
      for (const waiter of waiters) waiter(err);
    };
    if (slug) notify(slug);
    else {
      for (const key of Array.from(composioAuthFailureWaitersRef.current.keys())) notify(key);
    }
  }, []);

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
    setComposioConnectionsSynced({});
    composioAuthWaitersRef.current.clear();
    composioAuthFailureWaitersRef.current.clear();
    setConnectingIntegration(null);
    setTemplateName("");
    setCreating(false);
    onClose();
  };

  // Each section starts at its top.
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
  }, [tab, createMode, createStep]);

  useEffect(() => {
    if (!open) return;
    const handleOAuthMessage = (event: MessageEvent | { data: unknown }) => {
      const data = (
        event as {
          data?: {
            type?: string;
            toolkit?: string;
            connected_account_id?: string;
            auth_config_id?: string;
            error?: string;
          };
        }
      ).data;
      if (data?.type !== "composio_auth_complete") return;
      if ("error" in data && typeof data.error === "string" && data.error) {
        const toolkit = data.toolkit ? normalizeToolkitSlug(data.toolkit) : undefined;
        setConnectingIntegration(null);
        notifyComposioAuthFailed(toolkit, data.error);
        toast.error(`Provider OAuth failed: ${data.error}`);
        return;
      }
      const toolkit = data.toolkit ? normalizeToolkitSlug(data.toolkit) : undefined;
      setConnectingIntegration(null);
      notifyComposioAuthComplete({
        toolkit,
        connectedAccountId:
          typeof data.connected_account_id === "string" ? data.connected_account_id : undefined,
        authConfigId:
          typeof data.auth_config_id === "string" ? data.auth_config_id : undefined,
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
  }, [notifyComposioAuthComplete, notifyComposioAuthFailed, open]);

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

  const selectedDefaultVaultIds = () => uniqueStrings(form.defaultVaultIds.map((id) => id.trim()));

  const getVaultForComposio = async (vaultId: string): Promise<VaultLite> => {
    const existing = vaults.find((v) => v.id === vaultId);
    if (existing) return existing;
    const fetched = await api<VaultLite>(`/v1/vaults/${encodeURIComponent(vaultId)}`);
    if (fetched.archived_at) {
      throw new Error(`Selected vault ${vaultId} is archived.`);
    }
    setVaults((prev) => (prev.some((v) => v.id === fetched.id) ? prev : [fetched, ...prev]));
    return fetched;
  };

  const ensureIntegrationVault = async (): Promise<VaultLite> => {
    const selectedVaultId = selectedDefaultVaultIds()[0];
    if (selectedVaultId) return getVaultForComposio(selectedVaultId);
    const preferred = vaults.find((v) => v.name === "Connected Apps") ?? vaults[0];
    if (preferred) return preferred;
    const created = await api<VaultLite>("/v1/vaults", {
      method: "POST",
      body: JSON.stringify({ name: "Connected Apps" }),
    });
    setVaults((prev) => [created, ...prev]);
    return created;
  };

  const findConnectedComposioAccount = async (
    vaultId: string,
    toolkit: string,
    expectedAccountId?: string,
    fallbackAuthConfigId?: string,
  ): Promise<ComposioConnectionState[string] | null> => {
    const slug = normalizeToolkitSlug(toolkit);
    const params = new URLSearchParams({ toolkit: slug, limit: "100" });
    const accounts = await fetchJsonQuiet<ComposioConnectedAccountsResponse>(
      `/v1/vaults/${vaultId}/credentials/composio_accounts?${params.toString()}`,
    );
    const readyAccounts = (accounts.items ?? []).filter(isComposioAccountReady);
    const account =
      (expectedAccountId
        ? readyAccounts.find((item) => item.id === expectedAccountId)
        : undefined) ?? readyAccounts[0];
    if (!account) return null;
    return {
      connectedAccountId: account.id,
      authConfigId: account.auth_config?.id || fallbackAuthConfigId || "",
      status: "connected",
    };
  };

  const waitForComposioConnection = async (opts: {
    vaultId: string;
    toolkit: string;
    connectedAccountId: string;
    authConfigId: string;
    popup?: Window | null;
    timeoutMs?: number;
  }): Promise<ComposioConnectionState[string]> => {
    const slug = normalizeToolkitSlug(opts.toolkit);
    return new Promise((resolve, reject) => {
      let settled = false;
      let pollInFlight = false;
      let pollTimer = 0;
      let closeTimer = 0;
      let timeoutTimer = 0;
      let firstPollTimer = 0;

      const cleanup = () => {
        const waiters = composioAuthWaitersRef.current.get(slug);
        if (waiters) {
          waiters.delete(onComplete);
          if (waiters.size === 0) composioAuthWaitersRef.current.delete(slug);
        }
        const failureWaiters = composioAuthFailureWaitersRef.current.get(slug);
        if (failureWaiters) {
          failureWaiters.delete(onFailure);
          if (failureWaiters.size === 0) composioAuthFailureWaitersRef.current.delete(slug);
        }
        window.clearInterval(pollTimer);
        window.clearInterval(closeTimer);
        window.clearTimeout(timeoutTimer);
        window.clearTimeout(firstPollTimer);
      };

      const finish = (connection: ComposioConnectionState[string]) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(connection);
      };

      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };

      const onComplete = (completion: ComposioAuthCompletion) => {
        finish({
          connectedAccountId: completion.connectedAccountId || opts.connectedAccountId,
          authConfigId: completion.authConfigId || opts.authConfigId,
          status: "connected",
        });
      };
      const onFailure = (err: Error) => fail(err);

      const waiters = composioAuthWaitersRef.current.get(slug) ?? new Set();
      waiters.add(onComplete);
      composioAuthWaitersRef.current.set(slug, waiters);
      const failureWaiters = composioAuthFailureWaitersRef.current.get(slug) ?? new Set();
      failureWaiters.add(onFailure);
      composioAuthFailureWaitersRef.current.set(slug, failureWaiters);

      const pollOnce = async () => {
        if (settled || pollInFlight) return;
        pollInFlight = true;
        try {
          const account = await findConnectedComposioAccount(
            opts.vaultId,
            slug,
            opts.connectedAccountId,
            opts.authConfigId,
          );
          if (account) finish(account);
        } catch {
          // Keep waiting. The popup callback is the primary signal; polling is
          // a backup for browsers that sever opener messaging.
        } finally {
          pollInFlight = false;
        }
      };

      firstPollTimer = window.setTimeout(() => void pollOnce(), 1200);
      pollTimer = window.setInterval(() => void pollOnce(), 2000);
      closeTimer = window.setInterval(() => {
        if (!opts.popup?.closed) return;
        void pollOnce().finally(() => {
          if (!settled) fail(new Error(`Authentication window closed before ${slug} connected.`));
        });
      }, 1000);
      timeoutTimer = window.setTimeout(() => {
        fail(new Error(`Timed out waiting for ${slug} authentication.`));
      }, opts.timeoutMs ?? 5 * 60 * 1000);
    });
  };

  const startComposioToolkitAuth = async (
    toolkitSlug: string,
    opts: {
      wait?: boolean;
      popup?: Window | null;
      keepCallbackOpen?: boolean;
    } = {},
  ): Promise<ComposioConnectionState[string]> => {
    if (!composioConfigured) {
      throw new Error(COMPOSIO_NOT_CONFIGURED_MESSAGE);
    }
    const slug = normalizeToolkitSlug(toolkitSlug);
    const popup =
      opts.popup ?? window.open("", `composio-${slug}`, "width=600,height=720,popup=yes");
    if (!popup) {
      throw new Error("Allow pop-ups for this site to connect the selected app.");
    }
    setConnectingIntegration(slug);
    setForm((f) => ({
      ...f,
      composioToolkits: f.composioToolkits.includes(slug)
        ? f.composioToolkits
        : [...f.composioToolkits, slug],
    }));
    try {
      const vault = await ensureIntegrationVault();
      const callbackParams = new URLSearchParams({ toolkit: slug });
      if (opts.keepCallbackOpen) callbackParams.set("keep_open", "1");
      const callbackUrl = `${window.location.origin}/composio/callback?${callbackParams.toString()}`;
      const link = await api<{
        redirect_url: string;
        connected_account_id: string;
        auth_config_id: string;
      }>(`/v1/vaults/${vault.id}/credentials/composio_accounts/link`, {
        method: "POST",
        body: JSON.stringify({ toolkit: slug, callback_url: callbackUrl }),
      });
      const pendingConnection = {
        connectedAccountId: link.connected_account_id,
        authConfigId: link.auth_config_id,
        status: "pending" as const,
        redirectUrl: link.redirect_url,
      };
      setComposioConnectionsSynced((prev) => ({
        ...prev,
        [slug]: pendingConnection,
      }));
      popup.location.href = link.redirect_url;
      if (!opts.wait) {
        return pendingConnection;
      }
      const connected = await waitForComposioConnection({
        vaultId: vault.id,
        toolkit: slug,
        connectedAccountId: link.connected_account_id,
        authConfigId: link.auth_config_id,
        popup,
      });
      setComposioConnectionsSynced((prev) => ({
        ...prev,
        [slug]: connected,
      }));
      return connected;
    } catch (err) {
      if (!opts.popup && !popup.closed) popup.close();
      throw err;
    } finally {
      setConnectingIntegration(null);
    }
  };

  const connectComposioToolkit = async (entry: ComposioIntegrationEntry) => {
    try {
      await startComposioToolkitAuth(entry.slug);
    } catch (err) {
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

  const vaultHasComposioCredential = async (
    vaultId: string,
    selectedToolkits: string[],
  ): Promise<boolean> => {
    const creds = await fetchJsonQuiet<VaultCredentialsResponse>(
      `/v1/vaults/${encodeURIComponent(vaultId)}/credentials`,
    );
    return (creds.data ?? []).some((cred) =>
      composioCredentialCoversToolkits(cred, selectedToolkits),
    );
  };

  const ensureComposioCredentialForAgent = async (): Promise<string[]> => {
    if (form.composioToolkits.length === 0) return form.defaultVaultIds;
    if (!composioConfigured) {
      throw new Error(COMPOSIO_NOT_CONFIGURED_MESSAGE);
    }
    const selectedToolkits = uniqueStrings(form.composioToolkits.map(normalizeToolkitSlug));
    const selectedVaultIds = selectedDefaultVaultIds();
    for (const vaultId of selectedVaultIds) {
      if (await vaultHasComposioCredential(vaultId, selectedToolkits)) {
        return selectedVaultIds;
      }
    }

    const initiallyMissing = selectedToolkits.filter(
      (slug) => composioConnectionsRef.current[slug]?.status !== "connected",
    );
    const authPopup =
      initiallyMissing.length > 0
        ? window.open("", "composio-agent-auth", "width=600,height=720,popup=yes")
        : null;
    if (authPopup) {
      try {
        authPopup.document.title = "Connect app";
        authPopup.document.body.innerHTML =
          '<div style="font-family:system-ui,sans-serif;padding:24px;color:#111">Preparing authentication...</div>';
      } catch {
        // Some browser policies restrict writing to popup documents.
      }
    }
    const vault = await ensureIntegrationVault();
    if (
      !selectedVaultIds.includes(vault.id) &&
      (await vaultHasComposioCredential(vault.id, selectedToolkits))
    ) {
      return uniqueStrings([...form.defaultVaultIds, vault.id]);
    }
    for (const slug of initiallyMissing) {
      const existing = await findConnectedComposioAccount(vault.id, slug);
      if (!existing) continue;
      setComposioConnectionsSynced((prev) => ({
        ...prev,
        [slug]: existing,
      }));
    }

    const missing = selectedToolkits.filter(
      (slug) => composioConnectionsRef.current[slug]?.status !== "connected",
    );
    if (missing.length > 0) {
      setTab("integrations");
      if (!authPopup) {
        throw new Error("Allow pop-ups for this site to connect the selected apps.");
      }
      toast.info(`Connect ${missing.join(", ")} to finish creating this agent.`);
      try {
        for (const slug of missing) {
          await startComposioToolkitAuth(slug, {
            wait: true,
            popup: authPopup,
            keepCallbackOpen: missing.length > 1,
          });
        }
      } finally {
        if (!authPopup.closed) authPopup.close();
      }
    } else if (authPopup && !authPopup.closed) {
      authPopup.close();
    }

    const linkedEntries = selectedToolkits
      .map((slug) => [slug, composioConnectionsRef.current[slug]] as const)
      .filter((entry): entry is readonly [string, ComposioConnectionState[string]] => {
        return entry[1]?.status === "connected";
      });
    if (linkedEntries.length !== selectedToolkits.length) {
      const missingAfterAuth = selectedToolkits.filter(
        (slug) => composioConnectionsRef.current[slug]?.status !== "connected",
      );
      throw new Error(`Connect selected apps first: ${missingAfterAuth.join(", ")}`);
    }
    const connectedAccounts = Object.fromEntries(
      linkedEntries.map(([slug, link]) => [slug, link.connectedAccountId]),
    );
    const authConfigs = Object.fromEntries(
      linkedEntries
        .filter(([, link]) => Boolean(link.authConfigId))
        .map(([slug, link]) => [slug, link.authConfigId]),
    );
    const credentialBody: Record<string, unknown> = {
      display_name: `Composio Tool Router (${form.name || "Agent"})`,
      toolkits: { enable: selectedToolkits },
      connected_accounts: connectedAccounts,
    };
    if (Object.keys(authConfigs).length > 0) credentialBody.auth_configs = authConfigs;
    await api(`/v1/vaults/${vault.id}/credentials/composio_tool_router_session`, {
      method: "POST",
      body: JSON.stringify(credentialBody),
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
    if (creating) return;
    setCreateError("");
    setCreating(true);
    try {
      const ambientRuleBody = form.ambientEnabled ? buildAmbientRuleBody(form) : null;
      const defaultVaultIds = await ensureComposioCredentialForAgent();
      const mcpServers = mergedMcpServersForCreate();
      // Subscription harnesses need no model card; an empty model falls back
      // to "default", which matches neither harness's pass-through pattern so
      // both use the subscription's own default model.
      const subscriptionHarness = !form.runtimeId && form.harness !== "default";
      const payload: Record<string, unknown> = {
        name: form.name,
        model: subscriptionHarness ? form.model.trim() || "default" : form.model,
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
      if (form.longRunning) metadata.long_running = true;
      if (form.avatar) metadata[FACE_METADATA_KEY] = form.avatar;
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
      // Subscription harness (claude-agent-sdk / codex-sdk) — mutually
      // exclusive with the runtime-binding acp-proxy path above.
      if (subscriptionHarness) {
        payload._oma = {
          ...((payload._oma as Record<string, unknown>) ?? {}),
          harness: form.harness,
        };
      }
      // reasoning_level: only meaningful for cloud agents (local-runtime
      // agents bring their own model), and "instant" is the server default
      // so it's omitted rather than stored.
      if (form.reasoningLevel !== "instant" && !form.runtimeId) {
        payload._oma = {
          ...((payload._oma as Record<string, unknown>) ?? {}),
          reasoning_level: form.reasoningLevel,
        };
      }
      // memory: "off" is the server default (absent field) — only persist
      // shared / per_user. Same cloud-only gating as reasoning_level.
      if (form.memoryMode !== "off" && !form.runtimeId) {
        payload._oma = {
          ...((payload._oma as Record<string, unknown>) ?? {}),
          memory: { mode: form.memoryMode },
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
      // Keep the dialog (and its busy button) up until the setup chat is
      // ready, then leave: closing first showed the list for a beat.
      onCreated?.();
      await goToSetup(agent);
      closeCreate();
    } catch (e: any) {
      setCreateError(e?.message || "Failed to create agent");
    } finally {
      setCreating(false);
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
        // The agent keeps the face its template card wore.
        avatar: tmpl.face ?? "",
        mcpServers: tmpl.mcpServers.map((m) => ({ ...m })),
        skills: tmpl.skills.map((s) => ({ ...s } as SkillEntry)),
      });
    }
    setTemplateName(tmpl.id === "blank" ? "" : tmpl.name);
    setCreateStep("form");
    setTab("basic");
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
    if (form.longRunning) metadata.long_running = true;
    if (form.avatar) metadata[FACE_METADATA_KEY] = form.avatar;
    if (Object.keys(metadata).length > 0) config.metadata = metadata;
    if (form.enableGeneralSubagent) {
      config.enable_general_subagent = true;
    }
    if (form.reasoningLevel !== "instant" && !form.runtimeId) {
      config._oma = { reasoning_level: form.reasoningLevel };
    }
    if (form.memoryMode !== "off" && !form.runtimeId) {
      config._oma = {
        ...((config._oma as Record<string, unknown>) ?? {}),
        memory: { mode: form.memoryMode },
      };
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
          avatar: formatFace(parseFace(metadata[FACE_METADATA_KEY])),
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
          longRunning: (parsed.metadata as { long_running?: unknown } | undefined)?.long_running === true,
          reasoningLevel: ((): ReasoningLevelValue => {
            const rl = (parsed._oma as { reasoning_level?: unknown } | undefined)
              ?.reasoning_level;
            return rl === "low" || rl === "medium" || rl === "high" || rl === "max"
              ? rl
              : "instant";
          })(),
          memoryMode: parseMemoryMode(
            (parsed._oma as { memory?: unknown } | undefined)?.memory,
          ),
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
    if (creating) return;
    setCreateError("");
    setCreating(true);
    try {
      const parsed =
        createMode === "yaml"
          ? (yaml.load(codeValue) as Record<string, unknown>)
          : JSON.parse(codeValue);
      if (!parsed.name) {
        setCreateError("The config needs a name.");
        return;
      }
      if (!parsed.tools) parsed.tools = [{ type: "agent_toolset_20260401" }];
      const agent = await api<Agent>("/v1/agents", {
        method: "POST",
        body: JSON.stringify(parsed),
      });
      onCreated?.();
      await goToSetup(agent);
      closeCreate();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Invalid config";
      setCreateError(msg);
    } finally {
      setCreating(false);
    }
  };

  // Resolve which card the Model picker should highlight: explicit pick
  // wins, otherwise derive from model_id (paste path / pre-select effect).
  // Empty string when nothing matches (e.g. paste mode with an unknown model).
  const selectedCardId =
    form.modelCardId || modelCards.find((mc) => mc.model_id === form.model)?.id || "";

  const engineSet = !!form.runtimeId || form.harness !== "default" || !!selectedCardId;
  const delegation =
    form.callableAgents.length + (form.longRunning ? 1 : 0) + (form.enableGeneralSubagent ? 1 : 0);
  const navGroups: Array<{ label: string; items: NavItem[] }> = [
    {
      label: "Agent",
      items: [
        { id: "basic", label: "Basics", icon: IdCardIcon, mark: !!form.name.trim() },
        { id: "model", label: "Model and engine", icon: CpuIcon, mark: engineSet },
      ],
    },
    {
      label: "Capabilities",
      items: [
        { id: "tools", label: "Tools", icon: WrenchIcon, mark: Object.keys(form.toolOverrides).length },
        { id: "skills", label: "Skills", icon: PuzzleIcon, mark: form.skills.length },
        { id: "integrations", label: "Apps", icon: LayoutGridIcon, mark: form.composioToolkits.length },
        { id: "mcp", label: "MCP servers", icon: PlugIcon, mark: form.mcpServers.length },
        { id: "agents", label: "Delegation", icon: NetworkIcon, mark: delegation },
      ],
    },
    {
      label: "Runtime",
      items: [
        { id: "sandbox", label: "Sandbox", icon: BoxIcon, mark: !!form.environmentId },
        { id: "vaults", label: "Vaults", icon: VaultIcon, mark: form.defaultVaultIds.length },
      ],
    },
    {
      label: "Automation",
      items: [{ id: "ambient", label: "Triggers", icon: CalendarClockIcon, mark: form.ambientEnabled ? 1 : 0 }],
    },
  ];
  const navOrder = navGroups.flatMap((g) => g.items.map((i) => i.id));

  const onNavKeyDown = (e: React.KeyboardEvent) => {
    const i = navOrder.indexOf(tab);
    let next = i;
    if (e.key === "ArrowDown") next = Math.min(navOrder.length - 1, i + 1);
    else if (e.key === "ArrowUp") next = Math.max(0, i - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = navOrder.length - 1;
    else return;
    e.preventDefault();
    setTab(navOrder[next]);
    document.getElementById(`agent-form-tab-${navOrder[next]}`)?.focus();
  };

  const canCreate = createMode === "form" ? !!form.name.trim() : !!codeValue.trim();
  const footerHint =
    createMode !== "form"
      ? "The config is sent as written. Tools default to the built-in toolset when left out."
      : !form.name.trim()
        ? "Give the agent a name to create it."
        : "Next, the agent opens a setup chat and asks what you want it to do.";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !creating) closeCreate();
      }}
    >
      <DialogContent
        // A click on the scrim should not throw away a half-built agent.
        onInteractOutside={(e) => {
          if (createStep === "form") e.preventDefault();
        }}
        className={cn(
          "flex w-full flex-col gap-0 overflow-hidden p-0",
          // Tall enough for every template on a tall screen; on a short one the grid scrolls under a fade.
          createStep === "template" ? "h-[min(88vh,940px)] sm:max-w-4xl" : "h-[min(90vh,840px)] sm:max-w-5xl",
        )}
      >
        {/* Step 1: choose a starting point */}
        {createStep === "template" && (
          <>
            <header className="shrink-0 px-6 pt-5 pb-4">
              {/* The stepper shares a line with the title only; the subtitle has the full width,
                  so it is never squeezed into leaving one word on a line of its own. */}
              <div className="flex items-center justify-between gap-6 pr-10">
                <DialogTitle>New agent</DialogTitle>
                <Steps steps={["Choose a start", "Configure"]} current={0} className="hidden shrink-0 md:flex" />
              </div>
              <DialogDescription className="mt-1 text-pretty">
                Start from a template or a blank agent. Everything can be changed in the next step.
              </DialogDescription>
              <SearchInput
                value={templateSearch}
                onChange={setTemplateSearch}
                placeholder="Search templates"
                width="w-full max-w-sm"
                className="mt-4"
                autoFocus
              />
            </header>
            {/* More templates than fit fade out at the edge instead of being cut by it. */}
            <ScrollFade fade={40} className="min-h-0 flex-1 px-6 pt-1 pb-6">
              <TemplateStep search={templateSearch} onPick={selectTemplate} onClearSearch={() => setTemplateSearch("")} />
            </ScrollFade>
          </>
        )}

        {/* Step 2: configure */}
        {createStep === "form" && (
          <>
            <header className="flex shrink-0 items-center gap-3 border-b border-border py-3.5 pr-14 pl-4">
              <Tip label="Back to templates">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Back to templates"
                  disabled={creating}
                  onClick={() => {
                    setCreateStep("template");
                    setTemplateSearch("");
                    setCreateMode("form");
                    setCreateError("");
                  }}
                >
                  <ArrowLeftIcon />
                </Button>
              </Tip>
              <div className="min-w-0 flex-1">
                <DialogTitle className="truncate">New agent</DialogTitle>
                <DialogDescription className="truncate text-xs">
                  {templateName ? `Started from the ${templateName} template` : "Started from a blank agent"}
                </DialogDescription>
              </div>
              <SegmentedControl<"form" | "yaml" | "json">
                label="Editor"
                size="sm"
                value={createMode}
                onChange={switchMode}
                options={[
                  { value: "form", label: "Form" },
                  { value: "yaml", label: "YAML" },
                  { value: "json", label: "JSON" },
                ]}
              />
            </header>

            <div className="flex min-h-0 flex-1">
              {createMode === "form" && (
                <nav
                  role="tablist"
                  aria-orientation="vertical"
                  aria-label="Agent configuration sections"
                  onKeyDown={onNavKeyDown}
                  className="w-[13.5rem] shrink-0 space-y-4 overflow-y-auto border-r border-border bg-bg-inset/60 p-3"
                >
                  {navGroups.map((group) => (
                    <div key={group.label}>
                      <div className="px-2.5 pb-1 text-xs font-medium text-fg-subtle">{group.label}</div>
                      <div className="space-y-0.5">
                        {group.items.map((item) => {
                          const active = tab === item.id;
                          return (
                            <button
                              key={item.id}
                              id={`agent-form-tab-${item.id}`}
                              type="button"
                              role="tab"
                              aria-selected={active}
                              aria-controls="agent-form-panel"
                              tabIndex={active ? 0 : -1}
                              onClick={() => setTab(item.id)}
                              className={cn(
                                "flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-small-size font-medium transition-quick",
                                active
                                  ? "bg-bg-surface text-fg shadow-[var(--shadow-xs)] dark:bg-bg-pressed"
                                  : "text-fg-muted hover:bg-bg-hover hover:text-fg",
                              )}
                            >
                              <item.icon className="size-4 shrink-0" />
                              <span className="min-w-0 flex-1 truncate">{item.label}</span>
                              {typeof item.mark === "number" && item.mark > 0 && (
                                <span
                                  className={cn(
                                    "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 text-micro-size font-medium",
                                    active ? "bg-bg-pressed text-fg" : "bg-bg-soft text-fg-subtle",
                                  )}
                                >
                                  {item.mark}
                                  <span className="sr-only"> configured</span>
                                </span>
                              )}
                              {item.mark === true && (
                                <>
                                  <CheckIcon className="size-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
                                  <span className="sr-only">set</span>
                                </>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </nav>
              )}

              <div ref={bodyRef} className="min-w-0 flex-1 overflow-y-auto">
                {createMode !== "form" ? (
                  <div className="flex h-full min-h-[320px] flex-col px-8 py-6">
                    {createError && (
                      <Callout tone="danger" title="The agent was not created" className="mb-4">
                        {createError}
                      </Callout>
                    )}
                    <p className="mb-3 max-w-[72ch] text-small text-fg-muted">
                      The whole agent as {createMode === "yaml" ? "YAML" : "JSON"}. Creating from here sends it as
                      written. Switching back to the form keeps only the fields the form can show.
                    </p>
                    <Textarea
                      value={codeValue}
                      onChange={(e) => setCodeValue(e.target.value)}
                      aria-label={`Agent config as ${createMode === "yaml" ? "YAML" : "JSON"}`}
                      className="min-h-0 flex-1 resize-none [field-sizing:fixed] font-mono text-xs leading-relaxed md:text-xs"
                      spellCheck={false}
                    />
                  </div>
                ) : (
                  <div
                    id="agent-form-panel"
                    role="tabpanel"
                    aria-labelledby={`agent-form-tab-${tab}`}
                    className="mx-auto w-full max-w-[720px] px-8 pt-6 pb-10"
                  >
                    {createError && (
                      <Callout tone="danger" title="The agent was not created" className="mb-5">
                        {createError}
                      </Callout>
                    )}
                    {tab === "basic" && <BasicsSection form={form} setForm={setForm} />}
                    {tab === "model" && (
                      <ModelSection
                        form={form}
                        setForm={setForm}
                        modelCards={modelCards}
                        runtimes={runtimes}
                        selectedCardId={selectedCardId}
                      />
                    )}
                    {tab === "tools" && <ToolsSection form={form} setForm={setForm} />}
                    {tab === "skills" && (
                      <SkillsSection
                        form={form}
                        setForm={setForm}
                        customSkills={customSkills}
                        toggleAnthropicSkill={toggleAnthropicSkill}
                      />
                    )}
                    {tab === "integrations" && (
                      <AppsSection
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
                    {tab === "mcp" && (
                      <McpSection
                        form={form}
                        addMcp={addMcp}
                        addMcpFromRegistry={addMcpFromRegistry}
                        updateMcp={updateMcp}
                        removeMcp={removeMcp}
                      />
                    )}
                    {tab === "agents" && (
                      <DelegationSection
                        form={form}
                        setForm={setForm}
                        allAgents={allAgents}
                        addCallable={addCallable}
                        removeCallable={removeCallable}
                      />
                    )}
                    {tab === "sandbox" && (
                      <SandboxSection
                        form={form}
                        setForm={setForm}
                        environments={environments}
                        sandboxConfig={sandboxConfig}
                      />
                    )}
                    {tab === "vaults" && <VaultsSection form={form} setForm={setForm} vaults={vaults} />}
                    {tab === "ambient" && <TriggersSection form={form} setForm={setForm} />}
                  </div>
                )}
              </div>
            </div>

            <footer className="flex shrink-0 items-center justify-between gap-4 border-t border-border bg-bg-inset/60 px-6 py-3.5">
              <p className="min-w-0 truncate text-xs text-fg-subtle" title={footerHint}>
                {footerHint}
              </p>
              <div className="flex shrink-0 items-center gap-2">
                <Button variant="ghost" onClick={closeCreate} disabled={creating}>
                  Cancel
                </Button>
                <Button
                  onClick={createMode === "form" ? create : createFromCode}
                  disabled={!canCreate}
                  loading={creating}
                >
                  Create agent
                </Button>
              </div>
            </footer>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function buildAmbientRuleBody(form: FormState): Record<string, unknown> {
  return buildTriggerRuleBody(formToTriggerDraft(form), `${form.name.trim()} heartbeat`);
}

function normalizeToolkitSlug(slug: string): string {
  return slug.trim().toLowerCase();
}

function composioCredentialCoversToolkits(
  cred: VaultCredentialLite,
  selectedToolkits: string[],
): boolean {
  if (cred.archived_at || cred.auth?.type !== "composio_mcp") return false;
  const credentialToolkits = Array.isArray(cred.auth.composio_toolkits)
    ? uniqueStrings(cred.auth.composio_toolkits.map(normalizeToolkitSlug))
    : [];
  if (credentialToolkits.length === 0) return true;
  return selectedToolkits.every((slug) => credentialToolkits.includes(slug));
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

async function fetchJsonQuiet<T>(path: string): Promise<T> {
  const activeTenant = getActiveTenantId();
  const res = await fetch(path, {
    credentials: "include",
    headers: activeTenant ? { "x-active-tenant": activeTenant } : undefined,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(readApiErrorMessage(body, res.status));
  }
  return res.json() as Promise<T>;
}

function isComposioAccountReady(account: ComposioConnectedAccountItem): boolean {
  const status = account.status?.trim().toUpperCase();
  if (!status) return true;
  if (["ACTIVE", "CONNECTED", "SUCCESS", "COMPLETED", "ENABLED", "READY"].includes(status)) {
    return true;
  }
  if (
    status.includes("PENDING") ||
    status.includes("INITIATED") ||
    status.includes("PROCESSING") ||
    status.includes("IN_PROGRESS")
  ) {
    return false;
  }
  return !["FAILED", "ERROR", "DISABLED", "EXPIRED"].includes(status);
}
