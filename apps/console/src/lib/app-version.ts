/**
 * New-deploy detection for long-lived console tabs.
 *
 * A tab opened before a deploy keeps running the old JS forever — it never
 * refetches index.html or /assets/*, so new UI silently doesn't appear until
 * a hard refresh. The console's "build id" is the hashed entry script it was
 * loaded with (`/assets/index-<hash>.js`, injected by Vite into index.html).
 * Re-fetching `/` with `cache: "no-store"` and comparing its entry script to
 * ours tells us whether a newer build is live — no server endpoint needed,
 * and a deploy that didn't touch the console (same hash) never prompts.
 */

/** Matches every `<script ...>` opening tag in an HTML document. */
const SCRIPT_TAG_RE = /<script\b([^>]*)>/gi;
const ATTR_RE = /([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of raw.matchAll(ATTR_RE)) {
    out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return out;
}

const DEFAULT_BASE = "http://localhost/";

function pageBase(): string {
  return globalThis.location?.href ?? DEFAULT_BASE;
}

/** Normalize a script src to its pathname so "/assets/x.js" and
 *  "https://host/assets/x.js" compare equal. */
export function normalizeScriptSrc(src: string, base = DEFAULT_BASE): string {
  try {
    return new URL(src, base).pathname;
  } catch {
    return src;
  }
}

/**
 * The one rule both sides use to pick Vite's entry chunk: a module script
 * served from this origin under /assets/. Anything else — an extension's
 * injected `chrome-extension://.../inject.js`, a third-party widget, a dev
 * `/src/main.tsx` — is not a build id. Returns the normalized pathname, or
 * null when `src` isn't an entry candidate.
 */
export function entryScriptPath(src: string, base = DEFAULT_BASE): string | null {
  let url: URL;
  let origin: string;
  try {
    url = new URL(src, base);
    origin = new URL(base).origin;
  } catch {
    return null;
  }
  if (url.origin !== origin || !url.pathname.startsWith("/assets/")) return null;
  return url.pathname;
}

/** The first same-origin `/assets/` module script in `html` (Vite's entry
 *  chunk), normalized to a pathname. null if none. `base` is the URL the
 *  HTML was fetched from. */
export function extractEntryScript(html: string, base = DEFAULT_BASE): string | null {
  for (const m of html.matchAll(SCRIPT_TAG_RE)) {
    const attrs = parseAttrs(m[1]);
    if (attrs.type?.toLowerCase() !== "module" || !attrs.src) continue;
    const path = entryScriptPath(attrs.src, base);
    if (path) return path;
  }
  return null;
}

/** The entry script this tab was loaded with — same matching rule as
 *  extractEntryScript, so injected module scripts never count. */
export function currentEntryScript(doc: Document = document, base = pageBase()): string | null {
  for (const el of doc.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')) {
    const src = el.getAttribute("src");
    const path = src ? entryScriptPath(src, base) : null;
    if (path) return path;
  }
  return null;
}

/** True only when both builds are known and differ. An unparseable
 *  response (proxy error page, login wall) never counts as an update. */
export function isNewVersion(current: string | null, remote: string | null): boolean {
  return !!current && !!remote && current !== remote;
}

export interface UpdateCheckerOptions {
  /** Build id this tab is running. null disables the checker. */
  current: string | null;
  /** Fetches the live index.html. */
  fetchHtml: () => Promise<string>;
  /** URL the HTML is fetched from (resolves relative script srcs).
   *  Defaults to the page's own location. */
  base?: string;
  /** Called when a newer remote build is seen and isn't already announced
   *  or snoozed. */
  onUpdate: (remote: string) => void;
  /** Minimum gap between non-forced checks (focus/nav storms). */
  minIntervalMs?: number;
  now?: () => number;
}

export interface UpdateChecker {
  /** Checks for a newer build. Non-forced calls are throttled. Never throws. */
  check: (opts?: { force?: boolean }) => Promise<void>;
  /** The user dismissed the prompt for `remote`: stay quiet about it for
   *  `ms`, then announce it again on the next check. A different, newer
   *  build is announced right away. */
  snooze: (remote: string, ms: number) => void;
}

export function createUpdateChecker(opts: UpdateCheckerOptions): UpdateChecker {
  const minInterval = opts.minIntervalMs ?? 30_000;
  const now = opts.now ?? Date.now;
  let lastCheckAt = -Infinity;
  let inFlight: Promise<void> | null = null;
  // Remote id → time until which it must not be announced again. An
  // announced build stays quiet (Infinity) while its prompt is up; a
  // dismissal turns that into a finite snooze so the prompt comes back.
  const quietUntil = new Map<string, number>();

  async function run(): Promise<void> {
    let html: string;
    try {
      html = await opts.fetchHtml();
    } catch {
      return; // offline / mid-deploy — try again on the next trigger
    }
    const remote = extractEntryScript(html, opts.base ?? pageBase());
    if (!remote || !isNewVersion(opts.current, remote)) return;
    if (now() < (quietUntil.get(remote) ?? -Infinity)) return;
    quietUntil.set(remote, Infinity);
    opts.onUpdate(remote);
  }

  return {
    check({ force = false } = {}) {
      if (!opts.current) return Promise.resolve();
      if (inFlight) return inFlight;
      const t = now();
      if (!force && t - lastCheckAt < minInterval) return Promise.resolve();
      lastCheckAt = t;
      inFlight = run().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    snooze(remote, ms) {
      quietUntil.set(remote, now() + ms);
    },
  };
}
