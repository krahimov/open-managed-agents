import * as React from "react"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-9 w-full min-w-0 rounded-[10px] border border-input bg-bg-surface px-3 py-1 text-base transition-[border-color,box-shadow,background-color] duration-[var(--dur-base)] ease-[var(--ease-soft)] outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-fg-subtle hover:border-fg-subtle/45 focus-visible:border-ring focus-visible:ring-4 focus-visible:ring-ring/15 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-4 aria-invalid:ring-destructive/15 md:text-sm dark:border-border dark:bg-fill dark:hover:border-border-strong dark:focus-visible:border-ring",
        className
      )}
      {...props}
    />
  )
}

export { Input }
