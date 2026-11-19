import { describe, it, expect } from "vitest";
import {
  BROWSER_TOOL_NAMES,
  COMPUTER_TOOL_NAMES,
  buildBrowserTools,
  buildComputerTools,
  wrapTopLevelAwait,
  type BrowserHarness,
  type BrowserPage,
} from "../src/index";

const OPTS = { toolCallId: "tc_test", messages: [], abortSignal: undefined as unknown as AbortSignal };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function harnessWith(page: Partial<BrowserPage>): BrowserHarness {
  const full = {
    goto: async () => ({ status: () => 200 }),
    url: () => "about:blank",
    screenshot: async () => PNG,
    locator: () => ({}),
    evaluate: async () => undefined,
    content: async () => "",
    ...page,
  } as BrowserPage;
  return { launch: async () => ({ page: async () => full, close: async () => {}, isOpen: () => true }) };
}

describe("tool name lists", () => {
  it("match the tools each builder registers, so hosts can classify them as built-in", () => {
    expect(Object.keys(buildBrowserTools(harnessWith({}))).sort()).toEqual([...BROWSER_TOOL_NAMES].sort());
    const desktop = { screenshot: async () => "", click: async () => {}, type: async () => {}, press: async () => {}, scroll: async () => {} };
    expect(Object.keys(buildComputerTools(desktop)).sort()).toEqual([...COMPUTER_TOOL_NAMES].sort());
  });
});

describe("browser_screenshot save_path", () => {
  it("writes the PNG bytes through the host and says where", async () => {
    const writes: Array<{ path: string; bytes: Uint8Array }> = [];
    const tools = buildBrowserTools(harnessWith({}), null, {
      saveFile: async (path, bytes) => {
        writes.push({ path, bytes });
        return path;
      },
    });
    const out = await tools.browser_screenshot.execute({ save_path: "/mnt/sessions/s1/outputs/shot.png" }, OPTS);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.path).toBe("/mnt/sessions/s1/outputs/shot.png");
    expect([...writes[0]!.bytes]).toEqual([...PNG]);
    expect(out).toMatchObject({ type: "image", saved_path: "/mnt/sessions/s1/outputs/shot.png" });
    const model = tools.browser_screenshot.toModelOutput({ output: out });
    expect(model.value[0]).toEqual({ type: "text", text: "Saved screenshot to /mnt/sessions/s1/outputs/shot.png" });
    expect(model.value[1]).toMatchObject({ type: "image-data", mediaType: "image/png" });
  });

  it("returns only the image when no path is given", async () => {
    let wrote = false;
    const tools = buildBrowserTools(harnessWith({}), null, { saveFile: async (p) => { wrote = true; return p; } });
    const out = await tools.browser_screenshot.execute({}, OPTS);
    expect(wrote).toBe(false);
    expect(out).not.toHaveProperty("saved_path");
  });

  it("refuses save_path where the host cannot write files, or for a directory", async () => {
    const plain = buildBrowserTools(harnessWith({}));
    expect(await plain.browser_screenshot.execute({ save_path: "/tmp/a.png" }, OPTS)).toMatch(/save_path is not supported/);
    const withFs = buildBrowserTools(harnessWith({}), null, { saveFile: async (p) => p });
    expect(await withFs.browser_screenshot.execute({ save_path: "/workspace/" }, OPTS)).toMatch(/must be a file path/);
  });

  it("describes save_path only when it works", () => {
    expect(buildBrowserTools(harnessWith({})).browser_screenshot.description).not.toMatch(/save_path/);
    expect(buildBrowserTools(harnessWith({}), null, { saveFile: async (p) => p }).browser_screenshot.description).toMatch(/save_path/);
  });
});

// workerd (the root test run) refuses `eval` while handling a request,
// which is where tests run: the wrapped code is then only checked, not run.
const canEval = () => { try { return (0, eval)("1") === 1; } catch { return false; } };
const canParse = () => { try { new Function("return 1"); return true; } catch { return false; } };

describe("browser_eval top-level await", () => {
  it("leaves code without await untouched", () => {
    expect(wrapTopLevelAwait("document.title")).toBe("document.title");
  });

  it("wraps an awaited expression in an async IIFE that returns its value", async () => {
    const wrapped = wrapTopLevelAwait("await Promise.resolve(41) + 1");
    expect(wrapped).toBe("(async () => (await Promise.resolve(41) + 1\n))()");
    if (canEval()) expect(await (0, eval)(wrapped)).toBe(42);
  });

  it("assumes an expression where the runtime cannot parse code", (ctx) => {
    if (canParse()) return ctx.skip();
    expect(wrapTopLevelAwait("const a = await b; return a;")).toMatch(/^\(async \(\) => \(/);
  });

  it("wraps statements as an async function body", async (ctx) => {
    if (!canParse()) return ctx.skip();
    const wrapped = wrapTopLevelAwait("const a = await Promise.resolve(2);\nreturn a * 3;");
    expect(wrapped).toMatch(/^\(async \(\) => \{\n/);
    if (canEval()) expect(await (0, eval)(wrapped)).toBe(6);
  });

  it("keeps code that is already an async function", () => {
    const src = "(async () => { return await 1; })()";
    expect(wrapTopLevelAwait(src)).toBe(src);
  });

  it("sends the wrapped code to the page and serializes the result", async (ctx) => {
    if (!canEval()) return ctx.skip();
    const seen: string[] = [];
    const tools = buildBrowserTools(harnessWith({
      evaluate: async (expr: unknown) => {
        seen.push(String(expr));
        return (0, eval)(String(expr));
      },
    }));
    const out = await tools.browser_eval.execute({ expression: "await Promise.resolve({ ok: true })" }, OPTS);
    expect(seen[0]).toMatch(/^\(async \(\) => \(/);
    expect(JSON.parse(out as string)).toEqual({ ok: true });
    expect(await tools.browser_eval.execute({ expression: "const x = await Promise.resolve(1);" }, OPTS)).toBe("undefined");
  });
});
