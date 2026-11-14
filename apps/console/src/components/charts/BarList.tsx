import type { ReactNode } from "react";
import { Link } from "react-router";

import { cn } from "@/lib/utils";

/**
 * A ranked list with a bar per row: "which of these is biggest?" — spend
 * by model, sessions by agent, tokens by harness. Prefer it to a pie or a
 * column chart whenever the categories have names worth reading.
 *
 *   <BarList
 *     items={models.map((m) => ({ id: m.model, label: <ModelBadge model={m.model} variant="plain" />, value: m.cost_usd }))}
 *     formatValue={formatCost}
 *   />
 *
 * One hue for the whole list (magnitude, not identity) unless each row
 * passes its own `color` because the colour means something elsewhere on
 * the page (e.g. provider colours matching a chart above).
 */
export interface BarListItem {
  id: string;
  label: ReactNode;
  value: number;
  /** Secondary text after the label ("18 sessions"). */
  hint?: ReactNode;
  color?: string;
  href?: string;
}

export function BarList({
  items,
  formatValue = (n) => n.toLocaleString(),
  color = "var(--chart-1)",
  max,
  className,
}: {
  items: BarListItem[];
  formatValue?: (n: number) => string;
  color?: string;
  /** Scale bars against this instead of the largest item. */
  max?: number;
  className?: string;
}) {
  const top = max ?? Math.max(...items.map((i) => i.value), 0);
  return (
    <ul className={cn("space-y-3", className)}>
      {items.map((it) => {
        const pct = top > 0 ? Math.max((it.value / top) * 100, it.value > 0 ? 1.5 : 0) : 0;
        const row = (
          <>
            <div className="flex items-baseline justify-between gap-3">
              <span className="flex min-w-0 items-baseline gap-2 text-small text-fg">
                <span className="min-w-0 truncate">{it.label}</span>
                {it.hint && <span className="shrink-0 text-xs text-fg-subtle">{it.hint}</span>}
              </span>
              <span className="shrink-0 text-small font-medium text-fg">{formatValue(it.value)}</span>
            </div>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-bg-soft">
              <div
                className="h-full rounded-full transition-[width] duration-[var(--dur-slow)] ease-[var(--ease-rise)]"
                style={{ width: `${pct}%`, backgroundColor: it.color ?? color }}
              />
            </div>
          </>
        );
        return (
          <li key={it.id}>
            {it.href ? (
              <Link to={it.href} className="-mx-2 block rounded-md px-2 py-1 transition-quick hover:bg-bg-hover">
                {row}
              </Link>
            ) : (
              row
            )}
          </li>
        );
      })}
    </ul>
  );
}
