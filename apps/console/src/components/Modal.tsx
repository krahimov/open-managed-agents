import { useCallback, useEffect, useRef, useState, type JSX, type ReactNode } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

// Tailwind JIT safelist hint — these literal `!max-w-*` strings exist
// here so the bundler picks them up; the Modal component picks one of
// them at runtime via `${"!"}${maxWidth}`. shadcn's <DialogContent>
// bakes `sm:max-w-sm` (24rem) into its base className which would
// otherwise cap every modal at 384 px on desktop; the `!` prefix lifts
// our chosen width over it. Add new entries here if a caller starts
// passing a wider value.
//
// !max-w-sm !max-w-md !max-w-lg !max-w-xl !max-w-2xl !max-w-3xl !max-w-4xl

/**
 * Project-level modal convention built on shadcn `Dialog` primitives.
 * Keeps a small controlled API (open/onClose/title/subtitle/maxWidth/
 * children/footer) because the same modal pattern recurs across 18+
 * call sites and each direct `<Dialog>…<DialogContent><DialogHeader>…`
 * expansion would add the same boilerplate. Internals delegate to
 * shadcn so theming, close button (lucide X via DialogContent's
 * showCloseButton default), focus trap, and animations stay aligned
 * with the rest of the design system.
 *
 * Footer is rendered into `DialogFooter` only when provided so unused
 * modals don't get an empty bordered band at the bottom.
 *
 * The children block is wrapped in a scroll container so long forms
 * stay reachable when content exceeds the modal's max height. shadcn's
 * `DialogContent` doesn't auto-scroll; pulling it out of the dialog
 * shell keeps the header sticky and the footer pinned.
 */
interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  /** Tailwind max-width class WITHOUT the `!` prefix (e.g. `max-w-lg`,
   *  `max-w-2xl`). Modal applies `!important` internally to beat
   *  shadcn's baked-in `sm:max-w-sm` cap. Default: `max-w-lg`. */
  maxWidth?: string;
  /** `top` pins the dialog near the top of the window instead of centring
   *  it, for a dialog that opens something beneath itself (the session
   *  starter's Options) and so needs the room below. Default: `center`. */
  placement?: "center" | "top";
  children: ReactNode;
  footer?: ReactNode;
}

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  maxWidth = "max-w-lg",
  placement = "center",
  children,
  footer,
}: ModalProps): JSX.Element {
  // Strip a stray `!` prefix from caller for back-compat, then apply
  // our own — guarantees exactly one `!` is present in the final class.
  const widthClass = `!${maxWidth.replace(/^!/, "")}`;
  const edges = useScrollEdges(open);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        className={cn(
          "flex flex-col gap-0 overflow-hidden p-0",
          placement === "top"
            ? // Pinned near the top, it may grow to a small margin above the window's bottom.
              "top-[clamp(1.5rem,9vh,6rem)] max-h-[min(calc(100dvh-clamp(1.5rem,9vh,6rem)-1.5rem),880px)] translate-y-0"
            : "max-h-[min(86vh,880px)]",
          widthClass,
        )}
      >
        <DialogHeader className="gap-1 px-6 pt-5 pb-4 pr-14">
          <DialogTitle className="truncate">{title}</DialogTitle>
          {subtitle && <DialogDescription>{subtitle}</DialogDescription>}
        </DialogHeader>

        {/* When the body scrolls, its edges say so: a hairline under the
            header once something has gone up under it, and a soft fade at
            the bottom while more is below, so a cut line reads as "more",
            never as text clipped by mistake. */}
        <div
          ref={edges.ref}
          onScroll={edges.update}
          className={cn(
            "min-h-0 flex-1 overflow-y-auto border-t border-transparent px-6 pt-1 pb-6 transition-[border-color] duration-[var(--dur-quick)]",
            edges.above && "border-border",
            edges.below && "[mask-image:linear-gradient(to_bottom,black_calc(100%-2.5rem),transparent)]",
          )}
        >
          {children}
        </div>

        {footer && (
          <DialogFooter className="m-0 gap-2 rounded-none border-t border-border bg-bg-inset/60 px-6 py-4 sm:justify-end">
            {footer}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Whether a scroll box has content above or below what it shows. */
function useScrollEdges(open: boolean) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState({ above: false, below: false });
  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const above = el.scrollTop > 1;
    const below = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
    setState((cur) => (cur.above === above && cur.below === below ? cur : { above, below }));
  }, []);
  useEffect(() => {
    if (!open) return;
    // The dialog's content mounts a frame after `open`; watch the box and what it holds.
    let ro: ResizeObserver | undefined;
    const frame = requestAnimationFrame(() => {
      const el = ref.current;
      if (!el || typeof ResizeObserver === "undefined") return;
      ro = new ResizeObserver(update);
      ro.observe(el);
      for (const child of Array.from(el.children)) ro.observe(child);
      update();
    });
    return () => {
      cancelAnimationFrame(frame);
      ro?.disconnect();
    };
  }, [open, update]);
  return { ref, update, ...state };
}
