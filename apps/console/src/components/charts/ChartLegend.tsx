import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Legend for a chart with two or more series. Text is in text tokens; the
 * swatch carries the colour. A single-series chart needs no legend: its
 * title says what is plotted.
 *
 *   <ChartLegend items={[{ label: "Anthropic", color: "var(--chart-anthropic)", value: "$128.98" }]} />
 */
export function ChartLegend({
  items,
  className,
}: {
  items: Array<{ label: ReactNode; color: string; value?: ReactNode }>;
  className?: string;
}) {
  return (
    <ul className={cn("flex flex-wrap items-center gap-x-4 gap-y-1.5", className)}>
      {items.map((it, i) => (
        <li key={i} className="flex items-center gap-1.5 text-xs text-fg-muted">
          <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ backgroundColor: it.color }} />
          <span>{it.label}</span>
          {it.value !== undefined && <span className="font-medium text-fg">{it.value}</span>}
        </li>
      ))}
    </ul>
  );
}
