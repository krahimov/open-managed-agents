import { useEffect, useRef, useState } from "react";
import { useParams, Link } from "react-router";
import { toast } from "sonner";
import { useApi } from "../lib/api";
import { Button } from "@/components/ui/button";
import type { Event } from "../lib/events";
import { OAuthAppSetupPanel, type OAuthAppRequirement } from "./OAuthAppSetupPanel";

/**
 * Agent-initiated credential request — rendered when the agent calls its
 * `request_access` tool (system.access_request event). One click runs the
 * right connect flow for the service and, on completion, appends a
 * user.message so the agent learns access was granted and resumes:
 *
 *   - event.mcp_server_url present (the service matched one of the agent's
 *     own URL MCP servers, e.g. GitHub/Notion/Linear added during setup) →
 *     vault MCP OAuth popup (/v1/oauth/authorize), completion signalled as
 *     `oauth_complete` on the openma-oauth channel.
 *   - otherwise → Composio connected-account flow (vault link endpoint →
 *     provider OAuth popup → /composio/callback), completion signalled as
 *     `composio_auth_complete`.
 *
 * Secrets never appear in the conversation; credentials land in the
 * "Connected Apps" vault either way. Shared by SessionDetail (working
 * sessions) and SessionChat (agent setup panel).
 */
export function AccessRequestCard({
  event,
  sessionId: sessionIdProp,
  granted = false,
}: {
  event: Event;
  /** True when the session's event log already holds a
   *  system.access_granted for this request — the server recorded the
   *  grant, so the card renders "Connected" regardless of popup state or
   *  page reloads. */
  granted?: boolean;
  /** Session to notify on completion. Defaults to the :id route param
   *  (SessionDetail); SessionChat must pass it explicitly — its route
   *  param is the AGENT id. */
  sessionId?: string;
}) {
  const { api } = useApi();
  const { id: routeId } = useParams();
  const sessionId = sessionIdProp ?? routeId;
  const ev = event as unknown as {
    request_id?: string;
    service?: string;
    reason?: string;
    composio_configured?: boolean;
    mcp_server_url?: string;
    /** Server-side classification (postAccessRequest): how this service
     *  actually authenticates. Absent on events from older deploys —
     *  fall back to the pre-classification behavior then. */
    auth_kind?: "mcp_oauth" | "mcp_api_key" | "llm_provider" | "composio";
    /** Server-side discovery: provider needs a one-time OAuth app first. */
    oauth_app?: OAuthAppRequirement;
  };
  const service = (ev.service ?? "service").toLowerCase();
  const isMcpOauth =
    typeof ev.mcp_server_url === "string" &&
    ev.mcp_server_url.length > 0 &&
    ev.auth_kind !== "mcp_api_key";
  const isApiKeyMcp = ev.auth_kind === "mcp_api_key" && !!ev.mcp_server_url;
  const isLlmProvider = ev.auth_kind === "llm_provider";
  const [status, setStatus] = useState<"pending" | "connecting" | "connected" | "error">(
    granted ? "connected" : "pending",
  );
  const [error, setError] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  // One-time OAuth-app requirement (Slack, GitHub…). Seeded from the event
  // (postAccessRequest discovers it up front); also learned late from the
  // popup's `oauth_app_required` error for events from older deploys.
  const [appReq, setAppReq] = useState<OAuthAppRequirement | null>(
    ev.oauth_app && ev.oauth_app.required ? ev.oauth_app : null,
  );
  const [savingApp, setSavingApp] = useState(false);
  const notifiedRef = useRef(granted);
  /** Vault the Composio account landed in — needed post-OAuth to graft the
   *  connection onto the session's agent (tool-router server + vault link). */
  const vaultIdRef = useRef<string | null>(null);

  // Durable state wins over local popup bookkeeping: once the server has
  // written system.access_granted for this request, flip to Connected even
  // if this card never saw the popup finish (reload / re-render / other tab).
  useEffect(() => {
    if (!granted) return;
    notifiedRef.current = true;
    setStatus("connected");
  }, [granted]);

  useEffect(() => {
    if (status !== "connecting") return;
    const complete = async (opts: { grantRecorded?: boolean } = {}) => {
      if (notifiedRef.current) return;
      notifiedRef.current = true;
      setStatus("connected");
      if (opts.grantRecorded) {
        // The OAuth callback already appended system.access_granted + the
        // "[access granted]" nudge server-side — posting again would wake
        // the agent twice with a duplicate message.
        toast.success(`${service} connected.`);
        return;
      }
      // Graft the connection onto the session's AGENT (tool-router
      // mcp_server + vault link + toolkit list). Without this, an agent
      // created with no Composio wiring never sees the toolkit's tools —
      // in this session or any future one, scheduled sessions included.
      // Best-effort: the OAuth grant itself already succeeded.
      let attachedServer = false;
      if (!isMcpOauth && vaultIdRef.current) {
        try {
          const graft = await api<{ attached_server?: boolean }>(
            `/v1/sessions/${sessionId}/composio/graft`,
            {
              method: "POST",
              body: JSON.stringify({ toolkit: service, vault_id: vaultIdRef.current }),
              silentErrors: true,
            },
          );
          attachedServer = graft.attached_server === true;
        } catch {
          // agent stays unwired; the message below falls back to the nudge
        }
      }
      // Tell the agent — a plain user.message wakes the turn loop the same
      // way a typed reply would, so it picks the task back up.
      void api(`/v1/sessions/${sessionId}/events`, {
        method: "POST",
        body: JSON.stringify({
          events: [
            {
              type: "user.message",
              content: [
                {
                  type: "text",
                  // Composio grants change the tool surface mid-session
                  // (the tool router's SEARCH_TOOLS results now include the
                  // new toolkit) — without an explicit nudge, agents reason
                  // from their earlier "no tools found" and give up
                  // (observed: post-grant, an agent searched GitHub code
                  // for a Drive upload instead of re-querying Composio).
                  text: isMcpOauth
                    ? `[access granted] ${service} is now connected — continue where you left off.`
                    : attachedServer
                      ? `[access granted] ${service} is now connected and its toolkit was attached to this agent. This running session may not expose the new tools yet — NEW sessions of this agent (including scheduled ones) will have them. Re-run COMPOSIO_SEARCH_TOOLS for ${service} to check what's visible here, then continue where you left off.`
                      : `[access granted] ${service} is now connected. Your available actions have changed: re-run COMPOSIO_SEARCH_TOOLS for ${service} to discover its tools (do not assume earlier "no tools found" results still hold), then continue where you left off.`,
                },
              ],
            },
          ],
        }),
      }).catch(() => {
        toast.error("Connected, but failed to notify the agent — send it a message to continue.");
      });
      toast.success(`${service} connected.`);
    };
    const handle = (e: MessageEvent) => {
      const data = (
        e as MessageEvent<{ type?: string; toolkit?: string; service?: string }>
      ).data;
      if (data?.type === "composio_auth_complete") {
        if (data.toolkit && data.toolkit.toLowerCase() !== service) return;
        void complete();
      } else if (data?.type === "oauth_complete") {
        // Only THIS request's completion. Older callback pages carry no
        // request_id; accept those to stay compatible. Without this check
        // every connecting card completed on ANY popup finishing (seen live:
        // one GitHub popup → linear + github + github grants in one second).
        const done = data as { request_id?: string | null; grant_recorded?: boolean };
        if (done.request_id && ev.request_id && done.request_id !== ev.request_id) return;
        void complete({ grantRecorded: done.grant_recorded === true });
      } else if (data?.type === "oauth_error") {
        const err = data as {
          message?: string;
          code?: string;
          provider?: OAuthAppRequirement;
        };
        if (err.code === "oauth_app_required" && err.provider) {
          // Not a failure the user can retry — switch the card into the
          // guided one-time app setup.
          setAppReq(err.provider);
          setError(null);
          setStatus("pending");
          return;
        }
        // Popup-side failure (discovery, token exchange, provider proxy
        // state) — surface it on the card instead of leaving "Waiting for
        // provider…" forever.
        setStatus("error");
        setError(err.message ?? "Provider authentication failed");
      }
    };
    window.addEventListener("message", handle);
    let bc: BroadcastChannel | null = null;
    try {
      bc = new BroadcastChannel("openma-oauth");
      bc.addEventListener("message", handle);
    } catch {
      // BroadcastChannel is best effort for browsers without support.
    }
    return () => {
      window.removeEventListener("message", handle);
      if (bc) {
        bc.removeEventListener("message", handle);
        bc.close();
      }
    };
  }, [status, service, sessionId, api]);

  const ensureVault = async (): Promise<{ id: string }> => {
    const vaultsRes = await api<{
      data: Array<{ id: string; name: string; archived_at?: string | null }>;
    }>("/v1/vaults?status=active&limit=100");
    const existing =
      (vaultsRes.data ?? []).find((v) => !v.archived_at && v.name === "Connected Apps") ??
      (vaultsRes.data ?? []).find((v) => !v.archived_at) ??
      null;
    if (existing) return existing;
    return api<{ id: string }>("/v1/vaults", {
      method: "POST",
      body: JSON.stringify({ name: "Connected Apps" }),
    });
  };

  /** API-key MCP path (e.g. Retell: `Authorization: Bearer <key>`). The key
   *  goes straight into a static_bearer vault credential matched by the
   *  server URL — the credential proxy injects it on every call, the agent
   *  never sees it, and nothing lands in the transcript. */
  const saveApiKey = async () => {
    const token = apiKey.trim();
    if (!token) return;
    setError(null);
    setStatus("connecting");
    try {
      const vault = await ensureVault();
      await api(`/v1/vaults/${vault.id}/credentials`, {
        method: "POST",
        body: JSON.stringify({
          display_name: `${service} API key`,
          auth: { type: "static_bearer", token, mcp_server_url: ev.mcp_server_url },
        }),
      });
      setApiKey("");
      notifiedRef.current = true;
      setStatus("connected");
      await api(`/v1/sessions/${sessionId}/events`, {
        method: "POST",
        body: JSON.stringify({
          events: [
            {
              type: "user.message",
              content: [
                {
                  type: "text",
                  text: `[access granted] The ${service} API key is saved in the vault — calls to ${ev.mcp_server_url} are now authenticated automatically. Continue where you left off.`,
                },
              ],
            },
          ],
        }),
      }).catch(() => {
        toast.error("Key saved, but failed to notify the agent — send it a message to continue.");
      });
      toast.success(`${service} key saved to the vault.`);
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Failed to save the key");
    }
  };

  const connect = async () => {
    setError(null);
    setStatus("connecting");
    try {
      if (isMcpOauth) {
        // Direct MCP server the agent already carries in its harness — run
        // the vault OAuth flow against it (same popup VaultDetail uses).
        const vault = await ensureVault();
        const params = new URLSearchParams({
          mcp_server_url: ev.mcp_server_url!,
          vault_id: vault.id,
          redirect_uri: window.location.href,
          service,
        });
        // Let the callback record the grant on the session itself (and
        // graft the vault onto the agent) — the browser handoff below is
        // then only cosmetic.
        if (sessionId) params.set("session_id", sessionId);
        if (ev.request_id) params.set("request_id", ev.request_id);
        window.open(
          `/v1/oauth/authorize?${params.toString()}`,
          `oauth-${service}`,
          "width=600,height=700,popup=yes",
        );
        return;
      }
      // Composio path. Open the popup synchronously (popup blockers) and
      // point it at the provider once the link endpoint answers.
      const popup = window.open("", `composio-${service}`, "width=600,height=720,popup=yes");
      try {
        const vault = await ensureVault();
        vaultIdRef.current = vault.id;
        const callbackUrl = `${window.location.origin}/composio/callback?toolkit=${encodeURIComponent(service)}`;
        const link = await api<{ redirect_url: string }>(
          `/v1/vaults/${vault.id}/credentials/composio_accounts/link`,
          {
            method: "POST",
            body: JSON.stringify({ toolkit: service, callback_url: callbackUrl }),
          },
        );
        if (popup) popup.location.href = link.redirect_url;
        else window.open(link.redirect_url, `composio-${service}`, "width=600,height=720,popup=yes");
      } catch (err) {
        popup?.close();
        throw err;
      }
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Failed to start provider OAuth");
    }
  };

  const composioUnavailable = !isMcpOauth && ev.composio_configured === false;
  const needsAppSetup =
    isMcpOauth && status !== "connected" && !!appReq?.required && !appReq.configured;

  const saveOAuthApp = async (clientId: string, clientSecret: string) => {
    if (!appReq) return;
    setSavingApp(true);
    setError(null);
    try {
      await api("/v1/oauth/apps", {
        method: "PUT",
        body: JSON.stringify({ issuer: appReq.issuer, client_id: clientId, client_secret: clientSecret }),
      });
      setAppReq({ ...appReq, configured: true, source: "tenant" });
      toast.success(`${appReq.label} app saved — continuing to ${appReq.label}…`);
      await connect();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to save the ${appReq.label} app`);
    } finally {
      setSavingApp(false);
    }
  };

  return (
    <div className="max-w-2xl border border-border rounded-lg bg-bg-surface px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium">
            Agent requests access to <span className="font-mono">{service}</span>
          </div>
          {ev.reason && <div className="text-xs text-fg-subtle mt-0.5">{ev.reason}</div>}
        </div>
        {status === "connected" ? (
          <span className="text-xs font-medium text-success whitespace-nowrap">Connected ✓</span>
        ) : isLlmProvider ? (
          <Button asChild variant="outline" size="sm">
            <Link to="/model-cards">Add key in Model Cards</Link>
          </Button>
        ) : isApiKeyMcp ? null : composioUnavailable ? (
          <Button asChild variant="outline" size="sm">
            <Link to="/integrations/apps">Connect Composio first</Link>
          </Button>
        ) : needsAppSetup ? (
          <span className="text-xs font-medium text-warning whitespace-nowrap">Setup required</span>
        ) : (
          <Button size="sm" onClick={connect} disabled={status === "connecting"}>
            {status === "connecting" ? "Waiting for provider…" : `Connect ${service}`}
          </Button>
        )}
      </div>
      {isApiKeyMcp && status !== "connected" && (
        <form
          className="mt-2 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void saveApiKey();
          }}
        >
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={`${service} API key`}
            autoComplete="off"
            className="flex-1 min-w-0 h-8 rounded-md border border-border bg-bg px-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-brand"
          />
          <Button size="sm" type="submit" disabled={status === "connecting" || !apiKey.trim()}>
            {status === "connecting" ? "Saving…" : "Save to vault"}
          </Button>
        </form>
      )}
      {needsAppSetup && appReq && (
        <OAuthAppSetupPanel requirement={appReq} saving={savingApp} onSave={saveOAuthApp} />
      )}
      {error && <div className="mt-2 text-xs text-danger">{error}</div>}
      <div className="mt-2 text-[11px] text-fg-subtle">
        {isLlmProvider
          ? "Model-provider keys are managed in Model Cards, not as connected apps — add the key there and the agent's model calls use it automatically."
          : isApiKeyMcp
            ? `This server authenticates with an API key (no OAuth). The key is stored as a vault credential bound to ${ev.mcp_server_url} — the proxy injects it per call; it never enters this conversation.`
            : "Authentication happens with the provider directly; the credential lands in your Connected Apps vault — never in this conversation."}
      </div>
    </div>
  );
}
