import { useState, type ComponentProps, type ReactNode, type Ref } from "react";
import { EyeIcon, EyeOffIcon, MoonIcon, SunIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BRAND_DOCS_URL, BRAND_NAME, BRAND_TAGLINE } from "@/lib/brand";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { inlineLink, linkHitArea } from "@/lib/links";

import { Logo } from "../../components/Logo";
import { Tip } from "../../components/Tip";
import { Wash } from "../../components/Wash";

/**
 * The frame of the pages a person sees before they are in the console:
 * sign-in, sign-up, password reset and CLI authorisation. There is no app
 * shell here, so the frame supplies the canvas, the brand wash (one of its
 * four allowed places), the mark, a headline and a card for the form.
 *
 *   <AuthShell title="Welcome back" subtitle="Sign in to run and supervise your agents."
 *              below={<>New here? <AuthLink onClick={…}>Create an account</AuthLink></>}>
 *     …fields…
 *   </AuthShell>
 *
 * `children` is the card's content. Pass `bare` to render children without
 * the card (a full-page wait). `contentKey` re-runs the enter motion when
 * the page moves to another step.
 */
export function AuthShell({
  title,
  subtitle,
  children,
  below,
  bare,
  contentKey,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  /** A plain line under the card: the way to the other mode. */
  below?: ReactNode;
  bare?: boolean;
  contentKey?: string;
}) {
  const { effective, setTheme } = useTheme();
  const dark = effective === "dark";
  return (
    <div className="relative flex min-h-screen flex-col bg-bg">
      <Wash inline className="h-[min(64vh,600px)]" />

      <div className="absolute top-4 right-4">
        <Tip label={dark ? "Switch to light" : "Switch to dark"} side="left">
          <Button
            variant="ghost"
            size="icon"
            aria-label={dark ? "Switch to the light theme" : "Switch to the dark theme"}
            onClick={() => setTheme(dark ? "light" : "dark")}
          >
            {dark ? <SunIcon /> : <MoonIcon />}
          </Button>
        </Tip>
      </div>

      <main className="relative flex flex-1 flex-col items-center px-5 pt-[clamp(3rem,9vh,6rem)] pb-10">
        <div key={contentKey} className="flex w-full flex-col items-center">
          <Logo size="xl" className="animate-fade-in" />
          {title && (
            <h1 className="mt-7 max-w-[34rem] animate-rise-in text-center text-display text-balance text-fg">{title}</h1>
          )}
          {subtitle && (
            <p
              style={{ "--i": 1 } as React.CSSProperties}
              className="stagger mt-3 max-w-[30rem] animate-rise-in text-center text-[0.9375rem] leading-relaxed text-balance text-fg-muted"
            >
              {subtitle}
            </p>
          )}

          {bare ? (
            <div className="mt-8">{children}</div>
          ) : (
            <div
              style={{ "--i": 2 } as React.CSSProperties}
              className="stagger surface mt-9 w-full max-w-[400px] animate-rise-in rounded-3xl p-6 shadow-[var(--shadow-md)] sm:p-8"
            >
              {children}
            </div>
          )}

          {below && (
            <p
              style={{ "--i": 3 } as React.CSSProperties}
              className="stagger mt-6 animate-rise-in text-center text-small text-fg-muted"
            >
              {below}
            </p>
          )}
        </div>
      </main>

      <footer className="relative flex flex-wrap items-center justify-center gap-x-2 gap-y-1 px-5 pb-6 text-xs text-fg-subtle">
        <span>
          {BRAND_NAME} · {BRAND_TAGLINE}
        </span>
        <span aria-hidden="true">·</span>
        <a
          href={BRAND_DOCS_URL}
          target="_blank"
          rel="noreferrer"
          className={cn("rounded-sm font-medium text-fg-muted underline-offset-3 transition-quick hover:text-fg hover:underline", linkHitArea)}
        >
          Docs
        </a>
      </footer>
    </div>
  );
}

/** An inline text action in the auth pages ("Create an account"). */
export function AuthLink({ className, ...props }: ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn(
        inlineLink,
        "disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

/** Hairline, a word, hairline: between sign-in methods. */
export function AuthDivider({ children = "or" }: { children?: ReactNode }) {
  return (
    <div className="flex items-center gap-3" role="separator">
      <div className="h-px flex-1 bg-border" />
      <span className="text-xs text-fg-subtle">{children}</span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

/**
 * A password field for real credentials: unlike <SecretInput> it lets the
 * browser and password managers fill and save (pass `autoComplete`), and
 * it has the same show/hide eye.
 */
export function PasswordInput({ className, ...props }: Omit<ComponentProps<"input">, "type">) {
  const [revealed, setRevealed] = useState(false);
  return (
    <div className="relative">
      <Input type={revealed ? "text" : "password"} className={cn("h-10 pr-11", className)} {...props} />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={() => setRevealed((r) => !r)}
        className="absolute inset-y-0 right-1 my-auto text-fg-subtle hover:text-fg"
        aria-label={revealed ? "Hide password" : "Show password"}
        aria-pressed={revealed}
      >
        {revealed ? <EyeOffIcon /> : <EyeIcon />}
      </Button>
    </div>
  );
}

/**
 * A six-digit code as six boxes. It is one real text input stretched over
 * the boxes, so typing, paste, autofill from SMS/mail (`one-time-code`)
 * and screen readers all behave like a plain field; the boxes only draw
 * what it holds.
 */
export function OtpInput({
  value,
  onChange,
  length = 6,
  inputRef,
  ...props
}: Omit<ComponentProps<"input">, "value" | "onChange" | "type" | "maxLength" | "ref"> & {
  value: string;
  onChange: (value: string) => void;
  length?: number;
  inputRef?: Ref<HTMLInputElement>;
}) {
  const [focused, setFocused] = useState(false);
  const active = Math.min(value.length, length - 1);
  const invalid = props["aria-invalid"] === true || props["aria-invalid"] === "true";
  return (
    <div className="relative">
      <div aria-hidden="true" className="grid gap-2" style={{ gridTemplateColumns: `repeat(${length}, minmax(0, 1fr))` }}>
        {Array.from({ length }).map((_, i) => {
          const char = value[i];
          const current = focused && i === active;
          return (
            <div
              key={i}
              className={cn(
                "flex h-[52px] items-center justify-center rounded-md border bg-bg-surface font-mono text-[1.375rem] leading-none text-fg shadow-[var(--shadow-xs)] transition-quick dark:bg-bg-soft",
                current
                  ? "border-plum shadow-[var(--shadow-focus)]"
                  : invalid
                    ? "border-danger"
                    : char
                      ? "border-fg-faint"
                      : "border-border-strong",
              )}
            >
              {char ?? (current ? <span className="h-6 w-px bg-plum" /> : null)}
            </div>
          );
        })}
      </div>
      {/* After the boxes in DOM order, so it sits on top without a z-index. */}
      <input
        ref={inputRef}
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        autoComplete="one-time-code"
        maxLength={length}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, length))}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        className="absolute inset-0 h-full w-full cursor-text rounded-md bg-transparent text-transparent caret-transparent outline-none selection:bg-transparent"
        {...props}
      />
    </div>
  );
}
