import type { ComponentType, ReactNode } from "react";
import { CheckIcon, LockKeyholeIcon, PlusIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

import { EntityAvatar, type AvatarSize } from "../AgentAvatar";
import { Chip } from "../Badge";
import { RowLink } from "../DataTable";
import { FacetedFilter } from "../FacetedFilter";
import { FilterChip } from "../FilterChip";
import { OverflowTip } from "../OverflowTip";
import { Tip } from "../Tip";
import { failureSentence } from "@/lib/failure-text";

/**
 * Small shared parts of the resource pages (Environments, Vaults, Memory,
 * Skills, Models). They exist so the five lists and their record pages
 * are built from the same pieces:
 *
 *   <ResourceIdentity>      the identity cell: the name as the row's link, one line
 *   <ChipRow>               a few values in a cell, the whole list on hover and focus
 *   <ArchiveStatusFilter>   the Status chip (All / Active / Archived)
 *   <MaskedSecret>          a stored secret: dots, last characters, a lock
 *   <ChoiceCards>           a radio group drawn as cards (pick a kind)
 *   <KeyValueRows>          an editable list of key–value pairs
 *   <Fact>                  icon + short text, for dense fact lines
 */

// ── Identity cell ───────────────────────────────────────────────────

/**
 * The identity cell of a resource row: the record's name (the link that
 * opens the row) over one quiet line.
 *
 * A leading mark is there to tell rows apart: a skill's subject, a
 * provider's mark, a file's type. Pass it as `icon` (drawn in the neutral
 * tile) or `avatar` (your own mark). A list whose rows would all wear the
 * same icon (every vault a vault, every environment a box) passes
 * neither and leads with the name: the page title already says what
 * these are.
 *
 * Both lines truncate; while one is cut, the whole text is shown on hover
 * and on keyboard focus.
 */
export function ResourceIdentity({
  icon,
  avatar,
  name,
  secondary,
  secondaryTitle,
  archived,
  badge,
  size = "md",
  mono,
}: {
  /** A mark that differs from row to row, drawn in the neutral tile. */
  icon?: ComponentType<{ className?: string }>;
  /** A ready-made leading mark (an agent's avatar, a provider's mark). Wins over `icon`. */
  avatar?: ReactNode;
  name: string;
  /** One quiet line under the name. */
  secondary?: ReactNode;
  /** Full text of `secondary` for the tooltip when it is not a plain string. */
  secondaryTitle?: string;
  archived?: boolean;
  /** A chip after the name ("Default"). */
  badge?: ReactNode;
  size?: AvatarSize;
  /** Mono secondary line (a model id, a path). */
  mono?: boolean;
}) {
  const full = secondaryTitle ?? (typeof secondary === "string" ? secondary : undefined);
  return (
    <div className="flex min-w-0 items-center gap-3">
      {avatar ?? (icon ? <EntityAvatar icon={icon} size={size} className={cn(archived && "opacity-60")} /> : null)}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <RowLink className={cn("font-medium", archived ? "text-fg-muted" : "text-fg")}>{name}</RowLink>
          {badge}
          {archived && <Chip tone="outline">Archived</Chip>}
        </div>
        {secondary != null && secondary !== "" && (
          <div className="flex min-w-0">
            <OverflowTip label={full} focusable>
              <div className={cn("min-w-0 truncate rounded-sm text-xs text-fg-subtle", mono && "font-mono text-micro-size")}>
                {secondary}
              </div>
            </OverflowTip>
          </div>
        )}
      </div>
    </div>
  );
}

// ── A few values in a cell ──────────────────────────────────────────

/**
 * A short list of values in a table cell (the scopes of a key, the agents
 * found on a machine): the first as a chip, a second from 1280px wide,
 * and "+N" for the rest. The whole list is one tooltip on the row of
 * chips, shown on hover and on keyboard focus, so nothing that is cut or
 * counted is out of reach.
 */
export function ChipRow({
  items,
  mono,
  label,
}: {
  items: Array<{ key: string; label: string; mono?: boolean }>;
  /** Monospace for every chip (ids, scopes). An item's own `mono` wins. */
  mono?: boolean;
  /** What the list is, for the tooltip's first line and screen readers: "Scopes". */
  label: string;
}) {
  if (items.length === 0) return null;
  const [first, second, ...rest] = items;
  return (
    <Tip
      label={
        <span className="block">
          <span className="block opacity-75">{label}</span>
          {items.map((i) => (
            <span key={i.key} className={cn("block", (i.mono ?? mono) && "font-mono")}>
              {i.label}
            </span>
          ))}
        </span>
      }
    >
      <span tabIndex={0} aria-label={`${label}: ${items.map((i) => i.label).join(", ")}`} className="inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-full align-middle">
        <Chip mono={first.mono ?? mono} className="min-w-0 shrink">
          {first.label}
        </Chip>
        {second && (
          <>
            <Chip mono={second.mono ?? mono} className="hidden min-w-0 shrink-[8] xl:inline-flex">
              {second.label}
            </Chip>
            {/* Narrow: the second chip folds into the count. */}
            <Chip className="xl:hidden">+{rest.length + 1}</Chip>
          </>
        )}
        {rest.length > 0 && <Chip className="hidden xl:inline-flex">+{rest.length}</Chip>}
      </span>
    </Tip>
  );
}

// ── Status filter ───────────────────────────────────────────────────

export type ArchiveStatus = "any" | "active" | "archived";

const STATUS_OPTIONS: { value: ArchiveStatus; label: string }[] = [
  { value: "any", label: "All" },
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
];

/** The Status filter chip every archivable list shares. Maps to `?status=`. */
export function ArchiveStatusFilter({
  value,
  onChange,
  align = "start",
}: {
  value: ArchiveStatus;
  onChange: (value: ArchiveStatus) => void;
  align?: "start" | "end";
}) {
  return (
    <FilterChip
      label="Status"
      active={value !== "any"}
      display={value === "any" ? undefined : STATUS_OPTIONS.find((o) => o.value === value)?.label}
      onClear={() => onChange("any")}
    >
      <PopoverContent align={align} sideOffset={6} collisionPadding={8} className="w-52 gap-0 p-0">
        <FacetedFilter
          options={STATUS_OPTIONS}
          value={value}
          onValueChange={(v) => onChange(v as ArchiveStatus)}
          searchPlaceholder="Status"
        />
      </PopoverContent>
    </FilterChip>
  );
}

// ── Secrets ─────────────────────────────────────────────────────────

/**
 * A secret that is already stored. The console never has the value: it
 * shows a lock, a fixed run of dots and, when the API returns one, the
 * last characters so two keys can be told apart.
 *
 *   <MaskedSecret preview={card.api_key_preview} />     ••••••••wazK
 *   <MaskedSecret />                                    ••••••••••••
 *
 * There is deliberately no "reveal": stored secrets are write-only. To
 * change one, replace it.
 */
export function MaskedSecret({
  preview,
  hint = "Encrypted and write-only. It is never shown again; replace it to change it.",
  className,
}: {
  /** Trailing characters the API exposes for display. */
  preview?: string | null;
  /** Tooltip. */
  hint?: string;
  className?: string;
}) {
  return (
    <Tip label={hint}>
      <span
        className={cn(
          "inline-flex h-[22px] max-w-full items-center gap-1.5 rounded-full bg-bg-soft pr-2.5 pl-2 font-mono text-micro-size leading-none text-fg-muted",
          className,
        )}
      >
        <LockKeyholeIcon className="size-3 shrink-0 text-fg-subtle" aria-hidden="true" />
        <span aria-hidden="true" className="font-sans text-[0.5rem] tracking-[0.14em] text-fg-faint">
          {preview ? "●●●●" : "●●●●●●●●"}
        </span>
        {preview && <span className="text-fg">{preview}</span>}
        <span className="sr-only">{preview ? `Secret ending in ${preview}` : "Secret, hidden"}</span>
      </span>
    </Tip>
  );
}

// ── Choice cards ────────────────────────────────────────────────────

export interface ChoiceOption<T extends string> {
  value: T;
  label: string;
  description?: string;
  icon?: ComponentType<{ className?: string }>;
  disabled?: boolean;
}

/**
 * A radio group drawn as cards: use it when the choice changes what the
 * rest of the form asks for (a credential kind, an API format).
 */
export function ChoiceCards<T extends string>({
  label,
  value,
  onChange,
  options,
  columns = 2,
  className,
}: {
  /** Accessible name of the group. */
  label: string;
  value: T | null;
  onChange: (value: T) => void;
  options: ReadonlyArray<ChoiceOption<T>>;
  columns?: 2 | 3 | 4;
  className?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(
        "grid gap-2",
        columns === 2 && "sm:grid-cols-2",
        columns === 3 && "sm:grid-cols-3",
        columns === 4 && "grid-cols-2 lg:grid-cols-4",
        className,
      )}
    >
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            className={cn(
              "group/choice relative flex min-h-[60px] items-start gap-3 rounded-lg border px-3.5 py-3 text-left transition-quick disabled:pointer-events-none disabled:opacity-50",
              selected
                ? "border-ink bg-bg-surface shadow-[inset_0_0_0_1px_var(--ink)] dark:bg-bg-soft"
                : "border-border-strong bg-bg-surface hover:border-fg-faint hover:bg-bg-inset dark:bg-bg-soft dark:hover:bg-bg-hover",
            )}
          >
            {o.icon && (
              <span
                className={cn(
                  "mt-px flex size-7 shrink-0 items-center justify-center rounded-[9px] transition-quick",
                  selected ? "bg-ink text-on-ink" : "bg-bg-soft text-fg-muted",
                )}
              >
                <o.icon className="size-3.5" />
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span className="block text-small leading-5 font-medium text-fg">{o.label}</span>
              {o.description && <span className="mt-0.5 block text-xs text-fg-muted">{o.description}</span>}
            </span>
            <span
              aria-hidden="true"
              className={cn(
                "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border transition-quick",
                selected ? "border-ink bg-ink text-on-ink" : "border-border-strong",
              )}
            >
              {selected && <CheckIcon className="size-2.5 stroke-[3.5]" />}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ── Key–value rows ──────────────────────────────────────────────────

export interface KeyValueRow {
  key: string;
  value: string;
}

/** An editable list of key–value pairs (metadata, custom headers). */
export function KeyValueRows({
  rows,
  onChange,
  keyPlaceholder = "key",
  valuePlaceholder = "Value",
  addLabel = "Add row",
  noun = "row",
  minRows = 0,
  disabled,
}: {
  rows: KeyValueRow[];
  onChange: (rows: KeyValueRow[]) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  addLabel?: string;
  /** For accessible names: "header", "metadata entry". */
  noun?: string;
  /** Rows that cannot be removed (keep one blank row visible). */
  minRows?: number;
  disabled?: boolean;
}) {
  const set = (i: number, patch: Partial<KeyValueRow>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-2">
      {rows.map((row, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            value={row.key}
            onChange={(e) => set(i, { key: e.target.value })}
            placeholder={keyPlaceholder}
            aria-label={`${noun} ${i + 1} name`}
            autoComplete="off"
            disabled={disabled}
            className="flex-1 font-mono text-small-size md:text-small-size"
          />
          <Input
            value={row.value}
            onChange={(e) => set(i, { value: e.target.value })}
            placeholder={valuePlaceholder}
            aria-label={`${noun} ${i + 1} value`}
            autoComplete="off"
            disabled={disabled}
            className="flex-[1.4]"
          />
          <Tip label={`Remove ${noun}`}>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove ${noun} ${i + 1}`}
              disabled={disabled || rows.length <= minRows}
              onClick={() => onChange(rows.filter((_, j) => j !== i))}
            >
              <XIcon />
            </Button>
          </Tip>
        </div>
      ))}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="-ml-2"
        disabled={disabled}
        onClick={() => onChange([...rows, { key: "", value: "" }])}
      >
        <PlusIcon data-icon="inline-start" />
        {addLabel}
      </Button>
    </div>
  );
}

// ── Facts ───────────────────────────────────────────────────────────

/** Icon + short text, for a fact that needs a glyph to scan (network, runtime). */
export function Fact({
  icon: Icon,
  children,
  title,
  className,
}: {
  icon: ComponentType<{ className?: string }>;
  children: ReactNode;
  title?: string;
  className?: string;
}) {
  return (
    <span title={title} className={cn("inline-flex max-w-full min-w-0 items-center gap-1.5 text-fg-muted", className)}>
      <Icon className="size-3.5 shrink-0 text-fg-subtle" />
      <span className="truncate">{children}</span>
    </span>
  );
}

/** "192 B", "1.4 KB", "2.0 GB". */
export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n < 0) return "Not set";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  return `${v >= 100 || Number.isInteger(v) ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

/** Anything thrown, as a sentence a person can read (never a bare server token like "unavailable"). */
export function errorMessage(e: unknown, fallback = "Something went wrong"): string {
  if ((e instanceof Error && e.message) || (typeof e === "string" && e)) return failureSentence(e);
  return fallback;
}
