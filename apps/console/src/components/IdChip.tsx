import { CheckIcon, CopyIcon } from "lucide-react";

import { useCopy } from "@/lib/clipboard";
import { shortenId } from "@/lib/format";
import { cn } from "@/lib/utils";

import { Tip } from "./Tip";

/**
 * Ids are for machines. They never lead a row or a header; they appear
 * once per record as a quiet, copyable chip (in the detail header's meta
 * line or a property row), or behind a tooltip.
 *
 *   <IdChip id={agent.id} />              agent-rrtc…3d0  [copy]
 *   <IdChip id={session.id} full />       the whole id
 *   <CopyButton value={url} label="Copy link" />
 */
export function IdChip({
  id,
  full,
  label = "Copy id",
  className,
}: {
  id: string;
  /** Show the whole id instead of the shortened form. */
  full?: boolean;
  /** Tooltip / accessible name of the copy action. */
  label?: string;
  className?: string;
}) {
  const { copied, copy } = useCopy();
  return (
    <Tip label={copied ? "Copied" : full ? label : `${label} · ${id}`}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          void copy(id);
        }}
        aria-label={`${label}: ${id}`}
        className={cn(
          "group/id inline-flex h-[22px] max-w-full items-center gap-1 rounded-full bg-bg-soft pr-1.5 pl-2 font-mono text-micro-size leading-none text-fg-muted transition-quick hover:bg-bg-pressed hover:text-fg",
          className,
        )}
      >
        <span className="truncate">{full ? id : shortenId(id)}</span>
        {copied ? (
          <CheckIcon className="size-3 shrink-0 text-success" />
        ) : (
          <CopyIcon className="size-3 shrink-0 opacity-50 transition-opacity group-hover/id:opacity-100" />
        )}
      </button>
    </Tip>
  );
}

/** Icon-only copy button for any value (a URL, a snippet, a key). */
export function CopyButton({
  value,
  label = "Copy",
  size = "sm",
  className,
}: {
  value: string;
  label?: string;
  size?: "sm" | "md";
  className?: string;
}) {
  const { copied, copy } = useCopy();
  return (
    <Tip label={copied ? "Copied" : label}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          void copy(value);
        }}
        aria-label={label}
        className={cn(
          "inline-flex shrink-0 items-center justify-center rounded-full text-fg-subtle transition-quick hover:bg-bg-hover hover:text-fg",
          size === "sm" ? "size-7" : "size-8",
          className,
        )}
      >
        {copied ? <CheckIcon className="size-3.5 text-success" /> : <CopyIcon className="size-3.5" />}
      </button>
    </Tip>
  );
}
