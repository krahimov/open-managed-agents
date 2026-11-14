import { useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router";
import {
  ArchiveIcon,
  BanIcon,
  BoxIcon,
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  GlobeIcon,
  MessageSquarePlusIcon,
  PackageIcon,
  PencilIcon,
  PlusIcon,
  ServerIcon,
  ShieldCheckIcon,
  Trash2Icon,
} from "lucide-react";

import { ApiError, useApi } from "../lib/api";
import { copyText } from "../lib/clipboard";
import { plural } from "../lib/format";
import { startSession } from "../lib/shell-events";
import { useApiQuery, useQueryClient } from "../lib/useApiQuery";
import { AgentAvatar, EntityAvatar } from "../components/AgentAvatar";
import { Chip, StatusBadge } from "../components/Badge";
import { Callout } from "../components/Callout";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { DetailHeader } from "../components/DetailHeader";
import { EmptyState, RecordNotFound } from "../components/EmptyState";
import { EntityRef } from "../components/EntityRef";
import { CodeWell } from "../components/EventCard";
import { CopyButton, IdChip } from "../components/IdChip";
import { Page } from "../components/Page";
import { Property, PropertyList } from "../components/PropertyList";
import { ErrorState } from "../components/QueryProblem";
import { RelativeTime } from "../components/RelativeTime";
import { RowActionsMenu } from "../components/RowActionsMenu";
import { SectionCard } from "../components/SectionCard";
import { SkeletonDetail } from "../components/Skeleton";
import { EnvironmentEditDialog, type EnvironmentEditTab } from "../components/resources/EnvironmentEditDialog";
import {
  memoryMounts,
  networkSummary,
  packageSummary,
  providerLabel,
  type Environment,
} from "../components/resources/environment";
import { formatBytes } from "../components/resources/ResourceBits";
import { UsedByList, useResourceUsage } from "../components/resources/usage";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** Label column for the narrow aside, so a full id fits beside it. */
// The aside's label column: the same width as PropertyList labelWidth="narrow".
const ASIDE_ROW = "grid-cols-[6.5rem_minmax(0,1fr)]";

/** A mono token in a wrapping list: a package spec, a host. */
function Token({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-6 max-w-full items-center rounded-md bg-bg-soft px-2 font-mono text-micro-size text-fg-muted">
      <span className="truncate">{children}</span>
    </span>
  );
}

/** "Allowed" / "Blocked" as a quiet fact. It is a setting, not a state, so it wears no status colour. */
function Allowed({ value, yes = "Allowed", no = "Blocked" }: { value: boolean; yes?: string; no?: string }) {
  const Icon = value ? CheckIcon : BanIcon;
  return (
    <span className="inline-flex items-center gap-1.5">
      <Icon className="size-3.5 text-fg-subtle" />
      {value ? yes : no}
    </span>
  );
}

/**
 * Environment — the record of one sandbox. The header says what it is in
 * a glance (runtime, image, lifetime, network, size); the cards read the
 * configuration back as facts; every card's Edit opens the one edit
 * dialog on the matching tab. "Start session" picks from the agents that
 * already run here.
 */
export function EnvironmentDetail() {
  const { id } = useParams<{ id: string }>();
  const { api } = useApi();
  const nav = useNavigate();
  const queryClient = useQueryClient();
  const usage = useResourceUsage();

  const { data: env, error, isLoading, refetch } = useApiQuery<Environment>(id ? `/v1/environments/${id}` : null);

  const [editTab, setEditTab] = useState<EnvironmentEditTab | null>(null);
  const [confirm, setConfirm] = useState<"archive" | "delete" | null>(null);

  if (error && !env) {
    const missing = error instanceof ApiError && error.status === 404;
    return (
      <Page>
        {missing ? (
          <RecordNotFound thing="environment" kind="env" back={{ to: "/environments", label: "environments" }} className="mt-4" />
        ) : (
          <ErrorState title="This environment could not be loaded" error={error} retry={() => void refetch()} className="mt-4" />
        )}
      </Page>
    );
  }
  if (isLoading || !env) {
    return (
      <Page>
        <SkeletonDetail />
      </Page>
    );
  }

  const archived = !!env.archived_at;
  const sandbox = env.config.sandbox ?? {};
  const net = networkSummary(env);
  const packages = packageSummary(env);
  const persistent = sandbox.ephemeral === false;
  const bootstrap = sandbox.bootstrap_tools ?? true;
  const mounts = memoryMounts(env);
  // Outputs are attached unless the config turns them off; only worth a
  // row when the config says something about them.
  const outputs = env.config.resources?.outputs;
  const metadata = Object.entries(env.metadata ?? {});
  const agents = usage.environments.get(env.id) ?? [];

  const startWith = (agentId: string) => startSession({ agentId, environmentId: env.id });
  const edit = (tab: EnvironmentEditTab) => (
    <Button size="sm" variant="ghost" onClick={() => setEditTab(tab)}>
      <PencilIcon data-icon="inline-start" />
      Edit
    </Button>
  );

  // The primary action: start a session here, with one of the agents
  // whose default environment this is.
  // "Start session here": the session starter opens over this page, on this
  // environment, with an agent that already runs here or with any other.
  const startElsewhere = () => startSession({ environmentId: env.id });
  const primary = archived ? null : agents.length === 0 ? (
    <Button onClick={startElsewhere}>
      <MessageSquarePlusIcon data-icon="inline-start" />
      Start session here
    </Button>
  ) : (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button>
          <MessageSquarePlusIcon data-icon="inline-start" />
          Start session here
          <ChevronDownIcon data-icon="inline-end" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6} className="w-64">
        <DropdownMenuLabel>With an agent that runs here</DropdownMenuLabel>
        {agents.map((a) => (
          <DropdownMenuItem key={a.id} onSelect={() => startWith(a.id)}>
            <AgentAvatar name={a.name} id={a.id} size="xs" />
            <span className="truncate">{a.name}</span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={startElsewhere}>
          <PlusIcon />
          Another agent…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <Page>
      <DetailHeader
        avatar={<EntityAvatar icon={BoxIcon} size="xl" />}
        title={env.name}
        status={
          archived ? (
            <StatusBadge status="archived" variant="soft" />
          ) : env.status === "error" ? (
            <StatusBadge status="error" label="Build failed" variant="soft" />
          ) : env.status === "building" ? (
            <StatusBadge status="provisioning" label="Building" variant="soft" />
          ) : undefined
        }
        description={env.description?.trim() || <span className="text-fg-subtle">No description yet.</span>}
        meta={
          <>
            <Chip icon={ServerIcon}>{providerLabel(sandbox.provider)}</Chip>
            <Chip>{persistent ? "Kept between sessions" : "Fresh every session"}</Chip>
            <Chip icon={net.limited ? ShieldCheckIcon : GlobeIcon} title={net.hosts.join(", ") || undefined}>
              {net.label}
            </Chip>
            {packages.total > 0 && <Chip icon={PackageIcon}>{plural(packages.total, "package")}</Chip>}
          </>
        }
        actions={
          <>
            <Button variant="outline" onClick={() => setEditTab("details")}>
              <PencilIcon data-icon="inline-start" />
              Edit
            </Button>
            {primary}
          </>
        }
        menu={
          <RowActionsMenu
            label={`Actions for ${env.name}`}
            actions={[
              { label: "Copy environment id", icon: <CopyIcon />, onSelect: () => void copyText(env.id) },
              { label: "Archive", icon: <ArchiveIcon />, disabled: archived, onSelect: () => setConfirm("archive") },
              { label: "Delete", icon: <Trash2Icon />, destructive: true, onSelect: () => setConfirm("delete") },
            ]}
          />
        }
      />

      {archived && (
        <Callout tone="neutral" icon={ArchiveIcon} title="This environment is archived" className="mb-6">
          It is kept out of the active list. Sessions that already ran here keep their history.
        </Callout>
      )}
      {env.status === "error" && env.build_error && (
        <Callout tone="danger" title="The last build failed" className="mb-6">
          <span className="font-mono text-xs break-words">{env.build_error}</span>
        </Callout>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-4">
          <SectionCard title="Sandbox" description="What a session starts from." actions={edit("sandbox")}>
            <PropertyList columns={2}>
              <Property label="Image" empty="Provider default" className="sm:col-span-2">
                {sandbox.image ? (
                  <span className="inline-flex max-w-full items-center gap-0.5">
                    <span className="truncate font-mono text-xs" title={sandbox.image}>
                      {sandbox.image}
                    </span>
                    <CopyButton value={sandbox.image} label="Copy image" className="size-6" />
                  </span>
                ) : null}
              </Property>
              <Property label="Provider">{providerLabel(sandbox.provider)}</Property>
              <Property label="Lifetime">{persistent ? "Kept between sessions" : "Deleted when it stops"}</Property>
              <Property label="Working directory">
                <span className="font-mono text-xs">{sandbox.workdir || "/workspace"}</span>
              </Property>
              <Property label="Largest file">
                {sandbox.max_file_bytes ? formatBytes(sandbox.max_file_bytes) : "512 MB"}
                {!sandbox.max_file_bytes && <span className="text-fg-subtle"> (default)</span>}
              </Property>
              <Property label="Coding tools">
                <Allowed value={bootstrap} yes="Installed at start" no="Not installed" />
              </Property>
            </PropertyList>
            {(sandbox.bootstrap_apt_packages?.length ?? 0) > 0 && (
              <div className="mt-3 border-t border-border pt-3.5">
                <p className="text-small text-fg-subtle">Installed at start</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {sandbox.bootstrap_apt_packages!.map((p) => (
                    <Token key={p}>{p}</Token>
                  ))}
                </div>
              </div>
            )}
          </SectionCard>

          <SectionCard
            title="Packages"
            description={
              packages.total > 0
                ? `${plural(packages.total, "package")} installed when the sandbox is built.`
                : "Installed when the sandbox is built."
            }
            actions={edit("packages")}
            flush={packages.total > 0}
          >
            {packages.total === 0 ? (
              <EmptyState
                size="sm"
                variant="plain"
                icon={<PackageIcon />}
                title="No packages"
                body="The sandbox has only what its image ships with."
                action={
                  <Button size="sm" variant="secondary" onClick={() => setEditTab("packages")}>
                    Add packages
                  </Button>
                }
                className="py-6"
              />
            ) : (
              <ul>
                {packages.groups.map((g) => (
                  <li key={g.manager} className="flex items-start gap-4 border-t border-border px-5 py-3.5 first:border-t-0">
                    <div className="flex w-20 shrink-0 items-center gap-2 pt-0.5">
                      <span className="font-mono text-xs font-medium text-fg">{g.manager}</span>
                      <span className="text-xs text-fg-subtle">{g.packages.length}</span>
                    </div>
                    <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
                      {g.packages.map((p) => (
                        <Token key={p}>{p}</Token>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {env.config.dockerfile && (
              <div className={packages.total > 0 ? "border-t border-border px-5 py-4" : "mt-4"}>
                <div className="mb-1.5 flex h-6 items-center justify-between">
                  <p className="text-small text-fg-subtle">Extra build steps</p>
                  <CopyButton value={env.config.dockerfile} label="Copy build steps" className="size-6" />
                </div>
                <CodeWell>{env.config.dockerfile}</CodeWell>
              </div>
            )}
          </SectionCard>

          <SectionCard title="Network" description="What the sandbox may reach." actions={edit("network")}>
            <div className="flex items-start gap-3">
              <EntityAvatar icon={net.limited ? ShieldCheckIcon : GlobeIcon} size="lg" />
              <div className="min-w-0 pt-0.5">
                <p className="text-small-size font-medium text-fg">
                  {net.limited ? "Limited outbound access" : "Unrestricted outbound access"}
                </p>
                <p className="mt-0.5 text-small text-fg-muted">
                  {net.limited
                    ? net.hosts.length > 0
                      ? `Only ${net.hosts.length === 1 ? "this host" : `these ${net.hosts.length} hosts`} can be reached.`
                      : "No hosts are allowed yet, so nothing outside can be reached."
                    : "The sandbox can reach any host on the internet."}
                </p>
              </div>
            </div>
            {net.limited && net.hosts.length > 0 && (
              <div className="mt-3.5 flex flex-wrap gap-1.5">
                {net.hosts.map((h) => (
                  <Token key={h}>{h}</Token>
                ))}
              </div>
            )}
            <div className="mt-4 border-t border-border pt-2.5">
              <PropertyList columns={2}>
                <Property label="MCP servers">
                  <Allowed value={!!env.config.networking?.allow_mcp_servers} />
                </Property>
                <Property label="Package registries">
                  <Allowed value={!!env.config.networking?.allow_package_managers} />
                </Property>
              </PropertyList>
            </div>
          </SectionCard>

          {(mounts.length > 0 || outputs === false) && (
            <SectionCard
              title="Mounts"
              description="Attached to every session that starts in this environment."
              flush
            >
              <ul>
                {mounts.map((m) => (
                  <li key={m.storeId} className="flex items-start gap-4 border-t border-border px-5 py-3.5 first:border-t-0">
                    <div className="min-w-0 flex-1">
                      <EntityRef kind="memory_store" id={m.storeId} />
                      {m.instructions && <p className="mt-1 text-small text-fg-muted">{m.instructions}</p>}
                    </div>
                    <Chip>{m.readOnly ? "Read only" : "Read and write"}</Chip>
                  </li>
                ))}
                <li className="flex items-center gap-4 border-t border-border px-5 py-3.5 first:border-t-0">
                  <div className="min-w-0 flex-1">
                    <p className="text-small-size font-medium text-fg">Session outputs</p>
                    <p className="mt-0.5 text-small text-fg-muted">
                      {outputs === false
                        ? "The outputs folder is not attached in this environment."
                        : "The outputs folder is attached, as it is by default."}
                    </p>
                  </div>
                  <Chip>{outputs === false ? "Off" : "Attached"}</Chip>
                </li>
              </ul>
            </SectionCard>
          )}

          <SectionCard title="Metadata" description="Your own labels." actions={edit("metadata")}>
            {metadata.length === 0 ? (
              <p className="text-small text-fg-subtle">No metadata yet.</p>
            ) : (
              <PropertyList columns={2}>
                {metadata.map(([k, v]) => (
                  <Property key={k} label={<span className="font-mono text-xs">{k}</span>}>
                    <span className="break-words">{typeof v === "string" ? v : JSON.stringify(v)}</span>
                  </Property>
                ))}
              </PropertyList>
            )}
          </SectionCard>
        </div>

        <aside className="min-w-0 space-y-4">
          <SectionCard title="Used by" description={agents.length > 0 ? `${plural(agents.length, "agent")} ${agents.length === 1 ? "runs" : "run"} here by default.` : undefined}>
            <UsedByList
              agents={usage.environments.get(env.id)}
              loading={usage.isLoading}
              empty={
                archived
                  ? "No agent uses this environment."
                  : "No agent uses this environment yet. Choose it as an agent's environment and its sessions start here."
              }
            />
          </SectionCard>
          <SectionCard title="Details">
            <PropertyList>
              <Property label="Hosting" className={ASIDE_ROW}>
                {env.config.type === "cloud" ? "Cloud" : env.config.type}
              </Property>
              <Property label="Created" className={ASIDE_ROW}>
                <RelativeTime value={env.created_at} />
              </Property>
              <Property label="Updated" className={ASIDE_ROW}>
                <RelativeTime value={env.updated_at ?? env.created_at} />
              </Property>
              {archived && (
                <Property label="Archived" className={ASIDE_ROW}>
                  <RelativeTime value={env.archived_at} />
                </Property>
              )}
              <Property label="Environment id" className={ASIDE_ROW}>
                <IdChip id={env.id} full />
              </Property>
            </PropertyList>
          </SectionCard>
        </aside>
      </div>

      <EnvironmentEditDialog
        env={env}
        open={editTab !== null}
        tab={editTab ?? "details"}
        onClose={() => setEditTab(null)}
        onSaved={() => {
          void refetch();
          void queryClient.invalidateQueries({ queryKey: ["/v1/environments"] });
        }}
      />

      <ConfirmDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        destructive={confirm === "delete"}
        title={confirm === "delete" ? `Delete ${env.name}?` : `Archive ${env.name}?`}
        body={
          confirm === "delete"
            ? `The environment is removed. ${agents.length > 0 ? `${plural(agents.length, "agent")} ${agents.length === 1 ? "uses" : "use"} it by default. ` : ""}This cannot be undone.`
            : "Archived environments move out of the active list. Sessions that already ran here keep their history."
        }
        confirmLabel={confirm === "delete" ? "Delete environment" : "Archive environment"}
        onConfirm={async () => {
          if (confirm === "delete") {
            await api(`/v1/environments/${env.id}`, { method: "DELETE" });
          } else {
            await api(`/v1/environments/${env.id}/archive`, { method: "POST", body: "{}" });
          }
          void queryClient.invalidateQueries({ queryKey: ["/v1/environments"] });
          nav("/environments");
        }}
      />
    </Page>
  );
}
