import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { ModelCardsList } from "./ModelCardsList";

vi.mock("../lib/clerk-auth", () => ({
  getClerkBearerToken: vi.fn(async () => null),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("Create is disabled while the POST is in flight — a double click sends one request", async () => {
  let resolveCreate: (r: Response) => void = () => {};
  const creates: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/v1/model_cards" && init?.method === "POST") {
        creates.push(JSON.parse(String(init.body)));
        return new Promise<Response>((r) => (resolveCreate = r));
      }
      return Promise.resolve(Response.json({ data: [] }));
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ModelCardsList />
      </MemoryRouter>
    </QueryClientProvider>,
  );

  fireEvent.click(await screen.findByRole("button", { name: "+ New model card" }));
  await waitFor(() => expect(document.getElementById("modelcard-id")).toBeTruthy());
  fireEvent.change(document.getElementById("modelcard-id")!, { target: { value: "claude-opus-5-5" } });
  fireEvent.change(document.getElementById("modelcard-api-key")!, { target: { value: "sk-ant-test-key-123456" } });

  const create = screen.getByRole("button", { name: "Create" });
  fireEvent.click(create);
  fireEvent.click(create);
  await waitFor(() => expect(screen.getByRole("button", { name: /Creating…/ })).toBeDisabled());
  expect(creates).toHaveLength(1);

  resolveCreate(Response.json({ id: "mc_1", probe: { ok: null } }));
  await waitFor(() => expect(screen.queryByRole("button", { name: /Creating…/ })).not.toBeInTheDocument());
  expect(creates).toHaveLength(1);
});
