import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { ArchiveIcon, CopyIcon, LayoutGridIcon, MessageSquarePlusIcon, Rows3Icon, Trash2Icon } from "lucide-react";

import { useApi } from "../lib/api";
import { GALLERY_GRID, agentCapabilities } from "../lib/agents";
import { copyText } from "../lib/clipboard";
import { useAgentActivityNow } from "../components/sessions/readings";
import { countWords, plural } from "../lib/format";
import { startSession } from "../lib/shell-events";
import { useInfiniteApiQuery } from "../lib/useApiQuery";
import { AgentAvatar } from "../components/AgentAvatar";
import { AgentCard } from "../components/AgentCard";
import { Chip, StatusBadge } from "../components/Badge";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { DataTable, RowLink, type ColumnDef } from "../components/DataTable";
import { FacetedFilter } from "../components/FacetedFilter";
import { FilterChip, CreatedFilterChip } from "../components/FilterChip";
import { ModelBadge } from "../components/ModelBadge";
import { RelativeTime } from "../components/RelativeTime";
import { RowActionsMenu, type RowAction } from "../components/RowActionsMenu";
import { SegmentedControl } from "../components/SegmentedControl";
import { Button } from "@/components/ui/button";
import { PopoverContent } from "@/components/ui/popover";
import type { ModelCard } from "@open-managed-agents/api-types";
import type { AgentRecord as Agent } from "../types/agent";
import { AgentFormDialog } from "./agents/AgentFormDialog";

type Runtime = {
  id: string;
  hostname: string;
  status: string;
  agents: Array<{ id: string }>;
  /** Skills daemon detected locally on the user's machine, keyed by acp
   *  agent id. Source for the blocklist multi-select that appears when
   *  the user picks an acp agent. */
  local_skills?: Record<
    string,
    Array<{
      id: string;
      name?: string;
      description?: string;
      source?: string;
      source_label?: string;
    }>
  >;
};
type RuntimesResponse = { runtimes?: Runtime[]; data?: Runtime[] };

type StatusValue = "any" | "active" | "archived";
type ViewValue = "grid" | "list";

const STATUS_OPTIONS: { value: StatusValue; label: string }[] = [
  { value: "any", label: "All" },
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
];

const VIEW_KEY = "muse:agents:view";

function readView(): ViewValue {
  try {
    return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
}

/**
 * Agents — the gallery. Each agent is a profile card (who it is, what it
 * can do, how busy it is); the List view shows the same agents as a table
 * for scanning many at once. Search and filters are server-side.
 */
export function AgentsList() {
  const { api } = useApi();
  const [params, setParams] = useSearchParams();
  const [allAgents, setAllAgents] = useState<Agent[]>([]);
  const [customSkills, setCustomSkills] = useState<
    Array<{ id: string; name: string; description: string }>
  >([]);
  const [modelCards, setModelCards] = useState<ModelCard[]>([]);
  const [runtimes, setRuntimes] = useState<Runtime[]>([]);
  const [, setAuxLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(params.get("create") === "1");
  useEffect(() => {
    if (params.get("create") === "1") {
      setShowCreate(true);
      const next = new URLSearchParams(params); next.delete("create"); setParams(next, { replace: true });
    }
  }, [params, setParams]);

  const [view, setViewState] = useState<ViewValue>(readView);
  const setView = (v: ViewValue) => {
    setViewState(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // storage unavailable — the choice just will not persist
    }
  };

  // Server-driven filter state. Each piece flows into agentsParams below
  // → useInfiniteApiQuery resets to page 1 on params change → the list
  // reflects exactly what the server returned (no client-side faking).
  const [status, setStatus] = useState<StatusValue>("active");
  const [created, setCreated] = useState<{ after?: number; before?: number }>({});
  const [search, setSearch] = useState("");

  const agentsParams = useMemo(
    () => ({
      status,
      ...(created.after !== undefined
        ? { created_after: new Date(created.after).toISOString() }
        : {}),
      ...(created.before !== undefined
        ? { created_before: new Date(created.before).toISOString() }
        : {}),
      ...(search ? { q: search } : {}),
    }),
    [status, created.after, created.before, search],
  );
  const {
    items: agents,
    isLoading: loading,
    hasMore,
    isLoadingMore,
    loadMore,
    refresh: refreshAgents,
    error: loadError,
  } = useInfiniteApiQuery<Agent>("/v1/agents", { limit: 20, params: agentsParams });

  // Sessions per agent, running count and last activity (shared cache).
  const { byAgent } = useAgentActivityNow();

  // Aux fetches for the create dialog — refreshed on mount and after agent
  // CRUD. Failures of the secondary fetches (skills / model cards /
  // runtimes) are tolerated and logged: missing data degrades a dropdown
  // but should not block agent CRUD.
  const loadAux = async () => {
    setAuxLoading(true);
    try {
      // The list's own read says when agents cannot be loaded; this one is
      // only for the form's lookups, so it fails quietly (no second notice,
      // no uncaught rejection).
      const all = await api<{ data: Agent[] }>("/v1/agents?limit=200&status=any", { silentErrors: true }).catch((e) => {
        console.warn("[AgentsList] /v1/agents aux fetch failed", e);
        return null;
      });
      if (all) setAllAgents(all.data);
      await Promise.allSettled([
        (async () => {
          const sk = await api<{
            data: Array<{ id: string; name: string; description: string }>;
          }>("/v1/skills");
          setCustomSkills(sk.data);
        })().catch((e) => console.warn("[AgentsList] /v1/skills aux fetch failed", e)),
        (async () => {
          const mc = await api<{ data: ModelCard[] }>("/v1/model_cards?limit=200");
          setModelCards(mc.data);
        })().catch((e) => console.warn("[AgentsList] /v1/model_cards aux fetch failed", e)),
        (async () => {
          const rt = await api<RuntimesResponse>("/v1/runtimes");
          const rows = Array.isArray(rt.runtimes)
            ? rt.runtimes
            : Array.isArray(rt.data)
              ? rt.data
              : [];
          setRuntimes(rows);
        })().catch((e) => console.warn("[AgentsList] /v1/runtimes aux fetch failed", e)),
      ]);
    } finally {
      setAuxLoading(false);
    }
  };

  useEffect(() => {
    loadAux();
  }, []);

  // Destructive actions go through a designed confirmation.
  const [confirm, setConfirm] = useState<{ kind: "archive" | "delete"; agent: Agent } | null>(null);

  const actionsFor = (a: Agent): RowAction[] => {
    const archived = !!a.archived_at;
    return [
      {
        label: "Start session",
        icon: <MessageSquarePlusIcon />,
        disabled: archived,
        onSelect: () => startSession({ agentId: a.id }),
      },
      {
        label: "Copy agent id",
        icon: <CopyIcon />,
        onSelect: () => void copyText(a.id),
      },
      {
        label: "Archive",
        icon: <ArchiveIcon />,
        disabled: archived,
        onSelect: () => setConfirm({ kind: "archive", agent: a }),
      },
      {
        label: "Delete",
        icon: <Trash2Icon />,
        destructive: true,
        onSelect: () => setConfirm({ kind: "delete", agent: a }),
      },
    ];
  };

  // Table columns for the List view. The first column is the identity
  // cell; the id never leads (it is one click away in the row menu).
  const columns = useMemo<ColumnDef<Agent>[]>(
    () => [
      {
        id: "name",
        accessorKey: "name",
        header: "Agent",
        size: 380,
        enableHiding: false,
        cell: ({ row }) => {
          const a = row.original;
          return (
            <div className="flex min-w-0 items-center gap-3">
              <AgentAvatar name={a.name} id={a.id} size="md" archived={!!a.archived_at} />
              <div className="min-w-0">
                {/* The name is the row's link (click, ⌘-click, Tab + Enter). */}
                <div className="flex min-w-0">
                  <RowLink className="font-medium text-fg">{a.name}</RowLink>
                </div>
                <div className="truncate text-xs text-fg-subtle" title={a.description || undefined}>
                  {a.description?.trim() || "No description"}
                </div>
              </div>
            </div>
          );
        },
      },
      {
        id: "model",
        accessorFn: (a) => (typeof a.model === "string" ? a.model : a.model?.id || ""),
        header: "Model",
        size: 165,
        cell: ({ row }) => <ModelBadge model={row.original.model} variant="plain" />,
      },
      {
        id: "capabilities",
        header: "Capabilities",
        size: 230,
        cell: ({ row }) => {
          const caps = agentCapabilities(row.original);
          if (caps.length === 0) return <span className="text-fg-subtle">None</span>;
          return (
            <div className="flex h-[22px] flex-wrap items-center gap-x-1.5 gap-y-2 overflow-hidden">
              {caps.slice(0, 2).map((c) => (
                <Chip key={c.key} icon={c.icon} title={c.title}>
                  {c.label}
                </Chip>
              ))}
              {caps.length > 2 && (
                <Chip title={caps.slice(2).map((c) => c.title).join(" · ")}>+{caps.length - 2}</Chip>
              )}
            </div>
          );
        },
      },
      {
        id: "activity",
        header: "Activity",
        size: 150,
        cell: ({ row }) => {
          const act = byAgent.get(row.original.id);
          if (!act || act.sessions === 0) return <span className="text-fg-subtle">No sessions yet</span>;
          return (
            <div className="min-w-0 leading-tight">
              <div className="truncate text-fg">{plural(act.sessions, "session")}</div>
              <div className="truncate text-xs text-fg-subtle">
                active <RelativeTime value={act.lastActiveAt} />
              </div>
            </div>
          );
        },
      },
      {
        id: "status",
        accessorFn: (a) => (a.archived_at ? "archived" : "active"),
        header: "Status",
        size: 130,
        cell: ({ row }) => {
          const a = row.original;
          const running = (byAgent.get(a.id)?.running ?? 0) > 0;
          return <StatusBadge status={a.archived_at ? "archived" : running ? "running" : "active"} />;
        },
      },
      {
        id: "created",
        accessorFn: (a) => a.created_at,
        header: "Created",
        size: 120,
        cell: ({ row }) => <RelativeTime value={row.original.created_at} className="text-fg-muted" />,
      },
      {
        id: "actions",
        header: "",
        size: 56,
        enableHiding: false,
        cell: ({ row }) => <RowActionsMenu label={`Actions for ${row.original.name}`} actions={actionsFor(row.original)} />,
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [byAgent],
  );

  const statusDisplay =
    status === "any" ? undefined : STATUS_OPTIONS.find((o) => o.value === status)?.label;
  const filtered = !!search || created.after !== undefined || created.before !== undefined;

  const filters = (
    <>
      <FilterChip
        label="Status"
        active={status !== "any"}
        display={statusDisplay}
        onClear={() => setStatus("any")}
      >
        <PopoverContent align="start" sideOffset={6} collisionPadding={8} className="w-52 gap-0 p-0">
          <FacetedFilter
            options={STATUS_OPTIONS}
            value={status}
            onValueChange={(v) => setStatus(v as StatusValue)}
            searchPlaceholder="Status"
          />
        </PopoverContent>
      </FilterChip>

      <CreatedFilterChip value={created} onChange={setCreated} />
    </>
  );

  return (
    <DataTable<Agent>
      error={loadError}
      onRetry={refreshAgents}
      title="Agents"
      subtitle="Everyone on the team. Open an agent to see how it is set up, or start a session with it."
      createLabel="+ New agent"
      onCreate={() => setShowCreate(true)}
      searchPlaceholder="Search agents"
      searchValue={search}
      onSearchChange={setSearch}
      filters={filters}
      summary={loading ? undefined : countWords(agents.length, hasMore, "agent")}
      toolbarTrailing={
        <SegmentedControl<ViewValue>
          label="View"
          value={view}
          onChange={setView}
          iconOnly
          options={[
            { value: "grid", label: "Gallery", icon: LayoutGridIcon },
            { value: "list", label: "List", icon: Rows3Icon },
          ]}
        />
      }
      layout={view === "grid" ? "grid" : "table"}
      gridClassName={GALLERY_GRID}
      renderCard={(a, i) => (
        <AgentCard
          key={a.id}
          agent={a}
          activity={byAgent.get(a.id)}
          className="stagger animate-rise-in"
          style={{ "--i": Math.min(i, 12) } as React.CSSProperties}
          menu={<RowActionsMenu label={`Actions for ${a.name}`} actions={actionsFor(a)} />}
        />
      )}
      data={agents}
      loading={loading}
      getRowId={(a) => a.id}
      rowHref={(a) => `/agents/${a.id}`}
      hasMore={hasMore}
      loadingMore={isLoadingMore}
      onLoadMore={loadMore}
      emptyTitle={filtered ? "No agents match" : status === "archived" ? "No archived agents" : "No agents yet"}
      emptyKind="agent"
      filtered={filtered}
      emptyAction={
        filtered ? (
          <Button
            variant="outline"
            onClick={() => {
              setSearch("");
              setCreated({});
            }}
          >
            Clear filters
          </Button>
        ) : status !== "archived" ? (
          <>
            <Button onClick={() => setShowCreate(true)} aria-label="Create an agent">
              New agent
            </Button>
            <Button variant="ghost" asChild>
              <Link to="/">Open the setup guide</Link>
            </Button>
          </>
        ) : undefined
      }
      emptySubtitle={
        filtered
          ? "Try a different name, or widen the filters."
          : status === "archived"
            ? "Agents you archive are kept here, out of the way."
            : "An agent is a model with instructions, tools and a place to run. Start from a template and refine it in conversation."
      }
      columns={columns}
    >
      <AgentFormDialog
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onCreated={refreshAgents}
        allAgents={allAgents}
        customSkills={customSkills}
        modelCards={modelCards}
        runtimes={runtimes}
      />
      <ConfirmDialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        destructive={confirm?.kind === "delete"}
        title={confirm?.kind === "delete" ? `Delete ${confirm.agent.name}?` : `Archive ${confirm?.agent.name ?? "agent"}?`}
        body={
          confirm?.kind === "delete"
            ? "The agent and all of its versions are removed. Past sessions stay in history. This cannot be undone."
            : "Archived agents stop accepting new sessions and move out of the gallery. Their history is kept."
        }
        confirmLabel={confirm?.kind === "delete" ? "Delete agent" : "Archive agent"}
        onConfirm={async () => {
          if (!confirm) return;
          if (confirm.kind === "delete") {
            await api(`/v1/agents/${confirm.agent.id}`, { method: "DELETE" });
          } else {
            await api(`/v1/agents/${confirm.agent.id}/archive`, { method: "POST", body: "{}" });
          }
          refreshAgents();
        }}
      />
    </DataTable>
  );
}
