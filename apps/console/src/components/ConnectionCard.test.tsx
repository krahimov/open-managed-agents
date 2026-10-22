import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { ConnectionCard } from "./ConnectionCard";

const api = vi.hoisted(() => vi.fn());
vi.mock("../lib/api", () => ({ useApi: () => ({ api }) }));

const BASE = "/v1/connection-access/session/request";
const request = { request_id: "request", service: "linear", mcp_server_url: "https://mcp.linear.app/mcp", auth_kind: "mcp_oauth" };
const saved = { credential_id: "cred-1", vault_id: "vault-1", label: "Linear (OAuth)", vault_name: "Connected Apps", identity: null };
const karim = { status: "verified", account: "karim@serousal.com", workspace: "Serousal", workspace_id: "W1" };

function mount(props: Partial<Parameters<typeof ConnectionCard>[0]> = {}) {
  return render(<MemoryRouter><ConnectionCard request={request} sessionId="session" {...props} /></MemoryRouter>);
}

/** Route api() calls by path; `state` is what GET returns (mutable). */
function server(initial: { approved?: boolean; current?: unknown; connections?: unknown[] } = {}) {
  const state: Record<string, unknown> = { display_name: "Linear", approved: false, current: null, connections: [], ...initial };
  api.mockImplementation(async (path: string, init?: { method?: string; body?: string }) => {
    if (path === BASE) return structuredClone(state);
    if (path === `${BASE}/identify`) return karim;
    if (path === `${BASE}/use`) {
      Object.assign(state, { approved: true, current: { credential_id: "cred-1", vault_id: "vault-1", label: "Linear", account: karim.account, workspace: karim.workspace } });
      return { status: "connected", account: karim.account, workspace: karim.workspace };
    }
    if (path === `${BASE}/start`) return { vault_id: "vault-new", authorize_url: "/v1/oauth/authorize?x=1" };
    throw new Error(`unexpected ${init?.method ?? "GET"} ${path}`);
  });
  return state;
}

let popup: { location: { href: string }; close: ReturnType<typeof vi.fn>; closed: boolean };
beforeEach(() => {
  api.mockReset();
  popup = { location: { href: "" }, close: vi.fn(), closed: false };
  vi.spyOn(window, "open").mockReturnValue(popup as never);
  vi.stubGlobal("BroadcastChannel", class { addEventListener() {} removeEventListener() {} close() {} });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function complete(data: Record<string, unknown>) {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", {
      origin: window.location.origin,
      data: { type: "oauth_complete", request_id: "request", session_id: "session", ...data },
    }));
  });
}

describe("ConnectionCard", () => {
  it("names the service properly and offers a single Connect button when nothing is saved", async () => {
    server();
    mount();
    expect(await screen.findByText("Choose the account this agent works in")).toBeInTheDocument();
    expect(screen.getByText("Linear")).toBeInTheDocument();
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect Linear" })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByText(/Verify connection|Reuse this connection/)).not.toBeInTheDocument();
  });

  it("new sign-in: opens the popup during the click, then shows who got connected", async () => {
    const state = server();
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Connect Linear" }));
    expect(window.open).toHaveBeenCalledWith("", "oauth-request", expect.any(String));
    await waitFor(() => expect(popup.location.href).toBe("/v1/oauth/authorize?x=1"));
    expect(api).toHaveBeenCalledWith(`${BASE}/start`, expect.objectContaining({ method: "POST" }));
    expect(screen.getByText("Waiting for Linear…")).toBeInTheDocument();
    // A different card's popup must not complete this one.
    complete({ request_id: "someone-else", connected: true });
    expect(screen.getByText("Waiting for Linear…")).toBeInTheDocument();
    Object.assign(state, { approved: true, current: { credential_id: "c", vault_id: "v", label: "Linear", account: "ana@acme.com", workspace: "Acme" } });
    complete({ connected: true, account: "ana@acme.com", workspace: "Acme" });
    expect(await screen.findByText("ana@acme.com · Acme")).toBeInTheDocument();
    const card = screen.getByTestId("connection-card");
    expect(card).toHaveAttribute("data-state", "connected");
    expect(within(card).getByText("Connected")).toBeInTheDocument();
  });

  it("new sign-in that can't be verified shows the reason and stays unconnected", async () => {
    server();
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Connect Linear" }));
    await waitFor(() => expect(popup.location.href).not.toBe(""));
    complete({ connected: false, connect_error: "Authentication could not be verified. No access was granted." });
    expect(await screen.findByRole("alert")).toHaveTextContent("Authentication could not be verified");
    expect(screen.getByTestId("connection-card")).toHaveAttribute("data-state", "pending");
  });

  it("a blocked popup explains what to do", async () => {
    server();
    vi.mocked(window.open).mockReturnValue(null);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Connect Linear" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/blocked the sign-in window/);
    expect(api).not.toHaveBeenCalledWith(`${BASE}/start`, expect.anything());
  });

  it("closing the popup without finishing stops waiting and re-reads the server", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      server();
      mount();
      fireEvent.click(await screen.findByRole("button", { name: "Connect Linear" }));
      await waitFor(() => expect(popup.location.href).not.toBe(""));
      popup.closed = true;
      await act(async () => { vi.advanceTimersByTime(2_000); });
      await waitFor(() => expect(screen.getByRole("button", { name: "Connect Linear" })).toBeInTheDocument());
      expect(api.mock.calls.filter(([p]) => p === BASE).length).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("saved account: shows who it is, then one click on Use connects it", async () => {
    server({ connections: [saved] });
    mount();
    expect(await screen.findByText("karim@serousal.com · Serousal")).toBeInTheDocument();
    expect(api).toHaveBeenCalledWith(`${BASE}/identify`, expect.objectContaining({ body: JSON.stringify({ vault_id: "vault-1", credential_id: "cred-1" }) }));
    expect(screen.getByText("Saved Linear accounts")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Sign in with another Linear account/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Use" }));
    await waitFor(() => expect(screen.getByTestId("connection-card")).toHaveAttribute("data-state", "connected"));
    expect(api).toHaveBeenCalledWith(`${BASE}/use`, expect.objectContaining({
      body: JSON.stringify({ vault_id: "vault-1", credential_id: "cred-1", expected_workspace_id: "W1" }),
    }));
    expect(screen.getByText("karim@serousal.com · Serousal")).toBeInTheDocument();
  });

  it("Use stays disabled while the account is being checked", async () => {
    server({ connections: [saved] });
    let release!: (v: unknown) => void;
    const original = api.getMockImplementation()!;
    api.mockImplementation((path: string, init?: unknown) =>
      path.endsWith("/identify") ? new Promise((r) => { release = r; }) : original(path, init));
    mount();
    expect(await screen.findByText("Checking account…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use" })).toBeDisabled();
    await act(async () => release(karim));
    expect(screen.getByRole("button", { name: "Use" })).toBeEnabled();
  });

  it("a saved account that no longer works can't be used and says so", async () => {
    server({ connections: [saved] });
    const original = api.getMockImplementation()!;
    api.mockImplementation(async (path: string, init?: unknown) =>
      path.endsWith("/identify") ? { status: "unverified", message: "Authentication could not be verified. No access was granted. Reconnect or retry." } : original(path, init));
    mount();
    expect(await screen.findByText(/Authentication could not be verified/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use" })).toBeDisabled();
    expect(screen.getByText("Linear (OAuth)")).toBeInTheDocument();
  });

  it("uses cached identity from the server without re-checking", async () => {
    server({ connections: [{ ...saved, identity: karim }] });
    mount();
    expect(await screen.findByText("karim@serousal.com · Serousal")).toBeInTheDocument();
    expect(api).not.toHaveBeenCalledWith(`${BASE}/identify`, expect.anything());
  });

  it("Use that fails verification shows the server's reason", async () => {
    server({ connections: [{ ...saved, identity: karim }] });
    const original = api.getMockImplementation()!;
    api.mockImplementation(async (path: string, init?: unknown) =>
      path.endsWith("/use") ? { status: "unverified", message: "This account now points at a different workspace than the one shown." } : original(path, init));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Use" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("different workspace");
    expect(screen.getByTestId("connection-card")).toHaveAttribute("data-state", "pending");
  });

  it("connected: collapses to the account in use, and Change reopens the choices without it", async () => {
    server({
      approved: true,
      current: { credential_id: "cred-1", vault_id: "vault-1", label: "Linear", account: "karim@serousal.com", workspace: "Serousal" },
      connections: [{ ...saved, identity: karim }, { ...saved, credential_id: "cred-2", vault_id: "vault-2", identity: { status: "verified", account: "ana@acme.com", workspace: "Acme", workspace_id: "W2" } }],
    });
    mount();
    expect(await screen.findByText("karim@serousal.com · Serousal")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("ana@acme.com · Acme");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
  });

  it("an account that was removed after being chosen asks for another", async () => {
    server({ approved: false, connections: [] });
    const original = api.getMockImplementation()!;
    api.mockImplementation(async (path: string, init?: unknown) => {
      const r = await original(path, init);
      return path === BASE ? { ...r, broken: true } : r;
    });
    mount();
    expect(await screen.findByText(/The account this agent used was removed/)).toBeInTheDocument();
  });

  it("a server removed from the agent renders as no longer needed", async () => {
    api.mockRejectedValue(new Error("Linear is no longer configured on this agent"));
    mount();
    expect(await screen.findByText("Removed from this agent")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect Linear" })).not.toBeInTheDocument();
  });

  it("API-key servers take the key inline and connect it", async () => {
    server();
    const original = api.getMockImplementation()!;
    api.mockImplementation(async (path: string, init?: unknown) =>
      path.endsWith("/api_key") ? { status: "connected" } : original(path, init));
    render(<MemoryRouter><ConnectionCard request={{ ...request, service: "retell", mcp_server_url: "https://mcp.retellai.com/mcp", auth_kind: "mcp_api_key" }} sessionId="session" /></MemoryRouter>);
    const input = await screen.findByLabelText("Retell API key");
    fireEvent.change(input, { target: { value: " key_123 " } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(api).toHaveBeenCalledWith(`${BASE}/api_key`, expect.objectContaining({ body: JSON.stringify({ token: "key_123" }) })));
    expect(window.open).not.toHaveBeenCalled();
  });

  it("switches to the one-time app setup when the provider needs an OAuth app", async () => {
    server();
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Connect Linear" }));
    await waitFor(() => expect(popup.location.href).not.toBe(""));
    act(() => {
      window.dispatchEvent(new MessageEvent("message", {
        origin: window.location.origin,
        data: {
          type: "oauth_error", request_id: "request", session_id: "session", code: "oauth_app_required",
          provider: { required: true, configured: false, label: "Slack", issuer: "https://slack.com", callback_uri: "https://x/cb", env: { client_id: "A", client_secret: "B" }, setup_steps: ["Create an app"] },
        },
      }));
    });
    expect(await screen.findByText("Create an app")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect Linear" })).not.toBeInTheDocument();
  });

  it("re-reads the server when the session records the grant", async () => {
    server();
    const view = mount();
    await screen.findByRole("button", { name: "Connect Linear" });
    const before = api.mock.calls.filter(([p]) => p === BASE).length;
    view.rerender(<MemoryRouter><ConnectionCard request={request} sessionId="session" granted /></MemoryRouter>);
    await waitFor(() => expect(api.mock.calls.filter(([p]) => p === BASE).length).toBe(before + 1));
  });
});

describe("ConnectionCard loading", () => {
  it("a failed load offers Retry instead of a misleading 'Not connected'", async () => {
    server();
    const original = api.getMockImplementation()!;
    let fail = true;
    api.mockImplementation(async (path: string, init?: unknown) => {
      if (path === BASE && fail) throw new TypeError("Failed to fetch");
      return original(path, init);
    });
    mount();
    expect(await screen.findByText("Couldn't load this connection")).toBeInTheDocument();
    expect(screen.queryByText("Not connected")).not.toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("button", { name: "Connect Linear" })).toBeInTheDocument();
  });
});
