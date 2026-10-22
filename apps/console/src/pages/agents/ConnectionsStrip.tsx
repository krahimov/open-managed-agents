import { useCallback, useEffect, useImperativeHandle, useState, type Ref } from "react";
import { CheckIcon } from "lucide-react";
import { useApi } from "../../lib/api";
import { ServiceIcon } from "../../components/ConnectionCard";

export interface AgentConnection {
  name: string;
  display_name: string;
  mcp_server_url: string;
  status: "connected" | "pending" | "broken";
  account?: string;
  workspace?: string;
}

export interface ConnectionsStripHandle {
  refresh: () => void;
}

/**
 * Setup page overview: every tool server the agent has picked up, and
 * whether it's connected (with which account). A pending one jumps to its
 * connect card in the chat.
 */
export function ConnectionsStrip({ agentId, ref }: { agentId: string; ref?: Ref<ConnectionsStripHandle> }) {
  const { api } = useApi();
  const [items, setItems] = useState<AgentConnection[] | null>(null);

  const refresh = useCallback(() => {
    api<{ data: AgentConnection[] }>(`/v1/connection-access/agent/${encodeURIComponent(agentId)}/status`, {
      silentErrors: true,
    })
      .then((r) => setItems(r.data))
      .catch(() => {
        /* the strip is a convenience; the cards still work */
      });
  }, [api, agentId]);

  useEffect(() => {
    refresh();
  }, [refresh]);
  useImperativeHandle(ref, () => ({ refresh }), [refresh]);

  if (!items || items.length === 0) return null;
  const pending = items.filter((i) => i.status !== "connected").length;

  const jumpTo = (url: string) => {
    const cards = document.querySelectorAll<HTMLElement>(`[data-connection-url="${CSS.escape(url)}"]`);
    const card = cards[cards.length - 1];
    if (!card) return;
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    card.classList.add("ring-2", "ring-brand");
    window.setTimeout(() => card.classList.remove("ring-2", "ring-brand"), 1600);
  };

  return (
    <div className="shrink-0 border-b border-border px-3 py-2.5" data-testid="connections-strip">
      <div className="mb-2 flex items-center justify-between text-xs">
        <span className="font-medium text-fg-muted">Connections</span>
        <span className={pending > 0 ? "text-warning" : "text-success"}>
          {pending > 0 ? `${pending} to connect` : "All connected"}
        </span>
      </div>
      <ul className="flex flex-wrap gap-2">
        {items.map((item) => {
          const connected = item.status === "connected";
          const who = [item.account, item.workspace].filter(Boolean).join(" · ");
          return (
            <li key={item.mcp_server_url}>
              <button
                type="button"
                onClick={() => jumpTo(item.mcp_server_url)}
                title={connected ? `${item.display_name} — ${who || "connected"}` : `Connect ${item.display_name}`}
                className="flex max-w-[260px] items-center gap-2 rounded-md border border-border bg-bg-surface px-2 py-1 text-left hover:border-border-strong"
              >
                <ServiceIcon service={item.name} url={item.mcp_server_url} className="size-5" />
                <span className="min-w-0">
                  <span className="block text-xs font-medium text-fg">{item.display_name}</span>
                  <span className={`block truncate text-[11px] ${connected ? "text-fg-subtle" : "text-warning"}`}>
                    {connected ? (
                      <span className="inline-flex items-center gap-1">
                        <CheckIcon className="size-3 text-success" aria-hidden />
                        {who || "Connected"}
                      </span>
                    ) : item.status === "broken" ? (
                      "Account changed — choose again"
                    ) : (
                      "Not connected"
                    )}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
