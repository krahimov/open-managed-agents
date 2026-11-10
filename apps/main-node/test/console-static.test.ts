// Console static serving: cache headers + /assets 404 instead of the SPA
// fallback (stale tabs must fail loudly on old chunk hashes so the
// console's chunk-reload handler can recover).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import {
  ASSET_CACHE_CONTROL,
  HTML_CACHE_CONTROL,
  consoleRootRel,
  mountConsoleUi,
} from "../src/lib/console-static";

const INDEX = `<!DOCTYPE html><html><head><script type="module" crossorigin src="/assets/index-NEW.js"></script></head><body></body></html>`;

let dir: string;
let app: Hono;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "oma-console-static-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), INDEX);
  writeFileSync(join(dir, "assets", "index-NEW.js"), "export {};");
  writeFileSync(join(dir, "logo.svg"), "<svg/>");
  app = new Hono();
  app.get("/v1/ping", (c) => c.json({ ok: true }));
  mountConsoleUi(app, dir); // absolute path, like CONSOLE_DIR in prod
  app.notFound((c) => c.json({ error: "not found" }, 404));
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("mountConsoleUi", () => {
  it("serves / as index.html with no-cache", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(res.headers.get("cache-control")).toBe(HTML_CACHE_CONTROL);
    expect(await res.text()).toBe(INDEX);
  });

  it("serves SPA routes via the index.html fallback with no-cache", async () => {
    const res = await app.request("/sessions/sess_123");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(HTML_CACHE_CONTROL);
    expect(await res.text()).toBe(INDEX);
  });

  it("serves hashed assets as immutable", async () => {
    const res = await app.request("/assets/index-NEW.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/javascript/);
    expect(res.headers.get("cache-control")).toBe(ASSET_CACHE_CONTROL);
    expect(await res.text()).toBe("export {};");
  });

  it("404s unknown /assets paths instead of falling back to index.html", async () => {
    for (const path of ["/assets/index-OLD.js", "/assets/SessionDetail-gone.js", "/assets/"]) {
      const res = await app.request(path);
      expect(res.status, path).toBe(404);
      expect(res.headers.get("cache-control"), path).toBe("no-store");
      expect(await res.text(), path).not.toContain("<!DOCTYPE html>");
    }
  });

  it("HEAD on assets mirrors GET", async () => {
    expect((await app.request("/assets/index-OLD.js", { method: "HEAD" })).status).toBe(404);
    const ok = await app.request("/assets/index-NEW.js", { method: "HEAD" });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe(ASSET_CACHE_CONTROL);
  });

  it("leaves other static files and earlier API routes alone", async () => {
    const logo = await app.request("/logo.svg");
    expect(logo.status).toBe(200);
    expect(logo.headers.get("cache-control")).toBeNull();
    const api = await app.request("/v1/ping");
    expect(await api.json()).toEqual({ ok: true });
  });
});

describe("consoleRootRel", () => {
  it("relativizes absolute dirs against cwd and keeps relative ones", () => {
    expect(consoleRootRel("/srv/console/dist", "/srv")).toBe("console/dist");
    expect(consoleRootRel("/srv", "/srv")).toBe(".");
    expect(consoleRootRel("../console/dist", "/srv")).toBe("../console/dist");
  });
});
