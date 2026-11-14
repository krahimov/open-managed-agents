import type { ComponentType, ReactNode } from "react";
import { Link } from "react-router";
import { ArrowDownRightIcon, ArrowUpRightIcon, MinusIcon } from "lucide-react";

import { cn } from "@/lib/utils";

import { Sparkline } from "./charts/Sparkline";
import { Skeleton } from "./Skeleton";

/**
 * One headline number: label, value, optional change vs the previous
 * period, optional sparkline. Lay several out as a KPI row
 * (`grid gap-4 sm:grid-cols-2 lg:grid-cols-4`).
 *
 *   <StatTile
 *     label="Spend"
 *     value={formatCost(totals.cost_usd)}
 *     hint="last 30 days"
 *     delta={{ value: "12%", direction: "up", good: false }}
 *     spark={dailyCost}
 *     to="/usage"
 *   />
 *
 * Rules:
 *   - `label` is sentence case, no colon. `value` is already formatted.
 *   - `delta.good` decides the colour, not the direction: spend going up
 *     is not good; sessions going up is. Omit `good` for neutral.
 *   - A tile is a link (`to`) only when there is a page that explains the
 *     number. Then the whole tile is the target.
 *   - Do not use tiles for counts nobody acts on. Six "how many of each
 *     resource" tiles is the thing this component replaced.
 */
export interface StatDelta {
  /** Already formatted, without sign: "12%", "$4.20". */
  value: string;
  direction: "up" | "down" | "flat";
  /** Is this change good news? Sets green/red; omit for neutral grey. */
  good?: boolean;
}

export function StatTile({
  label,
  value,
  hint,
  delta,
  spark,
  sparkColor = "var(--chart-1)",
  icon: Icon,
  footer,
  to,
  loading,
  className,
}: {
  label: string;
  value: ReactNode;
  /** Quiet context under the value: "last 30 days", "of 12". */
  hint?: ReactNode;
  delta?: StatDelta;
  /** Trend values, oldest first. */
  spark?: number[];
  sparkColor?: string;
  icon?: ComponentType<{ className?: string }>;
  /** Custom content in the sparkline's place (a proportion bar, a Meter). */
  footer?: ReactNode;
  to?: string;
  loading?: boolean;
  className?: string;
}) {
  const DeltaIcon = delta?.direction === "up" ? ArrowUpRightIcon : delta?.direction === "down" ? ArrowDownRightIcon : MinusIcon;
  const body = (
    <>
      <div className="flex items-center gap-2 text-small text-fg-muted">
        {Icon && <Icon className="size-4 stroke-[1.75] text-fg-subtle" />}
        <span className="truncate">{label}</span>
      </div>
      {loading ? (
        // The same heights as the value and the hint, so the tile does not
        // grow when the numbers land.
        <>
          <Skeleton className="mt-2 h-7 w-24" rounded="md" />
          {hint !== undefined && (
            <div className="mt-1.5 flex h-[1.0125rem] items-center">
              <Skeleton className="h-2.5 w-28" rounded="sm" />
            </div>
          )}
        </>
      ) : (
        <div className="mt-2 flex items-baseline gap-2">
          <span className="text-stat text-fg">{value}</span>
          {delta && (
            <span
              className={cn(
                "inline-flex items-center gap-0.5 text-xs font-medium",
                delta.good === undefined || delta.direction === "flat"
                  ? "text-fg-subtle"
                  : delta.good
                    ? "text-success"
                    : "text-danger",
              )}
            >
              <DeltaIcon className="size-3.5" />
              {delta.value}
            </span>
          )}
        </div>
      )}
      {hint && !loading && <div className="mt-1.5 text-xs text-fg-subtle">{hint}</div>}
      {spark && spark.length > 1 && !loading && (
        <Sparkline data={spark} color={sparkColor} height={40} className="mt-3" aria-label={`${label} trend`} />
      )}
      {footer && !loading && <div className="mt-auto pt-5">{footer}</div>}
      {loading && (spark || footer) && <Skeleton className="mt-4 h-9 w-full" rounded="md" />}
    </>
  );
  const cls = cn("surface flex flex-col rounded-xl p-5", to && "lift", className);
  return to ? (
    <Link to={to} className={cls}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}
