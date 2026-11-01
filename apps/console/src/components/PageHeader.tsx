import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useOutletContext } from "react-router";

import { cn } from "@/lib/utils";

import type { AppOutletContext } from "./AppShell";

/**
 * Page header — rendered via React portal into AppShell's
 * `pageHeaderSlot`, which sits ABOVE the scroll container as a
 * `shrink-0` sibling. The slot literally cannot scroll, so the header
 * never moves; no sticky positioning required.
 *
 * Four slots, all optional:
 *   - `title`        → page name (usually omitted; AppBreadcrumb
 *                      already names the route at the top of the shell)
 *   - `subtitle`     → optional one-liner under the title
 *   - `actions`      → right-side button row (filters, CTAs)
 *   - `toolbar`      → second row below the title for search / chips
 *   - `tableHeader`  → bottom row for a frozen list-table header
 *                      (Excel-style). DataTable renders its `<thead>`
 *                      table here so column labels physically live
 *                      outside the scroll container and CAN'T move.
 *
 * Sections flow into each other WITHOUT internal dividers — the only
 * border is the scroll-shadow line added by AppShell's pageHeaderSlot
 * wrapper, which fades in once the user scrolls the panel content
 * under the header. Matches the LangSmith / Linear / Vercel pattern:
 * a flat header block, separator appears only when there's content
 * actually being hidden by it.
 *
 * Returns null when the slot isn't mounted, or when no slot has content.
 */
interface PageHeaderProps {
  /** Small caps label above the title (section / entity kind). */
  eyebrow?: ReactNode;
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  toolbar?: ReactNode;
  tableHeader?: ReactNode;
  /** `hero` = 40px display title (dashboards, entity heroes); default 28px. */
  size?: "default" | "hero";
  className?: string;
}

export function PageHeader({
  eyebrow,
  title,
  subtitle,
  actions,
  toolbar,
  tableHeader,
  size = "default",
  className,
}: PageHeaderProps) {
  const ctx = useOutletContext<AppOutletContext | undefined>();
  const slot = ctx?.pageHeaderSlot;
  if (!slot) return null;

  const hasTopRow = !!title || !!subtitle || !!actions || !!eyebrow;
  if (!hasTopRow && !toolbar && !tableHeader) return null;

  return createPortal(
    <div className={cn("bg-bg", className)}>
      {hasTopRow && (
        <div className="flex flex-wrap items-end gap-x-6 gap-y-3 px-8 pt-3 pb-1">
          <div className="min-w-0 flex-1">
            {eyebrow && <div className="eyebrow mb-1.5">{eyebrow}</div>}
            {title && (
              <h1
                className={cn(
                  "font-display text-fg truncate",
                  size === "hero" ? "text-hero" : "text-title",
                )}
              >
                {title}
              </h1>
            )}
            {subtitle && (
              <p className="mt-1.5 max-w-[68ch] text-[15px] leading-6 text-fg-muted">{subtitle}</p>
            )}
          </div>
          {actions && (
            <div className="flex flex-wrap items-center gap-2 shrink-0 pb-0.5">{actions}</div>
          )}
        </div>
      )}
      {toolbar && (
        <div className="flex items-center gap-2 px-8 pt-5 pb-4 overflow-x-auto [scrollbar-width:none]">
          {toolbar}
        </div>
      )}
      {tableHeader && <div className="px-8">{tableHeader}</div>}
    </div>,
    slot,
  );
}
