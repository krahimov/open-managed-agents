/**
 * Format a millisecond duration as a short human label:
 * `<1ms`, `123ms`, `1.23s`, `2m17s`. Used in timeline bars + tooltips
 * + turn headers — anywhere we want a compact "took X" indicator.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1) return "<1ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

/**
 * "12s ago" / "5m ago" / "3d ago" / "8mo ago" — coarse relative time
 * suitable for header chips. Prefer absolute timestamps in tooltips
 * when an exact value matters.
 */
export function formatRelative(diffMs: number): string {
  if (diffMs < 0) diffMs = -diffMs;
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

/**
 * Truncate a long ID like `agt_01ABCDEF...XYZ` to a few-char prefix +
 * ellipsis + suffix, used as a fallback label when the resource's
 * display name hasn't loaded yet. Better than rendering 30 chars of
 * opaque hex in a badge.
 */
export function shortenId(id: string | undefined): string {
  if (!id) return "—";
  if (id.length <= 12) return id;
  return id.slice(0, 8) + "…" + id.slice(-3);
}

/**
 * Snap a time-axis tick step to a friendly unit. Caller passes the
 * total span the chart covers; helper picks the smallest candidate
 * that still keeps tick count near 6. Used by the Timeline waterfall.
 */
export function pickTickStep(totalMs: number): number {
  const target = totalMs / 6;
  const candidates = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000, 60_000, 120_000, 300_000, 600_000];
  for (const c of candidates) if (c >= target) return c;
  return candidates[candidates.length - 1];
}

// ────────────────────────────────────────────────────────────────────────
// Muse display helpers. Every screen formats times, money and counts
// through these so the product reads the same everywhere.
// ────────────────────────────────────────────────────────────────────────

export type DateInput = string | number | Date | null | undefined;

/** Before this the product did not exist: such a timestamp is a placeholder. */
const EARLIEST = Date.UTC(2015, 0, 1);

export function toDate(value: DateInput): Date | null {
  if (value == null || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  // Runtimes send 0, 1 or a negative epoch for "never". None of those is a
  // day in 1969 or 1970, so anything before the product existed is no date.
  return Number.isNaN(d.getTime()) || d.getTime() < EARLIEST ? null : d;
}

/**
 * Human relative time: "just now", "5m ago", "3h ago", "yesterday",
 * "4d ago", then a short date ("Oct 12", or "Oct 12, 2025" across years).
 * Pair with `formatAbsolute` in a tooltip — `<RelativeTime>` does both.
 */
export function formatRelativeTime(value: DateInput, now: number = Date.now()): string {
  const d = toDate(value);
  if (!d) return "—";
  const diff = now - d.getTime();
  const future = diff < 0;
  const sec = Math.floor(Math.abs(diff) / 1000);
  const wrap = (s: string) => (future ? `in ${s}` : `${s} ago`);
  if (sec < 45) return future ? "in a moment" : "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return wrap(`${min}m`);
  const hr = Math.round(min / 60);
  if (hr < 24) return wrap(`${hr}h`);
  const day = Math.round(hr / 24);
  if (day === 1) return future ? "tomorrow" : "yesterday";
  if (day < 7) return wrap(`${day}d`);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** Full, unambiguous timestamp for tooltips and detail rows. */
export function formatAbsolute(value: DateInput): string {
  const d = toDate(value);
  if (!d) return "—";
  return d.toLocaleString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

/** Calendar date without time: "Nov 6, 2026". */
export function formatDate(value: DateInput): string {
  const d = toDate(value);
  if (!d) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** "$181.63", "$0.0042", "<$0.01". */
export function formatCost(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n > 0 && n < 0.005) return "<$0.01";
  return `$${n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Compact count: 1,234 → "1.2k", 151,133,438 → "151M". */
export function formatCompact(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(abs >= 1e10 ? 0 : 1)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(abs >= 1e8 ? 0 : 1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(abs >= 1e5 ? 0 : 1)}k`;
  return String(Math.round(n));
}

/** Session/run length from seconds: "57s", "6m 50s", "2h 14m", "3d 4h". */
export function formatSpan(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

/** "1 agent" / "12 agents". */
export function plural(n: number, one: string, many: string = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/**
 * A list's count when the list may hold more than it has loaded: "12 vaults",
 * or "More than 200 vaults" when another page exists. Never "200+": a
 * count says in words what it does not know.
 */
export function countWords(n: number, more: boolean, one: string, many: string = `${one}s`): string {
  return more ? `More than ${n.toLocaleString()} ${many}` : plural(n, one, many);
}

/** Up to two initials from a display name: "Support Triage" → "ST". */
export function initials(name: string | null | undefined, max = 2): string {
  const words = (name ?? "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, max).toUpperCase();
  return words
    .slice(0, max)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

/** Stable small hash for picking an identity tint from a string id. */
export function hashIndex(seed: string, mod: number): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % mod;
}
