import { useEffect, useState } from "react";

import { formatAbsolute, formatRelativeTime, toDate, type DateInput } from "@/lib/format";
import { cn } from "@/lib/utils";

import { Tip } from "./Tip";

/**
 * A time, shown relative ("3h ago") with the absolute timestamp on hover
 * and in the `datetime` attribute. This is the ONLY way times are shown in
 * lists, cards and headers. Use `formatAbsolute` directly only in a
 * property row whose whole job is the exact time.
 *
 *   <RelativeTime value={session.created_at} />
 *   <RelativeTime value={agent.updated_at} prefix="Updated" />
 */
export function RelativeTime({
  value,
  prefix,
  className,
  fallback = "—",
}: {
  value: DateInput;
  /** Leading word: "Updated", "Started". */
  prefix?: string;
  className?: string;
  /** Shown when the value is missing or unparsable. */
  fallback?: string;
}) {
  const date = toDate(value);
  // Re-render once a minute so "just now" does not go stale on a long-lived page.
  const [, tick] = useState(0);
  useEffect(() => {
    if (!date) return;
    const id = window.setInterval(() => tick((n) => n + 1), 60_000);
    return () => window.clearInterval(id);
  }, [date?.getTime()]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!date) return <span className={cn("text-fg-subtle", className)}>{fallback}</span>;
  const rel = formatRelativeTime(date);
  return (
    <Tip label={formatAbsolute(date)}>
      <time dateTime={date.toISOString()} className={cn("whitespace-nowrap", className)}>
        {prefix ? `${prefix} ${rel}` : rel}
      </time>
    </Tip>
  );
}
