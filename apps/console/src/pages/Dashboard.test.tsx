import { beforeAll, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { http, HttpResponse } from "msw";

import { Dashboard, homeProblems, listWords } from "./Dashboard";
import { server } from "../mocks/server";
import { SERVER_FEATURES_QUERY_KEY, type ServerFeature } from "../lib/server-features";

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

function show(features: ServerFeature[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(SERVER_FEATURES_QUERY_KEY, { features: new Set(features), source: "server" });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const AGENT = { id: "agent_1", name: "Release manager", model: "claude-sonnet-4-6", version: 1, created_at: "2026-11-01T00:00:00Z" };
const SESSION = {
  id: "sess_1",
  title: "Ship the release",
  agent: { id: "agent_1", version: 1, name: "Release manager" },
  environment_id: "env_1",
  status: "idle",
  created_at: "2026-11-13T09:00:00Z",
  updated_at: "2026-11-13T09:05:00Z",
};
/** Newest first, as `order=desc` returns them: the turn ended asking to run a command. */
const WAITING_LOG = [
  { seq: 4, type: "session.status_idle", stop_reason: { type: "requires_action", action_type: "tool_confirmation", event_ids: ["tu_1"] }, processed_at: "2026-11-13T09:05:00Z" },
  { seq: 3, type: "agent.tool_use", id: "tu_1", name: "bash", input: { command: "git push --tags" }, evaluated_permission: "ask", processed_at: "2026-11-13T09:04:59Z" },
  { seq: 2, type: "session.status_running", processed_at: "2026-11-13T09:04:00Z" },
  { seq: 1, type: "user.message", content: [{ type: "text", text: "Ship it" }], processed_at: "2026-11-13T09:04:00Z" },
];

describe("Home on a server without the operations report", () => {
  it("lists a session waiting for approval, read from its log, and never asks for the report", async () => {
    const asked: string[] = [];
    server.use(
      http.get("*/v1/*", ({ request }) => {
        const url = new URL(request.url);
        asked.push(url.pathname);
        if (url.pathname === "/v1/agents") return HttpResponse.json({ data: [AGENT] });
        if (url.pathname === "/v1/sessions") return HttpResponse.json({ data: [SESSION] });
        if (url.pathname === "/v1/sessions/sess_1/events") return HttpResponse.json({ data: WAITING_LOG, has_more: false });
        if (url.pathname === "/v1/stats")
          return HttpResponse.json({ agents: 1, sessions: 1, environments: 1, vaults: 0, skills: 0, model_cards: 1, api_keys: 0 });
        if (url.pathname === "/v1/usage") return HttpResponse.json({ totals: { calls: 0 }, daily: [], providers: [], models: [] });
        return HttpResponse.json({ data: [] });
      }),
    );
    show(["workspace_access", "usage"]);

    const band = await screen.findByRole("region", { name: "Needs attention" });
    await waitFor(() => expect(band).toHaveTextContent("Ship the release"));
    expect(band).toHaveTextContent("Wants to run bash");
    expect(band).toHaveTextContent("git push --tags");
    // "See all" goes where the server can show it: the Sessions list.
    expect(screen.getByRole("link", { name: /Waiting on you/ })).toHaveAttribute("href", "/sessions?status=approval");
    expect(screen.queryByRole("link", { name: /Open operations/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Not reported by this runtime")).not.toBeInTheDocument();
    expect(asked).not.toContain("/v1/operations");
  });
});

describe("Home when the server cannot be reached", () => {
  it("says so once, never that nothing is running", async () => {
    server.use(http.get("*/v1/*", () => HttpResponse.json({ error: { message: "upstream connect error" } }, { status: 503 })));
    show(["workspace_access", "usage", "operations"]);

    expect(await screen.findByText("Your workspace could not be reached")).toBeInTheDocument();
    expect(screen.queryByText("Nothing is running")).not.toBeInTheDocument();
    expect(screen.queryByText("Recent sessions could not be loaded")).not.toBeInTheDocument();
    expect(screen.queryByText("Operational activity could not be loaded")).not.toBeInTheDocument();
    expect(screen.queryByText("Usage could not be loaded")).not.toBeInTheDocument();
    expect(screen.queryByText("Workspace summary could not be loaded")).not.toBeInTheDocument();
    expect(screen.getByText(/Not known right now/)).toBeInTheDocument();
  });
});

describe("what Home says failed", () => {
  const read = (key: "sessions" | "operations" | "usage" | "stats", down: boolean) => ({ key, what: key, down, error: null, retry: () => {} });
  it("keeps only the reads that are down, in order", () => {
    expect(homeProblems([read("sessions", false), read("usage", true), read("stats", true)]).map((p) => p.key)).toEqual(["usage", "stats"]);
  });
  it("lists them as a sentence", () => {
    expect(listWords(["recent sessions"])).toBe("recent sessions");
    expect(listWords(["usage", "the workspace summary"])).toBe("usage and the workspace summary");
    expect(listWords(["a", "b", "c"])).toBe("a, b and c");
  });
});
