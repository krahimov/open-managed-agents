import { useMemo, useState, type ReactNode } from "react";
import {
  ArchiveIcon,
  BoxIcon,
  CopyIcon,
  LayoutGridIcon,
  PencilIcon,
  PlusIcon,
  Rows3Icon,
  Trash2Icon,
} from "lucide-react";

import { VaultIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

import { AgentAvatar, EntityAvatar } from "../components/AgentAvatar";
import { AgentCard } from "../components/AgentCard";
import { AgentPicker } from "../components/AgentPicker";
import { Chip, StatusBadge } from "../components/Badge";
import { Callout } from "../components/Callout";
import { CodeWell, EventCard, EventSection } from "../components/EventCard";
import { SettingRow } from "../components/SettingRow";
import { Steps } from "../components/Steps";
import { Switch } from "@/components/ui/switch";
import { BarList, ChartLegend, Meter, Sparkline, TimeSeriesChart } from "../components/charts";
import { Composer } from "../components/Composer";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { DetailHeader } from "../components/DetailHeader";
import { Disclosure } from "../components/Disclosure";
import { EmptyState } from "../components/EmptyState";
import { EntityRef } from "../components/EntityRef";
import { Field } from "../components/Field";
import { FilterChip } from "../components/FilterChip";
import { FacetedFilter } from "../components/FacetedFilter";
import { IdChip } from "../components/IdChip";
import { Kbd } from "../components/Kbd";
import { Modal } from "../components/Modal";
import { ModelBadge } from "../components/ModelBadge";
import { Page } from "../components/Page";
import { Property, PropertyList } from "../components/PropertyList";
import { QueryProblem } from "../components/QueryProblem";
import { RelativeTime } from "../components/RelativeTime";
import { RowActionsMenu } from "../components/RowActionsMenu";
import { Section, SectionCard } from "../components/SectionCard";
import { SegmentedControl } from "../components/SegmentedControl";
import { Select, SelectOption } from "../components/Select";
import { Skeleton, SkeletonCard, SkeletonText } from "../components/Skeleton";
import { StatTile } from "../components/StatTile";
import { TabBar, useTabParam } from "../components/TabBar";
import { SearchInput } from "../components/Toolbar";
import { PopoverContent } from "@/components/ui/popover";
import { agentCapabilities, harnessLabel } from "../lib/agents";
import { useAgents } from "../lib/directory";
import { useAgentActivityNow } from "../components/sessions/readings";
import { formatCompact, formatCost } from "../lib/format";
import { describeModel, PROVIDER_COLOR, providerOf } from "../lib/models";
import { useApiQuery } from "../lib/useApiQuery";

/**
 * /_kit — the Muse kit on one page, rendered with live workspace data.
 * It is the visual companion to DESIGN.md: open it in both themes when you
 * need to see how a shared component looks, sits and behaves before using
 * it. Not linked from the navigation.
 */

interface UsageReport {
  totals: { cost_usd: number; processed_tokens: number; sessions: number };
  daily: Array<{ day: string; provider: string; cost_usd: number; tokens: number }>;
  models: Array<{ model: string; provider: string; cost_usd: number; tokens: number }>;
}

const DAY = 86_400_000;

function Swatch({ name, className, note }: { name: string; className: string; note?: string }) {
  return (
    <div className="min-w-0">
      <div className={`h-12 rounded-lg border border-border ${className}`} />
      <div className="mt-1.5 truncate font-mono text-micro-size text-fg">{name}</div>
      {note && <div className="truncate text-micro-size text-fg-subtle">{note}</div>}
    </div>
  );
}

function Demo({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={className}>
      <div className="mb-2 text-xs font-medium text-fg-subtle">{label}</div>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

export function Kit() {
  const { agents } = useAgents();
  const { byAgent } = useAgentActivityNow();
  const agent = agents.find((a) => !a.archived_at && (a.mcp_servers?.length ?? 0) > 0) ?? agents[0];

  const usageParams = useMemo(() => {
    const until = Math.ceil(Date.now() / DAY) * DAY;
    return { since: String(until - 30 * DAY), until: String(until) };
  }, []);
  const usage = useApiQuery<UsageReport>("/v1/usage", usageParams);
  const series = useMemo(() => {
    const until = Number(usageParams.until);
    const days: string[] = [];
    for (let t = until - 30 * DAY; t < until; t += DAY) days.push(new Date(t).toISOString().slice(0, 10));
    const by = (provider: string) =>
      days.map((d) => usage.data?.daily.find((r) => r.day === d && r.provider === provider)?.cost_usd ?? 0);
    return { days, anthropic: by("anthropic"), openai: by("openai") };
  }, [usage.data, usageParams.until]);
  const total = series.anthropic.map((v, i) => v + series.openai[i]);

  const [tab, setTab] = useTabParam<"overview" | "activity" | "triggers" | "versions">("overview");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [text, setText] = useState("");
  const [agentId, setAgentId] = useState<string | null>(null);
  const [status, setStatus] = useState("active");
  const [select, setSelect] = useState("daily");
  const [modal, setModal] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [q, setQ] = useState("");
  const [step, setStep] = useState(1);
  const [allowMcp, setAllowMcp] = useState(true);

  const fmtDay = (d: string) =>
    new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });

  return (
    <Page width="default" className="space-y-14 pt-8">
      <header>
        <h1 className="text-h1 text-fg">Muse kit</h1>
        <p className="mt-1 max-w-[72ch] text-sm text-fg-muted">
          Every shared component, drawn with this workspace's data. The rules for each one are in{" "}
          <code className="rounded-sm bg-bg-soft px-1 py-0.5 text-[0.8em]">apps/console/DESIGN.md</code>.
        </p>
      </header>

      <Section title="Colour" description="Roles, not hues. Surfaces step up with elevation.">
        <div className="grid grid-cols-3 gap-4 sm:grid-cols-6">
          <Swatch name="bg-sidebar" className="bg-bg-sidebar" note="stage" />
          <Swatch name="bg" className="bg-bg" note="page canvas" />
          <Swatch name="bg-surface" className="bg-bg-surface" note="card" />
          <Swatch name="bg-raised" className="bg-bg-raised" note="popover" />
          <Swatch name="bg-inset" className="bg-bg-inset" note="well" />
          <Swatch name="bg-soft" className="bg-bg-soft" note="chip / soft fill" />
          <Swatch name="ink" className="bg-ink" note="primary" />
          <Swatch name="plum" className="bg-plum" note="accent" />
          <Swatch name="success" className="bg-success-subtle" note="+ subtle" />
          <Swatch name="warning" className="bg-warning-subtle" note="+ subtle" />
          <Swatch name="danger" className="bg-danger-subtle" note="+ subtle" />
          <Swatch name="info" className="bg-info-subtle" note="+ subtle" />
        </div>
        <div className="mt-4 grid grid-cols-3 gap-4 sm:grid-cols-6">
          {[1, 2, 3, 4, 5, 6].map((n) => (
            <div key={n}>
              <div className="h-8 rounded-lg" style={{ background: `var(--chart-${n})` }} />
              <div className="mt-1.5 font-mono text-micro-size text-fg">chart-{n}</div>
            </div>
          ))}
        </div>
        <div className="wash relative mt-4 h-28 overflow-hidden rounded-xl border border-border">
          <span className="absolute bottom-3 left-4 font-mono text-micro-size text-fg-muted">wash</span>
        </div>
      </Section>

      <Section title="Type" description="Hanken Grotesk for everything, JetBrains Mono for ids and code.">
        <div className="surface space-y-4 rounded-xl p-6">
          {(
            [
              ["text-display", "Good evening", "40 / 560 · the Home greeting only"],
              ["text-h1", "Support Triage", "26 / 600 · page and record titles"],
              ["text-h2", "Recent sessions", "18 / 600 · section titles"],
              ["text-h3", "Triggers", "15 / 600 · card titles"],
              ["text-prose", "Thanks for the clear report. We found the cause in the Okta setup.", "15.5 / 1.65 · conversation prose"],
              ["text-body", "Classifies inbound tickets and drafts replies.", "14 · default UI text"],
              ["text-small", "3 sessions · active 5d ago", "13 · secondary text, table cells, controls"],
              ["text-caption", "Updated 3h ago", "12 · captions, chips"],
              ["text-micro", "G then A", "11 · kbd, counts"],
            ] as const
          ).map(([cls, sample, note]) => (
            <div key={cls} className="grid items-baseline gap-x-6 gap-y-1 sm:grid-cols-[9rem_1fr_16rem]">
              <code className="text-micro-size text-fg-subtle">{cls}</code>
              <span className={`${cls} text-fg`}>{sample}</span>
              <span className="text-xs text-fg-subtle">{note}</span>
            </div>
          ))}
          <div className="grid items-baseline gap-x-6 sm:grid-cols-[9rem_1fr_16rem]">
            <code className="text-micro-size text-fg-subtle">font-mono</code>
            <span className="font-mono text-small-size text-fg">agent-rrtcdqruug4a13d0 · $181.63 · 1,234,567</span>
            <span className="text-xs text-fg-subtle">ids, code, tool input</span>
          </div>
        </div>
      </Section>

      <Section title="Buttons" description="Pills. One ink button per view.">
        <div className="surface grid gap-6 rounded-xl p-6 md:grid-cols-2">
          <Demo label="Variants">
            <Button>Start session</Button>
            <Button variant="outline">Edit</Button>
            <Button variant="secondary">Add trigger</Button>
            <Button variant="ghost">Cancel</Button>
            <Button variant="destructive">Delete</Button>
            <Button variant="link">Learn more</Button>
          </Demo>
          <Demo label="Sizes: lg 40 · default 36 · sm 32 · xs 28">
            <Button size="lg">Large</Button>
            <Button>Default</Button>
            <Button size="sm">Small</Button>
            <Button size="xs">Tiny</Button>
          </Demo>
          <Demo label="With icons, loading, disabled">
            <Button>
              <PlusIcon data-icon="inline-start" />
              New agent
            </Button>
            <Button variant="outline">
              <PencilIcon data-icon="inline-start" />
              Edit
            </Button>
            <Button loading loadingLabel="Saving…">
              Save
            </Button>
            <Button disabled>Disabled</Button>
          </Demo>
          <Demo label="Icon buttons, segmented control, kbd">
            <Button variant="outline" size="icon" aria-label="Copy">
              <CopyIcon />
            </Button>
            <Button variant="ghost" size="icon" aria-label="Archive">
              <ArchiveIcon />
            </Button>
            <SegmentedControl
              label="View"
              value={view}
              onChange={setView}
              iconOnly
              options={[
                { value: "grid", label: "Gallery", icon: LayoutGridIcon },
                { value: "list", label: "List", icon: Rows3Icon },
              ]}
            />
            <SegmentedControl
              label="Range"
              size="sm"
              value={select}
              onChange={setSelect}
              options={[
                { value: "daily", label: "7 days" },
                { value: "weekly", label: "30 days" },
                { value: "monthly", label: "90 days" },
              ]}
            />
            <Kbd keys={["⌘", "K"]} />
            <Kbd keys={["G", "A"]} then />
          </Demo>
        </div>
      </Section>

      <Section title="Form controls" description="Label above, hint or error below. 36px tall, 10px radius.">
        <div className="surface grid gap-x-6 gap-y-5 rounded-xl p-6 md:grid-cols-2">
          <Field label="Name" hint="Shown in the gallery and in session headers.">
            <Input placeholder="Support Triage" />
          </Field>
          <Field label="Slug" error="Use lowercase letters, numbers and dashes.">
            <Input defaultValue="Support Triage!" />
          </Field>
          <Field label="Schedule">
            <Select value={select} onValueChange={setSelect} placeholder="Pick a schedule">
              <SelectOption value="daily">Every day</SelectOption>
              <SelectOption value="weekly">Every week</SelectOption>
              <SelectOption value="monthly">Every month</SelectOption>
            </Select>
          </Field>
          <Field label="Search">
            <SearchInput value={q} onChange={setQ} placeholder="Search agents" width="w-full" />
          </Field>
          <Field label="Instructions" className="md:col-span-2">
            <Textarea placeholder="You are a support triage agent…" />
          </Field>
          <div className="flex flex-wrap items-center gap-4 md:col-span-2">
            <label className="flex cursor-pointer items-center gap-2 text-small text-fg">
              <Checkbox defaultChecked /> Require approval for shell commands
            </label>
            <FilterChip label="Status" active={status !== "any"} display={status === "any" ? undefined : "Active"} onClear={() => setStatus("any")}>
              <PopoverContent align="start" className="w-52 gap-0 p-0">
                <FacetedFilter
                  options={[
                    { value: "any", label: "All" },
                    { value: "active", label: "Active" },
                    { value: "archived", label: "Archived" },
                  ]}
                  value={status}
                  onValueChange={setStatus}
                  searchPlaceholder="Status"
                />
              </PopoverContent>
            </FilterChip>
            <FilterChip label="Created" active={false}>
              <PopoverContent align="start" className="w-52 p-3 text-small text-fg-muted">
                A resting chip is dashed.
              </PopoverContent>
            </FilterChip>
          </div>
        </div>
      </Section>

      <Section title="Status, chips and identity" description="One status vocabulary. Names lead; ids are a chip.">
        <div className="surface grid gap-6 rounded-xl p-6 md:grid-cols-2">
          <Demo label="StatusBadge (dot): tables and rows">
            {["running", "idle", "approval", "errored", "completed", "terminated", "archived"].map((s) => (
              <StatusBadge key={s} status={s} className="mr-2" />
            ))}
          </Demo>
          <Demo label='StatusBadge variant="soft": headers and cards'>
            {["running", "approval", "errored", "active", "pending", "archived"].map((s) => (
              <StatusBadge key={s} status={s} variant="soft" />
            ))}
          </Demo>
          <Demo label="Chip, ModelBadge, IdChip">
            {agent && agentCapabilities(agent).map((c) => (
              <Chip key={c.key} icon={c.icon} title={c.title}>
                {c.label}
              </Chip>
            ))}
            <Chip tone="outline" mono>
              v3
            </Chip>
            <ModelBadge model="claude-opus-4-8" />
            <ModelBadge model="gpt-5.5-mini" />
            <ModelBadge model="claude-sonnet-4-6" variant="plain" />
            {agent && <IdChip id={agent.id} />}
          </Demo>
          <Demo label="AgentAvatar xs → 2xl, EntityAvatar">
            {agent &&
              (["xs", "sm", "md", "lg", "xl", "2xl"] as const).map((s) => (
                <AgentAvatar key={s} name={agent.name} id={agent.id} size={s} />
              ))}
            <EntityAvatar icon={BoxIcon} size="lg" />
            <EntityAvatar icon={VaultIcon} size="lg" tone="surface" />
          </Demo>
          <Demo label="EntityRef resolves an id to a name" className="md:col-span-2">
            {agent && <EntityRef kind="agent" id={agent.id} />}
            {agent?._oma?.default_environment_id && (
              <EntityRef kind="environment" id={agent._oma.default_environment_id} variant="chip" />
            )}
            {agent?._oma?.default_vault_ids?.[0] && <EntityRef kind="vault" id={agent._oma.default_vault_ids[0]} variant="chip" />}
            <span className="text-small text-fg-muted">
              Updated <RelativeTime value={agent?.updated_at ?? agent?.created_at} />
            </span>
          </Demo>
        </div>
      </Section>

      {agent && (
        <Section title="Record page" description="DetailHeader + TabBar + SectionCards with PropertyLists.">
          <div className="surface relative overflow-hidden rounded-xl px-6 pt-2 pb-6">
            <DetailHeader
              wash="inline"
              avatar={<AgentAvatar name={agent.name} id={agent.id} size="xl" />}
              title={agent.name}
              status={<StatusBadge status="active" variant="soft" />}
              description={agent.description}
              meta={
                <>
                  <ModelBadge model={agent.model} />
                  {agentCapabilities(agent).map((c) => (
                    <Chip key={c.key} icon={c.icon} title={c.title}>
                      {c.label}
                    </Chip>
                  ))}
                  <Chip tone="outline" mono>
                    v{agent.version}
                  </Chip>
                  <IdChip id={agent.id} />
                </>
              }
              actions={
                <>
                  <Button variant="outline">
                    <PencilIcon data-icon="inline-start" />
                    Edit
                  </Button>
                  <Button>Start session</Button>
                </>
              }
              menu={
                <RowActionsMenu
                  label="More actions"
                  actions={[
                    { label: "Deploy", onSelect: () => {} },
                    { label: "Archive", icon: <ArchiveIcon />, onSelect: () => setConfirm(true) },
                    { label: "Delete", icon: <Trash2Icon />, destructive: true, onSelect: () => setConfirm(true) },
                  ]}
                />
              }
            >
              <TabBar
                label="Agent sections"
                value={tab}
                onChange={setTab}
                tabs={[
                  { value: "overview", label: "Overview" },
                  { value: "activity", label: "Activity", count: byAgent.get(agent.id)?.sessions ?? 0 },
                  { value: "triggers", label: "Triggers", count: 2 },
                  { value: "versions", label: "Versions" },
                ]}
              />
            </DetailHeader>

            <div className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
              <SectionCard
                title="Instructions"
                description="The system prompt this agent starts every session with."
                actions={
                  <Button size="sm" variant="outline">
                    Edit
                  </Button>
                }
              >
                <p className="line-clamp-5 text-prose whitespace-pre-line text-fg">{agent.system}</p>
              </SectionCard>
              <SectionCard title="Details">
                <PropertyList>
                  <Property label="Model">
                    <ModelBadge model={agent.model} variant="plain" />
                  </Property>
                  <Property label="Harness">{harnessLabel(agent._oma?.harness)}</Property>
                  <Property label="Environment">
                    <EntityRef kind="environment" id={agent._oma?.default_environment_id} />
                  </Property>
                  <Property label="Vaults" empty="None attached">
                    {agent._oma?.default_vault_ids?.length ? (
                      <span className="flex flex-wrap gap-1.5">
                        {agent._oma.default_vault_ids.map((v) => (
                          <EntityRef key={v} kind="vault" id={v} variant="chip" />
                        ))}
                      </span>
                    ) : null}
                  </Property>
                  <Property label="Created">
                    <RelativeTime value={agent.created_at} />
                  </Property>
                  <Property label="Agent id">
                    <IdChip id={agent.id} full />
                  </Property>
                </PropertyList>
              </SectionCard>
            </div>
          </div>
        </Section>
      )}

      <Section title="Numbers and charts" description="Hand-built SVG. Series colours come from --chart-1…6, in order.">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Estimated spend"
            value={formatCost(usage.data?.totals.cost_usd)}
            delta={{ value: "12%", direction: "down", good: true }}
            hint="vs the week before"
            spark={total}
            loading={usage.isLoading}
          />
          <StatTile label="Sessions" value={usage.data?.totals.sessions ?? 0} hint="last 30 days" delta={{ value: "4", direction: "up", good: true }} loading={usage.isLoading} />
          <StatTile label="Tokens processed" value={formatCompact(usage.data?.totals.processed_tokens)} spark={total} sparkColor="var(--chart-3)" loading={usage.isLoading} />
          <StatTile label="Loading" value="" spark={[1, 2]} loading />
        </div>
        <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <SectionCard title="Spend by provider" description="Estimated API cost per day, last 30 days.">
            <TimeSeriesChart
              type="area"
              stacked
              labels={series.days}
              series={[
                { id: "anthropic", label: "Anthropic", color: "var(--chart-anthropic)", values: series.anthropic },
                { id: "openai", label: "OpenAI", color: "var(--chart-openai)", values: series.openai },
              ]}
              formatValue={formatCost}
              formatTick={(n) => `$${n}`}
              formatLabel={fmtDay}
              height={220}
              aria-label="Estimated spend per day by provider"
            />
          </SectionCard>
          <SectionCard title="Spend by model">
            <BarList
              formatValue={formatCost}
              items={(usage.data?.models ?? []).map((m) => ({
                id: m.model,
                label: describeModel(m.model).label,
                hint: `${formatCompact(m.tokens)} tokens`,
                value: m.cost_usd,
                color: PROVIDER_COLOR[providerOf(m.model)],
              }))}
            />
          </SectionCard>
        </div>
        <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <SectionCard title="Spend per day" description="The same data as columns.">
            <TimeSeriesChart
              type="bar"
              labels={series.days}
              series={[
                { id: "anthropic", label: "Anthropic", color: "var(--chart-anthropic)", values: series.anthropic },
                { id: "openai", label: "OpenAI", color: "var(--chart-openai)", values: series.openai },
              ]}
              formatValue={formatCost}
              formatTick={(n) => `$${n}`}
              formatLabel={fmtDay}
              height={200}
              aria-label="Estimated spend per day, stacked by provider"
            />
          </SectionCard>
          <SectionCard title="Budgets" footer="Limits reset at midnight UTC.">
            <div className="space-y-5">
              <Meter label="Daily cost" value={6.4} max={10} formatValue={formatCost} />
              <Meter label="Daily tokens" value={8.6e6} max={10e6} formatValue={formatCompact} />
              <Meter label="Concurrent sessions" value={5} max={5} />
              <div className="flex items-center justify-between gap-4">
                <ChartLegend
                  items={[
                    { label: "Anthropic", color: "var(--chart-anthropic)", value: "71%" },
                    { label: "OpenAI", color: "var(--chart-openai)", value: "29%" },
                  ]}
                />
                <Sparkline data={total} height={28} className="max-w-28" />
              </div>
            </div>
          </SectionCard>
        </div>
      </Section>

      <Section title="Cards" description="AgentCard is the record card. Sessions are rows: in a table, on Home, in the sidebar.">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {agents.slice(0, 3).map((a) => (
            <AgentCard key={a.id} agent={a} activity={byAgent.get(a.id)} />
          ))}
        </div>
      </Section>

      <Section title="Tabs and disclosure">
        <div className="surface grid gap-6 rounded-xl p-6 md:grid-cols-2">
          <Tabs defaultValue="conversation">
            <TabsList>
              <TabsTrigger value="conversation">Conversation</TabsTrigger>
              <TabsTrigger value="timeline">Timeline</TabsTrigger>
            </TabsList>
            <TabsContent value="conversation" className="text-small text-fg-muted">
              Pill tabs switch a view of the same content.
            </TabsContent>
            <TabsContent value="timeline" className="text-small text-fg-muted">
              The timeline of the same session.
            </TabsContent>
          </Tabs>
          <div className="space-y-2">
            <Disclosure title="Advanced settings" meta="3 options">
              <p className="text-small text-fg-muted">Rarely changed options fold away. They never sit open by default.</p>
            </Disclosure>
            <Disclosure title="Thought for 4 seconds" variant="bare">
              <p className="text-small text-fg-muted">The bare variant sits inside another surface.</p>
            </Disclosure>
          </div>
        </div>
      </Section>

      <Section title="Empty, loading, error" description="Three different states. Never substitute one for another.">
        <div className="grid gap-4 lg:grid-cols-3">
          <EmptyState
            kind="vault"
            title="No vaults yet"
            body="Vaults hold the credentials your agents use to reach other services."
            action={<Button>New vault</Button>}
          />
          <div className="space-y-4">
            <SkeletonCard />
            <div className="surface rounded-xl p-5">
              <div className="flex items-center gap-3">
                <Skeleton className="size-8" rounded="lg" />
                <Skeleton className="h-3.5 w-40" rounded="sm" />
              </div>
              <SkeletonText className="mt-4" lines={2} />
            </div>
          </div>
          <div className="space-y-4">
            <QueryProblem title="Sessions could not be loaded" error={new Error("Database unavailable")} retry={() => {}} />
            <QueryProblem compact title="Usage could not be loaded" error={new Error("timeout")} retry={() => {}} />
            <EmptyState size="sm" kind="session" title="No sessions match" body="Try a different agent or a wider date range." />
          </div>
        </div>
      </Section>

      <Section
        title="Conversation"
        description="A 720px reading column. The person's turns are soft bubbles on the right; the agent's are plain prose. Everything the agent does is an EventCard."
      >
        <div className="surface rounded-xl px-6 py-8">
          <div className="mx-auto max-w-[720px] space-y-6">
            {/* user turn */}
            <div className="flex justify-end">
              <div className="max-w-[85%] rounded-2xl rounded-br-md bg-bg-soft px-4 py-2.5 text-prose text-fg">
                Reconcile October Stripe payouts against the general ledger. Post any adjustments needed, but only after I approve them.
              </div>
            </div>
            {/* agent turn */}
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-small font-medium text-fg">
                <AgentAvatar name="Finance Ops Reconciler" id="agent-ttbcc38k9qz4qmud" size="sm" />
                Finance Ops Reconciler
                <span className="font-normal text-fg-subtle">· 4d ago</span>
              </div>
              <EventCard kind="thinking" title="Thought for 4 seconds">
                The ledger export covers 23 payouts. Two of them will not match one-to-one: a duplicated fee line and a payout that arrived on Oct 30 but posted on Nov 1.
              </EventCard>
              <EventCard kind="mcp" source="Stripe" title="list_payouts" subtitle="created[gte]=2026-10-01 limit=100" status="completed" meta="1.8s" />
              <EventCard
                kind="tool"
                title="bash"
                subtitle="python /workspace/recon/match.py --period 2026-10"
                status="completed"
                meta="6.2s"
                defaultOpen
              >
                <EventSection label="Input" copy="python /workspace/recon/match.py --period 2026-10">
                  <CodeWell>python /workspace/recon/match.py --period 2026-10</CodeWell>
                </EventSection>
                <EventSection label="Output">
                  <CodeWell>{"matched 21 of 23 payouts\nunmatched: po_1QxR7w ($10.00), po_1QyF2m ($16,992.55)"}</CodeWell>
                </EventSection>
              </EventCard>
              <p className="text-prose text-fg">
                <strong className="font-semibold">21 of 23 payouts match.</strong> The two that do not are a $10.00 fee booked twice and a
                $16,992.55 payout that crossed the month boundary. I have staged both adjustments.
              </p>
              <EventCard
                kind="approval"
                title="Finance Ops Reconciler wants to run bash"
                subtitle="This posts two adjustments to the ledger."
                meta="4d ago"
                actions={
                  <>
                    <Button size="sm">Allow this call</Button>
                    <Button size="sm" variant="outline">
                      Deny
                    </Button>
                  </>
                }
              >
                <CodeWell>python /workspace/recon/post_adjustments.py --file adjustments-2026-10.csv --period 2026-10 --apply</CodeWell>
              </EventCard>
              <EventCard kind="tool" title="bash" subtitle="python /workspace/recon/post_adjustments.py --apply" status="running" />
              <EventCard
                kind="error"
                title="The model request failed"
                subtitle="insufficient_quota · You exceeded your current quota."
                actions={
                  <Button size="sm" variant="outline">
                    Retry
                  </Button>
                }
              />
            </div>
          </div>
        </div>
      </Section>

      <Section title="Settings and wizards" description="SettingRow for switches and selects that apply on their own; Steps for multi-step flows; Callout for inline notices.">
        <div className="grid gap-4 lg:grid-cols-2">
          <SectionCard title="Networking" description="What sandboxes built from this environment can reach." flush>
            <SettingRow label="Allow MCP servers" description="Agents may reach the MCP servers attached to them." htmlFor="kit-mcp">
              <Switch id="kit-mcp" checked={allowMcp} onCheckedChange={setAllowMcp} />
            </SettingRow>
            <SettingRow label="Package managers" description="pip, npm and apt can install at run time.">
              <Switch defaultChecked={false} aria-label="Package managers" />
            </SettingRow>
            <SettingRow label="Network access">
              <Select value={select} onValueChange={setSelect} className="w-40">
                <SelectOption value="daily">Limited</SelectOption>
                <SelectOption value="weekly">Unrestricted</SelectOption>
                <SelectOption value="monthly">None</SelectOption>
              </Select>
            </SettingRow>
          </SectionCard>
          <div className="space-y-4">
            <div className="surface rounded-xl p-5">
              <Steps steps={["Template", "Model", "Tools", "Review"]} current={step} onStepClick={setStep} />
              <div className="mt-5 flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => setStep((n) => Math.max(0, n - 1))}>
                  Back
                </Button>
                <Button size="sm" onClick={() => setStep((n) => Math.min(3, n + 1))}>
                  Continue
                </Button>
              </div>
            </div>
            <Callout tone="neutral" icon={ArchiveIcon} title="This agent is archived">
              It no longer accepts new sessions. Its history is kept.
            </Callout>
            <Callout tone="warning" title="This key expires in 3 days" action={<Button size="sm" variant="outline">Renew</Button>}>
              Anything that signs in with it will stop working on Friday.
            </Callout>
            <Callout tone="info">Cost figures are API-price estimates. Subscription harnesses do not bill per token.</Callout>
          </div>
        </div>
      </Section>

      <Section title="Composer" description="The same prompt box on Home (lg) and in a session (md).">
        <div className="mx-auto max-w-[760px] space-y-4">
          <Composer
            value={text}
            onChange={setText}
            onSubmit={() => setText("")}
            placeholder="Reply to Support Triage"
            leading={<AgentPicker value={agentId ?? agent?.id ?? null} onChange={(id) => setAgentId(id)} />}
            attachments={{ files: [], onAdd: () => {}, onRemove: () => {} }}
          />
          <Composer value="" onChange={() => {}} onSubmit={() => {}} running onStop={() => {}} placeholder="The agent is working. Queue a follow-up…" />
        </div>
      </Section>

      <Section title="Dialogs" description="Modal for forms, ConfirmDialog for irreversible actions.">
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setModal(true)}>
            Open modal
          </Button>
          <Button variant="outline" onClick={() => setConfirm(true)}>
            Open confirm
          </Button>
        </div>
        <Modal
          open={modal}
          onClose={() => setModal(false)}
          title="New vault"
          subtitle="A vault groups the credentials an agent may use."
          footer={
            <>
              <Button variant="ghost" onClick={() => setModal(false)}>
                Cancel
              </Button>
              <Button onClick={() => setModal(false)}>Create vault</Button>
            </>
          }
        >
          <div className="space-y-4">
            <Field label="Name" hint="For example the team or the system it belongs to.">
              <Input placeholder="Support & Success" autoFocus />
            </Field>
            <Field label="Description">
              <Textarea placeholder="What these credentials are for" />
            </Field>
          </div>
        </Modal>
        <ConfirmDialog
          open={confirm}
          onClose={() => setConfirm(false)}
          destructive
          title={`Delete ${agent?.name ?? "agent"}?`}
          body="The agent and all of its versions are removed. Past sessions stay in history. This cannot be undone."
          confirmLabel="Delete agent"
          onConfirm={() => {}}
        />
      </Section>
    </Page>
  );
}
