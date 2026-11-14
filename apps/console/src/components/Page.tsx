import { useLayoutEffect, type ReactNode } from "react";
import { useOutletContext } from "react-router";

import { cn } from "@/lib/utils";

import type { AppOutletContext } from "./AppShell";

/**
 * Page container. Every routed page (except the two full-bleed ones, Home
 * and Session detail) wraps its content in <Page>, which gives it one of
 * four widths and the shared gutter.
 *
 *   narrow  760px   forms, settings, wizards
 *   default 1120px  detail pages, mixed content
 *   wide    1440px  tables and galleries
 *   full    no max  canvases that manage their own width
 *
 * WHERE THE COLUMN SITS (`usePageColumn`):
 *
 *   Top-level pages (Sessions, Usage, Workspace: no breadcrumb above them)
 *   all start on ONE left edge, at every window width. The edge is the
 *   left side of the frame, which is the widest column (1440px) centred in
 *   the panel. A narrower page is capped at its own width and aligned to
 *   that edge; it is never centred on its own, so moving between Sessions,
 *   Usage and Workspace does not move the title.
 *
 *   Record pages (reached through a breadcrumb) are a centred reading
 *   column, with their breadcrumb in the same column. They only centre
 *   once the panel has 80px to spare on each side; until then they fill
 *   the panel exactly as the list they were opened from does, so a record
 *   and its list share BOTH edges (at 1440 with the sidebar open a record
 *   would otherwise start 19px to the right of its list, or stop 37px
 *   short of it). See `page-record-*` in index.css.
 *
 * `header` takes a <PageHeader>, which portals into the fixed slot above
 * the scroll area; pass it the same `width` so the title lines up with the
 * content.
 */
export type PageWidth = "narrow" | "default" | "wide" | "full";

export const PAGE_WIDTH: Record<PageWidth, string> = {
  narrow: "max-w-[760px]",
  default: "max-w-[1120px]",
  wide: "max-w-[1440px]",
  full: "max-w-none",
};

/** Horizontal page gutter: 20px, 32px from `lg`. */
export const PAGE_GUTTER = "px-5 lg:px-8";

/** The frame every top-level page starts in: the widest column, centred. */
const FRAME: Record<PageWidth, string> = {
  narrow: "mx-auto w-full max-w-[1440px]",
  default: "mx-auto w-full max-w-[1440px]",
  wide: "mx-auto w-full max-w-[1440px]",
  full: "w-full max-w-none",
};
/** A narrower top-level page inside the frame: its column less the gutters, on the frame's left edge. */
const FRAMED: Record<PageWidth, string> = {
  narrow: "max-w-[696px]",
  default: "max-w-[1056px]",
  wide: "",
  full: "",
};
/** A record page: its own column, centred once there is room (index.css). */
const RECORD: Record<PageWidth, string> = {
  narrow: "page-record-narrow w-full max-w-[760px]",
  // Its max-width comes from the utility: the panel's width until it centres, 1120px after.
  default: "page-record-default w-full",
  wide: "mx-auto w-full max-w-[1440px]",
  full: "w-full max-w-none",
};

export interface PageColumn {
  /** The positioned column, gutter included. */
  outer: string;
  /** The content box inside it. Empty when the column is the content box. */
  inner: string;
}

/** Column classes for a page of `width`. `topLevel` comes from the shell. */
export function pageColumn(width: PageWidth, topLevel: boolean): PageColumn {
  return topLevel
    ? { outer: cn(FRAME[width], PAGE_GUTTER), inner: FRAMED[width] }
    : { outer: cn(RECORD[width], PAGE_GUTTER), inner: "" };
}

/** The column for the current route. Outside the shell (unit tests) a page counts as top-level. */
export function usePageColumn(width: PageWidth): PageColumn {
  const topLevel = useOutletContext<AppOutletContext | undefined>()?.topLevel ?? true;
  return pageColumn(width, topLevel);
}

interface PageProps {
  children: ReactNode;
  /** Fixed page header — usually a `<PageHeader />`. */
  header?: ReactNode;
  width?: PageWidth;
  className?: string;
}

/** Tells the shell which width this route uses, so the breadcrumb lines up with it. */
export function useRegisterPageWidth(width: PageWidth) {
  const register = useOutletContext<AppOutletContext | undefined>()?.registerPageWidth;
  useLayoutEffect(() => {
    register?.(width);
  }, [register, width]);
}

export function Page({ header, children, width = "default", className = "" }: PageProps) {
  useRegisterPageWidth(width);
  const column = usePageColumn(width);
  return (
    <>
      {header}
      <div className={column.outer}>
        <div className={cn("pt-2 pb-16", column.inner, className)}>{children}</div>
      </div>
    </>
  );
}
