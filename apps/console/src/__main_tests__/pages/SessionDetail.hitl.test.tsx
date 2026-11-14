// Human-in-the-loop rendering in the session viewer, driven through the
// real SessionDetail page with a mocked API (initial history load = the
// "reload" path QA flagged: an idle requires_action session rendered as a
// running tool plus "Outcome: success").
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

let history: Array<Record<string, unknown>> = [];
beforeEach(() => {
  api.mockReset();
  api.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method === "POST") return {};
    if (path.startsWith("/v1/sessions/sess-1/events")) {
      return { data: history.map((data, i) => ({ seq: i + 1, type: data.type, data })), has_more: false };
    }
    if (path === "/v1/sessions/sess-1") return { agent: { id: "agent-1", name: "QA agent" } };
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
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

const askTurn = [
  { type: "user.message", id: "u1", content: [{ type: "text", text: "qa approve" }] },
  { type: "session.status_running", id: "r1" },
  { type: "agent.tool_use", id: "call_qa_8", name: "bash", input: { command: "env" }, evaluated_permission: "ask" },
  { type: "session.status_idle", id: "i1", stop_reason: { type: "requires_action", action_type: "tool_confirmation", event_ids: ["call_qa_8"] } },
];

describe("SessionDetail human-in-the-loop", () => {
  it("shows Approve/Deny on a reloaded requires_action session instead of Running + Outcome: success", async () => {
    history = askTurn;
    mount();
    expect(await screen.findByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deny" })).toBeInTheDocument();
    expect(screen.getAllByText("Awaiting approval").length).toBeGreaterThan(0);
    expect(screen.queryByText("Running")).toBeNull();
    // Trajectory says success, but the turn is parked on the client.
    await waitFor(() => expect(api).toHaveBeenCalledWith("/v1/sessions/sess-1/trajectory"));
    expect(screen.queryByText(/Outcome:/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        "/v1/sessions/sess-1/events",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ events: [{ type: "user.tool_confirmation", tool_use_id: "call_qa_8", result: "allow" }] }),
        }),
      ),
    );
  });

  it("renders a denied call as Denied, not Completed", async () => {
    history = [
      ...askTurn,
      { type: "user.tool_confirmation", id: "c1", tool_use_id: "call_qa_8", result: "deny", deny_message: "QA denial test" },
      { type: "session.status_running", id: "r2" },
      { type: "agent.tool_result", id: "t1", tool_use_id: "call_qa_8", content: "Denied: QA denial test" },
      { type: "session.status_idle", id: "i2", stop_reason: { type: "end_turn" } },
    ];
    mount();
    expect(await screen.findByText("Denied")).toBeInTheDocument();
    expect(screen.queryByText("Completed")).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("renders an is_error recovery placeholder as Failed", async () => {
    history = [
      { type: "user.message", id: "u1", content: [{ type: "text", text: "go" }] },
      { type: "agent.tool_use", id: "call_x", name: "bash", input: { command: "sleep 60" } },
      { type: "agent.tool_result", id: "t1", tool_use_id: "call_x", content: "outcome unknown; it MAY have taken effect", is_error: true },
      { type: "session.status_idle", id: "i1", stop_reason: { type: "end_turn" } },
    ];
    mount();
    expect(await screen.findByText("Failed")).toBeInTheDocument();
    expect(screen.queryByText("Completed")).toBeNull();
  });

  it("shows a waiting-for-client state for custom tools instead of Running", async () => {
    history = [
      { type: "user.message", id: "u1", content: [{ type: "text", text: "email" }] },
      { type: "agent.custom_tool_use", id: "call_c", name: "send_email", input: { to: "a@b.c" } },
      { type: "session.status_idle", id: "i1", stop_reason: { type: "requires_action", action_type: "custom_tool_result", event_ids: ["call_c"] } },
    ];
    mount();
    const badge = await screen.findByText("Waiting for client result");
    expect(within(badge.closest("button")!).queryByText("Running")).toBeNull();
    expect(screen.getByText("Awaiting client result")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });
});
