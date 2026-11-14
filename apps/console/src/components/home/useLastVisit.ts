import { useEffect, useState } from "react";

/**
 * When this person was last on Home, so Home can say what finished since.
 *
 * A "visit" is a stretch of work, not one page view: moving to a session
 * and back a minute later must not wipe the list of what is new. So the
 * cut-off only moves forward when Home is opened after a real break
 * (half an hour away). Within a visit it stays put.
 *
 *   const { since } = useLastVisit();   // ms, or null on a first visit
 *
 * Kept in localStorage, per browser. Nothing is sent anywhere.
 */

const KEY = "muse:home:visit";
const BREAK = 30 * 60_000;

interface Stored {
  /** The last moment Home was on screen. */
  seen: number;
  /** The cut-off the current visit uses: where the visit before it ended. */
  since: number | null;
}

function read(): Stored | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Stored>;
    if (typeof v.seen !== "number" || !Number.isFinite(v.seen)) return null;
    return { seen: v.seen, since: typeof v.since === "number" && Number.isFinite(v.since) ? v.since : null };
  } catch {
    return null;
  }
}

function write(value: Stored) {
  try {
    localStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    // storage unavailable: every visit is a first visit
  }
}

/** The cut-off for a visit that starts at `now`, given what was stored. Exported for tests. */
export function visitCutoff(stored: Stored | null, now: number): number | null {
  if (!stored) return null;
  // Back after a break: everything since the previous visit ended is new.
  if (now - stored.seen > BREAK) return stored.seen;
  // Still the same visit: keep its cut-off.
  return stored.since;
}

export function useLastVisit(): { since: number | null } {
  const [since] = useState<number | null>(() => {
    const now = Date.now();
    const cutoff = visitCutoff(read(), now);
    write({ seen: now, since: cutoff });
    return cutoff;
  });

  // While Home is on screen it is being seen: keep the mark fresh, so the
  // next visit counts from when this one really ended.
  useEffect(() => {
    const mark = () => {
      if (document.visibilityState === "visible") write({ seen: Date.now(), since });
    };
    const id = window.setInterval(mark, 60_000);
    document.addEventListener("visibilitychange", mark);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", mark);
      mark();
    };
  }, [since]);

  return { since };
}
