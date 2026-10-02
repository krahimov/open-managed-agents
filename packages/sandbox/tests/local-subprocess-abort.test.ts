// Cancellation for LocalSubprocessSandbox (PR #30 QA F6): a turn
// interrupt must kill the running command's whole process tree, so a
// command like `sleep 30; touch marker` (or a backgrounded child of it)
// never produces its side effect after Stop.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalSubprocessSandbox } from "../src/adapters/local-subprocess";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("LocalSubprocessSandbox cancellation", () => {
  let dir: string;
  let sandbox: LocalSubprocessSandbox;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oma-abort-"));
    sandbox = new LocalSubprocessSandbox({ workdir: dir, logger: { warn: () => {}, log: () => {} } });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("exec: aborting the signal kills the process group promptly", async () => {
    const ctrl = new AbortController();
    const t0 = Date.now();
    const out = sandbox.exec(
      `(sleep 1; touch ${dir}/child-marker) & sleep 30; touch ${dir}/marker`,
      60_000,
      { signal: ctrl.signal },
    );
    await sleep(200);
    ctrl.abort();
    const result = await out;
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(result).toContain("[aborted]");
    await sleep(1_500); // past the backgrounded child's sleep
    expect(existsSync(join(dir, "marker"))).toBe(false);
    expect(existsSync(join(dir, "child-marker"))).toBe(false);
  });

  it("exec: an already-aborted signal doesn't start the command", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await sandbox.exec(`touch ${dir}/marker`, 5_000, { signal: ctrl.signal });
    expect(existsSync(join(dir, "marker"))).toBe(false);
  });

  it("startProcess: kill() signals the whole tree, not just the shell", async () => {
    const proc = await sandbox.startProcess(`(sleep 1; touch ${dir}/child-marker) & sleep 30; touch ${dir}/marker`);
    expect(proc).not.toBeNull();
    await sleep(200);
    await proc!.kill("SIGTERM");
    for (let i = 0; i < 50 && (await proc!.getStatus()) === "running"; i++) await sleep(20);
    expect(await proc!.getStatus()).toBe("killed");
    await sleep(1_500);
    expect(existsSync(join(dir, "marker"))).toBe(false);
    expect(existsSync(join(dir, "child-marker"))).toBe(false);
  });

  it("exec without a signal still completes normally", async () => {
    expect(await sandbox.exec("echo hi")).toBe("hi");
  });
});
