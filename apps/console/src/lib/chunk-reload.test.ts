import { describe, expect, it, vi } from "vitest";
import {
  CHUNK_RELOAD_KEY,
  claimChunkReload,
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

describe("installChunkReloadHandlers", () => {
  function fakeWindow() {
    const target = new EventTarget();
    const storage = memoryStorage();
    const reload = vi.fn();
    const win = Object.assign(target, {
      sessionStorage: storage,
      location: { reload },
    }) as unknown as Window;
    return { win, reload };
  }

  it("reloads once on vite:preloadError and then stops", () => {
    const { win, reload } = fakeWindow();
    const uninstall = installChunkReloadHandlers(win);
    const first = new Event("vite:preloadError", { cancelable: true });
    win.dispatchEvent(first);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(first.defaultPrevented).toBe(true);

    // A second failure right after the reload must not loop — and the
    // error is left to propagate to the route error UI.
    const second = new Event("vite:preloadError", { cancelable: true });
    win.dispatchEvent(second);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(second.defaultPrevented).toBe(false);
    uninstall();
  });

  it("reloads on an unhandled dynamic-import rejection only", () => {
    const { win, reload } = fakeWindow();
    const uninstall = installChunkReloadHandlers(win);
    const rejection = (reason: unknown) => {
      const e = new Event("unhandledrejection", { cancelable: true });
      Object.defineProperty(e, "reason", { value: reason });
      return e;
    };
    win.dispatchEvent(rejection(new Error("boom")));
    expect(reload).not.toHaveBeenCalled();
    win.dispatchEvent(rejection(new TypeError("Failed to fetch dynamically imported module: /assets/x.js")));
    expect(reload).toHaveBeenCalledTimes(1);
    uninstall();
  });
});
