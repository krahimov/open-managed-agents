import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { ArchiveIcon, CopyIcon, GlobeIcon, ShieldCheckIcon, Trash2Icon } from "lucide-react";

import { useApi } from "../lib/api";
import { copyText } from "../lib/clipboard";
import { countWords, plural, toDate } from "../lib/format";
import { useInfiniteApiQuery } from "../lib/useApiQuery";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { DataTable, type ColumnDef } from "../components/DataTable";
import { Field } from "../components/Field";
import { CreatedFilterChip } from "../components/FilterChip";
import { Modal } from "../components/Modal";
import { RelativeTime } from "../components/RelativeTime";
import { RowActionsMenu, type RowAction } from "../components/RowActionsMenu";
import { Tip } from "../components/Tip";
import {
  networkSummary,
  packageSummary,
  providerLabel,
  type Environment,
} from "../components/resources/environment";
import {
  ArchiveStatusFilter,
  Fact,
  ResourceIdentity,
  errorMessage,
  type ArchiveStatus,
} from "../components/resources/ResourceBits";
import { OverflowTip } from "../components/OverflowTip";
import { ResourceListError } from "../components/resources/ResourceListError";
import { UsedBy, useResourceUsage } from "../components/resources/usage";
import { Callout } from "../components/Callout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

const SUBTITLE = "Sandboxes your agents run in: the runtime, its packages and what it can reach.";
const NAME_MAX = 50;

/**
 * Environments — the sandboxes agents run in. One row per environment:
 * what it runs on, how much is installed, what it may reach on the
 * network, and which agents depend on it. Search and filters are
 * server-side; rows open the record.
 */
export function EnvironmentsList() {
  const { api } = useApi();
  const nav = useNavigate();
  const usage = useResourceUsage();

  const [status, setStatus] = useState<ArchiveStatus>("active");
  const [created, setCreated] = useState<{ after?: number; before?: number }>({});
  const [search, setSearch] = useState("");

  const envsParams = useMemo(
    () => ({
      status,
      ...(created.after !== undefined ? { created_after: new Date(created.after).toISOString() } : {}),
      ...(created.before !== undefined ? { created_before: new Date(created.before).toISOString() } : {}),
      ...(search ? { q: search } : {}),
    }),
    [status, created.after, created.before, search],
  );

  const {
    items: envs,
    isLoading: loading,
    hasMore,
    isLoadingMore,
    loadMore,
    refresh,
    error,
  } = useInfiniteApiQuery<Environment>("/v1/environments", { limit: 20, params: envsParams });

  // Create
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ name: "", description: "" });
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const closeCreate = () => {
    if (creating) return;
    setShowCreate(false);
    setCreateError(null);
  };
  const create = async () => {
    setCreating(true);
    setCreateError(null);
    try {
      const env = await api<Environment>("/v1/environments", {
        method: "POST",
        body: JSON.stringify({
          name: form.name.trim(),
          config: { type: "cloud" },
          description: form.description.trim() || undefined,
        }),
        silentErrors: true,
      });
      setShowCreate(false);
      setForm({ name: "", description: "" });
      refresh();
      // A new environment is an empty sandbox: open it so the runtime,
      // packages and network can be set up straight away.
      if (env?.id) nav(`/environments/${env.id}`);
    } catch (e) {
      setCreateError(errorMessage(e, "The environment could not be created"));
    } finally {
      setCreating(false);
    }
  };

  // Archive / delete go through a designed confirmation.
  const [confirm, setConfirm] = useState<{ kind: "archive" | "delete"; env: Environment } | null>(null);

  const actionsFor = (e: Environment): RowAction[] => [
    { label: "Copy environment id", icon: <CopyIcon />, onSelect: () => void copyText(e.id) },
    {
      label: "Archive",
      icon: <ArchiveIcon />,
      disabled: !!e.archived_at,
      onSelect: () => setConfirm({ kind: "archive", env: e }),
    },
    {
      label: "Delete",
      icon: <Trash2Icon />,
      destructive: true,
      onSelect: () => setConfirm({ kind: "delete", env: e }),
    },
  ];

  const columns = useMemo<ColumnDef<Environment>[]>(
    () => [
      {
        id: "name",
        accessorKey: "name",
        header: "Environment",
        size: 380,
        minSize: 240,
        enableHiding: false,
        enableSorting: true,
        cell: ({ row }) => {
          const e = row.original;
          return (
            <ResourceIdentity
              name={e.name}
              secondary={e.description?.trim() || "No description"}
              archived={!!e.archived_at}
            />
          );
        },
      },
      {
        id: "runtime",
        header: "Runtime",
        size: 190,
        cell: ({ row }) => {
          const sb = row.original.config?.sandbox;
          return (
            <div className="min-w-0 leading-tight">
              <div className="truncate text-fg">{providerLabel(sb?.provider)}</div>
              <div className="flex min-w-0">
                <OverflowTip label={sb?.image} focusable>
                  <div className="min-w-0 truncate rounded-sm font-mono text-micro-size text-fg-subtle">
                    {sb?.image || "default image"}
                  </div>
                </OverflowTip>
              </div>
            </div>
          );
        },
      },
      {
        id: "packages",
        header: "Packages",
        size: 100,
        // Also on the environment's page: the first to go, so the name stays whole at 1280.
        meta: { hideBelow: 1000, align: "right" },
        cell: ({ row }) => {
          const { total, groups } = packageSummary(row.original);
          if (total === 0) return <span className="text-fg-subtle">None</span>;
          return (
            <Tip
              label={
                <span className="block">
                  {groups.map((g) => (
                    <span key={g.manager} className="block">
                      <span className="font-mono opacity-75">{g.manager}</span> {g.packages.length}
                    </span>
                  ))}
                </span>
              }
            >
              <span className="text-fg-muted" aria-label={plural(total, "package")}>
                {total}
              </span>
            </Tip>
          );
        },
      },
      {
        id: "network",
        header: "Network",
        size: 130,
        meta: { hideBelow: 720 },
        cell: ({ row }) => {
          const net = networkSummary(row.original);
          return (
            <Fact
              icon={net.limited ? ShieldCheckIcon : GlobeIcon}
              title={net.limited && net.hosts.length > 0 ? `Limited to ${net.hosts.join(", ")}` : net.label}
            >
              {net.short}
            </Fact>
          );
        },
      },
      {
        id: "used_by",
        header: "Used by",
        size: 200,
        cell: ({ row }) => (
          <UsedBy agents={usage.environments.get(row.original.id)} loading={usage.isLoading} />
        ),
      },
      {
        id: "updated",
        accessorFn: (r) => toDate(r.updated_at ?? r.created_at)?.getTime(),
        header: "Updated",
        size: 116,
        enableSorting: true,
        sortDescFirst: true,
        cell: ({ row }) => (
          <RelativeTime
            value={row.original.updated_at ?? row.original.created_at}
            className="text-fg-muted"
          />
        ),
      },
      {
        id: "actions",
        header: "",
        size: 56,
        enableHiding: false,
        cell: ({ row }) => (
          <RowActionsMenu label={`Actions for ${row.original.name}`} actions={actionsFor(row.original)} />
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [usage],
  );

  const filtered = !!search || created.after !== undefined || created.before !== undefined;
  const clearFilters = () => {
    setSearch("");
    setCreated({});
  };

  if (error && envs.length === 0) {
    return <ResourceListError title="Environments" subtitle={SUBTITLE} what="Environments" error={error} retry={refresh} />;
  }

  return (
    <DataTable<Environment>
      title="Environments"
      subtitle={SUBTITLE}
      createLabel="+ New environment"
      onCreate={() => setShowCreate(true)}
      searchPlaceholder="Search environments"
      searchValue={search}
      onSearchChange={setSearch}
      filters={
        <>
          <ArchiveStatusFilter value={status} onChange={setStatus} />
          <CreatedFilterChip value={created} onChange={setCreated} />
        </>
      }
      summary={
        loading || envs.length === 0
          ? undefined
          : countWords(envs.length, hasMore, "environment")
      }
      data={envs}
      loading={loading}
      getRowId={(e) => e.id}
      rowHref={(e) => `/environments/${e.id}`}
      hasMore={hasMore}
      loadingMore={isLoadingMore}
      onLoadMore={loadMore}
      columns={columns}
      emptyKind="env"
      emptyTitle={
        filtered ? "No environments match" : status === "archived" ? "No archived environments" : "No environments yet"
      }
      emptySubtitle={
        filtered
          ? "Try a different name, or widen the filters."
          : status === "archived"
            ? "Environments you archive are kept here, out of the way."
            : "An environment is the sandbox a session starts in: a runtime image, the packages installed on it, and the hosts it is allowed to reach."
      }
      filtered={filtered}
      emptyAction={
        filtered ? (
          <Button variant="outline" onClick={clearFilters}>
            Clear filters
          </Button>
        ) : status !== "archived" ? (
          <Button onClick={() => setShowCreate(true)}>New environment</Button>
        ) : undefined
      }
    >
      <Modal
        open={showCreate}
        onClose={closeCreate}
        title="New environment"
        subtitle="Name the sandbox now. You set its runtime, packages and network on the next screen."
        footer={
          <>
            <Button variant="ghost" onClick={closeCreate} disabled={creating}>
              Cancel
            </Button>
            <Button onClick={() => void create()} disabled={!form.name.trim()} loading={creating}>
              Create environment
            </Button>
          </>
        }
      >
        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (form.name.trim() && !creating) void create();
          }}
        >
          {createError && <Callout tone="danger">{createError}</Callout>}
          <Field label="Name" hint={`${form.name.length}/${NAME_MAX} characters`}>
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value.slice(0, NAME_MAX) })}
              placeholder="Production sandbox"
              autoComplete="off"
              autoFocus
            />
          </Field>
          <Field label="Description" hint="Optional. Say what this environment is for, so the right agents end up in it.">
            <Textarea
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              rows={3}
              placeholder="General-purpose sandbox for engineering agents"
            />
          </Field>
          <div className="flex items-center justify-between gap-4 rounded-lg bg-bg-soft px-3.5 py-2.5">
            <div className="min-w-0">
              <p className="text-small-size font-medium text-fg">Hosting</p>
              <p className="text-xs text-fg-muted">Cloud sandbox. This cannot be changed after creation.</p>
            </div>
            <span className="inline-flex h-[22px] shrink-0 items-center gap-1 rounded-full bg-bg-surface px-2 text-xs font-medium text-fg-muted shadow-[var(--shadow-xs)] dark:bg-bg-pressed">
              Cloud
            </span>
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        destructive={confirm?.kind === "delete"}
        title={
          confirm?.kind === "delete"
            ? `Delete ${confirm.env.name}?`
            : `Archive ${confirm?.env.name ?? "environment"}?`
        }
        body={
          confirm?.kind === "delete"
            ? `The environment is removed. ${(() => {
                const n = usage.environments.get(confirm.env.id)?.length ?? 0;
                return n > 0 ? `${plural(n, "agent")} ${n === 1 ? "uses" : "use"} it by default. ` : "";
              })()}This cannot be undone.`
            : "Archived environments move out of the active list. Sessions that already ran here keep their history."
        }
        confirmLabel={confirm?.kind === "delete" ? "Delete environment" : "Archive environment"}
        onConfirm={async () => {
          if (!confirm) return;
          if (confirm.kind === "delete") {
            await api(`/v1/environments/${confirm.env.id}`, { method: "DELETE" });
          } else {
            await api(`/v1/environments/${confirm.env.id}/archive`, { method: "POST", body: "{}" });
          }
          refresh();
        }}
      />
    </DataTable>
  );
}
