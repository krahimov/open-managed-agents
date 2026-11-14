import type { CSSProperties, JSX } from "react";

import { cn } from "@/lib/utils";

interface SkeletonProps {
  className?: string;
  rounded?: "sm" | "md" | "lg" | "xl" | "full";
  style?: CSSProperties;
}

const radiusCls: Record<NonNullable<SkeletonProps["rounded"]>, string> = {
  sm: "rounded-sm",
  md: "rounded-md",
  lg: "rounded-lg",
  xl: "rounded-xl",
  full: "rounded-full",
};

/**
 * Placeholder block for in-flight content. A skeleton takes the SHAPE of
 * what is loading (a line of text, an avatar, a card), so the page does
 * not jump when data lands. Caller sets width/height:
 *
 *   <Skeleton className="h-4 w-32" />                 a line
 *   <Skeleton className="size-10" rounded="lg" />     an agent avatar
 *
 * For whole blocks use <SkeletonCard>, <SkeletonRows> or <SkeletonText>.
 */
export function Skeleton({ className = "", rounded = "md", style }: SkeletonProps): JSX.Element {
  return (
    <div
      aria-hidden="true"
      data-slot="skeleton"
      style={style}
      className={cn("skeleton-pulse bg-bg-pressed", radiusCls[rounded], className)}
    />
  );
}

/** N lines of text; the last one is shorter. */
export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }): JSX.Element {
  return (
    <div className={cn("space-y-2", className)} aria-hidden="true">
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} rounded="sm" className={cn("h-3.5", i === lines - 1 ? "w-3/5" : "w-full")} />
      ))}
    </div>
  );
}

/** A card-shaped placeholder: avatar, two lines, a footer line. */
export function SkeletonCard({ className }: { className?: string }): JSX.Element {
  return (
    <div className={cn("surface rounded-xl p-5", className)} aria-hidden="true">
      <div className="flex items-center gap-3">
        <Skeleton className="size-10" rounded="lg" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-3.5 w-2/5" rounded="sm" />
          <Skeleton className="h-3 w-1/4" rounded="sm" />
        </div>
      </div>
      <SkeletonText lines={2} className="mt-5" />
      <Skeleton className="mt-5 h-5 w-24" rounded="full" />
    </div>
  );
}

/** A record page while it loads: header (avatar, title, chips) and two cards. */
export function SkeletonDetail({ className }: { className?: string }): JSX.Element {
  return (
    <div className={cn("pt-4", className)} aria-hidden="true">
      <div className="flex items-start gap-5 pb-8">
        <Skeleton className="size-14" rounded="xl" />
        <div className="flex-1 space-y-3 pt-1">
          <Skeleton className="h-6 w-64" rounded="md" />
          <Skeleton className="h-3.5 w-[min(28rem,70%)]" rounded="sm" />
          <div className="flex gap-2 pt-1">
            <Skeleton className="h-[22px] w-20" rounded="full" />
            <Skeleton className="h-[22px] w-16" rounded="full" />
            <Skeleton className="h-[22px] w-24" rounded="full" />
          </div>
        </div>
        <Skeleton className="h-9 w-28" rounded="full" />
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="surface rounded-xl p-5">
          <Skeleton className="h-4 w-32" rounded="sm" />
          <SkeletonText lines={5} className="mt-5" />
        </div>
        <div className="surface space-y-4 rounded-xl p-5">
          <Skeleton className="h-4 w-20" rounded="sm" />
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex justify-between gap-6">
              <Skeleton className="h-3 w-20" rounded="sm" />
              <Skeleton className="h-3 w-28" rounded="sm" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

interface SkeletonRowsProps {
  count: number;
  height?: number;
  gap?: number;
}

/**
 * N evenly-spaced full-width rows — for "loading a list" when the row
 * anatomy is unknown. Match the real row height to avoid a layout shift.
 */
export function SkeletonRows({ count, height = 44, gap = 8 }: SkeletonRowsProps): JSX.Element {
  return (
    <div style={{ display: "grid", gap: `${gap}px` }} aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} className="w-full" rounded="lg" style={{ height: `${height}px` }} />
      ))}
    </div>
  );
}
