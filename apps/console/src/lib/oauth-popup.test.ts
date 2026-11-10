import { afterEach, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { openOAuthPopup } from "./oauth-popup";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const params = () =>
  new URLSearchParams({ mcp_server_url: "https://mcp.linear.app/mcp", vault_id: "vlt-1" });

it("opens the popup synchronously, then points it at /authorize with a fetch-minted start token", async () => {
  const popup = { closed: false, location: { href: "" } };
  const open = vi.spyOn(window, "open").mockReturnValue(popup as any);
  const fetchMock = vi.fn(async () => Response.json({ token: "tok/1" }));
  vi.stubGlobal("fetch", fetchMock);

  expect(openOAuthPopup(params(), "oauth")).toBe(popup);
  // Blank first, so the click's user gesture opens it.
  expect(open).toHaveBeenCalledWith("", "oauth", "width=600,height=700,popup=yes");

  await waitFor(() => expect(popup.location.href).not.toBe(""));
  const url = new URL(popup.location.href, "https://console.example");
  expect(url.pathname).toBe("/v1/oauth/authorize");
  expect(url.searchParams.get("mcp_server_url")).toBe("https://mcp.linear.app/mcp");
  expect(url.searchParams.get("oauth_confirm")).toBe("tok/1");

  const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe("/v1/oauth/start-token");
  expect(init.method).toBe("POST");
  expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
  // The popup's navigation can't carry x-active-tenant, so neither does the mint.
  expect(init.headers).not.toHaveProperty("x-active-tenant");
  expect(JSON.parse(String(init.body))).toEqual({ query: params().toString() });
});

it("falls back to /authorize without a token (the confirm page) when minting fails", async () => {
  const popup = { closed: false, location: { href: "" } };
  vi.spyOn(window, "open").mockReturnValue(popup as any);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
  openOAuthPopup(params(), "oauth");
  await waitFor(() => expect(popup.location.href).not.toBe(""));
  expect(new URL(popup.location.href, "https://console.example").searchParams.has("oauth_confirm")).toBe(false);
});

it("returns null when the popup is blocked and mints nothing", () => {
  vi.spyOn(window, "open").mockReturnValue(null);
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  expect(openOAuthPopup(params(), "oauth")).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
});
