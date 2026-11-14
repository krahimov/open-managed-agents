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
  // Mirrors index.ts: an authenticated v1 sub-app with its own middleware,
  // mounted before the console, plus app-level /v1/oma and /public/v1 mounts.
  const v1 = new Hono();
  v1.use("*", async (c, next) => {
    if (c.req.header("x-test-auth") === "deny") return c.json({ error: "Unauthorized" }, 401);
    await next();
  });
  v1.get("/ping", (c) => c.json({ ok: true }));
  app.route("/v1", v1);
  app.get("/v1/oma/me", (c) => c.json({ me: true }));
  app.get("/public/v1/hello", (c) => c.json({ hello: true }));
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

describe("unknown API paths", () => {
  const unknown = ["/v1/x", "/v1/oma/x", "/public/v1/x", "/v1/operations", "/v1/workspace/members", "/v1/"];

  it("answer GET with a JSON 404, never the console page", async () => {
    for (const path of unknown) {
      const res = await app.request(path);
      expect(res.status, path).toBe(404);
      expect(res.headers.get("content-type"), path).toMatch(/application\/json/);
      expect(res.headers.get("cache-control"), path).toBe("no-store");
      expect(await res.json(), path).toEqual({ error: "not found" });
    }
  });

  it("answer other methods with a JSON 404 too", async () => {
    for (const method of ["POST", "PUT", "DELETE", "HEAD"]) {
      const res = await app.request("/v1/missions", { method });
      expect(res.status, method).toBe(404);
      expect(res.headers.get("content-type") ?? "", method).not.toMatch(/text\/html/);
    }
  });

  it("keep the v1 middleware in front, so an unauthenticated request is still a 401", async () => {
    const res = await app.request("/v1/x", { headers: { "x-test-auth": "deny" } });
    expect(res.status).toBe(401);
  });

  it("leave known API routes and look-alike console routes alone", async () => {
    expect(await (await app.request("/v1/ping")).json()).toEqual({ ok: true });
    expect(await (await app.request("/v1/oma/me")).json()).toEqual({ me: true });
    expect(await (await app.request("/public/v1/hello")).json()).toEqual({ hello: true });
    // Console routes that merely start with "v1" text still get the page.
    for (const path of ["/v1x", "/public/v1x", "/public"]) {
      const res = await app.request(path);
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).toBe(INDEX);
    }
  });
});

describe("consoleRootRel", () => {
  it("relativizes absolute dirs against cwd and keeps relative ones", () => {
    expect(consoleRootRel("/srv/console/dist", "/srv")).toBe("console/dist");
    expect(consoleRootRel("/srv", "/srv")).toBe(".");
    expect(consoleRootRel("../console/dist", "/srv")).toBe("../console/dist");
  });
});
