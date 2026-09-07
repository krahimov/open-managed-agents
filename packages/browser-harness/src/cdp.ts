// Connect to Chromium's DevTools protocol. This differs from
// chromium.connect(), which expects a Playwright launchServer endpoint.
import type { BrowserHarness, BrowserSession, BrowserSessionOpts, BrowserPage } from "./index";

interface CdpContext {
  pages(): BrowserPage[];
  newPage(): Promise<BrowserPage>;
  close?(): Promise<void>;
}

interface CdpSession {
  send(method: string, params: Record<string, unknown>): Promise<unknown>;
  detach(): Promise<void>;
}

export interface CdpConnection {
  contexts(): CdpContext[];
  newContext(): Promise<CdpContext>;
  isConnected?(): boolean;
  on?(event: "disconnected", listener: () => void): void;
  newBrowserCDPSession?(): Promise<CdpSession>;
  /** For connectOverCDP, closes the transport; does not send Browser.close. */
  close(): Promise<void>;
}

export type CdpConnector = (url: string, options: {
  headers?: Record<string, string>;
  timeout: number;
}) => Promise<CdpConnection>;

export interface CdpBrowserHarnessOpts {
  url: string;
  /** Preview authentication goes on the CDP handshake, never page requests. */
  headers?: Record<string, string>;
  /** Keep the machine's cookies, storage and existing tabs between sessions. */
  persistentContext?: boolean;
  /** Directory in the remote browser's filesystem, shared with shell tools. */
  downloadsPath?: string;
  /** Dependency seam for tests or a caller-provided Playwright runtime. */
  connect?: CdpConnector;
}

const defaultConnect: CdpConnector = async (url, options) => {
  const pw = await import(/* @vite-ignore */ "playwright-core" as string) as {
    chromium: { connectOverCDP: CdpConnector };
  };
  return pw.chromium.connectOverCDP(url, options);
};

export function createCdpBrowserHarness(opts: CdpBrowserHarnessOpts): BrowserHarness {
  return {
    async launch(launchOpts?: BrowserSessionOpts): Promise<BrowserSession> {
      return createCdpBrowserSession(opts, launchOpts?.hook);
    },
  };
}

function createCdpBrowserSession(opts: CdpBrowserHarnessOpts, hook: BrowserSessionOpts["hook"]): BrowserSession {
  let browser: CdpConnection | null = null;
  let page: BrowserPage | null = null;
  let openedAtMs: number | null = null;
  let inflight: Promise<BrowserPage> | null = null;
  let ownedContext: CdpContext | null = null;
  let downloadSession: CdpSession | null = null;

  async function configureDownloads(): Promise<void> {
    if (downloadSession && opts.downloadsPath) {
      await downloadSession.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: opts.downloadsPath, eventsEnabled: true });
    }
  }

  async function open(): Promise<BrowserPage> {
    const connected = await (opts.connect ?? defaultConnect)(opts.url, { headers: opts.headers, timeout: 30_000 });
    browser = connected;
    connected.on?.("disconnected", () => {
      if (browser === connected) { browser = null; page = null; }
    });
    try {
      const context = opts.persistentContext ? connected.contexts()[0] : await connected.newContext();
      if (!context) throw new Error("The agent computer browser has no persistent default context");
      if (!opts.persistentContext) ownedContext = context;
      if (opts.downloadsPath) {
        if (!connected.newBrowserCDPSession) throw new Error("CDP browser cannot configure the computer downloads directory");
        // Chromium resets this override when the CDP session detaches.
        downloadSession = await connected.newBrowserCDPSession();
        await configureDownloads();
      }
      page = (opts.persistentContext ? context.pages()[0] : undefined) ?? await context.newPage();
      openedAtMs ??= Date.now();
      return page;
    } catch (err) {
      await connected.close().catch(() => {});
      if (browser === connected) browser = null;
      throw err;
    }
  }

  async function ensure(): Promise<BrowserPage> {
    if (page && browser?.isConnected?.() !== false) {
      if (!(page as BrowserPage & { isClosed?(): boolean }).isClosed?.()) {
        // Another session's disconnect resets Chromium's download policy.
        // Reapply it before each tool uses this shared persistent context.
        await configureDownloads();
        return page;
      }
      page = null;
    }
    if (inflight) return inflight;
    // A tab closed by another session needs a fresh page, not an orphaned
    // second connection to the same browser.
    const pending = (async () => {
      if (browser) await browser.close().catch(() => {});
      return open();
    })();
    inflight = pending;
    try { return await pending; }
    finally { if (inflight === pending) inflight = null; }
  }

  return {
    page: ensure,
    isOpen: () => page !== null,
    async close() {
      await inflight?.catch(() => {});
      const elapsedMs = openedAtMs === null ? 0 : Date.now() - openedAtMs;
      const connected = browser;
      const context = ownedContext;
      const downloads = downloadSession;
      ownedContext = null;
      downloadSession = null;
      browser = null;
      page = null;
      openedAtMs = null;
      // Playwright's connectOverCDP wires this to WebSocketTransport.close.
      // Never close the default context/page or send CDP Browser.close:
      // those belong to the machine and are shared by other sessions.
      await context?.close?.().catch(() => {});
      await downloads?.detach().catch(() => {});
      await connected?.close().catch(() => {});
      const seconds = Math.floor(elapsedMs / 1000);
      if (seconds > 0 && hook) {
        try { await hook.onClose(seconds); }
        catch (err) { console.error(`[browser-harness/cdp] billing hook failed: ${(err as Error)?.message ?? err}`); }
      }
    },
  };
}
