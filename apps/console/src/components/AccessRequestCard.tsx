import { useEffect, useRef, useState } from "react";
import { useParams, Link } from "react-router";
import { toast } from "sonner";
import { KeyRoundIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

import { useApi } from "../lib/api";
import type { Event } from "../lib/events";
import { openOAuthPopup, subscribeOAuthMessages } from "../lib/oauth-popup";
import { useQuietQuery } from "../lib/useApiQuery";
import type { SessionRecord } from "../types/session";
import { EventCard } from "./EventCard";
import { SecretInput } from "./Input";
import { OAuthAppSetupPanel, type OAuthAppRequirement } from "./OAuthAppSetupPanel";
import { AnsweredRequest, NEEDS_YOU_CARD, PassedRequest } from "./sessions/RequestParts";
import { serverInfo } from "./sessions/tools";
import { withReason } from "@/lib/failure-text";

const MCP_POPUP = "width=600,height=700,popup=yes";
const COMPOSIO_POPUP = "width=600,height=720,popup=yes";
const POPUP_BLOCKED = "Your browser blocked the sign-in window. Allow pop-ups for this site and try again.";

/**
 * Agent-initiated credential request — rendered when the agent calls its
 * `request_access` tool (system.access_request event). One click runs the
 * right connect flow for the service:
 *
 *   - event.mcp_server_url present (the service matched one of the agent's
 *     own URL MCP servers, e.g. GitHub/Notion/Linear added during setup) →
 *     vault MCP OAuth popup through `openOAuthPopup` (a one-time start
 *     token, plus `session_id`/`request_id` so the OAuth callback records
 *     the grant on the session and tells the agent itself). Completion
 *     arrives as `oauth_complete` on the openma-oauth channel.
 *   - otherwise → Composio connected-account flow (vault link endpoint →
 *     provider OAuth popup → /composio/callback), completion signalled as
 *     `composio_auth_complete`. The account is then grafted onto the
 *     session's agent, and only a verified graft counts as connected.
 *
 * Providers whose MCP server registers no clients (Slack, GitHub…) first
 * need a one-time OAuth app: the card walks the person through it
 * (OAuthAppSetupPanel) instead of a Connect button that dead-ends.
 *
 * The card tells the agent ("[access granted] …", a user.message that
 * wakes the turn loop) only when the server has not already: never when
 * `granted` is set, and never when the popup reports `grant_recorded`.
 * Otherwise every start-token connect would wake the agent twice.
 *
 * Secrets never appear in the conversation; credentials land in the
 * "Connected Apps" vault (or the vault the caller names). Shared by
 * SessionDetail (working sessions), SessionChat (agent setup panel) and
 * the Telegram connection page.
 *
 * Whether the request is still waiting on a person is read from the
 * session's log (`state`, see sessions/requests.ts), so the card looks the
 * same after a reload as it did when it was answered:
 *
 *   open       amber, with the way to answer it. It counts as "waiting on you".
 *   answered   one quiet line: the app is connected.
 *   passed     the person replied without connecting. A neutral row that can
 *              still be used, but nothing is waiting on it.
 */
export function AccessRequestCard({
  event,
  sessionId: sessionIdProp,
  state = "open",
  granted = false,
  vaultId,
  agentName: agentNameProp,
}: {
  event: Event;
  /** What the log says became of this request. */
  state?: "open" | "answered" | "passed";
  /** True when the session's event log holds a `system.access_granted` for
   *  this request (C3's access_granted fold): the server recorded the
   *  grant, so the card reads as connected regardless of popup state or a
   *  reload, and it never posts its own "[access granted]" nudge. */
  granted?: boolean;
  /** The vault the signed-in user explicitly chose on the Telegram
   *  connection page; credentials go there instead of the default. */
  vaultId?: string;
  /** Session to notify on completion. Defaults to the :id route param
   *  (SessionDetail); SessionChat must pass it explicitly — its route
   *  param is the AGENT id. */
  sessionId?: string;
  /** The agent that asked, as the approval cards name it. When absent the
   *  card reads it from the session (one shared, quiet request). */
  agentName?: string;
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
    /** Server-side discovery: the provider needs a one-time OAuth app first. */
    oauth_app?: OAuthAppRequirement;
  };
  const service = (ev.service ?? "service").toLowerCase();
  const app = serverInfo(service);
  /** The app as people say it ("GitHub"), for everything a person reads. */
  const serviceLabel = app.label;
  const isMcpOauth =
    typeof ev.mcp_server_url === "string" &&
    ev.mcp_server_url.length > 0 &&
    ev.auth_kind !== "mcp_api_key";
  const isApiKeyMcp = ev.auth_kind === "mcp_api_key" && !!ev.mcp_server_url;
  const isLlmProvider = ev.auth_kind === "llm_provider";

  // Name the agent, as the approval cards do. Read from the session only
  // when the caller did not say, and only while the card is still asking.
  const askingAgent = useQuietQuery<SessionRecord>(
    sessionId ? `/v1/sessions/${sessionId}` : null,
    !agentNameProp && !granted && state !== "answered",
  );
  const agentName = agentNameProp?.trim() || askingAgent.data?.agent?.name?.trim() || "The agent";

  const [status, setStatus] = useState<"pending" | "connecting" | "connected" | "error">(
    granted ? "connected" : "pending",
  );
  const [error, setError] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  /** A passed-over request opened again to be answered after all. */
  const [reopened, setReopened] = useState(false);
  // One-time OAuth app requirement (Slack, GitHub…). Seeded from the event
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
  // written system.access_granted for this request, the card reads as
  // connected even if it never saw the popup finish (reload, other tab).
  useEffect(() => {
    if (!granted) return;
    notifiedRef.current = true;
    setStatus("connected");
    setError(null);
  }, [granted]);

  useEffect(() => {
    if (status !== "connecting") return;
    const complete = async (opts: { grantRecorded?: boolean } = {}) => {
      if (notifiedRef.current) return;
      notifiedRef.current = true;
      // Graft the connection onto the session's AGENT (tool-router
      // mcp_server + vault link + toolkit list). Without this, an agent
      // created with no Composio wiring never sees the toolkit's tools —
      // in this session or any future one, scheduled sessions included.
      // The graft also checks the provider account is active, so only a
      // verified connection is reported (and announced to the agent).
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
        } catch (err) {
          notifiedRef.current = false;
          setStatus("error");
          setError(withReason(`${serviceLabel} could not be confirmed as connected. Try again`, err));
          return;
        }
      }
      setStatus("connected");
      toast.success(`${serviceLabel} connected`);
      // The OAuth callback already appended system.access_granted and the
      // "[access granted]" message on the server: posting again would wake
      // the agent twice.
      if (opts.grantRecorded) return;
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
        toast.error("Connected, but the agent could not be told. Send it a message to continue.");
      });
    };
    const handle = (e: MessageEvent) => {
      // Only our own callback pages speak on this channel.
      if (e.origin && e.origin !== window.location.origin) return;
      const data = e.data as
        | {
            type?: string;
            toolkit?: string;
            error?: string;
            request_id?: string | null;
            grant_recorded?: boolean;
            message?: string;
            code?: string;
            provider?: OAuthAppRequirement;
          }
        | null
        | undefined;
      if (data?.type === "composio_auth_complete") {
        if (data.toolkit && data.toolkit.toLowerCase() !== service) return;
        if (data.error) {
          setStatus("error");
          setError(withReason(`${serviceLabel} did not complete the sign-in`, new Error(data.error)));
          return;
        }
        void complete();
      } else if (data?.type === "oauth_complete") {
        // Only THIS request's completion. Older callback pages carry no
        // request_id; those are accepted to stay compatible. Without the
        // check every connecting card completed on ANY popup finishing.
        if (data.request_id && ev.request_id && data.request_id !== ev.request_id) return;
        void complete({ grantRecorded: data.grant_recorded === true });
      } else if (data?.type === "oauth_error") {
        if (data.code === "oauth_app_required" && data.provider) {
          // Not a failure to retry: the provider needs its one-time app.
          setAppReq(data.provider);
          setError(null);
          setStatus("pending");
          return;
        }
        // Popup-side failure (discovery, token exchange, provider proxy
        // state) — surface it on the card instead of leaving "Waiting for
        // provider…" forever.
        setStatus("error");
        setError(data.message ?? `${serviceLabel} did not complete the sign-in. Try again.`);
      }
    };
    return subscribeOAuthMessages(handle);
  }, [status, service, serviceLabel, sessionId, api, isMcpOauth, ev.request_id]);

  const ensureVault = async (): Promise<{ id: string }> => {
    if (vaultId) return { id: vaultId };
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
      // Attach the vault to this session's agent and declare the server on
      // it: vault credentials only authenticate servers the agent declares.
      // Best effort; the key is saved either way.
      await api(`/v1/sessions/${sessionId}/access/attach`, {
        method: "POST",
        body: JSON.stringify({ service, vault_id: vault.id, mcp_server_url: ev.mcp_server_url }),
        silentErrors: true,
      }).catch(() => {});
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
        toast.error("Key saved, but the agent could not be told. Send it a message to continue.");
      });
      toast.success(`${serviceLabel} key saved to the vault`);
    } catch (err) {
      setStatus("error");
      setError(withReason("The key could not be saved", err));
    }
  };

  const connect = async () => {
    setError(null);
    if (isMcpOauth) {
      // Open the window inside the click (popup blockers); openOAuthPopup
      // finds it by name and points it at the provider once the vault and
      // the start token are ready.
      const name = `oauth-${service}`;
      const held = window.open("", name, MCP_POPUP);
      if (!held) {
        setStatus("error");
        setError(POPUP_BLOCKED);
        return;
      }
      setStatus("connecting");
      try {
        // Direct MCP server the agent already carries in its harness — run
        // the vault OAuth flow against it (same popup VaultDetail uses).
        const vault = await ensureVault();
        const params = new URLSearchParams({
          mcp_server_url: ev.mcp_server_url!,
          vault_id: vault.id,
          redirect_uri: window.location.href,
          service,
        });
        // The callback then records the grant on the session itself (and
        // grafts the vault onto the agent); the browser handoff is cosmetic.
        if (sessionId) params.set("session_id", sessionId);
        if (ev.request_id) params.set("request_id", ev.request_id);
        if (!openOAuthPopup(params, name, MCP_POPUP)) throw new Error(POPUP_BLOCKED);
      } catch (err) {
        held.close();
        setStatus("error");
        setError(withReason(`The ${serviceLabel} sign-in could not be started`, err));
      }
      return;
    }
    // Composio path. Open the popup synchronously (popup blockers) and
    // point it at the provider once the link endpoint answers.
    setStatus("connecting");
    const popup = window.open("", `composio-${service}`, COMPOSIO_POPUP);
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
      else window.open(link.redirect_url, `composio-${service}`, COMPOSIO_POPUP);
    } catch (err) {
      popup?.close();
      setStatus("error");
      setError(withReason(`The ${serviceLabel} sign-in could not be started`, err));
    }
  };

  const saveOAuthApp = async (clientId: string, clientSecret: string) => {
    if (!appReq) return;
    setSavingApp(true);
    setError(null);
    // Keep the click's permission to open a window across the save.
    const held = window.open("", `oauth-${service}`, MCP_POPUP);
    try {
      await api("/v1/oauth/apps", {
        method: "PUT",
        body: JSON.stringify({ issuer: appReq.issuer, client_id: clientId, client_secret: clientSecret }),
      });
    } catch (err) {
      held?.close();
      setError(withReason(`The ${appReq.label} app could not be saved`, err));
      setSavingApp(false);
      return;
    }
    setAppReq({ ...appReq, configured: true, source: "tenant" });
    setSavingApp(false);
    toast.success(`${appReq.label} app saved. Continuing to ${appReq.label}…`);
    await connect();
  };

  const composioUnavailable = !isMcpOauth && ev.composio_configured === false;
  const needsAppSetup = isMcpOauth && status !== "connected" && !!appReq?.required && !appReq.configured;
  const connecting = status === "connecting";

  // Done: the card relaxes into one quiet line, like a finished tool call.
  if (status === "connected" || granted || state === "answered") {
    return (
      <AnsweredRequest>
        <span className="font-medium text-fg">{app.label} connected.</span>{" "}
        {status !== "connected"
          ? "The agent was told and carried on."
          : isApiKeyMcp
            ? "The key is in your vault and the agent has been told."
            : "The agent has been told and is picking the task back up."}
      </AnsweredRequest>
    );
  }

  // The person answered in words instead: nothing waits on this any more,
  // but it can still be done from here.
  if (state === "passed" && !reopened && status === "pending") {
    return (
      <PassedRequest
        icon={isLlmProvider || isApiKeyMcp ? KeyRoundIcon : app.icon}
        title={`${agentName} asked for access to ${app.label}`}
        note={ev.reason}
        action={
          isLlmProvider ? (
            <Button asChild variant="outline" size="sm">
              <Link to="/model-cards">Add the key in Models</Link>
            </Button>
          ) : composioUnavailable ? (
            <Button asChild variant="outline" size="sm">
              <Link to="/integrations/apps">Connect Composio first</Link>
            </Button>
          ) : (
            // A key or an app setup is typed into the card, so the card opens
            // again; a sign-in starts at once.
            <Button
              variant="outline"
              size="sm"
              onClick={isApiKeyMcp || needsAppSetup ? () => setReopened(true) : connect}
            >
              {isApiKeyMcp ? "Add the key" : needsAppSetup ? `Set up ${app.label}` : `Connect ${app.label}`}
            </Button>
          )
        }
      />
    );
  }

  const note = isLlmProvider
    ? "Model-provider keys live in Models, not in connected apps. Add the key there and the agent's model calls use it automatically."
    : isApiKeyMcp
      ? `${app.label} signs requests with an API key, not a sign-in. The key is stored in your vault for ${hostOf(ev.mcp_server_url)} and added to each call; it never enters this conversation.`
      : `You sign in with ${app.label} directly. The credential is saved to your Connected Apps vault and never enters this conversation.`;

  return (
    <div data-needs-you={state === "open" ? "access" : undefined} className="scroll-my-24">
      <EventCard
        kind="approval"
        className={NEEDS_YOU_CARD}
        icon={isLlmProvider || isApiKeyMcp ? KeyRoundIcon : app.icon}
        title={`${agentName} needs access to ${app.label}`}
        subtitle={ev.reason || "It cannot continue this task without it."}
        actions={
          isLlmProvider ? (
            <Button asChild variant="outline" size="sm">
              <Link to="/model-cards">Add the key in Models</Link>
            </Button>
          ) : isApiKeyMcp || needsAppSetup ? undefined : composioUnavailable ? (
            <Button asChild variant="outline" size="sm">
              <Link to="/integrations/apps">Connect Composio first</Link>
            </Button>
          ) : (
            <Button size="sm" onClick={() => void connect()} loading={connecting} loadingLabel={`Waiting for ${app.label}…`}>
              Connect {app.label}
            </Button>
          )
        }
      >
        {isApiKeyMcp && (
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void saveApiKey();
            }}
          >
            <div className="min-w-0 flex-1">
              <SecretInput
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={`${app.label} API key`}
                aria-label={`${app.label} API key`}
              />
            </div>
            <Button type="submit" disabled={!apiKey.trim()} loading={connecting} loadingLabel="Saving…">
              Save to vault
            </Button>
          </form>
        )}
        {needsAppSetup && appReq && (
          <OAuthAppSetupPanel requirement={appReq} saving={savingApp} onSave={saveOAuthApp} />
        )}
        {error && (
          <p role="alert" className="text-small text-danger">
            {error}
          </p>
        )}
        <p className="text-xs leading-relaxed text-fg-muted">{note}</p>
      </EventCard>
    </div>
  );
}

function hostOf(url: string | undefined): string {
  if (!url) return "this server";
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
