import type { SessionReading } from "@/lib/session-state";

import { StatusBadge, StatusDot } from "../Badge";
import { Tip } from "../Tip";

/**
 * A session's state, drawn from its one reading (`lib/session-state.ts`).
 * Every place that shows a session's state draws this, so "Needs access",
 * "Stalled" and "Retrying" look and read the same in the header, the
 * Sessions list, Home and Operations. The detail line is in the tooltip
 * (and is the accessible description), so a two-word label never has to
 * stand alone.
 */
export function SessionStatus({
  reading,
  variant = "dot",
  tip = true,
  className,
}: {
  reading: SessionReading;
  variant?: "dot" | "soft";
  /** False where the detail is already written beside the badge. */
  tip?: boolean;
  className?: string;
}) {
  const badge = <StatusBadge status={reading.status} tone={reading.tone} label={reading.label} variant={variant} className={className} />;
  if (!tip || !reading.detail || reading.detail === reading.label) return badge;
  return (
    <Tip label={reading.detail}>
      <span className="inline-flex">
        {badge}
      </span>
    </Tip>
  );
}

/** The dot alone, for rows with no room for a label. Pair with the label as `sr-only` text or a tooltip. */
export function SessionStatusDot({ reading, className }: { reading: SessionReading; className?: string }) {
  return <StatusDot status={reading.status} tone={reading.tone} className={className} />;
}
