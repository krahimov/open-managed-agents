import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Keyboard hint. One <Kbd> per key: <Kbd>⌘</Kbd><Kbd>K</Kbd>, or pass
 * `keys` to render a sequence with the right gap.
 *
 *   <Kbd keys={["⌘", "K"]} />      a chord, keys pressed together
 *   <Kbd keys={["G", "A"]} then />  a sequence, "G then A"
 *
 * `tone="onInk"` is for hints sitting on an ink surface (tooltips, the
 * primary button).
 */
export function Kbd({
  children,
  keys,
  then,
  tone = "default",
  className,
}: {
  children?: ReactNode;
  keys?: string[];
  /** Render "then" between keys (a sequence rather than a chord). */
  then?: boolean;
  tone?: "default" | "onInk";
  className?: string;
}) {
  const keyCls = cn(
    "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-xs px-1 font-sans text-micro-size leading-none font-medium",
    tone === "default"
      ? "border border-border bg-bg-soft text-fg-subtle"
      : "bg-white/15 text-current dark:bg-black/10",
  );
  if (keys) {
    return (
      <span data-slot="kbd" className={cn("inline-flex items-center gap-0.5", className)}>
        {keys.map((k, i) => (
          <span key={i} className="inline-flex items-center gap-0.5">
            {/* On ink (a tooltip) the word takes the tooltip's own colour: the caption grey is unreadable there. */}
            {then && i > 0 && (
              <span className={cn("px-0.5 text-[0.625rem]", tone === "onInk" ? "text-current opacity-70" : "text-fg-subtle")}>then</span>
            )}
            {/* Symbol keys (⌘ ⇧ ↵) come from a fallback face that runs small. */}
            <kbd className={cn(keyCls, /^[^\w]$/.test(k) && "text-small-size")}>{k}</kbd>
          </span>
        ))}
      </span>
    );
  }
  return (
    <kbd data-slot="kbd" className={cn(keyCls, className)}>
      {children}
    </kbd>
  );
}
