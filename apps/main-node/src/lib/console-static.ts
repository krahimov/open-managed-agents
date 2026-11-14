// Console UI static serving (CONSOLE_DIR).
//
// Cache policy is what lets long-lived tabs notice deploys:
//   - index.html (and the SPA fallback) → `no-cache`: browsers always
//     revalidate, so the console's update check and every fresh load see
//     the current entry-script hash.
//   - /assets/* (Vite's content-hashed chunks) → immutable for a year.
//   - /assets/<anything that doesn't exist> → 404, never the SPA
//     index.html. A stale tab lazy-loading an old chunk must fail loudly
//     (HTML-as-JS fails obscurely) so the console's chunk-reload handler
//     can recover by reloading once.
//   - /v1/* and /public/v1/* that no API route answered → JSON 404, never
//     the SPA index.html. The console reads a missing endpoint as "this
//     server doesn't have that"; a 200 web page in its place looks like a
//     broken answer. (The v1 auth middleware still runs first, so an
//     unauthenticated request for an unknown path is a 401.)

import { relative } from "node:path";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";

export const HTML_CACHE_CONTROL = "no-cache";
export const ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";

/** serveStatic resolves `root` against cwd; accept absolute dirs too. */
export function consoleRootRel(consoleDir: string, cwd: string = process.cwd()): string {
  return consoleDir.startsWith("/") ? relative(cwd, consoleDir) || "." : consoleDir;
}

/**
 * Runs a serveStatic middleware and stamps Cache-Control on the response it
 * returns. (serveStatic's own `onFound` hook fires after the Response is
 * built, so headers set there are dropped.)
 */
function withCacheControl(
  mw: MiddlewareHandler,
  value: (res: Response) => string | null,
): MiddlewareHandler {
  return async (c, next) => {
    const res = await mw(c, next);
    if (res instanceof Response) {
      const v = value(res);
      if (v) res.headers.set("Cache-Control", v);
    }
    return res;
  };
}

const isHtml = (res: Response) => /^text\/html\b/i.test(res.headers.get("content-type") ?? "");
const htmlNoCache = (res: Response) => (isHtml(res) ? HTML_CACHE_CONTROL : null);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mountConsoleUi(app: Hono<any>, consoleDir: string): string {
  const root = consoleRootRel(consoleDir);

  const apiNotFound = (c: Context) => {
    c.header("Cache-Control", "no-store");
    return c.json({ error: "not found" }, 404);
  };
  app.all("/v1/*", apiNotFound);
  app.all("/public/v1/*", apiNotFound);

  app.get(
    "/assets/*",
    withCacheControl(serveStatic({ root }), () => ASSET_CACHE_CONTROL),
    (c) => {
      c.header("Cache-Control", "no-store");
      return c.text("Not found", 404);
    },
  );
  app.use("/*", withCacheControl(serveStatic({ root }), htmlNoCache));
  app.get("/*", withCacheControl(serveStatic({ root, path: "index.html" }), htmlNoCache));
  return root;
}
