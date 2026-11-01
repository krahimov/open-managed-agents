import * as React from "react"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-[30px] w-full min-w-0 rounded-[7px] border border-input bg-bg-surface px-2.5 py-1 text-base shadow-[0_0.5px_1px_rgb(0_0_0/0.04)] transition-[border-color,box-shadow] duration-[var(--dur-quick)] outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-fg-subtle focus-visible:border-system-accent focus-visible:ring-[3px] focus-visible:ring-system-accent/25 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20 md:text-sm dark:bg-white/[0.05] dark:disabled:bg-white/[0.03] dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Input }
