import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router";
import { TelegramConnect } from "./TelegramConnect";

const mini = vi.hoisted(() => ({ initData: "signed-proof", ready: vi.fn(), openLink: vi.fn() }));
vi.mock("../lib/telegram-mini-app", () => ({ loadTelegramMiniApp: async () => mini }));

// The page's frame follows the system theme; jsdom has no matchMedia.
const noMedia = (query: string) =>
  ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList;
beforeEach(() => vi.stubGlobal("matchMedia", noMedia));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  mini.initData = "signed-proof";
  vi.clearAllMocks();
});

const mount = () =>
  render(
    <MemoryRouter initialEntries={["/telegram/connect/session/request"]}>
      <Routes>
        <Route path="/telegram/connect/:sessionId/:requestId" element={<TelegramConnect />} />
      </Routes>
    </MemoryRouter>,
  );

const view = { service: "linear", vaults: [{ id: "vault", name: "Apps" }], vault_ids: ["vault"] };
const consent = { url: "https://provider.example/consent", flow_id: "flow" };

describe("Telegram connection page", () => {
  it("explains how to reopen legacy browser links without issuing authenticated API requests", async () => {
    mini.initData = "";
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("fresh Connect button");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses Telegram proof with no cookies, opens provider consent only on click, then verifies", async () => {
    const fetch = vi.fn(async (url: string) =>
      Response.json(url.endsWith("/view") ? view : url.endsWith("/authorize") ? consent : { connected: true }),
    );
    vi.stubGlobal("fetch", fetch);
    mount();
    // The app is named as people say it, and the agent's own vault is picked.
    expect(await screen.findByRole("heading", { name: "Connect Linear" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Credential vault" })).toHaveTextContent("Apps");

    fireEvent.click(screen.getByRole("button", { name: "Continue to authorization" }));
    const authorize = await screen.findByRole("button", { name: "Authorize Linear" });
    expect(mini.openLink).not.toHaveBeenCalled();
    fireEvent.click(authorize);
    expect(mini.openLink).toHaveBeenCalledWith("https://provider.example/consent");
    fireEvent.click(screen.getByRole("button", { name: "I've authorized the app" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Connected.");

    const calls = fetch.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls.map(([url]) => url)).toEqual([
      "/integrations/telegram/connect/session/request/view",
      "/integrations/telegram/connect/session/request/authorize",
      "/integrations/telegram/connect/session/request/complete",
    ]);
    expect(JSON.parse(String(calls[1][1].body))).toEqual({ vault_id: "vault" });
    expect(JSON.parse(String(calls[2][1].body))).toEqual({ flow_id: "flow" });
    for (const [, options] of calls) {
      expect(options.credentials).toBe("omit");
      expect(options.headers).toMatchObject({ "x-telegram-init-data": "signed-proof" });
    }
  });

  it("keeps incomplete provider consent in error and allows verification to be retried", async () => {
    const fetch = vi.fn(async (url: string) =>
      url.endsWith("/view")
        ? Response.json(view)
        : url.endsWith("/authorize")
          ? Response.json(consent)
          : Response.json({ error: "Provider authorization is not complete yet" }, { status: 409 }),
    );
    vi.stubGlobal("fetch", fetch);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Continue to authorization" }));
    fireEvent.click(await screen.findByRole("button", { name: "Authorize Linear" }));
    fireEvent.click(screen.getByRole("button", { name: "I've authorized the app" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("not complete yet");
    expect(screen.queryByRole("status")).toBeNull();
    await waitFor(() => expect(screen.getByRole("button", { name: "I've authorized the app" })).not.toBeDisabled());
    // The provider's page can be opened again from here.
    expect(screen.getByRole("button", { name: "Open Linear again" })).toBeInTheDocument();
  });

  it("says the connection failed in words when the server answers with something that is not JSON", async () => {
    const fetch = vi.fn(async () => new Response("<!doctype html><html></html>", { status: 404, headers: { "content-type": "text/html" } }));
    vi.stubGlobal("fetch", fetch);
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be made");
    expect(screen.queryByRole("button", { name: "Continue to authorization" })).toBeNull();
  });

  it("offers a new vault when the workspace has none", async () => {
    const fetch = vi.fn(async (url: string) =>
      Response.json(url.endsWith("/view") ? { ...view, vaults: [], vault_ids: [] } : consent),
    );
    vi.stubGlobal("fetch", fetch);
    mount();
    expect(await screen.findByText(/Connected Apps is made/)).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Credential vault" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Continue to authorization" }));
    await screen.findByRole("button", { name: "Authorize Linear" });
    const calls = fetch.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(JSON.parse(String(calls[1][1].body))).toEqual({});
  });
});
