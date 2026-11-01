import * as React from "react"
import { motion, useReducedMotion } from "motion/react"

import { cn } from "@/lib/utils"

/**
 * Liquid Glass segmented control pieces.
 *
 *   <div role="tablist" className={segmentedListClass}>
 *     <button role="tab" aria-selected={active} className={segmentedItemClass(active)}>
 *       {active && <SegmentedIndicator layoutId="session-view" />}
 *       <span className="relative">Conversation</span>
 *     </button>
 *   </div>
 *
 * The indicator is a raised glass capsule that slides between segments
 * via a shared `layoutId` (spring). Under prefers-reduced-motion it
 * snaps instantly. Callers keep their own roles / aria / keyboard logic —
 * these are purely presentational.
 */
export const segmentedListClass =
  "glass-well relative inline-flex h-9 items-center gap-0.5 rounded-full p-[3px]"

export function segmentedItemClass(active: boolean, className?: string) {
  return cn(
    "relative isolate inline-flex h-full min-h-[28px] items-center justify-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium whitespace-nowrap outline-none transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
    active ? "text-fg" : "text-fg-muted hover:text-fg",
    className
  )
}

export function SegmentedIndicator({
  layoutId,
  className,
  tint = false,
}: {
  layoutId: string
  className?: string
  /** Accent-tinted capsule instead of the neutral raised glass. */
  tint?: boolean
}) {
  const reduce = useReducedMotion()
  return (
    <motion.span
      layoutId={layoutId}
      aria-hidden="true"
      className={cn(
        "absolute inset-0 -z-10 rounded-full",
        tint
          ? "glass-tint"
          : "bg-glass-strong shadow-[inset_0_1px_0_var(--glass-hi),0_0_0_0.5px_var(--glass-edge),0_2px_8px_-2px_rgb(15_23_42/0.18)]",
        className
      )}
      transition={
        reduce
          ? { duration: 0 }
          : { type: "spring", stiffness: 520, damping: 40, mass: 0.9 }
      }
    />
  )
}

export function SegmentedLabel({ children }: { children: React.ReactNode }) {
  return <span className="relative inline-flex items-center gap-1.5">{children}</span>
}
