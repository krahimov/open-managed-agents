/**
 * Usage — token & cost analytics across all sessions (GET /v1/usage).
 *
 * Cost figures are API-price ESTIMATES: on the subscription harnesses
 * (claude-agent-sdk / codex-sdk) nothing bills per token, so the number
 * shows what the same traffic would have cost on API keys. Chart series
 * colors come from --chart-* tokens in index.css (validated pair per mode).
 */

import { useMemo, useRef, useState } from "react";

import { Page } from "@/components/Page";
import { PageHeader } from "@/components/PageHeader";
import { useApiQuery } from "@/lib/useApiQuery";

interface UsageReport {
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

const RANGES = [
  { key: "1", label: "Past 24h" },
  { key: "7", label: "7 days" },
  { key: "30", label: "30 days" },
  { key: "90", label: "90 days" },
] as const;

const PROVIDER_META: Record<string, { label: string; color: string }> = {
  anthropic: { label: "Claude", color: "var(--chart-anthropic)" },
  openai: { label: "OpenAI", color: "var(--chart-openai)" },
  other: { label: "Other", color: "var(--chart-other)" },
};

function providerMeta(p: string) {
  return PROVIDER_META[p] ?? { label: p, color: "var(--chart-other)" };
}

function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}k`;
  return String(Math.round(n));
}

function fmtCost(n: number): string {
  if (n > 0 && n < 0.005) return "<$0.01";
  return `$${n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: n < 1 ? 4 : 2,
  })}`;
}

function fmtDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

/** Segmented control matching the console's near-monochrome chrome. */
function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: ReadonlyArray<{ key: T; label: string }>;
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex items-center rounded-md border border-border bg-bg-surface p-0.5">
      {options.map((o) => (
        <button
          key={o.key}
          onClick={() => onChange(o.key)}
          className={`px-2.5 py-1 text-xs rounded-[5px] transition-colors ${
            o.key === value
              ? "bg-bg-inset text-fg font-medium"
              : "text-fg-muted hover:text-fg"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

interface ChartSeries {
  provider: string;
  color: string;
  values: number[]; // one per day slot
}

/** Two-series area-line chart with crosshair + tooltip. Hand-rolled SVG —
 *  no chart dependency; identity is carried by the legend rows beside the
 *  chart (never color alone). */
function DailyChart({
  days,
  series,
  metric,
}: {
  days: string[];
  series: ChartSeries[];
  metric: "cost" | "tokens";
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const W = 800;
  const H = 220;
  const PAD_L = 46;
  const PAD_R = 8;
  const PAD_T = 10;
  const PAD_B = 22;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;

  const maxVal = Math.max(1e-9, ...series.flatMap((s) => s.values));
  // Round the axis top to a friendly step so gridlines land on clean numbers.
  const axisMax = niceCeil(maxVal);
  const x = (i: number) =>
    PAD_L + (days.length <= 1 ? innerW / 2 : (i / (days.length - 1)) * innerW);
  const y = (v: number) => PAD_T + innerH - (v / axisMax) * innerH;

  const linePath = (vals: number[]) =>
    vals.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const areaPath = (vals: number[]) =>
    `${linePath(vals)}L${x(vals.length - 1).toFixed(1)},${(PAD_T + innerH).toFixed(1)}L${x(0).toFixed(1)},${(PAD_T + innerH).toFixed(1)}Z`;

  const gridVals = [0.25, 0.5, 0.75, 1].map((f) => axisMax * f);
  const fmt = metric === "cost" ? fmtCost : fmtTokens;

  const onMove = (e: React.MouseEvent) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect || days.length === 0) return;
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const frac = Math.min(1, Math.max(0, (px - PAD_L) / innerW));
    setHover(Math.round(frac * (days.length - 1)));
  };

  const tickIdx = days.length <= 2 ? days.map((_, i) => i) : [0, Math.floor((days.length - 1) / 2), days.length - 1];

  return (
    <div ref={wrapRef} className="relative" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto block" role="img" aria-label="Daily usage chart">
        {gridVals.map((v) => (
          <g key={v}>
            <line x1={PAD_L} x2={W - PAD_R} y1={y(v)} y2={y(v)} stroke="var(--border)" strokeWidth={1} strokeDasharray="0" opacity={0.6} />
            <text x={PAD_L - 6} y={y(v) + 3} textAnchor="end" fontSize={10} fill="var(--fg-subtle)">
              {fmt(v)}
            </text>
          </g>
        ))}
        <line x1={PAD_L} x2={W - PAD_R} y1={PAD_T + innerH} y2={PAD_T + innerH} stroke="var(--border)" strokeWidth={1} />
        {tickIdx.map((i) => (
          <text key={i} x={x(i)} y={H - 6} textAnchor={i === 0 ? "start" : i === days.length - 1 ? "end" : "middle"} fontSize={10} fill="var(--fg-subtle)">
            {fmtDay(days[i])}
          </text>
        ))}
        {series.map((s) => (
          <g key={s.provider}>
            <path d={areaPath(s.values)} fill={s.color} opacity={0.09} />
            <path d={linePath(s.values)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          </g>
        ))}
        {hover !== null && days[hover] !== undefined && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={PAD_T} y2={PAD_T + innerH} stroke="var(--fg-subtle)" strokeWidth={1} opacity={0.5} />
            {series.map((s) => (
              <circle key={s.provider} cx={x(hover)} cy={y(s.values[hover] ?? 0)} r={4} fill={s.color} stroke="var(--bg-surface)" strokeWidth={2} />
            ))}
          </g>
        )}
      </svg>
      {hover !== null && days[hover] !== undefined && (
        <div
          className="pointer-events-none absolute top-2 z-10 rounded-md border border-border bg-bg-surface shadow-sm px-2.5 py-1.5 text-xs"
          style={{
            left: `${(x(hover) / W) * 100}%`,
            transform: x(hover) > W * 0.7 ? "translateX(calc(-100% - 8px))" : "translateX(8px)",
          }}
        >
          <div className="text-fg-muted mb-1">{fmtDay(days[hover])}</div>
          {series.map((s) => (
            <div key={s.provider} className="flex items-center gap-1.5 text-fg">
              <span className="inline-block size-2 rounded-full" style={{ background: s.color }} />
              <span className="text-fg-muted">{providerMeta(s.provider).label}</span>
              <span className="ml-auto pl-3 font-medium tabular-nums">{fmt(s.values[hover] ?? 0)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function niceCeil(v: number): number {
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const norm = v / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return step * mag;
}

function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-border bg-bg-surface px-3.5 py-3">
      <div className="text-[11px] uppercase tracking-wide text-fg-subtle">{label}</div>
      <div className="mt-1 text-lg font-semibold text-fg tabular-nums">{value}</div>
      {hint ? <div className="text-[11px] text-fg-subtle mt-0.5">{hint}</div> : null}
    </div>
  );
}

export function UsagePage() {
  const [rangeDays, setRangeDays] = useState<(typeof RANGES)[number]["key"]>("30");
  const [metric, setMetric] = useState<"cost" | "tokens">("cost");
  const [breakdown, setBreakdown] = useState<"model" | "day" | "harness">("model");

  // Snap `until` to the next minute so the query key is stable across renders.
  const until = useMemo(() => Math.ceil(Date.now() / 60000) * 60000, [rangeDays]);
  const since = until - Number(rangeDays) * 86400000;

  const { data, isLoading, refetch } = useApiQuery<UsageReport>(
    "/v1/usage",
    { since: String(since), until: String(until) },
    { refetchInterval: 60_000 },
  );

  const days = useMemo(() => {
    const out: string[] = [];
    for (let d = Math.floor(since / 86400000); d <= Math.floor((until - 1) / 86400000); d++) {
      out.push(new Date(d * 86400000).toISOString().slice(0, 10));
    }
    return out;
  }, [since, until]);

  const series: ChartSeries[] = useMemo(() => {
    if (!data) return [];
    const providers = data.providers.map((p) => p.provider);
    return providers.map((p) => {
      const byDay = new Map(
        data.daily.filter((r) => r.provider === p).map((r) => [r.day, metric === "cost" ? r.cost_usd : r.tokens]),
      );
      return {
        provider: p,
        color: providerMeta(p).color,
        values: days.map((d) => byDay.get(d) ?? 0),
      };
    });
  }, [data, days, metric]);

  const totalMetric = data
    ? metric === "cost"
      ? fmtCost(data.totals.cost_usd)
      : fmtTokens(data.totals.processed_tokens)
    : "—";
  const grandCost = data?.totals.cost_usd ?? 0;
  const grandTokens = data?.totals.processed_tokens ?? 0;

  type BreakdownRow = { key: string; color?: string; cost: number; tokens: number };
  const breakdownRows = useMemo((): BreakdownRow[] => {
    if (!data) return [];
    if (breakdown === "model") {
      return data.models.map((m) => ({
        key: m.model,
        color: providerMeta(m.provider).color,
        cost: m.cost_usd,
        tokens: m.tokens,
      }));
    }
    if (breakdown === "harness") {
      return data.harnesses.map((h) => ({ key: h.harness, cost: h.cost_usd, tokens: h.tokens }));
    }
    const byDay = new Map<string, { cost: number; tokens: number }>();
    for (const r of data.daily) {
      const cur = byDay.get(r.day) ?? { cost: 0, tokens: 0 };
      byDay.set(r.day, { cost: cur.cost + r.cost_usd, tokens: cur.tokens + r.tokens });
    }
    return [...byDay.entries()]
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(([day, v]) => ({ key: fmtDay(day), cost: v.cost, tokens: v.tokens }));
  }, [data, breakdown]);

  return (
    <Page
      header={
        <PageHeader
          title="Usage"
          subtitle="Token usage and estimated API cost across sessions"
          actions={
            <div className="flex items-center gap-2">
              <Segmented
                value={metric}
                options={[
                  { key: "cost", label: "Cost" },
                  { key: "tokens", label: "Tokens" },
                ]}
                onChange={setMetric}
              />
              <Segmented value={rangeDays} options={RANGES} onChange={setRangeDays} />
              <button
                onClick={() => refetch()}
                className="px-2.5 py-1 text-xs rounded-md border border-border bg-bg-surface text-fg-muted hover:text-fg"
                title="Refresh"
              >
                ↻
              </button>
            </div>
          }
        />
      }
    >
      {isLoading && !data ? (
        <div className="py-16 text-center text-sm text-fg-subtle">Loading usage…</div>
      ) : !data || data.totals.calls === 0 ? (
        <div className="py-16 text-center">
          <div className="text-sm text-fg-muted">No usage recorded in this range.</div>
          <div className="text-xs text-fg-subtle mt-1">
            Run a session — every model call is tracked here, including subscription-harness turns.
          </div>
        </div>
      ) : (
        <div className="space-y-6 max-w-5xl">
          {/* Hero + chart */}
          <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-6 items-start">
            <div>
              <div className="text-3xl font-semibold text-fg tabular-nums">{totalMetric}</div>
              <div className="text-xs text-fg-subtle mt-1">
                {data.totals.sessions} session{data.totals.sessions === 1 ? "" : "s"} ·{" "}
                {metric === "cost" ? "API estimate" : `${fmtCost(grandCost)} est.`}
              </div>
              <div className="mt-5 space-y-3">
                {data.providers.map((p) => {
                  const meta = providerMeta(p.provider);
                  const share = metric === "cost"
                    ? (grandCost > 0 ? p.cost_usd / grandCost : 0)
                    : (grandTokens > 0 ? p.tokens / grandTokens : 0);
                  return (
                    <div key={p.provider} className="text-sm">
                      <div className="flex items-center gap-2">
                        <span className="inline-block size-2 rounded-full" style={{ background: meta.color }} />
                        <span className="text-fg font-medium">{meta.label}</span>
                        <span className="text-fg-subtle text-xs">
                          {p.sessions} session{p.sessions === 1 ? "" : "s"}
                        </span>
                        <span className="ml-auto text-fg tabular-nums">
                          {metric === "cost" ? fmtCost(p.cost_usd) : fmtTokens(p.tokens)}
                        </span>
                      </div>
                      <div className="text-xs text-fg-subtle mt-0.5 pl-4">
                        {(share * 100).toFixed(1)}% of {metric} · {fmtTokens(p.tokens)} tokens
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="rounded-lg border border-border bg-bg-surface p-4">
              <div className="text-xs text-fg-muted mb-2">
                Daily {metric === "cost" ? "cost" : "tokens"}
              </div>
              <DailyChart days={days} series={series} metric={metric} />
            </div>
          </div>

          {/* Totals */}
          <div>
            <h2 className="text-sm font-semibold text-fg mb-2">Totals</h2>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
              <StatTile label="Processed tokens" value={fmtTokens(data.totals.processed_tokens)} />
              <StatTile label="Cached input" value={fmtTokens(data.totals.cached_input_tokens)} />
              <StatTile label="Uncached input" value={fmtTokens(data.totals.uncached_input_tokens)} />
              <StatTile label="Output" value={fmtTokens(data.totals.output_tokens)} />
              <StatTile
                label="Cache savings"
                value={fmtCost(data.totals.cache_savings_usd)}
                hint="vs full input rate"
              />
            </div>
          </div>

          {/* Breakdown */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-semibold text-fg">Breakdown</h2>
              <Segmented
                value={breakdown}
                options={[
                  { key: "model", label: "Model" },
                  { key: "harness", label: "Harness" },
                  { key: "day", label: "Day" },
                ]}
                onChange={setBreakdown}
              />
            </div>
            <div className="rounded-lg border border-border bg-bg-surface overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-fg-subtle border-b border-border">
                    <th className="font-medium px-3.5 py-2">
                      {breakdown === "model" ? "Model" : breakdown === "harness" ? "Harness" : "Day"}
                    </th>
                    <th className="font-medium px-3.5 py-2 text-right">Cost</th>
                    <th className="font-medium px-3.5 py-2 text-right">Share</th>
                    <th className="font-medium px-3.5 py-2 text-right">Tokens</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {breakdownRows.map((r) => (
                    <tr key={r.key}>
                      <td className="px-3.5 py-2">
                        <span className="inline-flex items-center gap-2">
                          {r.color ? (
                            <span className="inline-block size-2 rounded-full" style={{ background: r.color }} />
                          ) : null}
                          <span className="text-fg font-mono text-xs">{r.key}</span>
                        </span>
                      </td>
                      <td className="px-3.5 py-2 text-right tabular-nums text-fg">{fmtCost(r.cost)}</td>
                      <td className="px-3.5 py-2 text-right tabular-nums text-fg-muted">
                        {grandCost > 0 ? `${((r.cost / grandCost) * 100).toFixed(1)}%` : "—"}
                      </td>
                      <td className="px-3.5 py-2 text-right tabular-nums text-fg-muted">{fmtTokens(r.tokens)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-fg-subtle mt-2">
              Costs are API-price estimates. Subscription-harness turns (claude-agent-sdk, codex-sdk)
              bill nothing per token — the figure shows what the same traffic would cost on API keys.
            </p>
          </div>
        </div>
      )}
    </Page>
  );
}
