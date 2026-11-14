import { useEffect, useRef, useState } from "react";
import { useParams, Link } from "react-router";
import { toast } from "sonner";
import { KeyRoundIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

import { useApi } from "../lib/api";
import type { Event } from "../lib/events";
import { EventCard } from "./EventCard";
import { SecretInput } from "./Input";
import { AnsweredRequest, NEEDS_YOU_CARD, PassedRequest } from "./sessions/RequestParts";
import { serverInfo } from "./sessions/tools";
import { withReason } from "@/lib/failure-text";

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
}: {
  event: Event;
  /** What the log says became of this request. */
  state?: "open" | "answered" | "passed";
  /** CONTRACT (step 0 baseline; C5 implements, C3 computes it in the
   *  access_granted fold). True when the session's event log holds a
   *  `system.access_granted` for this request: the server recorded the
   *  grant, so the card reads as connected regardless of popup state or a
   *  reload, and it never posts its own "[access granted]" nudge. C5 must
   *  also skip the nudge when the popup's `oauth_complete` message carries
   *  `grant_recorded: true` (the start-token path, where the OAuth callback
   *  already appended the grant and the nudge server-side). */
  granted?: boolean;
  /** CONTRACT (step 0 baseline; C5 implements, C1's TelegramConnect passes
   *  it). The vault the signed-in user explicitly chose on the Telegram
   *  connection page; credentials go there instead of the default. */
  vaultId?: string;
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
  };
  const service = (ev.service ?? "service").toLowerCase();
  /** The app as people say it ("GitHub"), for everything a person reads. */
  const serviceLabel = serverInfo(service).label;
  const isMcpOauth =
    typeof ev.mcp_server_url === "string" &&
    ev.mcp_server_url.length > 0 &&
    ev.auth_kind !== "mcp_api_key";
  const isApiKeyMcp = ev.auth_kind === "mcp_api_key" && !!ev.mcp_server_url;
  const isLlmProvider = ev.auth_kind === "llm_provider";
  const [status, setStatus] = useState<"pending" | "connecting" | "connected" | "error">(
    "pending",
  );
  const [error, setError] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  /** A passed-over request opened again to be answered after all. */
  const [reopened, setReopened] = useState(false);
  const notifiedRef = useRef(false);
  /** Vault the Composio account landed in — needed post-OAuth to graft the
   *  connection onto the session's agent (tool-router server + vault link). */
  const vaultIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (status !== "connecting") return;
    const complete = async () => {
      if (notifiedRef.current) return;
      notifiedRef.current = true;
      setStatus("connected");
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
        toast.error("Connected, but the agent could not be told. Send it a message to continue.");
      });
      toast.success(`${serviceLabel} connected`);
    };
    const handle = (e: MessageEvent) => {
      const data = (
        e as MessageEvent<{ type?: string; toolkit?: string; service?: string }>
      ).data;
      if (data?.type === "composio_auth_complete") {
        if (data.toolkit && data.toolkit.toLowerCase() !== service) return;
        void complete();
      } else if (data?.type === "oauth_complete") {
        // MCP OAuth callback reports the provider's display name — accept any
        // completion that lands while THIS card is the one connecting.
        void complete();
      } else if (data?.type === "oauth_error") {
        // Popup-side failure (discovery, missing preset app, token exchange,
        // provider proxy state) — surface it on the card instead of leaving
        // "Waiting for provider…" forever.
        setStatus("error");
        setError((data as { message?: string }).message ?? `${serviceLabel} did not complete the sign-in. Try again.`);
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
        });
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
      setError(withReason(`The ${serviceLabel} sign-in could not be started`, err));
    }
  };

  const composioUnavailable = !isMcpOauth && ev.composio_configured === false;
  const app = serverInfo(service);
  const connecting = status === "connecting";

  // Done: the card relaxes into one quiet line, like a finished tool call.
  if (status === "connected" || state === "answered") {
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
        title={`The agent asked for access to ${app.label}`}
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
            // A key is typed into the card, so the card opens again; a sign-in starts at once.
            <Button variant="outline" size="sm" onClick={isApiKeyMcp ? () => setReopened(true) : connect}>
              {isApiKeyMcp ? "Add the key" : `Connect ${app.label}`}
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
      title={`The agent needs access to ${app.label}`}
      subtitle={ev.reason || "It cannot continue this task without it."}
      actions={
        isLlmProvider ? (
          <Button asChild variant="outline" size="sm">
            <Link to="/model-cards">Add the key in Models</Link>
          </Button>
        ) : isApiKeyMcp ? undefined : composioUnavailable ? (
          <Button asChild variant="outline" size="sm">
            <Link to="/integrations/apps">Connect Composio first</Link>
          </Button>
        ) : (
          <Button size="sm" onClick={connect} loading={connecting} loadingLabel={`Waiting for ${app.label}…`}>
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
