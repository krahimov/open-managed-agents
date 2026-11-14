// Deleting an agent from its page: the confirm says for certain whether its
// computer goes too, the page leaves for a list that no longer shows it, and
// nothing keeps asking the server about the deleted agent.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { Outlet, RouterProvider, createMemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider, type InfiniteData } from "@tanstack/react-query";
import { AgentDetail } from "./AgentDetail";
import { useInfiniteApiQuery } from "../lib/useApiQuery";

const api = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
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
  version: 1,
  created_at: "2026-11-10T09:00:00.000Z",
  _oma: { default_environment_id: "env_session" },
};
const runningMachine = {
  id: "machine_test",
  state: "running",
  generation: 1,
  workdir: "/workspace",
  browserEnabled: false,
  lastActiveAt: null,
  errorReason: null,
};

let machine: typeof runningMachine | null = null;
let deleted = false;

function AgentsListStub() {
  const { items } = useInfiniteApiQuery<{ id: string; name: string }>("/v1/agents", { limit: 20 });
  return (
    <div>
      <h2>Agents list</h2>
      {items.map((a) => <div key={a.id}>{a.name}</div>)}
    </div>
  );
}

/** Stands in for AppShell: the header slot PageHeader portals into. */
function Shell() {
  const [pageHeaderSlot, setPageHeaderSlot] = useState<HTMLDivElement | null>(null);
  return (
    <>
      <div ref={setPageHeaderSlot} />
      <main>
        <Outlet context={{ pageHeaderSlot }} />
      </main>
    </>
  );
}

function mount(client: QueryClient) {
  const router = createMemoryRouter(
    [{
      element: <Shell />,
      children: [
        { path: "/agents", element: <AgentsListStub /> },
        { path: "/agents/:id", element: <AgentDetail /> },
      ],
    }],
    { initialEntries: ["/agents/agent_test"] },
  );
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

const newClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });

beforeEach(() => {
  machine = null;
  deleted = false;
  api.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  api.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/v1/agents/agent_test" && init?.method === "DELETE") {
      deleted = true;
      return { type: "agent_deleted", id: "agent_test" };
    }
    if (path.startsWith("/v1/agents?")) {
      return { data: deleted ? [] : [{ id: "agent_test", name: "Ops agent" }] };
    }
    if (deleted && path.includes("/agents/agent_test")) throw new Error(`refetched deleted agent: ${path}`);
    if (path === "/v1/agents/agent_test") return agent;
    if (path === "/v1/agents/agent_test/machine") return { machine, supported: !!machine };
    if (path === "/v1/environments/env_session") {
      return { id: "env_session", name: "Session sandbox", config: { sandbox: { provider: "subprocess" } } };
    }
    if (path === "/v1/agents/agent_test/memory") throw new Error("not found");
    return { data: [] };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AgentDetail delete", () => {
  it("names the agent and its computer, then lands on a list without it", async () => {
    machine = runningMachine;
    const client = newClient();
    // The list was visited first, so its page is cached with the agent in it.
    client.setQueryData<InfiniteData<{ data: { id: string; name: string }[] }>>(
      ["/v1/agents", "infinite", 20, "{}", "cursor"],
      { pages: [{ data: [{ id: "agent_test", name: "Ops agent" }] }], pageParams: [undefined] },
    );
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const router = mount(client);

    expect(await screen.findByText("Running")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/agents"));
    expect(confirm).toHaveBeenCalledWith(
      'Delete agent "Ops agent"? Its computer and all files on its disk will be deleted too. This cannot be undone.',
    );
    expect(api).toHaveBeenCalledWith("/v1/agents/agent_test", { method: "DELETE" });
    expect(await screen.findByRole("heading", { name: "Agents list" })).toBeInTheDocument();
    expect(screen.queryByText("Ops agent")).not.toBeInTheDocument();
    expect(toast.success).toHaveBeenCalledWith('Deleted agent "Ops agent"');
    await waitFor(() =>
      expect(
        client.getQueryCache().findAll().filter((q) => String(q.queryKey[0]).includes("/agents/agent_test")),
      ).toEqual([]),
    );
    // Nothing asked about the deleted agent after the delete.
    const deleteAt = api.mock.calls.findIndex(
      ([path, init]) => path === "/v1/agents/agent_test" && init?.method === "DELETE",
    );
    expect(
      api.mock.calls.slice(deleteAt + 1).filter(([path]) => String(path).includes("/agents/agent_test")),
    ).toEqual([]);
  });

  it("checks for a computer before confirming when the panel hasn't loaded it", async () => {
    const client = newClient();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    mount(client);

    await screen.findByRole("button", { name: "Delete" });
    client.removeQueries({ queryKey: ["/v1/agents/agent_test/machine"] });
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(confirm).toHaveBeenCalledWith(
        'Delete agent "Ops agent"? It has no computer, so there is no computer or disk to delete. This cannot be undone.',
      ),
    );
    expect(api).not.toHaveBeenCalledWith("/v1/agents/agent_test", { method: "DELETE" });
    expect(screen.getByRole("heading", { name: "Ops agent" })).toBeInTheDocument();
  });

  it("tells an agent on a session sandbox how to get a computer", async () => {
    mount(newClient());
    expect(await screen.findByText(/runs each session in a fresh sandbox/)).toBeInTheDocument();
    expect(api).toHaveBeenCalledWith("/v1/environments/env_session", expect.anything());
  });

  it("stays quiet when the default environment was deleted", async () => {
    const fallback = api.getMockImplementation()!;
    api.mockImplementation(async (path: string, init?: RequestInit & { silentErrors?: boolean }) => {
      if (path === "/v1/environments/env_session") {
        // Like api(): a failed request toasts unless the caller asked for quiet.
        if (!init?.silentErrors) toast.error("Environment not found");
        throw Object.assign(new Error("Environment not found"), { status: 404 });
      }
      return fallback(path, init);
    });
    // Default retries on, as in the app, to check the lookup is tried once.
    mount(new QueryClient({ defaultOptions: { queries: { retry: 1, retryDelay: 0, staleTime: 30_000 } } }));

    expect(await screen.findByText(/runs each session in a fresh sandbox/)).toBeInTheDocument();
    expect(toast.error).not.toHaveBeenCalled();
    expect(api.mock.calls.filter(([path]) => path === "/v1/environments/env_session")).toHaveLength(1);
  });
});
