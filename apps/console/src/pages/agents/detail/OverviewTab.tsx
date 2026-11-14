import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { BoxIcon, BrainIcon, PencilIcon, PlugIcon, PuzzleIcon, TerminalIcon, WrenchIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { harnessLabel } from "@/lib/agents";
import { COMPOSIO_MANAGED_AGENT_INTEGRATIONS } from "@/lib/composio-integrations";
import { plural } from "@/lib/format";
import { useEntityName, type EntityKind } from "@/lib/directory";
import { sessionTitle } from "@/lib/sessions";
import { useApiQuery } from "@/lib/useApiQuery";
import { cn } from "@/lib/utils";

import { AppIcon } from "../../../components/agents/controls";
import { GitHubIcon, LinearIcon, SlackIcon, VaultIcon } from "../../../components/icons";
import {
  Chip,
  EntityAvatar,
  EntityRef,
  IdChip,
  ModelBadge,
  Property,
  PropertyList,
  RelativeTime,
  SectionCard,
  Skeleton,
  StatTile,
  StatusBadge,
  StatusDot,
} from "../../../components/kit";
import { SessionStatusDot } from "../../../components/sessions/SessionStatus";
import { useSessionReadings } from "../../../components/sessions/readings";
import { MEMORY_MODE_LABELS, parseMemoryMode } from "../../../components/MemoryModeControl";
import type { AgentRecord } from "../../../types/agent";
import type { SessionRecord } from "../../../types/session";
import { ListRow, TOOL_POLICY, listInWords, localBrandIcon, summarizeTools } from "./parts";

/** Shared publication shape across Linear, GitHub and Slack. */
interface Pub {
  id: string;
  status: string;
  mode: string;
  persona: { name: string; avatarUrl: string | null };
  workspace_name: string | null;
}

const ANTHROPIC_SKILL_LABEL: Record<string, string> = {
  xlsx: "Excel spreadsheets",
  pdf: "PDF documents",
  pptx: "PowerPoint decks",
  docx: "Word documents",
};

const REASONING_LABEL: Record<string, string> = {
  instant: "Instant",
  low: "Low",
  medium: "Medium",
  high: "High",
  max: "Max",
};

const DAY_MS = 86_400_000;

/** The aside is 340px wide: a slimmer label column leaves the values room. */

/** Sessions started per day for the last `days` days, oldest first. */
function sessionsPerDay(sessions: SessionRecord[], days = 30): number[] {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const first = start.getTime() - (days - 1) * DAY_MS;
  const buckets = new Array<number>(days).fill(0);
  for (const s of sessions) {
    const t = new Date(s.created_at).getTime();
    if (!Number.isFinite(t) || t < first) continue;
    const i = Math.min(days - 1, Math.floor((t - first) / DAY_MS));
    buckets[i] += 1;
  }
  return buckets;
}

/**
 * Overview: what the agent is told, what it can use, where it shows up,
 * and the facts about how it runs. Read-only; editing opens the dialog.
 */
export function OverviewTab({
  agent,
  sessions,
  sessionsLoading,
  onEdit,
  onShowActivity,
}: {
  agent: AgentRecord;
  sessions: SessionRecord[];
  sessionsLoading: boolean;
  onEdit: () => void;
  onShowActivity: () => void;
}) {
  const archived = !!agent.archived_at;
  // The one reading of a session, the same as the sidebar and the Sessions list.
  const { read } = useSessionReadings();
  const tools = useMemo(() => summarizeTools(agent), [agent]);

  const skillEntries = (agent.skills ?? []) as Array<{ type?: string; skill_id?: string }>;
  const { data: skillsRes, isLoading: skillsLoading } = useApiQuery<{
    data: Array<{ id: string; name: string; description?: string }>;
  }>(skillEntries.length > 0 ? "/v1/skills" : null);
  const skillById = useMemo(() => new Map((skillsRes?.data ?? []).map((s) => [s.id, s])), [skillsRes]);

  const composioApps = useMemo(() => {
    const slugs = Array.isArray(agent.metadata?.composio_toolkits)
      ? agent.metadata.composio_toolkits.filter((id): id is string => typeof id === "string")
      : [];
    return slugs.map(
      (slug) =>
        COMPOSIO_MANAGED_AGENT_INTEGRATIONS.find((entry) => entry.slug === slug) ?? {
          slug,
          name: slug[0]?.toUpperCase() + slug.slice(1),
          category: "App",
          description: "",
          domain: "composio.dev",
        },
    );
  }, [agent.metadata]);

  const delegates = agent.multiagent?.agents ?? [];
  const binding = agent._oma?.runtime_binding;
  const { data: runtimesRes } = useApiQuery<{ runtimes?: Array<{ id: string; hostname: string }>; data?: Array<{ id: string; hostname: string }> }>(
    binding ? "/v1/runtimes" : null,
  );
  const runtimeHost = (runtimesRes?.runtimes ?? runtimesRes?.data ?? []).find((r) => r.id === binding?.runtime_id)?.hostname;

  const memoryMode = parseMemoryMode(agent._oma?.memory);
  const memoryStoreId = agent._oma?.memory?.store_id;
  const vaultIds = agent._oma?.default_vault_ids ?? [];
  const reasoning = agent._oma?.reasoning_level;

  const perDay = useMemo(() => sessionsPerDay(sessions), [sessions]);
  const last30 = perDay.reduce((a, b) => a + b, 0);
  const running = sessions.filter((s) => !s.archived_at && read(s).working).length;
  const lastActive = sessions[0]?.updated_at || sessions[0]?.created_at;
  const recent = sessions.slice(0, 4);

  const hasAnyTool = !!tools.builtIn || tools.custom.length > 0 || tools.servers.length > 0 || composioApps.length > 0;

  return (
    // Two columns from `xl`: below that the sidebar leaves the panel too
    // narrow for a readable main column beside a 340px aside, so the aside
    // moves under it and lays its two cards side by side.
    <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-w-0 space-y-4">
        <SectionCard
          title="Instructions"
          description="What the agent is told before every session."
          actions={
            <Button variant="ghost" size="sm" onClick={onEdit}>
              <PencilIcon data-icon="inline-start" />
              Edit
            </Button>
          }
        >
          {agent.system?.trim() ? (
            <ClampedProse text={agent.system} />
          ) : (
            <p className="text-small text-fg-subtle">
              No instructions yet. Without them the agent behaves like the model's default assistant.
            </p>
          )}
        </SectionCard>

        <SectionCard title="Tools and apps" description="What the agent can reach, and whether it has to ask." flush>
          {!hasAnyTool && (
            <p className="px-5 py-6 text-small text-fg-subtle">This agent has no tools. It can only talk.</p>
          )}
          {tools.builtIn && (
            <ListRow
              leading={<EntityAvatar icon={TerminalIcon} size="md" />}
              title="Built-in tools"
              description="Files, shell, web and scheduling in the sandbox"
              trailing={
                <Chip tone={TOOL_POLICY[tools.builtIn.policy].tone} title={TOOL_POLICY[tools.builtIn.policy].title}>
                  {TOOL_POLICY[tools.builtIn.policy].label}
                </Chip>
              }
            >
              <ToolOverrides label="Turned off" names={tools.builtIn.off} />
              <ToolOverrides label="Asks first" names={tools.builtIn.ask} tone="warning" />
              <ToolOverrides label="Allowed" names={tools.builtIn.allow} />
            </ListRow>
          )}
          {tools.custom.map((tool) => (
            <ListRow
              key={`custom-${tool.name}`}
              leading={<EntityAvatar icon={WrenchIcon} size="md" />}
              title={<span className="font-mono text-xs font-normal">{tool.name}</span>}
              description={tool.description || "Custom tool: your code runs it and returns the result"}
              trailing={<Chip>Custom tool</Chip>}
            />
          ))}
          {tools.servers.map((server) => {
            const Brand = localBrandIcon(server.name);
            return (
              <ListRow
                key={`mcp-${server.name}`}
                leading={
                  Brand ? <EntityAvatar icon={Brand} size="md" /> : <AppIcon name={server.label} size="md" />
                }
                title={server.label}
                description={
                  <span title={server.host}>
                    MCP server{server.host ? ` · ${server.host}` : ""}
                  </span>
                }
                trailing={
                  <Chip tone={TOOL_POLICY[server.policy].tone} title={TOOL_POLICY[server.policy].title}>
                    {TOOL_POLICY[server.policy].label}
                  </Chip>
                }
              />
            );
          })}
          {composioApps.map((app) => (
            <ListRow
              key={`app-${app.slug}`}
              leading={<AppIcon slug={app.slug} name={app.name} size="md" />}
              title={app.name}
              description={`Connected app · ${app.category}`}
              trailing={<Chip icon={PlugIcon}>Connected</Chip>}
            />
          ))}
        </SectionCard>

        {skillEntries.length > 0 && (
          <SectionCard title="Skills" description="Packaged know-how the agent loads when a task calls for it." flush>
            {skillEntries.map((entry, i) => {
              const id = entry.skill_id ?? "";
              const known = skillById.get(id);
              const anthropic = entry.type === "anthropic";
              const name = known?.name ?? (anthropic ? (ANTHROPIC_SKILL_LABEL[id] ?? id) : undefined);
              return (
                <ListRow
                  key={`${id}-${i}`}
                  leading={<EntityAvatar icon={PuzzleIcon} size="md" />}
                  title={
                    name ? (
                      name
                    ) : skillsLoading ? (
                      <Skeleton className="my-1 h-3.5 w-32" rounded="sm" />
                    ) : (
                      <span className="text-fg-subtle italic">Removed skill</span>
                    )
                  }
                  description={known?.description || (anthropic ? "Built-in document skill" : undefined)}
                  trailing={!name && !skillsLoading && id ? <IdChip id={id} label="Copy skill id" /> : undefined}
                />
              );
            })}
          </SectionCard>
        )}

        {delegates.length > 0 && (
          <SectionCard title="Works with" description="Agents this one can hand work to." flush>
            {delegates.map((d) => (
              <div key={d.id} className="flex min-h-12 items-center justify-between gap-3 border-t border-border px-5 py-2.5 first:border-t-0">
                <EntityRef kind="agent" id={d.id} />
                <Chip tone="outline" mono>
                  v{d.version}
                </Chip>
              </div>
            ))}
          </SectionCard>
        )}

        <SectionCard title="Integrations" description="Where people can reach this agent outside the console." flush>
          <PublicationRow kind="linear" label="Linear" icon={LinearIcon} agentId={agent.id} archived={archived} />
          <PublicationRow kind="github" label="GitHub" icon={GitHubIcon} agentId={agent.id} archived={archived} />
          <PublicationRow kind="slack" label="Slack" icon={SlackIcon} agentId={agent.id} archived={archived} />
        </SectionCard>
      </div>

      <aside className="grid min-w-0 items-start gap-4 md:grid-cols-2 xl:grid-cols-1">
        <SectionCard title="Details">
          <PropertyList labelWidth="narrow">
            <Property label="Model">
              <ModelBadge model={agent.model} variant="plain" className="text-fg" />
            </Property>
            {reasoning && <Property label="Reasoning">{REASONING_LABEL[reasoning] ?? reasoning}</Property>}
            <Property label="Runs on">{harnessLabel(agent._oma?.harness)}</Property>
            {binding && (
              <Property label="Local runtime" align="start">
                <div className="space-y-1">
                  <div className="truncate" title={runtimeHost ?? binding.runtime_id}>
                    {runtimeHost ?? <IdChip id={binding.runtime_id} label="Copy runtime id" />}
                  </div>
                  <div className="truncate font-mono text-xs text-fg-subtle" title={binding.acp_agent_id}>
                    {binding.acp_agent_id}
                  </div>
                </div>
              </Property>
            )}
            <Property label="Memory">
              {memoryMode === "off" ? <span className="text-fg-subtle">Off</span> : MEMORY_MODE_LABELS[memoryMode]}
            </Property>
          </PropertyList>

          {/* What it runs with, by name. These names are long, so each gets
              a full row instead of half of a label–value pair. */}
          <div className="mt-4 border-t border-border pt-4">
            <h4 className="text-xs font-medium text-fg-subtle">Runs with</h4>
            <ul className="-mx-2 mt-1.5">
              <ResourceRow
                kind="environment"
                icon={BoxIcon}
                id={agent._oma?.default_environment_id}
                role="Environment"
                emptyLabel="No default environment"
                emptyHint="Chosen when a session starts"
              />
              {vaultIds.length === 0 ? (
                <ResourceRow kind="vault" icon={VaultIcon} id={undefined} role="Vault" emptyLabel="No vaults attached" emptyHint="It has no stored credentials" />
              ) : (
                vaultIds.map((id) => <ResourceRow key={id} kind="vault" icon={VaultIcon} id={id} role="Vault" />)
              )}
              {memoryMode !== "off" && memoryStoreId && (
                <ResourceRow kind="memory_store" icon={BrainIcon} id={memoryStoreId} role="Memory store" />
              )}
            </ul>
          </div>

          <PropertyList labelWidth="narrow" className="mt-3 border-t border-border pt-3">
            <Property label="Created">
              <RelativeTime value={agent.created_at} fallback="Unknown" />
            </Property>
            <Property label="Updated">
              <RelativeTime value={agent.updated_at || agent.created_at} fallback="Unknown" />
            </Property>
            {agent.archived_at && (
              <Property label="Archived">
                <RelativeTime value={agent.archived_at} fallback="Unknown" />
              </Property>
            )}
            <Property label="Agent id">
              <IdChip id={agent.id} full label="Copy agent id" />
            </Property>
          </PropertyList>
        </SectionCard>

        <StatTile
          label="Sessions, last 30 days"
          loading={sessionsLoading}
          value={last30}
          hint={
            sessions.length === 0 ? (
              "No sessions yet"
            ) : (
              <span className="flex flex-wrap items-center gap-x-1.5">
                {running > 0 && (
                  <>
                    <span className="inline-flex items-center gap-1.5 font-medium text-info">
                      <StatusDot status="running" />
                      {running} running now
                    </span>
                    <span aria-hidden="true">·</span>
                  </>
                )}
                <span>
                  Last active <RelativeTime value={lastActive} />
                </span>
              </span>
            )
          }
          spark={last30 > 0 ? perDay : undefined}
          footer={
            recent.length > 0 ? (
              <div className="-mx-2 -mb-2">
                {recent.map((s) => {
                  const reading = read(s);
                  const tone = reading.tone;
                  return (
                    <Link
                      key={s.id}
                      to={`/sessions/${s.id}`}
                      className="flex min-h-9 items-center gap-2.5 rounded-md px-2 py-1.5 transition-quick hover:bg-bg-hover"
                    >
                      <SessionStatusDot reading={reading} className={cn(tone === "neutral" && "opacity-60")} />
                      <span className="min-w-0 flex-1 truncate text-small text-fg" title={sessionTitle(s, agent.name)}>
                        {sessionTitle(s, agent.name)}
                      </span>
                      <RelativeTime value={s.updated_at || s.created_at} className="shrink-0 text-xs text-fg-subtle" />
                      <span className="sr-only">{reading.label}</span>
                    </Link>
                  );
                })}
                {sessions.length > recent.length && (
                  <button
                    type="button"
                    onClick={onShowActivity}
                    className="mt-1 flex min-h-8 w-full items-center rounded-md px-2 text-left text-xs font-medium text-fg-muted transition-quick hover:bg-bg-hover hover:text-fg"
                  >
                    All {plural(sessions.length, "session")}
                  </button>
                )}
              </div>
            ) : undefined
          }
        />
      </aside>
    </div>
  );
}

/**
 * Something the agent runs with (its environment, a vault, its memory
 * store), by name, on a row of its own that links to the record. The name
 * may wrap to two lines; the id never shows. With no `id` it says what is
 * missing instead.
 */
function ResourceRow({
  kind,
  icon,
  id,
  role,
  emptyLabel,
  emptyHint,
}: {
  kind: EntityKind;
  icon: React.ComponentType<{ className?: string }>;
  id: string | null | undefined;
  /** What this resource is to the agent: "Environment", "Vault". */
  role: string;
  emptyLabel?: string;
  emptyHint?: string;
}) {
  const { name, isLoading, missing, href } = useEntityName(kind, id);
  const body = (
    <>
      <EntityAvatar icon={icon} size="md" className={!id || missing ? "opacity-60" : undefined} />
      <span className="min-w-0 flex-1">
        {isLoading ? (
          <Skeleton className="my-[3px] h-3.5 w-36" rounded="sm" />
        ) : (
          <span
            className={cn(
              "line-clamp-2 text-small leading-5 font-medium break-words",
              id && !missing ? "text-fg" : "text-fg-muted",
            )}
            title={name}
          >
            {!id ? emptyLabel : missing ? `Deleted ${role.toLowerCase()}` : name}
          </span>
        )}
        <span className="block text-xs text-fg-subtle">{!id ? emptyHint : role}</span>
      </span>
    </>
  );
  const row = "flex items-center gap-3 rounded-md px-2 py-1.5";
  return (
    <li>
      {id && href && !missing ? (
        <Link to={href} className={cn(row, "transition-quick hover:bg-bg-hover")}>
          {body}
        </Link>
      ) : (
        <div className={row}>{body}</div>
      )}
    </li>
  );
}

/** Per-tool exceptions to the default policy, as a labelled row of mono chips. */
function ToolOverrides({ label, names, tone }: { label: string; names: string[]; tone?: "warning" }) {
  if (names.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5" title={`${label}: ${listInWords(names)}`}>
      <span className="text-xs text-fg-subtle">{label}</span>
      {names.map((name) => (
        <Chip key={name} mono tone={tone ?? "neutral"}>
          {name}
        </Chip>
      ))}
    </div>
  );
}

/** System prompt as prose, folded to about twelve lines until asked for. */
function ClampedProse({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setOverflows(el.scrollHeight > 312);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text]);
  return (
    <div>
      <div className={cn("relative", !open && "max-h-[19.25rem] overflow-hidden")}>
        <div ref={ref} className="text-prose break-words whitespace-pre-line text-fg">
          {text}
        </div>
        {!open && overflows && (
          <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-bg-surface to-transparent" />
        )}
      </div>
      {overflows && (
        <Button variant="secondary" size="xs" className="mt-3" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? "Show less" : "Show all"}
        </Button>
      )}
    </div>
  );
}

function PublicationRow({
  kind,
  label,
  icon,
  agentId,
  archived,
}: {
  kind: "linear" | "github" | "slack";
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  agentId: string;
  archived: boolean;
}) {
  // Each provider is its own query: a provider that is not installed (404)
  // must not hide the others.
  const { data, isLoading } = useApiQuery<{ data: Pub[] }>(`/v1/integrations/${kind}/agents/${agentId}/publications`);
  const pubs = (data?.data ?? []).filter((p) => p.status === "live");
  const publishHref = `/integrations/${kind}/publish?agent_id=${agentId}`;
  const first = pubs[0];
  return (
    <ListRow
      leading={<EntityAvatar icon={icon} size="md" />}
      title={label}
      description={
        isLoading ? (
          <Skeleton className="my-0.5 h-3 w-36" rounded="sm" />
        ) : first ? (
          <>
            As {first.persona.name} in {first.workspace_name ?? `a ${label} workspace`}
            {first.mode === "full" ? " · full identity" : ""}
            {pubs.length > 1 ? ` · and ${pubs.length - 1} more` : ""}
          </>
        ) : (
          NOT_PUBLISHED_HINT[kind]
        )
      }
      trailing={
        isLoading ? null : first ? (
          <>
            <StatusBadge status="published" label={pubs.length > 1 ? `Published · ${pubs.length}` : "Published"} />
            <Button variant="ghost" size="sm" asChild>
              <Link to={publishHref}>Publish again</Link>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link to={`/integrations/${kind}`}>Manage</Link>
            </Button>
          </>
        ) : archived ? (
          <span className="text-xs text-fg-subtle">Not published</span>
        ) : (
          <Button variant="outline" size="sm" asChild>
            <Link to={publishHref} aria-label={`Publish to ${label}`}>
              Publish
            </Link>
          </Button>
        )
      }
    />
  );
}

const NOT_PUBLISHED_HINT: Record<"linear" | "github" | "slack", string> = {
  linear: "Assign issues to it and mention it in comments",
  github: "Let it pick up issues and pull requests",
  slack: "Message it in channels and DMs",
};
