import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { http, HttpResponse } from "msw";

import { server } from "../mocks/server";
import { AgentMemoryPanel } from "./AgentMemoryPanel";

const path = "*/v1/agents/agent_test/memory";
const store = { id: "memstore-1", name: "agent_test-memory" };

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AgentMemoryPanel agentId="agent_test" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("AgentMemoryPanel", () => {
  it("shows off with what that means, and turns memory on with one click", async () => {
    let enabled = false;
    const puts: unknown[] = [];
    const answer = () =>
      HttpResponse.json({
        enabled,
        mode: enabled ? "shared" : "off",
        explicit_off: false,
        store: enabled ? { ...store, note_count: 0, last_written_at: null } : null,
      });
    server.use(
      http.get(path, answer),
      http.put(path, async ({ request }) => {
        const body = (await request.json()) as { enabled: boolean };
        puts.push(body);
        enabled = body.enabled;
        return answer();
      }),
    );
    renderPanel();

    const toggle = await screen.findByRole("switch", { name: "Agent memory" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText(/Every session starts blank/)).toBeInTheDocument();

    fireEvent.click(toggle);

    await waitFor(() => expect(screen.getByRole("switch", { name: "Agent memory" })).toHaveAttribute("aria-checked", "true"));
    expect(puts).toEqual([{ enabled: true }]);
    expect(screen.getByRole("link", { name: /agent_test-memory/ })).toHaveAttribute("href", "/memory/memstore-1");
    expect(screen.getByText("Nothing saved yet")).toBeInTheDocument();
  });

  it("shows which store holds the notes and how many there are", async () => {
    server.use(
      http.get(path, () =>
        HttpResponse.json({
          enabled: true,
          mode: "shared",
          explicit_off: false,
          store: { ...store, note_count: 3, last_written_at: "2026-11-10T09:00:00.000Z" },
        }),
      ),
    );
    renderPanel();
    expect(await screen.findByRole("link", { name: /agent_test-memory/ })).toBeInTheDocument();
    expect(screen.getByText(/^3 files/)).toHaveTextContent(/3 files · last written/);
    expect(screen.getByText(/New sessions, scheduled runs included/i)).toBeInTheDocument();
  });

  it("when turned off, says the earlier notes are kept", async () => {
    server.use(
      http.get(path, () => HttpResponse.json({ enabled: false, mode: "off", explicit_off: true, store: { ...store, note_count: 3 } })),
    );
    renderPanel();
    expect(await screen.findByText(/Its earlier notes are kept in/)).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Agent memory" })).toHaveAttribute("aria-checked", "false");
  });

  it("keeps its slot with a loading placeholder until memory loads", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    server.use(
      http.get(path, async () => {
        await gate;
        return HttpResponse.json({ enabled: false, mode: "off", explicit_off: false, store: null });
      }),
    );
    renderPanel();

    expect(screen.getByRole("heading", { name: "Memory" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Loading memory" })).toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();

    release();
    expect(await screen.findByRole("switch", { name: "Agent memory" })).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "Loading memory" })).not.toBeInTheDocument();
  });

  it("renders nothing on a server without the endpoint", async () => {
    server.use(http.get(path, () => HttpResponse.json({ error: "Not found" }, { status: 404 })));
    const view = renderPanel();
    await waitFor(() => expect(view.container).toBeEmptyDOMElement());
  });

  it("renders nothing when the server answers with its web page instead", async () => {
    server.use(
      http.get(path, () => new HttpResponse("<!doctype html><html></html>", { headers: { "content-type": "text/html" } })),
    );
    const view = renderPanel();
    await waitFor(() => expect(view.container).toBeEmptyDOMElement());
  });
});
