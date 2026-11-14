import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";

import { AccessRequestCard } from "./AccessRequestCard";

const api = vi.hoisted(() => vi.fn());
vi.mock("../lib/api", async (original) => ({ ...(await original<typeof import("../lib/api")>()), useApi: () => ({ api }) }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }) }));

const composioEvent = { type: "system.access_request", request_id: "acreq-c", service: "linear", composio_configured: true } as any;
const mcpEvent = {
  type: "system.access_request",
  request_id: "acreq-1",
  service: "linear",
  auth_kind: "mcp_oauth",
  mcp_server_url: "https://mcp.linear.app/mcp",
} as any;

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

const show = (props: Partial<Parameters<typeof AccessRequestCard>[0]> = {}) =>
  render(<AccessRequestCard event={composioEvent} sessionId="session-one" agentName="Incident commander" {...props} />, {
    wrapper: Wrapper,
  });

const fromUs = (data: unknown) =>
  act(() => {
    fireEvent(window, new MessageEvent("message", { origin: window.location.origin, data }));
  });

const posted = (suffix: string) => api.mock.calls.filter(([p]) => typeof p === "string" && p.endsWith(suffix));

let popup: { closed: boolean; location: { href: string }; close: ReturnType<typeof vi.fn> };

beforeEach(() => {
  api.mockReset();
  popup = { closed: false, location: { href: "" }, close: vi.fn() };
  vi.spyOn(window, "open").mockReturnValue(popup as any);
  vi.stubGlobal("BroadcastChannel", class { addEventListener() {} removeEventListener() {} close() {} });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ token: "tok-1" })));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Composio connect", () => {
  async function begin() {
    show({ vaultId: "chosen-vault" });
    fireEvent.click(screen.getByRole("button", { name: "Connect Linear" }));
    await screen.findByRole("button", { name: /Waiting for Linear…/ });
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith("/v1/vaults/chosen-vault/credentials/composio_accounts/link", expect.anything()),
    );
  }

  it("does not announce access when the provider account cannot be verified", async () => {
    api.mockImplementation(async (path: string) => {
      if (path.endsWith("/link")) return { redirect_url: "https://connect.composio.dev/link/test" };
      if (path.endsWith("/graft")) throw new Error("No active account was found");
      throw new Error("Unexpected request " + path);
    });
    await begin();
    fromUs({ type: "composio_auth_complete", toolkit: "linear" });
    expect(await screen.findByRole("alert")).toHaveTextContent("No active account was found");
    expect(posted("/events")).toHaveLength(0);
    expect(screen.queryByText("Linear connected.")).not.toBeInTheDocument();
    // It can be tried again.
    expect(screen.getByRole("button", { name: "Connect Linear" })).toBeEnabled();
  });

  it("ignores foreign-origin callbacks, then uses the selected vault and resumes after a verified success", async () => {
    api.mockImplementation(async (path: string) =>
      path.endsWith("/link") ? { redirect_url: "https://connect.composio.dev/link/test" } : { attached_server: true },
    );
    await begin();
    expect(popup.location.href).toBe("https://connect.composio.dev/link/test");
    act(() => {
      fireEvent(
        window,
        new MessageEvent("message", { origin: "https://unrelated.example", data: { type: "composio_auth_complete", toolkit: "linear" } }),
      );
    });
    expect(posted("/graft")).toHaveLength(0);
    fromUs({ type: "composio_auth_complete", toolkit: "linear" });
    await screen.findByText("Linear connected.");
    expect(api).toHaveBeenCalledWith(
      "/v1/sessions/session-one/composio/graft",
      expect.objectContaining({ body: JSON.stringify({ toolkit: "linear", vault_id: "chosen-vault" }) }),
    );
    expect(api).toHaveBeenCalledWith("/v1/sessions/session-one/events", expect.anything());
  });
});

describe("MCP sign-in", () => {
  beforeEach(() => {
    api.mockImplementation(async (path: string) => {
      if (path.startsWith("/v1/vaults?")) return { data: [{ id: "vlt-apps", name: "Connected Apps" }] };
      return {};
    });
  });

  it("opens the start-token sign-in for this session and request, and does not wake the agent twice", async () => {
    show({ event: mcpEvent });
    fireEvent.click(screen.getByRole("button", { name: "Connect Linear" }));
    await waitFor(() => expect(popup.location.href).not.toBe(""));
    const url = new URL(popup.location.href, "https://console.example");
    expect(url.pathname).toBe("/v1/oauth/authorize");
    expect(url.searchParams.get("oauth_confirm")).toBe("tok-1");
    expect(url.searchParams.get("mcp_server_url")).toBe("https://mcp.linear.app/mcp");
    expect(url.searchParams.get("vault_id")).toBe("vlt-apps");
    expect(url.searchParams.get("session_id")).toBe("session-one");
    expect(url.searchParams.get("request_id")).toBe("acreq-1");
    expect(url.searchParams.get("service")).toBe("linear");

    // Another card's popup finishing is not this one.
    fromUs({ type: "oauth_complete", request_id: "acreq-other", grant_recorded: true });
    expect(screen.queryByText("Linear connected.")).not.toBeInTheDocument();

    fromUs({ type: "oauth_complete", request_id: "acreq-1", grant_recorded: true });
    await screen.findByText("Linear connected.");
    // The OAuth callback already told the agent.
    expect(posted("/events")).toHaveLength(0);
  });

  it("tells the agent itself when the server did not record the grant", async () => {
    show({ event: mcpEvent });
    fireEvent.click(screen.getByRole("button", { name: "Connect Linear" }));
    await waitFor(() => expect(popup.location.href).not.toBe(""));
    fromUs({ type: "oauth_complete", request_id: null });
    await screen.findByText("Linear connected.");
    await waitFor(() => expect(posted("/events")).toHaveLength(1));
  });

  it("says so when the browser blocks the sign-in window", () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    show({ event: mcpEvent });
    fireEvent.click(screen.getByRole("button", { name: "Connect Linear" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/blocked the sign-in window/);
    expect(screen.getByRole("button", { name: "Connect Linear" })).toBeEnabled();
  });

  it("shows the popup's error on the card", async () => {
    show({ event: mcpEvent });
    fireEvent.click(screen.getByRole("button", { name: "Connect Linear" }));
    await waitFor(() => expect(popup.location.href).not.toBe(""));
    fromUs({ type: "oauth_error", message: "Token exchange failed." });
    expect(screen.getByRole("alert")).toHaveTextContent("Token exchange failed.");
  });
});

describe("one-time OAuth app setup", () => {
  const requirement = {
    required: true,
    configured: false,
    label: "Slack",
    issuer: "https://mcp.slack.com",
    callback_uri: "https://console.example/v1/oauth/callback",
    env: { client_id: "SLACK_MCP_CLIENT_ID", client_secret: "SLACK_MCP_CLIENT_SECRET" },
    setup_steps: ["Create a Slack app.", "Paste the callback URL."],
  };
  const slackEvent = { ...mcpEvent, service: "slack", mcp_server_url: "https://mcp.slack.com/mcp", oauth_app: requirement };

  it("walks through the app setup instead of a Connect button, then signs in", async () => {
    api.mockImplementation(async (path: string) => {
      if (path.startsWith("/v1/vaults?")) return { data: [{ id: "vlt-apps", name: "Connected Apps" }] };
      return { ok: true };
    });
    show({ event: slackEvent });
    expect(screen.queryByRole("button", { name: "Connect Slack" })).not.toBeInTheDocument();
    expect(screen.getByText("https://console.example/v1/oauth/callback")).toBeInTheDocument();
    expect(screen.getByText("Create a Slack app.")).toBeInTheDocument();
    const save = screen.getByRole("button", { name: "Save and connect Slack" });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Client ID"), { target: { value: "cid" } });
    fireEvent.change(screen.getByLabelText("Client secret"), { target: { value: "secret" } });
    fireEvent.click(save);
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        "/v1/oauth/apps",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ issuer: "https://mcp.slack.com", client_id: "cid", client_secret: "secret" }),
        }),
      ),
    );
    await waitFor(() => expect(popup.location.href).toContain("/v1/oauth/authorize?"));
  });

  it("learns the requirement late from the popup's error", async () => {
    api.mockImplementation(async (path: string) =>
      path.startsWith("/v1/vaults?") ? { data: [{ id: "vlt-apps", name: "Connected Apps" }] } : {},
    );
    show({ event: { ...mcpEvent, service: "slack", mcp_server_url: "https://mcp.slack.com/mcp" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect Slack" }));
    await waitFor(() => expect(popup.location.href).not.toBe(""));
    fromUs({ type: "oauth_error", code: "oauth_app_required", provider: requirement, message: "Slack needs a one-time app setup" });
    expect(await screen.findByRole("button", { name: "Save and connect Slack" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("what the card says", () => {
  it("names the agent that asked", () => {
    show();
    expect(screen.getByText("Incident commander needs access to Linear")).toBeInTheDocument();
  });

  it("reads the agent's name from the session when the caller did not give it", async () => {
    api.mockImplementation(async (path: string) =>
      path === "/v1/sessions/session-one" ? { id: "session-one", agent: { id: "agent_1", version: 1, name: "Billing helper" } } : {},
    );
    show({ agentName: undefined });
    expect(await screen.findByText("Billing helper needs access to Linear")).toBeInTheDocument();
  });

  it("reads as connected once the server recorded the grant, and never posts a nudge", () => {
    show({ granted: true });
    expect(screen.getByText("Linear connected.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect Linear" })).not.toBeInTheDocument();
    expect(posted("/events")).toHaveLength(0);
  });
});

describe("API-key servers", () => {
  it("saves the key in the vault, declares the server on the agent and tells it", async () => {
    api.mockImplementation(async (path: string) =>
      path.startsWith("/v1/vaults?") ? { data: [{ id: "vlt-apps", name: "Connected Apps" }] } : {},
    );
    show({ event: { ...mcpEvent, service: "retell", auth_kind: "mcp_api_key", mcp_server_url: "https://mcp.retell.ai/mcp" } });
    expect(screen.queryByRole("button", { name: /^Connect/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Retell API key"), { target: { value: "key_123" } });
    fireEvent.click(screen.getByRole("button", { name: "Save to vault" }));
    await screen.findByText("Retell connected.");
    expect(api).toHaveBeenCalledWith("/v1/vaults/vlt-apps/credentials", expect.objectContaining({ method: "POST" }));
    expect(api).toHaveBeenCalledWith(
      "/v1/sessions/session-one/access/attach",
      expect.objectContaining({
        body: JSON.stringify({ service: "retell", vault_id: "vlt-apps", mcp_server_url: "https://mcp.retell.ai/mcp" }),
      }),
    );
    expect(posted("/events")).toHaveLength(1);
  });
});
