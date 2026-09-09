import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { createSandboxBrowserHarness } from "../src/sandbox";
import { AGENT_BROWSER_PROXY_SCRIPT } from "../../sandbox/src/machines/browser";

const executable = process.env.BROWSER_EXECUTABLE_PATH;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function terminate(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  await Promise.race([exited, delay(3000)]);
  if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
}

// Opt in with BROWSER_EXECUTABLE_PATH. Uses a disposable profile and the
// exact proxy shipped to the Linux machine, never the user's browser.
describe.skipIf(!executable)("real Chromium over the agent computer proxy", () => {
  it("navigates, screenshots, reads the shared filesystem and preserves a tab after disconnect", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oma-browser-test-"));
    const server = createServer((req, res) => {
      if (req.url === "/download") {
        res.setHeader("content-disposition", 'attachment; filename="from-browser.txt"');
        res.end("download saved in shared workspace");
        return;
      }
      res.setHeader("content-type", "text/html");
      res.end('<!doctype html><title>Cloud computer</title><h1 id="status">Cloud computer works</h1>');
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const webPort = (server.address() as { port: number }).port;
    const portServer = createServer();
    await new Promise<void>((resolve, reject) => { portServer.once("error", reject); portServer.listen(0, "127.0.0.1", resolve); });
    const proxyPort = (portServer.address() as { port: number }).port;
    await new Promise<void>((resolve) => portServer.close(() => resolve()));
    let chrome: ChildProcess | undefined;
    let proxy: ChildProcess | undefined;
    const sessions: Awaited<ReturnType<ReturnType<typeof createSandboxBrowserHarness>["launch"]>>[] = [];
    try {
      let chromeOutput = "";
      chrome = spawn(executable!, ["--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${join(dir, "profile")}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
      chrome.stderr?.on("data", (data) => { chromeOutput += String(data); });
      let activePort: string[] | undefined;
      for (let i = 0; i < 100; i++) {
        if (chrome.exitCode !== null || chrome.signalCode !== null) throw new Error(`Chrome exited (${chrome.exitCode ?? chrome.signalCode}): ${chromeOutput}`);
        try { activePort = (await readFile(join(dir, "profile", "DevToolsActivePort"), "utf8")).trim().split("\n"); break; }
        catch { await delay(100); }
      }
      if (!activePort) throw new Error(`Chrome did not start (exit ${chrome.exitCode})`);
      await writeFile(join(dir, "proxy.cjs"), AGENT_BROWSER_PROXY_SCRIPT);
      proxy = spawn(process.execPath, [join(dir, "proxy.cjs")], {
        stdio: "ignore", env: { ...process.env, OMA_CDP_PORT: activePort[0], OMA_CDP_PROXY_PORT: String(proxyPort) },
      });
      const preview = `http://127.0.0.1:${proxyPort}`;
      let response: Response | undefined;
      for (let i = 0; i < 50; i++) {
        try { response = await fetch(`${preview}/json/version`, { headers: { host: "cloud-preview.example" } }); if (response.ok) break; }
        catch { /* startup */ }
        await delay(100);
      }
      expect(response?.ok).toBe(true);
      const downloadsPath = join(dir, "downloads");
      await mkdir(downloadsPath);
      const endpoint = { wsUrl: `ws://127.0.0.1:${proxyPort}${activePort[1]}`, headers: { "x-daytona-preview-token": "fake-edge-token" }, generation: 1, downloadsPath };
      const harness = createSandboxBrowserHarness({ getBrowserEndpoint: async () => endpoint });
      const first = await harness.launch(); sessions.push(first);
      const page = await first.page();
      await page.goto(`http://127.0.0.1:${webPort}`);
      expect(await page.evaluate("document.title")).toBe("Cloud computer");
      const png = await page.screenshot();
      expect((png as Uint8Array).byteLength).toBeGreaterThan(100);
      await page.evaluate("{ const a = document.createElement('a'); a.href = '/download'; a.textContent = 'Download'; document.body.appendChild(a); }");
      await page.locator("a").click();
      let download: string | undefined;
      for (let i = 0; i < 50; i++) {
        try { download = await readFile(join(downloadsPath, "from-browser.txt"), "utf8"); break; }
        catch { await delay(100); }
      }
      expect(download).toBe("download saved in shared workspace");
      await page.evaluate("localStorage.setItem('resume', 'still here')");
      const second = await harness.launch(); sessions.push(second);
      expect((await second.page()).url()).toBe(page.url());
      await first.close();
      expect(chrome.exitCode).toBeNull();
      expect(await (await second.page()).evaluate("localStorage.getItem('resume')")).toBe("still here");
      await rm(join(downloadsPath, "from-browser.txt"));
      await (await second.page()).locator("a").click();
      download = undefined;
      for (let i = 0; i < 50; i++) {
        try { download = await readFile(join(downloadsPath, "from-browser.txt"), "utf8"); break; }
        catch { await delay(100); }
      }
      expect(download).toBe("download saved in shared workspace");
      await second.close();
      const third = await harness.launch(); sessions.push(third);
      expect(await (await third.page()).evaluate("document.title")).toBe("Cloud computer");
      const html = join(dir, "workspace.html");
      await writeFile(html, "<title>Shared workspace</title><p>File written by shell tools</p>");
      await (await third.page()).goto(pathToFileURL(html).href);
      expect(await (await third.page()).evaluate("document.title")).toBe("Shared workspace");
      await harness.dispose();
      expect(third.isOpen()).toBe(false);
      expect(chrome.exitCode).toBeNull();
      expect(await readFile(join(downloadsPath, "from-browser.txt"), "utf8")).toBe("download saved in shared workspace");
      expect((await fetch(`${preview}/json/list`).then((r) => r.json()) as Array<{ url: string }>).some((p) => p.url === pathToFileURL(html).href)).toBe(true);
    } finally {
      for (const session of sessions) await session.close().catch(() => {});
      await terminate(proxy);
      await terminate(chrome);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { force: true, recursive: true });
    }
  }, 30_000);
});
