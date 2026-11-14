/**
 * The window a usage figure covers.
 *
 * Home and the Usage page both say "last 30 days". They only mean the same
 * thing if they ask the server for the same `since` and `until`, so both get
 * them here. Because the two pages then send an identical request, they also
 * share one cache entry: the numbers cannot disagree.
 *
 *   const win = usageWindow(30);
 *   useApiQuery("/v1/usage", win.params);            // the window
 *   useApiQuery("/v1/usage", win.previousParams);    // the same length, just before
 *
 * What a window is:
 *
 *   two days or more   whole UTC days, today included. "Last 30 days" is today
 *                      so far plus the 29 days before it. The report buckets by
 *                      UTC day, so the window holds exactly `days` buckets and a
 *                      chart of it has no half-counted first day.
 *   24 hours           the 24 hours up to now, to the minute.
 *
 * `previous` is the window of the same length that ends where this one
 * starts, so a change is always like against like: 30 days against the 30
 * before, never 7 against a 30-day total.
 */

const DAY = 86_400_000;
const MINUTE = 60_000;

export interface UsageWindow {
  /** The length the window is named by: 1, 7, 30, 90. */
  days: number;
  /** Start, inclusive (ms since epoch). */
  since: number;
  /** End, exclusive (ms since epoch). */
  until: number;
  /** The same length immediately before: what a delta compares against. */
  previous: { since: number; until: number };
  /** Query params for `GET /v1/usage`. */
  params: { since: string; until: string };
  /** Query params for the period before. */
  previousParams: { since: string; until: string };
  /** The UTC days the window touches, oldest first, as the report names them ("2026-11-10"). */
  dayKeys: string[];
}

export function usageWindow(days: number, now: number = Date.now()): UsageWindow {
  const span = days * DAY;
  const until = days >= 2 ? (Math.floor(now / DAY) + 1) * DAY : Math.ceil(now / MINUTE) * MINUTE;
  const since = until - span;
  const dayKeys: string[] = [];
  for (let d = Math.floor(since / DAY); d <= Math.floor((until - 1) / DAY); d++) {
    dayKeys.push(new Date(d * DAY).toISOString().slice(0, 10));
  }
  return {
    days,
    since,
    until,
    previous: { since: since - span, until: since },
    params: { since: String(since), until: String(until) },
    previousParams: { since: String(since - span), until: String(since) },
    dayKeys,
  };
}

/** The UTC day a timestamp falls on, in the report's own format. */
export function utcDayKey(value: string | number | Date): string {
  return new Date(value).toISOString().slice(0, 10);
}
