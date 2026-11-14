import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const TRUNCATING = '[data-truncate], .truncate, [class*="line-clamp-"]';

/**
 * A tooltip that only appears while its child is actually cut off.
 *
 *   <OverflowTip label={title}>
 *     <a className="truncate" …>{title}</a>
 *   </OverflowTip>
 *
 * Text that fits says nothing twice; text that is cut (an ellipsis, a
 * clamped line) can be read in full on hover and on keyboard focus. The
 * child must be a single element that takes a ref. The text that is cut
 * may be the child or anything inside it that uses `truncate` or
 * `line-clamp-*` (or is marked `data-truncate`).
 *
 * A value that is not focusable on its own (a plain span in a cell) takes
 * `focusable`: while it is cut it gets a tab stop, so the full text can be
 * reached without a pointer. Text that fits gets none.
 */
export function OverflowTip({
  label,
  children,
  side = "top",
  align = "start",
  focusable,
}: {
  /** The full value. Empty: no tooltip at all. */
  label: ReactNode;
  children: ReactElement;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  /** Give a non-interactive child a tab stop while it is cut off. */
  focusable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [cut, setCut] = useState(false);
  const ref = useRef<HTMLElement | null>(null);

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return false;
    // The child itself, and anything inside it that truncates or clamps.
    const candidates = [el, ...Array.from(el.querySelectorAll<HTMLElement>(TRUNCATING))];
    const isCut = candidates.some((t) => t.scrollWidth > t.clientWidth + 1 || t.scrollHeight > t.clientHeight + 1);
    setCut((cur) => (cur === isCut ? cur : isCut));
    return isCut;
  }, []);

  // A tab stop has to exist before anyone hovers, so a focusable value is
  // measured as it is laid out and again whenever its box changes.
  useEffect(() => {
    if (!focusable) return;
    const el = ref.current;
    if (!el) return;
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const obs = new ResizeObserver(() => measure());
    obs.observe(el);
    return () => obs.disconnect();
  }, [focusable, measure, label]);

  if (label == null || label === "" || label === false) return children;

  return (
    <Tooltip open={open} onOpenChange={(next) => setOpen(next && measure())}>
      <TooltipTrigger asChild ref={ref as never} {...(focusable && cut ? { tabIndex: 0 } : {})}>
        {children}
      </TooltipTrigger>
      <TooltipContent side={side} align={align} className="max-w-sm break-words whitespace-pre-line">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
