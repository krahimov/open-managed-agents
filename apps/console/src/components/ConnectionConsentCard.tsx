import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router";
import { useApi } from "../lib/api";
import { Button } from "./ui/button";
import { OAuthAppSetupPanel, type OAuthAppRequirement } from "./OAuthAppSetupPanel";

interface Connection {
  credential_id: string;
  vault_id: string;
  label: string;
  vault_name?: string;
}
interface Verification {
  credential_id?: string;
  status: "verified" | "unverified";
  verification_id?: string;
  account?: string;
  workspace?: string;
  workspace_id?: string;
  message?: string;
}
export interface ConnectionRequest {
  request_id: string;
  service: string;
  reason?: string;
  mcp_server_url: string;
  auth_kind?: string;
  oauth_app?: OAuthAppRequirement;
}

export function ConnectionConsentCard({ request, sessionId: explicitSessionId, granted = false }: {
  request: ConnectionRequest;
  sessionId?: string;
  granted?: boolean;
}) {
  const { api } = useApi();
  const { id } = useParams();
  const sessionId = explicitSessionId ?? id;
  const base = `/v1/connection-access/${encodeURIComponent(sessionId ?? "")}/${encodeURIComponent(request.request_id)}`;
  const [connections, setConnections] = useState<Connection[]>([]);
  const [verification, setVerification] = useState<Verification | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newConnection, setNewConnection] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [appReq, setAppReq] = useState(request.oauth_app);
  const refresh = useCallback(async () => {
    const result = await api<{ connections: Connection[]; approved: boolean }>(base);
    setConnections(result.connections);
    setConnected(result.approved === true);
  }, [api, base]);
  useEffect(() => { void refresh().catch(() => setError("Saved connections could not be loaded. Retry before selecting one.")); }, [refresh]);
  useEffect(() => { if (granted) void refresh().catch(() => {}); }, [granted, refresh]);

  const verify = useCallback(async (connection: Pick<Connection, "credential_id" | "vault_id">) => {
    setBusy(true); setError(null); setVerification(null); setConfirmed(false);
    try {
      const result = await api<Verification>(`${base}/verify`, { method: "POST", body: JSON.stringify(connection) });
      setVerification({ ...result, credential_id: connection.credential_id });
    } catch {
      setError("Verification failed. No access was granted. Please retry.");
    } finally { setBusy(false); }
  }, [api, base]);

  useEffect(() => {
    if (!connecting) return;
    const handle = (event: MessageEvent) => {
      if (event.origin && event.origin !== window.location.origin) return;
      const data = event.data;
      // A different popup, or a legacy callback without a request identity,
      // cannot complete this card. Provider completion alone is not a grant.
      if (data?.request_id !== request.request_id || data?.session_id !== sessionId) return;
      if (data.type === "oauth_complete" && typeof data.credential_id === "string" && typeof data.vault_id === "string") {
        setConnecting(false);
        void refresh().catch(() => {});
        void verify({ credential_id: data.credential_id, vault_id: data.vault_id });
      } else if (data.type === "oauth_error") {
        setConnecting(false);
        if (data.code === "oauth_app_required" && data.provider) setAppReq(data.provider);
        setError("Sign-in did not complete. No access was granted.");
      }
    };
    window.addEventListener("message", handle);
    let channel: BroadcastChannel | undefined;
    try { channel = new BroadcastChannel("openma-oauth"); channel.addEventListener("message", handle); } catch { /* postMessage remains available */ }
    return () => { window.removeEventListener("message", handle); channel?.close(); };
  }, [connecting, request.request_id, sessionId, refresh, verify]);

  const createVault = () => api<{ id: string }>("/v1/vaults", {
    method: "POST", body: JSON.stringify({ name: `${request.service} connection` }),
  });
  const connectAnother = async () => {
    setError(null); setVerification(null); setConfirmed(false); setNewConnection(true);
    if (request.auth_kind === "mcp_api_key" || (appReq?.required && !appReq.configured)) return;
    // Open during the click, before awaiting network requests.
    const popup = window.open("", `oauth-${request.request_id}`, "width=600,height=700,popup=yes");
    if (!popup) { setError("Allow the sign-in popup, then try again."); return; }
    setConnecting(true);
    try {
      // A new account must never overwrite a credential another agent uses.
      const vault = await createVault();
      const params = new URLSearchParams({ mcp_server_url: request.mcp_server_url, vault_id: vault.id,
        redirect_uri: window.location.href, service: request.service, session_id: sessionId!, request_id: request.request_id });
      popup.location.href = `/v1/oauth/authorize?${params}`;
    } catch {
      popup.close(); setConnecting(false); setError("Could not start sign-in. Please retry.");
    }
  };
  const saveKey = async () => {
    setBusy(true); setError(null);
    try {
      const vault = await createVault();
      const credential = await api<{ id: string }>(`/v1/vaults/${vault.id}/credentials`, {
        method: "POST", body: JSON.stringify({ display_name: `${request.service} API key`,
          auth: { type: "static_bearer", token: apiKey.trim(), mcp_server_url: request.mcp_server_url } }),
      });
      setApiKey(""); await refresh();
      await verify({ credential_id: credential.id, vault_id: vault.id });
    } catch { setError("Could not save or verify this connection. No access was granted."); }
    finally { setBusy(false); }
  };
  const approve = async () => {
    if (!confirmed || !verification?.verification_id) return;
    setBusy(true); setError(null);
    try {
      await api(`${base}/approve`, { method: "POST", body: JSON.stringify({
        verification_id: verification.verification_id, confirmed: true, workspace_id: verification.workspace_id,
      }) });
      setConnected(true);
    } catch { setError("Approval failed. Verify the connection again before retrying."); }
    finally { setBusy(false); }
  };

  return <div className="max-w-2xl border border-border rounded-lg bg-bg-surface px-4 py-3 space-y-3">
    <div className="text-sm font-medium">Connect {request.service}</div>
    {request.reason && <p className="text-xs text-fg-subtle">{request.reason}</p>}
    {connected ? <p className="text-sm text-success">Access approved for this agent</p> : <>
      <p className="text-xs text-fg-subtle">Choose the account this agent may use. Saved connections are not shared with it until you approve.</p>
      {connections.map(connection => <div key={connection.credential_id} className="border border-border rounded p-3 space-y-1">
        <p className="text-sm">{connection.label}</p>
        <p className="text-xs text-fg-subtle">{connection.vault_name} · {verification?.credential_id === connection.credential_id && verification.status === "verified" ? "Verified — awaiting your approval" : "Account/workspace unverified"}</p>
        <Button variant="outline" size="sm" disabled={busy || connecting} onClick={() => void verify({ credential_id: connection.credential_id, vault_id: connection.vault_id })}>Verify connection</Button>
      </div>)}
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void connectAnother()}>{connecting ? "Restart sign-in" : "Connect another"}</Button>
      {newConnection && request.auth_kind === "mcp_api_key" && <form className="flex gap-2" onSubmit={e => { e.preventDefault(); void saveKey(); }}>
        <input aria-label="API key" type="password" autoComplete="off" value={apiKey} onChange={e => setApiKey(e.target.value)} className="border rounded px-2 text-sm" />
        <Button size="sm" disabled={busy || !apiKey.trim()}>Save and verify</Button>
      </form>}
      {newConnection && appReq?.required && !appReq.configured && <OAuthAppSetupPanel requirement={appReq} saving={busy} onSave={async (clientId, clientSecret) => {
        setBusy(true); setError(null);
        try {
          await api("/v1/oauth/apps", { method: "PUT", body: JSON.stringify({ issuer: appReq.issuer, client_id: clientId, client_secret: clientSecret }) });
          setAppReq({ ...appReq, configured: true });
        } catch { setError("Could not save the app configuration."); } finally { setBusy(false); }
      }} />}
      {busy && <p className="text-xs">Checking connection…</p>}
      {verification && <div className="border border-border rounded p-3 space-y-2">
        <p className="text-sm font-medium">{verification.status === "verified" ? "Service access verified" : "Unverified"}</p>
        {verification.account && <p className="text-sm">Account: {verification.account}</p>}
        {verification.workspace && <p className="text-sm">Workspace: {verification.workspace}</p>}
        {verification.message && <p className="text-xs text-fg-subtle">{verification.message}</p>}
        {verification.status === "verified" && <>
          <label className="flex gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />This is the connection and workspace I want this agent to use.</label>
          <Button size="sm" disabled={!confirmed || busy} onClick={() => void approve()}>Reuse this connection</Button>
        </>}
      </div>}
    </>}
    {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    <p className="text-[11px] text-fg-subtle">Only the selected connection is approved. Other credentials in its vault remain unavailable. Tokens never enter this conversation.</p>
  </div>;
}
