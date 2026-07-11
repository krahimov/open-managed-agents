import { useEffect, useRef, useState } from "react";
import { useParams, Link } from "react-router";
import { toast } from "sonner";
import { useApi } from "../lib/api";
import { Button } from "@/components/ui/button";
import type { Event } from "../lib/events";

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
}: {
  event: Event;
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
  };
  const service = (ev.service ?? "service").toLowerCase();
  const isMcpOauth = typeof ev.mcp_server_url === "string" && ev.mcp_server_url.length > 0;
  const [status, setStatus] = useState<"pending" | "connecting" | "connected" | "error">(
    "pending",
  );
  const [error, setError] = useState<string | null>(null);
  const notifiedRef = useRef(false);

  useEffect(() => {
    if (status !== "connecting") return;
    const complete = () => {
      if (notifiedRef.current) return;
      notifiedRef.current = true;
      setStatus("connected");
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
                  text: `[access granted] ${service} is now connected — continue where you left off.`,
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
        complete();
      } else if (data?.type === "oauth_complete") {
        // MCP OAuth callback reports the provider's display name — accept any
        // completion that lands while THIS card is the one connecting.
        complete();
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
        ) : composioUnavailable ? (
          <Button asChild variant="outline" size="sm">
            <Link to="/integrations/apps">Connect Composio first</Link>
          </Button>
        ) : (
          <Button size="sm" onClick={connect} disabled={status === "connecting"}>
            {status === "connecting" ? "Waiting for provider…" : `Connect ${service}`}
          </Button>
        )}
      </div>
      {error && <div className="mt-2 text-xs text-danger">{error}</div>}
      <div className="mt-2 text-[11px] text-fg-subtle">
        Authentication happens with the provider directly; the credential lands in your
        Connected Apps vault — never in this conversation.
      </div>
    </div>
  );
}
