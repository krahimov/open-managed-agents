import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import {
  ArchiveIcon,
  BrainIcon,
  CopyIcon,
  FileTextIcon,
  FolderIcon,
  HistoryIcon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
} from "lucide-react";

import { ApiError, useApi } from "../lib/api";
import { copyText } from "../lib/clipboard";
import { plural } from "../lib/format";
import { useApiQuery, useQueryClient } from "../lib/useApiQuery";
import { EntityAvatar } from "../components/AgentAvatar";
import { Chip, StatusBadge } from "../components/Badge";
import { Callout } from "../components/Callout";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { DetailHeader } from "../components/DetailHeader";
import { EmptyState, RecordNotFound } from "../components/EmptyState";
import { EntityRef } from "../components/EntityRef";
import { CopyButton, IdChip } from "../components/IdChip";
import { Page } from "../components/Page";
import { Property, PropertyList } from "../components/PropertyList";
import { ErrorState } from "../components/QueryProblem";
import { RelativeTime } from "../components/RelativeTime";
import { RowActionsMenu } from "../components/RowActionsMenu";
import { SectionCard } from "../components/SectionCard";
import { Skeleton, SkeletonDetail } from "../components/Skeleton";
import { TabBar, useTabParam } from "../components/TabBar";
import { Tip } from "../components/Tip";
import { memoryMounts, type Environment } from "../components/resources/environment";
import {
  baseName,
  mountPath,
  topFolder,
  useMemoryEntries,
  type MemoryListItem,
  type MemoryStore,
  type MemoryVersion,
} from "../components/resources/memory";
import { StoreLastWrite } from "../components/resources/lastWrite";
import { Actor, MemoryEntrySheet, OperationBadge, WriteMemoryDialog } from "../components/resources/MemoryPanels";
import { formatBytes } from "../components/resources/ResourceBits";
import { useQuietQuery } from "@/lib/useApiQuery";
import { UsedByList, useResourceUsage } from "../components/resources/usage";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type TabKey = "entries" | "history";

/** Label column for the narrow aside, so a full id fits beside it. */
// The aside's label column: the same width as PropertyList labelWidth="narrow".
const ASIDE_ROW = "grid-cols-[6.5rem_minmax(0,1fr)]";
/** Entry rows: file · size · updated. */
const ROW = "grid grid-cols-[minmax(0,1fr)_72px_96px] items-center gap-x-4";

/**
 * Memory store — a folder of notes that outlives a session. The page is
 * a small file browser: entries grouped by their top folder, opened in a
 * side panel to read, edit or roll back. History is the store-wide audit
 * trail, where the runtime keeps one.
 */
export function MemoryStoreDetail() {
  const { id: storeId } = useParams<{ id: string }>();
  const nav = useNavigate();
  const { api } = useApi();
  const queryClient = useQueryClient();
  const usage = useResourceUsage();
  const [tab, setTab] = useTabParam<TabKey>("entries", ["entries", "history"]);

  const { data: store, error, isLoading, refetch } = useApiQuery<MemoryStore>(
    storeId ? `/v1/memory_stores/${storeId}` : null,
  );
  // Unfiltered totals for the header (shared with the list page's cache).
  const totals = useMemoryEntries(storeId);

  // Environments that mount this store by default.
  const { data: envRes } = useApiQuery<{ data: Environment[] }>("/v1/environments", ENV_PARAMS);
  const mountedIn = useMemo(
    () => (envRes?.data ?? []).filter((e) => memoryMounts(e).some((m) => m.storeId === storeId)),
    [envRes, storeId],
  );

  const [showWrite, setShowWrite] = useState(false);
  const [confirm, setConfirm] = useState<"archive" | "delete" | null>(null);

  if (error && !store) {
    const missing = error instanceof ApiError && error.status === 404;
    return (
      <Page>
        {missing ? (
          <RecordNotFound thing="memory store" kind="memory" back={{ to: "/memory", label: "memory" }} className="mt-4" />
        ) : (
          <ErrorState title="This memory store could not be loaded" error={error} retry={() => void refetch()} className="mt-4" />
        )}
      </Page>
    );
  }
  if (isLoading || !store || !storeId) {
    return (
      <Page>
        <SkeletonDetail />
      </Page>
    );
  }

  const archived = !!store.archived_at;
  const agents = usage.memoryStores.get(store.id) ?? [];
  const path = mountPath(store);
  const refreshEntries = () => {
    void queryClient.invalidateQueries({ queryKey: [`/v1/memory_stores/${store.id}/memories`] });
  };

  return (
    <Page>
      <DetailHeader
        avatar={<EntityAvatar icon={BrainIcon} size="xl" />}
        title={store.name}
        status={<StatusBadge status={archived ? "archived" : "active"} variant="soft" />}
        description={store.description?.trim() || <span className="text-fg-subtle">No description yet.</span>}
        meta={
          <>
            {totals.stats &&
              (totals.stats.count === 0 ? (
                // An empty store has no size worth a chip of its own ("0 B").
                <Chip icon={FileTextIcon}>No entries yet</Chip>
              ) : (
                <>
                  <Chip icon={FileTextIcon}>{plural(totals.stats.count, "entry", "entries")}</Chip>
                  <Chip>{formatBytes(totals.stats.bytes)}</Chip>
                </>
              ))}
          </>
        }
        actions={
          !archived ? (
            <Button
              onClick={() => {
                setTab("entries");
                setShowWrite(true);
              }}
            >
              <PlusIcon data-icon="inline-start" className="stroke-[2.25]" />
              New entry
            </Button>
          ) : undefined
        }
        menu={
          <RowActionsMenu
            label={`Actions for ${store.name}`}
            actions={[
              { label: "Copy store id", icon: <CopyIcon />, onSelect: () => void copyText(store.id) },
              { label: "Copy mount path", icon: <CopyIcon />, onSelect: () => void copyText(path) },
              { label: "Archive", icon: <ArchiveIcon />, disabled: archived, onSelect: () => setConfirm("archive") },
              { label: "Delete", icon: <Trash2Icon />, destructive: true, onSelect: () => setConfirm("delete") },
            ]}
          />
        }
      >
        <TabBar<TabKey>
          label="Memory store sections"
          value={tab}
          onChange={setTab}
          tabs={[
            { value: "entries", label: "Entries", count: totals.stats?.count },
            { value: "history", label: "History" },
          ]}
        />
      </DetailHeader>

      {archived && (
        <Callout tone="neutral" icon={ArchiveIcon} title="This store is archived" className="mt-6">
          It is read-only and cannot be attached to new sessions.
        </Callout>
      )}

      <div className="mt-6 grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0">
          {tab === "entries" ? (
            <EntriesPanel storeId={store.id} archived={archived} onNew={() => setShowWrite(true)} onChanged={refreshEntries} />
          ) : (
            <HistoryPanel storeId={store.id} />
          )}
        </div>

        <aside className="min-w-0 space-y-4">
          <SectionCard title="Used by" description={agents.length > 0 ? `${plural(agents.length, "agent")} ${agents.length === 1 ? "remembers" : "remember"} here.` : undefined}>
            <UsedByList
              agents={usage.memoryStores.get(store.id)}
              loading={usage.isLoading}
              empty="No agent remembers here yet. Turn on memory for an agent and choose this store."
            />
            {mountedIn.length > 0 && (
              <div className="mt-4 border-t border-border pt-3.5">
                <p className="text-small text-fg-subtle">Mounted by default in</p>
                <ul className="mt-2 space-y-2">
                  {mountedIn.map((e) => (
                    <li key={e.id}>
                      <EntityRef kind="environment" id={e.id} name={e.name} />
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </SectionCard>
          <SectionCard title="Details">
            <div className="mb-3 rounded-lg bg-bg-soft px-3 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-fg-subtle">Mount path</span>
                <CopyButton value={path} label="Copy mount path" className="size-6" />
              </div>
              <code className="mt-0.5 block font-mono text-xs break-all text-fg">{path}</code>
              <p className="mt-1.5 text-xs text-fg-muted">
                When the store is attached to a session, the agent reads and writes here with its ordinary file tools.
              </p>
            </div>
            <PropertyList>
              <Property label="Created" className={ASIDE_ROW}>
                <RelativeTime value={store.created_at} />
              </Property>
              <Property label="Last write" className={ASIDE_ROW}>
                {/* From the entries alone: an empty store has no last write to show. */}
                <StoreLastWrite stats={totals.stats} isLoading={totals.isLoading} />
              </Property>
              {archived && (
                <Property label="Archived" className={ASIDE_ROW}>
                  <RelativeTime value={store.archived_at} />
                </Property>
              )}
              <Property label="Store id" className={ASIDE_ROW}>
                {/* memstore ids are too long for this column in full */}
                <IdChip id={store.id} />
              </Property>
            </PropertyList>
          </SectionCard>
        </aside>
      </div>

      <WriteMemoryDialog storeId={store.id} open={showWrite && !archived} onClose={() => setShowWrite(false)} onSaved={refreshEntries} />

      <ConfirmDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        destructive={confirm === "delete"}
        title={confirm === "delete" ? `Delete ${store.name}?` : `Archive ${store.name}?`}
        body={
          confirm === "delete"
            ? "The store, every entry in it and its version history are removed. This cannot be undone."
            : "The store becomes read-only and can no longer be attached to new sessions. Archiving cannot be reversed."
        }
        confirmLabel={confirm === "delete" ? "Delete store" : "Archive store"}
        onConfirm={async () => {
          if (confirm === "delete") await api(`/v1/memory_stores/${store.id}`, { method: "DELETE" });
          else await api(`/v1/memory_stores/${store.id}/archive`, { method: "POST" });
          void queryClient.invalidateQueries({ queryKey: ["/v1/memory_stores"] });
          nav("/memory");
        }}
      />
    </Page>
  );
}

const ENV_PARAMS = { limit: "200" } as const;

// ── Entries ─────────────────────────────────────────────────────────

function EntriesPanel({
  storeId,
  archived,
  onNew,
  onChanged,
}: {
  storeId: string;
  archived: boolean;
  onNew: () => void;
  onChanged: () => void;
}) {
  const [pathPrefix, setPathPrefix] = useState("");
  const [depth, setDepth] = useState("");
  const [open, setOpen] = useState<MemoryListItem | null>(null);

  // Both filters are server params. `depth` only means something below a prefix.
  const params = useMemo(
    () => ({ path_prefix: pathPrefix || undefined, depth: pathPrefix && depth ? depth : undefined }),
    [pathPrefix, depth],
  );
  const { data, isLoading, error, refetch } = useApiQuery<{ data: MemoryListItem[] }>(
    `/v1/memory_stores/${storeId}/memories`,
    params,
  );
  const entries = useMemo(() => data?.data ?? [], [data]);
  const filtered = !!pathPrefix;

  // Group by top folder, root files first, folders by name.
  const groups = useMemo(() => {
    const map = new Map<string, MemoryListItem[]>();
    for (const m of entries) {
      const key = topFolder(m.path);
      const list = map.get(key);
      if (list) list.push(m);
      else map.set(key, [m]);
    }
    return [...map.entries()]
      .sort((a, b) => (a[0] === "" ? -1 : b[0] === "" ? 1 : a[0].localeCompare(b[0])))
      .map(([folder, items]) => ({ folder, items: [...items].sort((a, b) => a.path.localeCompare(b.path)) }));
  }, [entries]);

  return (
    <SectionCard title="Entries" description="Files in this store, by folder." flush>
      {/* Both filters are sent to the server. */}
      <div className="flex items-center gap-2 border-b border-border px-5 py-3">
        <div className="relative min-w-0 flex-1">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-fg-subtle" />
          <Input
            value={pathPrefix}
            onChange={(e) => setPathPrefix(e.target.value)}
            placeholder="Filter by path, for example /policies/"
            aria-label="Filter by path prefix"
            spellCheck={false}
            autoComplete="off"
            className="h-8 rounded-full pl-8 text-small-size md:text-small-size"
          />
        </div>
        <Tip label={pathPrefix ? "How many folder levels below the prefix to include" : "Type a path prefix first"}>
          <span className="shrink-0">
            <Input
              value={depth}
              onChange={(e) => setDepth(e.target.value.replace(/[^0-9]/g, ""))}
              placeholder="Depth"
              aria-label="Depth filter"
              inputMode="numeric"
              disabled={!pathPrefix}
              className="h-8 w-[76px] rounded-full px-3 text-center text-small-size md:text-small-size"
            />
          </span>
        </Tip>
      </div>
      {error && entries.length === 0 ? (
        <div className="p-5">
          <ErrorState compact title="Entries could not be loaded" error={error} retry={() => void refetch()} />
        </div>
      ) : isLoading ? (
        <ul aria-hidden="true">
          {[0, 1, 2, 3, 4].map((i) => (
            <li key={i} className="flex h-[52px] items-center gap-3 border-t border-border px-5 first:border-t-0">
              <Skeleton className="size-8 shrink-0" rounded="lg" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-3" rounded="sm" style={{ width: `${24 + ((i * 11) % 22)}%` }} />
                <Skeleton className="h-2.5" rounded="sm" style={{ width: `${34 + ((i * 7) % 20)}%` }} />
              </div>
              <Skeleton className="h-3 w-10" rounded="sm" />
            </li>
          ))}
        </ul>
      ) : entries.length === 0 ? (
        filtered ? (
          <EmptyState
            size="md"
            variant="plain"
            icon={<FolderIcon />}
            title="No entries under that path"
            body="Paths start with a slash and are matched from the beginning."
            action={
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setPathPrefix("");
                  setDepth("");
                }}
              >
                Clear filter
              </Button>
            }
          />
        ) : (
          <EmptyState
            kind="memory"
            size="md"
            variant="plain"
            title="Nothing remembered yet"
            body={
              archived
                ? "This store was archived while it was empty."
                : "Agents write here as they work, when memory is on. You can also add an entry yourself: a policy, a preference, a fact worth keeping."
            }
            action={
              !archived && (
                <Button variant="secondary" size="sm" onClick={onNew}>
                  <PlusIcon data-icon="inline-start" />
                  New entry
                </Button>
              )
            }
          />
        )
      ) : (
        <>
          <div className={cn(ROW, "h-9 border-b border-border px-5 text-xs font-medium text-fg-subtle")}>
            <span>Name</span>
            <span className="text-right">Size</span>
            <span>Updated</span>
          </div>
          {groups.map((g) => (
            <section key={g.folder || "/"}>
              <h4 className="flex h-9 items-center gap-2 border-t border-border bg-bg-inset/60 px-5 text-xs font-medium text-fg-muted first:border-t-0">
                <FolderIcon className="size-3.5 text-fg-subtle" />
                <span className="font-mono text-micro-size">/{g.folder}</span>
                <span className="font-normal text-fg-subtle">{g.items.length}</span>
              </h4>
              <ul>
                {g.items.map((m) => (
                  <li key={m.id} className="border-t border-border">
                    <button
                      type="button"
                      onClick={() => setOpen(m)}
                      className={cn(ROW, "h-[52px] w-full px-5 text-left transition-quick hover:bg-bg-hover")}
                    >
                      <span className="flex min-w-0 items-center gap-3">
                        <EntityAvatar icon={FileTextIcon} size="md" />
                        <span className="min-w-0">
                          <span className="block truncate text-small-size font-medium text-fg" title={m.path}>
                            {baseName(m.path)}
                          </span>
                          <span className="block truncate font-mono text-micro-size text-fg-subtle">{m.path}</span>
                        </span>
                      </span>
                      <span className="text-right text-small text-fg-muted">{formatBytes(m.size_bytes)}</span>
                      <RelativeTime value={m.updated_at} className="text-small text-fg-muted" />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </>
      )}

      <MemoryEntrySheet
        storeId={storeId}
        item={open}
        archived={archived}
        onClose={() => setOpen(null)}
        onChanged={() => {
          void refetch();
          onChanged();
        }}
      />
    </SectionCard>
  );
}

// ── History (store-wide audit trail) ────────────────────────────────

function HistoryPanel({ storeId }: { storeId: string }) {
  const versions = useQuietQuery<{ data: MemoryVersion[] }>(`/v1/memory_stores/${storeId}/memory_versions`);
  const list = versions.data?.data ?? [];

  return (
    <SectionCard title="History" description="Every write to this store, newest first." flush>
      {versions.isLoading ? (
        <ul aria-hidden="true">
          {[0, 1, 2, 3].map((i) => (
            <li key={i} className="flex h-[52px] items-center gap-4 border-t border-border px-5 first:border-t-0">
              <Skeleton className="h-3 w-16" rounded="sm" />
              <Skeleton className="h-3 flex-1" rounded="sm" style={{ maxWidth: `${40 + i * 8}%` }} />
              <Skeleton className="h-3 w-14" rounded="sm" />
            </li>
          ))}
        </ul>
      ) : versions.missing ? (
        <EmptyState
          size="md"
          variant="plain"
          icon={<HistoryIcon />}
          title="History is not kept on this server"
          body="This runtime stores the current content of each entry, without a record of earlier versions."
        />
      ) : versions.error ? (
        <div className="p-5">
          <ErrorState compact title="History could not be loaded" error={versions.error} retry={() => void versions.refetch()} />
        </div>
      ) : list.length === 0 ? (
        <EmptyState
          size="md"
          variant="plain"
          icon={<HistoryIcon />}
          title="No history yet"
          body="Each time an entry is created, edited or deleted, it is recorded here."
        />
      ) : (
        <ul>
          {list.map((v) => (
            <li
              key={v.id}
              className="grid min-h-[52px] grid-cols-[104px_minmax(0,1fr)_96px] items-center gap-x-4 border-t border-border px-5 py-2 first:border-t-0"
            >
              <OperationBadge version={v} />
              <div className="min-w-0">
                <div className="truncate font-mono text-xs text-fg" title={v.path}>
                  {v.path ?? "Path not recorded"}
                </div>
                <div className="mt-0.5 flex items-center gap-1.5 text-xs text-fg-subtle">
                  <Actor actor={v.actor} />
                  {v.size_bytes != null && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span>{formatBytes(v.size_bytes)}</span>
                    </>
                  )}
                </div>
              </div>
              <RelativeTime value={v.created_at} className="text-small text-fg-muted" />
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
