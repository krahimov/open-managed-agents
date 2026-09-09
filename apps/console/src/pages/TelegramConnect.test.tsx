import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router";
import { TelegramConnect } from "./TelegramConnect";
const mini = vi.hoisted(() => ({ initData: "signed-proof", ready: vi.fn(), openLink: vi.fn() }));
vi.mock("../lib/telegram-mini-app", () => ({ loadTelegramMiniApp: async () => mini }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); mini.initData = "signed-proof"; vi.clearAllMocks(); });
const mount = () => render(<MemoryRouter initialEntries={["/telegram/connect/session/request"]}><Routes><Route path="/telegram/connect/:sessionId/:requestId" element={<TelegramConnect />} /></Routes></MemoryRouter>);
const view = { service: "linear", vaults: [{ id: "vault", name: "Apps" }], vault_ids: ["vault"] };
describe("Telegram connection page", () => {
  it("explains how to reopen legacy browser links without issuing authenticated API requests", async () => {
    mini.initData = "";
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch); mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("fresh Connect button");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("uses Telegram proof with no cookies, opens provider consent only on click, then verifies", async () => {
    const fetch = vi.fn(async (url: string) => Response.json(url.endsWith("/view") ? view : url.endsWith("/authorize") ? { url: "https://provider.example/consent", flow_id: "flow" } : { connected: true }));
    vi.stubGlobal("fetch", fetch); mount();
    fireEvent.click(await screen.findByRole("button", { name: "Continue to authorization" }));
    const authorize = await screen.findByRole("button", { name: "Authorize linear" });
    expect(mini.openLink).not.toHaveBeenCalled();
    fireEvent.click(authorize);
    expect(mini.openLink).toHaveBeenCalledWith("https://provider.example/consent");
    fireEvent.click(screen.getByRole("button", { name: "I've authorized the app" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Connected.");
    for (const [, options] of fetch.mock.calls as unknown as Array<[string, RequestInit]>) {
      expect(options.credentials).toBe("omit");
      expect(options.headers).toMatchObject({ "x-telegram-init-data": "signed-proof" });
    }
  });
  it("keeps incomplete provider consent in error and allows verification to be retried", async () => {
    const fetch = vi.fn(async (url: string) => url.endsWith("/view") ? Response.json(view) : url.endsWith("/authorize") ? Response.json({ url: "https://provider.example/consent", flow_id: "flow" }) : Response.json({ error: "Provider authorization is not complete yet" }, { status: 409 }));
    vi.stubGlobal("fetch", fetch); mount();
    fireEvent.click(await screen.findByRole("button", { name: "Continue to authorization" }));
    fireEvent.click(await screen.findByRole("button", { name: "Authorize linear" }));
    fireEvent.click(screen.getByRole("button", { name: "I've authorized the app" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("not complete yet");
    expect(screen.queryByRole("status")).toBeNull();
    await waitFor(() => expect(screen.getByRole("button", { name: "I've authorized the app" })).not.toBeDisabled());
  });
});
