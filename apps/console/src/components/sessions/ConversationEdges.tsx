import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { ArrowDownIcon } from "lucide-react";
import { useStickToBottomContext } from "use-stick-to-bottom";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { Tip } from "../Tip";

/**
 * The conversation's two edges. Render it inside <Conversation>.
 *
 * 1. Under the session bar. A line of text passing under the bar is never
 *    sliced by its rule: the scroller is MASKED, so what is in it is fully
 *    transparent for a whole line's height below the hairline, then fades
 *    in. A line the edge cuts through is therefore never seen in part.
 *    (An overlay gradient in the page colour could not do this: half-way
 *    down it still let half a line show through.) The fade grows with the
 *    scroll position, so at the very top, where nothing passes under,
 *    there is none.
 * 2. Above the composer. The same fade, and a band of its own for "Jump to
 *    latest". While the reader is away from the newest message, the last
 *    BAND pixels of the scroller are masked out entirely and the button
 *    sits there: it can never lie on top of a line or a control, because
 *    nothing is drawn where it is. The band opens as the reader scrolls
 *    away and closes as they return, so nothing jumps.
 * 3. Staying on the latest message when the room changes. The library
 *    follows new content; it does not follow the box getting shorter (the
 *    composer grew a line, a notice appeared above it), which left the last
 *    reply half under the composer.
 *
 * A mask is drawn by the compositor and is the same in both themes: it
 * hides the content itself, whatever colour is behind it.
 */

/**
 * Under the bar, the first CLEAR pixels show nothing at all. It is a line of
 * prose tall (15.5px at 1.65), so a line the edge cuts through is wholly
 * inside it: what is seen below is only whole lines, fading in.
 */
const TOP_CLEAR = 28;
/** Where the fade under the bar ends and the conversation is fully itself. */
const TOP_FADE = 60;
/** The fade is at full strength once the reader has scrolled this far (before any line can reach the edge). */
const TOP_RAMP = 16;
/** The band above the composer that belongs to the jump button. */
const BAND = 52;
/** The fade above that band (or above the composer, when there is no band). */
const BOTTOM_FADE = 28;

export function maskFor(scrollTop: number, fromBottom: number): string {
  const strength = Math.min(Math.max(scrollTop, 0) / TOP_RAMP, 1);
  const clearTop = TOP_CLEAR * strength;
  const top = TOP_FADE * strength;
  const band = Math.min(Math.max(fromBottom, 0), BAND);
  const fade = Math.min(Math.max(fromBottom, 0), BOTTOM_FADE);
  // An eased ramp, not a straight one: almost nothing for the first part,
  // so what enters from under the bar arrives as a whole line.
  return [
    "linear-gradient(to bottom",
    "transparent 0",
    `transparent ${clearTop.toFixed(1)}px`,
    `rgb(0 0 0 / 0.12) ${(clearTop + (top - clearTop) * 0.35).toFixed(1)}px`,
    `rgb(0 0 0 / 0.6) ${(clearTop + (top - clearTop) * 0.7).toFixed(1)}px`,
    `#000 ${top.toFixed(1)}px`,
    `#000 calc(100% - ${(band + fade).toFixed(1)}px)`,
    `rgb(0 0 0 / 0.45) calc(100% - ${(band + fade * 0.4).toFixed(1)}px)`,
    `transparent calc(100% - ${band.toFixed(1)}px)`,
    "transparent 100%)",
  ].join(", ");
}

export function ConversationEdges() {
  const { scrollRef, scrollToBottom, isAtBottom } = useStickToBottomContext();
  const atBottom = useRef(isAtBottom);
  atBottom.current = isAtBottom;

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let frame = 0;
    const paint = () => {
      frame = 0;
      const mask = maskFor(el.scrollTop, el.scrollHeight - el.scrollTop - el.clientHeight);
      el.style.setProperty("-webkit-mask-image", mask);
      el.style.setProperty("mask-image", mask);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(paint);
    };
    paint();
    el.addEventListener("scroll", onScroll, { passive: true });
    let height = el.clientHeight;
    const ro =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(() => {
            const next = el.clientHeight;
            if (next !== height) {
              height = next;
              if (atBottom.current) void scrollToBottom("instant");
            }
            onScroll();
          })
        : null;
    ro?.observe(el);
    // New content changes how far the reader is from the end without a scroll event.
    if (el.firstElementChild) ro?.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro?.disconnect();
      if (frame) cancelAnimationFrame(frame);
      el.style.removeProperty("-webkit-mask-image");
      el.style.removeProperty("mask-image");
    };
  }, [scrollRef, scrollToBottom]);

  return null;
}

/**
 * "Jump to latest", in the band ConversationEdges keeps clear for it above
 * the composer. Shown the moment the reader scrolls away from the newest
 * message. Render it inside <Conversation>, after <ConversationEdges>.
 */
export function JumpToLatest({ className }: { className?: string }) {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  if (isAtBottom) return null;
  return (
    <div className={cn("pointer-events-none absolute inset-x-0 bottom-0 flex justify-center", className)} style={{ height: BAND }}>
      <Tip label="Jump to latest">
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          aria-label="Jump to latest"
          onClick={() => void scrollToBottom()}
          className="pointer-events-auto mt-2.5 animate-pop-in rounded-full shadow-[var(--shadow-md)]"
        >
          <ArrowDownIcon className="size-4" />
        </Button>
      </Tip>
    </div>
  );
}

/** What the page can ask of the conversation's scroller from outside it. */
export interface ConversationHandle {
  /** Bring an element of the conversation to the middle of the view, and stay there. */
  reveal: (el: HTMLElement) => void;
}

/**
 * A handle on the scroller for the page around it. The scroller keeps
 * itself on the latest message while content is still arriving; `reveal`
 * tells it the reader has gone somewhere on purpose first, so it does not
 * pull them back. Render it inside <Conversation>.
 */
export const ConversationControl = forwardRef<ConversationHandle>(function ConversationControl(_, ref) {
  const { stopScroll } = useStickToBottomContext();
  useImperativeHandle(
    ref,
    () => ({
      reveal(el) {
        stopScroll();
        el.scrollIntoView({ block: "center", behavior: "smooth" });
      },
    }),
    [stopScroll],
  );
  return null;
});
