import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { http, HttpResponse } from "msw";

import { ModelCardsList } from "./ModelCardsList";
import { server } from "../mocks/server";
import { SERVER_FEATURE_KEYS, SERVER_FEATURES_QUERY_KEY, type ServerFeature } from "../lib/server-features";

vi.mock("../lib/clerk-auth", () => ({ getClerkBearerToken: vi.fn(async () => null) }));

beforeAll(() => {
  // The provider choice cards measure themselves.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

function show(features: readonly ServerFeature[] = SERVER_FEATURE_KEYS) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(SERVER_FEATURES_QUERY_KEY, { features: new Set(features), source: "server" });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ModelCardsList />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const CARD = {
  id: "mc_0",
  provider: "ant",
  model_id: "claude-sonnet-4-6",
  model: "claude-sonnet-4-6",
  api_key_preview: "…abcd",
  is_default: true,
  created_at: "2026-11-01T00:00:00Z",
};

/** Every list the page reads answers (empty unless `cards`), and the usage report too. */
function workspace(cards: unknown[] = []) {
  const asked: string[] = [];
  server.use(
    http.get("*/v1/*", ({ request }) => {
      const path = new URL(request.url).pathname;
      asked.push(path);
      if (path === "/v1/usage") return HttpResponse.json({ totals: {}, models: [], range: { since: 0, until: 30 * 86_400_000 } });
      if (path === "/v1/model_cards") return HttpResponse.json({ data: cards });
      return HttpResponse.json({ data: [] });
    }),
  );
  return asked;
}

describe("Models", () => {
  it("Add is disabled while the POST is in flight: a double click sends one request", async () => {
    workspace();
    const creates: unknown[] = [];
    let release: () => void = () => {};
    server.use(
      http.post("*/v1/model_cards", async ({ request }) => {
        creates.push(await request.json());
        await new Promise<void>((r) => (release = r));
        return HttpResponse.json({ id: "mc_1", probe: { ok: null } });
      }),
    );
    show();

    // An empty workspace offers the one button, in its empty state.
    fireEvent.click(await screen.findByRole("button", { name: "New model" }));
    fireEvent.change(await screen.findByLabelText("Model ID"), { target: { value: "claude-opus-5-5" } });
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-ant-test-key-123456" } });

    const add = screen.getByRole("button", { name: "Add model" });
    fireEvent.click(add);
    fireEvent.click(add);
    await waitFor(() => expect(screen.getByRole("button", { name: /Adding…/ })).toBeDisabled());
    await waitFor(() => expect(creates).toHaveLength(1));

    release();
    await waitFor(() => expect(screen.queryByRole("button", { name: /Adding…/ })).not.toBeInTheDocument());
    expect(creates).toHaveLength(1);
  });

  it("leaves out recent spend where the server keeps no usage, and never asks for it", async () => {
    const asked = workspace([CARD]);
    show(["workspace_access"]);
    expect(await screen.findByText("Used by")).toBeInTheDocument();
    expect(screen.queryByText(/Last \d+ days/)).not.toBeInTheDocument();
    expect(asked).not.toContain("/v1/usage");
  });

  it("reads recent spend per model where the server keeps usage", async () => {
    const asked = workspace([CARD]);
    show();
    expect(await screen.findByText("Used by")).toBeInTheDocument();
    await waitFor(() => expect(asked).toContain("/v1/usage"));
  });
});
