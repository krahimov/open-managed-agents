import { useEffect, useRef, useState, type ComponentProps, type Ref } from "react";

import { cn } from "@/lib/utils";

/**
 * A scrolling region whose content fades out at an edge that has more
 * behind it, instead of being cut by a hard line. The fade is a mask on
 * the content, so it works on any surface in both themes, and it is only
 * drawn on a side that can actually be scrolled toward.
 *
 *   <ScrollFade className="max-h-64 px-4">…</ScrollFade>
 */
export function ScrollFade({
  className,
  children,
  fade = 28,
  ref,
  ...props
}: ComponentProps<"div"> & {
  /** Height of the fade, in px. */
  fade?: number;
  ref?: Ref<HTMLDivElement>;
}) {
  const outer = useRef<HTMLDivElement | null>(null);
  const inner = useRef<HTMLDivElement | null>(null);
  const [edges, setEdges] = useState({ top: false, bottom: false });

  useEffect(() => {
    const el = outer.current;
    if (!el) return;
    const read = () => {
      const top = el.scrollTop > 1;
      const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
      setEdges((prev) => (prev.top === top && prev.bottom === bottom ? prev : { top, bottom }));
    };
    read();
    el.addEventListener("scroll", read, { passive: true });
    // Content that grows or shrinks (a search narrowing the list) and a
    // container that resizes both change what is hidden.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(read);
    observer?.observe(el);
    if (inner.current) observer?.observe(inner.current);
    return () => {
      el.removeEventListener("scroll", read);
      observer?.disconnect();
    };
  }, []);

  const mask = `linear-gradient(to bottom, ${edges.top ? "transparent" : "#000"} 0, #000 ${fade}px, #000 calc(100% - ${fade}px), ${edges.bottom ? "transparent" : "#000"} 100%)`;

  return (
    <div
      {...props}
      ref={(node) => {
        outer.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
      }}
      data-scroll-top={edges.top || undefined}
      data-scroll-bottom={edges.bottom || undefined}
      style={{ ...props.style, maskImage: mask, WebkitMaskImage: mask }}
      className={cn("overflow-y-auto", className)}
    >
      <div ref={inner}>{children}</div>
    </div>
  );
}
