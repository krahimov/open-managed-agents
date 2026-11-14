import { useCallback, type ComponentType, type ReactNode } from "react";
import { useSearchParams } from "react-router";

import { cn } from "@/lib/utils";

/**
 * Section tabs for a record page: underlined text tabs on a hairline.
 *
 *   const [tab, setTab] = useTabParam("overview");
 *   <TabBar
 *     label="Agent sections"
 *     value={tab}
 *     onChange={setTab}
 *     tabs={[
 *       { value: "overview", label: "Overview" },
 *       { value: "activity", label: "Activity", count: 14 },
 *       { value: "triggers", label: "Triggers", count: 2 },
 *       { value: "versions", label: "Versions" },
 *     ]}
 *   />
 *   {tab === "overview" && <…/>}
 *
 * `useTabParam` keeps the tab in `?tab=` so a section is linkable and
 * survives reload. For a view switch (not sections) use <SegmentedControl>
 * or the pill <Tabs>.
 */
export interface TabItem<T extends string = string> {
  value: T;
  label: ReactNode;
  /** Small count after the label. Hidden when undefined; shown when 0. */
  count?: number;
  icon?: ComponentType<{ className?: string }>;
  disabled?: boolean;
  /** Accessible name when it should differ from label + count ("Approvals (1)"). */
  ariaLabel?: string;
}

export function TabBar<T extends string>({
  tabs,
  value,
  onChange,
  label,
  trailing,
  className,
}: {
  tabs: ReadonlyArray<TabItem<T>>;
  value: T;
  onChange: (value: T) => void;
  /** Accessible name for the tablist. */
  label: string;
  /** Right-aligned controls on the same line (a filter, a view switch). */
  trailing?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center justify-between gap-4 border-b border-border", className)}>
      {/* Each tab's hit area hangs 4px outside its label (-mx-1). The list is
          padded by the same 4px on BOTH sides, so the last tab does not
          overflow it: an overflow of 4px is what made the whole row jump
          left when the last tab was selected and scrolled into view. */}
      <div role="tablist" aria-label={label} className="no-scrollbar -mb-px -ml-1 flex min-w-0 items-center gap-6 overflow-x-auto px-1">
        {tabs.map((t) => {
          const active = t.value === value;
          return (
            <button
              key={t.value}
              type="button"
              role="tab"
              aria-selected={active}
              aria-label={t.ariaLabel}
              disabled={t.disabled}
              onClick={() => onChange(t.value)}
              className={cn(
                "relative -mx-1 inline-flex h-10 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-small-size font-medium whitespace-nowrap transition-quick select-none disabled:pointer-events-none disabled:opacity-45",
                // The tablist scrolls sideways, which would clip an outset
                // ring: the focus ring is drawn inside the tab instead.
                "focus-visible:outline-offset-[-2px]",
                "after:absolute after:inset-x-1 after:bottom-0 after:h-0.5 after:rounded-full after:bg-ink after:transition-opacity",
                active ? "text-fg after:opacity-100" : "text-fg-muted after:opacity-0 hover:text-fg",
              )}
            >
              {t.icon && <t.icon className="size-4 stroke-[1.75]" />}
              {t.label}
              {t.count !== undefined && (
                <span
                  className={cn(
                    "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 text-micro-size font-medium",
                    active ? "bg-bg-pressed text-fg" : "bg-bg-soft text-fg-subtle",
                  )}
                >
                  {t.count}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {trailing && <div className="flex shrink-0 items-center gap-2 pb-1">{trailing}</div>}
    </div>
  );
}

/** Keep the active tab in the URL (`?tab=`). Unknown values fall back. */
export function useTabParam<T extends string>(
  fallback: T,
  allowed?: ReadonlyArray<T>,
  param = "tab",
): [T, (next: T) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.get(param) as T | null;
  const value = raw && (!allowed || allowed.includes(raw)) ? raw : fallback;
  const set = useCallback(
    (next: T) => {
      const sp = new URLSearchParams(params);
      if (next === fallback) sp.delete(param);
      else sp.set(param, next);
      setParams(sp, { replace: true });
    },
    [params, setParams, fallback, param],
  );
  return [value, set];
}
