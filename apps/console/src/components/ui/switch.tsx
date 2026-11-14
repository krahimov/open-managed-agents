import * as React from "react"
import { Switch as SwitchPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

/**
 * Switch — an on/off setting that applies immediately. Use a Checkbox
 * instead when the choice is part of a form that is submitted later.
 * Always pair with a visible label (see <SettingRow>).
 */
function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full border border-transparent bg-bg-pressed p-0.5 transition-quick disabled:cursor-not-allowed disabled:opacity-50 data-checked:bg-ink",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-4 rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/0.2)] transition-transform duration-[var(--dur-base)] ease-[var(--ease-rise)] data-checked:translate-x-4 dark:bg-bg-surface dark:data-checked:bg-on-ink"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
