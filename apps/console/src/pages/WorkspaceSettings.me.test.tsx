import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { http, HttpResponse } from "msw";

import { WorkspaceSettings } from "./WorkspaceSettings";
import { server } from "../mocks/server";
import { SERVER_FEATURES_QUERY_KEY } from "../lib/server-features";

vi.mock("../lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/auth")>()),
  useAuth: () => ({ user: { id: "user_1", name: "Milo Member", email: "milo@example.test" }, isLoading: false, isAuthenticated: true }),
}));

describe("Workspace settings when /v1/me leaves the name out", () => {
  it("names you from the signed-in user, never as a bare question mark", async () => {
    server.use(
      http.get("*/v1/me", () => HttpResponse.json({ user: { id: "user_1", email: "", name: "" }, tenant: { id: "t1", name: "Fabrik Labs" } })),
      http.get("*/v1/workspace/access", () => HttpResponse.json({ authorization: { role: "admin", kind: "session" }, budgets_supported: false })),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(SERVER_FEATURES_QUERY_KEY, { features: new Set(["workspace_access", "usage"]), source: "server" });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <WorkspaceSettings />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText("Milo Member")).toBeInTheDocument();
    expect(screen.getByText("milo@example.test")).toBeInTheDocument();
  });
});
