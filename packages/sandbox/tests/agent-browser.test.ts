import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_BROWSER_POLICY,
  agentBrowserLaunchFlags,
  bootstrapAgentComputer,
  buildAgentBrowserPrefsScript,
  buildAgentBrowserStartScript,
  buildAgentComputerPythonScript,
  resolveAgentComputerBrowser,
} from "../src/machines/browser";
import { FakeDaytona, type FakeSandboxInstance } from "./fake-daytona.js";
import type { DaytonaSandboxInstance } from "../src/adapters/daytona-types";
import type { AgentMachineSpec } from "../src/machines/ports";

const spec: AgentMachineSpec = { image: "debian:12", workdir: "/workspace", aptPackages: ["git"], bootstrapTools: true, browser: true, idleStopMinutes: 10, sdkMode: "off" };
function fakeSandbox() {
  const executeCommand = vi.fn(async (command: string) => ({ exitCode: 0, result: command.startsWith("curl ") ? JSON.stringify({ webSocketDebuggerUrl: "ws://localhost:9222/devtools/browser/real-browser-id" }) : "" }));
  const getPreviewLink = vi.fn(async () => ({ url: "https://9223-box.proxy.daytona.work", token: "secret-preview-token" }));
  const uploadFile = vi.fn(async (_file: Buffer, _path: string) => {});
  const sb = { public: false, process: { executeCommand }, fs: { uploadFile }, getPreviewLink } as unknown as DaytonaSandboxInstance;
  return { sb, executeCommand, getPreviewLink, uploadFile };
}

describe("agent computer browser bootstrap", () => {
  it("installs Chromium inside the box and launches it separately from session commands", async () => {
    const f = fakeSandbox();
    await bootstrapAgentComputer(f.sb, spec);
    expect(f.executeCommand.mock.calls[0][0]).toContain("'chromium'");
    expect(f.executeCommand.mock.calls[0][0]).toContain("'git'");
    expect(f.uploadFile).toHaveBeenCalledTimes(3);
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

it('uses the native Daytona desktop and starts headed Chromium on its display', async () => {
  const f = fakeSandbox();
  const start = vi.fn(async () => ({}));
  Object.assign(f.sb, { computerUse: { start } });
  await bootstrapAgentComputer(f.sb, { ...spec, desktop: true, snapshot: 'daytona-medium', bootstrapTools: false });
  expect(start).toHaveBeenCalledOnce();
  // The prepare step itself never installs anything on a snapshot...
  expect(f.executeCommand.mock.calls[0][0]).not.toContain('apt-get');
  // ...but the guarded, best-effort python step runs right after it.
  expect(f.executeCommand.mock.calls[1][0]).toBe(buildAgentComputerPythonScript());
  expect(f.executeCommand.mock.calls[0][0]).toContain('sudo -n');
  expect(f.executeCommand.mock.calls[0][0]).toContain('as_root chown');
  expect(f.executeCommand.mock.calls[0][0]).toContain('/mnt/sessions');
  expect(() => execFileSync('sh', ['-n'], { input: f.executeCommand.mock.calls[0][0] })).not.toThrow();
  const script = f.uploadFile.mock.calls.map(args => args[0].toString()).find(value => value.includes('--start-maximized'))!;
  expect(script).toContain('export DISPLAY');
  expect(script).not.toContain('--headless');
  expect(() => execFileSync('sh', ['-n'], { input: script })).not.toThrow();
});

describe("agent computer python setup", () => {
  const snapshotSpec: AgentMachineSpec = { ...spec, snapshot: "daytona-small", bootstrapTools: false, browser: false };
  async function fakeBox(): Promise<FakeSandboxInstance> {
    return new FakeDaytona().create({ snapshot: "daytona-small" });
  }
  const asDaytona = (sb: FakeSandboxInstance) => sb as unknown as DaytonaSandboxInstance;

  it("is guarded by python3/pip presence, links bare python, and is valid sh", () => {
    const script = buildAgentComputerPythonScript();
    expect(script).toContain("command -v python3");
    expect(script).toContain("python3 -m pip --version");
    expect(script).toContain("install -y -qq --no-install-recommends python3 python3-pip python3-venv");
    // python-is-python3 is missing before bullseye/focal; the symlink covers it.
    expect(script).not.toContain("python-is-python3");
    expect(script).toContain("/usr/local/bin/python");
    // Network waits are capped so the step stays inside the machine lease.
    expect(script).toContain("-o Acquire::Retries=0 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20");
    expect(script).toContain("'/var/lib/oma/python-ready'");
    expect(() => execFileSync("sh", ["-n"], { input: script })).not.toThrow();
  });

  it("installs python on a snapshot that lacks it, then skips on later bootstraps", async () => {
    const sb = await fakeBox();
    sb.missingCommands.add("python3");
    sb.missingCommands.add("python");
    const aptArgs: string[][] = [];
    sb.commandHandlers.set("apt-get", ({ args }) => {
      aptArgs.push(args);
      if (args.includes("install")) sb.missingCommands.delete("python3");
      return { exitCode: 0 };
    });
    await bootstrapAgentComputer(asDaytona(sb), snapshotSpec);
    const netOpts = ["-o", "Acquire::Retries=0", "-o", "Acquire::http::Timeout=20", "-o", "Acquire::https::Timeout=20"];
    expect(aptArgs).toEqual([
      [...netOpts, "update", "-qq"],
      [...netOpts, "install", "-y", "-qq", "--no-install-recommends", "python3", "python3-pip", "python3-venv"],
    ]);
    const runs = sb.execLog.filter((r) => r.command === buildAgentComputerPythonScript());
    expect(runs).toHaveLength(1);
    expect(runs[0].exitCode).toBe(0);
    expect(runs[0].timeout).toBe(90);
    expect(sb.isFile("/usr/local/bin/python")).toBe(true);
    expect(sb.isFile("/var/lib/oma/python-ready")).toBe(true);

    sb.commandHandlers.set("apt-get", () => { throw new Error("apt-get must not run once the marker exists"); });
    await bootstrapAgentComputer(asDaytona(sb), snapshotSpec);
    const reruns = sb.execLog.filter((r) => r.command === buildAgentComputerPythonScript());
    expect(reruns.map((r) => r.exitCode)).toEqual([0, 0]);
    expect(aptArgs).toHaveLength(2);
  });

  it("does not touch apt when python3 and pip already exist", async () => {
    const sb = await fakeBox();
    const apt = vi.fn(() => ({ exitCode: 0 }));
    sb.commandHandlers.set("apt-get", apt);
    await bootstrapAgentComputer(asDaytona(sb), snapshotSpec);
    expect(apt).not.toHaveBeenCalled();
    expect(sb.isFile("/var/lib/oma/python-ready")).toBe(true);
  });

  it("is best-effort: a failed install warns, does not fail the bootstrap, and backs off before retrying", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      let clock = Date.UTC(2026, 10, 10);
      const fake = new FakeDaytona();
      fake.now = () => clock;
      const sb = await fake.create({ snapshot: "daytona-small" });
      sb.missingCommands.add("python3");
      const apt = vi.fn(() => ({ exitCode: 100, stderr: "E: Unable to locate package\n" }));
      sb.commandHandlers.set("apt-get", apt);
      await expect(bootstrapAgentComputer(asDaytona(sb), snapshotSpec)).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("python setup failed"), expect.objectContaining({ exitCode: 1 }));
      expect(sb.isFile("/var/lib/oma/python-ready")).toBe(false);
      expect(sb.readText("/var/lib/oma/python-failed")?.trim()).toBe(String(clock / 1000));
      expect(apt).toHaveBeenCalledTimes(1);

      // A wake within the back-off window skips apt (no mirror wait under the lease)...
      warn.mockClear();
      clock += 60 * 60 * 1000;
      await bootstrapAgentComputer(asDaytona(sb), snapshotSpec);
      expect(apt).toHaveBeenCalledTimes(1);
      expect(warn).not.toHaveBeenCalled();

      // ...and one after it tries again; success clears the failure marker.
      clock += 6 * 60 * 60 * 1000;
      apt.mockImplementation(() => { sb.missingCommands.delete("python3"); return { exitCode: 0, stderr: "" }; });
      await bootstrapAgentComputer(asDaytona(sb), snapshotSpec);
      expect(apt).toHaveBeenCalledTimes(3);
      expect(sb.isFile("/var/lib/oma/python-ready")).toBe(true);
      expect(sb.exists("/var/lib/oma/python-failed")).toBe(false);

      // A thrown provider error is swallowed the same way.
      const f = fakeSandbox();
      f.executeCommand.mockImplementation(async (command: string) => {
        if (command === buildAgentComputerPythonScript()) throw new Error("toolbox timeout");
        return { exitCode: 0, result: "" };
      });
      await expect(bootstrapAgentComputer(f.sb, snapshotSpec)).resolves.toBeUndefined();
      expect(warn).toHaveBeenLastCalledWith(expect.stringContaining("python setup failed"), expect.objectContaining({ error: "Error: toolbox timeout" }));
    } finally {
      warn.mockRestore();
    }
  });
});

describe("camera-clean Chromium", () => {
  it("launches without infobars, first-run, translate, crash-restore or keyring prompts", () => {
    for (const desktop of [false, true]) {
      const flags = agentBrowserLaunchFlags(desktop);
      for (const flag of ["--test-type", "--no-first-run", "--no-default-browser-check", "--password-store=basic", "--hide-crash-restore-bubble"]) {
        expect(flags).toContain(flag);
      }
      expect(flags.find((f) => f.startsWith("--disable-features="))).toMatch(/\bTranslate\b/);
      // Isolation is unchanged: CDP stays on loopback.
      expect(flags).toContain("--remote-debugging-address=127.0.0.1");
      expect(buildAgentBrowserStartScript(desktop)).toContain(flags.join(" "));
    }
    expect(agentBrowserLaunchFlags(true)).toContain("--start-maximized");
    expect(agentBrowserLaunchFlags(false)).toContain("--headless=new");
  });

  it("applies preferences and installs the managed policy before every launch, never after", () => {
    const script = buildAgentBrowserStartScript(true);
    const prefs = script.indexOf("node '/var/lib/oma/browser/prefs.cjs' '/var/lib/oma/browser/profile/Default/Preferences'");
    const policy = script.indexOf("/etc/chromium/policies/managed");
    const launch = script.indexOf('nohup "$browser_bin"');
    expect(prefs).toBeGreaterThan(script.indexOf("if ! curl -fsS --max-time 2 http://127.0.0.1:9222"));
    expect(prefs).toBeLessThan(launch);
    expect(policy).toBeGreaterThan(prefs);
    expect(policy).toBeLessThan(launch);
    expect(script).toContain("/etc/opt/chrome/policies/managed");
    // Cosmetic steps never stop the browser from starting.
    expect(script).toMatch(/prefs\.cjs[^\n]*\|\| echo/);
    expect(() => execFileSync("sh", ["-n"], { input: script })).not.toThrow();
  });

  it("turns off the password manager in the profile and keeps the profile's other settings", () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-prefs-"));
    const script = join(dir, "prefs.cjs");
    writeFileSync(script, buildAgentBrowserPrefsScript());
    const prefsPath = join(dir, "profile", "Default", "Preferences");
    const policyPath = join(dir, "policy.json");
    // First launch: no profile yet.
    execFileSync(process.execPath, [script, prefsPath, policyPath]);
    let prefs = JSON.parse(readFileSync(prefsPath, "utf8"));
    expect(prefs.credentials_enable_service).toBe(false);
    expect(prefs.profile.password_manager_enabled).toBe(false);
    expect(prefs.translate.enabled).toBe(false);
    expect(JSON.parse(readFileSync(policyPath, "utf8"))).toEqual(AGENT_BROWSER_POLICY);
    expect(AGENT_BROWSER_POLICY.PasswordManagerEnabled).toBe(false);
    // An existing profile Chromium left after a hard stop.
    writeFileSync(prefsPath, JSON.stringify({ homepage: "https://example.com", profile: { exit_type: "Crashed", name: "Agent" }, credentials_enable_service: true }));
    execFileSync(process.execPath, [script, prefsPath, policyPath]);
    prefs = JSON.parse(readFileSync(prefsPath, "utf8"));
    expect(prefs).toMatchObject({ homepage: "https://example.com", credentials_enable_service: false, profile: { name: "Agent", exit_type: "Normal", password_manager_enabled: false } });
    // A corrupt file is replaced rather than blocking the launch.
    writeFileSync(prefsPath, "{not json");
    execFileSync(process.execPath, [script, prefsPath, policyPath]);
    expect(JSON.parse(readFileSync(prefsPath, "utf8")).credentials_enable_service).toBe(false);
  });

  it("re-uploads the launch files on every bootstrap so existing computers get them on their next start", async () => {
    const f = fakeSandbox();
    await bootstrapAgentComputer(f.sb, spec);
    await bootstrapAgentComputer(f.sb, spec);
    const uploaded = f.uploadFile.mock.calls.map((args) => args[1]);
    expect(uploaded.filter((p) => p === "/var/lib/oma/browser/prefs.cjs")).toHaveLength(2);
    expect(uploaded.filter((p) => p === "/var/lib/oma/browser/start.sh")).toHaveLength(2);
    const startScript = f.uploadFile.mock.calls.find((args) => args[1] === "/var/lib/oma/browser/start.sh")![0].toString();
    expect(startScript).toContain("--test-type");
  });
});
