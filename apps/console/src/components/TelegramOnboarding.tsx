import { useCallback, useEffect, useState } from "react";
import { useApi } from "../lib/api";
import { Send } from "lucide-react";

/** Hidden unless the deployment has connected its Telegram bot. */
export function TelegramOnboarding() {
  const { api } = useApi();
  const [status, setStatus] = useState<{
    enabled: boolean;
    connected: boolean;
  } | null>(null);
  const refresh = useCallback(async () => {
    try {
      setStatus(await api("/v1/telegram/status", { silentErrors: true }));
    } catch {
      setStatus(null);
    }
  }, [api]);
  useEffect(() => {
    void refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!status?.enabled || status.connected) return null;
  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ url?: string; connected: boolean }>(
        "/v1/telegram/connect",
        { method: "POST", body: "{}" },
      );
      if (result.url) setLink(result.url);
      if (result.connected) await refresh();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Couldn't connect Telegram. Please retry.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <aside
      className="shrink-0 border-b border-border bg-bg-surface px-4 py-3 flex flex-wrap items-center gap-3"
      aria-label="Telegram onboarding"
    >
      <Send size={18} className="text-brand" />
      <div className="flex-1 min-w-48">
        <p className="text-sm font-medium">
          Your agent can meet you in Telegram
        </p>
        <p className="text-xs text-fg-muted">
          Connect once, then create agents and get work done from chat.
        </p>
        {error && (
          <p role="alert" className="text-xs text-red-600">
            {error}
          </p>
        )}
      </div>
      {link ? (
        <>
          <a
            className="text-sm font-medium text-brand underline"
            href={link}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open Telegram and press Start
          </a>
          <button
            className="text-xs text-fg-muted underline"
            onClick={() => void refresh()}
          >
            I’ve connected
          </button>
          <button
            className="text-xs text-fg-muted underline"
            disabled={busy}
            onClick={() => void connect()}
          >
            Refresh link
          </button>
        </>
      ) : (
        <button
          className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-brand-subtle disabled:opacity-50"
          disabled={busy}
          onClick={() => void connect()}
        >
          {busy ? "Preparing…" : "Continue in Telegram"}
        </button>
      )}
    </aside>
  );
}
