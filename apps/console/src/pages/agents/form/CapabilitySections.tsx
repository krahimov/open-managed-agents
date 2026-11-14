import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import {
  CheckIcon,
  ExternalLinkIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FileTypeIcon,
  LayoutGridIcon,
  PencilIcon,
  PlugIcon,
  PlusIcon,
  PresentationIcon,
  PuzzleIcon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { useApi } from "@/lib/api";
import {
  composioEntriesFromCatalog,
  filterComposioEntries,
  type ComposioIntegrationEntry,
  type ComposioToolkitCatalogResponse,
} from "@/lib/composio-integrations";
import { MCP_REGISTRY, type McpRegistryEntry } from "@/lib/mcp-registry";
import { useApiQuery } from "@/lib/useApiQuery";
import { cn } from "@/lib/utils";
import { inlineLink } from "@/lib/links";

import { AppIcon, CheckRow, FormSection, GroupLabel, OptionCard, PickSelect, RowBox } from "../../../components/agents/controls";
import {
  AgentAvatar,
  Chip,
  Combobox,
  EmptyState,
  EntityAvatar,
  Field,
  SearchInput,
  SecretInput,
  Skeleton,
  Tip,
} from "../../../components/kit";
import { GitHubIcon, LinearIcon, SlackIcon } from "../../../components/icons";
import { McpServerPicker } from "../../../components/McpServerPickerModal";
import type { AgentRecord as Agent } from "../../../types/agent";
import {
  ANTHROPIC_SKILLS,
  BUILTIN_TOOLS,
  BUILTIN_TOOL_GROUPS,
  type ComposioConnectionState,
  type FormSetter,
  type FormState,
  type McpEntry,
  type SkillLite,
  type ToolOverride,
} from "./model";

// ── Tools ────────────────────────────────────────────────────────────────

const PERMISSION_OPTIONS = [
  { value: "always_allow" as const, label: "Allow", hint: "Tools run without asking." },
  { value: "always_ask" as const, label: "Ask first", hint: "Each call waits for a person to approve it." },
];

/** Built-in tool policy: one default, and exceptions per tool. */
export function ToolsSection({ form, setForm }: { form: FormState; setForm: FormSetter }) {
  const defaultLabel = !form.toolDefaultEnabled ? "Off" : form.toolDefaultPermission === "always_ask" ? "Ask first" : "Allow";
  const overrideOptions: Array<{ value: ToolOverride; label: string }> = [
    { value: "default", label: `Default · ${defaultLabel}` },
    { value: "always_allow", label: "Allow" },
    { value: "always_ask", label: "Ask first" },
    { value: "disabled", label: "Off" },
  ];
  const setOverride = (name: string, v: ToolOverride) => {
    const next = { ...form.toolOverrides };
    if (v === "default") delete next[name];
    else next[name] = v;
    setForm({ ...form, toolOverrides: next });
  };

  return (
    <FormSection
      title="Tools"
      description="The built-in tools the agent can use in its sandbox. Apps and MCP servers have their own sections."
    >
      <RowBox>
        <div className="flex items-center justify-between gap-6 px-3.5 py-3">
          <div className="min-w-0">
            <label htmlFor="tools-default-enabled" className="block text-small-size font-medium text-fg">
              Built-in tools
            </label>
            <p className="mt-0.5 text-xs text-fg-muted">Files, shell, web and scheduling. Turn off to start from nothing.</p>
          </div>
          <Switch
            id="tools-default-enabled"
            checked={form.toolDefaultEnabled}
            onCheckedChange={(checked) => setForm({ ...form, toolDefaultEnabled: checked })}
          />
        </div>
        <div className={cn("flex items-center justify-between gap-6 border-t border-border px-3.5 py-3", !form.toolDefaultEnabled && "opacity-55")}>
          <div className="min-w-0">
            <div className="text-small-size font-medium text-fg">By default</div>
            <p className="mt-0.5 text-xs text-fg-muted">Applies to every tool below that is left on Default.</p>
          </div>
          <PickSelect
            aria-label="Default permission"
            value={form.toolDefaultPermission}
            disabled={!form.toolDefaultEnabled}
            onValueChange={(toolDefaultPermission) => setForm({ ...form, toolDefaultPermission })}
            options={PERMISSION_OPTIONS}
            size="sm"
            className="w-36"
          />
        </div>
      </RowBox>

      {BUILTIN_TOOL_GROUPS.map((group) => (
        <div key={group.id}>
          <GroupLabel>{group.label}</GroupLabel>
          <RowBox>
            {BUILTIN_TOOLS.filter((bt) => bt.group === group.id).map((bt) => {
              const current = form.toolOverrides[bt.name] ?? "default";
              const isOff = current === "disabled" || (current === "default" && !form.toolDefaultEnabled);
              return (
                <div
                  key={bt.name}
                  className="flex min-h-[52px] items-center justify-between gap-4 border-t border-border px-3.5 py-2 first:border-t-0"
                >
                  <div className={cn("min-w-0", isOff && "opacity-55")}>
                    <div className="font-mono text-xs text-fg">{bt.name}</div>
                    <div className="line-clamp-2 text-xs text-fg-subtle" title={bt.description}>
                      {bt.description}
                    </div>
                  </div>
                  <PickSelect
                    aria-label={`Permission for ${bt.name}`}
                    value={current}
                    onValueChange={(v) => setOverride(bt.name, v)}
                    options={overrideOptions}
                    size="sm"
                    // Tools on the default stay quiet; an exception keeps the
                    // control's edge, so overrides stand out when scanning.
                    className={cn(
                      "w-40 shrink-0",
                      current === "default" &&
                        "border-transparent bg-transparent text-fg-muted shadow-none hover:border-border-strong hover:bg-bg-hover dark:bg-transparent",
                    )}
                  />
                </div>
              );
            })}
          </RowBox>
        </div>
      ))}
      <p className="text-xs text-fg-subtle">
        Ask first pauses the session until someone approves the call, in the session or in Operations.
      </p>
    </FormSection>
  );
}

// ── Skills ───────────────────────────────────────────────────────────────

const DOCUMENT_SKILL_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  xlsx: FileSpreadsheetIcon,
  pdf: FileTextIcon,
  pptx: PresentationIcon,
  docx: FileTypeIcon,
};

export function SkillsSection({
  form,
  setForm,
  customSkills,
  toggleAnthropicSkill,
}: {
  form: FormState;
  setForm: FormSetter;
  customSkills: SkillLite[];
  toggleAnthropicSkill: (id: string) => void;
}) {
  // Rows whose id is one of the document skills are the same skill listed
  // twice by the backend; hide them here so nothing appears in both groups.
  const anthropicIds = new Set(ANTHROPIC_SKILLS.map((s) => s.id));
  const filtered = customSkills.filter((cs) => !anthropicIds.has(cs.id));

  const toggleCustom = (id: string, active: boolean) => {
    if (active) {
      setForm({ ...form, skills: form.skills.filter((sk) => !(sk.type === "custom" && sk.skill_id === id)) });
    } else {
      setForm({ ...form, skills: [...form.skills, { type: "custom", skill_id: id, version: "latest" }] });
    }
  };

  return (
    <FormSection title="Skills" description="Packaged know-how the agent loads when a task calls for it.">
      <div>
        <GroupLabel>Document skills</GroupLabel>
        <div className="grid gap-2.5 sm:grid-cols-2">
          {ANTHROPIC_SKILLS.map((s) => (
            <OptionCard
              key={s.id}
              role="checkbox"
              selected={form.skills.some((sk) => sk.type === "anthropic" && sk.skill_id === s.id)}
              onSelect={() => toggleAnthropicSkill(s.id)}
              icon={DOCUMENT_SKILL_ICON[s.id] ?? FileTextIcon}
              title={s.label}
              description={s.description}
            />
          ))}
        </div>
      </div>

      <div>
        <GroupLabel>Workspace skills</GroupLabel>
        {filtered.length > 0 ? (
          <RowBox>
            {filtered.map((cs) => {
              const active = form.skills.some((sk) => sk.type === "custom" && sk.skill_id === cs.id);
              return (
                <CheckRow
                  key={cs.id}
                  checked={active}
                  onCheckedChange={() => toggleCustom(cs.id, active)}
                  leading={<EntityAvatar icon={PuzzleIcon} size="sm" />}
                  title={cs.name}
                  description={cs.description || "No description"}
                />
              );
            })}
          </RowBox>
        ) : (
          <p className="rounded-lg border border-dashed border-border-strong px-4 py-3.5 text-small text-fg-muted">
            No workspace skills yet.{" "}
            <Link to="/skills" className={inlineLink}>
              Add one on the Skills page
            </Link>
            .
          </p>
        )}
      </div>
    </FormSection>
  );
}

// ── Apps (Composio integrations) ─────────────────────────────────────────

export function AppsSection({
  form,
  search,
  setSearch,
  connections,
  connecting,
  composioConfigured,
  composioStatusLoading,
  onComposioConnected,
  onToggle,
  onConnect,
}: {
  form: FormState;
  search: string;
  setSearch: (value: string) => void;
  connections: ComposioConnectionState;
  connecting: string | null;
  composioConfigured: boolean;
  composioStatusLoading: boolean;
  onComposioConnected: () => void;
  onToggle: (entry: ComposioIntegrationEntry) => void;
  onConnect: (entry: ComposioIntegrationEntry) => void;
}) {
  const { api } = useApi();
  const [composioKeyInput, setComposioKeyInput] = useState("");
  const [savingComposioKey, setSavingComposioKey] = useState(false);

  const saveComposioKey = async () => {
    const apiKey = composioKeyInput.trim();
    if (!apiKey) return;
    setSavingComposioKey(true);
    try {
      await api(`/v1/composio/key`, { method: "PUT", body: JSON.stringify({ api_key: apiKey }) });
      setComposioKeyInput("");
      toast.success("Composio connected. Loading the app catalog.");
      onComposioConnected();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save Composio key");
    } finally {
      setSavingComposioKey(false);
    }
  };
  const { data: catalogRes, isLoading: catalogLoading } = useApiQuery<ComposioToolkitCatalogResponse>(
    "/v1/composio/toolkits?limit=500",
    undefined,
    { enabled: composioConfigured },
  );
  const catalogEntries = useMemo(() => composioEntriesFromCatalog(catalogRes), [catalogRes]);
  const filtered = useMemo(() => filterComposioEntries(catalogEntries, search), [catalogEntries, search]);
  const loading = composioStatusLoading || (composioConfigured && catalogLoading);
  const selectedCount = form.composioToolkits.length;

  return (
    <FormSection
      title="Apps"
      description="Give the agent accounts in the tools your team already uses. Each app is connected once and kept in a vault."
      action={
        composioConfigured ? (
          <SearchInput value={search} onChange={setSearch} placeholder="Search apps" width="w-52" />
        ) : undefined
      }
    >
      {!composioStatusLoading && !composioConfigured && (
        <div className="rounded-lg border border-border-strong bg-bg-surface p-4 dark:bg-bg-soft">
          <div className="flex items-start gap-3">
            <EntityAvatar icon={LayoutGridIcon} size="md" />
            <div className="min-w-0">
              <div className="text-small leading-5 font-medium text-fg">Connect Composio to add apps</div>
              <p className="mt-0.5 text-small text-fg-muted">
                Apps are provided through Composio. Paste an API key from{" "}
                <a
                  href="https://app.composio.dev"
                  target="_blank"
                  rel="noreferrer"
                  className={inlineLink}
                >
                  app.composio.dev
                </a>
                . It is stored encrypted in this workspace and used only for your agents.
              </p>
            </div>
          </div>
          <div className="mt-3.5 flex items-center gap-2 pl-11">
            <div className="min-w-0 flex-1">
              <SecretInput
                value={composioKeyInput}
                onChange={(e) => setComposioKeyInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void saveComposioKey();
                  }
                }}
                placeholder="Composio API key"
                aria-label="Composio API key"
              />
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={() => void saveComposioKey()}
              disabled={!composioKeyInput.trim()}
              loading={savingComposioKey}
            >
              Connect
            </Button>
          </div>
        </div>
      )}

      {loading && (
        <div className="grid gap-2.5 sm:grid-cols-2" aria-hidden="true">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="rounded-lg border border-border p-3.5">
              <div className="flex items-center gap-3">
                <Skeleton className="size-8" rounded="lg" />
                <Skeleton className="h-3.5 w-28" rounded="sm" />
              </div>
              <Skeleton className="mt-3 h-3 w-full" rounded="sm" />
              <Skeleton className="mt-3 h-7 w-32" rounded="full" />
            </div>
          ))}
        </div>
      )}

      {composioConfigured && !loading && (
        <>
          <p className="text-xs text-fg-subtle" aria-live="polite">
            {selectedCount} selected · {catalogEntries.length} available
            {search.trim() ? ` · ${filtered.length} match "${search.trim()}"` : ""}
          </p>
          {filtered.length === 0 ? (
            <EmptyState
              variant="plain"
              size="sm"
              icon={<LayoutGridIcon />}
              title={search.trim() ? "No apps match" : "No apps available"}
              body={search.trim() ? "Try a different name." : "The Composio catalog returned nothing for this workspace."}
              action={
                search.trim() ? (
                  <Button variant="outline" size="sm" onClick={() => setSearch("")}>
                    Clear search
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="-mt-2 grid gap-2.5 sm:grid-cols-2">
              {filtered.map((entry) => {
                const selected = form.composioToolkits.includes(entry.slug);
                const connection = connections[entry.slug];
                const connected = connection?.status === "connected";
                const pending = connection?.status === "pending";
                return (
                  <div
                    key={entry.slug}
                    className={cn(
                      "flex flex-col gap-3 rounded-lg border bg-bg-surface p-3.5 transition-quick dark:bg-bg-soft",
                      selected ? "border-ink shadow-[inset_0_0_0_1px_var(--ink)]" : "border-border-strong",
                    )}
                  >
                    <div className="flex min-w-0 items-start gap-3">
                      <AppIcon slug={entry.slug} name={entry.name} size="md" />
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <div className="truncate text-small leading-5 font-medium text-fg" title={entry.name}>
                            {entry.name}
                          </div>
                          <Chip className="shrink">{entry.category}</Chip>
                        </div>
                        <div className="mt-0.5 line-clamp-2 min-h-8 text-xs leading-4 text-fg-subtle" title={entry.description}>
                          {entry.description || "No description"}
                        </div>
                      </div>
                    </div>
                    <div className="mt-auto flex items-center gap-2">
                      <Button
                        type="button"
                        variant={selected ? "secondary" : "outline"}
                        size="xs"
                        aria-pressed={selected}
                        onClick={() => onToggle(entry)}
                      >
                        {selected ? <CheckIcon data-icon="inline-start" /> : <PlusIcon data-icon="inline-start" />}
                        {selected ? "Added" : "Add"}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={() => {
                          if (pending && connection?.redirectUrl) {
                            window.open(connection.redirectUrl, `composio-${entry.slug}`, "width=600,height=720,popup=yes");
                          } else {
                            onConnect(entry);
                          }
                        }}
                        disabled={!composioConfigured || !!connecting}
                        className={cn(connected && "text-success hover:text-success")}
                      >
                        {connected ? <CheckIcon data-icon="inline-start" /> : <ExternalLinkIcon data-icon="inline-start" />}
                        {connected
                          ? "Connected"
                          : pending
                            ? "Finish sign-in"
                            : connecting === entry.slug
                              ? "Opening…"
                              : "Connect account"}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </FormSection>
  );
}

// ── MCP servers ──────────────────────────────────────────────────────────

/** Brand marks we ship locally. Other servers show their initial. */
const BRAND_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  github: GitHubIcon,
  linear: LinearIcon,
  slack: SlackIcon,
};

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

const TRANSPORT_OPTIONS = [
  { value: "url", label: "HTTP" },
  { value: "sse", label: "SSE" },
  { value: "stdio", label: "stdio" },
];

export function McpSection({
  form,
  addMcp,
  addMcpFromRegistry,
  updateMcp,
  removeMcp,
}: {
  form: FormState;
  addMcp: () => void;
  addMcpFromRegistry: (entry: McpRegistryEntry) => void;
  updateMcp: (i: number, field: keyof McpEntry, val: string) => void;
  removeMcp: (i: number) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  // One server is open for editing at a time. A server added by URL has
  // nothing filled in yet, so it opens straight away.
  const [open, setOpen] = useState<number | null>(null);
  const count = useRef(form.mcpServers.length);
  useEffect(() => {
    const n = form.mcpServers.length;
    if (n > count.current && !form.mcpServers[n - 1]?.url) setOpen(n - 1);
    count.current = n;
  }, [form.mcpServers]);
  const addButtons = (size: "sm" | "default") => (
    <>
      <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
        <PopoverTrigger asChild>
          <Button type="button" variant="outline" size={size}>
            <PlusIcon data-icon="inline-start" />
            Add server
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" sideOffset={6} collisionPadding={12} className="w-[22rem] p-3">
          <McpServerPicker
            alreadyAddedUrls={form.mcpServers.map((m) => m.url)}
            onPick={(entry) => {
              addMcpFromRegistry(entry);
              setPickerOpen(false);
            }}
            listClassName="max-h-64"
            footer={
              <button
                type="button"
                onClick={() => {
                  addMcp();
                  setPickerOpen(false);
                }}
                className="flex min-h-9 w-full items-center gap-2 rounded-md px-2 text-left text-small-size font-medium text-fg transition-quick hover:bg-bg-hover"
              >
                <PlugIcon className="size-4 text-fg-muted" />
                Add a server by URL
              </button>
            }
          />
        </PopoverContent>
      </Popover>
    </>
  );

  return (
    <FormSection
      title="MCP servers"
      description="External tools over the Model Context Protocol. Every tool a server offers is allowed once it is added."
      action={form.mcpServers.length > 0 ? addButtons("sm") : undefined}
    >
      {form.mcpServers.length === 0 ? (
        <EmptyState
          variant="plain"
          size="sm"
          icon={<PlugIcon />}
          title="No MCP servers yet"
          body="Pick a known server, or add your own by URL."
          action={addButtons("default")}
          className="rounded-lg border border-dashed border-border-strong"
        />
      ) : (
        <RowBox>
          {form.mcpServers.map((mcp, i) => {
            const known = MCP_REGISTRY.find((entry) => entry.url === mcp.url || entry.id === mcp.name);
            const label = known?.name ?? (mcp.name ? mcp.name[0].toUpperCase() + mcp.name.slice(1).replace(/[_-]+/g, " ") : "");
            const Brand = BRAND_ICON[(known?.id ?? mcp.name).toLowerCase()];
            const isOpen = open === i;
            const transport = TRANSPORT_OPTIONS.find((t) => t.value === mcp.type)?.label ?? mcp.type;
            return (
              <div key={i} className="border-t border-border first:border-t-0">
                <div className="flex min-h-[52px] items-center gap-3 py-2 pr-2 pl-3.5">
                  {Brand ? <EntityAvatar icon={Brand} size="md" /> : <AppIcon name={label || "?"} size="md" />}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-small leading-5 font-medium text-fg">
                      {label || <span className="text-fg-subtle">New server</span>}
                    </div>
                    <div className="truncate font-mono text-xs text-fg-subtle" title={mcp.url || undefined}>
                      {mcp.url ? hostOf(mcp.url) : "No URL yet"}
                    </div>
                  </div>
                  <Chip>{transport}</Chip>
                  <Tip label={isOpen ? "Done editing" : "Edit server"}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-expanded={isOpen}
                      aria-label={`${isOpen ? "Done editing" : "Edit"} MCP server ${mcp.name || i + 1}`}
                      onClick={() => setOpen(isOpen ? null : i)}
                    >
                      {isOpen ? <CheckIcon /> : <PencilIcon />}
                    </Button>
                  </Tip>
                  <Tip label="Remove server">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => {
                        setOpen(null);
                        removeMcp(i);
                      }}
                      aria-label={`Remove MCP server ${mcp.name || i + 1}`}
                    >
                      <XIcon />
                    </Button>
                  </Tip>
                </div>
                {isOpen && (
                  <div className="animate-fade-in space-y-4 border-t border-border bg-bg-inset/60 px-3.5 pt-3.5 pb-4">
                    <div className="grid grid-cols-[minmax(0,1fr)_8rem] gap-3">
                      <Field label="Name" hint="How the agent refers to it. Lowercase, no spaces.">
                        <Input
                          id={`mcp-name-${i}`}
                          value={mcp.name}
                          onChange={(e) => updateMcp(i, "name", e.target.value)}
                          placeholder="github"
                          autoComplete="off"
                          spellCheck={false}
                        />
                      </Field>
                      <Field label="Transport">
                        <PickSelect value={mcp.type} onValueChange={(v) => updateMcp(i, "type", v)} options={TRANSPORT_OPTIONS} />
                      </Field>
                    </div>
                    <Field label="URL">
                      <Input
                        id={`mcp-url-${i}`}
                        value={mcp.url}
                        onChange={(e) => updateMcp(i, "url", e.target.value)}
                        placeholder="https://mcp.example.com/mcp"
                        autoComplete="off"
                        spellCheck={false}
                        className="font-mono"
                      />
                    </Field>
                  </div>
                )}
              </div>
            );
          })}
        </RowBox>
      )}
    </FormSection>
  );
}

// ── Delegation (multi-agent) ─────────────────────────────────────────────

export function DelegationSection({
  form,
  setForm,
  allAgents,
  addCallable,
  removeCallable,
}: {
  form: FormState;
  setForm: FormSetter;
  allAgents: Agent[];
  addCallable: (agentId: string) => void;
  removeCallable: (i: number) => void;
}) {
  return (
    <FormSection title="Delegation" description="How the agent splits up bigger jobs: by itself, with a helper, or by handing work to other agents.">
      <RowBox>
        <div className="flex items-start justify-between gap-6 px-3.5 py-3">
          <div className="min-w-0">
            <label htmlFor="agent-long-running" className="block text-small-size font-medium text-fg">
              Long-running goals
            </label>
            <p className="mt-0.5 text-xs text-fg-muted">
              Sessions can carry a goal. The agent keeps iterating in fresh contexts until the goal's checks pass, the
              budget runs out or it gets stuck. Start one with "Run until done" on the agent's page.
            </p>
          </div>
          <Switch
            id="agent-long-running"
            checked={form.longRunning}
            onCheckedChange={(checked) => setForm({ ...form, longRunning: checked })}
          />
        </div>
        <div className="flex items-start justify-between gap-6 border-t border-border px-3.5 py-3">
          <div className="min-w-0">
            <label htmlFor="agent-general-subagent" className="block text-small-size font-medium text-fg">
              General sub-agent
            </label>
            <p className="mt-0.5 text-xs text-fg-muted">
              Adds a <code className="font-mono">general_subagent</code> tool that starts a helper with this agent's
              model and sandbox and a safe set of file and shell tools. Nothing else to set up.
            </p>
          </div>
          <Switch
            id="agent-general-subagent"
            checked={form.enableGeneralSubagent}
            onCheckedChange={(checked) => setForm({ ...form, enableGeneralSubagent: checked })}
          />
        </div>
      </RowBox>

      <div>
        <GroupLabel>Can hand work to</GroupLabel>
        {form.callableAgents.length > 0 && (
          <RowBox className="mb-2.5">
            {form.callableAgents.map((ca, i) => {
              const agentInfo = allAgents.find((a) => a.id === ca.id);
              return (
                <div key={ca.id} className="flex min-h-12 items-center gap-3 border-t border-border px-3.5 py-2 first:border-t-0">
                  <AgentAvatar name={agentInfo?.name ?? "?"} id={ca.id} size="sm" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-small-size font-medium text-fg" title={agentInfo ? `${agentInfo.name} · ${ca.id}` : ca.id}>
                      {agentInfo?.name ?? <span className="font-mono text-xs font-normal">{ca.id}</span>}
                    </div>
                    {agentInfo?.description && <div className="truncate text-xs text-fg-subtle">{agentInfo.description}</div>}
                  </div>
                  <Tip label="Remove">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => removeCallable(i)}
                      aria-label={`Remove ${agentInfo?.name ?? ca.id}`}
                    >
                      <XIcon />
                    </Button>
                  </Tip>
                </div>
              );
            })}
          </RowBox>
        )}
        <Combobox<Agent>
          value=""
          onValueChange={(v) => {
            if (v) addCallable(v);
          }}
          endpoint="/v1/agents"
          getValue={(a) => a.id}
          getLabel={(a) => (
            <span className="flex min-w-0 items-center gap-2">
              <AgentAvatar name={a.name} id={a.id} size="xs" />
              <span className="truncate">{a.name}</span>
            </span>
          )}
          getTextLabel={(a) => a.name}
          placeholder={form.callableAgents.length > 0 ? "Add another agent" : "Choose an agent"}
          excludeIds={form.callableAgents.map((c) => c.id)}
        />
        <p className="mt-1.5 text-xs text-fg-subtle">
          {form.callableAgents.length === 0 && allAgents.length === 0
            ? "Create other agents first, then come back to let this one delegate to them."
            : "Each agent you add becomes a tool this agent can call."}
        </p>
      </div>
    </FormSection>
  );
}
