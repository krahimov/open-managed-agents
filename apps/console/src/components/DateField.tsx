import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { CalendarIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";

import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * A date, chosen from a calendar or typed.
 *
 *   <Field label="Expiration date">
 *     <DateField value={expiry} onChange={setExpiry} min={today} placeholder="No expiry" />
 *   </Field>
 *
 * The value is a calendar day as `YYYY-MM-DD` ("" for none), the same
 * string a native date input holds, so it drops in where one was. What it
 * replaces is the browser's own picker, which looks like a different
 * product on every platform.
 *
 * The field reads the way dates are written everywhere else in the
 * console ("Feb 8, 2027") and can be typed into: an ISO date, "8 Feb
 * 2027" or "2/8/2027" are all understood when the field is left. The
 * button opens a month grid: arrow keys move by day and week, Page Up and
 * Page Down by month, Home and End to the ends of the week, Enter picks.
 * Days outside `min`..`max` are shown but cannot be picked.
 *
 * It is a single form control for <Field>: `id`, `aria-describedby` and
 * `aria-invalid` land on the text input.
 */
export function DateField({
  value,
  onChange,
  min,
  max,
  today: todayProp,
  placeholder = "No date",
  className,
  id,
  disabled,
  "aria-describedby": describedBy,
  "aria-invalid": invalid,
  "aria-label": ariaLabel,
  "aria-labelledby": labelledBy,
}: {
  /** `YYYY-MM-DD`, or "" for no date. */
  value: string;
  onChange: (value: string) => void;
  /** Earliest and latest day that can be picked, `YYYY-MM-DD`. */
  min?: string;
  max?: string;
  /** The day to mark as today. Defaults to the local date; pass a UTC day when the value is one. */
  today?: string;
  /** Shown while there is no date. It should say what "none" means: "No expiry". */
  placeholder?: string;
  className?: string;
  id?: string;
  disabled?: boolean;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  "aria-label"?: string;
  "aria-labelledby"?: string;
}) {
  const today = todayProp ?? toIso(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());
  const [open, setOpen] = useState(false);
  // What is being typed, while it is being typed. null: show the value.
  const [draft, setDraft] = useState<string | null>(null);
  // Why the last thing typed was not taken. The field goes back to what it held and says this under it.
  const [problem, setProblem] = useState("");
  const rejected = problem !== "";
  const setRejected = (on: false) => !on && setProblem("");
  const problemId = useId();

  const allowed = (iso: string) => (!min || iso >= min) && (!max || iso <= max);

  const commitDraft = () => {
    if (draft === null) return;
    const text = draft.trim();
    setDraft(null);
    if (text === "") {
      setRejected(false);
      if (value !== "") onChange("");
      return;
    }
    const parsed = parseDay(text);
    if (parsed && allowed(parsed)) {
      setRejected(false);
      if (parsed !== value) onChange(parsed);
    } else if (!parsed) {
      setProblem(`“${text}” is not a date. Try 2027-02-08 or Feb 8, 2027.`);
    } else {
      setProblem(
        min && max
          ? `Choose a day from ${formatDay(min)} to ${formatDay(max)}.`
          : min
            ? `Choose ${formatDay(min)} or later.`
            : `Choose ${formatDay(max!)} or earlier.`,
      );
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div
          data-slot="date-field"
          className={cn(
            "group/date relative flex h-9 w-full min-w-0 items-center rounded-md border border-border-strong bg-bg-surface shadow-[var(--shadow-xs)] transition-quick hover:border-fg-faint has-[input:focus-visible]:border-plum has-[input:focus-visible]:shadow-[var(--shadow-focus)] dark:bg-bg-soft",
            (invalid || rejected) && "border-danger",
            disabled && "pointer-events-none bg-bg-inset opacity-60",
            className,
          )}
        >
          <input
            id={id}
            type="text"
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            aria-label={ariaLabel}
            aria-labelledby={labelledBy}
            aria-describedby={[rejected ? problemId : null, describedBy].filter(Boolean).join(" ") || undefined}
            aria-invalid={invalid || rejected || undefined}
            placeholder={placeholder}
            value={draft ?? (value ? formatDay(value) : "")}
            onChange={(e) => {
              setDraft(e.target.value);
              setRejected(false);
            }}
            onBlur={commitDraft}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitDraft();
              } else if (e.key === "ArrowDown" && e.altKey) {
                e.preventDefault();
                setOpen(true);
              } else if (e.key === "Escape" && draft !== null) {
                e.stopPropagation();
                setDraft(null);
              }
            }}
            className="h-full min-w-0 flex-1 rounded-md bg-transparent pr-1 pl-3 text-base text-fg outline-none placeholder:text-fg-subtle focus-visible:outline-none md:text-sm"
          />
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={disabled}
              aria-label={value ? `Choose a date, ${formatDay(value)} selected` : "Choose a date"}
              className="mr-1 inline-flex size-7 shrink-0 items-center justify-center rounded-full text-fg-subtle transition-quick hover:bg-bg-hover hover:text-fg aria-expanded:bg-bg-hover aria-expanded:text-fg"
            >
              <CalendarIcon className="size-4" />
            </button>
          </PopoverTrigger>
        </div>
      </PopoverAnchor>
      {rejected && (
        <p id={problemId} role="alert" className="mt-1.5 text-xs text-danger">
          {problem}
        </p>
      )}
      <PopoverContent
        align="start"
        sideOffset={6}
        collisionPadding={8}
        className="w-auto gap-0 p-3"
        // Open on the chosen day (or today), ready for the arrow keys.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement).querySelector<HTMLButtonElement>('[data-day][tabindex="0"]')?.focus({ preventScroll: true });
        }}
      >
        <MonthGrid
          value={value}
          today={today}
          min={min}
          max={max}
          onPick={(iso) => {
            setRejected(false);
            setDraft(null);
            onChange(iso);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

// ── The calendar ────────────────────────────────────────────────────

function MonthGrid({
  value,
  today,
  min,
  max,
  onPick,
}: {
  value: string;
  today: string;
  min?: string;
  max?: string;
  onPick: (iso: string) => void;
}) {
  const clamp = (iso: string) => (min && iso < min ? min : max && iso > max ? max : iso);
  // The day the keyboard is on. It starts on the chosen day, or today.
  const [cursor, setCursor] = useState(() => clamp(value || today));
  const { y, m } = parts(cursor);
  const titleId = useId();
  const gridRef = useRef<HTMLDivElement>(null);
  // Focus follows the cursor only when a key moved it: the month buttons
  // keep focus, so "next, next, next" works from the keyboard too.
  const follow = useRef(false);
  useEffect(() => {
    if (!follow.current) return;
    follow.current = false;
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-day="${cursor}"]`)?.focus({ preventScroll: true });
  }, [cursor]);

  const firstDay = useMemo(weekStart, []);
  const weekdays = useMemo(() => {
    // 2024-01-01 was a Monday.
    const fmt = new Intl.DateTimeFormat(undefined, { weekday: "short", timeZone: "UTC" });
    const long = new Intl.DateTimeFormat(undefined, { weekday: "long", timeZone: "UTC" });
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(Date.UTC(2024, 0, 1 + ((firstDay - 1 + i) % 7)));
      return { short: fmt.format(d).slice(0, 2), long: long.format(d) };
    });
  }, [firstDay]);

  const weeks = useMemo(() => {
    const first = new Date(Date.UTC(y, m, 1));
    const lead = (first.getUTCDay() - (firstDay % 7) + 7) % 7;
    const days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const cells: Array<string | null> = [...Array<null>(lead).fill(null)];
    for (let d = 1; d <= days; d++) cells.push(toIso(y, m, d));
    while (cells.length % 7 !== 0) cells.push(null);
    return Array.from({ length: cells.length / 7 }, (_, w) => cells.slice(w * 7, w * 7 + 7));
  }, [y, m, firstDay]);

  const monthLabel = new Date(Date.UTC(y, m, 1)).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
  const canGoBack = !min || toIso(y, m, 1) > min;
  const canGoForward = !max || toIso(y, m + 1, 1) <= max;
  const shiftMonth = (by: number) => setCursor((c) => clamp(addMonths(c, by)));

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const move = (next: string) => {
      e.preventDefault();
      follow.current = true;
      setCursor(clamp(next));
    };
    const weekday = (new Date(`${cursor}T00:00:00Z`).getUTCDay() - (firstDay % 7) + 7) % 7;
    switch (e.key) {
      case "ArrowLeft":
        return move(addDays(cursor, -1));
      case "ArrowRight":
        return move(addDays(cursor, 1));
      case "ArrowUp":
        return move(addDays(cursor, -7));
      case "ArrowDown":
        return move(addDays(cursor, 7));
      case "Home":
        return move(addDays(cursor, -weekday));
      case "End":
        return move(addDays(cursor, 6 - weekday));
      case "PageUp":
        return move(addMonths(cursor, e.shiftKey ? -12 : -1));
      case "PageDown":
        return move(addMonths(cursor, e.shiftKey ? 12 : 1));
    }
  };

  const navButton =
    "inline-flex size-8 items-center justify-center rounded-full text-fg-muted transition-quick hover:bg-bg-hover hover:text-fg disabled:pointer-events-none disabled:text-fg-faint";

  return (
    <div className="select-none">
      <div className="flex items-center justify-between gap-2 pb-2">
        <button type="button" aria-label="Previous month" disabled={!canGoBack} onClick={() => shiftMonth(-1)} className={navButton}>
          <ChevronLeftIcon className="size-4" />
        </button>
        <div id={titleId} aria-live="polite" className="text-small font-medium text-fg">
          {monthLabel}
        </div>
        <button type="button" aria-label="Next month" disabled={!canGoForward} onClick={() => shiftMonth(1)} className={navButton}>
          <ChevronRightIcon className="size-4" />
        </button>
      </div>

      <div ref={gridRef} role="grid" aria-labelledby={titleId} onKeyDown={onKeyDown}>
        <div role="row" className="grid grid-cols-7">
          {weekdays.map((d) => (
            <div key={d.long} role="columnheader" aria-label={d.long} className="flex h-7 w-9 items-center justify-center text-xs font-medium text-fg-subtle">
              {d.short}
            </div>
          ))}
        </div>
        {weeks.map((week, w) => (
          <div key={w} role="row" className="grid grid-cols-7">
            {week.map((iso, i) => {
              if (!iso) return <div key={i} role="gridcell" className="size-9" />;
              const selected = iso === value;
              const isToday = iso === today;
              const off = (!!min && iso < min) || (!!max && iso > max);
              return (
                <div key={iso} role="gridcell" aria-selected={selected} className="flex size-9 items-center justify-center">
                  <button
                    type="button"
                    data-day={iso}
                    tabIndex={iso === cursor ? 0 : -1}
                    aria-label={formatDay(iso, true)}
                    aria-current={isToday ? "date" : undefined}
                    aria-disabled={off || undefined}
                    onClick={() => !off && onPick(iso)}
                    onFocus={() => iso !== cursor && setCursor(iso)}
                    className={cn(
                      "relative inline-flex size-8 items-center justify-center rounded-full text-small tabular-nums transition-quick",
                      selected
                        ? "bg-ink font-medium text-on-ink"
                        : off
                          ? "cursor-default text-fg-faint"
                          : "text-fg hover:bg-bg-hover",
                      // Today is marked with a dot under the number, not a second fill.
                      isToday && "after:absolute after:bottom-1 after:size-1 after:rounded-full",
                      isToday && (selected ? "after:bg-on-ink" : "after:bg-plum"),
                    )}
                  >
                    {Number(iso.slice(8))}
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Calendar days as strings (no time zones involved) ───────────────

const pad = (n: number) => String(n).padStart(2, "0");

/** `YYYY-MM-DD` from a year, a 0-based month (may overflow) and a day. */
function toIso(y: number, m: number, d: number): string {
  const date = new Date(Date.UTC(y, m, d));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function parts(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split("-").map(Number);
  return { y, m: m - 1, d };
}

function addDays(iso: string, by: number): string {
  const { y, m, d } = parts(iso);
  return toIso(y, m, d + by);
}

/** The same day in another month, or that month's last day when it is shorter. */
function addMonths(iso: string, by: number): string {
  const { y, m, d } = parts(iso);
  const last = new Date(Date.UTC(y, m + by + 1, 0)).getUTCDate();
  return toIso(y, m + by, Math.min(d, last));
}

/** "Feb 8, 2027"; with `long`, "Monday, February 8, 2027" for screen readers. */
function formatDay(iso: string, long = false): string {
  const { y, m, d } = parts(iso);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return iso;
  return new Date(Date.UTC(y, m, d)).toLocaleDateString(
    undefined,
    long
      ? { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }
      : { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" },
  );
}

/** A typed date as `YYYY-MM-DD`, or null. ISO first, then whatever the platform can read. */
function parseDay(text: string): string | null {
  const iso = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(text);
  if (iso) {
    const [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    const out = toIso(y, m - 1, d);
    // Reject 2027-02-31 rather than roll it into March.
    return out === `${iso[1]}-${pad(m)}-${pad(d)}` ? out : null;
  }
  const t = Date.parse(text);
  if (Number.isNaN(t)) return null;
  const local = new Date(t);
  const year = local.getFullYear();
  if (year < 1970 || year > 9999) return null;
  return toIso(year, local.getMonth(), local.getDate());
}

/** 1 (Monday) to 7 (Sunday): the first day of the week where the reader is. */
function weekStart(): number {
  try {
    const locale = new Intl.Locale(navigator.language) as Intl.Locale & {
      getWeekInfo?: () => { firstDay?: number };
      weekInfo?: { firstDay?: number };
    };
    const first = locale.getWeekInfo?.().firstDay ?? locale.weekInfo?.firstDay;
    if (first && first >= 1 && first <= 7) return first;
    return /-(US|CA|MX|BR|JP|IL|AU|PH|ZA|IN|KR|TW|HK|CO|PE|VE)$/i.test(navigator.language) ? 7 : 1;
  } catch {
    return 1;
  }
}
