import type { ComponentType, ReactNode } from "react";
import { CircleAlertIcon, CircleCheckIcon, InfoIcon, TriangleAlertIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * An inline notice inside a page or a card: context the person should
 * read before acting. Not for failures of a data load (use <ErrorState>)
 * and not for transient feedback (use a toast).
 *
 *   <Callout tone="neutral" icon={ArchiveIcon} title="This agent is archived">
 *     It no longer accepts new sessions. Its history is kept.
 *   </Callout>
 *   <Callout tone="warning" title="This key expires in 3 days"
 *            action={<Button size="sm" variant="outline">Renew</Button>}>
 *     Anything that signs in with it will stop working on Friday.
 *   </Callout>
 *
 * Tones: `neutral` (a tip, or a state at rest such as archived), `info`,
 * `success`, `warning` (a person is needed: amber means nothing else),
 * `danger` (something is wrong). One callout per region; if you need
 * three, the page needs restructuring.
 */
type Tone = "neutral" | "info" | "success" | "warning" | "danger";

const TONE: Record<Tone, { wrap: string; icon: string; Icon: ComponentType<{ className?: string }> }> = {
  neutral: { wrap: "bg-bg-soft", icon: "text-fg-muted", Icon: InfoIcon },
  info: { wrap: "bg-info-subtle", icon: "text-info", Icon: InfoIcon },
  success: { wrap: "bg-success-subtle", icon: "text-success", Icon: CircleCheckIcon },
  warning: { wrap: "bg-warning-subtle", icon: "text-warning", Icon: TriangleAlertIcon },
  danger: { wrap: "bg-danger-subtle", icon: "text-danger", Icon: CircleAlertIcon },
};

export function Callout({
  tone = "neutral",
  title,
  children,
  action,
  icon,
  className,
}: {
  tone?: Tone;
  title?: ReactNode;
  children?: ReactNode;
  /** A small button or link on the right. */
  action?: ReactNode;
  /** Override the tone's icon. */
  icon?: ComponentType<{ className?: string }>;
  className?: string;
}) {
  const t = TONE[tone];
  const Icon = icon ?? t.Icon;
  return (
    <div
      role={tone === "danger" || tone === "warning" ? "alert" : "note"}
      className={cn("flex items-start gap-3 rounded-lg px-4 py-3 text-small", t.wrap, className)}
    >
      <Icon className={cn("mt-0.5 size-4 shrink-0", t.icon)} />
      <div className="min-w-0 flex-1">
        {title && <p className="font-medium text-fg">{title}</p>}
        {children && <div className={cn("text-fg-muted", title && "mt-0.5")}>{children}</div>}
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </div>
  );
}
