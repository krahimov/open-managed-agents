/**
 * Stale-chunk recovery. After a deploy every hashed chunk is replaced; a tab
 * opened before it still references the old ones, and lazy imports fail.
 * main-node returns 404 for unknown /assets/* paths, so the import fails
 * loudly.
 *
 * Route chunks and in-page chunks are handled differently:
 *   - A failure while the router is navigating (lazy route: Session detail,
 *     Agent setup, ...) or still booting: the user is leaving the page
 *     anyway, so we load the URL they were going to - a full page load that
 *     picks up the fresh index.html.
 *   - Any other chunk (Shiki grammars, mermaid diagram types, the noVNC
 *     desktop viewer, ... loaded mid-session) never reloads: that would
 *     drop composer text and kill in-flight OAuth popups. The component
 *     degrades and `onStaleChunk` shows the update prompt instead.
 * A sessionStorage timestamp keeps a persistently broken deploy from
 * turning into a reload loop.
 */

export const CHUNK_RELOAD_KEY = "oma-chunk-reload-at";
export const CHUNK_RELOAD_WINDOW_MS = 30_000;

type MinimalStorage = Pick<Storage, "getItem" | "setItem">;

/**
 * Returns true (and records the attempt) when a chunk-error reload is
 * allowed: no reload happened within `windowMs`. Storage that is missing
 * or throws means we can't guard against loops, so we refuse.
 */
export function claimChunkReload(
  storage: MinimalStorage | null | undefined,
  now: number = Date.now(),
  windowMs: number = CHUNK_RELOAD_WINDOW_MS,
): boolean {
  if (!storage) return false;
  try {
    const last = Number(storage.getItem(CHUNK_RELOAD_KEY) ?? 0);
    // A timestamp in the future (clock change) is treated as stale.
    if (Number.isFinite(last) && last > 0 && last <= now && now - last < windowMs) {
      return false;
    }
    storage.setItem(CHUNK_RELOAD_KEY, String(now));
    return true;
  } catch {
    return false;
  }
}

const CHUNK_ERROR_PATTERNS = [
  /Failed to fetch dynamically imported module/i, // Chromium
  /error loading dynamically imported module/i, // Firefox
  /Importing a module script failed/i, // Safari
  /Unable to preload CSS/i, // Vite CSS preload
  /'text\/html' is not a valid JavaScript MIME type/i, // HTML served for a chunk
];

/** Whether an error looks like a failed dynamic import / chunk preload. */
export function isChunkLoadError(err: unknown): boolean {
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return !!message && CHUNK_ERROR_PATTERNS.some((re) => re.test(message));
}

function safeSessionStorage(win: Window): Storage | null {
  try {
    return win.sessionStorage;
  } catch {
    return null;
  }
}

/** The bits of a react-router data router this module reads. */
export interface ChunkReloadRouter {
  state: {
    initialized: boolean;
    navigation: { state: string; location?: unknown };
  };
  createHref: (location: never) => string;
}

/**
 * Where a chunk-error reload should land, or null when it must not reload:
 * the pending navigation's target while the router is navigating, the
 * current URL while it is still booting (nothing typed yet), otherwise null.
 */
export function chunkReloadTarget(
  router: ChunkReloadRouter | null | undefined,
  currentHref: string,
): string | null {
  if (!router) return null;
  if (!router.state.initialized) return currentHref;
  const nav = router.state.navigation;
  if (nav.state === "idle" || !nav.location) return null;
  try {
    return router.createHref(nav.location as never);
  } catch {
    return null;
  }
}

function withoutHash(url: URL): string {
  const copy = new URL(url.href);
  copy.hash = "";
  return copy.href;
}

/**
 * Full page load of `target`. `location.assign()` of a URL that matches the
 * current document apart from its fragment (e.g. booting on
 * /sessions/abc#evt-12) is only a fragment navigation under the HTML
 * navigate algorithm, so nothing reloads. handle() returning true means the
 * preload error was preventDefault()ed and the import resolves to
 * undefined, which would leave lazyRoute's "Loading the new version…"
 * placeholder up for good. A same-document target therefore uses
 * `location.reload()` (after moving the URL to the target if it differs),
 * which always reloads.
 */
function loadFresh(win: Window, target: string): void {
  let current: URL;
  let next: URL;
  try {
    current = new URL(win.location.href);
    next = new URL(target, current);
  } catch {
    win.location.assign(target);
    return;
  }
  if (withoutHash(next) !== withoutHash(current)) {
    win.location.assign(target);
    return;
  }
  if (next.href !== current.href) {
    try {
      win.history.replaceState(win.history.state, "", next.href);
    } catch {
      // Reloading the current URL still beats no reload at all.
    }
  }
  win.location.reload();
}

export interface ChunkReloadOptions {
  win?: Window;
  router?: ChunkReloadRouter | null;
  /** A chunk failed outside a navigation: tell the user a new version is
   *  live instead of reloading under them. */
  onStaleChunk?: () => void;
}

/** Wires `vite:preloadError` and unhandled dynamic-import rejections to
 *  navigation-only, loop-guarded reloads. Returns an uninstall function. */
export function installChunkReloadHandlers({
  win = window,
  router = null,
  onStaleChunk,
}: ChunkReloadOptions = {}): () => void {
  const handle = (): boolean => {
    const target = chunkReloadTarget(router, win.location.href);
    if (target == null) {
      onStaleChunk?.();
      return false;
    }
    if (!claimChunkReload(safeSessionStorage(win))) return false;
    loadFresh(win, target);
    return true;
  };

  const onPreloadError = (event: Event) => {
    // Only swallow the error when we actually reload; otherwise let it
    // reach the route error UI / component so the user sees something.
    // preventDefault() makes vite resolve the import to undefined instead
    // of rejecting, so route chunks must load via lazyRoute (lazy-route.tsx).
    if (handle()) event.preventDefault();
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    if (isChunkLoadError(event.reason) && handle()) event.preventDefault();
  };

  win.addEventListener("vite:preloadError", onPreloadError);
  win.addEventListener("unhandledrejection", onRejection);
  return () => {
    win.removeEventListener("vite:preloadError", onPreloadError);
    win.removeEventListener("unhandledrejection", onRejection);
  };
}
