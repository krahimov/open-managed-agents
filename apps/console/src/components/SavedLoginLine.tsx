import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";

import { inlineLink, quietLink } from "@/lib/links";
import { cn } from "@/lib/utils";

import type { Event } from "../lib/events";
import { openOAuthPopup, subscribeOAuthMessages } from "../lib/oauth-popup";
import { serverInfo } from "./sessions/tools";

/**
 * One line under the turn for a `system.saved_login_attached` event: setup
 * found a working login for one of the agent's MCP servers and attached its
 * vault instead of asking. The line says which vault the agent got (by
 * name, linked) and, when the login can be replaced by an OAuth sign-in,
 * offers "Switch account".
 *
 * Switching signs in through the provider (`openOAuthPopup`, carrying
 * `session_id` and `request_id`) and saves the result in a NEW vault
 * (`new_vault_name`, never `vault_id`), so a login other agents share is
 * never overwritten. The durable `switched` prop (a `system.access_granted`
 * for this request in the log) is what marks the switch done; popup
 * messages only clear "waiting", and a closed popup stops waiting too.
 */
export interface SavedLoginLineProps {
  /** The `system.saved_login_attached` event. */
  event: Event;
  /** Defaults to the :id route param (SessionDetail); SessionChat must pass
   *  it explicitly, since its route param is the AGENT id. */
  sessionId?: string;
  /** The session's event log holds a `system.access_granted` for this
   *  event's request_id (C3's access_granted fold). */
  switched?: boolean;
}

export function SavedLoginLine({ event, sessionId: sessionIdProp, switched = false }: SavedLoginLineProps) {
  const { id: routeId } = useParams();
  const sessionId = sessionIdProp ?? routeId;
  const ev = event as unknown as {
    request_id?: string;
    service?: string;
    mcp_server_url?: string;
    vault_id?: string;
    vault_name?: string;
    agent_name?: string;
    can_switch?: boolean;
  };
  const service = (ev.service ?? "service").toLowerCase();
  const app = serverInfo(service);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const popupRef = useRef<Window | null>(null);

  useEffect(() => {
    if (switched) setWaiting(false);
  }, [switched]);

  useEffect(() => {
    if (!waiting) return;
    const handle = (e: MessageEvent) => {
      if (e.origin && e.origin !== window.location.origin) return;
      const data = e.data as { type?: string; request_id?: string | null; message?: string } | null | undefined;
      if (data?.type === "oauth_complete") {
        if (data.request_id && data.request_id !== ev.request_id) return;
        setWaiting(false);
      } else if (data?.type === "oauth_error") {
        setWaiting(false);
        setError(data.message ?? `${app.label} did not complete the sign-in. Try again.`);
      }
    };
    const unsubscribe = subscribeOAuthMessages(handle);
    // Closing the popup without finishing must not leave the line stuck.
    const closedCheck = window.setInterval(() => {
      if (popupRef.current?.closed) setWaiting(false);
    }, 500);
    return () => {
      unsubscribe();
      window.clearInterval(closedCheck);
    };
  }, [waiting, ev.request_id, app.label]);

  const switchAccount = () => {
    setError(null);
    const params = new URLSearchParams({
      mcp_server_url: ev.mcp_server_url ?? "",
      new_vault_name: ev.agent_name ? `${service} · ${ev.agent_name}` : `${service} login`,
      redirect_uri: window.location.href,
      service,
    });
    if (sessionId) params.set("session_id", sessionId);
    if (ev.request_id) params.set("request_id", ev.request_id);
    const popup = openOAuthPopup(params, `oauth-${service}`);
    if (!popup) {
      setError("Your browser blocked the sign-in window. Allow pop-ups for this site and try again.");
      return;
    }
    popupRef.current = popup;
    setWaiting(true);
  };

  const canSwitch = !!ev.can_switch && !!ev.mcp_server_url;
  const Icon = app.icon;

  return (
    <div className="flex min-h-8 items-start gap-2 py-1.5 text-small text-fg-muted" data-testid="saved-login">
      <Icon className="mt-0.5 size-4 shrink-0 text-fg-subtle" />
      <div className="min-w-0">
        <p className="min-w-0">
          {switched ? (
            <>
              <span className="font-medium text-fg">{app.label}</span> is using the account you just signed in with.
            </>
          ) : (
            <>
              <span className="font-medium text-fg">{app.label}</span> is using the saved login in{" "}
              {ev.vault_id ? (
                <Link to={`/vaults/${ev.vault_id}`} className={inlineLink}>
                  {ev.vault_name?.trim() || "this vault"}
                </Link>
              ) : (
                <span className="font-medium text-fg">{ev.vault_name?.trim() || "a vault"}</span>
              )}
              .
            </>
          )}
          {canSwitch && (
            <>
              {" "}
              <button
                type="button"
                onClick={switchAccount}
                disabled={waiting}
                className={cn(quietLink, "disabled:text-fg-subtle disabled:no-underline")}
              >
                {waiting ? "Waiting for sign-in…" : "Switch account"}
              </button>
            </>
          )}
        </p>
        {waiting && (
          <p className="mt-0.5 text-xs text-fg-subtle">
            Not offered a choice of account? Sign out of {app.label} in that window, then try again.
          </p>
        )}
        {error && (
          <p role="alert" className="mt-0.5 text-xs text-danger">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
