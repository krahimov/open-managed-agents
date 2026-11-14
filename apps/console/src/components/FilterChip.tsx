import { useEffect, useState, type ReactNode } from "react";
import { CheckIcon, ChevronDownIcon, XIcon } from "lucide-react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

import { DateField } from "./DateField";

/**
 * Filter chip — one structured filter in a list toolbar.
 *
 *   <FilterChip label="Status" active={status !== "any"} display={statusLabel} onClear={() => setStatus("any")}>
 *     <PopoverContent align="start" className="w-52 p-0">
 *       <FacetedFilter options={…} value={status} onValueChange={setStatus} />
 *     </PopoverContent>
 *   </FilterChip>
 *
 * At rest it is a dashed pill ("Status ⌄"): an invitation, not a value.
 * Once a value is chosen it becomes a solid pill that reads as a sentence
 * ("Status  Active ×"); the × clears just this filter. Every chip maps to
 * a real server query param — never filter loaded rows on the client.
 */
export function FilterChip({
  label,
  active,
  display,
  onClear,
  children,
}: {
  label: string;
  active: boolean;
  display?: string;
  onClear?: () => void;
  children: ReactNode;
}) {
  return (
    <Popover>
      <div
        className={cn(
          "inline-flex h-9 shrink-0 items-center rounded-full border text-small-size font-medium transition-quick",
          active
            ? "border-border-strong bg-bg-surface text-fg shadow-[var(--shadow-xs)] dark:bg-bg-soft"
            : "border-dashed border-border-strong text-fg-muted hover:border-fg-faint hover:bg-bg-hover hover:text-fg has-[[aria-expanded=true]]:bg-bg-hover has-[[aria-expanded=true]]:text-fg",
        )}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn("inline-flex h-full items-center gap-1.5 rounded-full", active ? "pr-1.5 pl-3" : "pr-2.5 pl-3")}
          >
            <span className={cn(active && "font-normal text-fg-muted")}>{label}</span>
            {display && <span>{display}</span>}
            {!active && <ChevronDownIcon className="size-3.5 text-fg-subtle" />}
          </button>
        </PopoverTrigger>
        {active && onClear && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onClear();
            }}
            className="mr-1 inline-flex size-6 items-center justify-center rounded-full text-fg-subtle transition-quick hover:bg-bg-hover hover:text-fg"
            aria-label={`Clear ${label} filter`}
          >
            <XIcon className="size-3.5" />
          </button>
        )}
      </div>
      {children}
    </Popover>
  );
}

// ── Created-at filter ───────────────────────────────────────────────
// Reusable across every list page that wants to slice by created_at.
// Internal state owns the preset choice + custom-range bounds; the
// page only sees the resolved `(after, before)` epoch-ms tuple via
// onChange. Both bounds nullable → "no bound on this side".

export type CreatedPreset =
  | "any"
  | "today"
  | "last-hour"
  | "last-day"
  | "last-7d"
  | "last-30d"
  | "custom";

export const CREATED_PRESET_LABELS: Record<CreatedPreset, string> = {
  any: "All time",
  today: "Today",
  "last-hour": "Last hour",
  "last-day": "Last day",
  "last-7d": "Last 7 days",
  "last-30d": "Last 30 days",
  custom: "Custom range",
};

function computePresetRange(
  preset: Exclude<CreatedPreset, "any" | "custom">,
): { after?: number; before?: number } {
  const now = Date.now();
  switch (preset) {
    case "today": {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      return { after: start.getTime() };
    }
    case "last-hour":
      return { after: now - 60 * 60 * 1000 };
    case "last-day":
      return { after: now - 24 * 60 * 60 * 1000 };
    case "last-7d":
      return { after: now - 7 * 24 * 60 * 60 * 1000 };
    case "last-30d":
      return { after: now - 30 * 24 * 60 * 60 * 1000 };
  }
}

/** Epoch ms → the local calendar day as YYYY-MM-DD, the value a
 *  <DateField> holds. `dateInputToMs` is its inverse (local midnight). */
export function msToDateInput(ms: number | undefined): string {
  if (ms === undefined) return "";
  const d = new Date(ms);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** YYYY-MM-DD → epoch ms at local midnight of that day. "" → undefined. */
export function dateInputToMs(day: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return undefined;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
}

/**
 * Drop-in Created-at chip. Owns its preset choice internally; surfaces
 * the resolved (after, before) epoch-ms bounds to the parent via
 * onChange so the parent can drop them straight into a server query
 * param.
 *
 * Label is configurable — pass "Created" / "Updated" / "Submitted"
 * etc. depending on the resource.
 */
export function CreatedFilterChip({
  label = "Created",
  value,
  onChange,
}: {
  label?: string;
  /** Currently-resolved bounds. `{}` = no filter. */
  value: { after?: number; before?: number };
  onChange: (v: { after?: number; before?: number }) => void;
}) {
  const [preset, setPreset] = useState<CreatedPreset>("any");
  const [customAfter, setCustomAfter] = useState<number | undefined>(value.after);
  const [customBefore, setCustomBefore] = useState<number | undefined>(value.before);

  const active = value.after !== undefined || value.before !== undefined;
  const display = preset === "any" ? undefined : CREATED_PRESET_LABELS[preset];

  // The page cleared the filter from outside ("Clear filters"): forget the
  // choice made here too. (A custom range with no dates yet is not that:
  // it is a person about to pick them.)
  const cleared = value.after === undefined && value.before === undefined;
  useEffect(() => {
    if (!cleared || preset === "any") return;
    if (preset === "custom" && customAfter === undefined && customBefore === undefined) return;
    setPreset("any");
    setCustomAfter(undefined);
    setCustomBefore(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cleared]);

  const apply = (next: CreatedPreset, opts?: { after?: number; before?: number }) => {
    setPreset(next);
    if (next === "any") {
      onChange({});
      return;
    }
    if (next === "custom") {
      onChange({ after: opts?.after ?? customAfter, before: opts?.before ?? customBefore });
      return;
    }
    onChange(computePresetRange(next));
  };

  return (
    <FilterChip
      label={label}
      active={active}
      display={display}
      onClear={() => {
        setPreset("any");
        setCustomAfter(undefined);
        setCustomBefore(undefined);
        onChange({});
      }}
    >
      <PopoverContent
        align="start"
        sideOffset={4}
        collisionPadding={8}
        className="w-60 gap-0.5 p-1.5"
      >
        {(Object.keys(CREATED_PRESET_LABELS) as CreatedPreset[]).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => apply(p)}
            className={cn(
              "flex min-h-8 w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-small-size text-fg transition-colors duration-75",
              "hover:bg-bg-hover",
              preset === p && "font-medium",
            )}
          >
            {CREATED_PRESET_LABELS[p]}
            {preset === p && <CheckIcon className="size-4 text-fg" />}
          </button>
        ))}
        {preset === "custom" && (
          <div className="mt-1.5 space-y-2.5 border-t border-border px-1 pt-2.5 pb-1">
            <div>
              <span className="mb-1 block text-xs font-medium text-fg-muted">From</span>
              <DateField
                aria-label={`${label} from`}
                placeholder="Any time"
                value={msToDateInput(customAfter)}
                // "To" holds the start of the day after the one chosen.
                max={customBefore !== undefined ? msToDateInput(customBefore - 1) : undefined}
                onChange={(v) => {
                  const next = dateInputToMs(v);
                  setCustomAfter(next);
                  apply("custom", { after: next, before: customBefore });
                }}
              />
            </div>
            <div>
              <span className="mb-1 block text-xs font-medium text-fg-muted">To</span>
              <DateField
                aria-label={`${label} to`}
                placeholder="Now"
                value={customBefore !== undefined ? msToDateInput(customBefore - 1) : ""}
                min={msToDateInput(customAfter) || undefined}
                onChange={(v) => {
                  // The start of the next day, so the chosen day is included
                  // whole (the filter is "before", not "up to").
                  const day = dateInputToMs(v);
                  let next: number | undefined;
                  if (day !== undefined) {
                    const d = new Date(day);
                    d.setDate(d.getDate() + 1);
                    next = d.getTime();
                  }
                  setCustomBefore(next);
                  apply("custom", { after: customAfter, before: next });
                }}
              />
            </div>
          </div>
        )}
      </PopoverContent>
    </FilterChip>
  );
}
