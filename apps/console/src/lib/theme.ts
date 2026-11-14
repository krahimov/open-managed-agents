import { useCallback, useEffect, useSyncExternalStore } from "react";

export type Theme = "light" | "dark" | "system";

/**
 * Theme: Light, Dark or System, kept in `localStorage.theme` (absent means
 * System) and applied as `.dark` on <html>.
 *
 * One shared store, not per-component state: the account menu, the command
 * palette, the sign-in pages and the toaster all read the same value, so a
 * change made in one is reflected in the others at once.
 */
function getEffective(theme: Theme): "light" | "dark" {
  if (theme === "system") {
    return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return theme;
}

function apply(effective: "light" | "dark") {
  document.documentElement.classList.toggle("dark", effective === "dark");
}

function read(): Theme {
  try {
    const stored = localStorage.getItem("theme");
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

const listeners = new Set<() => void>();
let current: Theme = typeof window === "undefined" ? "system" : read();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function setStoredTheme(next: Theme) {
  current = next;
  try {
    if (next === "system") localStorage.removeItem("theme");
    else localStorage.setItem("theme", next);
  } catch {
    // storage unavailable — the choice lasts for this page only
  }
  apply(getEffective(next));
  listeners.forEach((l) => l());
}

export function useTheme() {
  const theme = useSyncExternalStore(
    subscribe,
    () => current,
    () => "system" as Theme,
  );
  const effective = getEffective(theme);

  const setTheme = useCallback((t: Theme) => setStoredTheme(t), []);

  // Follow the system preference while in "system" mode.
  useEffect(() => {
    if (theme !== "system") return;
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      apply(getEffective("system"));
      listeners.forEach((l) => l());
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [theme]);

  // Apply on mount (index.html does it before first paint; this keeps the
  // class right if the stored value changed in another tab).
  useEffect(() => {
    apply(effective);
  }, [effective]);

  return { theme, effective, setTheme } as const;
}
