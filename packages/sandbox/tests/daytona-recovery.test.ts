// Sandbox-gone self-heal (withSandboxRecovery) — the adapter must survive
// Daytona deleting an idle box server-side while the Node registry still
// holds the adapter instance. Live failure this guards against (prod
// 2026-07-25): every exec on a 7h-idle session returned
//   not found: sandbox 69917c98-7870-4fed-a3f5-a5dbed85befa not found (it has been deleted)
// forever, bricking the session until a process restart.
//
// The adapter dynamic-imports @daytonaio/sdk inside ensureSandbox, so these
// tests stub the private surface (`ensureSandbox`, mount replay collaborators)
// through an `any` cast rather than spinning up the real SDK.

import { describe, it, expect, vi } from "vitest";
import { DaytonaSandbox } from "../src/adapters/daytona.js";

const GONE_MSG =
  "not found: sandbox 69917c98-7870-4fed-a3f5-a5dbed85befa not found (it has been deleted)";

function makeAdapter() {
  return new DaytonaSandbox({
    sessionId: "sess-test",
    logger: { log: () => {}, warn: () => {} },
  } as never) as unknown as {
    ensureSandbox: () => Promise<unknown>;
    replayMounts: (sb: unknown) => Promise<void>;
    withSandboxRecovery: <T>(op: string, fn: (sb: unknown) => Promise<T>) => Promise<T>;
    isSandboxGone: (err: unknown) => boolean;
    sandboxPromise: Promise<unknown> | null;
  };
}

describe("DaytonaSandbox.isSandboxGone", () => {
  const a = makeAdapter();

  it("matches the live prod deleted-sandbox message", () => {
    expect(a.isSandboxGone(new Error(GONE_MSG))).toBe(true);
  });

  it("matches archived variant", () => {
    expect(a.isSandboxGone(new Error("sandbox has been archived"))).toBe(true);
  });

  it("does NOT match a missing-file error", () => {
    expect(a.isSandboxGone(new Error("file not found: /workspace/notes.md"))).toBe(false);
  });

  it("does NOT match a file path that merely contains 'sandbox'", () => {
    expect(
      a.isSandboxGone(new Error("not found: /workspace/sandbox/config.json")),
    ).toBe(false);
  });
});

describe("DaytonaSandbox.withSandboxRecovery", () => {
  it("re-provisions once and retries after a gone error", async () => {
    const a = makeAdapter();
    const boxes: unknown[] = [{ id: "old" }, { id: "fresh" }];
    let created = 0;
    a.ensureSandbox = vi.fn(async () => {
      // Mirror the real contract: cached promise until reset.
      if (!a.sandboxPromise) a.sandboxPromise = Promise.resolve(boxes[created++]);
      return a.sandboxPromise;
    });
    a.replayMounts = vi.fn(async () => {});

    const fn = vi
      .fn<(sb: unknown) => Promise<string>>()
      .mockRejectedValueOnce(new Error(GONE_MSG))
      .mockResolvedValueOnce("ok");

    const result = await a.withSandboxRecovery("exec", fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn.mock.calls[0][0]).toEqual({ id: "old" });
    expect(fn.mock.calls[1][0]).toEqual({ id: "fresh" });
    expect(a.replayMounts).toHaveBeenCalledTimes(1);
  });

  it("propagates non-gone errors without re-provisioning", async () => {
    const a = makeAdapter();
    a.sandboxPromise = Promise.resolve({ id: "old" });
    a.ensureSandbox = vi.fn(async () => a.sandboxPromise);
    a.replayMounts = vi.fn(async () => {});

    await expect(
      a.withSandboxRecovery("exec", async () => {
        throw new Error("command exited 127");
      }),
    ).rejects.toThrow("command exited 127");
    expect(a.replayMounts).not.toHaveBeenCalled();
  });

  it("throws (no infinite loop) when the replacement also reports gone", async () => {
    const a = makeAdapter();
    a.ensureSandbox = vi.fn(async () => ({ id: "always-dead" }));
    a.replayMounts = vi.fn(async () => {});

    await expect(
      a.withSandboxRecovery("exec", async () => {
        throw new Error(GONE_MSG);
      }),
    ).rejects.toThrow(/has been deleted/);
  });
});
