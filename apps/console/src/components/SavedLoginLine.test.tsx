import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { SavedLoginLine } from "./SavedLoginLine";

const event = {
  type: "system.saved_login_attached",
  request_id: "acreq-1",
  service: "linear",
  mcp_server_url: "https://mcp.linear.app/mcp",
  vault_id: "vlt-1",
  vault_name: "linear connection",
  agent_name: "Incident commander",
  can_switch: true,
} as any;

const show = (props: Partial<Parameters<typeof SavedLoginLine>[0]> = {}) =>
  render(
    <MemoryRouter>
      <SavedLoginLine event={event} sessionId="sess-1" {...props} />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.stubGlobal("BroadcastChannel", class { addEventListener() {} removeEventListener() {} close() {} });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ token: "tok-1" })));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("names the vault the agent got and links to it", () => {
  show();
  expect(screen.getByText("Linear")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "linear connection" })).toHaveAttribute("href", "/vaults/vlt-1");
});

it("switches into a new vault, never the shared one, against this session", async () => {
  const popup = { closed: false, location: { href: "" } };
  vi.spyOn(window, "open").mockReturnValue(popup as any);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ token: "tok-1" })));
  show();
  fireEvent.click(screen.getByRole("button", { name: "Switch account" }));
  await waitFor(() => expect(popup.location.href).not.toBe(""));
  const url = new URL(popup.location.href, "https://console.example");
  expect(url.pathname).toBe("/v1/oauth/authorize");
  expect(url.searchParams.get("oauth_confirm")).toBe("tok-1");
  expect(url.searchParams.get("new_vault_name")).toBe("linear · Incident commander");
  expect(url.searchParams.has("vault_id")).toBe(false);
  expect(url.searchParams.get("session_id")).toBe("sess-1");
  expect(url.searchParams.get("request_id")).toBe("acreq-1");
  expect(screen.getByRole("button", { name: "Waiting for sign-in…" })).toBeDisabled();
});

it("shows the error from the popup and lets the user retry", () => {
  vi.spyOn(window, "open").mockReturnValue({ closed: false, location: { href: "" } } as any);
  show();
  fireEvent.click(screen.getByRole("button", { name: "Switch account" }));
  act(() => {
    fireEvent(window, new MessageEvent("message", {
      origin: window.location.origin,
      data: { type: "oauth_error", message: "Authorization failed" },
    }));
  });
  expect(screen.getByText("Authorization failed")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Switch account" })).toBeEnabled();
});

it("does not get stuck waiting when the popup is closed", () => {
  vi.useFakeTimers();
  try {
    const popup = { closed: false, location: { href: "" } };
    vi.spyOn(window, "open").mockReturnValue(popup as any);
    show();
    fireEvent.click(screen.getByRole("button", { name: "Switch account" }));
    popup.closed = true;
    act(() => { vi.advanceTimersByTime(600); });
    expect(screen.getByRole("button", { name: "Switch account" })).toBeEnabled();
  } finally {
    vi.useRealTimers();
  }
});

it("tells the user when the sign-in window was blocked", () => {
  vi.spyOn(window, "open").mockReturnValue(null);
  show();
  fireEvent.click(screen.getByRole("button", { name: "Switch account" }));
  expect(screen.getByText(/blocked the sign-in window/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Switch account" })).toBeEnabled();
});

it("says the new account is in use once the grant is recorded", () => {
  show({ switched: true });
  expect(screen.getByText(/using the account you just signed in with/)).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "linear connection" })).not.toBeInTheDocument();
});

it("offers no switch for a login OAuth can't replace", () => {
  show({ event: { ...event, can_switch: false } });
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "linear connection" })).toBeInTheDocument();
});
