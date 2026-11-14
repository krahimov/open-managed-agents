import * as React from "react"
import { Checkbox as CheckboxPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"
import { CheckIcon } from "lucide-react"

function Checkbox({
  className,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer relative flex size-[18px] shrink-0 items-center justify-center rounded-[6px] border border-border-strong bg-bg-surface shadow-[var(--shadow-xs)] transition-quick group-has-disabled/field:opacity-50 after:absolute after:-inset-x-2.5 after:-inset-y-2 hover:border-fg-faint disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger data-checked:border-ink data-checked:bg-ink data-checked:text-on-ink dark:bg-bg-soft",
        className
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="grid place-content-center text-current transition-none [&>svg]:size-3 [&>svg]:stroke-[3]"
      >
        <CheckIcon
        />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }
