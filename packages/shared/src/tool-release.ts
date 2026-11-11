// Per-turn tool dict cleanup.
//
// buildTools() opens one MCP client per declared server every time it
// runs (each turn, each approval). The AI SDK's HTTP transport holds a GET
// SSE stream open per client until close(), and nothing closed them — a
// long-lived Node process accumulated one stream (plus its reconnect
// timer) per server per turn. buildTools now hangs a non-enumerable
// release function off the dict it returns; whoever owns the dict's
// lifetime (session-runtime's turn loop, the approval path) calls
// releaseTools() when it is done with it. Non-enumerable, so
// Object.keys / spreads of the dict never see it.

export const TOOLS_RELEASE = Symbol.for("oma.tools.release");

/** Attach `release` to a tool dict (idempotent: runs at most once). */
export function attachToolsRelease(tools: object, release: () => Promise<void>): void {
  let done = false;
  Object.defineProperty(tools, TOOLS_RELEASE, {
    value: async () => {
      if (done) return;
      done = true;
      await release();
    },
    enumerable: false,
    configurable: true,
  });
}

/** Release what a tool dict holds open (MCP clients). Never throws; a
 *  dict without a release hook is a no-op. */
export async function releaseTools(tools: unknown): Promise<void> {
  const release = (tools as { [TOOLS_RELEASE]?: unknown } | null | undefined)?.[TOOLS_RELEASE];
  if (typeof release !== "function") return;
  try {
    await (release as () => Promise<void>)();
  } catch {
    // Best effort — a failed close only leaks what used to leak.
  }
}
