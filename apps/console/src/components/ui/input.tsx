import * as React from "react"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-8 w-full min-w-0 rounded-[10px] border-0 bg-field px-3 py-1 text-base shadow-[inset_0_0_0_1px_var(--border-strong),inset_0_1px_2px_0_rgb(15_23_42/0.05)] transition-[box-shadow,background-color] duration-200 outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-fg-subtle hover:bg-field-hover focus-visible:bg-field-hover focus-visible:shadow-[inset_0_0_0_1px_var(--ring),0_0_0_3px_color-mix(in_oklab,var(--ring)_22%,transparent)] focus-visible:outline-none disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:shadow-[inset_0_0_0_1px_var(--danger),0_0_0_3px_color-mix(in_oklab,var(--danger)_18%,transparent)] md:text-sm",
        className
      )}
      {...props}
    />
  )
}

export { Input }
