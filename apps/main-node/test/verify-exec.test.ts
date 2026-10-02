// PR #30 QA round 3 (R3): outcome verify scripts must report their real
// exit status on every sandbox adapter — LocalSubprocess's plain output on
// success used to be read as exit -1.
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalSubprocessSandbox } from "@open-managed-agents/sandbox/adapters/local-subprocess";
import { parseVerifyExec, wrapVerifyCommand } from "../src/lib/verify-exec";

describe("verify script exit status", () => {
  const withSandbox = async (fn: (s: LocalSubprocessSandbox) => Promise<void>) => {
    const dir = mkdtempSync(join(tmpdir(), "oma-verify-"));
    try { await fn(new LocalSubprocessSandbox({ workdir: dir })); } finally { rmSync(dir, { recursive: true, force: true }); }
  };

  it("reads success, failure and an explicit `exit` through LocalSubprocess", async () => {
    await withSandbox(async (sb) => {
      const run = async (cmd: string) => parseVerifyExec(await sb.exec(wrapVerifyCommand(cmd), 10_000));
      expect(await run("echo evaluated; exit 0")).toEqual({ exit_code: 0, output: "evaluated" });
      expect(await run("echo nope >&2; exit 3")).toMatchObject({ exit_code: 3 });
      expect(await run("true")).toMatchObject({ exit_code: 0 });
      expect(await run("false")).toMatchObject({ exit_code: 1 });
    });
  });

  it("handles a prefix-style adapter output and a missing marker", () => {
    expect(parseVerifyExec("exit=0\nhello\n__OMA_VERIFY_EXIT__=0\n")).toEqual({ exit_code: 0, output: "exit=0\nhello" });
    expect(parseVerifyExec("killed mid-run")).toEqual({ exit_code: -1, output: "killed mid-run" });
  });
});
