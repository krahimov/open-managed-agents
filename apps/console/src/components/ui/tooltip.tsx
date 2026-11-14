"use client"

import * as React from "react"
import { Tooltip as TooltipPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

// Radix throws when a Tooltip renders without a provider above it. Pages
// outside AppShell (login, CLI login) and unit tests have none, so Tooltip
// supplies its own when it is not already inside one.
const HasTooltipProvider = React.createContext(false)

function TooltipProvider({
  delayDuration = 350,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <HasTooltipProvider.Provider value={true}>
      <TooltipPrimitive.Provider
        data-slot="tooltip-provider"
        delayDuration={delayDuration}
        {...props}
      />
    </HasTooltipProvider.Provider>
  )
}

/**
 * Set by a trigger that took focus because a dialog (or a popover, a sheet)
 * put it there, not because the person moved to it: a dialog opening, or
 * focus coming back from a list it opened. A tooltip does not open from
 * that focus, so a dialog never opens with a tooltip over its first label
 * (the avatar button's "Change avatar" over Name). Moving to the trigger
 * within the dialog, or pointing at it, opens it as usual.
 */
const FocusGate = React.createContext<React.MutableRefObject<boolean> | null>(null)

function Tooltip({
  open: openProp,
  defaultOpen,
  onOpenChange,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  const provided = React.useContext(HasTooltipProvider)
  const gate = React.useRef(false)
  const [uncontrolled, setUncontrolled] = React.useState(defaultOpen ?? false)
  const controlled = openProp !== undefined
  const handleOpenChange = (next: boolean) => {
    if (next && gate.current) return
    if (!controlled) setUncontrolled(next)
    onOpenChange?.(next)
  }
  const root = (
    <FocusGate.Provider value={gate}>
      <TooltipPrimitive.Root
        data-slot="tooltip"
        open={controlled ? openProp : uncontrolled}
        onOpenChange={handleOpenChange}
        {...props}
      />
    </FocusGate.Provider>
  )
  return provided ? root : <TooltipProvider>{root}</TooltipProvider>
}

function TooltipTrigger({
  onFocus,
  onBlur,
  onPointerMove,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  const gate = React.useContext(FocusGate)
  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
      onFocus={(e) => {
        if (gate) {
          const layer = e.currentTarget.closest('[role="dialog"], [role="alertdialog"]')
          const from = e.relatedTarget
          gate.current = !!layer && !(from instanceof Node && layer.contains(from))
        }
        onFocus?.(e)
      }}
      onBlur={(e) => {
        if (gate) gate.current = false
        onBlur?.(e)
      }}
      onPointerMove={(e) => {
        if (gate) gate.current = false
        onPointerMove?.(e)
      }}
      {...props}
    />
  )
}

function TooltipContent({
  className,
  sideOffset = 6,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          "z-50 inline-flex w-fit max-w-xs origin-(--radix-tooltip-content-transform-origin) items-center gap-1.5 rounded-md bg-ink px-2.5 py-1.5 text-xs leading-snug font-medium text-on-ink shadow-[var(--shadow-md)] has-data-[slot=kbd]:pr-1.5 duration-150 data-[side=bottom]:slide-in-from-top-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 data-[side=top]:slide-in-from-bottom-1 data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-97 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
          className
        )}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger }
