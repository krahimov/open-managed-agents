// Time helpers for records whose timestamps arrive as unix numbers.
//
// Integrations and local runtimes report `created_at` / `last_heartbeat` as
// a number that may be seconds or milliseconds depending on the adapter.
// `toMillis` normalises either (and ISO strings) so the value can be handed
// to <RelativeTime>, which is how every time is shown on screen.

/** Normalise seconds, milliseconds, an ISO string or a Date to epoch ms. */
export function toMillis(input: number | string | Date | null | undefined): number | null {
  if (input == null || input === "") return null;
  if (input instanceof Date) return input.getTime();
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input <= 0) return null;
    // A 10-digit value is seconds; promote it.
    return input < 1e12 ? input * 1000 : input;
  }
  const t = Date.parse(input);
  return Number.isNaN(t) ? null : t;
}

/**
 * Coarse relative time as plain text ("3d ago"). Prefer <RelativeTime>
 * with `toMillis` in components: it adds the absolute time on hover. This
 * stays for callers that need a string.
 */
export function relativeTime(input: number | string | Date): string {
  const t = toMillis(input);
  if (t == null) return "unknown";
  const diff = Date.now() - t;
  if (diff < 0) return "just now"; // clock skew or future timestamps
  const sec = Math.floor(diff / 1000);
  if (sec < 45) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  if (day < 30) return `${Math.floor(day / 7)}w ago`;
  if (day < 365) return `${Math.floor(day / 30)}mo ago`;
  return `${Math.floor(day / 365)}y ago`;
}
