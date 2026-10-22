import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router";
import { CheckIcon, PlusIcon } from "lucide-react";
import { knownMcpServerForName, knownMcpServerForUrl, serviceDisplayName } from "@open-managed-agents/api-types";
import { useApi } from "../lib/api";
import { Button } from "./ui/button";
import { Spinner } from "./ui/spinner";
import { OAuthAppSetupPanel, type OAuthAppRequirement } from "./OAuthAppSetupPanel";

/**
 * Connect card for one MCP server on an agent (system.access_request with an
 * mcp_server_url). The user picks the account this agent works in:
 *
 *   - a saved account — each row shows who it is (account · workspace, looked
 *     up from the provider) and one "Use" click connects it, or
 *   - a new sign-in — "Connect Linear" opens the provider popup; the server
 *     verifies the account and connects it when the popup finishes.
 *
 * Nothing is shared with the agent until one of those happens (server-side
 * bindings, see apps/main-node/src/lib/connection-consent.ts). Tokens never
 * reach the browser or the conversation.
 */

export interface ConnectionRequest {
  request_id: string;
  service: string;
  reason?: string;
  mcp_server_url: string;
  auth_kind?: string;
  oauth_app?: OAuthAppRequirement;
  /** The agent asked for a different account: open on the choices. */
  switch_account?: boolean;
}

interface Identity {
  status: "verified" | "unverified";
  account?: string;
  workspace?: string;
  workspace_id?: string;
  message?: string;
  /** Marks the credential generation this identity describes; Use echoes it. */
  version?: string;
}

interface SavedConnection {
  credential_id: string;
  vault_id: string;
  label: string;
  vault_name?: string;
  identity: Identity | null;
}

interface CardState {
  display_name?: string;
  approved: boolean;
  broken?: boolean;
  current: { credential_id: string; vault_id: string; label: string; account?: string; workspace?: string } | null;
  connections: SavedConnection[];
}

type ConnectResult =
  | { status: "connected"; account?: string; workspace?: string; message?: string }
  | { status: "unverified"; message: string };

function errorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === "object" && "message" in err && typeof err.message === "string" && err.message) {
    return err.message;
  }
  return fallback;
}

/** Provider favicon, falling back to the service's initial. */
export function ServiceIcon({ service, url, className = "size-8" }: { service: string; url?: string; className?: string }) {
  const known = knownMcpServerForUrl(url) ?? knownMcpServerForName(service);
  let domain = known?.domain;
  if (!domain && url) {
    try {
      domain = new URL(url).hostname.replace(/^(mcp|api)\./, "");
    } catch {
      domain = undefined;
    }
  }
  const [failed, setFailed] = useState(false);
  const name = serviceDisplayName(service, url);
  return (
    <span
      className={`${className} shrink-0 rounded-md border border-border bg-bg flex items-center justify-center overflow-hidden`}
      aria-hidden
    >
      {domain && !failed ? (
        <img
          src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`}
          alt=""
          className="size-[60%]"
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="text-xs font-semibold text-fg-muted">{name.charAt(0)}</span>
      )}
    </span>
  );
}

function who(account?: string, workspace?: string): string {
  return [account, workspace].filter(Boolean).join(" · ");
}

export function ConnectionCard({
  request,
  sessionId: explicitSessionId,
  granted = false,
}: {
  request: ConnectionRequest;
  sessionId?: string;
  /** The session log holds a system.access_granted for this request. */
  granted?: boolean;
}) {
  const { api } = useApi();
  const { id } = useParams();
  const sessionId = explicitSessionId ?? id ?? "";
  const base = `/v1/connection-access/${encodeURIComponent(sessionId)}/${encodeURIComponent(request.request_id)}`;
  const name = serviceDisplayName(request.service, request.mcp_server_url);
  const isApiKey = request.auth_kind === "mcp_api_key";

  const [state, setState] = useState<CardState | null>(null);
  const [gone, setGone] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [identities, setIdentities] = useState<Record<string, Identity | "checking">>({});
  const [choosing, setChoosing] = useState(request.switch_account === true);
  const [busy, setBusy] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [appReq, setAppReq] = useState<OAuthAppRequirement | undefined>(request.oauth_app);
  const [savingApp, setSavingApp] = useState(false);
  const popupRef = useRef<Window | null>(null);
  const identifyStarted = useRef(new Set<string>());

  const identify = useCallback(
    (conn: SavedConnection) => {
      identifyStarted.current.add(conn.credential_id);
      setIdentities((m) => ({ ...m, [conn.credential_id]: "checking" }));
      api<Identity>(`${base}/identify`, {
        method: "POST",
        body: JSON.stringify({ vault_id: conn.vault_id, credential_id: conn.credential_id }),
        silentErrors: true,
      })
        .then((identity) => setIdentities((m) => ({ ...m, [conn.credential_id]: identity })))
        .catch(() =>
          setIdentities((m) => ({
            ...m,
            [conn.credential_id]: { status: "unverified", message: "Couldn't check this account." },
          })),
        );
    },
    [api, base],
  );

  const load = useCallback(async () => {
    try {
      const next = await api<CardState>(base, { silentErrors: true });
      setState(next);
      setGone(null);
      setLoadFailed(false);
      return next;
    } catch (err) {
      const message = errorMessage(err, "");
      if (/no longer configured/i.test(message)) setGone(message);
      else setLoadFailed(true);
      return null;
    }
  }, [api, base]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (granted) void load();
  }, [granted, load]);

  // Look up who each saved account is (provider identity, read-only) so the
  // user can tell them apart before choosing.
  // A few at a time: a workspace can hold many old sign-ins for one service.
  useEffect(() => {
    if (!state) return;
    let inFlight = Object.values(identities).filter((v) => v === "checking").length;
    for (const conn of state.connections) {
      if (inFlight >= 3) break;
      if (conn.identity || identifyStarted.current.has(conn.credential_id)) continue;
      identify(conn);
      inFlight++;
    }
  }, [state, identities, identify]);

  const finish = useCallback(
    async (result: ConnectResult) => {
      if (result.status === "connected") {
        setChoosing(false);
        setError(null);
        await load();
      } else {
        setError(result.message);
        await load();
      }
    },
    [load],
  );

  // Popup completion (postMessage from the callback page, or the
  // BroadcastChannel when the opener link is lost).
  useEffect(() => {
    if (!signingIn) return;
    const handle = (event: MessageEvent) => {
      if (event.origin && event.origin !== window.location.origin) return;
      const data = event.data as {
        type?: string;
        request_id?: string | null;
        session_id?: string | null;
        connected?: boolean | null;
        account?: string | null;
        workspace?: string | null;
        connect_error?: string | null;
        message?: string;
        code?: string;
        provider?: OAuthAppRequirement;
      } | null;
      if (!data || data.request_id !== request.request_id || data.session_id !== sessionId) return;
      if (data.type === "oauth_complete") {
        setSigningIn(false);
        void finish(
          data.connected
            ? { status: "connected", account: data.account ?? undefined, workspace: data.workspace ?? undefined }
            : { status: "unverified", message: data.connect_error ?? "Signed in, but the account couldn't be verified." },
        );
      } else if (data.type === "oauth_error") {
        setSigningIn(false);
        if (data.code === "oauth_app_required" && data.provider) {
          setAppReq(data.provider);
          setError(null);
        } else {
          setError(data.message ? `Sign-in failed: ${data.message}` : "Sign-in didn't complete.");
        }
      }
    };
    window.addEventListener("message", handle);
    let channel: BroadcastChannel | undefined;
    try {
      channel = new BroadcastChannel("openma-oauth");
      channel.addEventListener("message", handle);
    } catch {
      // postMessage still works
    }
    // Popup closed without a completion message (user gave up, or both
    // channels were lost): stop waiting and re-read the server state.
    const timer = window.setInterval(() => {
      if (popupRef.current && popupRef.current.closed) {
        window.clearInterval(timer);
        window.setTimeout(() => {
          setSigningIn(false);
          void load();
        }, 800);
      }
    }, 600);
    return () => {
      window.removeEventListener("message", handle);
      channel?.close();
      window.clearInterval(timer);
    };
  }, [signingIn, request.request_id, sessionId, finish, load]);

  const signIn = async () => {
    setError(null);
    // Open during the click (popup blockers), point it at the provider once
    // the server has prepared the flow.
    const popup = window.open("", `oauth-${request.request_id}`, "width=600,height=720,popup=yes");
    if (!popup) {
      setError("Your browser blocked the sign-in window. Allow popups for this site and try again.");
      return;
    }
    popupRef.current = popup;
    setSigningIn(true);
    try {
      const started = await api<{ authorize_url: string }>(`${base}/start`, {
        method: "POST",
        body: JSON.stringify({ redirect_uri: window.location.href }),
        silentErrors: true,
      });
      popup.location.href = started.authorize_url;
    } catch (err) {
      popup.close();
      setSigningIn(false);
      setError(errorMessage(err, "Couldn't start the sign-in. Try again."));
    }
  };

  const use = async (conn: SavedConnection, identity: Identity | undefined) => {
    setBusy(conn.credential_id);
    setError(null);
    try {
      const result = await api<ConnectResult>(`${base}/use`, {
        method: "POST",
        body: JSON.stringify({
          vault_id: conn.vault_id,
          credential_id: conn.credential_id,
          expected_version: identity?.version,
          ...(identity?.account ? { expected_account: identity.account } : {}),
          ...(identity?.workspace_id ? { expected_workspace_id: identity.workspace_id } : {}),
        }),
        silentErrors: true,
      });
      if (result.status !== "connected") {
        // Re-check who this row is now, so the user sees the current account.
        setIdentities((m) => {
          const { [conn.credential_id]: _dropped, ...rest } = m;
          return rest;
        });
        identify(conn);
      }
      await finish(result);
    } catch (err) {
      setError(errorMessage(err, "Couldn't connect this account. Try again."));
      await load();
    } finally {
      setBusy(null);
    }
  };

  const saveKey = async () => {
    const token = apiKey.trim();
    if (!token) return;
    setBusy("api_key");
    setError(null);
    try {
      const result = await api<ConnectResult>(`${base}/api_key`, {
        method: "POST",
        body: JSON.stringify({ token }),
        silentErrors: true,
      });
      setApiKey("");
      await finish(result);
    } catch (err) {
      setError(errorMessage(err, "That key didn't work. Check it and try again."));
    } finally {
      setBusy(null);
    }
  };

  const saveOAuthApp = async (clientId: string, clientSecret: string) => {
    if (!appReq) return;
    setSavingApp(true);
    setError(null);
    try {
      await api("/v1/oauth/apps", {
        method: "PUT",
        body: JSON.stringify({ issuer: appReq.issuer, client_id: clientId, client_secret: clientSecret }),
        silentErrors: true,
      });
      setAppReq({ ...appReq, configured: true, source: "tenant" });
    } catch (err) {
      setError(errorMessage(err, `Couldn't save the ${appReq.label} app.`));
    } finally {
      setSavingApp(false);
    }
  };

  const connected = !!state?.approved && !!state.current;
  const needsAppSetup = !isApiKey && !!appReq?.required && !appReq.configured;
  const showChooser = !gone && (!connected || choosing);
  const saved = (state?.connections ?? []).filter((c) => !(connected && c.credential_id === state?.current?.credential_id));
  // Sort saved sign-ins into: usable accounts (one row per real account —
  // repeated sign-ins of the same account collapse), still being checked,
  // and ones that no longer work (tucked away, not a wall of rows).
  const rows = saved.map((conn) => {
    const looked = identities[conn.credential_id];
    // A fresh local check wins over the server's cached identity.
    const identity = (looked && looked !== "checking" ? looked : undefined) ?? conn.identity ?? undefined;
    return { conn, identity, checking: looked === "checking" || (!identity && looked === undefined) };
  });
  const seenAccounts = new Set<string>();
  const good = rows.filter((r) => {
    if (r.checking || r.identity?.status !== "verified") return false;
    const key = r.identity.account || r.identity.workspace_id ? `${r.identity.account ?? ""}|${r.identity.workspace_id ?? ""}` : null;
    if (!key) return true;
    if (seenAccounts.has(key)) return false;
    seenAccounts.add(key);
    return true;
  });
  const checkingCount = rows.filter((r) => r.checking).length;
  const broken = rows.filter((r) => !r.checking && r.identity && r.identity.status !== "verified");

  const subtitle = gone
    ? "Removed from this agent"
    : connected
      ? `${choosing ? "Currently: " : ""}${who(state?.current?.account, state?.current?.workspace) || state?.current?.label || "Connected"}`
      : state?.broken
        ? "The account this agent used was removed or reconnected. Choose it again."
        : state === null
          ? loadFailed
            ? "Couldn't load this connection"
            : "Loading…"
          : "Choose the account this agent works in";

  return (
    <div
      className="harness-diff-card max-w-2xl rounded-lg border border-border bg-bg-surface overflow-hidden"
      data-testid="connection-card"
      data-state={gone ? "gone" : connected ? "connected" : "pending"}
      data-connection-url={request.mcp_server_url}
    >
      <div className="flex items-center gap-3 px-4 py-3">
        <ServiceIcon service={request.service} url={request.mcp_server_url} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-fg">{name}</div>
          <div className={`text-xs truncate ${connected ? "text-fg-muted" : "text-fg-subtle"}`}>{subtitle}</div>
        </div>
        {connected && !choosing ? (
          <div className="flex items-center gap-2 shrink-0">
            <span className="inline-flex items-center gap-1 text-xs font-medium text-success">
              <CheckIcon className="size-3.5" aria-hidden /> Connected
            </span>
            <Button variant="ghost" size="sm" onClick={() => setChoosing(true)}>
              Change
            </Button>
          </div>
        ) : connected && choosing ? (
          <Button variant="ghost" size="sm" onClick={() => setChoosing(false)}>
            Cancel
          </Button>
        ) : gone ? null : state === null ? (
          loadFailed ? (
            <Button variant="outline" size="sm" onClick={() => void load()}>
              Retry
            </Button>
          ) : (
            <Spinner className="size-4 text-fg-subtle" />
          )
        ) : (
          <span className="inline-flex items-center gap-1.5 text-xs text-warning shrink-0">
            <span className="size-1.5 rounded-full bg-warning" aria-hidden /> Not connected
          </span>
        )}
      </div>

      {showChooser && state && (
        <div className="border-t border-border px-4 py-3 space-y-3">
          {good.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-[11px] font-medium uppercase tracking-wider text-fg-subtle">
                Saved {name} accounts
              </div>
              <ul className="divide-y divide-border rounded-md border border-border bg-bg">
                {good.map(({ conn, identity }) => (
                  <li key={conn.credential_id} className="flex items-center gap-3 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-fg truncate">{who(identity?.account, identity?.workspace) || conn.label}</div>
                      <div className="text-xs text-fg-subtle truncate">
                        {identity?.account || identity?.workspace
                          ? conn.label
                          : `Signed in · ${name} doesn't share account details`}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      disabled={!identity?.version || !!busy || signingIn}
                      loading={busy === conn.credential_id}
                      loadingLabel="Connecting…"
                      onClick={() => void use(conn, identity)}
                    >
                      Use
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {checkingCount > 0 && (
            <div className="flex items-center gap-1.5 text-xs text-fg-subtle">
              <Spinner className="size-3" />
              {good.length > 0
                ? `Checking ${checkingCount} more saved sign-in${checkingCount === 1 ? "" : "s"}…`
                : `Checking your saved ${name} accounts…`}
            </div>
          )}
          {broken.length > 0 && (
            <details className="text-xs text-fg-subtle" data-testid="broken-signins">
              <summary className="cursor-pointer select-none">
                {broken.length} older sign-in{broken.length === 1 ? "" : "s"} no longer work{broken.length === 1 ? "s" : ""}
              </summary>
              <ul className="mt-1.5 divide-y divide-border rounded-md border border-border bg-bg">
                {broken.map(({ conn, identity }) => (
                  <li key={conn.credential_id} className="flex items-center gap-3 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-fg truncate">{conn.label}</div>
                      <div className="text-xs text-danger truncate">{identity?.message ?? "This sign-in no longer works."}</div>
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => identify(conn)}>
                      Retry
                    </Button>
                  </li>
                ))}
              </ul>
            </details>
          )}

          {connected && !isApiKey && (
            <p className="text-xs text-fg-muted" data-testid="switch-hint">
              {name} signs you in as whoever your browser is logged into. For a different account or
              workspace, switch to it (or sign out) at {knownMcpServerForUrl(request.mcp_server_url)?.domain ?? name} first,
              then sign in here. Your current account stays connected until you pick another.
            </p>
          )}

          {isApiKey ? (
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void saveKey();
              }}
            >
              <input
                aria-label={`${name} API key`}
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={`Paste a ${name} API key`}
                className="flex-1 min-w-0 h-8 rounded-md border border-border bg-bg px-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-brand"
              />
              <Button size="sm" type="submit" disabled={!apiKey.trim() || !!busy} loading={busy === "api_key"} loadingLabel="Checking…">
                Connect
              </Button>
            </form>
          ) : needsAppSetup && appReq ? (
            <OAuthAppSetupPanel requirement={appReq} saving={savingApp} onSave={saveOAuthApp} />
          ) : (
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant={good.length > 0 ? "outline" : "default"}
                disabled={!!busy}
                onClick={() => void signIn()}
              >
                {signingIn ? (
                  <>
                    <Spinner className="size-3.5" /> Waiting for {name}…
                  </>
                ) : good.length > 0 || connected ? (
                  <>
                    <PlusIcon className="size-3.5" aria-hidden /> Sign in with {connected ? "a different" : "another"} {name} account
                  </>
                ) : (
                  `Connect ${name}`
                )}
              </Button>
              {signingIn && (
                <Button variant="ghost" size="sm" onClick={() => void signIn()}>
                  Reopen window
                </Button>
              )}
            </div>
          )}
        </div>
      )}

      {error && (
        <div role="alert" className="border-t border-border bg-danger-subtle px-4 py-2 text-xs text-danger">
          {error}
        </div>
      )}
      {gone && (
        <div className="border-t border-border px-4 py-2 text-xs text-fg-subtle">{gone}</div>
      )}
      {showChooser && state && (
        <div className="border-t border-border px-4 py-2 text-[11px] text-fg-subtle">
          Only the account you pick is shared with this agent. Tokens stay in your vault and never enter this chat.
        </div>
      )}
    </div>
  );
}
