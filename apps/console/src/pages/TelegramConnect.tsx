import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { Button } from "@/components/ui/button";
import { loadTelegramMiniApp, type TelegramMiniApp } from "../lib/telegram-mini-app";

type View = { service: string; reason?: string; vaults: Array<{ id: string; name: string }>; vault_ids: string[] };
type Flow = { url: string; flow_id: string };

/** Telegram proves the linked identity; the provider still asks for consent. */
export function TelegramConnect() {
  const { sessionId, requestId } = useParams();
  const [app, setApp] = useState<TelegramMiniApp>();
  const [view, setView] = useState<View>();
  const [selected, setSelected] = useState("");
  const [flow, setFlow] = useState<Flow>();
  const [opened, setOpened] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const base = `/integrations/telegram/connect/${encodeURIComponent(sessionId ?? "")}/${encodeURIComponent(requestId ?? "")}`;

  async function request<T>(telegram: TelegramMiniApp, action: string, body = {}): Promise<T> {
    const response = await fetch(`${base}/${action}`, {
      method: "POST", credentials: "omit", cache: "no-store",
      headers: { "content-type": "application/json", "x-telegram-init-data": telegram.initData },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Connection failed. Please try again.");
    return result as T;
  }

  useEffect(() => {
    let disposed = false;
    setView(undefined); setFlow(undefined); setConnected(false); setOpened(false); setError("");
    void loadTelegramMiniApp().then(async telegram => {
      telegram.ready();
      if (!telegram.initData) throw new Error("Open this page using a fresh Connect button in your linked Telegram chat. Send /connect followed by the app name to get one.");
      const result = await request<View>(telegram, "view");
      if (disposed) return;
      setApp(telegram); setView(result);
      setSelected(result.vaults.find(v => result.vault_ids.includes(v.id))?.id ?? result.vaults.find(v => v.name === "Connected Apps")?.id ?? result.vaults[0]?.id ?? "");
    }).catch(e => { if (!disposed) setError(e.message); });
    return () => { disposed = true; };
  }, [base]);

  const authorize = async () => {
    if (!app) return;
    setBusy(true); setError("");
    try {
      const result = await request<Flow>(app, "authorize", { vault_id: selected || undefined });
      if (new URL(result.url).protocol !== "https:") throw new Error("The provider returned an invalid authorization link.");
      setFlow(result);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not start authorization."); }
    finally { setBusy(false); }
  };
  const complete = async () => {
    if (!app || !flow) return;
    setBusy(true); setError("");
    try {
      await request(app, "complete", { flow_id: flow.flow_id });
      setConnected(true);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not verify authorization."); }
    finally { setBusy(false); }
  };
  return <main className="mx-auto w-full max-w-2xl space-y-5 p-6">
    <h1 className="text-xl font-semibold">{view ? `Connect ${view.service}` : "Connect your Telegram agent"}</h1>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    {!view && !error && <p>Verifying your Telegram account…</p>}
    {view && !connected && <>
      <p className="text-sm text-fg-subtle">{view.reason || "Authorize the app, then return here to finish connecting your agent."}</p>
      {!flow ? <div className="space-y-3 rounded-lg border border-border p-4">
        {view.vaults.length > 0 && <>
          <label className="block text-sm" htmlFor="telegram-vault">Credential vault</label>
          <select id="telegram-vault" className="w-full rounded border border-border bg-bg p-2" value={selected} onChange={e => setSelected(e.target.value)}>
            {view.vaults.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </>}
        <p className="text-sm text-fg-subtle">{view.vaults.length ? "This gives your agent access to the selected vault in future work sessions." : "A Connected Apps vault will store this connection for your agent."} Credentials stay out of Telegram.</p>
        <Button onClick={() => void authorize()} disabled={busy}>{busy ? "Preparing…" : "Continue to authorization"}</Button>
      </div> : <div className="space-y-3">
        <p>Open the provider, complete its consent screen, then return to this page.</p>
        <Button onClick={() => { app!.openLink(flow.url); setOpened(true); }}>{opened ? "Reopen provider" : `Authorize ${view.service}`}</Button>
        {opened && <Button onClick={() => void complete()} disabled={busy}>{busy ? "Checking…" : "I've authorized the app"}</Button>}
      </div>}
    </>}
    {connected && <p role="status">Connected. Return to Telegram to continue setup. Send /run when you are ready to start work.</p>}
  </main>;
}
