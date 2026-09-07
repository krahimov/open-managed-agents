import { NotSupportedError, type BrowserHarness, type BrowserSession, type BrowserPage } from "./index";
import { createCdpBrowserHarness, type CdpConnector } from "./cdp";

/** Structural subset of SandboxExecutor, with no Node/sandbox dependency. */
export interface BrowserSandbox {
  getBrowserEndpoint?(): Promise<{
    wsUrl: string;
    headers: Record<string, string>;
    generation: number;
    downloadsPath?: string;
  } | null>;
}

/** Browser tools use the same Linux machine as the session's file tools. */
export function createSandboxBrowserHarness(sandbox: BrowserSandbox, options?: { connect?: CdpConnector }): BrowserHarness & { dispose(): Promise<void> } {
  const sessions = new Set<BrowserSession>();
  let disposed = false;
  return {
    async launch(opts) {
      if (disposed) throw new Error("The sandbox browser harness is disposed");
      let session: BrowserSession | null = null;
      let endpointKey: string | null = null;
      let inflight: Promise<BrowserPage> | null = null;
      let closing: Promise<void> | null = null;
      let closed = false;
      async function resolvePage(): Promise<BrowserPage> {
        const endpoint = await sandbox.getBrowserEndpoint?.();
        if (!endpoint) throw new NotSupportedError("This agent computer does not have its browser enabled");
        // Re-resolve every tool call: recreated computers have new browser
        // ids, and stopped/started Daytona boxes rotate preview tokens.
        const key = JSON.stringify([endpoint.generation, endpoint.wsUrl, endpoint.headers, endpoint.downloadsPath]);
        if (!session || key !== endpointKey) {
          await session?.close();
          session = await createCdpBrowserHarness({
            url: endpoint.wsUrl,
            headers: endpoint.headers,
            persistentContext: true,
            downloadsPath: endpoint.downloadsPath,
            connect: options?.connect,
          }).launch(opts);
          endpointKey = key;
        }
        return session.page();
      }
      const wrapper: BrowserSession = {
        async page() {
          if (closed || disposed) throw new Error("The sandbox browser session is closed");
          if (inflight) return inflight;
          const pending = resolvePage();
          inflight = pending;
          try { return await pending; }
          finally { if (inflight === pending) inflight = null; }
        },
        isOpen: () => !closed && (session?.isOpen() ?? false),
        async close() {
          if (closing) return closing;
          closed = true;
          closing = (async () => {
            try {
              await inflight?.catch(() => {});
              await session?.close();
            } finally {
              session = null;
              endpointKey = null;
              sessions.delete(wrapper);
            }
          })();
          return closing;
        },
      };
      sessions.add(wrapper);
      return wrapper;
    },
    async dispose() {
      disposed = true;
      const results = await Promise.allSettled([...sessions].map((session) => session.close()));
      const errors = results.filter((result) => result.status === "rejected");
      if (errors.length) throw new AggregateError(errors.map((result) => result.reason), "Failed to disconnect sandbox browser sessions");
    },
  };
}
