import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { AccessRequestCard } from "./AccessRequestCard";
const api = vi.hoisted(() => vi.fn());
vi.mock("../lib/api", () => ({ useApi: () => ({ api }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const event = { type: "system.access_request", service: "linear", composio_configured: true } as any;
beforeEach(() => {
  api.mockReset();
  vi.spyOn(window, "open").mockReturnValue({ location: { href: "" }, close: vi.fn() } as any);
  vi.stubGlobal("BroadcastChannel", class { addEventListener() {} removeEventListener() {} close() {} });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function begin() {
  render(<MemoryRouter><AccessRequestCard event={event} sessionId="session-one" vaultId="chosen-vault" /></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "Connect linear" }));
  await screen.findByRole("button", { name: "Waiting for provider…" });
  await waitFor(() => expect(api).toHaveBeenCalledWith("/v1/vaults/chosen-vault/credentials/composio_accounts/link", expect.anything()));
}
it("does not announce access when provider completion cannot be verified", async () => {
  api.mockImplementation(async (path: string) => {
    if (path.endsWith("/link")) return { redirect_url: "https://connect.composio.dev/link/test" };
    if (path.endsWith("/graft")) throw new Error("No active account was found");
    throw new Error("Unexpected request " + path);
  });
  await begin();
  fireEvent(window, new MessageEvent("message", { origin: window.location.origin, data: { type: "composio_auth_complete", toolkit: "linear" } }));
  await screen.findByText("No active account was found");
  expect(api.mock.calls.some(([p]) => p.endsWith("/events"))).toBe(false);
  expect(screen.queryByText("Connected ✓")).not.toBeInTheDocument();
});
it("ignores foreign-origin callbacks, then uses the selected vault and resumes after verified success", async () => {
  api.mockImplementation(async (path: string) => path.endsWith("/link") ? { redirect_url: "https://connect.composio.dev/link/test" } : { attached_server: true });
  await begin();
  fireEvent(window, new MessageEvent("message", { origin: "https://unrelated.example", data: { type: "composio_auth_complete", toolkit: "linear" } }));
  expect(api.mock.calls.some(([p]) => p.endsWith("/graft"))).toBe(false);
  fireEvent(window, new MessageEvent("message", { origin: window.location.origin, data: { type: "composio_auth_complete", toolkit: "linear" } }));
  await screen.findByText("Connected ✓");
  expect(api).toHaveBeenCalledWith("/v1/sessions/session-one/composio/graft", expect.objectContaining({ body: JSON.stringify({ toolkit: "linear", vault_id: "chosen-vault" }) }));
  expect(api).toHaveBeenCalledWith("/v1/sessions/session-one/events", expect.anything());
});
