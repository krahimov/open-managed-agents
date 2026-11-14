import { forwardRef, type ReactNode } from "react";

import type { FieldControlProps } from "./Field";

import {
  Select as ShadcnSelect,
  SelectContent as ShadcnSelectContent,
  SelectGroup as ShadcnSelectGroup,
  SelectItem,
  SelectLabel as ShadcnSelectLabel,
  SelectSeparator as ShadcnSelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * Project-level convenience wrapper over the shadcn `Select` primitives.
 * Keeps a small controlled API (`value` / `onValueChange` / `placeholder` /
 * children) so the 3 call sites don't each have to assemble
 * Root + Trigger + Value + Content + Item + Portal + Scroll buttons.
 *
 * Native `<select>` is intentionally avoided because:
 *   1. It can't be styled to match the design tokens (bg/fg/border) on
 *      every platform — Safari/macOS in particular shows the system widget.
 *   2. No type-to-search inside large option lists.
 *   3. No accessible labelling for groups.
 *
 * Internals delegate to shadcn (which sits on Radix Select), so popover
 * styling / scroll buttons / chevron-down / focus ring stay aligned with
 * every other shadcn surface.
 */

interface SelectProps extends FieldControlProps {
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  /** When true, renders disabled. */
  disabled?: boolean;
  /** Optional name; emitted as the underlying form input. */
  name?: string;
  /** Override the trigger className. Default uses shadcn's full-width
   *  trigger so it fills its container. */
  className?: string;
  /** Accessible name when there is no visible label (inside <Field> the
   *  label names it). Falls back to the placeholder. */
  "aria-label"?: string;
  children: ReactNode;
}

/**
 * Inside <Field> it takes the field's `id`, label, hint and error on the
 * trigger, the element that takes focus:
 *
 *   <Field label="Applies to" hint="…" error={err}>
 *     <Select value={scope} onValueChange={setScope}>…</Select>
 *   </Field>
 */
export function Select({
  value,
  onValueChange,
  placeholder,
  disabled,
  name,
  className,
  id,
  "aria-label": ariaLabel,
  "aria-labelledby": labelledBy,
  "aria-describedby": describedBy,
  "aria-invalid": invalid,
  children,
}: SelectProps) {
  return (
    <ShadcnSelect
      value={value || undefined}
      onValueChange={onValueChange}
      disabled={disabled}
      name={name}
    >
      <SelectTrigger
        id={id}
        // A visible label wins; the placeholder names it only when nothing else does.
        aria-label={labelledBy ? undefined : (ariaLabel ?? placeholder)}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        // Override shadcn's default w-fit so the trigger fills the form
        // column it lives in (matches the previous TextInput look).
        className={className ?? "w-full"}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <ShadcnSelectContent>{children}</ShadcnSelectContent>
    </ShadcnSelect>
  );
}

interface SelectOptionProps {
  value: string;
  /** When true, the row is rendered but unselectable. */
  disabled?: boolean;
  children: ReactNode;
}

/**
 * One row inside a `<Select>`. Delegates to shadcn `SelectItem`; the
 * wrapper exists so call sites don't have to import both `Select` from
 * here and `SelectItem` from `@/components/ui/select` (mixed-source
 * imports were a common source of stale-prop bugs in the prior wrapper).
 */
export const SelectOption = forwardRef<HTMLDivElement, SelectOptionProps>(
  ({ value, disabled, children }, ref) => (
    <SelectItem ref={ref} value={value} disabled={disabled}>
      {children}
    </SelectItem>
  ),
);

SelectOption.displayName = "SelectOption";

/**
 * Optional non-interactive label inside the popover; useful when grouping
 * options (e.g. "Anthropic skills" / "Custom skills").
 */
export function SelectGroupLabel({ children }: { children: ReactNode }) {
  return <ShadcnSelectLabel>{children}</ShadcnSelectLabel>;
}

/**
 * Wraps a set of SelectOptions as an ARIA-labelled group. Pair with
 * `SelectGroupLabel` for visual + accessibility labelling.
 */
export function SelectGroup({ children }: { children: ReactNode }) {
  return <ShadcnSelectGroup>{children}</ShadcnSelectGroup>;
}

/**
 * Visual divider between groups. Renders a thin border line in the popover.
 */
export function SelectSeparator() {
  return <ShadcnSelectSeparator />;
}
