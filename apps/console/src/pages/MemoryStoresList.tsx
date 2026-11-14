import { useMemo, useState } from "react";
import { ArchiveIcon, CopyIcon, Trash2Icon } from "lucide-react";

import { useApi } from "../lib/api";
import { useServerFeature } from "../lib/server-features";
import { copyText } from "../lib/clipboard";
import { plural } from "../lib/format";
import { useApiQuery } from "../lib/useApiQuery";
import { useLocalSearch } from "../lib/useLocalSearch";
import { Callout } from "../components/Callout";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { DataTable, type ColumnDef } from "../components/DataTable";
import { Field } from "../components/Field";
import { CreatedFilterChip } from "../components/FilterChip";
import { Modal } from "../components/Modal";
import { RelativeTime } from "../components/RelativeTime";
import { RowActionsMenu, type RowAction } from "../components/RowActionsMenu";
import { Skeleton } from "../components/Skeleton";
import { Tip } from "../components/Tip";
import { useMemoryEntries, type MemoryStore } from "../components/resources/memory";
import {
  ArchiveStatusFilter,
  ResourceIdentity,
  formatBytes,
  type ArchiveStatus,
} from "../components/resources/ResourceBits";
import { lastWriteOf, StoreLastWrite as LastWrite } from "../components/resources/lastWrite";
import { ResourceListError } from "../components/resources/ResourceListError";
import { UsedBy, useResourceUsage } from "../components/resources/usage";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { withReason } from "../lib/failure-text";

const SUBTITLE = "What your agents remember between sessions, kept as folders of notes.";

/** "12 entries" over "2.9 KB in 7 folders". */
function StoreSize({ store }: { store: MemoryStore }) {
  const { stats, isLoading } = useMemoryEntries(store.id);
  if (isLoading || !stats) return <Skeleton className="h-3.5 w-20" rounded="sm" />;
  if (stats.count === 0) return <span className="text-fg-subtle">Empty</span>;
  return (
    <div className="min-w-0 leading-tight">
      <div className="truncate text-fg">{plural(stats.count, "entry", "entries")}</div>
      <div className="truncate text-xs text-fg-subtle">
        {formatBytes(stats.bytes)}
        {stats.folders > 0 ? ` in ${plural(stats.folders, "folder")}` : ""}
      </div>
    </div>
  );
}

/**
 * When an agent or a person last wrote to the store: from its entries, never
 * from the store's own date. An empty store has no last write: Contents
 * already says "Empty", so this column shows a quiet dash (its words on
 * hover and to a screen reader) instead of saying it again, cut short.
 */
function StoreLastWrite({ store }: { store: MemoryStore }) {
  const { stats, isLoading } = useMemoryEntries(store.id);
  if (!isLoading && lastWriteOf(stats).kind === "never") {
    return (
      <Tip label="Nothing written yet">
        <span className="text-fg-faint">
          <span aria-hidden="true">—</span>
          <span className="sr-only">Nothing written yet</span>
        </span>
      </Tip>
    );
  }
  return <LastWrite stats={stats} isLoading={isLoading} className="text-fg-muted" />;
}

/**
 * Memory — the stores agents remember in. One row per store: what it is
 * for, how much is in it, which agents use it and when it was last
 * written to.
 */
export function MemoryStoresList() {
  const { api } = useApi();
  const usage = useResourceUsage();

  // Server-driven filters. /v1/memory_stores has no text search, so the
  // search field narrows the stores in the browser, by name and description
  // (the list arrives whole).
  const [status, setStatus] = useState<ArchiveStatus>("active");
  const [created, setCreated] = useState<{ after?: number; before?: number }>({});

  const storesParams = useMemo(
    () => ({
      status,
      ...(created.after !== undefined ? { created_after: new Date(created.after).toISOString() } : {}),
      ...(created.before !== undefined ? { created_before: new Date(created.before).toISOString() } : {}),
    }),
    [status, created.after, created.before],
  );

  const { data: resp, isLoading: loading, error, refetch } = useApiQuery<{ data: MemoryStore[] }>(
    "/v1/memory_stores",
    storesParams,
  );
  const stores = resp?.data ?? [];
  const found = useLocalSearch(stores, (s) => [s.name, s.description]);

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
      await api("/v1/memory_stores", {
        method: "POST",
        body: JSON.stringify({ name: form.name.trim(), description: form.description.trim() || undefined }),
        silentErrors: true,
      });
      setShowCreate(false);
      setForm({ name: "", description: "" });
      void refetch();
    } catch (e) {
      setCreateError(withReason("The store could not be created", e));
    } finally {
      setCreating(false);
    }
  };

  const [confirm, setConfirm] = useState<{ kind: "archive" | "delete"; store: MemoryStore } | null>(null);

  // Archiving and deleting a store need a server that has those writes.
  const writable = useServerFeature("memory_writes");
  const actionsFor = (s: MemoryStore): RowAction[] => [
    { label: "Copy store id", icon: <CopyIcon />, onSelect: () => void copyText(s.id) },
    ...(writable
      ? [
          {
            label: "Archive",
            icon: <ArchiveIcon />,
            disabled: !!s.archived_at,
            onSelect: () => setConfirm({ kind: "archive", store: s }),
          },
          { label: "Delete", icon: <Trash2Icon />, destructive: true, onSelect: () => setConfirm({ kind: "delete", store: s }) },
        ]
      : []),
  ];

  const columns = useMemo<ColumnDef<MemoryStore>[]>(
    () => [
      {
        id: "name",
        accessorKey: "name",
        header: "Memory store",
        size: 470,
        minSize: 240,
        enableHiding: false,
        enableSorting: true,
        cell: ({ row }) => (
          <ResourceIdentity
            name={row.original.name}
            secondary={row.original.description?.trim() || "No description"}
            archived={!!row.original.archived_at}
          />
        ),
      },
      {
        id: "size",
        header: "Contents",
        size: 220,
        cell: ({ row }) => <StoreSize store={row.original} />,
      },
      {
        id: "used_by",
        header: "Used by",
        size: 230,
        // Also on the store's page: it gives way before the table scrolls sideways.
        meta: { hideBelow: 720 },
        cell: ({ row }) => <UsedBy agents={usage.memoryStores.get(row.original.id)} loading={usage.isLoading} />,
      },
      {
        id: "updated",
        header: "Last write",
        size: 130,
        cell: ({ row }) => <StoreLastWrite store={row.original} />,
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
    [usage, writable],
  );

  const dated = created.after !== undefined || created.before !== undefined;
  const filtered = found.searching || dated;

  if (error && stores.length === 0) {
    return (
      <ResourceListError
        title="Memory"
        subtitle={SUBTITLE}
        what="Memory stores"
        error={error}
        retry={() => void refetch()}
      />
    );
  }

  return (
    <DataTable<MemoryStore>
      title="Memory"
      subtitle={SUBTITLE}
      createLabel="+ New store"
      onCreate={() => setShowCreate(true)}
      searchPlaceholder="Search memory"
      searchValue={found.search}
      onSearchChange={found.setSearch}
      filters={
        <>
          <ArchiveStatusFilter value={status} onChange={setStatus} />
          <CreatedFilterChip value={created} onChange={setCreated} />
        </>
      }
      summary={loading || found.rows.length === 0 ? undefined : plural(found.rows.length, "store")}
      data={found.rows}
      loading={loading}
      getRowId={(s) => s.id}
      rowHref={(s) => `/memory/${s.id}`}
      columns={columns}
      emptyKind="memory"
      emptyTitle={
        found.searching
          ? `No memory stores match “${found.query}”`
          : filtered
            ? "No memory stores match"
            : status === "archived"
              ? "No archived stores"
              : "No memory stores yet"
      }
      emptySubtitle={
        found.searching
          ? `Stores are searched by name and description, not by what is written in them.${dated ? " The date range is narrowing the list too." : ""}`
          : filtered
            ? "Widen the date range to see more."
            : status === "archived"
              ? "Stores you archive become read-only and are kept here."
              : "A memory store is a folder of notes that outlives a session. Attach one to an agent and it can pick up where it left off: preferences, decisions, customer context."
      }
      filtered={filtered}
      emptyAction={
        filtered ? (
          <Button
            variant="outline"
            onClick={() => {
              found.setSearch("");
              setCreated({});
            }}
          >
            {found.searching && !dated ? "Clear search" : "Clear filters"}
          </Button>
        ) : status !== "archived" ? (
          <Button onClick={() => setShowCreate(true)}>New store</Button>
        ) : undefined
      }
    >
      <Modal
        open={showCreate}
        onClose={closeCreate}
        title="New memory store"
        subtitle="A place for one kind of knowledge. Agents see the name and description when they decide where to look."
        footer={
          <>
            <Button variant="ghost" onClick={closeCreate} disabled={creating}>
              Cancel
            </Button>
            <Button onClick={() => void create()} disabled={!form.name.trim()} loading={creating}>
              Create store
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
          <Field label="Name" hint="Also the folder name inside the sandbox: /mnt/memory/<name>/">
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Support playbook"
              autoComplete="off"
              autoFocus
            />
          </Field>
          <Field label="Description" hint="Optional. What is stored here, and when an agent should read it.">
            <Textarea
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              rows={3}
              placeholder="Known issues, policies and escalation contacts for the support team"
            />
          </Field>
        </form>
      </Modal>

      <ConfirmDialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        destructive={confirm?.kind === "delete"}
        title={confirm?.kind === "delete" ? `Delete ${confirm.store.name}?` : `Archive ${confirm?.store.name ?? "store"}?`}
        body={
          confirm?.kind === "delete"
            ? "The store, every entry in it and its version history are removed. This cannot be undone."
            : "The store becomes read-only and can no longer be attached to new sessions. Archiving cannot be reversed."
        }
        confirmLabel={confirm?.kind === "delete" ? "Delete store" : "Archive store"}
        onConfirm={async () => {
          if (!confirm) return;
          if (confirm.kind === "delete") {
            await api(`/v1/memory_stores/${confirm.store.id}`, { method: "DELETE" });
          } else {
            await api(`/v1/memory_stores/${confirm.store.id}/archive`, { method: "POST", body: "{}" });
          }
          void refetch();
        }}
      />
    </DataTable>
  );
}
