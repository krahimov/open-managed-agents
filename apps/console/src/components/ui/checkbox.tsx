import * as React from "react"
import { Checkbox as CheckboxPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"
import { CheckIcon } from "lucide-react"

/**
 * Checkbox. `variant="switch"` draws the same Radix checkbox as an
 * iOS-style toggle (see index.css) — same role, state and keyboard
 * behaviour, just the native "on/off" look for standalone booleans.
 */
function Checkbox({
  className,
  variant = "checkbox",
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root> & {
  variant?: "checkbox" | "switch"
}) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      data-variant={variant}
      className={cn(
        "peer relative flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-input bg-bg-surface shadow-[0_0.5px_1px_rgb(0_0_0/0.06)] transition-colors outline-none group-has-disabled/field:opacity-50 after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:ring-[3px] focus-visible:ring-system-accent/45 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 aria-invalid:aria-checked:border-primary dark:bg-white/[0.06] dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 data-checked:border-transparent data-checked:bg-system-accent data-checked:text-white dark:data-checked:bg-system-accent",
        className
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="grid place-content-center text-current transition-none [&>svg]:size-3.5"
      >
        <CheckIcon
        />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }
