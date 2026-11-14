import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { http, HttpResponse } from "msw";

import { server } from "@/mocks/server";
import { AddCredentialDialog } from "./AddCredentialDialog";

const api = vi.hoisted(() => vi.fn());
// The dialog's own requests go to this mock. lib/server-features is loaded
// by the msw handlers before this mock exists, so the feature list (and
// the start-token mint, a raw fetch) go through msw instead.
vi.mock("@/lib/api", async (original) => ({ ...(await original<typeof import("@/lib/api")>()), useApi: () => ({ api }) }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }) }));

const vault = { id: "vlt-1", name: "Team logins", created_at: "2026-11-01T00:00:00Z" };
function answer(path: string): unknown {
  if (path.startsWith("/v1/composio/status")) return { configured: true, source: "env" };
  if (path.includes("/composio_toolkits")) return { data: [] };
  if (path.endsWith("/composio_tool_router_session/refresh")) return { refreshed: 1 };
  if (path === "/v1/oauth/apps") return { ok: true };
  throw new Error("Unexpected request " + path);
}

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

const open = (props: Partial<Parameters<typeof AddCredentialDialog>[0]> = {}) =>
  render(
    <AddCredentialDialog vault={vault} hasComposioCredential={false} onClose={vi.fn()} onCreated={vi.fn()} {...props} />,
    { wrapper: Wrapper },
  );

const fromUs = (data: unknown) =>
  act(() => {
    fireEvent(window, new MessageEvent("message", { origin: window.location.origin, data }));
  });

let popup: { closed: boolean; location: { href: string }; close: ReturnType<typeof vi.fn> };

beforeEach(() => {
  server.use(http.post("*/v1/oauth/start-token", () => HttpResponse.json({ token: "tok-1" })));
  api.mockReset();
  api.mockImplementation(async (path: string) => answer(path));
  popup = { closed: false, location: { href: "" }, close: vi.fn() };
  vi.spyOn(window, "open").mockReturnValue(popup as any);
  vi.stubGlobal("BroadcastChannel", class { addEventListener() {} removeEventListener() {} close() {} });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function startSignIn(url = "https://mcp.slack.com/mcp") {
  open();
  fireEvent.change(screen.getByRole("combobox"), { target: { value: url } });
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  await waitFor(() => expect(popup.location.href).not.toBe(""));
}

describe("MCP sign-in", () => {
  it("starts the sign-in with a one-time start token", async () => {
    await startSignIn("https://mcp.sentry.dev/mcp");
    const target = new URL(popup.location.href, "https://console.example");
    expect(target.pathname).toBe("/v1/oauth/authorize");
    expect(target.searchParams.get("oauth_confirm")).toBe("tok-1");
    expect(target.searchParams.get("vault_id")).toBe("vlt-1");
    expect(target.searchParams.get("mcp_server_url")).toBe("https://mcp.sentry.dev/mcp");
    expect(screen.getByText("Finish signing in in the popup window")).toBeInTheDocument();
  });

  it("shows the popup's error instead of waiting forever", async () => {
    await startSignIn();
    fromUs({ type: "oauth_error", message: "The provider refused the request." });
    expect(screen.getByText("The provider refused the request.")).toBeInTheDocument();
    expect(screen.queryByText("Finish signing in in the popup window")).not.toBeInTheDocument();
  });

  it("turns into the one-time app setup when the provider needs one, then signs in again", async () => {
    await startSignIn();
    popup.location.href = "";
    fromUs({
      type: "oauth_error",
      code: "oauth_app_required",
      message: "Slack needs a one-time app setup",
      provider: {
        required: true,
        configured: false,
        label: "Slack",
        issuer: "https://mcp.slack.com",
        callback_uri: "https://console.example/v1/oauth/callback",
        env: { client_id: "SLACK_MCP_CLIENT_ID", client_secret: "SLACK_MCP_CLIENT_SECRET" },
        setup_steps: ["Create a Slack app."],
      },
    });
    // One primary action: the panel's, not the footer's Connect.
    expect(screen.queryByRole("button", { name: "Connect" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Client ID"), { target: { value: "cid" } });
    fireEvent.change(screen.getByLabelText("Client secret"), { target: { value: "shh" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and connect Slack" }));
    await waitFor(() => expect(api).toHaveBeenCalledWith("/v1/oauth/apps", expect.objectContaining({ method: "PUT" })));
    await waitFor(() => expect(popup.location.href).toContain("mcp_server_url=https%3A%2F%2Fmcp.slack.com%2Fmcp"));
  });
});

describe("Composio", () => {
  it("re-provisions the vault's tool routers once an account turns active", async () => {
    const onCredentialsChanged = vi.fn();
    const onCreated = vi.fn();
    open({ initialKind: "composio", hasComposioCredential: true, onCredentialsChanged, onCreated });
    fromUs({ type: "composio_auth_complete", toolkit: "github" });
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        "/v1/vaults/vlt-1/credentials/composio_tool_router_session/refresh",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    await waitFor(() => expect(onCredentialsChanged).toHaveBeenCalled());
    // The dialog stays open: its own submit still creates the router.
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("does not refresh when the vault has no router yet", async () => {
    open({ initialKind: "composio", hasComposioCredential: false });
    fromUs({ type: "composio_auth_complete", toolkit: "github" });
    await Promise.resolve();
    expect(api.mock.calls.some(([p]) => String(p).endsWith("/refresh"))).toBe(false);
  });
});

describe("CLI sign-in", () => {
  it("offers the device-flow sign-in when the server has it", async () => {
    open({ initialKind: "cli" });
    expect(await screen.findByRole("button", { name: "Sign in with gh" })).toBeInTheDocument();
  });

  it("hides it on a server without it, leaving the token field", async () => {
    let asked = false;
    server.use(
      http.get("*/v1/server_features", () => {
        asked = true;
        return HttpResponse.json({ features: [] });
      }),
    );
    open({ initialKind: "cli" });
    await waitFor(() => expect(asked).toBe(true));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole("button", { name: "Sign in with gh" })).not.toBeInTheDocument();
    expect(screen.queryByText(/sign-in available/)).not.toBeInTheDocument();
    expect(screen.getByText("Write-only: it cannot be read back after you save.")).toBeInTheDocument();
  });
});
