import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"
import { BrandLoader } from "@/components/BrandLoader"

/**
 * macOS push buttons. Default = the accent "default button" with a soft
 * top sheen; outline = the standard white push button; secondary = a
 * borderless tinted fill; ghost = toolbar-style. All share a 7px radius
 * (concentric with 12px groups at 5px padding) and a springy press.
 */
const buttonVariants = cva(
  "group/button sq-press inline-flex shrink-0 items-center justify-center rounded-[7px] border border-transparent bg-clip-padding text-[13px] font-medium tracking-[-0.003em] whitespace-nowrap outline-none select-none focus-visible:ring-[3px] focus-visible:ring-system-accent/45 disabled:pointer-events-none disabled:opacity-45 aria-invalid:ring-[3px] aria-invalid:ring-destructive/25 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "sq-sheen bg-brand text-brand-fg shadow-[var(--shadow-button)] hover:bg-brand-hover active:bg-[var(--brand-press)]",
        outline:
          "bg-bg-surface text-fg shadow-[var(--shadow-button)] hover:bg-[#fafafa] active:bg-[#f0f0f2] aria-expanded:bg-[#f0f0f2] dark:bg-white/[0.10] dark:hover:bg-white/[0.14] dark:active:bg-white/[0.18] dark:aria-expanded:bg-white/[0.16]",
        secondary:
          "bg-bg-hover text-fg hover:bg-bg-press aria-expanded:bg-bg-press dark:bg-white/[0.08] dark:hover:bg-white/[0.12]",
        ghost:
          "text-fg-muted hover:bg-bg-hover hover:text-fg active:bg-bg-press aria-expanded:bg-bg-hover aria-expanded:text-fg",
        destructive:
          "bg-danger/10 text-danger hover:bg-danger/[0.16] active:bg-danger/20 focus-visible:ring-danger/30 dark:bg-danger/[0.16] dark:hover:bg-danger/[0.22]",
        link: "text-brand underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-[30px] gap-1.5 px-3 has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5",
        xs: "h-6 gap-1 rounded-[6px] px-2 text-xs in-data-[slot=button-group]:rounded-[6px] has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 rounded-[6px] px-2.5 text-[12px] in-data-[slot=button-group]:rounded-[6px] has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-8 gap-1.5 px-4 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
        icon: "size-[30px]",
        "icon-xs":
          "size-6 rounded-[6px] in-data-[slot=button-group]:rounded-[6px] [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "size-7 rounded-[6px] in-data-[slot=button-group]:rounded-[6px]",
        "icon-lg": "size-8",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

type ButtonOwnProps = {
  asChild?: boolean
  /** Disables the button and renders a BrandLoader; pair with useAsyncAction
   *  so a fast double-click can't fire the handler twice (the bug that made
   *  Create-Key produce duplicate records). Ignored when `asChild` is set. */
  loading?: boolean
  /** Replaces children while loading. Defaults to children unchanged. */
  loadingLabel?: React.ReactNode
}

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  loading = false,
  loadingLabel,
  disabled,
  children,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> &
  ButtonOwnProps) {
  const Comp = asChild ? Slot.Root : "button"

  // asChild forwards props onto its single child element, which won't be a
  // <button> (it's whatever the caller renders). The disabled / aria-busy
  // / loader overlay only make sense on real buttons, so loading is a
  // no-op when asChild is true rather than silently breaking the slot.
  const showLoader = loading && !asChild

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      disabled={asChild ? undefined : disabled || showLoader}
      aria-busy={showLoader || undefined}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    >
      {showLoader ? (
        <>
          <BrandLoader size="sm" label="Loading" className="!text-current" />
          {loadingLabel ?? children}
        </>
      ) : (
        children
      )}
    </Comp>
  )
}

export { Button, buttonVariants }
