import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ExternalLinkIcon, KeyRoundIcon, LayoutGridIcon, LogInIcon, SquareTerminalIcon } from "lucide-react";

import { useApi } from "@/lib/api";
import { openOAuthPopup, subscribeOAuthMessages } from "@/lib/oauth-popup";
import { useServerFeature } from "@/lib/server-features";
import {
  composioEntriesFromCatalog,
  type ComposioIntegrationEntry,
  type ComposioStatusResponse,
  type ComposioToolkitCatalogResponse,
} from "@/lib/composio-integrations";
import { MCP_REGISTRY, type McpRegistryEntry } from "@/lib/mcp-registry";
import { useApiQuery } from "@/lib/useApiQuery";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";

import { StatusBadge } from "../Badge";
import { BrandLoader } from "../BrandLoader";
import { Callout } from "../Callout";
import { Disclosure } from "../Disclosure";
import { Field } from "../Field";
import { CopyButton } from "../IdChip";
import { SecretInput } from "../Input";
import { LocalCombobox } from "../LocalCombobox";
import { Modal } from "../Modal";
import { OAuthAppSetupPanel, type OAuthAppRequirement } from "../OAuthAppSetupPanel";
import { Select, SelectOption } from "../Select";
import { Skeleton } from "../Skeleton";
import { CAP_CLIS, type Vault } from "./credentials";
import { ChoiceCards, errorMessage } from "./ResourceBits";
import { cn } from "@/lib/utils";
import { standaloneLink } from "@/lib/links";
import { failureSentence } from "@/lib/failure-text";

/** What the person is adding. Decides which fields the dialog asks for. */
export type CredentialKindChoice = "oauth" | "bearer" | "cli" | "composio";

type ComposioConnectionState = Record<
  string,
  {
    connectedAccountId: string;
    authConfigId: string;
    status: "pending" | "connected";
    redirectUrl?: string;
  }
>;

type AuthMethod = "client_secret_basic" | "client_secret_post" | "none";

interface DeviceFlow {
  cli_id: string;
  session_id: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  interval_seconds: number;
  expires_at_ms: number;
  status: "polling" | "ready" | "expired" | "denied" | "error";
  error?: string;
}

const COMPOSIO_UNAVAILABLE = "Configure COMPOSIO_API_KEY on the API server, or add a key for this vault below.";
const MONO = "font-mono text-small-size md:text-small-size";

const normalizeSlug = (slug: string) => slug.trim().toLowerCase();
const parseToolkits = (raw: string) =>
  Array.from(new Set(raw.split(/[,\s]+/).map(normalizeSlug).filter(Boolean)));
const formatToolkits = (toolkits: string[]) => toolkits.join(", ");

/** A neutral letter mark for a service. No remote favicons: the console loads no network images. */
function InitialTile({ name, size = "md" }: { name: string; size?: "sm" | "md" }) {
  return (
    <span
      aria-hidden="true"
      className={
        size === "sm"
          ? "flex size-4 shrink-0 items-center justify-center rounded-[5px] bg-bg-soft text-[0.5625rem] font-semibold text-fg-muted"
          : "flex size-7 shrink-0 items-center justify-center rounded-[9px] bg-bg-soft text-xs font-semibold text-fg-muted"
      }
    >
      {(name.trim()[0] ?? "?").toUpperCase()}
    </span>
  );
}

function OptionalTag({ required }: { required?: boolean }) {
  return <span className="ml-1.5 font-normal text-fg-subtle">{required ? "(required)" : "(optional)"}</span>;
}

/**
 * Add a credential to a vault.
 *
 * One question first — what kind of credential — then only the fields
 * that kind needs:
 *
 *   OAuth sign-in   pick an MCP server, authorise in a popup
 *   Token           pick an MCP server, paste a bearer token (optionally
 *                   with a refresh token so it renews on its own)
 *   CLI tool        pick a CLI, sign in with its device flow or paste a token
 *   Composio apps   one Composio session carrying the apps you connect
 *
 * Every flow, request and popup protocol is the original one; only the
 * arrangement changed. Secrets typed here are sent once and never shown
 * again.
 *
 * MCP sign-in goes through `openOAuthPopup` (one-time start token, so the
 * server starts the flow without a confirm page) and listens with
 * `subscribeOAuthMessages` (each popup result once, over postMessage or
 * BroadcastChannel). A provider that needs a one-time OAuth app first
 * turns the dialog into that setup (OAuthAppSetupPanel). The CLI sign-in
 * (device flow) is offered only when the server has it (`cap_cli`).
 */
export function AddCredentialDialog({
  vault,
  initialKind,
  initialToolkits,
  hasComposioCredential,
  onClose,
  onCreated,
  onCredentialsChanged,
}: {
  vault: Vault;
  initialKind?: CredentialKindChoice;
  initialToolkits?: string[];
  hasComposioCredential: boolean;
  onClose: () => void;
  onCreated: () => void;
  /** The vault's credential list changed without this dialog finishing (a
   *  tool router re-provisioned in the background): reload, do not close. */
  onCredentialsChanged?: () => void;
}) {
  const { api } = useApi();
  const deviceFlowAvailable = useServerFeature("cap_cli");
  const { data: composioStatus, isLoading: composioStatusLoading } =
    useApiQuery<ComposioStatusResponse>("/v1/composio/status");
  const composioConfigured = composioStatus?.configured === true;

  const [kind, setKind] = useState<CredentialKindChoice>(initialKind ?? "oauth");
  const [connecting, setConnecting] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // MCP server form (OAuth sign-in and pasted token share it).
  const [form, setForm] = useState({
    name: "",
    url: "",
    pickedName: "",
    token: "",
    refreshToken: "",
    tokenEndpoint: "",
    authMethod: "client_secret_post" as AuthMethod,
    clientId: "",
    clientSecret: "",
    composioToolkits: formatToolkits(initialToolkits ?? []),
    composioApiKey: "",
  });
  const [refreshOpen, setRefreshOpen] = useState(false);
  const [clientCredsOpen, setClientCredsOpen] = useState(false);
  /** The server being signed in to, kept for a retry after the one-time app setup. */
  const [lastMcp, setLastMcp] = useState<{ name: string; url: string } | null>(null);
  /** The provider needs a one-time OAuth app (the popup said so). */
  const [appReq, setAppReq] = useState<OAuthAppRequirement | null>(null);
  const [savingApp, setSavingApp] = useState(false);

  const composioToolkits = useMemo(() => parseToolkits(form.composioToolkits), [form.composioToolkits]);
  const composioApiKey = composioConfigured ? "" : form.composioApiKey.trim();
  const composioAvailable = composioConfigured || !!composioApiKey || hasComposioCredential;
  const composioCatalogEnabled = composioConfigured || hasComposioCredential;
  const showComposioApiKey = !composioStatusLoading && !composioConfigured;
  const { data: composioCatalogRes, isLoading: composioCatalogLoading } =
    useApiQuery<ComposioToolkitCatalogResponse>(
      `/v1/vaults/${vault.id}/credentials/composio_toolkits`,
      { limit: "500" },
      { enabled: composioCatalogEnabled && kind === "composio" },
    );
  const composioCatalogEntries = useMemo(() => composioEntriesFromCatalog(composioCatalogRes), [composioCatalogRes]);
  const [composioConnections, setComposioConnections] = useState<ComposioConnectionState>({});

  // CLI form (cap_cli credentials).
  const [cliForm, setCliForm] = useState({ cli_id: "gh", display_name: "", token: "" });
  const cli = CAP_CLIS.find((c) => c.cli_id === cliForm.cli_id);

  // OAuth Device Authorization Grant for a CLI: set when the person asks
  // to sign in; polled until ready or a terminal failure.
  const [deviceFlow, setDeviceFlow] = useState<DeviceFlow | null>(null);
  const polling = deviceFlow?.status === "polling";

  const writeToolkits = useCallback((toolkits: string[]) => {
    setForm((prev) => ({ ...prev, composioToolkits: formatToolkits(toolkits) }));
  }, []);
  const toggleToolkit = useCallback(
    (slug: string) => {
      const normalized = normalizeSlug(slug);
      writeToolkits(
        composioToolkits.includes(normalized)
          ? composioToolkits.filter((s) => s !== normalized)
          : [...composioToolkits, normalized],
      );
    },
    [composioToolkits, writeToolkits],
  );
  const addToolkit = useCallback(
    (slug: string) => {
      const normalized = normalizeSlug(slug);
      if (!normalized || composioToolkits.includes(normalized)) return;
      writeToolkits([...composioToolkits, normalized]);
    },
    [composioToolkits, writeToolkits],
  );

  // OAuth popup completion arrives over two transports. COOP severs
  // window.opener for providers that set Cross-Origin-Opener-Policy:
  // same-origin on their authorize page (Sentry), so postMessage from the
  // popup cannot reach us there. BroadcastChannel is same-origin and
  // survives COOP; the popup posts to both, and subscribeOAuthMessages
  // delivers each result once (it used to toast twice).
  const handleOAuthMessage = useCallback(
    (event: MessageEvent) => {
      if (event.origin && event.origin !== window.location.origin) return;
      const data = (
        event as {
          data?: {
            type?: string;
            toolkit?: string;
            connected_account_id?: string;
            service?: string;
            probe_ok?: boolean;
            probe_message?: string | null;
            message?: string;
            code?: string;
            provider?: OAuthAppRequirement;
          };
        }
      ).data;
      if (data?.type === "oauth_error") {
        setConnecting(null);
        if (data.code === "oauth_app_required" && data.provider) {
          // Not a failure to retry: the provider needs its one-time app.
          setAppReq(data.provider);
          setError(null);
          return;
        }
        setError(data.message ?? "The provider did not complete the sign-in. Try again.");
      } else if (data?.type === "oauth_complete") {
        setConnecting(null);
        onCreated();
        // Report the MCP probe so the person knows whether the stored
        // credential will actually work.
        const svc = data.service ?? "MCP server";
        if (data.probe_ok === true) {
          toast.success(`Connected to ${svc}. The token was verified.`);
        } else if (data.probe_ok === false) {
          toast.warning(
            data.probe_message
              ? `Connected to ${svc}, but: ${data.probe_message}`
              : `Connected to ${svc}, but the server rejected the token.`,
          );
        }
      } else if (data?.type === "composio_auth_complete") {
        const toolkit = data.toolkit ? normalizeSlug(data.toolkit) : "";
        setConnecting(null);
        setComposioConnections((prev) => {
          const next = { ...prev };
          if (toolkit && next[toolkit]) {
            next[toolkit] = { ...next[toolkit], status: "connected" };
          } else {
            for (const slug of Object.keys(next)) {
              if (next[slug].status === "pending") next[slug] = { ...next[slug], status: "connected" };
            }
          }
          return next;
        });
        toast.success("Account connected through Composio.");
        // The account just turned ACTIVE: re-provision this vault's existing
        // tool routers so they bind it (a router does not see an unbound
        // account). Best effort, since sessions also repair on start. Only
        // the credential list reloads: the dialog stays open, and its own
        // submit still creates the router for the apps being connected.
        if (hasComposioCredential) {
          void api<{ refreshed?: number }>(
            `/v1/vaults/${vault.id}/credentials/composio_tool_router_session/refresh`,
            { method: "POST", body: JSON.stringify({}), silentErrors: true },
          )
            .then((res) => {
              if ((res?.refreshed ?? 0) > 0) onCredentialsChanged?.();
            })
            .catch(() => {});
        }
      }
    },
    [api, hasComposioCredential, onCreated, onCredentialsChanged, vault.id],
  );

  useEffect(() => subscribeOAuthMessages(handleOAuthMessage), [handleOAuthMessage]);

  const connectMcp = (
    entry: McpRegistryEntry | { name: string; url: string },
    opts?: { clientId?: string; clientSecret?: string },
  ) => {
    setError(null);
    setLastMcp({ name: entry.name, url: entry.url });
    const params = new URLSearchParams({
      mcp_server_url: entry.url,
      vault_id: vault.id,
      redirect_uri: window.location.href,
    });
    if (opts?.clientId) params.set("client_id", opts.clientId);
    if (opts?.clientSecret) params.set("client_secret", opts.clientSecret);
    if (!openOAuthPopup(params, "oauth")) {
      setConnecting(null);
      setError("Your browser blocked the sign-in window. Allow pop-ups for this site and try again.");
      return;
    }
    setConnecting(entry.name);
  };

  // Store the provider's one-time app for this workspace, then go straight
  // on to the sign-in it was needed for.
  const saveOAuthApp = async (clientId: string, clientSecret: string) => {
    if (!appReq) return;
    setSavingApp(true);
    setError(null);
    // Keep the click's permission to open a window across the save.
    const held = lastMcp ? window.open("", "oauth", "width=600,height=700,popup=yes") : null;
    try {
      await api("/v1/oauth/apps", {
        method: "PUT",
        body: JSON.stringify({ issuer: appReq.issuer, client_id: clientId, client_secret: clientSecret }),
        silentErrors: true,
      });
    } catch (e) {
      held?.close();
      setError(errorMessage(e, `The ${appReq.label} app could not be saved`));
      setSavingApp(false);
      return;
    }
    toast.success(`${appReq.label} app saved. Continuing to ${appReq.label}…`);
    setSavingApp(false);
    setAppReq(null);
    if (lastMcp) connectMcp(lastMcp);
  };

  const createBearerCred = async () => {
    setSubmitting(true);
    setError(null);
    try {
      // access_token + refresh_token + token_endpoint → mcp_oauth (the
      // server refreshes on 401); access_token alone → static_bearer.
      const hasRefresh = form.refreshToken && form.tokenEndpoint;
      const auth: Record<string, unknown> = hasRefresh
        ? {
            type: "mcp_oauth",
            access_token: form.token,
            refresh_token: form.refreshToken,
            token_endpoint: form.tokenEndpoint,
            token_endpoint_auth_method: form.authMethod,
            mcp_server_url: form.url,
          }
        : { type: "static_bearer", token: form.token, mcp_server_url: form.url };
      await api(`/v1/vaults/${vault.id}/credentials`, {
        method: "POST",
        body: JSON.stringify({ display_name: form.name || form.pickedName || "Custom MCP", auth }),
        silentErrors: true,
      });
      onCreated();
    } catch (e) {
      setError(errorMessage(e, "The credential could not be saved"));
    } finally {
      setSubmitting(false);
    }
  };

  const createComposioCred = async () => {
    if (!composioAvailable) {
      setError(COMPOSIO_UNAVAILABLE);
      return;
    }
    setSubmitting(true);
    setError(null);
    const linked = Object.entries(composioConnections).filter(([slug]) => composioToolkits.includes(slug));
    try {
      await api(`/v1/vaults/${vault.id}/credentials/composio_tool_router_session`, {
        method: "POST",
        body: JSON.stringify({
          display_name: form.name || form.pickedName || "Composio Tool Router",
          api_key: composioApiKey || undefined,
          toolkits: composioToolkits.length > 0 ? { enable: composioToolkits } : undefined,
          connected_accounts:
            linked.length > 0
              ? Object.fromEntries(linked.map(([slug, link]) => [slug, link.connectedAccountId]))
              : undefined,
          auth_configs:
            linked.length > 0 ? Object.fromEntries(linked.map(([slug, link]) => [slug, link.authConfigId])) : undefined,
        }),
        silentErrors: true,
      });
      onCreated();
    } catch (e) {
      setError(errorMessage(e, "The Composio session could not be created"));
    } finally {
      setSubmitting(false);
    }
  };

  const connectComposioToolkit = async (entry: Pick<ComposioIntegrationEntry, "slug" | "name">) => {
    if (!composioAvailable) {
      setError(COMPOSIO_UNAVAILABLE);
      return;
    }
    const slug = normalizeSlug(entry.slug);
    // Open the window inside the click, then point it at the provider.
    const popup = window.open("", `composio-${slug}`, "width=600,height=720,popup=yes");
    setConnecting(entry.name);
    try {
      addToolkit(slug);
      const callbackUrl = `${window.location.origin}/composio/callback?toolkit=${encodeURIComponent(slug)}`;
      const link = await api<{ redirect_url: string; connected_account_id: string; auth_config_id: string }>(
        `/v1/vaults/${vault.id}/credentials/composio_accounts/link`,
        {
          method: "POST",
          body: JSON.stringify({ toolkit: slug, callback_url: callbackUrl, api_key: composioApiKey || undefined }),
          silentErrors: true,
        },
      );
      setComposioConnections((prev) => ({
        ...prev,
        [slug]: {
          connectedAccountId: link.connected_account_id,
          authConfigId: link.auth_config_id,
          status: "pending",
          redirectUrl: link.redirect_url,
        },
      }));
      if (popup) popup.location.href = link.redirect_url;
      else window.open(link.redirect_url, `composio-${slug}`, "width=600,height=720,popup=yes");
    } catch (err) {
      popup?.close();
      setError(errorMessage(err, "The provider sign-in could not be started"));
    } finally {
      setConnecting(null);
    }
  };

  const openOrConnect = (slug: string, name: string) => {
    const connection = composioConnections[slug];
    if (connection?.status === "pending" && connection.redirectUrl) {
      window.open(connection.redirectUrl, `composio-${slug}`, "width=600,height=720,popup=yes");
    } else {
      void connectComposioToolkit({ slug, name });
    }
  };

  const createCapCliCred = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await api(`/v1/vaults/${vault.id}/credentials`, {
        method: "POST",
        body: JSON.stringify({
          display_name: cliForm.display_name || cli?.label || cliForm.cli_id,
          auth: { type: "cap_cli", cli_id: cliForm.cli_id, token: cliForm.token },
        }),
        silentErrors: true,
      });
      onCreated();
    } catch (e) {
      setError(errorMessage(e, "The credential could not be saved"));
    } finally {
      setSubmitting(false);
    }
  };

  const pollDeviceFlow = async (flow: { session_id: string; interval_seconds: number; expires_at_ms: number }) => {
    let interval = flow.interval_seconds;
    while (Date.now() < flow.expires_at_ms) {
      await new Promise((r) => setTimeout(r, interval * 1000));
      try {
        const r = await api<{
          status: "pending" | "slow_down" | "ready" | "expired" | "denied" | "error";
          new_interval_seconds?: number;
          oauth_error?: string;
          description?: string;
          credential_id?: string;
        }>(`/v1/cap-cli/oauth/poll`, {
          method: "POST",
          body: JSON.stringify({ session_id: flow.session_id }),
          silentErrors: true,
        });
        if (r.status === "pending") continue;
        if (r.status === "slow_down") {
          interval = r.new_interval_seconds ?? interval + 5;
          continue;
        }
        if (r.status === "ready") {
          setDeviceFlow((prev) => (prev ? { ...prev, status: "ready" } : null));
          // Refetch so the new credential shows up; the parent closes the dialog.
          onCreated();
          setTimeout(() => setDeviceFlow(null), 1500);
          return;
        }
        setDeviceFlow((prev) =>
          prev
            ? { ...prev, status: r.status as "expired" | "denied" | "error", error: r.description ?? r.oauth_error }
            : null,
        );
        return;
      } catch (err) {
        setDeviceFlow((prev) => (prev ? { ...prev, status: "error", error: failureSentence(err) } : null));
        return;
      }
    }
    setDeviceFlow((prev) => (prev ? { ...prev, status: "expired" } : null));
  };

  // Device flow: POST /initiate → show the code and URL → poll until
  // ready or a terminal failure.
  const startDeviceFlow = async () => {
    setDeviceFlow(null);
    try {
      const init = await api<{
        session_id: string;
        user_code: string;
        verification_uri: string;
        verification_uri_complete?: string;
        interval_seconds: number;
        expires_at_ms: number;
      }>(`/v1/cap-cli/oauth/initiate`, {
        method: "POST",
        body: JSON.stringify({ vault_id: vault.id, cli_id: cliForm.cli_id }),
        silentErrors: true,
      });
      const flow = { ...init, cli_id: cliForm.cli_id, status: "polling" as const };
      setDeviceFlow(flow);
      void pollDeviceFlow(flow);
    } catch (err) {
      setDeviceFlow({
        cli_id: cliForm.cli_id,
        session_id: "",
        user_code: "",
        verification_uri: "",
        interval_seconds: 0,
        expires_at_ms: 0,
        status: "error",
        error: failureSentence(err),
      });
    }
  };

  const submit = () => {
    if (kind === "cli") return void createCapCliCred();
    if (kind === "composio") return void createComposioCred();
    if (!form.url) return;
    if (kind === "bearer") return void createBearerCred();
    connectMcp(
      { name: form.name || form.pickedName || form.url, url: form.url },
      { clientId: form.clientId, clientSecret: form.clientSecret },
    );
  };

  const canSubmit =
    kind === "cli"
      ? !!cliForm.token
      : kind === "composio"
        ? composioAvailable
        : kind === "bearer"
          ? !!form.url && !!form.token
          : !!form.url;
  const submitLabel = kind === "oauth" ? "Connect" : "Add credential";
  const waitingForPopup = kind === "oauth" && !!connecting;

  const serverField = (
    <div>
      <label htmlFor="cred-mcp-server" className="mb-1.5 block text-small leading-5 font-medium text-fg">
        MCP server
      </label>
      {/* Type to filter the registry; pick a row to fill the URL, or type a URL of your own. */}
      <LocalCombobox<McpRegistryEntry>
        id="cred-mcp-server"
        value={form.url}
        onChange={(text) => setForm({ ...form, url: text, pickedName: "" })}
        onPick={(entry) => {
          setForm({ ...form, url: entry.url, pickedName: entry.name });
          if (entry.id === "composio") setKind("composio");
        }}
        options={MCP_REGISTRY}
        filter={(entry, q) => !q || entry.name.toLowerCase().includes(q) || entry.url.toLowerCase().includes(q)}
        getKey={(entry) => entry.id}
        renderItem={(entry) => (
          <div className="flex items-center gap-3 px-2.5 py-2">
            <InitialTile name={entry.name} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-small-size font-medium text-fg">{entry.name}</div>
              <div className="truncate font-mono text-micro-size text-fg-subtle">{entry.url}</div>
            </div>
          </div>
        )}
        prefix={form.pickedName ? <InitialTile name={form.pickedName} size="sm" /> : null}
        placeholder="Search known servers, or paste a URL"
        emptyHint="No known server matches. Keep typing to use your own URL."
      />
    </div>
  );

  const nameField = (
    <Field
      label={
        <>
          Name
          <OptionalTag />
        </>
      }
      hint="How this credential is listed in the vault."
    >
      <Input
        value={form.name}
        onChange={(e) => setForm({ ...form, name: e.target.value })}
        placeholder={form.pickedName || (kind === "composio" ? "Composio Tool Router" : "Sentry (production)")}
        autoComplete="off"
      />
    </Field>
  );

  return (
    <Modal
      open
      onClose={onClose}
      title="Add credential"
      subtitle="Secrets are encrypted when saved, and are never shown again."
      maxWidth="max-w-2xl"
      footer={
        polling ? (
          <Button variant="ghost" onClick={() => setDeviceFlow(null)}>
            Cancel sign-in
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
            {!(kind === "oauth" && appReq) && (
              <Button onClick={submit} disabled={!canSubmit || !!connecting} loading={submitting}>
                {submitLabel}
              </Button>
            )}
          </>
        )
      }
    >
      <div className="space-y-5">
        <ChoiceCards<CredentialKindChoice>
          label="Kind of credential"
          value={kind}
          onChange={(k) => {
            setKind(k);
            setError(null);
            setConnecting(null);
            setAppReq(null);
          }}
          options={[
            {
              value: "oauth",
              label: "Sign in with OAuth",
              description: "Authorise an MCP server in a popup.",
              icon: LogInIcon,
              disabled: polling,
            },
            {
              value: "bearer",
              label: "Paste a token",
              description: "A bearer token for an MCP server.",
              icon: KeyRoundIcon,
              disabled: polling,
            },
            {
              value: "cli",
              label: "Command-line tool",
              description: `gh, aws, gcloud and ${CAP_CLIS.length - 3} more.`,
              icon: SquareTerminalIcon,
            },
            {
              value: "composio",
              label: "Composio apps",
              description: "Many apps through one session.",
              icon: LayoutGridIcon,
              disabled: polling,
            },
          ]}
        />

        {error && <Callout tone="danger">{error}</Callout>}

        {kind === "oauth" && appReq && (
          <div className="space-y-4">
            <OAuthAppSetupPanel requirement={appReq} saving={savingApp} onSave={saveOAuthApp} />
            <Button variant="ghost" size="sm" onClick={() => setAppReq(null)} disabled={savingApp}>
              Choose another server
            </Button>
          </div>
        )}

        {kind === "oauth" && !appReq && (
          <>
            {serverField}
            {nameField}
            <Disclosure
              title="Use your own OAuth app"
              meta="Optional"
              open={clientCredsOpen}
              onOpenChange={setClientCredsOpen}
            >
              <div className="space-y-3">
                <Input
                  value={form.clientId}
                  onChange={(e) => setForm({ ...form, clientId: e.target.value })}
                  placeholder="Client ID"
                  aria-label="OAuth client ID"
                  autoComplete="off"
                  className={MONO}
                />
                <SecretInput
                  value={form.clientSecret}
                  onChange={(e) => setForm({ ...form, clientSecret: e.target.value })}
                  placeholder="Client secret"
                  aria-label="OAuth client secret"
                />
                <p className="text-xs text-fg-subtle">
                  For providers without Dynamic Client Registration (GitHub, Feishu): the client ID and secret of an
                  app you registered with them.
                </p>
              </div>
            </Disclosure>
            {waitingForPopup && (
              <Callout
                tone="info"
                title="Finish signing in in the popup window"
                action={
                  <Button size="sm" variant="ghost" onClick={() => setConnecting(null)}>
                    Start over
                  </Button>
                }
              >
                This dialog updates on its own when the provider sends you back.
              </Callout>
            )}
            <p className="text-xs text-fg-subtle">
              Signing in here does not give the login to an agent. An agent uses it once the server is among its tools
              and this vault is attached to it.
            </p>
          </>
        )}

        {kind === "bearer" && (
          <>
            {serverField}
            {nameField}
            <SecretInput
              label="Access token"
              hint="Sent to the MCP server as a bearer token."
              value={form.token}
              onChange={(e) => setForm({ ...form, token: e.target.value })}
              placeholder="Paste the token"
            />
            <Disclosure title="Refresh it automatically" meta="Optional" open={refreshOpen} onOpenChange={setRefreshOpen}>
              <div className="space-y-4">
                <SecretInput
                  label="Refresh token"
                  value={form.refreshToken}
                  onChange={(e) => setForm({ ...form, refreshToken: e.target.value })}
                  placeholder="OAuth refresh token"
                />
                <Field label="Token endpoint">
                  <Input
                    value={form.tokenEndpoint}
                    onChange={(e) => setForm({ ...form, tokenEndpoint: e.target.value })}
                    placeholder="https://auth.example.com/oauth/token"
                    autoComplete="off"
                    className={MONO}
                  />
                </Field>
                <Field label="Auth method" hint="How the server authenticates when it refreshes after a 401 (RFC 8414).">
                  <Select value={form.authMethod} onValueChange={(v) => setForm({ ...form, authMethod: v as AuthMethod })}>
                    <SelectOption value="client_secret_post">client_secret_post</SelectOption>
                    <SelectOption value="client_secret_basic">client_secret_basic</SelectOption>
                    <SelectOption value="none">none</SelectOption>
                  </Select>
                </Field>
                <p className="text-xs text-fg-subtle">
                  With a refresh token and its endpoint, the credential is stored as OAuth and renews itself. Without
                  them it is a fixed token.
                </p>
              </div>
            </Disclosure>
          </>
        )}

        {kind === "cli" && (
          <>
            <Field label="Tool" hint={cli?.helper}>
              <Select
                value={cliForm.cli_id}
                onValueChange={(v) => {
                  setCliForm({ ...cliForm, cli_id: v });
                  setDeviceFlow(null);
                }}
                disabled={polling}
              >
                {CAP_CLIS.map((c) => (
                  <SelectOption key={c.cli_id} value={c.cli_id}>
                    {c.label}
                    {c.oauth && deviceFlowAvailable ? " · sign-in available" : ""}
                  </SelectOption>
                ))}
              </Select>
            </Field>

            {cli?.oauth && deviceFlowAvailable && (
              <div className="rounded-lg bg-bg-soft p-4">
                {!deviceFlow && (
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <p className="text-small-size font-medium text-fg">Sign in instead of pasting a token</p>
                      <p className="mt-0.5 text-xs text-fg-muted">
                        You approve a one-time code on the provider's site. No token passes through your clipboard.
                      </p>
                    </div>
                    <Button variant="outline" size="sm" onClick={() => void startDeviceFlow()}>
                      Sign in with {cliForm.cli_id}
                    </Button>
                  </div>
                )}
                {polling && deviceFlow && (
                  <div className="text-center">
                    <p className="text-small text-fg-muted">Open this page and enter the code</p>
                    <a
                      href={deviceFlow.verification_uri_complete ?? deviceFlow.verification_uri}
                      target="_blank"
                      rel="noreferrer"
                      className={cn(standaloneLink, "mt-1 max-w-full text-small")}
                    >
                      <span className="truncate">{deviceFlow.verification_uri_complete ?? deviceFlow.verification_uri}</span>
                      <ExternalLinkIcon className="size-3.5 shrink-0" />
                    </a>
                    <div className="mt-3 flex items-center justify-center gap-1.5">
                      <span className="rounded-lg bg-bg-surface px-4 py-2 font-mono text-h1 tracking-[0.12em] text-fg shadow-[var(--shadow-xs)] select-all dark:bg-bg-pressed">
                        {deviceFlow.user_code}
                      </span>
                      <CopyButton value={deviceFlow.user_code} label="Copy code" size="md" />
                    </div>
                    <p className="mt-3 inline-flex items-center gap-2 text-xs text-fg-subtle">
                      <BrandLoader size="sm" label="Waiting" />
                      Waiting for you to approve. Checking every {deviceFlow.interval_seconds}s.
                    </p>
                  </div>
                )}
                {deviceFlow?.status === "ready" && (
                  <Callout tone="success" className="bg-transparent p-0">
                    Signed in. The token is stored in this vault.
                  </Callout>
                )}
                {(deviceFlow?.status === "expired" || deviceFlow?.status === "denied" || deviceFlow?.status === "error") && (
                  <Callout
                    tone="danger"
                    className="bg-transparent p-0"
                    action={
                      <Button size="sm" variant="outline" onClick={() => void startDeviceFlow()}>
                        Try again
                      </Button>
                    }
                  >
                    {deviceFlow.status === "denied"
                      ? "Access was denied on the provider's site."
                      : deviceFlow.status === "expired"
                        ? "The code expired before it was approved."
                        : `Sign-in failed: ${deviceFlow.error ?? "unknown error"}`}
                  </Callout>
                )}
              </div>
            )}

            <Field
              label={
                <>
                  Name
                  <OptionalTag />
                </>
              }
            >
              <Input
                value={cliForm.display_name}
                onChange={(e) => setCliForm({ ...cliForm, display_name: e.target.value })}
                placeholder={cli?.label ?? cliForm.cli_id}
                disabled={polling}
                autoComplete="off"
              />
            </Field>
            <SecretInput
              label="Token"
              hint={
                cli?.oauth && deviceFlowAvailable
                  ? "Write-only. Leave blank if you sign in above."
                  : "Write-only: it cannot be read back after you save."
              }
              value={cliForm.token}
              onChange={(e) => setCliForm({ ...cliForm, token: e.target.value })}
              placeholder="Paste the token"
              disabled={polling}
            />
          </>
        )}

        {kind === "composio" && (
          <>
            {!composioStatusLoading && !composioAvailable && <Callout tone="warning">{COMPOSIO_UNAVAILABLE}</Callout>}
            {showComposioApiKey && (
              <SecretInput
                label={
                  <>
                    Composio API key
                    <OptionalTag required={!hasComposioCredential} />
                  </>
                }
                hint="Used for this vault when the API server has no COMPOSIO_API_KEY of its own."
                value={form.composioApiKey}
                onChange={(e) => setForm({ ...form, composioApiKey: e.target.value })}
                placeholder="ak_..."
              />
            )}
            {nameField}

            <div>
              <div className="mb-1.5 flex items-baseline justify-between gap-3">
                <p className="text-small leading-5 font-medium text-fg">Apps</p>
                <p className="text-xs text-fg-subtle">
                  {composioStatusLoading || (composioCatalogEnabled && composioCatalogLoading)
                    ? "Loading"
                    : `${composioCatalogEntries.length} available`}
                </p>
              </div>
              {composioStatusLoading || (composioCatalogEnabled && composioCatalogLoading) ? (
                <div className="space-y-px overflow-hidden rounded-lg border border-border" aria-hidden="true">
                  {[0, 1, 2, 3].map((i) => (
                    <div key={i} className="flex h-[52px] items-center gap-3 border-t border-border px-3.5 first:border-t-0">
                      <Skeleton className="size-[18px]" rounded="sm" />
                      <Skeleton className="size-7" rounded="md" />
                      <Skeleton className="h-3 w-32" rounded="sm" />
                    </div>
                  ))}
                </div>
              ) : composioCatalogEntries.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border-strong px-4 py-6 text-center">
                  <p className="text-small-size font-medium text-fg">
                    {composioCatalogEnabled ? "No apps to show" : "The app list needs a Composio key"}
                  </p>
                  <p className="mt-0.5 text-xs text-fg-muted">
                    {composioCatalogEnabled
                      ? "You can still name toolkits below."
                      : "Once a key is saved with this vault you can browse and connect apps here. Until then, name the toolkits below."}
                  </p>
                </div>
              ) : (
                <ul className="max-h-72 overflow-y-auto rounded-lg border border-border">
                  {composioCatalogEntries.map((entry) => {
                    const selected = composioToolkits.includes(entry.slug);
                    const connection = composioConnections[entry.slug];
                    return (
                      <li key={entry.slug} className="flex items-center gap-3 border-t border-border px-3.5 py-2.5 first:border-t-0">
                        <Checkbox
                          checked={selected}
                          onCheckedChange={() => toggleToolkit(entry.slug)}
                          aria-label={`Enable ${entry.name}`}
                        />
                        <InitialTile name={entry.name} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-small-size font-medium text-fg">{entry.name}</div>
                          <div className="truncate text-xs text-fg-subtle">{entry.category}</div>
                        </div>
                        {connection && (
                          <StatusBadge status={connection.status === "connected" ? "connected" : "pending"} variant="soft" />
                        )}
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => openOrConnect(entry.slug, entry.name)}
                          disabled={!composioAvailable || !!connecting}
                        >
                          {connection?.status === "pending" ? "Open sign-in" : "Connect"}
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <Field
              label={
                <>
                  Toolkits
                  <OptionalTag />
                </>
              }
              hint="Composio toolkit names, separated by commas. Ticking an app above adds it here."
            >
              <Input
                value={form.composioToolkits}
                onChange={(e) => setForm({ ...form, composioToolkits: e.target.value })}
                placeholder="github, slack, notion, googledrive"
                autoComplete="off"
                className={MONO}
              />
            </Field>
            {composioToolkits.length > 0 && (
              <div className="-mt-2 flex flex-wrap gap-1.5">
                {composioToolkits.map((slug) => {
                  const known = composioCatalogEntries.find((entry) => entry.slug === slug);
                  const connection = composioConnections[slug];
                  return (
                    <span
                      key={slug}
                      className="inline-flex h-7 items-center gap-2 rounded-full bg-bg-soft pr-1 pl-2.5 text-xs text-fg-muted"
                    >
                      <span className="font-mono text-micro-size text-fg">{slug}</span>
                      {connection && (
                        <span className={connection.status === "connected" ? "text-success" : "text-warning"}>
                          {connection.status === "connected" ? "Connected" : "Pending"}
                        </span>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        className="h-5 px-2"
                        disabled={!composioAvailable || !!connecting}
                        onClick={() => openOrConnect(slug, known?.name ?? slug)}
                      >
                        {connection?.status === "pending" ? "Open sign-in" : "Connect"}
                      </Button>
                    </span>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
