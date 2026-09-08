import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { useApi } from "../lib/api";
import type { Event } from "../lib/events";
import { AccessRequestCard } from "../components/AccessRequestCard";
import { Button } from "@/components/ui/button";

/** Reuses Orrery's authenticated provider flow. The Telegram URL contains no credential. */
export function TelegramConnect() {
  const { sessionId, requestId } = useParams();
  const { api } = useApi();
  const [event, setEvent] = useState<Event | null>(null);
  const [vaults, setVaults] = useState<Array<{ id: string; name: string }>>([]);
  const [selected, setSelected] = useState("");
  const [attached, setAttached] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let disposed = false;
    void Promise.all([
      api<{ event: Event; vault_ids: string[] }>(`/v1/telegram/conversations/${sessionId}/access/${requestId}`),
      api<{ data: Array<{ id: string; name: string; archived_at?: string | null }> }>("/v1/vaults?status=active&limit=100"),
    ]).then(([request, list]) => {
      if (disposed) return;
      const available = list.data.filter(v => !v.archived_at);
      setEvent(request.event);
      setVaults(available);
      setSelected(available.find(v => request.vault_ids.includes(v.id))?.id ?? available.find(v => v.name === "Connected Apps")?.id ?? available[0]?.id ?? "");
    }).catch(e => { if (!disposed) setError(e.message); });
    return () => { disposed = true; };
  }, [api, sessionId, requestId]);
  const chooseVault = async () => {
    setBusy(true); setError("");
    try {
      const id = selected || (await api<{ id: string }>("/v1/vaults", { method: "POST", body: JSON.stringify({ name: "Connected Apps" }) })).id;
      await api(`/v1/telegram/conversations/${sessionId}/vault`, { method: "POST", body: JSON.stringify({ vault_id: id }) });
      setAttached(id);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not select the vault."); }
    finally { setBusy(false); }
  };
  return <main className="mx-auto w-full max-w-2xl space-y-5 p-6">
    <h1 className="text-xl font-semibold">Connect your Telegram agent</h1>
    <p className="text-sm text-fg-subtle">Choose a vault, then authorize the app. Return to Telegram after connecting. Send /run when setup is ready to start work with the saved connections.</p>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    {!event && !error && <p>Loading connection request…</p>}
    {event && !attached && <div className="space-y-3 rounded-lg border border-border p-4">
      <label className="block text-sm" htmlFor="telegram-vault">Credential vault</label>
      {vaults.length > 0 && <select id="telegram-vault" className="w-full rounded border border-border bg-bg p-2" value={selected} onChange={e => setSelected(e.target.value)}>
        {vaults.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
      </select>}
      <p className="text-xs text-fg-subtle">This grants the agent access to the selected vault in future work sessions. Credentials stay in the vault.</p>
      <Button onClick={() => void chooseVault()} disabled={busy}>{busy ? "Saving…" : vaults.length ? "Use this vault" : "Create Connected Apps vault"}</Button>
    </div>}
    {event && attached && <AccessRequestCard event={event} sessionId={sessionId} vaultId={attached} />}
  </main>;
}
