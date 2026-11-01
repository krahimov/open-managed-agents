import * as React from "react"

import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-xl border border-input bg-bg-surface px-3 py-2 text-base leading-relaxed transition-[border-color,box-shadow] duration-[var(--dur-base)] ease-[var(--ease-soft)] outline-none placeholder:text-fg-subtle hover:border-fg-subtle/45 focus-visible:border-ring focus-visible:ring-4 focus-visible:ring-ring/15 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-4 aria-invalid:ring-destructive/15 md:text-sm dark:border-border dark:bg-fill dark:hover:border-border-strong dark:focus-visible:border-ring",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
