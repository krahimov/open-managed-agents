import { useMemo, useState, type ReactNode } from "react";
import { BanIcon, CopyIcon, ExternalLinkIcon, LaptopIcon, PanelRightOpenIcon, PlusIcon, PuzzleIcon, TerminalIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { PopoverContent } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";

import { useApi } from "../lib/api";
import { BRAND_NAME } from "../lib/brand";
import { copyText } from "../lib/clipboard";
import { plural } from "../lib/format";
import { useApiQuery } from "../lib/useApiQuery";
import { EntityAvatar } from "../components/AgentAvatar";
import { Chip, StatusBadge } from "../components/Badge";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { DataTable, type ColumnDef } from "../components/DataTable";
import { Disclosure } from "../components/Disclosure";
import { EmptyState } from "../components/EmptyState";
import { FacetedFilter } from "../components/FacetedFilter";
import { FilterChip } from "../components/FilterChip";
import { IdChip } from "../components/IdChip";
import { Modal } from "../components/Modal";
import { Page } from "../components/Page";
import { PageHeader } from "../components/PageHeader";
import { PropertyList, Property } from "../components/PropertyList";
import { ErrorState } from "../components/QueryProblem";
import { RelativeTime } from "../components/RelativeTime";
import { RowActionsMenu } from "../components/RowActionsMenu";
import { ChipRow, ResourceIdentity } from "../components/resources/ResourceBits";
import { CommandLine } from "../components/settings/CopyField";
import { toMillis } from "../integrations/components/relativeTime";
import { inlineLink } from "@/lib/links";

interface LocalSkill {
  id: string;
  name?: string;
  description?: string;
  source?: "global" | "plugin" | "project";
  source_label?: string;
}

interface Runtime {
  id: string;
  machine_id: string;
  hostname: string;
  os: string;
  agents: Array<{ id: string; binary?: string }>;
  /** Per-acp-agent-id list of skills the daemon detected on the machine
   *  (~/.claude/skills and plugin skills for Claude Code). The source for
   *  the per-agent blocklist (AgentConfig.runtime_binding.local_skill_blocklist). */
  local_skills?: Record<string, LocalSkill[]>;
  version: string;
  status: "online" | "offline";
  last_heartbeat: number | null;
  created_at: number;
}
type RuntimesResponse = { runtimes?: Runtime[]; data?: Runtime[] };

type StatusValue = "any" | "online" | "offline";

const STATUS_OPTIONS: { value: StatusValue; label: string }[] = [
  { value: "any", label: "All" },
  { value: "online", label: "Online" },
  { value: "offline", label: "Offline" },
];

const SETUP_COMMAND = "npx @openma/cli@beta bridge setup";
const SUBTITLE = "Your own machines. An agent bound to one runs there instead of in a cloud sandbox.";

const skillCount = (r: Runtime) => Object.values(r.local_skills ?? {}).reduce((n, list) => n + (list?.length ?? 0), 0);

/**
 * Local runtimes — laptops and VMs running the bridge daemon. An agent
 * bound to a runtime runs on that machine instead of a cloud sandbox. The
 * list answers "is my machine connected and what can it run"; a row opens
 * the machine's details, and connecting a new one is a three-step dialog.
 */
export function RuntimesList() {
  const { api } = useApi();
  const [showConnect, setShowConnect] = useState(false);
  const [status, setStatus] = useState<StatusValue>("any");
  const [openId, setOpenId] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<Runtime | null>(null);

  // Refetch every 15s so a freshly attached daemon shows up, and a machine
  // that went to sleep flips to offline, without a reload.
  const { data: runtimesRes, isLoading: loading, error, refetch } = useApiQuery<RuntimesResponse>("/v1/runtimes", undefined, {
    refetchInterval: 15_000,
  });
  const runtimes = useMemo<Runtime[]>(
    () => (Array.isArray(runtimesRes?.runtimes) ? runtimesRes.runtimes : Array.isArray(runtimesRes?.data) ? runtimesRes.data : []),
    [runtimesRes],
  );

  // The list is a handful of machines, already fully loaded and kept fresh
  // by the poll, so the status filter narrows it in memory.
  const filtered = useMemo(() => (status === "any" ? runtimes : runtimes.filter((r) => r.status === status)), [runtimes, status]);
  const open = runtimes.find((r) => r.id === openId) ?? null;
  const online = runtimes.filter((r) => r.status === "online").length;

  const columns = useMemo<ColumnDef<Runtime>[]>(
    () => [
      {
        id: "hostname",
        accessorKey: "hostname",
        header: "Machine",
        size: 300,
        minSize: 220,
        enableHiding: false,
        enableSorting: true,
        cell: ({ row }) => {
          const r = row.original;
          return (
            // Every row here is a machine: the hostname leads, with no icon to repeat.
            <ResourceIdentity
              name={r.hostname || "Unnamed machine"}
              secondary={[r.os, r.version && `CLI ${r.version}`].filter(Boolean).join(" · ") || "No system details reported"}
            />
          );
        },
      },
      {
        id: "status",
        accessorFn: (r) => r.status,
        header: "Status",
        size: 120,
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
      },
      {
        id: "agents",
        header: "Agents found",
        // Room for two agent ids whole at 1280; the rest are counted.
        size: 300,
        cell: ({ row }) => {
          const agents = row.original.agents ?? [];
          if (agents.length === 0) return <span className="text-fg-subtle">None found</span>;
          return <ChipRow mono label="Agents found" items={agents.map((a) => ({ key: a.id, label: a.id }))} />;
        },
      },
      {
        id: "skills",
        header: "Local skills",
        size: 130,
        cell: ({ row }) => {
          const n = skillCount(row.original);
          return n === 0 ? <span className="text-fg-subtle">None</span> : <span className="text-fg-muted">{plural(n, "skill")}</span>;
        },
      },
      {
        id: "heartbeat",
        accessorFn: (r) => toMillis(r.last_heartbeat) ?? undefined,
        header: "Last seen",
        size: 130,
        enableSorting: true,
        sortDescFirst: true,
        cell: ({ row }) => (
          <RelativeTime value={toMillis(row.original.last_heartbeat)} className="text-fg-muted" fallback="Never" />
        ),
      },
      {
        id: "actions",
        header: "",
        size: 56,
        enableHiding: false,
        cell: ({ row }) => (
          <RowActionsMenu
            label={`Actions for ${row.original.hostname}`}
            actions={[
              { label: "View details", icon: <PanelRightOpenIcon />, onSelect: () => setOpenId(row.original.id) },
              { label: "Copy runtime id", icon: <CopyIcon />, onSelect: () => void copyText(row.original.id) },
              { label: "Revoke", icon: <BanIcon />, destructive: true, onSelect: () => setRevoking(row.original) },
            ]}
          />
        ),
      },
    ],
    [],
  );

  const statusDisplay = status === "any" ? undefined : STATUS_OPTIONS.find((o) => o.value === status)?.label;

  const filters = (
    <FilterChip label="Status" active={status !== "any"} display={statusDisplay} onClear={() => setStatus("any")}>
      <PopoverContent align="start" sideOffset={6} collisionPadding={8} className="w-52 gap-0 p-0">
        <FacetedFilter
          options={STATUS_OPTIONS}
          value={status}
          onValueChange={(v) => setStatus(v as StatusValue)}
          searchPlaceholder="Status"
        />
      </PopoverContent>
    </FilterChip>
  );

  const dialogs = (
    <>
      <ConnectDialog open={showConnect} onClose={() => setShowConnect(false)} />

      <RuntimeSheet runtime={open} onClose={() => setOpenId(null)} onRevoke={(r) => setRevoking(r)} />

      <ConfirmDialog
        open={!!revoking}
        onClose={() => setRevoking(null)}
        destructive
        title={`Revoke ${revoking?.hostname || "this machine"}?`}
        body="The daemon on that machine can no longer attach, and agents bound to it stop running there. Run setup again to reconnect."
        confirmLabel="Revoke machine"
        onConfirm={async () => {
          if (!revoking) return;
          await api(`/v1/runtimes/${revoking.id}`, { method: "DELETE" });
          setOpenId(null);
          await refetch();
        }}
      />
    </>
  );

  // A failed read replaces the list: never an empty state for an error.
  if (error && runtimes.length === 0) {
    return (
      <Page width="wide" header={<PageHeader title="Local runtimes" subtitle={SUBTITLE} width="wide" />}>
        <ErrorState title="Local runtimes could not be loaded" error={error} retry={() => void refetch()} />
      </Page>
    );
  }

  // First run: nothing to list, so the page teaches the three steps and
  // puts the setup command where it can be copied straight away.
  if (!loading && runtimes.length === 0) {
    return (
      <Page
        width="wide"
        header={
          <PageHeader
            title="Local runtimes"
            subtitle={SUBTITLE}
            width="wide"
            actions={
              // First run: the empty state below carries the page's one ink button.
              <Button variant="outline" onClick={() => setShowConnect(true)} aria-label="+ Connect machine">
                <PlusIcon data-icon="inline-start" className="stroke-[2.25]" />
                Connect machine
              </Button>
            }
          />
        }
      >
        <div className="animate-rise-in space-y-4">
          <EmptyState
            size="lg"
            kind="runtime"
            title="No machines connected"
            body="Connect a laptop or a VM to run agents such as Claude Code and Codex on it, supervised from here."
            action={<Button onClick={() => setShowConnect(true)}>Connect machine</Button>}
          />
          <section aria-label="How connecting a machine works" className="surface rounded-xl px-6 py-5">
            <h2 className="text-h3 text-fg">How it works</h2>
            <ol className="mt-4 grid gap-6 md:grid-cols-3">
              <Instruction n={1} title="Run setup on the machine">
                <CommandLine command={SETUP_COMMAND} wrap />
              </Instruction>
              <Instruction n={2} title="Approve it in your browser">
                <p>Setup opens this console and asks you to allow the machine. Its daemon then stays running in the background.</p>
              </Instruction>
              <Instruction n={3} title="Bind an agent to it">
                <p>Agents found on the machine show up here. Choose the machine as the runtime when you create or edit an agent.</p>
              </Instruction>
            </ol>
          </section>
        </div>
        {dialogs}
      </Page>
    );
  }

  return (
    <DataTable<Runtime>
      title="Local runtimes"
      subtitle={SUBTITLE}
      createLabel="+ Connect machine"
      onCreate={() => setShowConnect(true)}
      filters={filters}
      summary={loading ? undefined : `${online} of ${plural(runtimes.length, "machine")} online`}
      data={filtered}
      loading={loading}
      getRowId={(r) => r.id}
      onRowClick={(r) => setOpenId(r.id)}
      // Only reachable with a status filter on: no machines at all is the first-run page above.
      emptyTitle={`No ${status === "any" ? "" : `${status} `}machines`}
      emptyKind="runtime"
      emptySubtitle="Machines report in every few seconds. Try a different status."
      emptyAction={
        <Button variant="outline" onClick={() => setStatus("any")}>
          Clear filters
        </Button>
      }
      columns={columns}
    >
      {dialogs}
    </DataTable>
  );
}

/** A numbered instruction: what to do, why, and anything to copy. */
function Instruction({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3.5">
      <span
        aria-hidden="true"
        className="mt-px flex size-6 shrink-0 items-center justify-center rounded-full bg-bg-soft text-micro-size font-semibold text-fg"
      >
        {n}
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <p className="text-sm font-medium text-fg">{title}</p>
        <div className="space-y-2.5 text-small text-fg-muted">{children}</div>
      </div>
    </li>
  );
}

const code = "rounded-sm bg-bg-soft px-1 py-0.5 font-mono text-xs text-fg";
const link = inlineLink;

function ConnectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Connect a machine"
      subtitle="Takes about a minute. You need a terminal on the machine."
      maxWidth="max-w-xl"
      // Focus starts on Done, not on the first copy button (which would pop its tooltip).
      footer={
        <Button onClick={onClose} autoFocus>
          Done
        </Button>
      }
    >
      <ol className="space-y-6">
        <Instruction n={1} title="Run setup on the machine">
          <CommandLine command={SETUP_COMMAND} />
        </Instruction>
        <Instruction n={2} title="Approve it in your browser">
          <p>
            Setup opens this console so you can approve the machine. It then saves its credentials to{" "}
            <code className={code}>~/.oma/bridge/</code> and, on macOS, installs a launchd job that keeps the daemon running
            across restarts.
          </p>
        </Instruction>
        <Instruction n={3} title="Bind an agent to it">
          <p>
            The daemon scans <code className={code}>$PATH</code> for ACP-compatible agents and reports them here. Choose the
            machine as the runtime when you create or edit an agent.
          </p>
        </Instruction>
      </ol>

      <Disclosure title="Which agents can it run?" meta="4 featured, 30+ more" className="mt-6">
        <div className="space-y-4 text-small text-fg-muted">
          <div>
            <p className="font-medium text-fg">Recommended by {BRAND_NAME}</p>
            <ul className="mt-2 space-y-2">
              <AgentHint name="claude-acp">
                <code className={code}>npx -y @agentclientprotocol/claude-agent-acp</code>, installed for you when{" "}
                <code className={code}>claude</code> is on the path.
              </AgentHint>
              <AgentHint name="codex-acp">
                Download from{" "}
                <a className={link} href="https://github.com/zed-industries/codex-acp/releases" target="_blank" rel="noreferrer">
                  zed-industries/codex-acp releases
                </a>
                .
              </AgentHint>
              <AgentHint name="openclaw">
                <code className={code}>npm i -g openclaw</code>, which uses the <code className={code}>openclaw acp</code> bridge.
              </AgentHint>
              <AgentHint name="hermes">
                <code className={`${code} break-all`}>
                  curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash
                </code>
              </AgentHint>
            </ul>
          </div>
          <div>
            <p className="font-medium text-fg">Installed for you during setup</p>
            <ul className="mt-2 space-y-1.5">
              <li>
                <code className={code}>claude</code> found: installs <code className={code}>@agentclientprotocol/claude-agent-acp</code>.
              </li>
              <li>
                <code className={code}>codex</code> found: installs <code className={code}>@normahq/codex-acp-bridge</code>, which drives
                Codex over ACP.
              </li>
              <li>
                <code className={code}>gemini</code> missing: installs <code className={code}>@google/gemini-cli</code>, which speaks
                ACP natively.
              </li>
            </ul>
          </div>
          <p>
            Gemini, OpenCode, Cline, Cursor, Kimi, Qwen Code and 30 or so others come from the{" "}
            <a className={link} href="https://agentclientprotocol.com/get-started/registry" target="_blank" rel="noreferrer">
              ACP Registry
              <ExternalLinkIcon className="ml-0.5 inline size-3 align-[-1px]" />
            </a>
            . The daemon reads it at startup, and any installed binary becomes selectable.
          </p>
        </div>
      </Disclosure>
    </Modal>
  );
}

function AgentHint({ name, children }: { name: string; children: ReactNode }) {
  return (
    <li className="flex gap-2.5">
      <Chip mono className="mt-px">
        {name}
      </Chip>
      <span className="min-w-0 flex-1">{children}</span>
    </li>
  );
}

/** One machine, inspected without leaving the list. */
function RuntimeSheet({
  runtime,
  onClose,
  onRevoke,
}: {
  runtime: Runtime | null;
  onClose: () => void;
  onRevoke: (r: Runtime) => void;
}) {
  return (
    <Sheet open={!!runtime} onOpenChange={(next) => !next && onClose()}>
      <SheetContent
        className="gap-0 outline-none focus-visible:outline-none sm:max-w-[440px]"
        // Focus the panel itself: the first control is a copy chip whose tooltip would open.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement).focus();
        }}
      >
        {runtime && (
          <>
            <SheetHeader className="flex-row items-center gap-3.5 pb-5">
              <EntityAvatar icon={LaptopIcon} size="lg" />
              <div className="min-w-0 flex-1">
                <SheetTitle className="truncate">{runtime.hostname || "Unnamed machine"}</SheetTitle>
                <SheetDescription className="mt-1 flex items-center gap-2">
                  <StatusBadge status={runtime.status} variant="soft" />
                  <span className="truncate text-small">{runtime.os || "Unknown system"}</span>
                </SheetDescription>
              </div>
            </SheetHeader>

            <div className="min-h-0 flex-1 space-y-7 overflow-y-auto px-6 pb-6">
              <section>
                <h3 className="mb-1 text-xs font-medium text-fg-subtle">Details</h3>
                <PropertyList>
                  <Property label="Last seen">
                    <RelativeTime value={toMillis(runtime.last_heartbeat)} fallback="Never" />
                  </Property>
                  <Property label="Connected">
                    <RelativeTime value={toMillis(runtime.created_at)} fallback="Not recorded" />
                  </Property>
                  <Property label="CLI version" empty="Not reported">
                    {runtime.version ? <span className="font-mono text-xs">{runtime.version}</span> : null}
                  </Property>
                  <Property label="Runtime id">
                    <IdChip id={runtime.id} label="Copy runtime id" />
                  </Property>
                  <Property label="Machine id" empty="Not reported">
                    {runtime.machine_id ? <IdChip id={runtime.machine_id} label="Copy machine id" /> : null}
                  </Property>
                </PropertyList>
              </section>

              <section>
                <h3 className="mb-2 text-xs font-medium text-fg-subtle">Agents on this machine</h3>
                {runtime.agents.length === 0 ? (
                  <p className="rounded-lg bg-bg-soft px-3.5 py-3 text-small text-fg-muted">
                    No ACP-compatible agent was found on the path. Install one, then restart the daemon.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {runtime.agents.map((a) => {
                      const skills = runtime.local_skills?.[a.id] ?? [];
                      return (
                        <li key={a.id} className="rounded-lg border border-border">
                          <div className="flex items-center gap-3 px-3.5 py-2.5">
                            <EntityAvatar icon={TerminalIcon} size="sm" />
                            <div className="min-w-0 flex-1">
                              <p className="truncate font-mono text-small-size text-fg">{a.id}</p>
                              {a.binary && (
                                <p className="truncate font-mono text-xs text-fg-subtle" title={a.binary}>
                                  {a.binary}
                                </p>
                              )}
                            </div>
                            <Chip icon={PuzzleIcon}>{skills.length === 0 ? "No skills" : plural(skills.length, "skill")}</Chip>
                          </div>
                          {skills.length > 0 && (
                            <ul className="space-y-1.5 border-t border-border bg-bg-inset/60 px-3.5 py-2.5">
                              {skills.map((s) => (
                                <li key={`${s.source_label ?? ""}/${s.id}`} className="flex items-baseline justify-between gap-3">
                                  <span className="truncate font-mono text-xs text-fg" title={s.description || s.name || s.id}>
                                    {s.id}
                                  </span>
                                  <span className="shrink-0 text-xs text-fg-subtle">
                                    {s.source ?? "global"}
                                    {s.source_label ? ` · ${s.source_label}` : ""}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            </div>

            <SheetFooter className="flex-row justify-between gap-2 px-6 py-4">
              <Button variant="ghost" onClick={onClose}>
                Close
              </Button>
              <Button variant="outline" onClick={() => onRevoke(runtime)}>
                <BanIcon data-icon="inline-start" />
                Revoke machine
              </Button>
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
