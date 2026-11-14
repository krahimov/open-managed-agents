import { useId } from "react";

import { cn } from "@/lib/utils";

import { linePath, useMeasure } from "./util";

/**
 * A tiny trend line with no axes: the shape of a number over time, beside
 * the number itself (see <StatTile>). Fills its container's width.
 *
 *   <Sparkline data={dailyCost} />
 *   <Sparkline data={dailySessions} color="var(--chart-3)" height={28} area={false} />
 *
 * Rules: one series; 2px line; a soft area wash beneath; an end dot marks
 * "now". Never label points on a sparkline — the value lives next to it.
 */
export function Sparkline({
  data,
  color = "var(--chart-1)",
  height = 36,
  area = true,
  endDot = true,
  className,
  "aria-label": ariaLabel,
}: {
  data: number[];
  color?: string;
  height?: number;
  area?: boolean;
  endDot?: boolean;
  className?: string;
  "aria-label"?: string;
}) {
  const [ref, width] = useMeasure<HTMLDivElement>();
  const gid = useId();
  const pad = 4;
  const n = data.length;
  const max = Math.max(...data, 0);
  const min = Math.min(...data, 0);
  const span = max - min || 1;
  const innerW = Math.max(width - pad * 2, 1);
  const innerH = height - pad * 2;
  const pts: Array<[number, number]> = data.map((v, i) => [
    pad + (n <= 1 ? innerW : (i / (n - 1)) * innerW),
    pad + innerH - ((v - min) / span) * innerH,
  ]);
  const line = linePath(pts);
  const last = pts[pts.length - 1];

  return (
    <div ref={ref} className={cn("w-full", className)} style={{ height }} role="img" aria-label={ariaLabel ?? "Trend"}>
      {width > 0 && n > 1 && (
        <svg width={width} height={height} className="block overflow-visible" aria-hidden="true">
          {area && (
            <>
              <defs>
                <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor={color} stopOpacity="0.2" />
                  <stop offset="1" stopColor={color} stopOpacity="0" />
                </linearGradient>
              </defs>
              <path d={`${line} L${last[0].toFixed(1)},${height} L${pts[0][0].toFixed(1)},${height} Z`} fill={`url(#${gid})`} />
            </>
          )}
          <path d={line} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
          {endDot && <circle cx={last[0]} cy={last[1]} r="3.5" fill={color} stroke="var(--bg-surface)" strokeWidth="2" />}
        </svg>
      )}
    </div>
  );
}
