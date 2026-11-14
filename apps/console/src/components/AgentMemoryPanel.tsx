import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { formatAbsolute, plural, toDate } from "@/lib/format";

import { ApiError, useApi } from "../lib/api";
import { EntityRef } from "./EntityRef";
import { RelativeTime } from "./RelativeTime";
import { SectionCard } from "./SectionCard";
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

export interface AgentMemoryPanelProps {
  agentId: string;
}

/**
 * Memory on the agent's page: whether this agent carries anything from one
 * session to the next, which store holds it, and a switch. Off means every
 * session, and every scheduled run, starts blank; the store is kept, so
 * turning it back on finds the same notes.
 *
 * Reads `GET /v1/agents/:id/memory`; the switch writes
 * `PUT /v1/agents/:id/memory { enabled }`, which saves a new agent version,
 * so the agent and its versions are read again after a change.
 *
 * A placeholder under its heading while loading. Nothing at all on a server
 * without the endpoint (404, or the web page a server without it answers
 * with), so the page is unchanged there.
 */
export function AgentMemoryPanel({ agentId }: AgentMemoryPanelProps) {
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
    mutationFn: (enabled) =>
      api<AgentMemoryResponse>(path, { method: "PUT", body: JSON.stringify({ enabled }), silentErrors: true }),
    onSuccess: (result) => {
      qc.setQueryData([path, {}], result);
      // The switch saves a new agent version.
      void qc.invalidateQueries({ queryKey: [`/v1/agents/${agentId}`] });
      void qc.invalidateQueries({ queryKey: [`/v1/agents/${agentId}/versions`] });
    },
  });

  if (status.isPending) {
    return (
      <SectionCard title="Memory" actions={<Skeleton className="h-[22px] w-[38px]" rounded="full" />}>
        <div role="status" aria-label="Loading memory" aria-busy="true" className="space-y-2">
          <Skeleton className="h-3.5 w-4/5" rounded="sm" />
          <Skeleton className="h-3.5 w-3/5" rounded="sm" />
        </div>
      </SectionCard>
    );
  }

  if (status.error) {
    // Not on this server: say nothing, the page is as it was.
    if (status.error instanceof ApiError && (status.error.status === 404 || status.error.status === 501)) return null;
    return (
      <SectionCard title="Memory">
        <p className="text-small text-fg-muted">Whether this agent remembers could not be loaded.</p>
        <Button variant="outline" size="sm" className="mt-3" onClick={() => void status.refetch()}>
          Try again
        </Button>
      </SectionCard>
    );
  }

  const memory = status.data;
  const on = memory.enabled;
  const store = memory.store;
  const notes = store?.note_count;
  const lastWritten = toDate(store?.last_written_at ?? null);

  return (
    <SectionCard
      title="Memory"
      actions={
        <span className="flex items-center gap-2">
          <span aria-live="polite" className="text-xs text-fg-subtle">
            {toggle.isPending ? "Saving…" : on ? "On" : "Off"}
          </span>
          <Switch
            checked={on}
            aria-label="Agent memory"
            disabled={toggle.isPending}
            onCheckedChange={(next) => toggle.mutate(next)}
          />
        </span>
      }
    >
      {on ? (
        <div className="space-y-2.5 text-small">
          {store ? (
            <div className="flex min-w-0 items-center gap-1.5 text-fg-muted">
              <span className="shrink-0">Kept in</span>
              <EntityRef kind="memory_store" id={store.id} name={store.name} />
            </div>
          ) : (
            <p className="text-fg-muted">
              {memory.mode === "per_user"
                ? "Each person gets their own store, made the first time they talk to the agent."
                : "The store is made when the next session starts."}
            </p>
          )}
          {store && notes !== undefined && (
            <p className="text-fg">
              {notes === 0 ? (
                "Nothing saved yet"
              ) : (
                <>
                  {plural(notes, "file")}
                  {lastWritten && (
                    <span className="text-fg-muted" title={formatAbsolute(lastWritten)}>
                      {" "}
                      · last written <RelativeTime value={lastWritten} />
                    </span>
                  )}
                </>
              )}
            </p>
          )}
          <p className="text-xs text-fg-subtle">
            Applies to new sessions, scheduled runs included. Sessions already open keep what they started with.
          </p>
        </div>
      ) : (
        <p className="text-small text-fg-muted">
          Every session starts blank: this agent does not remember earlier sessions or scheduled runs.
          {store && (
            <>
              {" "}
              Its earlier notes are kept in <EntityRef kind="memory_store" id={store.id} name={store.name} avatar={false} />{" "}
              and come back if memory is turned on again.
            </>
          )}
        </p>
      )}
      {toggle.error && (
        <p role="alert" className="mt-2.5 text-small text-danger">
          Memory could not be changed. {toggle.error.message}
        </p>
      )}
    </SectionCard>
  );
}
