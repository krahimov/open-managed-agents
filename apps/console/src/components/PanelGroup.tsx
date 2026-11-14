import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * One labelled group in a side panel (a `Sheet`, the session's details
 * panel): a quiet 12px label, an optional control on its right, then the
 * content. Stack groups with `space-y-6` or `space-y-7`; no rules between
 * them.
 *
 *   <PanelGroup label="Used by" action={<Button size="xs" variant="ghost">Edit</Button>}>
 *     <UsedByList … />
 *   </PanelGroup>
 */
export function PanelGroup({
  label,
  action,
  children,
  id,
  className,
}: {
  label: ReactNode;
  /** Right-aligned control on the label's line. */
  action?: ReactNode;
  children: ReactNode;
  /** Anchor, when something scrolls the panel to this group. */
  id?: string;
  className?: string;
}) {
  return (
    <section id={id} className={cn(id && "scroll-mt-5", className)}>
      <div className="mb-2 flex h-6 items-center justify-between gap-3">
        <h3 className="text-xs font-medium text-fg-subtle">{label}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}
