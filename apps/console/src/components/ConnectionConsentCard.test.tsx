import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { ConnectionConsentCard } from "./ConnectionConsentCard";
const api = vi.hoisted(() => vi.fn());
vi.mock("../lib/api", () => ({ useApi: () => ({ api }) }));
const request = { request_id: "request", service: "slack", mcp_server_url: "https://mcp.slack.com/mcp", auth_kind: "mcp_oauth" };
const connection = { credential_id: "chosen", vault_id: "shared", label: "Old Slack account", vault_name: "Shared vault" };
function mount(connectionRequest = request) { render(<MemoryRouter><ConnectionConsentCard request={connectionRequest} sessionId="session" /></MemoryRouter>); }
beforeEach(() => { api.mockReset(); vi.stubGlobal("BroadcastChannel", class { addEventListener() {} close() {} }); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("requires verification, workspace confirmation, and approval", async () => {
  api.mockImplementation(async (path: string) => {
    if (path.endsWith("/verify")) return { status: "verified", verification_id: "verification", account: "karim", workspace: "Erandry", workspace_id: "T-old" };
    if (path.endsWith("/approve")) return { status: "connected" };
    return { connections: [connection] };
  });
  mount(); await screen.findByText("Old Slack account");
  expect(api).toHaveBeenCalledTimes(1);
  expect(screen.queryByText("Access approved for this agent")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Verify connection" }));
  await screen.findByText("Workspace: Erandry");
  expect(screen.getByText("Shared vault · Verified — awaiting your approval")).toBeInTheDocument();
  expect(screen.queryByText(/Account\/workspace unverified/)).not.toBeInTheDocument();
  const approve = screen.getByRole("button", { name: "Reuse this connection" });
  expect(approve).toBeDisabled();
  expect(api.mock.calls.some(([path]) => path.endsWith("/approve"))).toBe(false);
  fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(approve);
  await screen.findByText("Access approved for this agent");
  expect(api).toHaveBeenCalledWith("/v1/connection-access/session/request/approve", expect.objectContaining({ body: JSON.stringify({ verification_id: "verification", confirmed: true, workspace_id: "T-old" }) }));
  expect(api.mock.calls.some(([path]) => path.endsWith("/events"))).toBe(false);
});
it("shows unverified authentication without an approval button", async () => {
  api.mockImplementation(async (path: string) => path.endsWith("/verify") ? { status: "unverified", message: "Provider unreachable" } : { connections: [connection] });
  mount(); fireEvent.click(await screen.findByRole("button", { name: "Verify connection" }));
  await screen.findByText("Unverified");
  expect(screen.queryByRole("button", { name: "Reuse this connection" })).not.toBeInTheDocument();
});
it("creates a separate vault for another account without overwriting the old one", async () => {
  const popup = { location: { href: "" }, close: vi.fn() };
  vi.spyOn(window, "open").mockReturnValue(popup as any);
  api.mockImplementation(async (path: string) => path === "/v1/vaults" ? { id: "new-vault" } : { connections: [connection] });
  mount(); fireEvent.click(await screen.findByRole("button", { name: "Connect another" }));
  await waitFor(() => expect(popup.location.href).toContain("vault_id=new-vault"));
  expect(popup.location.href).toContain("request_id=request");
  expect(popup.location.href).toContain("account_selection=choose");
  expect(api.mock.calls.some(([path]) => path.endsWith("/approve"))).toBe(false);
});

it("offers an account switch before starting Linear authorization", async () => {
  const popup = { location: { href: "" }, close: vi.fn() };
  const open = vi.spyOn(window, "open").mockReturnValue(popup as any);
  api.mockImplementation(async (path: string) => path === "/v1/vaults" ? { id: "new-vault" } : { connections: [] });
  mount({ ...request, service: "linear", mcp_server_url: "https://mcp.linear.app/mcp" });
  fireEvent.click(await screen.findByRole("button", { name: "Connect another" }));
  expect(screen.getByRole("link", { name: "Open Linear to switch accounts" })).toHaveAttribute("href", "https://linear.app");
  expect(open).not.toHaveBeenCalled();
  expect(api.mock.calls.some(([path]) => path === "/v1/vaults")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("button", { name: "Continue to Linear sign-in" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Connect another" }));
  fireEvent.click(screen.getByRole("button", { name: "Continue to Linear sign-in" }));
  await waitFor(() => expect(popup.location.href).toContain("account_selection=choose"));
  expect(api.mock.calls.some(([path]) => path.endsWith("/approve"))).toBe(false);
});

it("ignores a previous popup and verifies the selected return without granting access", async () => {
  const popup = { location: { href: "" }, close: vi.fn() };
  vi.spyOn(window, "open").mockReturnValue(popup as any);
  api.mockImplementation(async (path: string) => {
    if (path === "/v1/vaults") return { id: "new-vault" };
    if (path.endsWith("/verify")) return { status: "verified", verification_id: "receipt", account: "other@example.test", workspace: "Other workspace", workspace_id: "T-other" };
    return { connections: [connection] };
  });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Connect another" }));
  await waitFor(() => expect(popup.location.href).toContain("vault_id=new-vault"));
  const complete = (vaultId: string) => act(() => window.dispatchEvent(new MessageEvent("message", {
    origin: window.location.origin,
    data: { type: "oauth_complete", request_id: "request", session_id: "session", credential_id: "new-credential", vault_id: vaultId },
  })));
  complete("previous-attempt-vault");
  expect(api.mock.calls.some(([path]) => path.endsWith("/verify"))).toBe(false);
  complete("new-vault");
  await screen.findByText("Workspace: Other workspace");
  expect(screen.getByRole("button", { name: "Reuse this connection" })).toBeDisabled();
  expect(api.mock.calls.some(([path]) => path.endsWith("/approve"))).toBe(false);
});
