import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { AgentMemoryPanel } from "./AgentMemoryPanel";
import { ACTIVE_TENANT_KEY } from "../lib/api";

vi.mock("../lib/clerk-auth", () => ({
  getClerkBearerToken: vi.fn(async () => "console-session-token"),
}));

const path = "/v1/agents/agent_test/memory";
const store = { id: "memstore-1", name: "agent_test-memory" };
const fetchMock = vi.fn<typeof fetch>();

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AgentMemoryPanel agentId="agent_test" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  for (const name of ["localStorage", "sessionStorage"]) {
    const values = new Map<string, string>();
    vi.stubGlobal(name, {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
  }
  localStorage.setItem(ACTIVE_TENANT_KEY, "tenant_test");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AgentMemoryPanel", () => {
  it("shows off with what that means, and turns memory on with one click", async () => {
    let enabled = false;
    fetchMock.mockImplementation(async (input, init) => {
      if (input !== path) throw new Error(`Unexpected request: ${String(input)}`);
      if (init?.method === "PUT") enabled = (JSON.parse(String(init.body)) as { enabled: boolean }).enabled;
      return Response.json({
        enabled,
        mode: enabled ? "shared" : "off",
        explicit_off: false,
        store: enabled ? { ...store, note_count: 0, last_written_at: null } : null,
      });
    });

    renderPanel();

    const toggle = await screen.findByRole("switch", { name: "Agent memory" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText(/Every session starts blank/)).toBeInTheDocument();

    fireEvent.click(toggle);

    await waitFor(() => expect(screen.getByRole("switch", { name: "Agent memory" })).toHaveAttribute("aria-checked", "true"));
    expect(fetchMock).toHaveBeenCalledWith(path, expect.objectContaining({ method: "PUT", body: '{"enabled":true}' }));
    expect(screen.getByRole("link", { name: "agent_test-memory" })).toHaveAttribute("href", "/memory/memstore-1");
    expect(screen.getByText("Nothing saved yet")).toBeInTheDocument();
  });

  it("shows which store holds the notes and how many there are", async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        enabled: true,
        mode: "shared",
        explicit_off: false,
        store: { ...store, note_count: 3, last_written_at: "2026-11-10T09:00:00.000Z" },
      }),
    );
    renderPanel();
    expect(await screen.findByRole("link", { name: "agent_test-memory" })).toBeInTheDocument();
    expect(screen.getByText(/^3 files · last written /)).toBeInTheDocument();
    expect(screen.getByText(/New sessions, scheduled runs included/)).toBeInTheDocument();
  });

  it("when turned off, says the earlier notes are kept", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ enabled: false, mode: "off", explicit_off: true, store: { ...store, note_count: 3 } }),
    );
    renderPanel();
    expect(await screen.findByText(/Its earlier notes are kept in/)).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Agent memory" })).toHaveAttribute("aria-checked", "false");
  });

  it("keeps its slot with a loading placeholder until memory loads", async () => {
    let respond!: (response: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => { respond = resolve; }));
    renderPanel();

    expect(screen.getByRole("heading", { name: "Memory" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Loading memory" })).toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    respond(Response.json({ enabled: false, mode: "off", explicit_off: false, store: null }));

    expect(await screen.findByRole("switch", { name: "Agent memory" })).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "Loading memory" })).not.toBeInTheDocument();
  });

  it("renders nothing on runtimes without the endpoint", async () => {
    fetchMock.mockResolvedValue(Response.json({ error: "Not found" }, { status: 404 }));
    const view = renderPanel();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() => expect(view.container).toBeEmptyDOMElement());
    expect(screen.queryByText("Memory")).not.toBeInTheDocument();
  });
});
