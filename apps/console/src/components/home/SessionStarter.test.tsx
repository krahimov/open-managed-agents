// Starting a session with files: any kind of file goes along with the first
// message (an image as a picture, anything else into the agent's sandbox),
// and a server that asks for payment (402) is said in place, with the words
// still in the box, instead of leaving for a page this console has not got.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";

import { ApiError } from "../../lib/api";
import { server } from "../../mocks/server";
import { SessionStarter } from "./SessionStarter";

const api = vi.hoisted(() => vi.fn());
vi.mock("../../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/api")>()),
  useApi: () => ({ api, streamEvents: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

const agent = { id: "agent-1", name: "Analyst", model: "claude-sonnet-4-5", _oma: { default_environment_id: "env-1" } };
let posts: Array<{ path: string; body: unknown }> = [];
let onPost: (path: string) => unknown = () => ({});

beforeEach(() => {
  try {
    sessionStorage.clear();
    localStorage.clear();
  } catch {
    /* no storage */
  }
  posts = [];
  onPost = (path) => (path === "/v1/sessions" ? { id: "sess-9" } : {});
  server.use(http.get("*/v1/server_features", () => HttpResponse.json({ features: ["workspace_access", "usage"] })));
  api.mockReset();
  api.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method && init.method !== "GET") {
      posts.push({ path, body: init.body instanceof FormData ? init.body : JSON.parse(String(init.body ?? "null")) });
      return onPost(path);
    }
    if (path === "/v1/server_features") return { features: ["workspace_access", "usage"] };
    if (path.startsWith("/v1/agents/agent-1/ambient-rules")) return { data: [] };
    if (path.startsWith("/v1/agents/agent-1")) return agent;
    if (path.startsWith("/v1/agents")) return { data: [agent] };
    if (path.startsWith("/v1/environments/env-1")) return { id: "env-1", name: "Sandbox" };
    return { data: [] };
  });
});

const mount = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<SessionStarter initialAgentId="agent-1" />} />
          <Route path="/sessions/:id" element={<div>SESSION PAGE</div>} />
          <Route path="*" element={<div>WRONG ROUTE</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

async function ready() {
  const box = await screen.findByRole("textbox", { name: "Message to start a new session" });
  await waitFor(() => expect(screen.getByRole("button", { name: "Attach files" })).toBeEnabled());
  return box;
}

describe("SessionStarter attachments", () => {
  it("starts a session with a CSV: uploaded to it, written into the sandbox, then named in the first message", async () => {
    onPost = (path) => {
      if (path === "/v1/sessions") return { id: "sess-9" };
      if (path === "/v1/files") return { id: "file-1", filename: "orders.csv", media_type: "text/csv", size_bytes: 8 };
      if (path === "/v1/sessions/sess-9/resources") return { id: "res-1", mount_path: "/mnt/session/uploads/orders.csv" };
      return {};
    };
    mount();
    const box = await ready();
    fireEvent.change(document.querySelector<HTMLInputElement>('input[type="file"]')!, {
      target: { files: [new File(["a,b\n1,2\n"], "orders.csv", { type: "text/csv" })] },
    });
    expect(within(await screen.findByTestId("composer-attachments")).getByText("orders.csv")).toBeInTheDocument();
    expect(screen.queryByText(/was not attached/)).toBeNull();
    fireEvent.change(box, { target: { value: "Which orders are late?" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("SESSION PAGE")).toBeInTheDocument();
    expect(posts.map((p) => p.path)).toEqual(["/v1/sessions", "/v1/files", "/v1/sessions/sess-9/resources", "/v1/sessions/sess-9/events"]);
    expect((posts[1].body as FormData).get("scope_id")).toBe("sess-9");
    const [event] = (posts[3].body as { events: Array<Record<string, any>> }).events;
    expect(event.content[0]).toEqual({ type: "text", text: "Which orders are late?" });
    expect(event.content[1].text).toContain("/mnt/session/uploads/orders.csv");
    expect(event.metadata.attachments).toEqual([expect.objectContaining({ filename: "orders.csv", kind: "file" })]);
  });

  it("says a 402 in place and keeps the words, without leaving for a Billing page", async () => {
    onPost = (path) => {
      if (path === "/v1/sessions") throw new ApiError({ status: 402, message: "Insufficient balance for a cloud sandbox", code: "payment_required" });
      return {};
    };
    mount();
    const box = (await ready()) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "Summarise yesterday" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent("The session could not be started");
    expect(notice).toHaveTextContent("Insufficient balance");
    expect(screen.queryByText("WRONG ROUTE")).toBeNull();
    expect(box.value).toBe("Summarise yesterday");
  });
});
