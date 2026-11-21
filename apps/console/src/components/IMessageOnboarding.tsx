import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MessageCircleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useApi } from "../lib/api";
import { withReason } from "../lib/failure-text";
import { standaloneLink, quietLink } from "../lib/links";

type Connection = { connected: boolean; number?: string; code?: string; url?: string };
export function IMessageOnboarding() {
  const { api } = useApi();
  const [connection, setConnection] = useState<Connection>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const status = useQuery({
    queryKey: ["imessage", "status"],
    queryFn: ({ signal }) => api<{ enabled: boolean; connected: boolean }>("/v1/imessage/status", { signal, silentErrors: true }).catch(() => null),
    staleTime: 0, refetchOnWindowFocus: "always", retry: false,
  });
  if (!status.data?.enabled || status.data.connected) return null;
  const connect = async () => {
    setBusy(true); setError(undefined);
    try {
      const result = await api<Connection>("/v1/imessage/connect", { method: "POST", body: "{}", silentErrors: true });
      setConnection(result);
      if (result.connected) await status.refetch();
    } catch (e) { setError(withReason("Could not connect iMessage", e)); }
    finally { setBusy(false); }
  };
  return <aside aria-label="iMessage" className="relative flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-bg-soft px-4 py-2.5 lg:px-5">
    <div className="flex min-w-0 flex-1 basis-72 items-start gap-3">
      <span className="mt-px flex size-7 shrink-0 items-center justify-center rounded-full bg-bg-surface text-fg-muted"><MessageCircleIcon className="size-3.5" aria-hidden="true" /></span>
      <div className="min-w-0 text-small">
        <p className="font-medium text-fg">Your agents can meet you in iMessage</p>
        {connection?.code ? <>
          <p className="text-fg-muted">Text <strong>{connection.number}</strong> from your iPhone with this code. It expires in 10 minutes.</p>
          <p className="select-all break-all font-mono">{connection.code}</p>
        </> : <p className="text-fg-muted">Connect once, then work with your cloud agent from Messages.</p>}
        {error && <p role="alert" className="mt-0.5 text-danger">{error}</p>}
      </div>
    </div>
    <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1.5 pl-10 sm:pl-0">
      {connection?.url && <>
        <a className={standaloneLink} href={connection.url}>Open Messages</a>
        <button type="button" className={quietLink} onClick={() => void status.refetch()}>I’ve connected</button>
      </>}
      <Button size="sm" variant="outline" loading={busy} onClick={() => void connect()}>{connection?.url ? "Get a new code" : "Continue in iMessage"}</Button>
    </div>
  </aside>;
}
