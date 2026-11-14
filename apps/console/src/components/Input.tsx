import { useState, type InputHTMLAttributes, type ReactNode } from "react";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { EyeIcon, EyeOffIcon } from "lucide-react";

import { Field } from "./Field";

type CommonProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type" | "className"
> & {
  className?: string;
  /** Wrap with a labelled <div> if provided. Saves callsites the
   *  boilerplate of label + helper-text composition. The label is
   *  programmatically associated with the input via `htmlFor`/`id` so
   *  screen readers announce them as a pair and clicking the label
   *  focuses the input. */
  label?: ReactNode;
  hint?: ReactNode;
};

// Mobile touch target. shadcn's <Input> defaults to h-8 (~32px) which is
// below iOS HIG / WCAG 2.5.5 — bump the minimum on small viewports and
// fall back to shadcn's intrinsic height on sm+ so dense forms don't
// grow on desktop.
const TOUCH_TARGET = "max-sm:min-h-11";

/**
 * Plain text input. Defaults `autoComplete="off"` to prevent the browser
 * from offering saved credentials in non-login contexts (persona names,
 * agent ids, paths…). Add a specific `autoComplete` token (e.g. "email"
 * or "username") at the call site if a real autofill is wanted.
 *
 * Built on shadcn `Input`; the 1Password / LastPass opt-out attrs +
 * touch-target sizing live here so every caller gets them automatically.
 */
export function TextInput({
  className,
  label,
  hint,
  autoComplete,
  ...rest
}: CommonProps) {
  const input = (
    <Input
      type="text"
      autoComplete={autoComplete ?? "off"}
      data-1p-ignore
      data-lpignore="true"
      className={[TOUCH_TARGET, className].filter(Boolean).join(" ")}
      {...rest}
    />
  );
  if (!label && !hint) return input;
  return (
    <Field label={label} hint={hint}>
      {input}
    </Field>
  );
}

/**
 * Secret input — for API keys, tokens, signing secrets, client secrets,
 * webhook secrets, anything sensitive. Renders masked by default with a
 * right-side eye toggle so the user can verify the paste landed in the
 * right field (Stripe / Vercel / GitHub PAT pattern). Always sets
 * `autoComplete="new-password"` (the only reliable way to disable
 * Chrome's saved-password autofill — `off` is ignored on type=password)
 * plus 1Password / LastPass opt-out attrs.
 *
 * Use this in any "paste a credential" UI — never `<input type="password">`
 * directly, otherwise the browser autofills the user's iCloud/Google
 * password into a place it doesn't belong, AND the user has to paste
 * blind into a row of dot-fields.
 *
 * Type: what is typed is a token, so it is set in mono (masked or shown);
 * the placeholder is a label or a hint ("Composio API key", "Starts with
 * lin_wh_"), so it stays in the UI face. Callers do not set either.
 */
export function SecretInput({ label, hint, ...rest }: CommonProps) {
  // The box (input + eye) is its own component so that <Field> hands its
  // id, label and hint to it and it puts them on the <input>: cloned onto
  // a wrapping <div>, the label pointed at the div and named nothing.
  const input = <SecretBox {...rest} />;
  if (!label && !hint) return input;
  return (
    <Field label={label} hint={hint}>
      {input}
    </Field>
  );
}

function SecretBox({ className, ...rest }: Omit<CommonProps, "label" | "hint">) {
  const [revealed, setRevealed] = useState(false);
  return (
    <div className="relative">
      <Input
        type={revealed ? "text" : "password"}
        autoComplete="new-password"
        data-1p-ignore
        data-lpignore="true"
        className={[TOUCH_TARGET, "pr-10 font-mono placeholder:font-sans", className].filter(Boolean).join(" ")}
        {...rest}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={() => setRevealed((r) => !r)}
        className="absolute inset-y-0 right-1 my-auto size-7 text-fg-subtle hover:text-fg"
        title={revealed ? "Hide" : "Show"}
        aria-label={revealed ? "Hide secret" : "Show secret"}
      >
        {revealed ? <EyeOffIcon /> : <EyeIcon />}
      </Button>
    </div>
  );
}
