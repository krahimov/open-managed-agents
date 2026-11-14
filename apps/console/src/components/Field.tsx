import {
  Children,
  cloneElement,
  isValidElement,
  useId,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";

import { Label } from "@/components/ui/label";

interface FieldProps {
  /** Visible label text. Rendered as `<label htmlFor>`. */
  label?: ReactNode;
  /** Helper text below the input. Wired up via `aria-describedby` on the
   *  child so screen readers announce it after the input's name. */
  hint?: ReactNode;
  /** Visible inline error. When set, takes precedence over `hint` and
   *  the child gains `aria-invalid="true"`. */
  error?: ReactNode;
  /** Optional class on the wrapper. */
  className?: string;
  /** Single form control: input / textarea / select / Combobox / Select.
   *  The control is cloned with `id`, `aria-describedby`, and
   *  `aria-invalid` props so callers don't have to thread them. */
  children: ReactNode;
}

/**
 * The props <Field> hands its control. Every composed control (Select,
 * PickSelect, Combobox, LocalCombobox, EnvironmentPicker, DateField,
 * TimeField, SegmentedControl, SearchInput, Switch, Checkbox…) accepts them
 * and puts them on the element that takes focus, so the label names it,
 * a click on the label reaches it, and a hint or an error is read out with
 * it. A control that does not take them breaks the field: test it.
 */
export interface FieldControlProps {
  id?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}

const LABELABLE = new Set(["BUTTON", "INPUT", "METER", "OUTPUT", "PROGRESS", "SELECT", "TEXTAREA"]);
const FOCUSABLE =
  'input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A click on a label goes to its control, whatever the control is made of.
 *   - A control that opens a list (a select, a combobox, a picker button)
 *     takes the focus and stays closed, as a native <select>'s label does.
 *     Without this the browser "clicks" the button, which opens some
 *     lists and not others depending on how they were last opened.
 *   - A control that is not a labelable element (a radio group, a box of
 *     several inputs) gives the focus to its chosen radio or first input.
 *   - Anything else (an input, a checkbox, a switch) keeps the browser's
 *     own behaviour: focus, or toggle.
 */
export function onLabelClick(e: MouseEvent<HTMLLabelElement>) {
  const id = e.currentTarget.htmlFor;
  const el = id ? document.getElementById(id) : null;
  if (!el || el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true") return;
  if (el.tagName === "BUTTON" && (el.getAttribute("role") === "combobox" || el.hasAttribute("aria-haspopup"))) {
    e.preventDefault();
    el.focus();
    return;
  }
  if (LABELABLE.has(el.tagName)) return;
  e.preventDefault();
  const target =
    (el.getAttribute("role") === "radiogroup" &&
      el.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]:not([disabled])')) ||
    (el.tabIndex >= 0 ? el : el.querySelector<HTMLElement>(FOCUSABLE));
  target?.focus();
}

/**
 * Form-field wrapper that programmatically associates a label with its
 * input via `htmlFor`/`id`. Replaces the 6 in-file reimplementations
 * across console pages — most of which forgot the `htmlFor`/`id` pair
 * and silently shipped orphan labels (clicking the label didn't focus
 * the input; SR users couldn't pair them).
 *
 * Usage:
 *   <Field label="Workspace name" hint="Letters, numbers, dashes only.">
 *     <input value={name} onChange={...} className={inputCls} />
 *   </Field>
 *
 * The control is cloned with `id`, `aria-labelledby` (the label, unless
 * the caller named the control itself), `aria-describedby` (the hint or
 * error, added to any the control already had) and `aria-invalid`. The
 * child must be the control itself, or a component that takes
 * `FieldControlProps`: a wrapper such as react-hook-form's <Controller>
 * drops them, so put the <Field> inside its `render` instead.
 *
 * Visual layer leans on shadcn `Label`; everything else (cloneElement
 * threading, hint/error tone) stays here because shadcn doesn't ship
 * an auto-binding form wrapper at this granularity.
 */
export function Field({ label, hint, error, className, children }: FieldProps) {
  const generatedId = useId();
  const child = Children.only(children) as ReactElement<
    FieldControlProps & { "aria-label"?: string }
  >;

  const inputId = (isValidElement(child) && child.props.id) || generatedId;
  const hintId = hint || error ? `${inputId}-hint` : undefined;
  const labelId = label ? `${inputId}-label` : undefined;

  const childWithProps = isValidElement(child)
    ? cloneElement(child, {
        id: inputId,
        "aria-labelledby":
          child.props["aria-labelledby"] ?? (child.props["aria-label"] ? undefined : labelId),
        "aria-describedby":
          [hintId, child.props["aria-describedby"]].filter(Boolean).join(" ") || undefined,
        "aria-invalid": error ? true : child.props["aria-invalid"],
      })
    : child;

  if (!label && !hint && !error) return <>{childWithProps}</>;

  return (
    <div className={className}>
      {label && (
        <Label
          id={labelId}
          htmlFor={inputId}
          onClick={onLabelClick}
          className="mb-1.5 block text-small leading-5 font-medium text-fg"
        >
          {label}
        </Label>
      )}
      {childWithProps}
      {error ? (
        <p id={hintId} role="alert" className="mt-1.5 text-xs text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="mt-1.5 text-xs text-fg-subtle">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
