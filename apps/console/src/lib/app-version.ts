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

/** Normalize a script src to its pathname so "/assets/x.js" and
 *  "https://host/assets/x.js" compare equal. */
export function normalizeScriptSrc(src: string, base = "http://localhost/"): string {
  try {
    return new URL(src, base).pathname;
  } catch {
    return src;
  }
}

/** The src of the first `<script type="module" src=...>` in `html`
 *  (Vite's entry chunk), normalized to a pathname. null if none. */
export function extractEntryScript(html: string): string | null {
  for (const m of html.matchAll(SCRIPT_TAG_RE)) {
    const attrs = parseAttrs(m[1]);
    if (attrs.type?.toLowerCase() === "module" && attrs.src) {
      return normalizeScriptSrc(attrs.src);
    }
  }
  return null;
}

/** The entry script this tab was loaded with. */
export function currentEntryScript(doc: Document = document): string | null {
  const el = doc.querySelector<HTMLScriptElement>('script[type="module"][src]');
  const src = el?.getAttribute("src");
  return src ? normalizeScriptSrc(src) : null;
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
  /** Called once per newly-seen remote build id. */
  onUpdate: (remote: string) => void;
  /** Minimum gap between non-forced checks (focus/nav storms). */
  minIntervalMs?: number;
  now?: () => number;
}

export interface UpdateChecker {
  /** Checks for a newer build. Non-forced calls are throttled. Never throws. */
  check: (opts?: { force?: boolean }) => Promise<void>;
}

export function createUpdateChecker(opts: UpdateCheckerOptions): UpdateChecker {
  const minInterval = opts.minIntervalMs ?? 30_000;
  const now = opts.now ?? Date.now;
  let lastCheckAt = -Infinity;
  let inFlight: Promise<void> | null = null;
  // Remote ids we've already announced — never toast the same build twice.
  const announced = new Set<string>();

  async function run(): Promise<void> {
    let html: string;
    try {
      html = await opts.fetchHtml();
    } catch {
      return; // offline / mid-deploy — try again on the next trigger
    }
    const remote = extractEntryScript(html);
    if (!remote || !isNewVersion(opts.current, remote) || announced.has(remote)) return;
    announced.add(remote);
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
  };
}
