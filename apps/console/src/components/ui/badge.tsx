import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

/**
 * Badge (primitive) — a small pill label. For status use <StatusBadge>,
 * for facts on a record use <Chip>; both live in components/Badge.tsx.
 */
const badgeVariants = cva(
  "group/badge inline-flex h-[22px] w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border border-transparent px-2 text-xs leading-none font-medium whitespace-nowrap transition-quick has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default: "bg-ink text-on-ink [a]:hover:bg-ink-hover",
        secondary: "bg-bg-soft text-fg-muted [a]:hover:bg-bg-pressed",
        destructive: "bg-danger-subtle text-danger [a]:hover:border-danger/40",
        outline: "border-border-strong text-fg-muted [a]:hover:bg-bg-hover [a]:hover:text-fg",
        ghost: "text-fg-muted hover:bg-bg-hover hover:text-fg",
        link: "text-plum underline-offset-4 hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
