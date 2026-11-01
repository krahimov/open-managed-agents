import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"
import { BrandLoader } from "@/components/BrandLoader"

/* Liquid Glass buttons — every button is a pill.
 *   default     solid accent with a soft inner highlight
 *   outline /
 *   secondary   glass capsule (translucent fill + specular rim)
 *   ghost       bare until hover, then a faint tinted capsule
 *   destructive tinted danger capsule
 * Presses scale down on a spring; reduced-motion keeps them still. */
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-full border border-transparent bg-clip-padding text-sm font-medium tracking-[-0.005em] whitespace-nowrap outline-none select-none transition-[background-color,color,box-shadow,transform,filter] duration-200 ease-(--ease-soft) focus-visible:ring-[3px] focus-visible:ring-ring/30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:not-aria-[haspopup]:scale-[0.97] active:not-aria-[haspopup]:duration-100 motion-reduce:active:not-aria-[haspopup]:scale-100 disabled:pointer-events-none disabled:opacity-45 aria-invalid:ring-2 aria-invalid:ring-destructive/25 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "btn-solid hover:brightness-[1.08] aria-expanded:brightness-[1.08]",
        outline:
          "glass-chip text-fg hover:bg-glass-strong aria-expanded:bg-glass-strong",
        secondary:
          "glass-chip text-fg hover:bg-glass-strong aria-expanded:bg-glass-strong",
        ghost:
          "text-fg-muted hover:bg-fg/[0.06] hover:text-fg aria-expanded:bg-fg/[0.06] aria-expanded:text-fg",
        destructive:
          "bg-danger-subtle text-danger shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--danger)_18%,transparent)] hover:bg-danger/15 focus-visible:outline-danger focus-visible:ring-danger/25",
        link: "rounded-md text-brand underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-8 gap-1.5 px-3.5 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
        xs: "h-6 gap-1 px-2.5 text-xs has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 px-3 text-[0.8125rem] has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-10 gap-2 px-5 text-[0.9375rem] has-data-[icon=inline-end]:pr-4 has-data-[icon=inline-start]:pl-4",
        icon: "size-8",
        "icon-xs": "size-6 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-7",
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
