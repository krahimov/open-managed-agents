import { ArrowDownRightIcon, ArrowUpRightIcon, MinusIcon } from "lucide-react";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SectionCard, Skeleton, type StatDelta } from "@/components/kit";
import { formatCompact, formatCost } from "@/lib/format";
import { PROVIDER_COLOR, type ModelProvider } from "@/lib/models";
import { cn } from "@/lib/utils";

/**
 * The pieces of the Usage page that are not in the kit: the report's shape,
 * the day helpers, the change-against-last-period chip, the token mix and
 * the day-by-day table.
 */

export interface UsageReport {
  range: { since: number; until: number };
  totals: {
    cost_usd: number;
    cache_savings_usd: number;
    processed_tokens: number;
    uncached_input_tokens: number;
    cached_input_tokens: number;
    cache_write_input_tokens: number;
    output_tokens: number;
    reasoning_tokens: number;
    calls: number;
    sessions: number;
  };
  providers: Array<{ provider: string; cost_usd: number; tokens: number; sessions: number }>;
  daily: Array<{ day: string; provider: string; cost_usd: number; tokens: number }>;
  models: Array<{ model: string; provider: string; cost_usd: number; tokens: number }>;
  harnesses: Array<{ harness: string; cost_usd: number; tokens: number; sessions: number }>;
}

export type Metric = "cost" | "tokens";

/** day → provider → what that provider did that day. */
export type DayCells = Map<string, Map<string, { cost: number; tokens: number }>>;

const PROVIDER_LABEL: Record<string, string> = { anthropic: "Anthropic", openai: "OpenAI", google: "Google", other: "Other" };

export function providerLabel(p: string): string {
  return PROVIDER_LABEL[p] ?? p;
}

export function providerColor(p: string): string {
  return PROVIDER_COLOR[p as ModelProvider] ?? "var(--chart-other)";
}

/** "Nov 6". The report's days are UTC days. */
export function shortDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

function longDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** Change against the period before. Nothing to compare against → no delta. */
export function periodDelta(current: number, previous: number | undefined, upIsGood: boolean | undefined): StatDelta | undefined {
  // With little or no history before the period a percentage is noise ("1100%").
  if (previous === undefined || previous <= 0 || previous < current * 0.25) return undefined;
  const change = (current - previous) / previous;
  const pct = Math.abs(change) * 100;
  if (pct < 0.5) return { value: "0%", direction: "flat" };
  const direction = change > 0 ? "up" : "down";
  return {
    value: `${pct >= 10 ? Math.round(pct) : pct.toFixed(1)}%`,
    direction,
    good: upIsGood === undefined ? undefined : direction === "up" ? upIsGood : !upIsGood,
  };
}

/**
 * Spend, tokens and sessions against the period before: all three or none.
 * One arrow beside two bare numbers reads as a mistake, so a change is shown
 * only when every number has enough history before it to compare with.
 * Usage and Home both draw from this.
 */
export function periodChanges(
  totals: { cost_usd: number; processed_tokens: number; sessions: number },
  prev: { cost_usd: number; processed_tokens: number; sessions: number } | undefined,
): { comparable: boolean; cost?: StatDelta; tokens?: StatDelta; sessions?: StatDelta } {
  const cost = periodDelta(totals.cost_usd, prev?.cost_usd, false);
  const tokens = periodDelta(totals.processed_tokens, prev?.processed_tokens, undefined);
  const sessions = periodDelta(totals.sessions, prev?.sessions, true);
  return prev && cost && tokens && sessions ? { comparable: true, cost, tokens, sessions } : { comparable: false };
}

/** The same change chip a StatTile draws, for the headline number. */
export function DeltaChip({ delta, className }: { delta: StatDelta; className?: string }) {
  const Icon = delta.direction === "up" ? ArrowUpRightIcon : delta.direction === "down" ? ArrowDownRightIcon : MinusIcon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 text-small font-medium",
        delta.good === undefined || delta.direction === "flat" ? "text-fg-subtle" : delta.good ? "text-success" : "text-danger",
        className,
      )}
    >
      <Icon className="size-4" />
      {delta.value}
      <span className="sr-only">{delta.direction === "up" ? " up" : delta.direction === "down" ? " down" : " unchanged"}</span>
    </span>
  );
}

/** One rounded bar split into labelled parts. Colour carries identity; the
 *  accessible name carries the numbers. */
export function ProportionBar({ parts, label }: { parts: Array<{ label: string; value: number; color: string }>; label: string }) {
  const total = sum(parts.map((p) => p.value)) || 1;
  const visible = parts.filter((p) => p.value > 0);
  return (
    <div
      className="flex h-2 gap-0.5 overflow-hidden rounded-full"
      role="img"
      aria-label={`${label}: ${visible.map((p) => `${p.label} ${Math.round((100 * p.value) / total)}%`).join(", ")}`}
    >
      {visible.map((p) => (
        <span
          key={p.label}
          className="h-full min-w-1 rounded-full"
          style={{ width: `${(100 * p.value) / total}%`, backgroundColor: p.color }}
        />
      ))}
    </div>
  );
}

/** Input (cached, new, written to cache) and output as one bar with the
 *  numbers beside it. The same ink ramp, in the same order, as the session's
 *  usage panel (index.css --mix-*): lightest for the cheapest token, darkest
 *  for the dearest. No hue, so the bar never reads as a provider (apricot,
 *  teal) or a kind of work (plum, indigo, lilac). */
export function TokenMix({ totals }: { totals: UsageReport["totals"] }) {
  const parts = [
    { label: "Cached input", note: "Read back from the prompt cache", value: totals.cached_input_tokens, color: "var(--mix-cached)" },
    { label: "New input", note: "Read at the full input price", value: totals.uncached_input_tokens, color: "var(--mix-input)" },
    { label: "Cache writes", note: "Stored for later turns", value: totals.cache_write_input_tokens, color: "var(--mix-write)" },
    {
      label: "Output",
      note:
        totals.reasoning_tokens > 0
          ? `Includes ${formatCompact(totals.reasoning_tokens)} of reasoning`
          : "What the models wrote",
      value: totals.output_tokens,
      color: "var(--mix-output)",
    },
  ];
  const total = sum(parts.map((p) => p.value)) || 1;
  return (
    <div>
      <ProportionBar label="Token mix" parts={parts} />
      <dl className="mt-5 grid gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
        {parts.map((p) => (
          <div key={p.label} className="min-w-0">
            <dt className="flex items-center gap-1.5 text-small text-fg-muted">
              <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ backgroundColor: p.color }} />
              {p.label}
            </dt>
            <dd className="mt-1 flex items-baseline gap-2">
              <span className="text-h2 text-fg">{formatCompact(p.value)}</span>
              <span className="text-xs text-fg-subtle">{((100 * p.value) / total).toFixed(p.value / total < 0.1 ? 1 : 0)}%</span>
            </dd>
            <dd className="mt-0.5 text-xs text-fg-subtle">{p.note}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** How many days the table shows before "Show all". */
const DAY_ROWS = 7;

/**
 * The same days as the chart, as numbers to read and compare: each
 * provider, the day's total, a bar that places the day against the busiest
 * one, and the other measure. Follows the Cost | Tokens switch.
 */
export function DailyTable({
  days,
  providers,
  byDay,
  metric,
  today,
  showAll,
  onToggle,
}: {
  days: string[];
  providers: string[];
  byDay: DayCells;
  metric: Metric;
  /** The UTC day that is still in progress. */
  today: string;
  showAll: boolean;
  onToggle: () => void;
}) {
  const pick = (cell: { cost: number; tokens: number }) => (metric === "cost" ? cell.cost : cell.tokens);
  const fmt = metric === "cost" ? formatCost : formatCompact;
  // Newest first; days with nothing recorded are left out.
  const rows = [...days]
    .reverse()
    .map((day) => {
      const cells = byDay.get(day);
      const cost = sum([...(cells?.values() ?? [])].map((c) => c.cost));
      const tokens = sum([...(cells?.values() ?? [])].map((c) => c.tokens));
      return { day, cells, cost, tokens };
    })
    .filter((r) => r.tokens > 0 || r.cost > 0);
  const peak = Math.max(...rows.map((r) => (metric === "cost" ? r.cost : r.tokens)), 0);
  const visible = showAll ? rows : rows.slice(0, DAY_ROWS);
  if (rows.length === 0) return null;

  return (
    <SectionCard
      flush
      title="Day by day"
      description="Newest first, in UTC days. Days with no usage are left out."
      footer={
        rows.length > DAY_ROWS ? (
          <button
            type="button"
            onClick={onToggle}
            className="rounded-sm font-medium text-fg-muted transition-quick hover:text-fg"
            aria-expanded={showAll}
          >
            {showAll ? `Show the latest ${DAY_ROWS} days` : `Show all ${rows.length} days`}
          </button>
        ) : undefined
      }
    >
      <Table className="text-small-size">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="pl-5">Day</TableHead>
            {providers.map((p) => (
              <TableHead key={p} className="px-4 text-right">
                <span className="inline-flex items-center gap-1.5">
                  <span aria-hidden="true" className="size-2 rounded-full" style={{ backgroundColor: providerColor(p) }} />
                  {providerLabel(p)}
                </span>
              </TableHead>
            ))}
            <TableHead className="px-4 text-right">{metric === "cost" ? "Estimated spend" : "Tokens"}</TableHead>
            <TableHead className="w-[20%] px-4">Share of the busiest day</TableHead>
            <TableHead className="pr-5 pl-4 text-right">{metric === "cost" ? "Tokens" : "Estimated spend"}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {visible.map((r) => {
            const value = metric === "cost" ? r.cost : r.tokens;
            return (
              <TableRow key={r.day} className="h-11">
                <TableCell className="pl-5 font-medium whitespace-nowrap text-fg">
                  {longDay(r.day)}
                  {r.day === today && <span className="ml-2 font-normal text-fg-subtle">so far</span>}
                </TableCell>
                {providers.map((p) => {
                  const cell = r.cells?.get(p);
                  return (
                    <TableCell key={p} className="px-4 text-right text-fg-muted">
                      {cell ? fmt(pick(cell)) : <span className="text-fg-faint">–</span>}
                    </TableCell>
                  );
                })}
                <TableCell className="px-4 text-right font-medium text-fg">{fmt(value)}</TableCell>
                <TableCell className="px-4">
                  <div className="h-1.5 overflow-hidden rounded-full bg-bg-soft" aria-hidden="true">
                    <div
                      className="h-full rounded-full bg-chart-1"
                      style={{ width: `${peak > 0 ? Math.max((value / peak) * 100, value > 0 ? 1.5 : 0) : 0}%` }}
                    />
                  </div>
                  <span className="sr-only">{peak > 0 ? `${Math.round((value / peak) * 100)}%` : ""}</span>
                </TableCell>
                <TableCell className="pr-5 pl-4 text-right text-fg-muted">
                  {metric === "cost" ? formatCompact(r.tokens) : formatCost(r.cost)}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </SectionCard>
  );
}

/** The page while the first report loads: the headline card, three tiles, two rankings. */
export function UsageSkeleton() {
  return (
    <div className="space-y-6" aria-hidden="true">
      <div className="surface rounded-xl p-5 lg:p-6">
        <Skeleton className="h-3.5 w-44" rounded="sm" />
        <Skeleton className="mt-3 h-9 w-40" rounded="md" />
        <Skeleton className="mt-3 h-3.5 w-72" rounded="sm" />
        <Skeleton className="mt-6 h-[260px] w-full" rounded="lg" />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="surface rounded-xl p-5">
            <Skeleton className="h-3.5 w-28" rounded="sm" />
            <Skeleton className="mt-3 h-7 w-20" rounded="md" />
            <Skeleton className="mt-2.5 h-3 w-36" rounded="sm" />
            <Skeleton className="mt-4 h-9 w-full" rounded="md" />
          </div>
        ))}
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        {[0, 1].map((i) => (
          <div key={i} className="surface space-y-5 rounded-xl p-5">
            <Skeleton className="h-4 w-28" rounded="sm" />
            {[0, 1, 2, 3].map((j) => (
              <div key={j} className="space-y-2">
                <Skeleton className="h-3.5 w-1/2" rounded="sm" />
                <Skeleton className="h-1.5 w-full" rounded="full" />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
