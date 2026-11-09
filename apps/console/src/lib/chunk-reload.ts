/**
 * Stale-chunk recovery. After a deploy every hashed chunk is replaced; a tab
 * opened before it still references the old ones, and lazy routes (Session
 * detail, Agent setup, ...) fail to load. main-node returns 404 for unknown
 * /assets/* paths, so the import fails loudly — we then reload once to pick
 * up the fresh index.html. A sessionStorage timestamp keeps a persistently
 * broken deploy from turning into a reload loop.
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

/** Wires `vite:preloadError` and unhandled dynamic-import rejections to a
 *  guarded single reload. Returns an uninstall function. */
export function installChunkReloadHandlers(win: Window = window): () => void {
  const tryReload = (): boolean => {
    if (!claimChunkReload(safeSessionStorage(win))) return false;
    win.location.reload();
    return true;
  };

  const onPreloadError = (event: Event) => {
    // Only swallow the error when we actually reload; otherwise let it
    // reach the route error UI so the user sees something.
    if (tryReload()) event.preventDefault();
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    if (isChunkLoadError(event.reason) && tryReload()) event.preventDefault();
  };

  win.addEventListener("vite:preloadError", onPreloadError);
  win.addEventListener("unhandledrejection", onRejection);
  return () => {
    win.removeEventListener("vite:preloadError", onPreloadError);
    win.removeEventListener("unhandledrejection", onRejection);
  };
}
