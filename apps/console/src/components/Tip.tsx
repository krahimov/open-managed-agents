import type { ReactElement, ReactNode } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * One-line tooltip helper. Wrap any single focusable element:
 *
 *   <Tip label="Copy id"><button …/></Tip>
 *   <Tip label="Open palette" keys={["⌘", "K"]}>…</Tip>
 *
 * Use it for: icon-only buttons (always), truncated text (the full value),
 * and relative times (the absolute time). When `label` is empty the child
 * is returned untouched, so it is safe to pass a conditional label.
 */
export function Tip({
  label,
  children,
  side = "top",
  align = "center",
  delay,
}: {
  label: ReactNode;
  children: ReactElement;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  /** Override the provider's open delay (ms). */
  delay?: number;
}) {
  if (label == null || label === "" || label === false) return children;
  return (
    <Tooltip delayDuration={delay}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} align={align}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
