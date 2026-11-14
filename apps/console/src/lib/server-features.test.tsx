import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server } from "../mocks/server";
import { ApiError, NOT_ON_SERVER_CODE, useApi } from "./api";
import { SERVER_FEATURE_KEYS, useServerFeature, useServerFeatures } from "./server-features";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), info: vi.fn(), success: vi.fn() }) }));

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const page = () => new HttpResponse("<!doctype html><html><body>app</body></html>", { headers: { "content-type": "text/html" } });

describe("api() on a server whose console fallback answers unknown /v1 paths", () => {
  it("turns a 200 text/html body into ApiError 404 not_on_server", async () => {
    server.use(http.get("*/v1/operations", page));
    const { result } = renderHook(() => useApi());
    const err = await result.current.api("/v1/operations", { silentErrors: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
    expect((err as ApiError).code).toBe(NOT_ON_SERVER_CODE);
  });

  it("still parses JSON and empty bodies", async () => {
    server.use(
      http.get("*/v1/agents", () => HttpResponse.json({ data: [] })),
      http.post("*/v1/sessions/s1/events", () => new HttpResponse(null, { status: 202 })),
    );
    const { result } = renderHook(() => useApi());
    expect(await result.current.api("/v1/agents")).toEqual({ data: [] });
    expect(await result.current.api("/v1/sessions/s1/events", { method: "POST", body: "{}" })).toBeUndefined();
  });
});

describe("useServerFeature", () => {
  it("reads the server's list", async () => {
    server.use(http.get("*/v1/server_features", () => HttpResponse.json({ features: ["usage", "workspace_access", "nonsense"] })));
    const { result } = renderHook(() => ({ all: useServerFeatures(), usage: useServerFeature("usage"), ops: useServerFeature("operations") }), { wrapper });
    await waitFor(() => expect(result.current.all.data).toBeDefined());
    expect(result.current.all.data?.source).toBe("server");
    expect(result.current.usage).toBe(true);
    expect(result.current.ops).toBe(false);
    expect([...(result.current.all.data?.features ?? [])].sort()).toEqual(["usage", "workspace_access"]);
  });

  it("is off while loading", () => {
    const { result } = renderHook(() => useServerFeature("usage"), { wrapper });
    expect(result.current).toBe(false);
  });

  it("on an older server (no list, app page for unknown paths) turns on only what a quiet GET confirms", async () => {
    server.use(
      http.get("*/v1/server_features", page),
      http.get("*/v1/workspace/access", () => HttpResponse.json({ authorization: { role: "owner", kind: "session" }, budgets_supported: false })),
      http.get("*/v1/usage", () => HttpResponse.json({ totals: {} })),
      http.get("*/v1/operations", page),
      http.get("*/v1/workspace/members", () => HttpResponse.json({ error: { type: "not_found", message: "Not found" } }, { status: 404 })),
      http.get("*/v1/workspace/budgets", page),
      http.get("*/v1/evals/comparisons", () => new HttpResponse(null, { status: 501 })),
    );
    const { result } = renderHook(() => useServerFeatures(), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.source).toBe("probe");
    expect([...(result.current.data?.features ?? [])].sort()).toEqual(["usage", "workspace_access"]);
  });

  it("the default test handler turns every feature on", async () => {
    const { result } = renderHook(() => useServerFeatures(), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.features.size).toBe(SERVER_FEATURE_KEYS.length);
  });
});
