import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import type { Event } from "../lib/events";
import { openOAuthPopup, subscribeOAuthMessages } from "../lib/oauth-popup";

/**
 * Setup attached a saved login instead of asking (system.saved_login_attached):
 * says which vault the agent got and offers Switch account. Switching signs in
 * through the provider and saves the result in a NEW vault, so a login other
 * agents share is never overwritten. The durable system.access_granted (the
 * `switched` prop) is what marks it done; popup messages only clear "waiting".
 */
export function SavedLoginLine({
  event,
  sessionId: sessionIdProp,
  switched = false,
}: {
  event: Event;
  /** Defaults to the :id route param (SessionDetail); SessionChat must pass
   *  it explicitly — its route param is the AGENT id. */
  sessionId?: string;
  /** The session's event log holds a system.access_granted for this line. */
  switched?: boolean;
}) {
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
  const service = ev.service ?? "service";
  const label = service.charAt(0).toUpperCase() + service.slice(1);
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
      const data = (e as MessageEvent<{ type?: string; request_id?: string | null; message?: string }>).data;
      if (data?.type === "oauth_complete") {
        if (data.request_id && data.request_id !== ev.request_id) return;
        setWaiting(false);
      } else if (data?.type === "oauth_error") {
        setWaiting(false);
        setError(data.message ?? "Sign-in failed");
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
  }, [waiting, ev.request_id]);

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
      setError("Your browser blocked the sign-in window. Allow popups for this site and try again.");
      return;
    }
    popupRef.current = popup;
    setWaiting(true);
  };

  return (
    <div className="max-w-2xl text-xs text-fg-subtle">
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
        {switched ? (
          <span>
            <span className="font-medium text-fg">{label}</span>: using the account you just signed in with
          </span>
        ) : (
          <span>
            <span className="font-medium text-fg">{label}</span>: using the saved login from{" "}
            <Link to={`/vaults/${ev.vault_id ?? ""}`} className="font-mono underline underline-offset-2">
              {ev.vault_name ?? ev.vault_id}
            </Link>
          </span>
        )}
        {ev.can_switch && ev.mcp_server_url && (
          <>
            <span aria-hidden>·</span>
            <button
              type="button"
              onClick={switchAccount}
              disabled={waiting}
              className="underline underline-offset-2 hover:text-fg disabled:no-underline disabled:opacity-70"
            >
              {waiting ? "Waiting for sign-in…" : "Switch account"}
            </button>
          </>
        )}
      </div>
      {waiting && (
        <div className="mt-0.5">
          Not offered a choice of account? Sign out of {label} in that window, then try again.
        </div>
      )}
      {error && <div className="mt-0.5 text-danger">{error}</div>}
    </div>
  );
}
