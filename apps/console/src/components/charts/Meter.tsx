import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Progress toward a limit (budgets, quotas, eval pass rate). The bar turns
 * amber at 80% and red at 100% unless `tone` is fixed.
 *
 *   <Meter label="Daily cost" value={8} max={10} formatValue={formatCost} />
 */
export function Meter({
  label,
  value,
  max,
  formatValue = (n) => n.toLocaleString(),
  tone,
  className,
}: {
  label?: ReactNode;
  value: number;
  max: number;
  formatValue?: (n: number) => string;
  tone?: "neutral" | "success" | "warning" | "danger";
  className?: string;
}) {
  const ratio = max > 0 ? value / max : 0;
  const t = tone ?? (ratio >= 1 ? "danger" : ratio >= 0.8 ? "warning" : "neutral");
  const fill =
    t === "danger" ? "bg-danger-solid" : t === "warning" ? "bg-warning-solid" : t === "success" ? "bg-success-solid" : "bg-ink";
  return (
    <div className={className}>
      {(label || max > 0) && (
        <div className="mb-1.5 flex items-baseline justify-between gap-3 text-small">
          <span className="text-fg-muted">{label}</span>
          <span className="text-fg">
            <span className="font-medium">{formatValue(value)}</span>
            <span className="text-fg-subtle"> / {formatValue(max)}</span>
          </span>
        </div>
      )}
      <div
        role="meter"
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value}
        className="h-1.5 overflow-hidden rounded-full bg-bg-soft"
      >
        <div
          className={cn("h-full rounded-full transition-[width] duration-[var(--dur-slow)] ease-[var(--ease-rise)]", fill)}
          style={{ width: `${Math.min(Math.max(ratio, 0), 1) * 100}%` }}
        />
      </div>
    </div>
  );
}
