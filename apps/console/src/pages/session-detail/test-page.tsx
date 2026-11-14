/**
 * Shared rig for the SessionDetail page tests (files, approvals, agent
 * link): the real page under a router and a query client, with `useApi`
 * answered by a mock the test controls (`api`, hoisted by each test file
 * and passed in) and everything else over msw.
 *
 * `history` is the stored event log the page reads on load; POSTs made
 * through api() are recorded in order. Reads the page makes that a test
 * does not care about (names, lists, the model picker) get a quiet empty
 * answer, the way a server with nothing to say would.
 */
import type { ReactNode } from "react";
import { render } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import type { Mock } from "vitest";

import { server } from "../../mocks/server";
import { SessionDetail } from "../SessionDetail";

export interface PageRig {
  history: Array<Record<string, unknown>>;
  posts: Array<{ path: string; body: unknown }>;
  /** Answer for a POST; default `{}`. Throw to fail it. */
  onPost: (path: string, body: unknown) => unknown;
  /** Extra GET answers, checked first. Return undefined to fall through. */
  onGet: (path: string) => unknown;
  session: Record<string, unknown>;
}

export function rigApi(api: Mock, rig: PageRig) {
  api.mockReset();
  api.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method && init.method !== "GET") {
      const body = init.body instanceof FormData ? init.body : init.body ? JSON.parse(String(init.body)) : undefined;
      rig.posts.push({ path, body });
      return rig.onPost(path, body);
    }
    const own = rig.onGet(path);
    if (own !== undefined) return own;
    if (path === "/v1/server_features") return { features: ["workspace_access", "usage"] };
    if (path.startsWith("/v1/sessions/sess-1/events")) {
      return { data: rig.history.map((data, i) => ({ seq: i + 1, type: data.type, data })), has_more: false };
    }
    if (path === "/v1/sessions/sess-1") return rig.session;
    if (path.endsWith("/trajectory")) return { outcome: "success" };
    if (path.endsWith("/threads") || path.endsWith("/pending")) return { data: [] };
    if (path === "/v1/workspace/access") return { authorization: { role: "owner", kind: "session" }, budgets_supported: false };
    return { data: [] };
  });
  // lib/server-features reads over msw (it is loaded before the mock).
  server.use(http.get("*/v1/server_features", () => HttpResponse.json({ features: ["workspace_access", "usage"] })));
}

export function newRig(): PageRig {
  return {
    history: [],
    posts: [],
    onPost: () => ({}),
    onGet: () => undefined,
    session: { id: "sess-1", status: "idle", agent: { id: "agent-1", name: "QA agent" } },
  };
}

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

export function mountSession(extraRoutes?: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/sessions/sess-1"]}>
        <Where />
        <Routes>
          <Route path="/sessions/:id" element={<SessionDetail />} />
          {extraRoutes}
          <Route path="*" element={<div>WRONG ROUTE</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** jsdom lacks what the conversation scroller and object URLs need. */
export function installDomShims() {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollTo ??= function () {};
  Element.prototype.scrollIntoView ??= function () {};
}
