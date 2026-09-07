import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { bootstrapAgentComputer, buildAgentBrowserStartScript, resolveAgentComputerBrowser } from "../src/machines/browser";
import type { DaytonaSandboxInstance } from "../src/adapters/daytona-types";
import type { AgentMachineSpec } from "../src/machines/ports";

const spec: AgentMachineSpec = { image: "debian:12", workdir: "/workspace", aptPackages: ["git"], bootstrapTools: true, browser: true, idleStopMinutes: 10, sdkMode: "off" };
function fakeSandbox() {
  const executeCommand = vi.fn(async (command: string) => ({ exitCode: 0, result: command.startsWith("curl ") ? JSON.stringify({ webSocketDebuggerUrl: "ws://localhost:9222/devtools/browser/real-browser-id" }) : "" }));
  const getPreviewLink = vi.fn(async () => ({ url: "https://9223-box.proxy.daytona.work", token: "secret-preview-token" }));
  const uploadFile = vi.fn(async () => {});
  const sb = { public: false, process: { executeCommand }, fs: { uploadFile }, getPreviewLink } as unknown as DaytonaSandboxInstance;
  return { sb, executeCommand, getPreviewLink, uploadFile };
}

describe("agent computer browser bootstrap", () => {
  it("installs Chromium inside the box and launches it separately from session commands", async () => {
    const f = fakeSandbox();
    await bootstrapAgentComputer(f.sb, spec);
    expect(f.executeCommand.mock.calls[0][0]).toContain("'chromium'");
    expect(f.executeCommand.mock.calls[0][0]).toContain("'git'");
    expect(f.uploadFile).toHaveBeenCalledTimes(2);
    expect(f.executeCommand.mock.calls.at(-1)?.[0]).toBe("sh '/var/lib/oma/browser/start.sh'");
    const script = buildAgentBrowserStartScript();
    expect(script).toContain("--remote-debugging-address=127.0.0.1");
    expect(script).toContain("--user-data-dir='/var/lib/oma/browser/profile'");
    expect(script).toContain("nohup");
    expect(() => execFileSync("sh", ["-n"], { input: script })).not.toThrow();
  });

  it("does not install or expose a browser when disabled", async () => {
    const f = fakeSandbox();
    await bootstrapAgentComputer(f.sb, { ...spec, browser: false });
    expect(f.uploadFile).not.toHaveBeenCalled();
    expect(f.executeCommand.mock.calls[0][0]).not.toContain("chromium");
    expect(f.getPreviewLink).not.toHaveBeenCalled();
  });

  it("returns a WSS preview endpoint with separate credentials and current generation", async () => {
    const f = fakeSandbox();
    const endpoint = await resolveAgentComputerBrowser(f.sb, 4);
    expect(f.getPreviewLink).toHaveBeenCalledWith(9223);
    expect(endpoint).toEqual({
      httpUrl: "https://9223-box.proxy.daytona.work",
      wsUrl: "wss://9223-box.proxy.daytona.work/devtools/browser/real-browser-id",
      headers: { "x-daytona-preview-token": "secret-preview-token", "X-Daytona-Skip-Preview-Warning": "true" }, generation: 4,
      downloadsPath: "/workspace/downloads",
    });
    expect(endpoint.wsUrl).not.toContain("secret-preview-token");
    expect(f.executeCommand.mock.calls[0][0]).toBe("sh '/var/lib/oma/browser/start.sh'");
  });

  it("refuses public previews and missing authentication", async () => {
    const f = fakeSandbox();
    Object.assign(f.sb, { public: true });
    await expect(bootstrapAgentComputer(f.sb, spec)).rejects.toThrow("private Daytona");
    await expect(resolveAgentComputerBrowser(f.sb, 1)).rejects.toThrow("private Daytona");
    expect(f.executeCommand).not.toHaveBeenCalled();
    Object.assign(f.sb, { public: false });
    f.getPreviewLink.mockResolvedValue({ url: "https://private.example", token: "" });
    await expect(resolveAgentComputerBrowser(f.sb, 1)).rejects.toThrow("authentication token");
  });

  it("fails bootstrap on install errors instead of marking the machine ready", async () => {
    const f = fakeSandbox();
    f.executeCommand.mockResolvedValue({ exitCode: 100, result: "package install failed" });
    await expect(bootstrapAgentComputer(f.sb, spec)).rejects.toThrow("package install failed");
    expect(f.uploadFile).not.toHaveBeenCalled();
  });
});
