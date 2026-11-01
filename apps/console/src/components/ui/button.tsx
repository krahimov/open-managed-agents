import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"
import { BrandLoader } from "@/components/BrandLoader"

const buttonVariants = cva(
  // Studio buttons are pills: solid ink for the primary action (apple.com
  // "Buy"), quiet tinted / outlined pills for everything else. Press
  // feedback is a small spring-y scale, never a layout shift.
  "group/button inline-flex shrink-0 items-center justify-center rounded-full border border-transparent bg-clip-padding text-[13px] font-medium tracking-[-0.01em] whitespace-nowrap transition-[background-color,border-color,color,box-shadow,transform,opacity] duration-[var(--dur-base)] ease-[var(--ease-soft)] outline-none select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:not-aria-[haspopup]:scale-[0.97] active:duration-[var(--dur-quick)] disabled:pointer-events-none disabled:opacity-45 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "bg-ink text-brand-fg hover:bg-ink-hover shadow-[0_1px_2px_rgb(0_0_0/0.12)] dark:shadow-none",
        outline:
          "border-border-strong bg-bg-surface text-fg hover:border-fg-subtle/50 hover:bg-bg-inset aria-expanded:bg-bg-inset dark:border-border dark:bg-fill dark:hover:bg-fill-strong dark:aria-expanded:bg-fill-strong",
        secondary:
          "bg-fill text-fg hover:bg-fill-strong aria-expanded:bg-fill-strong",
        ghost:
          "text-fg-muted hover:bg-fill hover:text-fg aria-expanded:bg-fill aria-expanded:text-fg",
        destructive:
          "bg-danger-subtle text-danger hover:bg-danger/15 focus-visible:outline-danger dark:hover:bg-danger/25",
        link: "rounded-md text-brand underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-8 gap-1.5 px-3.5 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
        xs: "h-6 gap-1 px-2.5 text-xs has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 px-3 text-xs has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-10 gap-2 px-5 text-sm has-data-[icon=inline-end]:pr-4 has-data-[icon=inline-start]:pl-4",
        icon: "size-8",
        "icon-xs": "size-6 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-7 [&_svg:not([class*='size-'])]:size-3.5",
        "icon-lg": "size-10",
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
