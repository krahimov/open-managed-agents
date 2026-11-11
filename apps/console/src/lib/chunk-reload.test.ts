import { describe, expect, it, vi } from "vitest";
import {
  CHUNK_RELOAD_KEY,
  chunkReloadTarget,
  claimChunkReload,
  type ChunkReloadRouter,
  installChunkReloadHandlers,
  isChunkLoadError,
} from "./chunk-reload";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    data,
  };
}

describe("claimChunkReload", () => {
  it("allows the first reload and records it", () => {
    const s = memoryStorage();
    expect(claimChunkReload(s, 100_000, 30_000)).toBe(true);
    expect(s.data.get(CHUNK_RELOAD_KEY)).toBe("100000");
  });

  it("refuses a second reload inside the window (loop guard)", () => {
    const s = memoryStorage();
    expect(claimChunkReload(s, 100_000, 30_000)).toBe(true);
    expect(claimChunkReload(s, 110_000, 30_000)).toBe(false);
    expect(claimChunkReload(s, 129_999, 30_000)).toBe(false);
    // The refused attempt doesn't extend the window.
    expect(s.data.get(CHUNK_RELOAD_KEY)).toBe("100000");
  });

  it("allows another reload once the window has passed", () => {
    const s = memoryStorage({ [CHUNK_RELOAD_KEY]: "100000" });
    expect(claimChunkReload(s, 130_000, 30_000)).toBe(true);
  });

  it("treats garbage or future timestamps as stale", () => {
    expect(claimChunkReload(memoryStorage({ [CHUNK_RELOAD_KEY]: "nope" }), 1000)).toBe(true);
    expect(claimChunkReload(memoryStorage({ [CHUNK_RELOAD_KEY]: "999999999" }), 1000)).toBe(true);
  });

  it("refuses when storage is missing or throws (can't guard a loop)", () => {
    expect(claimChunkReload(null, 1000)).toBe(false);
    const throwing = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {},
    };
    expect(claimChunkReload(throwing, 1000)).toBe(false);
  });
});

describe("isChunkLoadError", () => {
  it("recognizes browser dynamic-import failures", () => {
    expect(
      isChunkLoadError(new TypeError("Failed to fetch dynamically imported module: https://x/assets/a.js")),
    ).toBe(true);
    expect(isChunkLoadError(new TypeError("error loading dynamically imported module"))).toBe(true);
    expect(isChunkLoadError(new TypeError("Importing a module script failed."))).toBe(true);
    expect(isChunkLoadError(new Error("Unable to preload CSS for /assets/a.css"))).toBe(true);
  });

  it("ignores unrelated errors", () => {
    expect(isChunkLoadError(new Error("Network request failed"))).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
    expect(isChunkLoadError({ message: "Failed to fetch dynamically imported module" })).toBe(false);
  });
});

function fakeRouter(
  state: { initialized?: boolean; navigation?: { state: string; location?: unknown } } = {},
): ChunkReloadRouter & { state: { initialized: boolean; navigation: { state: string; location?: unknown } } } {
  return {
    state: {
      initialized: state.initialized ?? true,
      navigation: state.navigation ?? { state: "idle" },
    },
    createHref: ((loc: { pathname: string; search?: string; hash?: string }) =>
      `${loc.pathname}${loc.search ?? ""}${loc.hash ?? ""}`) as never,
  };
}

const navigatingTo = (pathname: string, search = "") =>
  ({ state: "loading", location: { pathname, search, hash: "" } }) as const;

describe("chunkReloadTarget", () => {
  it("targets the pending navigation's URL", () => {
    expect(chunkReloadTarget(fakeRouter({ navigation: navigatingTo("/sessions/s1", "?v=1") }), "http://x/agents")).toBe(
      "/sessions/s1?v=1",
    );
  });

  it("reloads the current URL while the router is still booting", () => {
    expect(chunkReloadTarget(fakeRouter({ initialized: false }), "http://x/sessions/s1")).toBe("http://x/sessions/s1");
  });

  it("refuses when idle (in-page chunk) or without a router", () => {
    expect(chunkReloadTarget(fakeRouter(), "http://x/sessions/s1")).toBeNull();
    expect(chunkReloadTarget(null, "http://x/sessions/s1")).toBeNull();
  });
});

describe("installChunkReloadHandlers", () => {
  function fakeWindow(href = "http://x/agents") {
    const target = new EventTarget();
    const storage = memoryStorage();
    const assign = vi.fn();
    const reload = vi.fn();
    const location = { href, assign, reload };
    const replaceState = vi.fn((_state: unknown, _unused: string, url: string) => {
      location.href = url;
    });
    const win = Object.assign(target, {
      sessionStorage: storage,
      location,
      history: { state: { key: "k1" }, replaceState },
    }) as unknown as Window;
    return { win, assign, reload, replaceState, location };
  }

  const rejection = (reason: unknown) => {
    const e = new Event("unhandledrejection", { cancelable: true });
    Object.defineProperty(e, "reason", { value: reason });
    return e;
  };

  it("loads the navigation target on a route-chunk failure, once", () => {
    const { win, assign, reload } = fakeWindow();
    const router = fakeRouter({ navigation: navigatingTo("/sessions/s1") });
    const onStaleChunk = vi.fn();
    const uninstall = installChunkReloadHandlers({ win, router, onStaleChunk });
    const first = new Event("vite:preloadError", { cancelable: true });
    win.dispatchEvent(first);
    expect(assign).toHaveBeenCalledWith("/sessions/s1");
    expect(reload).not.toHaveBeenCalled();
    expect(first.defaultPrevented).toBe(true);

    // A second failure right after must not loop — and the error is left
    // to propagate to the route error UI.
    const second = new Event("vite:preloadError", { cancelable: true });
    win.dispatchEvent(second);
    expect(assign).toHaveBeenCalledTimes(1);
    expect(second.defaultPrevented).toBe(false);
    expect(onStaleChunk).not.toHaveBeenCalled();
    uninstall();
  });

  it("never reloads for an in-page chunk (grammar, diagram, viewer) — prompts instead", () => {
    const { win, assign, reload } = fakeWindow();
    const onStaleChunk = vi.fn();
    const uninstall = installChunkReloadHandlers({ win, router: fakeRouter(), onStaleChunk });
    const e = new Event("vite:preloadError", { cancelable: true });
    win.dispatchEvent(e);
    win.dispatchEvent(rejection(new TypeError("Failed to fetch dynamically imported module: /assets/python-X.js")));
    expect(assign).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
    expect(onStaleChunk).toHaveBeenCalledTimes(2);
    uninstall();
  });

  it("handles unhandled dynamic-import rejections during navigation only", () => {
    const { win, assign } = fakeWindow();
    const router = fakeRouter({ navigation: navigatingTo("/agents/a1/setup") });
    const uninstall = installChunkReloadHandlers({ win, router });
    win.dispatchEvent(rejection(new Error("boom")));
    expect(assign).not.toHaveBeenCalled();
    win.dispatchEvent(rejection(new TypeError("Failed to fetch dynamically imported module: /assets/x.js")));
    expect(assign).toHaveBeenCalledWith("/agents/a1/setup");
    uninstall();
  });

  it("reloads (not assigns) a boot-time URL with a #fragment, which assign() would only scroll to", () => {
    const { win, assign, reload, replaceState } = fakeWindow("http://x/sessions/abc#evt-12");
    const uninstall = installChunkReloadHandlers({ win, router: fakeRouter({ initialized: false }) });
    const e = new Event("vite:preloadError", { cancelable: true });
    win.dispatchEvent(e);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(assign).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
    uninstall();
  });

  it("moves to a pending same-document #fragment target, then reloads", () => {
    const { win, assign, reload, replaceState, location } = fakeWindow("http://x/sessions/abc");
    const router = fakeRouter({
      navigation: { state: "loading", location: { pathname: "/sessions/abc", search: "", hash: "#evt-3" } },
    });
    const uninstall = installChunkReloadHandlers({ win, router });
    win.dispatchEvent(new Event("vite:preloadError", { cancelable: true }));
    expect(replaceState).toHaveBeenCalledWith({ key: "k1" }, "", "http://x/sessions/abc#evt-3");
    expect(location.href).toBe("http://x/sessions/abc#evt-3");
    expect(reload).toHaveBeenCalledTimes(1);
    expect(assign).not.toHaveBeenCalled();
    uninstall();
  });

  it("still assigns a pending target that is another page, even from a URL with a #fragment", () => {
    const { win, assign, reload } = fakeWindow("http://x/sessions/abc#evt-12");
    const uninstall = installChunkReloadHandlers({ win, router: fakeRouter({ navigation: navigatingTo("/agents/a1/setup") }) });
    win.dispatchEvent(new Event("vite:preloadError", { cancelable: true }));
    expect(assign).toHaveBeenCalledWith("/agents/a1/setup");
    expect(reload).not.toHaveBeenCalled();
    uninstall();
  });

  it("does nothing without a router", () => {
    const { win, assign, reload } = fakeWindow();
    const uninstall = installChunkReloadHandlers({ win });
    win.dispatchEvent(new Event("vite:preloadError", { cancelable: true }));
    expect(assign).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    uninstall();
  });
});
