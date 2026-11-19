// @open-managed-agents/browser-harness — runtime-agnostic browser tool surface.
//
// Three impls live in sibling files:
//   - cf.ts      → wraps @cloudflare/playwright + the BROWSER binding
//   - node.ts    → wraps playwright-core's chromium.launch() (lazy import)
//   - cdp.ts     → wraps playwright-core's chromium.connectOverCDP() to a remote
//                  Browserless / k8s pool (BROWSERLESS_URL)
//   - disabled.ts → throw-on-call placeholder when nothing else is wired
//
// The agent harness consumes ONLY the BrowserHarness + BrowserSession
// interfaces from this file; no Playwright type leaks into apps/agent.

import { z } from "zod";
import { tool } from "ai";

/** Subset of Playwright Page methods the harness uses. Typed loosely so
 *  the package doesn't have to depend on @cloudflare/playwright or
 *  playwright-core directly — both shapes satisfy this interface. */
export interface BrowserPage {
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<{ status?(): number } | null>;
  url(): string;
  screenshot(opts?: { fullPage?: boolean; type?: "png" | "jpeg"; quality?: number }): Promise<Uint8Array | { toString(enc: string): string }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  locator(selector: string): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  evaluate(expr: string | ((arg?: unknown) => unknown), arg?: unknown): Promise<any>;
  content(): Promise<string>;
}

/** One Browser+Page wrapper, lazy-launched on first page() call. */
export interface BrowserSession {
  page(): Promise<BrowserPage>;
  close(): Promise<void>;
  isOpen(): boolean;
}

/** Optional billing hook — fired once on close() with the elapsed
 *  page-open seconds. CF SessionDO wires this to UsageStore.recordUsage. */
export interface BrowserBillingHook {
  tenantId: string;
  sessionId: string;
  agentId?: string | null;
  onClose: (elapsedSeconds: number) => Promise<void> | void;
}

export interface BrowserSessionOpts {
  hook?: BrowserBillingHook | null;
}

/** Factory for BrowserSession. CF / Node / CDP / Disabled implement this. */
export interface BrowserHarness {
  launch(opts?: BrowserSessionOpts): Promise<BrowserSession>;
}

/** Thrown by the Disabled impl when an agent calls a browser_* tool but
 *  no backend is configured. Wrapped as a tool-result string so the LLM
 *  sees the message and can fall back to web_fetch. */
export class NotSupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotSupportedError";
  }
}

const DEFAULT_TIMEOUT = 30_000;
/** Screenshots saved as .jpg/.jpeg: still sharp for text, a fraction of the PNG. */
const JPEG_QUALITY = 80;

/** Every tool name `buildBrowserTools` registers. Hosts classify these as
 *  built-in (server-executed) tools — the toolset config names the group
 *  "browser", which is never a registered tool itself. */
export const BROWSER_TOOL_NAMES = [
  "browser_navigate",
  "browser_screenshot",
  "browser_click",
  "browser_type",
  "browser_get_text",
  "browser_eval",
  "browser_close",
] as const;

/** Host hooks for browser tools that touch the session's machine. */
export interface BrowserToolOptions {
  /** Write bytes into the session's sandbox (the same filesystem as the
   *  file tools) and return the absolute path written. Enables
   *  browser_screenshot's `save_path`; absent → the parameter is refused.
   *  Hosts pass it only where a file write needs no approval. */
  saveFile?: (path: string, bytes: Uint8Array) => Promise<string>;
}

/**
 * Make `expression` safe for Playwright's string `evaluate` when it uses
 * top-level `await`, which is a syntax error in a plain script. An
 * expression becomes `(async () => (expr))()`; statements become an async
 * IIFE body, so a value must be `return`ed. Code without `await` is sent
 * unchanged. The form is chosen by parsing (never running) the code here;
 * where the runtime forbids code generation (workerd), the expression form
 * is assumed.
 */
export function wrapTopLevelAwait(expression: string): string {
  if (!/\bawait\b/.test(expression)) return expression;
  const trimmed = expression.trim().replace(/;+\s*$/, "");
  // Already an async function or IIFE: the page awaits what it returns.
  if (/^\(?\s*async\b/.test(trimmed)) return expression;
  const asExpression = `(async () => (${trimmed}\n))()`;
  const asStatements = `(async () => {\n${expression}\n})()`;
  const parses = (source: string): boolean | null => {
    try {
      // Parse only: the constructed function is never called.
      new Function(source);
      return true;
    } catch (err) {
      return err instanceof SyntaxError ? false : null;
    }
  };
  // null = this runtime cannot parse here: assume an expression.
  if (parses(asExpression) !== false) return asExpression;
  return parses(asStatements) ? asStatements : asExpression;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolSet = Record<string, any>;

/**
 * Add browser_* tools to the agent's tool set. No-op when harness is null.
 *
 * Returned tool names: browser_navigate, browser_screenshot, browser_click,
 * browser_type, browser_get_text, browser_eval, browser_close.
 *
 * The harness is launched lazily on first browser_* tool call and reused
 * across the rest of the build. Within a session Playwright reuses
 * Browser/Context/Page on its own — no pooling layer here.
 */
export function buildBrowserTools(
  harness: BrowserHarness | null,
  hook?: BrowserBillingHook | null,
  options: BrowserToolOptions = {},
): ToolSet {
  if (!harness) return {};
  const h = harness;
  let session: BrowserSession | null = null;
  async function ensureSession(): Promise<BrowserSession> {
    if (session) return session;
    session = await h.launch({ hook });
    return session;
  }
  async function ensurePage(): Promise<BrowserPage> {
    const s = await ensureSession();
    return s.page();
  }

  const tools: ToolSet = {};

  tools.browser_navigate = tool({
    description:
      "Navigate the browser to a URL and wait for the page to load (network idle, " +
      "30s timeout). Returns the final URL after redirects.",
    inputSchema: z.object({
      url: z.string().describe("Absolute URL, e.g. https://example.com/path"),
    }),
    execute: async ({ url }: { url: string }) => {
      try {
        const page = await ensurePage();
        const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT });
        const finalUrl = page.url();
        const status = response?.status?.();
        return `Loaded ${finalUrl} (HTTP ${status ?? "?"})`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Navigate error: ${msg}`;
      }
    },
  });

  tools.browser_screenshot = tool({
    description:
      "Capture a PNG screenshot of the current page (visible viewport). Returns " +
      "the image so you can read text, layout, charts, etc. directly. Use this " +
      "when text extraction (browser_get_text) isn't enough — e.g. images, PDFs " +
      "rendered in browser, charts, complex layout." +
      (options.saveFile
        ? " Pass save_path to also write the image to a file on this machine (e.g. in " +
          "the session outputs directory) so you can attach it to a report. A path " +
          "ending in .jpg or .jpeg saves a smaller, faster JPEG."
        : ""),
    inputSchema: z.object({
      full_page: z.boolean().optional().describe("If true, capture the entire scrollable page (slower)."),
      save_path: z
        .string()
        .optional()
        .describe("Optional file path ending in .png (or .jpg) to also save the screenshot to, e.g. <outputs dir>/checkout.png"),
    }),
    execute: async ({ full_page, save_path }: { full_page?: boolean; save_path?: string }) => {
      try {
        const target = save_path?.trim();
        if (target !== undefined) {
          if (!options.saveFile) {
            return "Screenshot error: save_path is not available in this session (saving needs the write tool, enabled and allowed without approval). Take the screenshot without save_path.";
          }
          if (!target || target.endsWith("/")) return "Screenshot error: save_path must be a file path, e.g. /workspace/shot.png";
        }
        const jpeg = !!target && /\.jpe?g$/i.test(target);
        const page = await ensurePage();
        // One capture serves both the file and the model: the bytes go to
        // the host as captured and are base64-encoded once, while they upload.
        const buf = await page.screenshot({
          fullPage: full_page === true,
          ...(jpeg ? { type: "jpeg" as const, quality: JPEG_QUALITY } : { type: "png" as const }),
        });
        const bytes = toBytes(buf);
        const saving = target ? options.saveFile!(target, bytes) : undefined;
        const data = bytesToBase64(bytes);
        const saved = await saving;
        return {
          type: "image" as const,
          source: { type: "base64" as const, media_type: jpeg ? "image/jpeg" : "image/png", data },
          ...(saved ? { saved_path: saved } : {}),
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Screenshot error: ${msg}`;
      }
    },
    toModelOutput: ({ output }: { output: unknown }) => {
      if (output && typeof output === "object" && "type" in output && (output as { type?: string }).type === "image") {
        const image = output as unknown as { source: { data: string; media_type: string }; saved_path?: string };
        const src = image.source;
        return {
          type: "content" as const,
          value: [
            ...(image.saved_path ? [{ type: "text" as const, text: `Saved screenshot to ${image.saved_path}` }] : []),
            { type: "image-data" as const, data: src.data, mediaType: src.media_type },
          ],
        };
      }
      return { type: "text" as const, value: typeof output === "string" ? output : JSON.stringify(output) };
    },
  });

  tools.browser_click = tool({
    description:
      "Click an element matched by a CSS selector or text. Auto-waits up to 30s. " +
      "Examples: 'button[type=submit]', 'a:has-text(\"Sign in\")', '#submit'.",
    inputSchema: z.object({
      selector: z.string().describe("Playwright selector (CSS, :has-text, etc.)"),
    }),
    execute: async ({ selector }: { selector: string }) => {
      try {
        const page = await ensurePage();
        await page.locator(selector).first().click({ timeout: DEFAULT_TIMEOUT });
        return `Clicked: ${selector}`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Click error: ${msg}`;
      }
    },
  });

  tools.browser_type = tool({
    description:
      "Type text into an input/textarea matched by a selector. Clears existing " +
      "value first. Use submit:true to press Enter after typing.",
    inputSchema: z.object({
      selector: z.string().describe("Playwright selector for the input/textarea"),
      text: z.string().describe("Text to type"),
      submit: z.boolean().optional().describe("Press Enter after typing (default false)"),
    }),
    execute: async ({ selector, text, submit }: { selector: string; text: string; submit?: boolean }) => {
      try {
        const page = await ensurePage();
        const locator = page.locator(selector).first();
        await locator.fill(text, { timeout: DEFAULT_TIMEOUT });
        if (submit) await locator.press("Enter");
        return `Typed ${text.length} chars into: ${selector}${submit ? " (submitted)" : ""}`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Type error: ${msg}`;
      }
    },
  });

  tools.browser_get_text = tool({
    description:
      "Extract visible text from the page. Without selector returns the whole " +
      "<body> innerText (may be long — truncated to 30k chars). With selector " +
      "returns text from matching element.",
    inputSchema: z.object({
      selector: z.string().optional().describe("Optional Playwright selector to scope extraction"),
      max_chars: z.number().optional().describe("Truncation limit (default 30000)"),
    }),
    execute: async ({ selector, max_chars }: { selector?: string; max_chars?: number }) => {
      try {
        const page = await ensurePage();
        const text = selector
          ? await page.locator(selector).first().innerText({ timeout: DEFAULT_TIMEOUT })
          : await page.locator("body").innerText({ timeout: DEFAULT_TIMEOUT });
        const limit = max_chars ?? 30_000;
        if (text.length > limit) {
          return text.slice(0, limit) + `\n\n...[truncated; ${text.length - limit} more chars]`;
        }
        return text || "(empty)";
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Get text error: ${msg}`;
      }
    },
  });

  tools.browser_eval = tool({
    description:
      "Run a JavaScript expression in the page context. Returns the JSON-stringified " +
      "result. Use for fetching computed properties, hidden state, or DOM queries the " +
      "other tools can't reach. Example: 'document.querySelectorAll(\"a\").length'. " +
      "Top-level await works: 'await (await fetch(\"/api/me\")).json()'. For several " +
      "statements, `return` the value you want back.",
    inputSchema: z.object({
      expression: z
        .string()
        .describe("JavaScript expression or statements (top-level await allowed). Result is serialized to JSON."),
    }),
    execute: async ({ expression }: { expression: string }) => {
      try {
        const page = await ensurePage();
        // String overload of Playwright's evaluate isn't in the typed
        // signature — cast to call it directly.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await (page.evaluate as any)(wrapTopLevelAwait(expression));
        return (JSON.stringify(result, null, 2) ?? "undefined").slice(0, 30_000);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Eval error: ${msg}`;
      }
    },
  });

  tools.browser_close = tool({
    description:
      "Close the browser session. Use only when you're truly done — subsequent " +
      "browser_* calls will reconnect. Agent computers preserve their shared tabs and cookies.",
    inputSchema: z.object({}),
    execute: async () => {
      if (!session || !session.isOpen()) return "No browser session to close.";
      await session.close();
      session = null;
      return "Browser session closed.";
    },
  });

  return tools;
}

/** Playwright Page.screenshot returns a Buffer on Node and a Uint8Array on
 *  workerd (a Buffer is a Uint8Array too). */
function toBytes(buf: Uint8Array | { toString(enc: string): string }): Uint8Array {
  if (buf instanceof Uint8Array) return buf;
  return base64ToBytes(buf.toString("base64"));
}

/** Node's Buffer encodes natively; elsewhere btoa over 32 KiB chunks
 *  (a byte-at-a-time string build is slow for a multi-MB PNG). */
function bytesToBase64(bytes: Uint8Array): string {
  const NodeBuffer = (globalThis as { Buffer?: { from(b: ArrayBufferLike, o: number, l: number): { toString(enc: string): string } } }).Buffer;
  if (NodeBuffer) return NodeBuffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export { buildComputerTools, COMPUTER_TOOL_NAMES, type DesktopControl } from "./computer";
