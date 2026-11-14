import type { ComponentType, ReactNode } from "react";
import { Select as SelectPrimitive } from "radix-ui";
import { CheckIcon } from "lucide-react";

import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectTrigger, SelectValue } from "@/components/ui/select";
import { initials } from "@/lib/format";
import { cn } from "@/lib/utils";

import { EntityAvatar, type AvatarSize } from "../AgentAvatar";
import { BRAND_MARKS } from "../brand-marks";

/**
 * Small form controls shared by the agent screens (create and edit
 * dialogs, the trigger dialog, deployments, CLI sign-in). They are built
 * from the kit's tokens and primitives and add only what the kit does not
 * have: a select whose options carry a description, selectable cards,
 * choice pills and checkbox rows.
 */

type IconType = ComponentType<{ className?: string }>;

export interface PickOption<T extends string = string> {
  value: T;
  label: string;
  /** Second line in the list. Not shown in the closed trigger. */
  hint?: string;
  icon?: IconType;
  disabled?: boolean;
}

/**
 * A select for a handful of options that each deserve a line of
 * explanation ("Decide: assesses the event first…"). The closed control
 * shows only the label. Works inside <Field>: it accepts the `id` and
 * aria attributes Field passes down, so the label is announced with it.
 *
 *   <Field label="When it wakes">
 *     <PickSelect value={mode} onValueChange={setMode} options={WAKE_OPTIONS} />
 *   </Field>
 */
export function PickSelect<T extends string>({
  value,
  onValueChange,
  options,
  placeholder,
  disabled,
  size = "default",
  className,
  id,
  "aria-label": ariaLabel,
  "aria-labelledby": labelledBy,
  "aria-describedby": describedBy,
  "aria-invalid": invalid,
}: {
  value: T | "";
  onValueChange: (value: T) => void;
  options: ReadonlyArray<PickOption<T>>;
  placeholder?: string;
  disabled?: boolean;
  size?: "sm" | "default";
  className?: string;
  id?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}) {
  return (
    <Select value={value || undefined} onValueChange={(v) => onValueChange(v as T)} disabled={disabled}>
      <SelectTrigger
        id={id}
        size={size}
        aria-label={ariaLabel}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        aria-invalid={invalid}
        className={cn("w-full", className)}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent position="popper" align="start" className="max-w-[min(26rem,calc(100vw-2rem))]">
        {options.map((opt) => (
          <SelectPrimitive.Item
            key={opt.value}
            value={opt.value}
            disabled={opt.disabled}
            className="relative flex min-h-8 w-full cursor-pointer items-start gap-2 rounded-md py-1.5 pr-8 pl-2 text-small-size text-fg outline-hidden transition-colors duration-75 select-none focus:bg-bg-hover data-disabled:pointer-events-none data-disabled:opacity-45"
          >
            <span className="min-w-0 flex-1">
              <SelectPrimitive.ItemText>
                <span className="inline-flex items-center gap-1.5">
                  {opt.icon && <opt.icon className="size-3.5 shrink-0 text-fg-muted" />}
                  {opt.label}
                </span>
              </SelectPrimitive.ItemText>
              {opt.hint && <span className="mt-0.5 block text-xs leading-snug text-fg-subtle">{opt.hint}</span>}
            </span>
            <span className="pointer-events-none absolute top-2 right-2 flex size-4 items-center justify-center">
              <SelectPrimitive.ItemIndicator>
                <CheckIcon className="size-4" />
              </SelectPrimitive.ItemIndicator>
            </span>
          </SelectPrimitive.Item>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * A choice drawn as a card: an icon, a title and one line that says what
 * choosing it means. Use a group of them when the options need explaining
 * (which engine runs the agent). `role` is "radio" inside a radiogroup or
 * "checkbox" for independent toggles.
 */
export function OptionCard({
  selected,
  onSelect,
  title,
  description,
  icon: Icon,
  leading,
  role = "radio",
  disabled,
  trailing,
  className,
}: {
  selected: boolean;
  onSelect: () => void;
  title: ReactNode;
  description?: ReactNode;
  icon?: IconType;
  /** Custom leading mark (an avatar). Wins over `icon`. */
  leading?: ReactNode;
  role?: "radio" | "checkbox";
  disabled?: boolean;
  /** Replaces the check mark (a status chip on a disabled option). */
  trailing?: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      role={role}
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "group/option relative flex w-full items-start gap-3 rounded-lg border bg-bg-surface p-3.5 text-left transition-quick dark:bg-bg-soft",
        selected
          ? "border-ink shadow-[inset_0_0_0_1px_var(--ink)]"
          : "border-border-strong hover:border-fg-faint hover:bg-bg-inset dark:hover:bg-bg-hover",
        disabled && "cursor-not-allowed opacity-60 hover:border-border-strong hover:bg-bg-surface",
        className,
      )}
    >
      {leading ?? (Icon && <EntityAvatar icon={Icon} size="md" />)}
      <span className="min-w-0 flex-1">
        <span className="block text-small leading-5 font-medium text-fg">{title}</span>
        {description && <span className="mt-0.5 block text-xs leading-snug text-fg-muted">{description}</span>}
      </span>
      {trailing ?? (
        <span
          aria-hidden="true"
          className={cn(
            "mt-0.5 flex size-[18px] shrink-0 items-center justify-center border transition-quick",
            role === "radio" ? "rounded-full" : "rounded-[6px]",
            selected ? "border-ink bg-ink text-on-ink" : "border-border-strong bg-bg-surface dark:bg-transparent",
          )}
        >
          {selected && <CheckIcon className="size-3 stroke-[3]" />}
        </span>
      )}
    </button>
  );
}

/**
 * A row of mutually exclusive pills with icons, for six to ten short
 * options that are easier to scan than to open a menu for (trigger
 * sources). Wraps onto more lines as needed.
 */
export function ChoicePills<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
}: {
  value: T;
  onChange: (value: T) => void;
  options: ReadonlyArray<{ value: T; label: string; icon?: IconType }>;
  /** Accessible name for the group. */
  label: string;
  className?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cn("flex flex-wrap gap-1.5", className)}>
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(opt.value)}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-small leading-none font-medium whitespace-nowrap transition-quick select-none",
              active
                ? "border-ink bg-ink text-on-ink"
                : "border-border-strong bg-bg-surface text-fg-muted hover:border-fg-faint hover:text-fg dark:bg-bg-soft",
            )}
          >
            {opt.icon && <opt.icon className="size-3.5 shrink-0" />}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * One selectable row in a list (a skill, a vault, a workspace): checkbox,
 * optional mark, a name and a secondary line. The whole row toggles.
 * Stack rows inside a `rounded-lg border` box; they draw their own
 * dividers.
 */
export function CheckRow({
  checked,
  onCheckedChange,
  title,
  description,
  leading,
  trailing,
  disabled,
  mono,
  className,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
  disabled?: boolean;
  /** Monospace title (tool names, ids). */
  mono?: boolean;
  className?: string;
}) {
  return (
    <label
      className={cn(
        "flex min-h-11 cursor-pointer items-center gap-3 border-t border-border px-3.5 py-2.5 transition-quick first:border-t-0 hover:bg-bg-hover has-disabled:cursor-not-allowed has-disabled:opacity-60",
        className,
      )}
    >
      <Checkbox checked={checked} disabled={disabled} onCheckedChange={(v) => onCheckedChange(v === true)} />
      {leading}
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate text-small leading-5 font-medium text-fg", mono && "font-mono font-normal")}>
          {title}
        </span>
        {description && <span className="block truncate text-xs text-fg-subtle">{description}</span>}
      </span>
      {trailing}
    </label>
  );
}

/** The bordered box that holds a stack of <CheckRow>s or other list rows. */
export function RowBox({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("overflow-hidden rounded-lg border border-border-strong bg-bg-surface dark:bg-bg-soft", className)}>
      {children}
    </div>
  );
}

/**
 * A third-party app's mark. Known apps draw their brand glyph from the
 * vendored set (components/brand-marks.ts) in the text colour, so it sits
 * with the rest of the iconography in both themes; any other app shows its
 * initial. Nothing is fetched from the network, so there is never an empty
 * box or a late-loading image.
 *
 * `slug` is the app's id where there is one ("googledrive"); the name is
 * tried too ("Google Drive").
 */
export function AppIcon({
  name,
  slug,
  size = "md",
  tone = "neutral",
  className,
}: {
  name: string;
  slug?: string | null;
  size?: AvatarSize;
  /** `neutral` in rows and lists (default); `surface` on a gallery card. */
  tone?: "neutral" | "surface";
  className?: string;
}) {
  const path = brandMark(slug) ?? brandMark(name);
  return (
    <EntityAvatar size={size} tone={tone} className={cn("font-semibold", path && "text-fg", className)}>
      {path ? (
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="size-[52%]">
          <path d={path} />
        </svg>
      ) : (
        <span className="tracking-tight">{initials(name, 1)}</span>
      )}
    </EntityAvatar>
  );
}

/** The vendored glyph for an app id or name, if there is one. */
export function brandMark(key: string | null | undefined): string | undefined {
  if (!key) return undefined;
  const k = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return BRAND_MARKS[k] ?? BRAND_MARKS[k.replace(/(mcp|app|cloud)$/, "")];
}

/**
 * A titled group of fields inside a long form: a heading, one line of
 * guidance, then the fields. The agent dialog is made of these.
 */
export function FormSection({
  title,
  description,
  action,
  children,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** Right-aligned control beside the heading (an "Add" button, a link). */
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={className}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-h3 text-fg">{title}</h3>
          {description && <p className="mt-0.5 max-w-[60ch] text-small text-fg-muted">{description}</p>}
        </div>
        {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
      </div>
      <div className="mt-4 space-y-5">{children}</div>
    </section>
  );
}

/** A quiet label above a sub-group inside a FormSection ("Files and shell"). */
export function GroupLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("mb-1.5 text-xs font-medium text-fg-subtle", className)}>{children}</div>;
}
