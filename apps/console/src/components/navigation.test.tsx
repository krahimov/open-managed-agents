import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server } from "../mocks/server";
import { ROUTE_CHORDS } from "../lib/route-chords";
import { useServerFeatures } from "../lib/server-features";
import { PRIMARY_NAV, WORKSPACE_NAV, useNavigation } from "./navigation";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), info: vi.fn(), success: vi.fn() }) }));

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const GATED = ["/operations", "/usage", "/runtimes", "/workspace"];

function render() {
  return renderHook(() => ({ nav: useNavigation(), features: useServerFeatures() }), { wrapper });
}

describe("useNavigation", () => {
  it("shows every destination on a server that has every feature", async () => {
    // The default handler answers every feature on.
    const { result } = render();
    await waitFor(() => expect(result.current.features.data).toBeDefined());
    const paths = result.current.nav.items.map((i) => i.to);
    for (const p of GATED) expect(paths).toContain(p);
    expect(result.current.nav.primary.map((i) => i.label)).toEqual(["Home", "Agents", "Sessions", "Operations"]);
    expect(result.current.nav.shows("/operations")).toBe(true);
  });

  it("leaves out Operations, Usage, Local runtimes and Workspace on a server without them, and their chords", async () => {
    server.use(http.get("*/v1/server_features", () => HttpResponse.json({ features: [] })));
    const { result } = render();
    await waitFor(() => expect(result.current.features.data).toBeDefined());
    const { nav } = result.current;
    const paths = nav.items.map((i) => i.to);
    for (const p of GATED) {
      expect(paths).not.toContain(p);
      expect(nav.shows(p)).toBe(false);
    }
    expect(nav.primary.map((i) => i.label)).toEqual(["Home", "Agents", "Sessions"]);
    // Everything else is still there, with its chord.
    for (const p of ["/", "/agents", "/sessions", "/files", "/evals", "/vaults", "/api-keys"]) {
      expect(paths).toContain(p);
      expect(nav.shows(p)).toBe(true);
    }
    expect(Object.keys(ROUTE_CHORDS).filter((p) => !nav.shows(p)).sort()).toEqual([...GATED].sort());
    // A group keeps its other destinations.
    expect(nav.groups.find((g) => g.id === "settings")?.items.map((i) => i.label)).toEqual(["API keys"]);
  });

  it("shows only what this release's server lists (workspace access and usage)", async () => {
    server.use(http.get("*/v1/server_features", () => HttpResponse.json({ features: ["workspace_access", "usage"] })));
    const { result } = render();
    await waitFor(() => expect(result.current.features.data).toBeDefined());
    const paths = result.current.nav.items.map((i) => i.to);
    expect(paths).toContain("/usage");
    expect(paths).toContain("/workspace");
    expect(paths).not.toContain("/operations");
    expect(paths).not.toContain("/runtimes");
  });

  it("holds the gated destinations back while the feature list is loading", () => {
    server.use(http.get("*/v1/server_features", () => new Promise(() => {})));
    const { result } = render();
    for (const p of GATED) expect(result.current.nav.shows(p)).toBe(false);
    expect(result.current.nav.items.map((i) => i.to)).toContain("/agents");
  });

  it("gates exactly the destinations whose endpoints only some servers have", () => {
    const gated = [...PRIMARY_NAV, ...WORKSPACE_NAV.flatMap((g) => g.items)].filter((i) => i.feature).map((i) => i.to);
    expect(gated.sort()).toEqual([...GATED].sort());
  });
});
