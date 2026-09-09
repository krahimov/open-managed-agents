import { describe, expect, it, vi } from "vitest";
import { createCdpBrowserHarness, type CdpConnection } from "../src/cdp";
import { createSandboxBrowserHarness } from "../src/sandbox";
import type { BrowserPage } from "../src/index";

function fakeConnection() {
  const page = { isClosed: () => false } as unknown as BrowserPage;
  const context = { pages: () => [page], newPage: vi.fn(async () => page) };
  const browser: CdpConnection = {
    contexts: () => [context], newContext: vi.fn(async () => context),
    close: vi.fn(async () => {}), isConnected: () => true,
  };
  return { page, context, browser, connect: vi.fn(async () => browser) };
}

describe("CDP sessions", () => {
  it("authenticates only the connection and reuses the machine's context and page", async () => {
    const f = fakeConnection();
    const headers = { "x-daytona-preview-token": "private-token" };
    const s = await createCdpBrowserHarness({ url: "wss://preview/devtools/browser/123", headers, persistentContext: true, connect: f.connect }).launch();
    expect(f.connect).not.toHaveBeenCalled();
    const pages = await Promise.all([s.page(), s.page()]);
    expect(pages).toEqual([f.page, f.page]);
    expect(f.connect).toHaveBeenCalledExactlyOnceWith("wss://preview/devtools/browser/123", { headers, timeout: 30000 });
    expect(f.browser.newContext).not.toHaveBeenCalled();
    expect(f.context.newPage).not.toHaveBeenCalled();
    await s.close();
    await s.close();
    expect(f.browser.close).toHaveBeenCalledTimes(1);
    expect(s.isOpen()).toBe(false);
  });

  it("creates a persistent tab when there are no existing tabs", async () => {
    const f = fakeConnection();
    f.context.pages = () => [];
    const s = await createCdpBrowserHarness({ url: "ws://browser", persistentContext: true, connect: f.connect }).launch();
    expect(await s.page()).toBe(f.page);
    expect(f.context.newPage).toHaveBeenCalledTimes(1);
  });

  it("keeps download configuration attached until the browser session closes", async () => {
    const f = fakeConnection();
    const send = vi.fn(async () => undefined);
    const detach = vi.fn(async () => {});
    f.browser.newBrowserCDPSession = async () => ({ send, detach });
    const s = await createCdpBrowserHarness({ url: "ws://browser", persistentContext: true, downloadsPath: "/workspace/downloads", connect: f.connect }).launch();
    await s.page();
    expect(send).toHaveBeenCalledWith("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: "/workspace/downloads", eventsEnabled: true });
    expect(detach).not.toHaveBeenCalled();
    await s.close();
    expect(detach).toHaveBeenCalledTimes(1);
  });

  it("disconnects after a context initialization error and permits retry", async () => {
    const f = fakeConnection();
    f.browser.contexts = () => [];
    const s = await createCdpBrowserHarness({ url: "ws://browser", persistentContext: true, connect: f.connect }).launch();
    await expect(s.page()).rejects.toThrow("no persistent default context");
    expect(f.browser.close).toHaveBeenCalledTimes(1);
    f.browser.contexts = () => [f.context];
    expect(await s.page()).toBe(f.page);
  });
});

describe("sandbox browser routing", () => {
  it("disposes every wrapper once without closing the machine's persistent tabs", async () => {
    const f = fakeConnection();
    const closeContext = vi.fn(async () => {});
    const closePage = vi.fn(async () => {});
    Object.assign(f.context, { close: closeContext });
    Object.assign(f.page, { close: closePage });
    const harness = createSandboxBrowserHarness({ getBrowserEndpoint: async () => ({ wsUrl: "ws://private/browser", generation: 1, headers: {} }) }, { connect: f.connect });
    const first = await harness.launch();
    const second = await harness.launch();
    const unused = await harness.launch();
    await first.page();
    await second.page();
    await first.close();
    expect(f.browser.close).toHaveBeenCalledTimes(1);
    await Promise.all([harness.dispose(), harness.dispose()]);
    expect(f.browser.close).toHaveBeenCalledTimes(2);
    expect(closeContext).not.toHaveBeenCalled();
    expect(closePage).not.toHaveBeenCalled();
    expect(second.isOpen()).toBe(false);
    await expect(second.page()).rejects.toThrow("session is closed");
    await expect(unused.page()).rejects.toThrow("session is closed");
    await expect(harness.launch()).rejects.toThrow("harness is disposed");
  });

  it("fails explicitly for computers without a browser", async () => {
    const s = await createSandboxBrowserHarness({ getBrowserEndpoint: async () => null }).launch();
    await expect(s.page()).rejects.toThrow("does not have its browser enabled");
  });

  it("reconnects when credentials rotate or the computer is recreated", async () => {
    const f = fakeConnection();
    let generation = 1;
    let token = "token-1";
    const endpoint = vi.fn(async () => ({ wsUrl: `wss://private/devtools/browser/${generation}`, generation, headers: { "x-daytona-preview-token": token } }));
    const s = await createSandboxBrowserHarness({ getBrowserEndpoint: endpoint }, { connect: f.connect }).launch();
    await Promise.all([s.page(), s.page()]);
    await s.page();
    expect(f.connect).toHaveBeenCalledTimes(1);
    token = "token-2";
    await s.page();
    generation = 2;
    await s.page();
    expect(f.connect).toHaveBeenCalledTimes(3);
    expect(f.browser.close).toHaveBeenCalledTimes(2);
    expect(endpoint).toHaveBeenCalledTimes(4);
  });
});
