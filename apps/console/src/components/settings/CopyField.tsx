import { useState, type ReactNode } from "react";
import { CheckIcon, CopyIcon, EyeIcon, EyeOffIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useCopy } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

import { CopyButton } from "../IdChip";
import { Tip } from "../Tip";

/**
 * Values a person has to carry somewhere else: a callback URL to paste into
 * another product, a shell command to run, a secret that is shown once.
 * Settings, integrations and the connect flows all use these three blocks,
 * so "copy this" looks and behaves the same everywhere. Feedback is inline
 * (the icon turns into a check), never a toast.
 *
 *   <CopyList>
 *     <CopyRow label="Redirect URL" value={form.callbackUrl} />
 *     <CopyRow label="Events request URL" value={form.webhookUrl} />
 *   </CopyList>
 *
 *   <CommandLine command="npx @openma/cli@beta bridge setup" />
 *
 *   <SecretOnce label="API key" value={createdKey} />
 */

/** A well that stacks <CopyRow>s with hairlines between them. */
export function CopyList({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <dl className={cn("divide-y divide-border overflow-hidden rounded-lg border border-border bg-bg-inset", className)}>
      {children}
    </dl>
  );
}

/**
 * One labelled, read-only value with a copy button. The value is mono and
 * truncates in the middle of the row; the full text is in the tooltip and
 * on the clipboard. `secret` masks it behind a reveal toggle.
 */
export function CopyRow({
  label,
  value,
  secret,
  hint,
}: {
  label: string;
  value: string;
  /** Mask the value until the person asks to see it. */
  secret?: boolean;
  /** One quiet line under the value: where it goes. */
  hint?: ReactNode;
}) {
  const [revealed, setRevealed] = useState(!secret);
  const shown = revealed ? value : "•".repeat(Math.min(Math.max(value.length, 12), 32));
  return (
    <div className="flex min-h-11 items-center gap-3 py-1.5 pr-1.5 pl-3.5">
      <dt className="w-32 shrink-0 text-xs font-medium text-fg-subtle sm:w-40">{label}</dt>
      <dd className="min-w-0 flex-1">
        <code className="block truncate font-mono text-xs text-fg select-all" title={revealed ? value : undefined}>
          {shown}
        </code>
        {hint && <p className="mt-0.5 truncate text-xs text-fg-subtle">{hint}</p>}
      </dd>
      <div className="flex shrink-0 items-center">
        {secret && (
          <Tip label={revealed ? "Hide" : "Show"}>
            <button
              type="button"
              onClick={() => setRevealed((r) => !r)}
              aria-label={revealed ? `Hide ${label}` : `Show ${label}`}
              className="inline-flex size-8 items-center justify-center rounded-full text-fg-subtle transition-quick hover:bg-bg-hover hover:text-fg"
            >
              {revealed ? <EyeOffIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
            </button>
          </Tip>
        )}
        <CopyButton value={value} label={`Copy ${label.toLowerCase()}`} size="md" />
      </div>
    </div>
  );
}

/**
 * A shell command to run somewhere else: mono, with a prompt glyph and a
 * copy button. One line that scrolls sideways by default; `wrap` lets a
 * long command break onto more lines when all of it has to be readable.
 */
export function CommandLine({
  command,
  label = "Copy command",
  wrap,
  className,
}: {
  command: string;
  /** Accessible name of the copy button. */
  label?: string;
  /** Wrap instead of scrolling sideways. */
  wrap?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-h-11 gap-2.5 rounded-lg border border-border bg-bg-inset py-1.5 pr-1.5 pl-3.5",
        wrap ? "items-start" : "items-center",
        className,
      )}
    >
      <span aria-hidden="true" className={cn("font-mono text-small-size text-fg-faint select-none", wrap && "pt-1.5")}>
        $
      </span>
      <code
        className={cn(
          "min-w-0 flex-1 font-mono text-small-size text-fg select-all",
          wrap ? "py-1.5 leading-relaxed break-words whitespace-pre-wrap" : "no-scrollbar overflow-x-auto whitespace-nowrap",
        )}
      >
        {command}
      </code>
      <CopyButton value={command} label={label} size="md" />
    </div>
  );
}

/**
 * A secret that is shown exactly once (a new API key). The whole value is
 * visible and selectable, and the copy action is a labelled button rather
 * than an icon: this is the one thing the person must do before leaving.
 */
export function SecretOnce({
  label,
  value,
  copyLabel = "Copy key",
  className,
}: {
  label: string;
  value: string;
  copyLabel?: string;
  className?: string;
}) {
  const { copied, copy } = useCopy(2400);
  return (
    <div className={cn("rounded-lg border border-border bg-bg-inset p-3.5", className)}>
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-medium text-fg-subtle">{label}</p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void copy(value)}
          aria-label={copied ? "Copied" : copyLabel}
        >
          {copied ? (
            <CheckIcon data-icon="inline-start" className="text-success" />
          ) : (
            <CopyIcon data-icon="inline-start" />
          )}
          {copied ? "Copied" : copyLabel}
        </Button>
      </div>
      <code className="mt-2 block font-mono text-small leading-relaxed break-all text-fg select-all">{value}</code>
    </div>
  );
}
