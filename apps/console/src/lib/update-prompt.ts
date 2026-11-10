import { toast } from "sonner";
import { createUpdateChecker, currentEntryScript } from "./app-version";
import { sessionStoreOf, stashDrafts } from "./composer-draft";

const POLL_INTERVAL_MS = 5 * 60_000;
/** How long "Later" / close keeps the prompt away before it comes back. */
const SNOOZE_MS = 15 * 60_000;
const TOAST_ID = "oma-app-update";

interface RouterLike {
  subscribe: (fn: (state: { location: { pathname: string; search: string } }) => void) => () => void;
}

async function fetchIndexHtml(): Promise<string> {
  const res = await fetch("/", {
    cache: "no-store",
    credentials: "same-origin",
    headers: { Accept: "text/html" },
  });
  if (!res.ok) throw new Error(`index.html ${res.status}`);
  return res.text();
}

/**
 * Reloads the tab without losing unsent composer text: drafts are stashed
 * in sessionStorage and restored by the composer after the reload. If a
 * draft can't be stashed (storage blocked/full), asks first. Returns false
 * when the user chose to stay.
 */
export function reloadKeepingDrafts(win: Window = window): boolean {
  if (
    !stashDrafts(win.document, sessionStoreOf(win)) &&
    !win.confirm("Your unsent message can't be kept across a reload. Reload anyway?")
  ) {
    return false;
  }
  win.location.reload();
  return true;
}

/**
 * Persistent, non-blocking "new version" prompt. The user reloads when
 * they're ready (unsent text is kept), or dismisses it with "Later" / the
 * close button — `onSnooze` then lets the checker bring it back. Shown at
 * the top so it never covers the composer / model picker at the bottom
 * right. Same id → never stacks.
 */
export function showUpdateToast(opts: { onSnooze?: () => void } = {}) {
  toast("Orrery was updated", {
    id: TOAST_ID,
    description: "A new version is available. Reload when you're ready — your unsent message is kept.",
    duration: Infinity,
    position: "top-center",
    closeButton: true,
    action: {
      label: "Reload",
      onClick: (event) => {
        // Staying (declined confirm) keeps the prompt up.
        if (!reloadKeepingDrafts()) event.preventDefault();
      },
    },
    cancel: { label: "Later", onClick: () => opts.onSnooze?.() },
    // Close button / swipe. ("Later" doesn't fire onDismiss in sonner.)
    onDismiss: () => opts.onSnooze?.(),
  });
}

/**
 * Watches for a newer console deploy: on tab focus / visibility, on route
 * navigation, and every 5 minutes while visible. Production builds only —
 * the dev server's entry is /src/main.tsx and HMR handles freshness.
 */
export function installUpdatePrompt(router: RouterLike): () => void {
  if (import.meta.env.DEV) return () => {};

  const checker = createUpdateChecker({
    current: currentEntryScript(),
    fetchHtml: fetchIndexHtml,
    onUpdate: (remote) => showUpdateToast({ onSnooze: () => checker.snooze(remote, SNOOZE_MS) }),
  });
  const visible = () => document.visibilityState === "visible";
  const onVisible = () => {
    if (visible()) void checker.check();
  };

  window.addEventListener("focus", onVisible);
  document.addEventListener("visibilitychange", onVisible);
  const timer = window.setInterval(() => {
    if (visible()) void checker.check({ force: true });
  }, POLL_INTERVAL_MS);

  let lastLocation = `${window.location.pathname}${window.location.search}`;
  const unsubscribe = router.subscribe(({ location }) => {
    const next = `${location.pathname}${location.search}`;
    if (next === lastLocation) return;
    lastLocation = next;
    void checker.check();
  });

  return () => {
    window.removeEventListener("focus", onVisible);
    document.removeEventListener("visibilitychange", onVisible);
    window.clearInterval(timer);
    unsubscribe();
  };
}
