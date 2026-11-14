// The agent's page on a production server: the setup chat resumes or starts
// the agent's setup conversation, "Run until done" appears only where the
// server runs missions, and Activity reads each session the way the
// Sessions list does (state, what came of it, how long it ran).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Outlet, RouterProvider, createMemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { AgentDetail } from "./AgentDetail";
import { server } from "../mocks/server";

const api = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn(), message: vi.fn() }));
vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  useApi: () => ({ api, streamEvents: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast }));
vi.mock("../lib/clerk-auth", () => ({ getClerkBearerToken: vi.fn(async () => null) }));

const agent = {
  id: "agent_test",
  name: "Ops agent",
  model: "claude-sonnet-4-5",
  version: 2,
  created_at: "2026-11-10T09:00:00.000Z",
  metadata: { long_running: true },
  _oma: { default_environment_id: "env_session" },
};

const now = Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
const sessions = [
  {
    id: "sess_ended",
    title: "Weekly report",
    agent: { id: "agent_test", version: 2 },
    environment_id: "env_session",
    status: "terminated",
    created_at: iso(3_600_000),
    updated_at: iso(3_000_000),
    terminated_at: iso(3_000_000),
    stats: { duration_seconds: 410 },
  },
  {
    id: "sess_quiet",
    title: "Nothing recorded",
    agent: { id: "agent_test", version: 1 },
    environment_id: "env_session",
    status: "idle",
    created_at: iso(60_000),
  },
];

let setupSessionId: string | null = null;

function mount() {
  const router = createMemoryRouter(
    [{
      element: <main><Outlet /></main>,
      children: [
        { path: "/agents/:id", element: <AgentDetail /> },
        { path: "/agents/:id/setup", element: <h2>Setup chat page</h2> },
      ],
    }],
    { initialEntries: ["/agents/agent_test"] },
  );
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

beforeEach(() => {
  server.use(http.get("*/v1/server_features", () => HttpResponse.json({ features: ["workspace_access", "usage"] })));
  setupSessionId = null;
  api.mockReset();
  api.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/v1/agents/agent_test") return agent;
    if (path === "/v1/agents/agent_test/setup_session") return { data: setupSessionId ? { id: setupSessionId } : null };
    if (path.startsWith("/v1/sessions?agent_id=agent_test")) return { data: sessions };
    if (path === "/v1/sessions" && init?.method === "POST") return { id: "sess_new_setup" };
    if (path === "/v1/sessions/sess_new_setup/events" && init?.method === "POST") return undefined;
    if (path === "/v1/agents/agent_test/machine") return { machine: null, supported: false };
    if (path.startsWith("/v1/environments")) {
      return path.includes("?") ? { data: [{ id: "env_session", name: "Sandbox", config: { sandbox: {} } }] } : { id: "env_session", config: {} };
    }
    return { data: [] };
  });
});

describe("AgentDetail", () => {
  it("reopens the agent's setup conversation", async () => {
    setupSessionId = "sess_setup";
    const user = userEvent.setup();
    const router = mount();

    await user.click(await screen.findByRole("button", { name: "Setup chat" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/agents/agent_test/setup"));
    expect(router.state.location.search).toBe("?session=sess_setup");
    expect(api).not.toHaveBeenCalledWith("/v1/sessions", expect.objectContaining({ method: "POST" }));
  });

  it("starts a setup conversation in the agent's environment when it has none", async () => {
    const user = userEvent.setup();
    const router = mount();

    await user.click(await screen.findByRole("button", { name: "Setup chat" }));

    await waitFor(() => expect(router.state.location.search).toBe("?session=sess_new_setup"));
    const create = api.mock.calls.find(([path, init]) => path === "/v1/sessions" && init?.method === "POST");
    expect(JSON.parse(create![1].body)).toEqual({
      agent: "agent_test",
      environment_id: "env_session",
      metadata: { oma_setup: true },
    });
    const kickoff = api.mock.calls.find(([path]) => path === "/v1/sessions/sess_new_setup/events");
    expect(JSON.parse(kickoff![1].body).events[0].type).toBe("user.message");
  });

  it("leaves Run until done out where the server runs no missions", async () => {
    mount();
    await screen.findByRole("button", { name: "Setup chat" });
    expect(screen.queryByRole("button", { name: "Run until done" })).not.toBeInTheDocument();
  });

  it("offers Run until done for a long-running agent where the server runs missions", async () => {
    server.use(http.get("*/v1/server_features", () => HttpResponse.json({ features: ["missions"] })));
    mount();
    expect(await screen.findByRole("button", { name: "Run until done" })).toBeInTheDocument();
  });

  it("reads each session in Activity with its state, how long it ran and when it was last active", async () => {
    const user = userEvent.setup();
    mount();

    await user.click(await screen.findByRole("tab", { name: /Activity/ }));
    const table = await screen.findByRole("table");
    expect(within(table).getByRole("columnheader", { name: "Duration" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "Last activity" })).toBeInTheDocument();

    const ended = within(table).getByRole("link", { name: "Weekly report" }).closest("tr")!;
    expect(within(ended).getByText("Ended")).toBeInTheDocument();
    expect(within(ended).getByText("6m 50s")).toBeInTheDocument();

    const quiet = within(table).getByRole("link", { name: "Nothing recorded" }).closest("tr")!;
    expect(within(quiet).getByText("Not recorded")).toBeInTheDocument();
    expect(within(quiet).getByText(/as v1/)).toBeInTheDocument();
  });
});
