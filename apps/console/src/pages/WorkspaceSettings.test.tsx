import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { http, HttpResponse } from "msw";

import { WorkspaceSettings } from "./WorkspaceSettings";
import { server } from "../mocks/server";
import { SERVER_FEATURES_QUERY_KEY, type ServerFeature } from "../lib/server-features";

const ME = { user: { id: "user_1", email: "ada@example.test", name: "Ada Lovelace" }, tenant: { id: "default", name: "Fabrik Labs" } };

function show(features: ServerFeature[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(SERVER_FEATURES_QUERY_KEY, { features: new Set(features), source: "server" });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <WorkspaceSettings />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Workspace settings on a server without members, limits or history", () => {
  it("shows who you are, read-only, and asks for nothing the server does not keep", async () => {
    const asked: string[] = [];
    server.use(
      http.get("*/v1/me", () => HttpResponse.json(ME)),
      http.get("*/v1/workspace/access", () => HttpResponse.json({ authorization: { role: "admin", kind: "session" }, budgets_supported: false })),
      http.get("*/v1/workspace/*", ({ request }) => {
        asked.push(new URL(request.url).pathname);
        return HttpResponse.json({ error: "not found" }, { status: 404 });
      }),
    );
    show(["workspace_access", "usage"]);

    expect(await screen.findByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("You")).toBeInTheDocument();
    expect(screen.getByText("Administrator")).toBeInTheDocument();
    // No role picker, no limits, no history.
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByText("Execution limits")).not.toBeInTheDocument();
    expect(screen.queryByText(/history/i)).not.toBeInTheDocument();
    expect(screen.getByText(/does not list the other members/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(asked).toEqual([]);
  });

  it("without roles at all, says everyone signed in can manage the workspace", async () => {
    server.use(http.get("*/v1/me", () => HttpResponse.json(ME)));
    show(["usage"]);
    expect(await screen.findByText(/keeps no workspace roles/)).toBeInTheDocument();
    expect(await screen.findByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.queryByText("Members")).not.toBeInTheDocument();
  });
});
