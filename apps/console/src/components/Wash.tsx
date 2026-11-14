import { createPortal } from "react-dom";
import { useOutletContext } from "react-router";

import { cn } from "@/lib/utils";

import type { AppOutletContext } from "./AppShell";

/**
 * The signature wash: a very soft peach → rose → lilac gradient that fades
 * out downward. It is the brand's one decorative gesture, so it is
 * rationed. Allowed in exactly these places:
 *
 *   - Home, behind the greeting and composer          <Wash />
 *   - Login / CLI login / connect pages                <Wash fixed />
 *   - an agent's profile header                        <Wash variant="header" />
 *   - page-level empty states (inside <EmptyState size="lg">)
 *
 * Never behind tables, forms, chat or any dense reading.
 *
 * Default mode portals into the shell panel's backdrop slot, so the wash
 * reaches the panel's top edge (under any top bar) and fades away as the
 * page scrolls, leaving a neutral canvas for the content below.
 * `inline` positions it inside the nearest `relative` parent instead.
 */
export function Wash({
  variant = "page",
  inline,
  className,
}: {
  /** `page`: tall, three-colour, for a full canvas. `header`: a short band. */
  variant?: "page" | "header";
  /** Render in place (absolute inside the parent) instead of the panel backdrop. */
  inline?: boolean;
  className?: string;
}) {
  const ctx = useOutletContext<AppOutletContext | undefined>();
  const node = (
    <div
      aria-hidden="true"
      data-wash=""
      style={
        inline
          ? undefined
          : {
              // Recede with scroll: gone after ~360px, drifting up at half speed.
              opacity: "clamp(0, calc(1 - var(--scroll-y, 0) / 360), 1)",
              transform: "translateY(calc(var(--scroll-y, 0) * -0.5px))",
            }
      }
      className={cn(
        "pointer-events-none absolute inset-x-0 top-0",
        variant === "page"
          ? "wash h-[460px] [mask-image:linear-gradient(to_bottom,black_30%,transparent)]"
          : "wash-corner h-full opacity-70 [mask-image:linear-gradient(to_bottom,black,transparent)]",
        className,
      )}
    />
  );
  if (inline || !ctx?.backdropSlot) return inline ? node : null;
  return createPortal(node, ctx.backdropSlot);
}
