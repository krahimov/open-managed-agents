// What an ambient (triggered) run looks like from the outside: the title
// its session gets and the metadata its wake message carries. Shared by
// every dispatcher (Node's schedule sweep, the webhook route, "run now")
// so the console can tell a run apart from the next one and draw the wake
// message as "Triggered by <rule>" instead of a bubble from a person.

import type { AmbientTriggerSource, AmbientWakeMode } from "./ambient-types";

/**
 * `metadata.ambient` on the wake `user.message` (and, without `prompt`, on
 * the session). The message text stays in the event log as-is — harnesses
 * build the model's context from it — this only says where it came from.
 */
export interface AmbientWakeMetadata {
  rule_id: string;
  rule_name: string;
  source: Extract<AmbientTriggerSource, "schedule" | "webhook">;
  wake_mode: AmbientWakeMode;
  /** ISO time the run was dispatched. */
  fired_at: string;
  /** Schedule: the occurrence the sweep fired for (the rule's due time). */
  scheduled_for?: string;
  /** Webhook: the caller's event_id. */
  event_id?: string;
  /** Started from the console's "Run now" / "Send test event". */
  manual?: boolean;
}

const MAX_SUFFIX = 40;

/**
 * "<rule name> · Nov 18, 09:00 UTC": a distinct, readable title per run.
 * The time is shown in the rule's own time zone when it has a valid one,
 * else UTC. `suffix` (a webhook's event id) replaces the time when given.
 */
export function ambientRunTitle(
  ruleName: string,
  opts: { at: number; timezone?: string | null; suffix?: string | null },
): string {
  const name = ruleName.trim() || "Trigger";
  const suffix = opts.suffix?.trim();
  if (suffix) {
    const short = suffix.length > MAX_SUFFIX ? `${suffix.slice(0, MAX_SUFFIX - 1)}…` : suffix;
    return `${name} · ${short}`;
  }
  return `${name} · ${formatRunTime(opts.at, opts.timezone)}`;
}

/** "Nov 18, 09:00 UTC" in `timezone` (IANA), falling back to UTC when it is missing or unknown. */
export function formatRunTime(at: number, timezone?: string | null): string {
  const zone = typeof timezone === "string" && timezone.trim() ? timezone.trim() : "UTC";
  try {
    return format(at, zone);
  } catch {
    return format(at, "UTC");
  }
}

function format(at: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).formatToParts(new Date(at));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("month")} ${get("day")}, ${get("hour")}:${get("minute")} ${get("timeZoneName")}`.trim();
}
