import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { useApi } from "../lib/api";
import { Skeleton } from "./Skeleton";

/** GET/PUT /v1/agents/:id/memory (main-node). */
export interface AgentMemoryResponse {
  enabled: boolean;
  mode: "off" | "shared" | "per_user";
  explicit_off: boolean;
  store: {
    id: string;
    name: string;
    note_count?: number;
    last_written_at?: string | null;
  } | null;
}

/**
 * Memory — whether this agent carries anything from one session to the
 * next, which store holds it, and a switch. Off means every session (and
 * every scheduled run) starts blank.
 *
 * Shows a placeholder under its heading while loading. Renders nothing on
 * runtimes without the endpoint (404), so the agent page is unchanged there.
 */
export function AgentMemoryPanel({ agentId }: { agentId: string }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const path = `/v1/agents/${agentId}/memory`;
  const status = useQuery<AgentMemoryResponse>({
    queryKey: [path, {}],
    queryFn: ({ signal }) => api<AgentMemoryResponse>(path, { signal, silentErrors: true }),
    staleTime: 0,
    retry: false,
  });
  const toggle = useMutation<AgentMemoryResponse, Error, boolean>({
    mutationFn: (enabled) => api<AgentMemoryResponse>(path, { method: "PUT", body: JSON.stringify({ enabled }) }),
    onSuccess: (result) => {
      qc.setQueryData([path, {}], result);
      // The switch bumps the agent's version.
      void qc.invalidateQueries({ queryKey: [`/v1/agents/${agentId}`] });
      void qc.invalidateQueries({ queryKey: [`/v1/agents/${agentId}/versions`] });
    },
  });

  const memory = status.data;
  if (status.isPending) {
    return (
      <section aria-labelledby="agent-memory-heading" aria-busy="true" className="mt-6 max-w-2xl">
        <div className="flex items-center justify-between gap-3 mb-2">
          <h2 id="agent-memory-heading" className="font-display text-base font-semibold">
            Memory
          </h2>
          <Skeleton className="h-5 w-9" rounded="full" />
        </div>
        <div role="status" aria-label="Loading memory" className="border border-border rounded-lg px-4 py-3 space-y-2">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      </section>
    );
  }
  if (!memory) return null;

  const on = memory.enabled;
  const store = memory.store;
  const notes = store?.note_count;

  return (
    <section aria-labelledby="agent-memory-heading" className="mt-6 max-w-2xl">
      <div className="flex items-center justify-between gap-3 mb-2">
        <h2 id="agent-memory-heading" className="font-display text-base font-semibold">
          Memory
        </h2>
        <label className="flex items-center gap-2 cursor-pointer">
          <span className={`text-xs ${on ? "text-fg" : "text-fg-subtle"}`} aria-live="polite">
            {toggle.isPending ? "Saving…" : on ? "On" : "Off"}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-label="Agent memory"
            disabled={toggle.isPending}
            onClick={() => toggle.mutate(!on)}
            className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] focus-visible:ring-2 focus-visible:ring-brand focus-visible:outline-none disabled:opacity-60 ${
              on ? "bg-brand" : "bg-bg-surface border border-border"
            }`}
          >
            <span
              className={`inline-block h-3.5 w-3.5 transform rounded-full bg-bg shadow transition-transform ${
                on ? "translate-x-5" : "translate-x-0.5"
              }`}
            />
          </button>
        </label>
      </div>
      <div className="border border-border rounded-lg px-4 py-3 text-sm">
        {on ? (
          <dl className="grid grid-cols-[100px_1fr] gap-x-3 gap-y-1.5">
            <dt className="text-fg-muted">Store</dt>
            <dd className="min-w-0">
              {store ? (
                <Link to={`/memory/${store.id}`} className="font-mono text-xs hover:underline break-all">
                  {store.name}
                </Link>
              ) : memory.mode === "per_user" ? (
                <span className="text-fg-subtle">One store per user, created on their first session</span>
              ) : (
                <span className="text-fg-subtle">Created on the next session</span>
              )}
            </dd>
            {store && notes !== undefined && (
              <>
                <dt className="text-fg-muted">Notes</dt>
                <dd>
                  {notes === 0
                    ? "Nothing saved yet"
                    : `${notes} file${notes === 1 ? "" : "s"}${
                        store.last_written_at
                          ? ` · last written ${new Date(store.last_written_at).toLocaleString()}`
                          : ""
                      }`}
                </dd>
              </>
            )}
            <dt className="text-fg-muted">Applies to</dt>
            <dd className="text-fg-muted">New sessions, scheduled runs included. Sessions already open keep what they started with.</dd>
          </dl>
        ) : (
          <p className="text-fg-subtle">
            Every session starts blank — this agent doesn't remember earlier sessions or scheduled runs.
            {store && (
              <>
                {" "}
                Its earlier notes are kept in{" "}
                <Link to={`/memory/${store.id}`} className="font-mono text-xs hover:underline">
                  {store.name}
                </Link>{" "}
                and come back if you turn memory on.
              </>
            )}
          </p>
        )}
        {toggle.error && (
          <p role="alert" className="mt-2 text-sm text-danger">
            Could not change memory. {toggle.error.message}
          </p>
        )}
      </div>
    </section>
  );
}
