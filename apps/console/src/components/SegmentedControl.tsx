import type { ComponentType, ReactNode } from "react";

import { cn } from "@/lib/utils";

import { Tip } from "./Tip";

/**
 * A small set of mutually exclusive choices that apply immediately: a view
 * switch (Grid | List), a range (7d | 30d | 90d), the theme. Two to five
 * options. For page sections use <TabBar>; for filters use <FilterChip>.
 *
 *   <SegmentedControl
 *     label="View"
 *     value={view}
 *     onChange={setView}
 *     options={[
 *       { value: "grid", label: "Gallery", icon: LayoutGridIcon },
 *       { value: "list", label: "List", icon: Rows3Icon },
 *     ]}
 *     iconOnly
 *   />
 */
export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: ComponentType<{ className?: string }>;
}

export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  label,
  size = "md",
  iconOnly,
  stretch,
  className,
  id,
  "aria-labelledby": labelledBy,
  "aria-describedby": describedBy,
  "aria-invalid": invalid,
}: {
  value: T;
  onChange: (value: T) => void;
  options: ReadonlyArray<SegmentedOption<T>>;
  /** Accessible name for the group. Inside <Field> the visible label names it instead. */
  label?: string;
  size?: "sm" | "md";
  /** Show icons only; labels move to tooltips. Every option needs an icon. */
  iconOnly?: boolean;
  /** Fill the container width (options share it equally). */
  stretch?: boolean;
  className?: string;
  /** From <Field>: a click on its label focuses the chosen option. */
  id?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}) {
  return (
    <div
      id={id}
      role="radiogroup"
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      aria-invalid={invalid || undefined}
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5 rounded-full bg-bg-soft p-[3px]",
        size === "md" ? "h-9" : "h-8",
        stretch && "flex w-full",
        className,
      )}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        const Icon = opt.icon;
        const content: ReactNode = (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={iconOnly ? opt.label : undefined}
            onClick={() => onChange(opt.value)}
            className={cn(
              "inline-flex h-full items-center justify-center gap-1.5 rounded-full text-small leading-none font-medium whitespace-nowrap transition-quick select-none",
              iconOnly ? "aspect-square px-0" : size === "sm" ? "px-2.5" : "px-3.5",
              stretch && "flex-1",
              active
                ? "bg-bg-surface text-fg shadow-[var(--shadow-xs)] dark:bg-bg-pressed"
                : "text-fg-muted hover:text-fg",
            )}
          >
            {Icon && <Icon className="size-4 shrink-0" />}
            {!iconOnly && opt.label}
          </button>
        );
        return iconOnly ? (
          <Tip key={opt.value} label={opt.label}>
            {content as React.ReactElement}
          </Tip>
        ) : (
          content
        );
      })}
    </div>
  );
}
