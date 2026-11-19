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
 * else UTC. `suffix` (see webhookRunSuffix) replaces the time when given.
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

/**
 * Event-data fields that name one delivery ("1287", "v2.4.1"), in order of
 * preference. They outrank the caller's event id.
 */
export const WEBHOOK_RUN_NAME_FIELDS = ["build", "version", "release"] as const;
/**
 * Fields many deliveries share ("production", "nightly"): used only when
 * the event id is one nobody chose, since a chosen id tells runs apart.
 */
export const WEBHOOK_RUN_FALLBACK_FIELDS = ["tag", "environment"] as const;
const MAX_NAME_FIELD = 32;

/**
 * What a webhook run's title is suffixed with: a short human value naming
 * the delivery ("v2.4.1", "1287"), else the caller's event id when it
 * reads as a name ("deploy-1287"), else a shared value such as the tag or
 * environment ("staging"), else null, which titles the run by its time.
 * Ids nobody chose (the console's "test-3842931265d9", "run-…", UUIDs,
 * long hex digests) never become the title, and neither does text that
 * would not read as one plain line.
 */
export function webhookRunSuffix(eventId: string, data?: Record<string, unknown> | null): string | null {
  const fromData = (fields: readonly string[]): string | null => {
    for (const field of fields) {
      const name = shortName(data?.[field], MAX_NAME_FIELD);
      if (name) return name;
    }
    return null;
  };
  const named = fromData(WEBHOOK_RUN_NAME_FIELDS);
  if (named) return named;
  const id = shortName(eventId, Number.POSITIVE_INFINITY);
  if (id && !isGeneratedId(id)) return id;
  return fromData(WEBHOOK_RUN_FALLBACK_FIELDS);
}

/**
 * Text that cannot draw itself as something else: no control characters,
 * line or paragraph separators, bidi overrides/isolates or zero-width
 * characters (Unicode Cc, Cf, Zl, Zp).
 */
const NOT_ONE_PLAIN_LINE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

function shortName(value: unknown, maxLength: number): string | null {
  if (typeof value === "number") return Number.isSafeInteger(value) ? String(value) : null;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > maxLength || NOT_ONE_PLAIN_LINE.test(text)) return null;
  return text;
}

/** The console's generated ids, UUIDs and bare hex digests. */
function isGeneratedId(id: string): boolean {
  return /^(test|run)-[0-9a-f]{12}$/i.test(id) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ||
    /^[0-9a-f]{16,}$/i.test(id);
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
