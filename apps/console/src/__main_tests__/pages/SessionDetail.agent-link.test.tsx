// The agent badge in the session header: its name is a real link to the
// agent's page (so cmd/middle-click work), and the raw config stays one
// click away through the small button next to it.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SessionDetail } from "./SessionDetail";

const api = vi.hoisted(() => vi.fn());
vi.mock("../lib/api", () => ({ useApi: () => ({ api, streamEvents: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

beforeAll(() => {
  // StickToBottom (Conversation) needs these in jsdom.
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  Element.prototype.scrollTo ??= function () {};
});

beforeEach(() => {
  api.mockReset();
  api.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method === "POST") return {};
    if (path.startsWith("/v1/sessions/sess-1/events")) return { data: [], has_more: false };
    if (path === "/v1/sessions/sess-1") return { agent: { id: "agent-1", name: "QA agent" } };
    if (path === "/v1/agents/agent-1") return { id: "agent-1", name: "QA agent", model: "claude-sonnet-4-5" };
    if (path.endsWith("/trajectory")) return { outcome: "success" };
    if (path.endsWith("/threads") || path.endsWith("/pending")) return { data: [] };
    throw new Error(`unexpected ${path}`);
  });
});

const mount = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={["/sessions/sess-1"]}>
        <Routes>
          <Route path="/sessions/:id" element={<SessionDetail />} />
          <Route path="/agents/:id" element={<div>AGENT PAGE</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

describe("SessionDetail agent badge", () => {
  it("links the agent name straight to the agent page", async () => {
    mount();
    const link = await screen.findByRole("link", { name: "QA agent" });
    expect(link).toHaveAttribute("href", "/agents/agent-1");
    // No detour through the config panel on the way there.
    expect(api).not.toHaveBeenCalledWith("/v1/agents/agent-1");

    fireEvent.click(link);
    expect(await screen.findByText("AGENT PAGE")).toBeInTheDocument();
  });

  it("keeps the agent config reachable from the button next to the name", async () => {
    mount();
    await screen.findByRole("link", { name: "QA agent" });
    const button = screen.getByRole("button", { name: "View agent config" });
    expect(button).toHaveAttribute("title", "View agent config");

    fireEvent.click(button);
    await waitFor(() => expect(api).toHaveBeenCalledWith("/v1/agents/agent-1"));
    // The panel shows the raw config…
    expect(await screen.findByText(/"model": "claude-sonnet-4-5"/)).toBeInTheDocument();
    // …and the session page stays put.
    expect(screen.queryByText("AGENT PAGE")).toBeNull();
  });
});
