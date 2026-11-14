import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { ArchiveIcon, CopyIcon, Trash2Icon } from "lucide-react";

import { useApi } from "../lib/api";
import { copyText } from "../lib/clipboard";
import { countWords, plural, toDate } from "../lib/format";
import { useInfiniteApiQuery } from "../lib/useApiQuery";
import { useLocalSearch } from "../lib/useLocalSearch";
import { Chip } from "../components/Badge";
import { Callout } from "../components/Callout";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { DataTable, type ColumnDef } from "../components/DataTable";
import { Field } from "../components/Field";
import { CreatedFilterChip } from "../components/FilterChip";
import { Modal } from "../components/Modal";
import { RelativeTime } from "../components/RelativeTime";
import { RowActionsMenu, type RowAction } from "../components/RowActionsMenu";
import { Skeleton } from "../components/Skeleton";
import {
  credentialBreakdown,
  isConnectedAppsVault,
  useVaultCredentials,
  type Vault,
} from "../components/resources/credentials";
import {
  ArchiveStatusFilter,
  ResourceIdentity,
  type ArchiveStatus,
} from "../components/resources/ResourceBits";
import { ResourceListError } from "../components/resources/ResourceListError";
import { UsedBy, useResourceUsage } from "../components/resources/usage";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { withReason } from "../lib/failure-text";

const SUBTITLE = "Credentials your agents borrow at run time. Secrets are write-only.";
const NAME_MAX = 30;

/** Identity cell: the vault's name over the names of what it holds. */
function VaultIdentity({ vault }: { vault: Vault }) {
  const { credentials, isLoading } = useVaultCredentials(vault.id);
  const active = (credentials ?? []).filter((c) => !c.archived_at);
  const names = active.map((c) => c.display_name);
  const secondary = isLoading ? (
    <Skeleton className="mt-1 h-2.5 w-40" rounded="sm" />
  ) : names.length > 0 ? (
    names.slice(0, 3).join(", ") + (names.length > 3 ? ` and ${names.length - 3} more` : "")
  ) : isConnectedAppsVault(vault) ? (
    "Holds the apps you connect from Integrations"
  ) : (
    "Empty"
  );
  return (
    <ResourceIdentity
      name={vault.name}
      secondary={secondary}
      secondaryTitle={names.join(", ") || undefined}
      archived={!!vault.archived_at}
      badge={isConnectedAppsVault(vault) ? <Chip>Managed</Chip> : undefined}
    />
  );
}

/** "5 credentials" over "3 MCP servers · 2 CLIs". */
function VaultCredentials({ vault }: { vault: Vault }) {
  const { credentials, isLoading } = useVaultCredentials(vault.id);
  if (isLoading || !credentials) return <Skeleton className="h-3.5 w-24" rounded="sm" />;
  const active = credentials.filter((c) => !c.archived_at);
  if (active.length === 0) return <span className="text-fg-subtle">No credentials yet</span>;
  const parts = credentialBreakdown(active);
  return (
    <div className="min-w-0 leading-tight">
      <div className="truncate text-fg">{plural(active.length, "credential")}</div>
      <div className="truncate text-xs text-fg-subtle">{parts.map((p) => p.label).join(" · ")}</div>
    </div>
  );
}

/**
 * Vaults — where credentials live. One row per vault: what it holds (how
 * many credentials, of which kinds), which agents borrow from it, and
 * when it last changed. No secret is ever on this page.
 */
export function VaultsList() {
  const { api } = useApi();
  const nav = useNavigate();
  const usage = useResourceUsage();

  const [status, setStatus] = useState<ArchiveStatus>("active");
  const [created, setCreated] = useState<{ after?: number; before?: number }>({});

  const vaultParams = useMemo(
    () => ({
      status,
      ...(created.after !== undefined ? { created_after: new Date(created.after).toISOString() } : {}),
      ...(created.before !== undefined ? { created_before: new Date(created.before).toISOString() } : {}),
    }),
    [status, created.after, created.before],
  );

  const {
    items: vaults,
    isLoading: loading,
    hasMore,
    isLoadingMore,
    loadMore,
    refresh,
    error,
  } = useInfiniteApiQuery<Vault>("/v1/vaults", { limit: 20, params: vaultParams });

  // /v1/vaults has no text search: the field narrows the loaded vaults by
  // name and loads the rest while something is typed (lib/useLocalSearch.ts).
  const found = useLocalSearch(vaults, (v) => [v.name], { hasMore, isLoadingMore, loadMore });

  // Create
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
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
      const vault = await api<Vault>("/v1/vaults", {
        method: "POST",
        body: JSON.stringify({ name: name.trim() }),
        silentErrors: true,
      });
      setShowCreate(false);
      setName("");
      refresh();
      // A new vault is empty: open it so the first credential can be added.
      if (vault?.id) nav(`/vaults/${vault.id}`);
    } catch (e) {
      setCreateError(withReason("The vault could not be created", e));
    } finally {
      setCreating(false);
    }
  };

  const [confirm, setConfirm] = useState<{ kind: "archive" | "delete"; vault: Vault } | null>(null);

  const actionsFor = (v: Vault): RowAction[] => [
    { label: "Copy vault id", icon: <CopyIcon />, onSelect: () => void copyText(v.id) },
    {
      label: "Archive",
      icon: <ArchiveIcon />,
      disabled: !!v.archived_at,
      onSelect: () => setConfirm({ kind: "archive", vault: v }),
    },
    { label: "Delete", icon: <Trash2Icon />, destructive: true, onSelect: () => setConfirm({ kind: "delete", vault: v }) },
  ];

  const columns = useMemo<ColumnDef<Vault>[]>(
    () => [
      {
        id: "name",
        accessorKey: "name",
        header: "Vault",
        size: 470,
        minSize: 240,
        enableHiding: false,
        enableSorting: true,
        cell: ({ row }) => <VaultIdentity vault={row.original} />,
      },
      {
        id: "credentials",
        header: "Credentials",
        size: 250,
        cell: ({ row }) => <VaultCredentials vault={row.original} />,
      },
      {
        id: "used_by",
        header: "Used by",
        size: 220,
        // Also on the vault's page: it gives way before the table scrolls sideways.
        meta: { hideBelow: 720 },
        cell: ({ row }) => <UsedBy agents={usage.vaults.get(row.original.id)} loading={usage.isLoading} />,
      },
      {
        id: "updated",
        accessorFn: (r) => toDate(r.updated_at ?? r.created_at)?.getTime(),
        header: "Updated",
        size: 130,
        enableSorting: true,
        sortDescFirst: true,
        cell: ({ row }) => (
          <RelativeTime value={row.original.updated_at ?? row.original.created_at} className="text-fg-muted" />
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

  const dated = created.after !== undefined || created.before !== undefined;
  const filtered = found.searching || dated;

  if (error && vaults.length === 0) {
    return <ResourceListError title="Vaults" subtitle={SUBTITLE} what="Vaults" error={error} retry={refresh} />;
  }

  return (
    <DataTable<Vault>
      title="Vaults"
      subtitle={SUBTITLE}
      createLabel="+ New vault"
      onCreate={() => setShowCreate(true)}
      searchPlaceholder="Search vaults"
      searchValue={found.search}
      onSearchChange={found.setSearch}
      filters={
        <>
          <ArchiveStatusFilter value={status} onChange={setStatus} />
          <CreatedFilterChip value={created} onChange={setCreated} />
        </>
      }
      summary={
        loading || found.rows.length === 0
          ? undefined
          : countWords(found.rows.length, hasMore, "vault")
      }
      data={found.rows}
      loading={loading}
      getRowId={(v) => v.id}
      rowHref={(v) => `/vaults/${v.id}`}
      hasMore={hasMore}
      loadingMore={isLoadingMore}
      onLoadMore={loadMore}
      columns={columns}
      emptyKind="vault"
      emptyTitle={
        found.searching
          ? `No vaults match “${found.query}”`
          : filtered
            ? "No vaults match"
            : status === "archived"
              ? "No archived vaults"
              : "No vaults yet"
      }
      emptySubtitle={
        found.searching
          ? `Vaults are searched by name.${dated ? " The date range is narrowing the list too." : ""}`
          : filtered
            ? "Widen the date range to see more."
            : status === "archived"
              ? "Vaults you archive are kept here. Their credentials are archived with them."
              : "A vault holds the tokens your agents need for other services: MCP servers, command-line tools and connected apps. Secrets are encrypted and never shown again."
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
          <Button onClick={() => setShowCreate(true)}>New vault</Button>
        ) : undefined
      }
    >
      <Modal
        open={showCreate}
        onClose={closeCreate}
        title="New vault"
        subtitle="Group credentials the way you grant them: by team, by sensitivity or by system."
        footer={
          <>
            <Button variant="ghost" onClick={closeCreate} disabled={creating}>
              Cancel
            </Button>
            <Button onClick={() => void create()} disabled={!name.trim()} loading={creating}>
              Create vault
            </Button>
          </>
        }
      >
        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim() && !creating) void create();
          }}
        >
          {createError && <Callout tone="danger">{createError}</Callout>}
          <Field label="Name" hint={`${name.length}/${NAME_MAX} characters. You add credentials on the next screen.`}>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value.slice(0, NAME_MAX))}
              placeholder="Engineering"
              autoComplete="off"
              autoFocus
            />
          </Field>
        </form>
      </Modal>

      <ConfirmDialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        destructive={confirm?.kind === "delete"}
        title={confirm?.kind === "delete" ? `Delete ${confirm.vault.name}?` : `Archive ${confirm?.vault.name ?? "vault"}?`}
        body={
          confirm?.kind === "delete"
            ? "The vault and every credential in it are removed. Agents that borrow from it lose that access. This cannot be undone."
            : "The vault and all of its credentials are archived, and agents can no longer borrow from it. Archiving cannot be reversed."
        }
        confirmLabel={confirm?.kind === "delete" ? "Delete vault" : "Archive vault"}
        onConfirm={async () => {
          if (!confirm) return;
          if (confirm.kind === "delete") {
            await api(`/v1/vaults/${confirm.vault.id}`, { method: "DELETE" });
          } else {
            await api(`/v1/vaults/${confirm.vault.id}/archive`, { method: "POST", body: "{}" });
          }
          refresh();
        }}
      />
    </DataTable>
  );
}
