/**
 * Usage: what the workspace's agents consumed (GET /v1/usage).
 *
 * Cost figures are API-price ESTIMATES. The managed loop is billed per
 * token on the workspace's model keys; the SDK harnesses (claude-agent-sdk,
 * codex-sdk) normally run on a subscription, so their figure is what the
 * same traffic would have cost on API keys. The page says so next to the
 * headline number, not only in a footnote.
 *
 * Layout: one headline (the chosen measure, its change, and its trend by
 * provider), three supporting numbers, the rankings by model and harness,
 * where the tokens went, and the same days as a table. The range and the
 * Cost | Tokens switch apply to everything on the page.
 *
 * The view is in the address: `?range=7d&metric=tokens&days=all`. A reload
 * keeps it and a link carries it. The defaults (30 days, cost, the latest
 * days) are left out, so a plain /usage is the default view. Changing the
 * view replaces the history entry: Back leaves the page, it does not step
 * through every range that was looked at.
 *
 * A change is only shown against the period before when that period has
 * enough in it to compare with, and then every number that can change
 * shows one and names its baseline ("8 in the 30 days before"). One tile
 * with an arrow beside two without reads as a mistake.
 *
 * A server without the usage tracker (`useServerFeature("usage")` off) is
 * never asked for the report: the page says usage is not recorded there.
 */

import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router";
import { ChartColumnIcon, RefreshCwIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  BarList,
  Callout,
  ChartLegend,
  EmptyState,
  ErrorState,
  Page,
  PageHeader,
  SectionCard,
  SegmentedControl,
  StatTile,
  TimeSeriesChart,
  Tip,
} from "@/components/kit";
import { harnessLabel } from "@/lib/agents";
import { useRecentSessions } from "@/lib/directory";
import { formatCompact, formatCost, plural } from "@/lib/format";
import { describeModel } from "@/lib/models";
import { useServerFeatures } from "@/lib/server-features";
import { usageWindow } from "@/lib/usage-window";
import { useApiQuery } from "@/lib/useApiQuery";
import { cn } from "@/lib/utils";

import {
  DailyTable,
  DeltaChip,
  ProportionBar,
  TokenMix,
  UsageSkeleton,
  periodChanges,
  providerColor,
  providerLabel,
  shortDay,
  sum,
  type DayCells,
  type Metric,
  type UsageReport,
} from "./usage/parts";

type RangeKey = "1" | "7" | "30" | "90";

/** `param` is how the range is written in the address. */
const RANGES: ReadonlyArray<{ value: RangeKey; label: string; words: string; param: string }> = [
  { value: "1", label: "24h", words: "24 hours", param: "24h" },
  { value: "7", label: "7 days", words: "7 days", param: "7d" },
  { value: "30", label: "30 days", words: "30 days", param: "30d" },
  { value: "90", label: "90 days", words: "90 days", param: "90d" },
];
const DEFAULT_RANGE: RangeKey = "30";
const DEFAULT_METRIC: Metric = "cost";

const DAY = 86_400_000;

/** Harnesses that normally run on a subscription instead of per-token API billing. */
const SUBSCRIPTION_HARNESSES = new Set(["claude-agent-sdk", "codex-sdk"]);

/** Axis ticks: "15M", not "15.0M". */
const tickCount = (n: number) => formatCompact(n).replace(/\.0(?=[kMB])/, "");

export function UsagePage() {
  // The view lives in the address (see the header comment). Anything the
  // address does not say, or says wrongly, is the default.
  const [searchParams, setSearchParams] = useSearchParams();
  const range: RangeKey = RANGES.find((r) => r.param === searchParams.get("range"))?.value ?? DEFAULT_RANGE;
  const metric: Metric = searchParams.get("metric") === "tokens" ? "tokens" : DEFAULT_METRIC;
  const allDays = searchParams.get("days") === "all";
  const setView = useCallback(
    (key: "range" | "metric" | "days", value: string | null) =>
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (value === null) next.delete(key);
          else next.set(key, value);
          return next;
        },
        { replace: true },
      ),
    [setSearchParams],
  );
  const setRange = (value: RangeKey) => setView("range", value === DEFAULT_RANGE ? null : (RANGES.find((r) => r.value === value)?.param ?? null));
  const setMetric = (value: Metric) => setView("metric", value === DEFAULT_METRIC ? null : value);

  // The window comes from the helper Home uses too, so "last 30 days" is one
  // request and one number on both pages, and the period before is the same length.
  const { since, until, params, previousParams: prevParams } = useMemo(() => usageWindow(Number(range)), [range]);

  const features = useServerFeatures();
  const tracked = features.data?.features.has("usage") ?? false;
  const notTracked = !features.isLoading && !tracked;
  const { data, isLoading, isFetching, isPlaceholderData, error, refetch } = useApiQuery<UsageReport>(tracked ? "/v1/usage" : null, params, {
    refetchInterval: 60_000,
  });
  // The same report for the period before, to say whether things went up or down.
  const previous = useApiQuery<UsageReport>(tracked ? "/v1/usage" : null, prevParams, { staleTime: 5 * 60_000 });
  const prev = previous.isPlaceholderData ? undefined : previous.data?.totals;

  const words = RANGES.find((r) => r.value === range)?.words ?? `${range} days`;
  const fmt = metric === "cost" ? formatCost : formatCompact;

  // The report counts by UTC day; so does every label on this page.
  const days = useMemo(() => {
    const out: string[] = [];
    for (let d = Math.floor(since / DAY); d <= Math.floor((until - 1) / DAY); d++) {
      out.push(new Date(d * DAY).toISOString().slice(0, 10));
    }
    return out;
  }, [since, until]);
  const today = days[days.length - 1];

  const byDay = useMemo(() => {
    const map: DayCells = new Map();
    for (const row of data?.daily ?? []) {
      const dayMap = map.get(row.day) ?? new Map();
      dayMap.set(row.provider, { cost: row.cost_usd, tokens: row.tokens });
      map.set(row.day, dayMap);
    }
    return map;
  }, [data]);

  const providers = useMemo(() => (data?.providers ?? []).map((p) => p.provider), [data]);

  const series = useMemo(
    () =>
      providers.map((p) => ({
        id: p,
        label: providerLabel(p),
        color: providerColor(p),
        values: days.map((d) => {
          const cell = byDay.get(d)?.get(p);
          return cell ? (metric === "cost" ? cell.cost : cell.tokens) : 0;
        }),
      })),
    [providers, days, byDay, metric],
  );

  const dailyCost = useMemo(() => days.map((d) => sum([...(byDay.get(d)?.values() ?? [])].map((c) => c.cost))), [days, byDay]);
  const dailyTokens = useMemo(
    () => days.map((d) => sum([...(byDay.get(d)?.values() ?? [])].map((c) => c.tokens))),
    [days, byDay],
  );

  // The report has no per-day session count; the directory's recent sessions do.
  const { sessions: recentSessions } = useRecentSessions();
  const dailySessions = useMemo(() => {
    const perDay = new Map<string, number>();
    for (const s of recentSessions) {
      const d = new Date(s.created_at).toISOString().slice(0, 10);
      perDay.set(d, (perDay.get(d) ?? 0) + 1);
    }
    return days.map((d) => perDay.get(d) ?? 0);
  }, [recentSessions, days]);

  // A trend needs a few points and something in them; a flat line under "$0.00" says nothing.
  const spark = (values: number[]) => (days.length >= 4 && values.some((v) => v > 0) ? values : undefined);

  const totals = data?.totals;
  const empty = !!data && data.totals.calls === 0;
  const uncachedPrice = totals ? totals.cost_usd + totals.cache_savings_usd : 0;
  const savedShare = totals && uncachedPrice > 0 ? totals.cache_savings_usd / uncachedPrice : 0;

  const header = (
    <PageHeader
      width="wide"
      title="Usage"
      subtitle="What your agents consumed, priced at API rates."
      actions={
        <>
          <SegmentedControl
            label="Measure"
            value={metric}
            onChange={setMetric}
            options={[
              { value: "cost", label: "Cost" },
              { value: "tokens", label: "Tokens" },
            ]}
          />
          <SegmentedControl label="Range" value={range} onChange={setRange} options={RANGES} />
          <Tip label="Refresh">
            <Button variant="ghost" size="icon" aria-label="Refresh usage" onClick={() => refetch()} disabled={isFetching}>
              <RefreshCwIcon className={cn(isFetching && "animate-spin")} />
            </Button>
          </Tip>
        </>
      }
    />
  );

  if (notTracked) {
    return (
      <Page header={<PageHeader width="wide" title="Usage" subtitle="What your agents consumed, priced at API rates." />} width="wide">
        <EmptyState
          size="lg"
          icon={<ChartColumnIcon />}
          title="Usage is not recorded on this server"
          body="This server does not keep a record of model calls, so there is no spend or token count to show. Each session still shows its own activity."
        />
      </Page>
    );
  }

  if ((features.isLoading || (isLoading && !data)) && !error) {
    return (
      <Page header={header} width="wide">
        <UsageSkeleton />
      </Page>
    );
  }

  if (error && !data) {
    return (
      <Page header={header} width="wide">
        <ErrorState title="Usage could not be loaded" error={error} retry={refetch} />
      </Page>
    );
  }

  if (isLoading && !data) {
    return (
      <Page header={header} width="wide">
        <UsageSkeleton />
      </Page>
    );
  }
  if (!data || !totals) return <Page header={header} width="wide">{null}</Page>;

  if (empty) {
    const next = RANGES[RANGES.findIndex((r) => r.value === range) + 1];
    return (
      <Page header={header} width="wide">
        <EmptyState
          size="lg"
          icon={<ChartColumnIcon />}
          title={`No usage in the last ${words}`}
          body="Every model call is recorded here once a session runs, including turns that a subscription paid for."
          action={
            next ? (
              <Button variant="outline" onClick={() => setRange(next.value)}>
                Show {next.words}
              </Button>
            ) : undefined
          }
        />
      </Page>
    );
  }

  // What part of the estimate is real per-token billing, and what part a subscription normally covers.
  const subscriptionCost = sum(data.harnesses.filter((h) => SUBSCRIPTION_HARNESSES.has(h.harness)).map((h) => h.cost_usd));
  const perTokenCost = Math.max(totals.cost_usd - subscriptionCost, 0);

  // Change against the period before: all three numbers or none (see the header comment).
  const delta = periodChanges(totals, prev);
  const comparable = delta.comparable;
  /** What a tile's change is measured against: "8 in the 30 days before". */
  const baseline = (value: string) => `${value} in the ${words} before`;

  const headline =
    metric === "cost"
      ? { label: "Estimated spend", value: formatCost(totals.cost_usd), delta: delta.cost }
      : { label: "Tokens processed", value: formatCompact(totals.processed_tokens), delta: delta.tokens };
  const trend = days.length > 2;
  const columns = days.length <= 32;

  return (
    <Page header={header} width="wide">
      {/* While another range loads, the last one stays on screen, dimmed: no skeleton flash, no jump. */}
      <div className={cn("space-y-6 transition-opacity duration-[var(--dur-base)]", isPlaceholderData && "opacity-60")}>
        {/* The headline: one number, its change, and how it built up. */}
        <section aria-label={`${headline.label} in the last ${words}`} className="surface rounded-xl p-5 lg:p-6">
          <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
            <div className="min-w-0">
              <p className="text-small text-fg-muted">
                {headline.label} <span className="text-fg-subtle">· last {words}</span>
              </p>
              <p className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-hero text-fg proportional-nums">
                  {headline.value}
                </span>
                {headline.delta && (
                  <span className="flex items-baseline gap-1.5">
                    <DeltaChip delta={headline.delta} className="translate-y-px self-center" />
                    <span className="text-small text-fg-subtle">vs the {words} before</span>
                  </span>
                )}
              </p>
              {metric === "cost" ? (
                subscriptionCost > 0 && (
                  <p className="mt-3 text-small text-fg-muted">
                    <span className="font-medium text-fg">{formatCost(perTokenCost)}</span> billed per token on your model keys
                    <span aria-hidden="true" className="px-1.5 text-fg-faint">
                      ·
                    </span>
                    <span className="font-medium text-fg">{formatCost(subscriptionCost)}</span> on subscriptions, at API prices
                  </p>
                )
              ) : (
                <p className="mt-3 text-small text-fg-muted">
                  {formatCompact(totals.calls)} model calls across {plural(totals.sessions, "session")}
                </p>
              )}
            </div>
            {trend && (
              <ChartLegend
                className="justify-end pt-1"
                items={data.providers.map((p) => ({
                  label: providerLabel(p.provider),
                  color: providerColor(p.provider),
                  value: fmt(metric === "cost" ? p.cost_usd : p.tokens),
                }))}
              />
            )}
          </div>

          {trend ? (
            <>
              <TimeSeriesChart
                className="mt-6"
                type={columns ? "bar" : "area"}
                // A month of days reads best as slim columns; a week can afford wider ones.
                barWidth={days.length > 10 ? 14 : 24}
                stacked
                legend={false}
                labels={days}
                series={series}
                height={260}
                formatValue={fmt}
                formatTick={metric === "cost" ? (n) => `$${n.toLocaleString()}` : tickCount}
                formatLabel={shortDay}
                aria-label={
                  metric === "cost" ? "Estimated spend per day by provider" : "Tokens processed per day by provider"
                }
              />
              <p className="mt-3 text-xs text-fg-subtle">
                {metric === "cost" ? "Estimated API cost" : "Tokens processed"} per UTC day, by provider. The last{" "}
                {columns ? "column" : "point"} is today so far.
              </p>
            </>
          ) : (
            <div className="mt-6 max-w-[560px]">
              <BarList
                formatValue={fmt}
                items={data.providers.map((p) => ({
                  id: p.provider,
                  label: providerLabel(p.provider),
                  value: metric === "cost" ? p.cost_usd : p.tokens,
                  hint: plural(p.sessions, "session"),
                  color: providerColor(p.provider),
                }))}
              />
              <p className="mt-4 text-xs text-fg-subtle">
                Usage is counted per day, so 24 hours has no trend to draw. Pick a longer range to see one.
              </p>
            </div>
          )}
        </section>

        {/* Supporting numbers */}
        <div className="grid gap-4 sm:grid-cols-3">
          {metric === "cost" ? (
            <StatTile
              label="Tokens processed"
              value={formatCompact(totals.processed_tokens)}
              delta={delta.tokens}
              hint={
                comparable && prev
                  ? `${formatCompact(totals.calls)} model calls · ${baseline(formatCompact(prev.processed_tokens))}`
                  : `${formatCompact(totals.calls)} model calls`
              }
              spark={spark(dailyTokens)}
            />
          ) : (
            <StatTile
              label="Estimated spend"
              value={formatCost(totals.cost_usd)}
              delta={delta.cost}
              hint={
                comparable && prev
                  ? baseline(formatCost(prev.cost_usd))
                  : subscriptionCost > 0
                    ? `${formatCost(perTokenCost)} of it billed per token`
                    : "at API prices"
              }
              spark={spark(dailyCost)}
            />
          )}
          <StatTile
            label="Sessions"
            value={totals.sessions.toLocaleString()}
            delta={delta.sessions}
            hint={
              totals.sessions > 0
                ? [
                    metric === "cost"
                      ? `${formatCost(totals.cost_usd / totals.sessions)} per session${comparable ? "" : " on average"}`
                      : `${formatCompact(totals.processed_tokens / totals.sessions)} tokens per session${comparable ? "" : " on average"}`,
                    comparable && prev ? baseline(prev.sessions.toLocaleString()) : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : `in the last ${words}`
            }
            spark={spark(dailySessions)}
          />
          <StatTile
            label="Saved by caching"
            value={formatCost(totals.cache_savings_usd)}
            hint={uncachedPrice > 0 ? `${Math.round(savedShare * 100)}% off the uncached price` : "Nothing was read from the cache"}
            footer={
              uncachedPrice > 0 ? (
                <ProportionBar
                  label="Share of the uncached price saved by caching"
                  parts={[
                    { label: "Saved", value: savedShare, color: "var(--chart-6)" },
                    { label: "Paid", value: 1 - savedShare, color: "var(--bg-pressed)" },
                  ]}
                />
              ) : undefined
            }
          />
        </div>

        {/* Rankings */}
        <div className="grid gap-4 xl:grid-cols-2">
          <SectionCard title="By model" description="Which models the work ran on.">
            <BarList
              formatValue={fmt}
              items={[...data.models]
                .sort((a, b) => (metric === "cost" ? b.cost_usd - a.cost_usd : b.tokens - a.tokens))
                .map((m) => ({
                  id: m.model,
                  label: (
                    <Tip label={m.model}>
                      <span tabIndex={0} className="rounded-sm outline-offset-2">
                        {describeModel(m.model).label}
                      </span>
                    </Tip>
                  ),
                  value: metric === "cost" ? m.cost_usd : m.tokens,
                  hint: metric === "cost" ? `${formatCompact(m.tokens)} tokens` : formatCost(m.cost_usd),
                  color: providerColor(m.provider),
                }))}
            />
          </SectionCard>
          <SectionCard title="By harness" description="Which engine ran the agent loop, and how it is paid for.">
            <BarList
              formatValue={fmt}
              items={[...data.harnesses]
                .sort((a, b) => (metric === "cost" ? b.cost_usd - a.cost_usd : b.tokens - a.tokens))
                .map((h) => ({
                  id: h.harness,
                  label: harnessLabel(h.harness),
                  value: metric === "cost" ? h.cost_usd : h.tokens,
                  hint: [
                    plural(h.sessions, "session"),
                    SUBSCRIPTION_HARNESSES.has(h.harness) ? "subscription" : h.harness === "default" ? "billed per token" : null,
                  ]
                    .filter(Boolean)
                    .join(" · "),
                }))}
            />
          </SectionCard>
        </div>

        {/* Token mix */}
        <SectionCard
          title="Where the tokens went"
          description="Cached input is billed at a fraction of new input, which is where the saving comes from."
        >
          <TokenMix totals={totals} />
        </SectionCard>

        {/* Day by day */}
        <DailyTable
          days={days}
          providers={providers}
          byDay={byDay}
          metric={metric}
          today={today}
          showAll={allDays}
          onToggle={() => setView("days", allDays ? null : "all")}
        />

        <Callout tone="neutral" title="These are estimates, not an invoice">
          Every call is priced at the provider's API rates so agents can be compared on one scale. Sessions on the Claude Agent
          SDK and Codex SDK harnesses normally run on a subscription and are not billed per token; your provider's invoice is
          the record of what you were charged.
        </Callout>
      </div>
    </Page>
  );
}
