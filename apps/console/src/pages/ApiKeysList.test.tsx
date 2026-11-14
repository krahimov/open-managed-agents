import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiKeysList } from "./ApiKeysList";
import { SERVER_FEATURE_KEYS, SERVER_FEATURES_QUERY_KEY, type ServerFeature } from "../lib/server-features";

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../lib/api", () => ({ useApi: () => ({ api }) }));
vi.mock("../components/PageHeader", () => ({ PageHeader: ({ actions, toolbar }: { actions: React.ReactNode; toolbar: React.ReactNode }) => <>{actions}{toolbar}</> }));
beforeEach(() => { api.mockReset(); });

/** The page, on a server with these features (every one unless told otherwise). */
function renderKeys(features: readonly ServerFeature[] = SERVER_FEATURE_KEYS) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(SERVER_FEATURES_QUERY_KEY, { features: new Set(features), source: "server" });
  return render(<QueryClientProvider client={client}><MemoryRouter><ApiKeysList /></MemoryRouter></QueryClientProvider>);
}

describe("API key access controls", () => {
  it("creates a read-only expiring key by default and shows the secret once", async () => {
    api.mockImplementation(async (_path: string, init?: RequestInit) => init?.method === "POST" ? { key: "omak_new_test_secret" } : { data: [] });
    renderKeys();
    await userEvent.click(await screen.findByRole("button", { name: "+ New API key" }));
    expect(screen.getByLabelText("Permission scopes")).toHaveValue("*:read");
    expect(screen.getByLabelText("Expiration date")).not.toHaveValue("");
    await userEvent.type(screen.getByLabelText("Name (optional)"), "Read reports");
    await userEvent.click(screen.getByRole("button", { name: "Create key" }));
    expect(await screen.findByText("omak_new_test_secret")).toBeInTheDocument();
    const sent = api.mock.calls.find(([, init]) => init?.method === "POST");
    const body = JSON.parse(sent?.[1]?.body as string);
    expect(body.scopes).toEqual(["*:read"]);
    expect(Date.parse(body.expires_at)).toBeGreaterThan(Date.now());
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByText("omak_new_test_secret")).not.toBeInTheDocument());
  });

  it("takes an expiry typed or picked from the calendar, and says why a past day is refused", async () => {
    api.mockImplementation(async (_path: string, init?: RequestInit) => init?.method === "POST" ? { key: "omak_new_test_secret" } : { data: [] });
    renderKeys();
    await userEvent.click(await screen.findByRole("button", { name: "+ New API key" }));
    const field = screen.getByLabelText("Expiration date");
    // Not the browser's own date control.
    expect(field).toHaveAttribute("type", "text");

    // A day that has passed is refused in words, and the field keeps what it held.
    const held = (field as HTMLInputElement).value;
    await userEvent.clear(field);
    await userEvent.type(field, "2020-01-01{Enter}");
    expect(await screen.findByText(/or later\.$/)).toBeInTheDocument();
    expect(field).toHaveValue(held);

    // Typed as an ISO day.
    await userEvent.clear(field);
    await userEvent.type(field, "2031-03-09{Enter}");
    expect(screen.queryByText(/or later\.$/)).not.toBeInTheDocument();

    // Picked from the month grid: the keyboard starts on the chosen day.
    await userEvent.click(screen.getByRole("button", { name: /^Choose a date/ }));
    const grid = await screen.findByRole("grid", { name: "March 2031" });
    expect(grid).toBeInTheDocument();
    await userEvent.keyboard("{ArrowRight}{Enter}");
    await waitFor(() => expect(screen.queryByRole("grid")).not.toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "Create key" }));
    expect(await screen.findByText("omak_new_test_secret")).toBeInTheDocument();
    const sent = api.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(sent?.[1]?.body as string).expires_at).toBe("2031-03-10T23:59:59.999Z");
  });

  it("rejects invalid resource restrictions before issuing a key", async () => {
    api.mockResolvedValue({ data: [] });
    renderKeys();
    await userEvent.click(await screen.findByRole("button", { name: "+ New API key" }));
    await userEvent.click(screen.getByText("Restrict to specific resources"));
    await userEvent.type(screen.getByLabelText("Resource IDs as JSON"), "not-json");
    await userEvent.click(screen.getByRole("button", { name: "Create key" }));
    expect(await screen.findByText(/Resource restrictions must be a JSON object/)).toBeInTheDocument();
    expect(api.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("on a server that makes every key full access, asks for a name only and says so", async () => {
    api.mockImplementation(async (_path: string, init?: RequestInit) =>
      init?.method === "POST"
        ? { id: "ak_1", key: "omak_full_secret", prefix: "omak_ful", created_at: "2026-11-13T00:00:00Z" }
        : { data: [{ id: "ak_0", name: "CI", prefix: "omak_ci0", created_at: "2026-11-01T00:00:00Z" }] });
    renderKeys(["workspace_access", "usage"]);
    // Listed as what it is, with no "Last used" the server does not record.
    expect(await screen.findByText("Full access")).toBeInTheDocument();
    expect(screen.queryByText("Last used")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "+ New API key" }));
    expect(screen.queryByLabelText("Permission scopes")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Expiration date")).not.toBeInTheDocument();
    expect(screen.queryByText("Restrict to specific resources")).not.toBeInTheDocument();
    expect(screen.getByText("Full access, no expiry")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Name (optional)"), "Deploy bot");
    await userEvent.click(screen.getByRole("button", { name: "Create key" }));
    expect(await screen.findByText("omak_full_secret")).toBeInTheDocument();
    const sent = api.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(sent?.[1]?.body as string)).toEqual({ name: "Deploy bot" });
    expect(screen.getAllByText("Full access").length).toBeGreaterThan(0);
    expect(within(screen.getByRole("dialog")).getByText("Never")).toBeInTheDocument();
  });
});
