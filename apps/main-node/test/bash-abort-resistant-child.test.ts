// PR #30 QA round 2 (N3): aborting a bash call must also kill background
// children that ignore SIGTERM. The process handle tracks the shell, which
// can exit long before its group does, so the group SIGKILL has to fire
// unconditionally after the grace.
import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalSubprocessSandbox } from "@open-managed-agents/sandbox/adapters/local-subprocess";
import { buildTools } from "@open-managed-agents/agent/harness/tools";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("bash abort kills TERM-resistant background children", () => {
  it("a child that traps TERM and redirects output never runs its side effect", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-abort-resistant-"));
    try {
      const sandbox = new LocalSubprocessSandbox({ workdir: dir });
      const agent = {
        id: "a", name: "a", model: "mock", system: "",
        tools: [{ type: "agent_toolset_20260401", default_config: { enabled: false }, configs: [{ name: "bash", enabled: true }] }],
      };
      const tools = (await buildTools(agent as never, sandbox as never)) as Record<string, { execute: (...a: unknown[]) => Promise<unknown> }>;
      const marker = join(dir, "resistant-marker");
      const ctrl = new AbortController();
      const run = tools.bash.execute(
        { command: `(trap '' TERM; sleep 2; touch ${marker}) >/dev/null 2>&1 & sleep 30`, timeout: 60_000 },
        { toolCallId: "resistant", messages: [], abortSignal: ctrl.signal },
      );
      await sleep(300);
      const t0 = Date.now();
      ctrl.abort();
      await expect(run).rejects.toThrow(/interrupted/i);
      expect(Date.now() - t0).toBeLessThan(2_000);
      await sleep(3_000);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
