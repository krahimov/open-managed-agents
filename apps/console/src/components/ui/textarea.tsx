import * as React from "react"

import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-20 w-full rounded-lg border border-border-strong bg-bg-surface px-3 py-2.5 text-base leading-relaxed text-fg shadow-[var(--shadow-xs)] transition-quick outline-none placeholder:text-fg-subtle hover:border-fg-faint focus-visible:border-plum focus-visible:shadow-[var(--shadow-focus)] focus-visible:outline-none disabled:cursor-not-allowed disabled:bg-bg-inset disabled:opacity-60 aria-invalid:border-danger md:text-sm dark:bg-bg-soft",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
