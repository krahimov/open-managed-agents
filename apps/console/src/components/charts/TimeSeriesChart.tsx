import { useId, useMemo, useState } from "react";

import { cn } from "@/lib/utils";

import { ChartLegend } from "./ChartLegend";
import { linePath, niceTicks, pickLabelIndices, useMeasure, type ChartSeries } from "./util";

/**
 * A value over time, for one or a few series.
 *
 *   <TimeSeriesChart
 *     type="area"                     "area" | "line" | "bar"
 *     stacked                         series add up (cost by provider)
 *     labels={days}                   one x label per point
 *     series={[
 *       { id: "anthropic", label: "Anthropic", color: "var(--chart-anthropic)", values },
 *       { id: "openai", label: "OpenAI", color: "var(--chart-openai)", values },
 *     ]}
 *     formatValue={formatCost}              tooltip values
 *     formatTick={(n) => `$${n}`}           y-axis ticks (optional, shorter)
 *     formatLabel={(d) => shortDay(d)}
 *     height={240}
 *   />
 *
 * What it does for you: clean y ticks from zero, a handful of x labels, a
 * hover crosshair with a tooltip listing every series (and the total when
 * stacked), a legend when there are two or more series, and an sr-only
 * data table.
 *
 * Choosing `type`:
 *   area  one series, or stacked parts of a whole over time
 *   line  compare two to four independent series (never stack lines)
 *   bar   discrete buckets (per day / per run) where each bar is read alone
 * One y axis only. Two measures of different scale get two charts.
 */
/**
 * About half the drawn width of an x label in the micro size (11px Geist,
 * whose digits and letters average a little over 6px). An estimate is
 * enough: it only keeps a label from running past the chart's edge.
 */
export function labelHalfWidth(text: string): number {
  return Math.ceil(text.length * 3.3);
}

export function TimeSeriesChart({
  type = "area",
  labels,
  series,
  stacked = false,
  height = 240,
  formatValue = (n) => n.toLocaleString(),
  formatTick,
  formatLabel = (l) => l,
  legend = true,
  barWidth = 24,
  className,
  "aria-label": ariaLabel = "Chart",
}: {
  type?: "area" | "line" | "bar";
  labels: string[];
  series: ChartSeries[];
  stacked?: boolean;
  height?: number;
  formatValue?: (n: number) => string;
  /** Shorter format for y-axis ticks ("$10" rather than "$10.00"). Defaults to `formatValue`. */
  formatTick?: (n: number) => string;
  formatLabel?: (label: string) => string;
  /** Show the legend (only rendered for ≥ 2 series). */
  legend?: boolean;
  /** Widest a column may be, in px (default 24). Lower it for a dense daily
   *  series so the columns stay slim and the band keeps its air. */
  barWidth?: number;
  className?: string;
  "aria-label"?: string;
}) {
  const [ref, width] = useMeasure<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const clipId = useId();

  const n = labels.length;
  const isStacked = stacked || type === "bar";
  const M = { top: 8, right: 8, bottom: 26, left: 44 };
  const innerW = Math.max(width - M.left - M.right, 1);
  const innerH = height - M.top - M.bottom;

  const { ticks, top, stacks } = useMemo(() => {
    // stacks[s][i] = [y0, y1] cumulative bounds for series s at index i
    const acc = new Array(n).fill(0);
    const st: Array<Array<[number, number]>> = series.map((s) =>
      s.values.map((v, i) => {
        const val = Number.isFinite(v) ? v : 0;
        if (!isStacked) return [0, val] as [number, number];
        const y0 = acc[i];
        acc[i] = y0 + val;
        return [y0, acc[i]] as [number, number];
      }),
    );
    const rawMax = isStacked
      ? Math.max(...acc, 0)
      : Math.max(...series.flatMap((s) => s.values.filter(Number.isFinite)), 0);
    const tk = niceTicks(rawMax, 4);
    return { ticks: tk, top: tk[tk.length - 1] || 1, stacks: st };
  }, [series, n, isStacked]);

  const band = n > 0 ? innerW / n : innerW;
  // Line/area points sit on band centres so bars and lines share an x scale.
  const x = (i: number) => M.left + band * (i + 0.5);
  const y = (v: number) => M.top + innerH - (v / top) * innerH;

  const xLabels = pickLabelIndices(n, Math.max(2, Math.min(8, Math.floor(innerW / 84))));
  const barW = Math.min(barWidth, Math.max(2, band - 4));

  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const i = Math.floor(((e.clientX - rect.left) / rect.width) * n);
    setHover(Math.min(Math.max(i, 0), n - 1));
  };

  const totalAt = (i: number) => series.reduce((sum, s) => sum + (Number.isFinite(s.values[i]) ? s.values[i] : 0), 0);
  const tooltipLeft = hover === null ? 0 : x(hover);
  const flip = hover !== null && tooltipLeft > width * 0.62;

  return (
    <figure className={cn("m-0", className)}>
      {legend && series.length > 1 && (
        <ChartLegend className="mb-3" items={series.map((s) => ({ label: s.label, color: s.color }))} />
      )}
      <div ref={ref} className="relative w-full" style={{ height }}>
        {width > 0 && n > 0 && (
          <svg width={width} height={height} role="img" aria-label={ariaLabel} className="block">
            <defs>
              <clipPath id={clipId}>
                <rect x={M.left} y={0} width={innerW} height={M.top + innerH} />
              </clipPath>
            </defs>

            {/* y grid + ticks */}
            {ticks.map((t, i) => (
              <g key={i}>
                <line
                  x1={M.left}
                  x2={width - M.right}
                  y1={y(t)}
                  y2={y(t)}
                  stroke={i === 0 ? "var(--border-strong)" : "var(--chart-grid)"}
                  strokeWidth="1"
                  shapeRendering="crispEdges"
                />
                <text x={M.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fill-fg-subtle text-micro-size">
                  {(formatTick ?? formatValue)(t)}
                </text>
              </g>
            ))}

            {/* x labels: each centred under its own column or point. Only a
                label that would run off the chart is moved in, by just
                enough (the left margin holds the y ticks, so in practice
                only the last label on a narrow chart moves). */}
            {xLabels.map((i) => {
              const text = formatLabel(labels[i]);
              const half = labelHalfWidth(text);
              const cx = Math.min(Math.max(x(i), half + 1), width - half - 1);
              return (
                <text key={i} x={cx} y={height - 6} textAnchor="middle" className="fill-fg-subtle text-micro-size">
                  {text}
                </text>
              );
            })}

            <g clipPath={`url(#${clipId})`}>
              {type === "bar"
                ? series.map((s, si) =>
                    s.values.map((v, i) => {
                      if (!v) return null;
                      const [y0, y1] = stacks[si][i];
                      const isTop = !series.slice(si + 1).some((o) => (o.values[i] ?? 0) > 0);
                      const yTop = y(y1);
                      // 2px surface gap between stacked segments
                      const h = Math.max(y(y0) - yTop - (si > 0 ? 2 : 0), 1);
                      const bx = x(i) - barW / 2;
                      const r = isTop ? Math.min(4, barW / 2, h) : 0;
                      return (
                        <path
                          key={`${s.id}-${i}`}
                          d={`M${bx},${yTop + h} V${yTop + r} Q${bx},${yTop} ${bx + r},${yTop} H${bx + barW - r} Q${bx + barW},${yTop} ${bx + barW},${yTop + r} V${yTop + h} Z`}
                          fill={s.color}
                          opacity={hover === null || hover === i ? 1 : 0.45}
                          className="transition-opacity duration-100"
                        />
                      );
                    }),
                  )
                : series.map((s, si) => {
                    const upper: Array<[number, number]> = stacks[si].map(([, y1], i) => [x(i), y(y1)]);
                    const lower: Array<[number, number]> = stacks[si].map(([y0], i) => [x(i), y(y0)]);
                    const fillArea = type === "area";
                    return (
                      <g key={s.id}>
                        {fillArea && (
                          <path
                            d={`${linePath(upper)} ${linePath([...lower].reverse()).replace("M", "L")} Z`}
                            fill={s.color}
                            opacity={isStacked ? 0.16 : 0.1}
                          />
                        )}
                        <path
                          d={linePath(upper)}
                          fill="none"
                          stroke={s.color}
                          strokeWidth="2"
                          strokeLinejoin="round"
                          strokeLinecap="round"
                        />
                      </g>
                    );
                  })}
            </g>

            {/* hover layer */}
            {hover !== null && type !== "bar" && (
              <g pointerEvents="none">
                <line
                  x1={x(hover)}
                  x2={x(hover)}
                  y1={M.top}
                  y2={M.top + innerH}
                  stroke="var(--border-strong)"
                  strokeWidth="1"
                  shapeRendering="crispEdges"
                />
                {series.map((s, si) => (
                  <circle
                    key={s.id}
                    cx={x(hover)}
                    cy={y(stacks[si][hover][1])}
                    r="4"
                    fill={s.color}
                    stroke="var(--bg-surface)"
                    strokeWidth="2"
                  />
                ))}
              </g>
            )}
            <rect
              x={M.left}
              y={M.top}
              width={innerW}
              height={innerH}
              fill="transparent"
              onMouseMove={onMove}
              onMouseLeave={() => setHover(null)}
            />
          </svg>
        )}

        {hover !== null && (
          <div
            role="status"
            className="pointer-events-none absolute top-2 z-10 min-w-36 rounded-lg border border-border bg-bg-raised px-3 py-2.5 text-xs shadow-[var(--shadow-md)]"
            style={{
              left: tooltipLeft,
              transform: flip ? "translateX(calc(-100% - 12px))" : "translateX(12px)",
            }}
          >
            <div className="mb-1.5 font-medium text-fg">{formatLabel(labels[hover])}</div>
            <ul className="space-y-1">
              {series.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-4">
                  <span className="flex items-center gap-1.5 text-fg-muted">
                    <span aria-hidden="true" className="size-2 rounded-full" style={{ backgroundColor: s.color }} />
                    {s.label}
                  </span>
                  <span className="font-medium text-fg">{formatValue(s.values[hover] ?? 0)}</span>
                </li>
              ))}
            </ul>
            {isStacked && series.length > 1 && (
              <div className="mt-1.5 flex items-center justify-between gap-4 border-t border-border pt-1.5">
                <span className="text-fg-muted">Total</span>
                <span className="font-medium text-fg">{formatValue(totalAt(hover))}</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Table view for assistive tech */}
      <table className="sr-only">
        <caption>{ariaLabel}</caption>
        <thead>
          <tr>
            <th scope="col">Period</th>
            {series.map((s) => (
              <th key={s.id} scope="col">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {labels.map((l, i) => (
            <tr key={l + i}>
              <th scope="row">{formatLabel(l)}</th>
              {series.map((s) => (
                <td key={s.id}>{formatValue(s.values[i] ?? 0)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
