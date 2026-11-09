import { describe, expect, it, vi } from "vitest";
import {
  createUpdateChecker,
  currentEntryScript,
  extractEntryScript,
  isNewVersion,
} from "./app-version";

const builtIndex = (hash: string) => `<!DOCTYPE html>
<html lang="en">
  <head>
    <script>
      const t = localStorage.getItem("theme");
    </script>
    <script type="module" crossorigin src="/assets/index-${hash}.js"></script>
    <link rel="modulepreload" crossorigin href="/assets/vendor-abc.js">
    <link rel="stylesheet" crossorigin href="/assets/index-${hash}.css">
  </head>
  <body><div id="root"></div></body>
</html>`;

describe("extractEntryScript", () => {
  it("returns the module entry script from a built index.html", () => {
    expect(extractEntryScript(builtIndex("D4x9Kq"))).toBe("/assets/index-D4x9Kq.js");
  });

  it("ignores inline and classic scripts", () => {
    const html = `<script>1</script><script src="/legacy.js"></script>
      <script src='/assets/index-AAA.js' type='module'></script>`;
    expect(extractEntryScript(html)).toBe("/assets/index-AAA.js");
  });

  it("normalizes absolute URLs to a pathname", () => {
    const html = `<script type="module" src="https://app.example.com/assets/index-X.js"></script>`;
    expect(extractEntryScript(html)).toBe("/assets/index-X.js");
  });

  it("returns null when there is no module entry (error page, JSON)", () => {
    expect(extractEntryScript("<html><body>502 Bad Gateway</body></html>")).toBeNull();
    expect(extractEntryScript('{"error":"not found"}')).toBeNull();
  });
});

describe("currentEntryScript", () => {
  it("reads the entry script from the live document", () => {
    const doc = document.implementation.createHTMLDocument("t");
    doc.head.innerHTML = `<script type="module" crossorigin src="/assets/index-OLD.js"></script>`;
    expect(currentEntryScript(doc)).toBe("/assets/index-OLD.js");
  });

  it("returns null without a module script", () => {
    const doc = document.implementation.createHTMLDocument("t");
    expect(currentEntryScript(doc)).toBeNull();
  });
});

describe("isNewVersion", () => {
  it("is true only when both are known and differ", () => {
    expect(isNewVersion("/assets/index-A.js", "/assets/index-B.js")).toBe(true);
    expect(isNewVersion("/assets/index-A.js", "/assets/index-A.js")).toBe(false);
    expect(isNewVersion(null, "/assets/index-B.js")).toBe(false);
    expect(isNewVersion("/assets/index-A.js", null)).toBe(false);
  });
});

describe("createUpdateChecker", () => {
  function setup(opts: { current?: string | null; html?: string | (() => string) } = {}) {
    let t = 0;
    const html = opts.html ?? builtIndex("NEW");
    const fetchHtml = vi.fn(async () => (typeof html === "function" ? html() : html));
    const onUpdate = vi.fn();
    const checker = createUpdateChecker({
      current: opts.current === undefined ? "/assets/index-OLD.js" : opts.current,
      fetchHtml,
      onUpdate,
      minIntervalMs: 1000,
      now: () => t,
    });
    return { checker, fetchHtml, onUpdate, advance: (ms: number) => (t += ms) };
  }

  it("announces a newer build", async () => {
    const { checker, onUpdate } = setup();
    await checker.check();
    expect(onUpdate).toHaveBeenCalledWith("/assets/index-NEW.js");
  });

  it("stays quiet when the live build matches", async () => {
    const { checker, onUpdate } = setup({ html: builtIndex("OLD") });
    await checker.check();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("announces the same build only once", async () => {
    const { checker, onUpdate, advance } = setup();
    await checker.check();
    advance(5000);
    await checker.check();
    await checker.check({ force: true });
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it("announces again for a subsequent, different build", async () => {
    let hash = "NEW1";
    const { checker, onUpdate } = setup({ html: () => builtIndex(hash) });
    await checker.check({ force: true });
    hash = "NEW2";
    await checker.check({ force: true });
    expect(onUpdate.mock.calls).toEqual([["/assets/index-NEW1.js"], ["/assets/index-NEW2.js"]]);
  });

  it("throttles non-forced checks", async () => {
    const { checker, fetchHtml, advance } = setup({ html: builtIndex("OLD") });
    await checker.check();
    await checker.check();
    expect(fetchHtml).toHaveBeenCalledTimes(1);
    advance(1000);
    await checker.check();
    expect(fetchHtml).toHaveBeenCalledTimes(2);
    await checker.check({ force: true });
    expect(fetchHtml).toHaveBeenCalledTimes(3);
  });

  it("dedupes concurrent checks", async () => {
    const { checker, fetchHtml } = setup({ html: builtIndex("OLD") });
    await Promise.all([checker.check({ force: true }), checker.check({ force: true })]);
    expect(fetchHtml).toHaveBeenCalledTimes(1);
  });

  it("swallows fetch failures and unparseable responses", async () => {
    const onUpdate = vi.fn();
    const failing = createUpdateChecker({
      current: "/assets/index-OLD.js",
      fetchHtml: async () => {
        throw new TypeError("Failed to fetch");
      },
      onUpdate,
    });
    await expect(failing.check()).resolves.toBeUndefined();
    const { checker, onUpdate: onUpdate2 } = setup({ html: "<html>Bad Gateway</html>" });
    await checker.check();
    expect(onUpdate).not.toHaveBeenCalled();
    expect(onUpdate2).not.toHaveBeenCalled();
  });

  it("is a no-op when the current build is unknown", async () => {
    const { checker, fetchHtml, onUpdate } = setup({ current: null });
    await checker.check({ force: true });
    expect(fetchHtml).not.toHaveBeenCalled();
    expect(onUpdate).not.toHaveBeenCalled();
  });
});
