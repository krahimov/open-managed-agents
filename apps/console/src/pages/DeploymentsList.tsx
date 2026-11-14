import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import {
  CopyIcon,
  GlobeIcon,
  KeyRoundIcon,
  PauseCircleIcon,
  PlayCircleIcon,
  PlusIcon,
  RocketIcon,
  Trash2Icon,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { PopoverContent } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { copyText } from "@/lib/clipboard";

import { useApi } from "../lib/api";
import { useAgents, useEntityName } from "../lib/directory";
import { countWords, toDate } from "../lib/format";
import { useInfiniteApiQuery } from "../lib/useApiQuery";
import { useLocalSearch } from "../lib/useLocalSearch";
import { AgentAvatar } from "../components/AgentAvatar";
import { RowLink } from "../components/DataTable";
import { OverflowTip } from "../components/OverflowTip";
import { Skeleton } from "../components/Skeleton";
import { Tip } from "../components/Tip";
import {
  CreateDeploymentDialog,
  DeploymentKeyModal,
  deploymentSnippet,
  type Deployment,
} from "../components/CreateDeploymentDialog";
import {
  Chip,
  CodeWell,
  ConfirmDialog,
  DataTable,
  EntityAvatar,
  EntityRef,
  ErrorState,
  EventSection,
  FacetedFilter,
  FilterChip,
  IdChip,
  Page,
  PageHeader,
  Property,
  PropertyList,
  RelativeTime,
  RowActionsMenu,
  StatusBadge,
  type ColumnDef,
  type RowAction,
} from "../components/kit";

const SUBTITLE = "Agents published behind a key, so your own frontend can talk to them.";

/** "example.com" from "https://example.com". Falls back to the raw value. */
function originHost(origin: string): string {
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin;
  }
}

/**
 * Who may call a deployment, in a cell: "Any origin", or the first host
 * whole with "and 2 more" under it. The rest are one hover or one Tab
 * away, and the row's panel lists every origin.
 */
function Origins({ origins }: { origins: string[] | null }) {
  if (!origins || origins.length === 0) return <span className="text-fg-subtle">Any origin</span>;
  const hosts = origins.map(originHost);
  const rest = hosts.slice(1);
  return (
    <div className="min-w-0 leading-tight">
      <div className="flex min-w-0">
        <OverflowTip label={hosts[0]} focusable>
          <span className="min-w-0 truncate rounded-sm text-fg-muted">{hosts[0]}</span>
        </OverflowTip>
      </div>
      {rest.length > 0 && (
        <Tip
          label={
            <span className="block">
              {rest.map((h) => (
                <span key={h} className="block">
                  {h}
                </span>
              ))}
            </span>
          }
        >
          <span tabIndex={0} className="rounded-sm text-xs text-fg-subtle">
            and {rest.length} more
          </span>
        </Tip>
      )}
    </div>
  );
}

/**
 * Where a deployment runs. Environment names are long ("Cloud sandbox —
 * Node 22 + Python 3.12"), so the name wraps onto a second line instead
 * of being cut; a name longer than two lines can be read in full on hover
 * and on focus.
 */
function EnvironmentCell({ id }: { id: string | null }) {
  const { name, isLoading } = useEntityName("environment", id);
  if (!id) {
    return (
      <Tip label="Sessions run in the agent's default environment">
        <span className="text-fg-subtle">Agent default</span>
      </Tip>
    );
  }
  if (isLoading) return <Skeleton className="h-3.5 w-28" rounded="sm" />;
  if (!name) return <span className="text-fg-subtle italic">Deleted environment</span>;
  return (
    <OverflowTip label={name}>
      <Link
        to={`/environments/${id}`}
        className="line-clamp-2 rounded-sm leading-[1.35] text-pretty whitespace-normal text-fg-muted decoration-border-strong underline-offset-4 hover:text-fg hover:underline"
      >
        {name}
      </Link>
    </OverflowTip>
  );
}

type Pending = { kind: "rotate" | "delete"; deployment: Deployment };

type StatusValue = "any" | "active" | "disabled";

const STATUS_OPTIONS: { value: StatusValue; label: string }[] = [
  { value: "any", label: "All" },
  { value: "active", label: "Active" },
  { value: "disabled", label: "Disabled" },
];

/**
 * Deployments: agents published for direct use from a frontend. Each row
 * is one publishable key: which agent it reaches (the row wears that
 * agent's face, as a session does), where it runs, who may call it and
 * whether it is switched on. Nothing is cut at 1280: the agent sits under
 * the name, an environment's name wraps, and the first origin is whole
 * with a count of the rest. A row opens the deployment in a
 * side panel (the full origin list, the integration snippet, its id).
 * Creating one is the page's primary action; rotating a key, switching a
 * deployment off and deleting it are in the row menu, and the two that
 * cannot be undone ask first.
 */
export function DeploymentsList() {
  const { api } = useApi();
  const [showCreate, setShowCreate] = useState(false);
  const [rotatedKey, setRotatedKey] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const { byId: agentsById, isLoading: agentsLoading } = useAgents();

  const {
    items: deployments,
    isLoading: loading,
    hasMore,
    isLoadingMore,
    loadMore,
    refresh: load,
    error,
  } = useInfiniteApiQuery<Deployment>("/v1/deployments", {});

  // The same toolbar as every other list: search, then filters. The
  // endpoint has neither, so both narrow the loaded rows (and the rest are
  // loaded while a search or a filter is on, so "no match" is about all of
  // them). A deployment is found by its name, its agent or a site it serves.
  const [status, setStatus] = useState<StatusValue>("any");
  const ofStatus = useMemo(
    () => (status === "any" ? deployments : deployments.filter((d) => (status === "disabled") === !!d.disabled)),
    [deployments, status],
  );
  const found = useLocalSearch(ofStatus, (d) => [d.name, agentsById.get(d.agent_id)?.name, ...(d.allowed_origins ?? [])], {
    hasMore,
    isLoadingMore,
    loadMore,
  });
  useEffect(() => {
    if (status !== "any" && hasMore && !isLoadingMore) loadMore();
  }, [status, hasMore, isLoadingMore, loadMore]);
  const filtered = found.searching || status !== "any";
  const clearFilters = () => {
    found.setSearch("");
    setStatus("any");
  };

  const setDisabled = async (d: Deployment, disabled: boolean) => {
    try {
      await api(`/v1/deployments/${d.id}`, { method: "POST", body: JSON.stringify({ disabled }) });
      toast.success(disabled ? "Deployment switched off" : "Deployment switched on");
      load();
    } catch {
      // The API client already raised a toast.
    }
  };

  const actionsFor = (d: Deployment): RowAction[] => [
    { label: "Copy deployment id", icon: <CopyIcon />, onSelect: () => void copyText(d.id) },
    { label: "Rotate key", icon: <KeyRoundIcon />, onSelect: () => setPending({ kind: "rotate", deployment: d }) },
    {
      label: d.disabled ? "Enable" : "Disable",
      icon: d.disabled ? <PlayCircleIcon /> : <PauseCircleIcon />,
      onSelect: () => void setDisabled(d, !d.disabled),
    },
    { label: "Delete", icon: <Trash2Icon />, destructive: true, onSelect: () => setPending({ kind: "delete", deployment: d }) },
  ];

  const columns = useMemo<ColumnDef<Deployment>[]>(
    () => [
      {
        id: "name",
        accessorKey: "name",
        header: "Deployment",
        size: 320,
        minSize: 240,
        enableHiding: false,
        enableSorting: true,
        cell: ({ row }) => {
          const d = row.original;
          const agent = agentsById.get(d.agent_id);
          return (
            <div className="flex min-w-0 items-center gap-3">
              <AgentAvatar name={agent?.name ?? "?"} id={d.agent_id} size="md" archived={d.disabled || !!agent?.archived_at} />
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <RowLink className={d.disabled ? "font-medium text-fg-muted" : "font-medium text-fg"}>{d.name}</RowLink>
                  {d.agent_version !== null && (
                    <Tip label={`Pinned to version ${d.agent_version} of the agent. Without a pin a deployment follows the latest.`}>
                      <span className="inline-flex shrink-0">
                        <Chip tone="outline" mono>
                          v{d.agent_version}
                        </Chip>
                      </span>
                    </Tip>
                  )}
                </div>
                {/* The row opens the panel; the reference goes to the agent. */}
                <div className="flex min-w-0 text-xs">
                  {agent || agentsLoading ? (
                    <EntityRef
                      kind="agent"
                      id={d.agent_id}
                      name={agent?.name}
                      avatar={false}
                      className="text-xs font-normal text-fg-subtle"
                    />
                  ) : (
                    <span className="truncate text-fg-subtle italic">Deleted agent</span>
                  )}
                </div>
              </div>
            </div>
          );
        },
      },
      {
        id: "environment",
        accessorFn: (d) => d.environment_id ?? "",
        header: "Environment",
        size: 250,
        cell: ({ row }) => <EnvironmentCell id={row.original.environment_id} />,
      },
      {
        id: "origins",
        accessorFn: (d) => (d.allowed_origins ?? []).join(","),
        header: "Allowed origins",
        size: 170,
        meta: { hideBelow: 720 },
        cell: ({ row }) => <Origins origins={row.original.allowed_origins} />,
      },
      {
        id: "key",
        accessorKey: "key_prefix",
        header: "Key",
        size: 130,
        // Also in the row's panel: the first to go on a narrow table.
        meta: { hideBelow: 1040 },
        cell: ({ row }) => (
          <Tip label="A publishable key. Only its first characters are kept.">
            <span className="font-mono text-xs text-fg-muted">{row.original.key_prefix}…</span>
          </Tip>
        ),
      },
      {
        id: "status",
        accessorFn: (d) => (d.disabled ? "disabled" : "active"),
        header: "Status",
        size: 110,
        cell: ({ row }) => <StatusBadge status={row.original.disabled ? "disabled" : "active"} />,
      },
      {
        id: "created",
        accessorFn: (d) => toDate(d.created_at)?.getTime(),
        header: "Created",
        size: 100,
        enableSorting: true,
        sortDescFirst: true,
        cell: ({ row }) => <RelativeTime value={row.original.created_at} className="text-fg-muted" fallback="Unknown" />,
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
    [api, load, agentsById, agentsLoading],
  );

  const dialogs = (
    <>
      <CreateDeploymentDialog open={showCreate} onClose={() => setShowCreate(false)} />

      <DeploymentKeyModal open={!!rotatedKey} onClose={() => setRotatedKey("")} deploymentKey={rotatedKey} title="Key rotated" />

      <ConfirmDialog
        open={!!pending}
        onClose={() => setPending(null)}
        destructive={pending?.kind === "delete"}
        title={
          pending?.kind === "delete"
            ? `Delete ${pending.deployment.name}?`
            : `Rotate the key for ${pending?.deployment.name ?? "this deployment"}?`
        }
        body={
          pending?.kind === "delete"
            ? "Its key stops working immediately, so any frontend using it loses access. This cannot be undone."
            : "The current key stops working immediately. The new key is shown once, so have your frontend's configuration ready."
        }
        confirmLabel={pending?.kind === "delete" ? "Delete deployment" : "Rotate key"}
        onConfirm={async () => {
          if (!pending) return;
          const d = pending.deployment;
          if (pending.kind === "delete") {
            await api(`/v1/deployments/${d.id}`, { method: "DELETE" });
            toast.success("Deployment deleted");
            if (openId === d.id) setOpenId(null);
          } else {
            const res = await api<Deployment & { key: string }>(`/v1/deployments/${d.id}/rotate_key`, {
              method: "POST",
              body: "{}",
            });
            setRotatedKey(res.key);
          }
          load();
        }}
      />
    </>
  );

  // A failed first read replaces the table: never an empty state for an error.
  if (error && deployments.length === 0) {
    return (
      <Page
        width="wide"
        header={
          <PageHeader
            title="Deployments"
            subtitle={SUBTITLE}
            width="wide"
            actions={
              <Button onClick={() => setShowCreate(true)} aria-label="+ New deployment">
                <PlusIcon data-icon="inline-start" className="stroke-[2.25]" />
                New deployment
              </Button>
            }
          />
        }
      >
        <ErrorState title="Deployments could not be loaded" error={error} retry={load} />
        {dialogs}
      </Page>
    );
  }

  const open = openId ? (deployments.find((d) => d.id === openId) ?? null) : null;

  return (
    <DataTable<Deployment>
      title="Deployments"
      subtitle={SUBTITLE}
      createLabel="+ New deployment"
      onCreate={() => setShowCreate(true)}
      searchPlaceholder="Search deployments"
      searchValue={found.search}
      onSearchChange={found.setSearch}
      filters={
        <FilterChip
          label="Status"
          active={status !== "any"}
          display={status === "any" ? undefined : STATUS_OPTIONS.find((o) => o.value === status)?.label}
          onClear={() => setStatus("any")}
        >
          <PopoverContent align="start" sideOffset={6} collisionPadding={8} className="w-52 gap-0 p-0">
            <FacetedFilter options={STATUS_OPTIONS} value={status} onValueChange={(v) => setStatus(v as StatusValue)} searchPlaceholder="Status" />
          </PopoverContent>
        </FilterChip>
      }
      summary={
        loading || found.rows.length === 0
          ? undefined
          : countWords(found.rows.length, hasMore, "deployment")
      }
      data={found.rows}
      filtered={filtered}
      loading={loading}
      getRowId={(d) => d.id}
      onRowClick={(d) => setOpenId(d.id)}
      hasMore={hasMore}
      loadingMore={isLoadingMore}
      onLoadMore={loadMore}
      emptyIcon={<RocketIcon />}
      emptyTitle={found.searching ? `No deployments match “${found.query}”` : filtered ? "No deployments match" : "No deployments yet"}
      emptySubtitle={
        found.searching
          ? "Deployments are searched by name, by agent and by the sites they serve."
          : filtered
            ? "Choose another status to see more."
            : "A deployment gives one agent a publishable key. Put the key in your website or app and visitors can chat with the agent, with no server of yours in between."
      }
      emptyAction={
        filtered ? (
          <Button variant="outline" onClick={clearFilters}>
            {found.searching && status === "any" ? "Clear search" : "Clear filters"}
          </Button>
        ) : (
          <Button onClick={() => setShowCreate(true)} aria-label="Create a deployment">
            New deployment
          </Button>
        )
      }
      columns={columns}
    >
      {dialogs}
      <DeploymentSheet
        deployment={open}
        onClose={() => setOpenId(null)}
        onRotate={(d) => setPending({ kind: "rotate", deployment: d })}
        onToggle={(d) => void setDisabled(d, !d.disabled)}
        onDelete={(d) => setPending({ kind: "delete", deployment: d })}
      />
    </DataTable>
  );
}

/**
 * One deployment, inspected without leaving the list: what it reaches,
 * who may call it, and how to use its key. The key itself is shown only
 * when it is created or rotated, so the snippet here carries a
 * placeholder.
 */
function DeploymentSheet({
  deployment,
  onClose,
  onRotate,
  onToggle,
  onDelete,
}: {
  deployment: Deployment | null;
  onClose: () => void;
  onRotate: (d: Deployment) => void;
  onToggle: (d: Deployment) => void;
  onDelete: (d: Deployment) => void;
}) {
  // Keep the last deployment while the panel animates out.
  const [last, setLast] = useState<Deployment | null>(null);
  if (deployment && deployment !== last) setLast(deployment);
  const d = deployment ?? last;
  const snippet = deploymentSnippet("YOUR_PUBLISHABLE_KEY");
  const origins = d?.allowed_origins ?? [];

  return (
    <Sheet open={!!deployment} onOpenChange={(next) => !next && onClose()}>
      <SheetContent
        className="gap-0 outline-none sm:max-w-[480px]"
        tabIndex={-1}
        // Start on the panel itself: focusing the first control would pop
        // its tooltip over the title.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement).focus();
        }}
      >
        {d && (
          <>
            <SheetHeader className="pb-5">
              <div className="flex items-start gap-3.5">
                <EntityAvatar icon={RocketIcon} size="lg" className={d.disabled ? "opacity-60" : undefined} />
                <div className="min-w-0 flex-1">
                  <SheetTitle className="break-words">{d.name}</SheetTitle>
                  <SheetDescription asChild>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <StatusBadge status={d.disabled ? "disabled" : "active"} variant="soft" />
                      <IdChip id={d.id} label="Copy deployment id" />
                    </div>
                  </SheetDescription>
                </div>
              </div>
            </SheetHeader>

            <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-6 pb-6">
              {d.disabled && (
                <p className="rounded-lg bg-bg-soft px-3.5 py-2.5 text-small text-fg-muted">
                  This deployment is switched off. Requests with its key are refused until it is enabled again.
                </p>
              )}

              {/* A narrow panel: a slimmer label column leaves the names room. */}
              <PropertyList labelWidth="narrow">
                <Property label="Agent">
                  <EntityRef kind="agent" id={d.agent_id} />
                </Property>
                <Property label="Version">
                  {d.agent_version !== null ? (
                    <span className="flex items-center gap-2">
                      <Chip tone="outline" mono>
                        v{d.agent_version}
                      </Chip>
                      <span className="text-fg-subtle">Pinned</span>
                    </span>
                  ) : (
                    <span>
                      Latest <span className="text-fg-subtle">· follows the agent</span>
                    </span>
                  )}
                </Property>
                <Property label="Environment">
                  {d.environment_id ? (
                    <EntityRef kind="environment" id={d.environment_id} />
                  ) : (
                    <span className="text-fg-subtle">The agent's default</span>
                  )}
                </Property>
                <Property label="Key">
                  <span className="font-mono text-xs text-fg-muted" title="Only the first characters are kept">
                    {d.key_prefix}…
                  </span>
                </Property>
                <Property label="Created">
                  <RelativeTime value={d.created_at} fallback="Unknown" />
                </Property>
                {d.updated_at && d.updated_at !== d.created_at && (
                  <Property label="Updated">
                    <RelativeTime value={d.updated_at} fallback="Unknown" />
                  </Property>
                )}
              </PropertyList>

              <section>
                <h3 className="text-small leading-5 font-medium text-fg">Allowed origins</h3>
                {origins.length === 0 ? (
                  <p className="mt-1.5 flex items-start gap-2 text-small text-fg-muted">
                    <GlobeIcon className="mt-0.5 size-4 shrink-0 text-fg-subtle" aria-hidden="true" />
                    Any website can use this key. Restrict it by creating a deployment with a list of origins.
                  </p>
                ) : (
                  <>
                    <p className="mt-0.5 text-xs text-fg-subtle">
                      Only pages on {origins.length === 1 ? "this origin" : "these origins"} can use the key.
                    </p>
                    <ul className="mt-2 flex flex-wrap gap-1.5">
                      {origins.map((o) => (
                        <li key={o}>
                          <Chip mono title={o} className="max-w-[26rem]">
                            {o}
                          </Chip>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </section>

              <EventSection label="Use it from your frontend" copy={snippet}>
                <CodeWell className="max-h-64 whitespace-pre">{snippet}</CodeWell>
                <p className="mt-2 text-xs text-fg-subtle">
                  Replace the placeholder with the key you copied when it was created. Lost it? Rotate the key to
                  get a new one.
                </p>
              </EventSection>
            </div>

            <SheetFooter className="flex-row items-center gap-2 py-4">
              <Button variant="outline" onClick={() => onRotate(d)}>
                <KeyRoundIcon data-icon="inline-start" />
                Rotate key
              </Button>
              <Button variant="outline" onClick={() => onToggle(d)}>
                {d.disabled ? <PlayCircleIcon data-icon="inline-start" /> : <PauseCircleIcon data-icon="inline-start" />}
                {d.disabled ? "Enable" : "Disable"}
              </Button>
              <div className="ml-auto">
                <RowActionsMenu
                  label={`More actions for ${d.name}`}
                  actions={[
                    { label: "Copy deployment id", icon: <CopyIcon />, onSelect: () => void copyText(d.id) },
                    { label: "Delete", icon: <Trash2Icon />, destructive: true, onSelect: () => onDelete(d) },
                  ]}
                />
              </div>
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
