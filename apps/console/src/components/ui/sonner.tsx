import { Toaster as Sonner, type ToasterProps } from "sonner"
import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"

import { useTheme } from "@/lib/theme"

/**
 * Sonner Toaster wired into the console's own `useTheme` (lib/theme.ts)
 * — the shadcn template ships with `next-themes`, but the console already
 * has its own light/dark/system manager that owns the `.dark` class on
 * `<html>`. Reading from it keeps the toast colour mode in lock-step
 * with the rest of the app on manual toggles (next-themes would only
 * see the system preference, not in-app overrides).
 */
const Toaster = ({ ...props }: ToasterProps) => {
  const { effective } = useTheme()

  return (
    <Sonner
      theme={effective}
      className="toaster group"
      // Match the previous Radix Toast placement: bottom-right on desktop,
      // top-center on narrow viewports. swipeDirections / closeButton fall
      // back to sonner defaults.
      position="bottom-right"
      duration={4000}
      icons={{
        success: <CircleCheckIcon className="size-4 text-success" />,
        info: <InfoIcon className="size-4 text-brand" />,
        warning: <TriangleAlertIcon className="size-4 text-warning" />,
        error: <OctagonXIcon className="size-4 text-danger" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          // macOS notification banner: raised material, 14px corners,
          // soft layered shadow, hairline edge.
          "--normal-bg": "var(--bg-raised)",
          "--normal-text": "var(--fg)",
          "--normal-border": "var(--hairline)",
          "--border-radius": "14px",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast !shadow-[var(--shadow-lg)] !text-[13px] !font-sans",
          title: "!font-semibold",
          description: "!text-fg-muted",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
