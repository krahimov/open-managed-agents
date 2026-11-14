import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"
import { BrandLoader } from "@/components/BrandLoader"

/**
 * Button — Muse.
 *
 * Shape: a full pill. Icon-only sizes are circles.
 * Variants (pick by role, not by look):
 *   default      ink fill. THE primary action; one per view.
 *   outline      white surface + hairline. Secondary actions beside a primary.
 *   secondary    soft fill, no border. Tertiary / in-card actions.
 *   ghost        text only until hovered. Toolbars, icon buttons, row actions.
 *   destructive  soft red. Confirm steps of destructive flows only.
 *   link         inline plum text link.
 * Sizes: default 36px · sm 32px · lg 40px · xs 28px (dense, inside cards only).
 */
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-full border border-transparent bg-clip-padding text-small leading-none font-medium whitespace-nowrap select-none transition-quick active:not-aria-[haspopup]:scale-[0.97] disabled:pointer-events-none disabled:opacity-45 aria-invalid:border-danger [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        // Disabled is a quiet neutral pill, not ink at half strength (which
        // reads as a muddy mauve on the warm canvas).
        default:
          "bg-ink text-on-ink shadow-[var(--shadow-xs)] hover:bg-ink-hover disabled:bg-bg-pressed disabled:text-fg-subtle disabled:opacity-100 disabled:shadow-none",
        outline:
          "border-border-strong bg-bg-surface text-fg shadow-[var(--shadow-xs)] hover:bg-bg-inset hover:border-fg-faint aria-expanded:bg-bg-inset dark:bg-bg-soft dark:hover:bg-bg-hover",
        secondary:
          "bg-bg-soft text-fg hover:bg-bg-pressed aria-expanded:bg-bg-pressed",
        ghost:
          "text-fg-muted hover:bg-bg-hover hover:text-fg aria-expanded:bg-bg-hover aria-expanded:text-fg",
        destructive:
          "border-danger/20 bg-danger-subtle text-danger hover:border-danger/45",
        link: "relative h-auto! rounded-sm px-0! text-plum underline-offset-4 after:absolute after:-inset-1 hover:text-plum-hover hover:underline",
      },
      size: {
        default: "h-9 gap-1.5 px-4 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
        xs: "h-7 gap-1 px-2.5 text-xs [&_svg:not([class*='size-'])]:size-3.5",
        sm: "h-8 gap-1.5 px-3 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-10 gap-2 px-5 text-sm",
        icon: "size-9",
        "icon-xs": "size-7 [&_svg:not([class*='size-'])]:size-3.5",
        "icon-sm": "size-8",
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
