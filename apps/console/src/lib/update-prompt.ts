import { toast } from "sonner";
import { createUpdateChecker, currentEntryScript } from "./app-version";

const POLL_INTERVAL_MS = 5 * 60_000;
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

function showUpdateToast() {
  // Persistent and non-blocking: the user reloads when they're ready, so
  // nothing they're typing gets thrown away. Same id → never stacks.
  toast("Orrery was updated", {
    id: TOAST_ID,
    description: "Reload to get the latest version.",
    duration: Infinity,
    action: { label: "Reload", onClick: () => window.location.reload() },
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
    onUpdate: showUpdateToast,
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
