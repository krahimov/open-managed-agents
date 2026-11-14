import { http, HttpResponse, type HttpHandler } from "msw";
import { SERVER_FEATURE_KEYS } from "../lib/server-features";

// MSW handlers shared across the whole test suite. Tests opt in to
// specific responses with `server.use(http.get(...))` rather than
// relying on a big global registry, so this list stays small — only
// add a handler here when many tests would otherwise duplicate it.
export const handlers: HttpHandler[] = [
  // Feature detection (lib/server-features.ts). By default a test runs
  // against a server that has every feature, which is what Muse's tests
  // were written for. A test of a hidden surface overrides it, e.g.
  // `server.use(http.get("*/v1/server_features", () => HttpResponse.json({ features: [] })))`.
  http.get("*/v1/server_features", () => HttpResponse.json({ features: [...SERVER_FEATURE_KEYS] })),
];
