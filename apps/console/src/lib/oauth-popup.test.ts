import { afterEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import {
  createOAuthMessageDeduper,
  createOAuthMessageHub,
  openOAuthPopup,
} from "./oauth-popup";

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

describe("OAuth popup messages", () => {
  /** What node-oauth-routes.ts's callback page posts for a vault connect. */
  const vaultComplete = (service = "linear") => ({
    type: "oauth_complete",
    service,
    server_name: service,
    vault_id: "vlt-1",
    request_id: null,
    session_id: null,
    grant_recorded: false,
    probe_ok: true,
    probe_message: null,
  });

  function setup() {
    const channel = new EventTarget() as EventTarget & { close: () => void };
    channel.close = vi.fn();
    const hub = createOAuthMessageHub({
      openChannel: () => channel as unknown as BroadcastChannel,
    });
    const handler = vi.fn();
    const unsubscribe = hub.subscribe(handler);
    const viaOpener = (data: unknown, origin = window.location.origin) =>
      window.dispatchEvent(new MessageEvent("message", { data, origin }));
    const viaBroadcast = (data: unknown, origin = window.location.origin) =>
      channel.dispatchEvent(new MessageEvent("message", { data, origin }));
    return { hub, handler, unsubscribe, channel, viaOpener, viaBroadcast };
  }

  it("delivers a completion once when it arrives via both postMessage and BroadcastChannel", () => {
    const { handler, unsubscribe, viaOpener, viaBroadcast } = setup();
    // The callback page posts the same object to both transports.
    viaOpener(vaultComplete());
    viaBroadcast(vaultComplete());
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].data).toEqual(vaultComplete());

    // Either order.
    viaBroadcast(vaultComplete("sentry"));
    viaOpener(vaultComplete("sentry"));
    expect(handler).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("still delivers distinct completions, and repeats on the same transport", () => {
    const { handler, unsubscribe, viaOpener, viaBroadcast } = setup();
    viaOpener(vaultComplete("linear"));
    viaBroadcast(vaultComplete("linear"));
    viaOpener(vaultComplete("github"));
    viaBroadcast(vaultComplete("github"));
    expect(handler.mock.calls.map((c) => c[0].data.service)).toEqual(["linear", "github"]);

    // Opener severed by COOP: a second connect of the same service only
    // arrives on the channel, and must not be taken for an echo.
    viaBroadcast(vaultComplete("linear"));
    viaBroadcast(vaultComplete("linear"));
    expect(handler).toHaveBeenCalledTimes(4);
    unsubscribe();
  });

  it("does not let a message from another origin swallow the real one", () => {
    const { handler, unsubscribe, viaOpener, viaBroadcast } = setup();
    viaOpener(vaultComplete(), "https://unrelated.example");
    viaBroadcast(vaultComplete());
    expect(handler.mock.calls.map((c) => c[0].origin)).toEqual([
      "https://unrelated.example",
      window.location.origin,
    ]);
    unsubscribe();
  });

  it("forgets a copy that never got its pair after the window", () => {
    const deduper = createOAuthMessageDeduper(1000);
    const event = { data: vaultComplete(), origin: "https://console.example" };
    expect(deduper.accept(event, "window", 0)).toBe(true);
    expect(deduper.accept(event, "broadcast", 2000)).toBe(true);
    expect(deduper.accept(event, "window", 2500)).toBe(false);
  });

  it("dedupes across re-subscribing and fans out to every subscriber once", () => {
    const { hub, handler, unsubscribe, channel, viaOpener, viaBroadcast } = setup();
    const other = vi.fn();
    const unsubscribeOther = hub.subscribe(other);
    viaOpener(vaultComplete());
    // A component re-subscribing between the two copies (re-render from
    // handling the first) must not get the second.
    unsubscribe();
    const again = vi.fn();
    const unsubscribeAgain = hub.subscribe(again);
    viaBroadcast(vaultComplete());
    expect(handler).toHaveBeenCalledTimes(1);
    expect(other).toHaveBeenCalledTimes(1);
    expect(again).not.toHaveBeenCalled();

    unsubscribeOther();
    unsubscribeAgain();
    expect(channel.close).toHaveBeenCalled();
    viaOpener(vaultComplete("after"));
    expect(again).not.toHaveBeenCalled();
  });
});
