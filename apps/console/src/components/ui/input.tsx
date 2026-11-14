import * as React from "react"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-9 w-full min-w-0 rounded-md border border-border-strong bg-bg-surface px-3 py-1 text-base text-fg shadow-[var(--shadow-xs)] transition-quick outline-none placeholder:text-fg-subtle hover:border-fg-faint focus-visible:border-plum focus-visible:shadow-[var(--shadow-focus)] focus-visible:outline-none disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-bg-inset disabled:opacity-60 aria-invalid:border-danger md:text-sm dark:bg-bg-soft file:mr-3 file:inline-flex file:h-6 file:rounded-full file:border-0 file:bg-bg-soft file:px-2.5 file:text-xs file:font-medium file:text-fg",
        className
      )}
      {...props}
    />
  )
}

export { Input }
