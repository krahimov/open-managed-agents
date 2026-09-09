// Session-scoped DaytonaSandbox driven end-to-end through the in-memory fake
// (tests/fake-daytona.ts) via the `daytonaModule` seam: one box per adapter,
// created lazily with today's params, bootstrapped once, deleted on destroy,
// re-provisioned through SessionBoxProvider.acquire({ reason: "recover" })
// when Daytona deletes it upstream.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DaytonaNotFoundError,
  FakeDaytona,
  type FakeSandboxInstance,
  fakeDaytonaModule,
  sandboxGoneMessage,
} from "./fake-daytona.js";
import {
  DaytonaSandbox,
  type DaytonaSandboxOptions,
  buildDaytonaBootstrapScript,
  buildDaytonaCreateParams,
  sandboxFactory,
} from "../src/adapters/daytona.js";
import { SessionBoxProvider } from "../src/adapters/daytona-box-provider.js";
import { isDaytonaNotFound } from "../src/adapters/daytona-types.js";

const silent = { log() {}, warn() {} };
const bucket = { endpoint: "https://s3.test", accessKey: "ak", secretKey: "sk", bucketName: "bkt" };

function makeSandbox(fake: FakeDaytona, extra: Partial<DaytonaSandboxOptions> = {}) {
  return new DaytonaSandbox({
    sessionId: "sess-1",
    apiKey: "test-key",
    apiUrl: "https://daytona.test",
    daytonaModule: fakeDaytonaModule(fake),
    logger: silent,
    ...extra,
  });
}

/** In-memory stand-in for the lazily imported @aws-sdk/client-s3 runtime. */
function fakeS3(adapter: DaytonaSandbox) {
  const sends: Array<{ type: string; input: Record<string, unknown> }> = [];
  class Cmd {
    constructor(public type: string, public input: Record<string, unknown>) {}
  }
  const runtime = {
    client: {
      async send(c: Cmd) {
        sends.push({ type: c.type, input: c.input });
        if (c.type === "ListObjectsV2") return { Contents: [] };
        if (c.type === "GetObject") return { Body: Buffer.alloc(0) };
        return {};
      },
    },
    ListObjectsV2Command: class extends Cmd { constructor(input: Record<string, unknown>) { super("ListObjectsV2", input); } },
    GetObjectCommand: class extends Cmd { constructor(input: Record<string, unknown>) { super("GetObject", input); } },
    PutObjectCommand: class extends Cmd { constructor(input: Record<string, unknown>) { super("PutObject", input); } },
  };
  (adapter as unknown as { s3RuntimePromise: Promise<unknown> | null }).s3RuntimePromise = Promise.resolve(runtime);
  return sends;
}

function onlyBox(fake: FakeDaytona): FakeSandboxInstance {
  const boxes = [...fake.sandboxes.values()];
  expect(boxes).toHaveLength(1);
  return boxes[0];
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DaytonaSandbox (session scope) — box lifecycle", () => {
  it("creates one box lazily with the unchanged session params and bootstraps it once", async () => {
    const fake = new FakeDaytona();
    const a = makeSandbox(fake);
    expect(fake.createCalls).toHaveLength(0); // constructor never touches Daytona

    expect(await a.exec("echo hi")).toBe("hi");
    expect(await a.exec("pwd")).toBe("/workspace");
    expect(await a.writeFile("notes.txt", "n")).toBe("/workspace/notes.txt");
    expect(await a.readFile("/workspace/notes.txt")).toBe("n");

    expect(fake.clientConfigs).toEqual([{ apiKey: "test-key", apiUrl: "https://daytona.test" }]);
    expect(fake.createCalls).toEqual([buildDaytonaCreateParams({ sessionId: "sess-1" })]);
    expect(fake.createCalls[0]).toEqual({
      image: "node:22-bookworm",
      labels: { "oma-session-id": "sess-1" },
      ephemeral: true,
    });

    const sb = onlyBox(fake);
    expect(sb.isFile("/tmp/.oma-daytona-tools-ready")).toBe(true);
    const bootstrapRuns = sb.execLog.filter((r) => r.command.includes("/tmp/.oma-daytona-tools-ready"));
    expect(bootstrapRuns).toHaveLength(1);
    expect(bootstrapRuns[0].timeout).toBe(300);
    expect(sb.unhandledCommands.map((c) => c.name)).toEqual(["apt-get", "apt-get"]);
    expect(sb.unhandledCommands[1].args).toContain("ripgrep");
  });

  it("honours image / ephemeral=false / apiKey from env", async () => {
    const fake = new FakeDaytona();
    const prev = process.env.DAYTONA_API_KEY;
    process.env.DAYTONA_API_KEY = "env-key";
    try {
      const a = makeSandbox(fake, { apiKey: undefined, image: "debian:12", ephemeral: false, bootstrapTools: false });
      await a.exec("true");
      expect(fake.clientConfigs[0]).toMatchObject({ apiKey: "env-key" });
      expect(fake.createCalls[0]).toEqual({
        image: "debian:12",
        labels: { "oma-session-id": "sess-1" },
        autoDeleteInterval: -1,
      });
      expect(onlyBox(fake).unhandledCommands).toEqual([]); // bootstrapTools=false → no apt
    } finally {
      if (prev === undefined) delete process.env.DAYTONA_API_KEY;
      else process.env.DAYTONA_API_KEY = prev;
    }
  });

  it("fails clearly without an API key and does not cache the failure", async () => {
    const fake = new FakeDaytona();
    const prev = process.env.DAYTONA_API_KEY;
    delete process.env.DAYTONA_API_KEY;
    try {
      const a = makeSandbox(fake, { apiKey: undefined });
      expect(await a.exec("true")).toBe(
        "[error: DaytonaSandbox: apiKey not provided and DAYTONA_API_KEY env var not set]",
      );
      expect(fake.createCalls).toHaveLength(0);
      process.env.DAYTONA_API_KEY = "late-key";
      expect(await a.exec("echo recovered")).toBe("recovered");
      expect(fake.createCalls).toHaveLength(1);
    } finally {
      if (prev === undefined) delete process.env.DAYTONA_API_KEY;
      else process.env.DAYTONA_API_KEY = prev;
    }
  });

  it("deletes a box whose bootstrap failed and creates a fresh one on the next call", async () => {
    const fake = new FakeDaytona();
    let first = true;
    fake.onCreate = (sb) => {
      if (first) sb.missingCommands.add("apt-get");
      first = false;
    };
    const a = makeSandbox(fake);
    const out = await a.exec("echo hi");
    expect(out).toMatch(/^\[error: Daytona sandbox bootstrap failed \(exit=127\)/);
    expect(fake.createCalls).toHaveLength(1);
    expect(fake.deleteCalls).toHaveLength(1);

    expect(await a.exec("echo hi")).toBe("hi");
    expect(fake.createCalls).toHaveLength(2);
    expect([...fake.sandboxes.values()].filter((sb) => sb.state === "started")).toHaveLength(1);
  });

  it("mounts session outputs at /mnt/session/outputs (legacy single-session layout)", async () => {
    const fake = new FakeDaytona();
    const a = makeSandbox(fake, { memoryBucket: bucket });
    const sends = fakeS3(a);
    await a.mountSessionOutputs({ tenantId: "t1", sessionId: "sess-1" });
    const sb = onlyBox(fake);
    expect(sb.isDir("/mnt/session/outputs")).toBe(true);

    // The mount is write-back synced after exec and after file-tool writes.
    expect(await a.exec("echo report > /mnt/session/outputs/report.txt")).toBe("");
    expect(sends.filter((s) => s.type === "PutObject").map((s) => s.input.Key)).toEqual([
      "session-outputs/t1/sess-1/report.txt",
    ]);
    await a.writeFile("/mnt/session/outputs/second.txt", "2");
    expect(sends.filter((s) => s.type === "PutObject").map((s) => s.input.Key)).toEqual([
      "session-outputs/t1/sess-1/report.txt",
      "session-outputs/t1/sess-1/report.txt",
      "session-outputs/t1/sess-1/second.txt",
    ]);
  });

  it("destroy() deletes the box via daytona.delete and is a no-op before any box exists", async () => {
    const fake = new FakeDaytona();
    const idle = makeSandbox(fake);
    await idle.destroy();
    expect(fake.createCalls).toHaveLength(0);
    expect(fake.deleteCalls).toEqual([]);

    const a = makeSandbox(fake, { memoryBucket: bucket });
    const sends = fakeS3(a);
    await a.mountSessionOutputs({ tenantId: "t1", sessionId: "sess-1" });
    const sb = onlyBox(fake);
    sb.writeText("/mnt/session/outputs/final.txt", "bye");
    await a.destroy();
    expect(fake.deleteCalls).toEqual([sb.id]);
    expect(sb.state).toBe("destroyed");
    // outputs flushed to S3 before the box went away
    expect(sends.filter((s) => s.type === "PutObject").map((s) => s.input.Key)).toEqual([
      "session-outputs/t1/sess-1/final.txt",
    ]);
    // a later exec re-provisions instead of failing forever
    expect(await a.exec("echo again")).toBe("again");
    expect(fake.createCalls).toHaveLength(2);
  });

  it("renewActivityTimeout refreshes Daytona activity but never creates a box by itself", async () => {
    const fake = new FakeDaytona();
    const a = makeSandbox(fake);
    await a.renewActivityTimeout();
    expect(fake.createCalls).toHaveLength(0);

    await a.exec("true");
    const sb = onlyBox(fake);
    expect(sb.activityRefreshes).toBe(0);
    await a.renewActivityTimeout();
    await a.renewActivityTimeout();
    expect(sb.activityRefreshes).toBe(2);
  });
});

describe("DaytonaSandbox (session scope) — self-heal through the box provider", () => {
  it("re-acquires with reason:'recover', creates a second box and replays mounts once", async () => {
    const fake = new FakeDaytona();
    const provider = new SessionBoxProvider({
      sessionId: "sess-1",
      apiKey: "test-key",
      daytonaModule: fakeDaytonaModule(fake),
      bootstrap: async (sb) => {
        await sb.process.executeCommand("touch /tmp/bootstrapped");
      },
      logger: silent,
    });
    const acquire = vi.spyOn(provider, "acquire");
    const a = makeSandbox(fake, { box: provider, memoryBucket: bucket });
    fakeS3(a);
    const replay = vi.spyOn(a as unknown as { replayMounts: (sb: unknown) => Promise<void> }, "replayMounts");

    await a.mountMemoryStore({ storeName: "notes", storeId: "store-1", readOnly: false });
    await a.mountSessionOutputs({ tenantId: "t1", sessionId: "sess-1" });
    expect(await a.exec("echo one")).toBe("one");
    const first = onlyBox(fake);
    expect(first.isFile("/tmp/bootstrapped")).toBe(true);

    fake.vanish(first.id);
    expect(await a.exec("echo two")).toBe("two");

    expect(fake.createCalls).toHaveLength(2);
    expect(acquire.mock.calls.map(([opts]) => opts)).toEqual([
      { reason: "use" },
      { reason: "recover", failedSandboxId: first.id },
    ]);
    expect(replay).toHaveBeenCalledTimes(1);
    const second = [...fake.sandboxes.values()].find((sb) => sb.id !== first.id)!;
    expect(second.state).toBe("started");
    expect(second.isFile("/tmp/bootstrapped")).toBe(true); // bootstrap ran on the replacement too
    expect(second.isDir("/mnt/memory/notes")).toBe(true);
    expect(second.isDir("/mnt/session/outputs")).toBe(true);
    // the "two" exec landed on the replacement
    expect(second.execLog.some((r) => r.command.endsWith("echo two"))).toBe(true);

    // steady state afterwards: no further re-provisioning
    expect(await a.exec("echo three")).toBe("three");
    expect(fake.createCalls).toHaveLength(2);
    expect(replay).toHaveBeenCalledTimes(1);
  });

  it("concurrent ops that both observe the gone box share ONE replacement (no orphan box, no third create)", async () => {
    const fake = new FakeDaytona();
    const a = makeSandbox(fake, { memoryBucket: bucket });
    fakeS3(a);
    const replay = vi.spyOn(a as unknown as { replayMounts: (sb: unknown) => Promise<void> }, "replayMounts");
    await a.mountSessionOutputs({ tenantId: "t1", sessionId: "sess-1" });
    await a.exec("true");
    const first = onlyBox(fake);
    fake.vanish(first.id);

    // Parallel tool calls: both fail on the dead box at the same time.
    const [x, y] = await Promise.all([a.exec("echo x"), a.exec("echo y")]);
    expect([x, y]).toEqual(["x", "y"]);
    expect(fake.createCalls).toHaveLength(2);
    const live = [...fake.sandboxes.values()].filter((sb) => sb.state === "started");
    expect(live).toHaveLength(1);
    // both retried ops landed on the single replacement, mounts replayed once
    expect(live[0].execLog.filter((r) => /echo [xy]$/.test(r.command))).toHaveLength(2);
    expect(replay).toHaveBeenCalledTimes(1);

    // A late failure against the OLD box after recovery finished reuses the
    // replacement instead of provisioning again.
    const recover = (a as unknown as {
      recoverFrom: (dead: { id: string }, p: Promise<unknown> | null, op: string) => Promise<{ id: string }>;
    }).recoverFrom.bind(a);
    const reused = await recover(first, null, "exec");
    expect(reused.id).toBe(live[0].id);
    expect(fake.createCalls).toHaveLength(2);

    await a.destroy();
    expect(fake.deleteCalls).toEqual([live[0].id]);
  });

  it("SessionBoxProvider ignores a stale recover request for a box it already replaced", async () => {
    const fake = new FakeDaytona();
    const provider = new SessionBoxProvider({
      sessionId: "sess-1",
      apiKey: "test-key",
      daytonaModule: fakeDaytonaModule(fake),
      bootstrap: async () => {},
      logger: silent,
    });
    const b1 = await provider.acquire({ reason: "use" });
    fake.vanish(b1.sb.id);
    const b2 = await provider.acquire({ reason: "recover", failedSandboxId: b1.sb.id });
    expect(b2.sb.id).not.toBe(b1.sb.id);
    expect(b2.generation).toBe(2);
    // stale: names the box that is already gone and replaced → keep b2
    const again = await provider.acquire({ reason: "recover", failedSandboxId: b1.sb.id });
    expect(again.sb.id).toBe(b2.sb.id);
    expect(again.freshlyCreated).toBe(false);
    expect(fake.createCalls).toHaveLength(2);
    // genuine: b2 itself is gone → a third box
    fake.vanish(b2.sb.id);
    const b3 = await provider.acquire({ reason: "recover", failedSandboxId: b2.sb.id });
    expect(b3.sb.id).not.toBe(b2.sb.id);
    expect(fake.createCalls).toHaveLength(3);
  });

  it("does not replay mounts when nothing was mounted", async () => {
    const fake = new FakeDaytona();
    const a = makeSandbox(fake);
    const replay = vi.spyOn(a as unknown as { replayMounts: (sb: unknown) => Promise<void> }, "replayMounts");
    await a.exec("true");
    fake.vanish(onlyBox(fake).id);
    expect(await a.exec("echo back")).toBe("back");
    expect(fake.createCalls).toHaveLength(2);
    // replayMounts is still invoked by withSandboxRecovery (it is a no-op
    // with no mounts) — exactly once, never for the initial provisioning.
    expect(replay).toHaveBeenCalledTimes(1);
  });

  it("a missing FILE (404 DaytonaNotFoundError) is not treated as a vanished sandbox", async () => {
    const fake = new FakeDaytona();
    const a = makeSandbox(fake);
    await a.exec("true");
    await expect(a.readFile("/workspace/sandbox/config.json")).rejects.toBeInstanceOf(DaytonaNotFoundError);
    await expect(a.readFile("/workspace/nope.md")).rejects.toThrow(/no such file/);
    expect(fake.createCalls).toHaveLength(1);
    expect(fake.deleteCalls).toEqual([]);
  });

  it("gives up after one replacement when the replacement is gone too", async () => {
    const fake = new FakeDaytona();
    fake.onCreate = (sb) => {
      // Every box dies right after bootstrap → exec sees the prod message.
      const origExec = sb.process.executeCommand;
      sb.process.executeCommand = async (cmd, cwd, env, timeout) => {
        if (cmd.startsWith("ulimit -f")) throw new Error(sandboxGoneMessage(sb.id));
        return origExec(cmd, cwd, env, timeout);
      };
    };
    const a = makeSandbox(fake);
    expect(await a.exec("echo x")).toMatch(/^\[error: not found: sandbox .* has been deleted\)\]$/);
    expect(fake.createCalls).toHaveLength(2);
  });
});

describe("isDaytonaNotFound", () => {
  const mod = fakeDaytonaModule(new FakeDaytona());

  it("matches the prod messages with or without the SDK module", () => {
    const gone = new Error(sandboxGoneMessage("69917c98-7870-4fed-a3f5-a5dbed85befa"));
    expect(isDaytonaNotFound(gone)).toBe(true);
    expect(isDaytonaNotFound(gone, mod)).toBe(true);
    expect(isDaytonaNotFound(new Error("sandbox abc123 has been archived"), mod)).toBe(true);
    expect(isDaytonaNotFound("sandbox 69917c98-7870 not found")).toBe(true);
  });

  it("accepts the SDK's own not-found class only when the message names a sandbox", () => {
    expect(isDaytonaNotFound(new DaytonaNotFoundError("Sandbox with ID sb-0001-abcdef12 not found"), mod)).toBe(true);
    expect(isDaytonaNotFound(new DaytonaNotFoundError("sandbox sb-0001-abcdef12 not found"), mod)).toBe(true);
    // same class for a missing file / session / command → NOT gone
    expect(isDaytonaNotFound(new DaytonaNotFoundError("open /workspace/notes.md: no such file or directory"), mod)).toBe(false);
    expect(isDaytonaNotFound(new DaytonaNotFoundError("open /workspace/sandbox/config.json: no such file or directory"), mod)).toBe(false);
    expect(isDaytonaNotFound(new DaytonaNotFoundError("session oma-proc-p1 not found"), mod)).toBe(false);
    expect(isDaytonaNotFound(new DaytonaNotFoundError("command cmd-1 not found in session oma-proc-p1"), mod)).toBe(false);
    // without the module the class check is unavailable → message regex only
    expect(isDaytonaNotFound(new DaytonaNotFoundError("Sandbox with ID sb-0001-abcdef12 not found"))).toBe(false);
  });

  it("ignores unrelated errors", () => {
    expect(isDaytonaNotFound(new Error("file not found: /workspace/notes.md"), mod)).toBe(false);
    expect(isDaytonaNotFound(new Error("not found: /workspace/sandbox/config.json"), mod)).toBe(false);
    expect(isDaytonaNotFound(new Error("command exited 127"), mod)).toBe(false);
    expect(isDaytonaNotFound(null, mod)).toBe(false);
  });
});

describe("buildDaytonaBootstrapScript", () => {
  it("emits the exact legacy script for default args", () => {
    expect(buildDaytonaBootstrapScript({ workdir: "/workspace", bootstrapTools: true, aptPackages: ["git", "curl"] })).toBe([
      "set -e",
      "mkdir -p '/workspace'",
      "if [ ! -f /tmp/.oma-daytona-tools-ready ]; then",
      "if command -v apt-get >/dev/null 2>&1; then",
      "  export DEBIAN_FRONTEND=noninteractive",
      "  apt-get update -qq",
      "  apt-get install -y -qq --no-install-recommends 'git' 'curl'",
      "else",
      "  echo 'apt-get not found; cannot bootstrap Daytona coding tools' >&2",
      "  exit 127",
      "fi",
      "  touch /tmp/.oma-daytona-tools-ready",
      "fi",
      "cd '/workspace'",
    ].join("\n"));
  });

  it("supports a custom marker path and extra lines before cd", async () => {
    const script = buildDaytonaBootstrapScript({
      workdir: "/workspace",
      bootstrapTools: false,
      aptPackages: [],
      markerPath: "/var/lib/oma/bootstrap.abc123.ok",
      extraLines: ["mkdir -p /var/lib/oma/procs", "touch /var/lib/oma/extra"],
    });
    expect(script).toContain("mkdir -p '/var/lib/oma'");
    expect(script).toContain("if [ ! -f '/var/lib/oma/bootstrap.abc123.ok' ]; then");
    expect(script).toContain("  touch '/var/lib/oma/bootstrap.abc123.ok'");
    expect(script.indexOf("touch /var/lib/oma/extra")).toBeLessThan(script.indexOf("cd '/workspace'"));
    expect(script.indexOf("touch /var/lib/oma/extra")).toBeGreaterThan(script.indexOf("bootstrap.abc123.ok' ]"));

    const fake = new FakeDaytona();
    const sb = await fake.create();
    expect((await sb.process.executeCommand(script)).exitCode).toBe(0);
    expect(sb.isFile("/var/lib/oma/bootstrap.abc123.ok")).toBe(true);
    expect(sb.isFile("/var/lib/oma/extra")).toBe(true);
    expect(sb.isDir("/var/lib/oma/procs")).toBe(true);
  });
});

describe("sandboxFactory", () => {
  it("builds a session-scoped adapter from env without touching Daytona", async () => {
    const sandbox = await sandboxFactory(
      { sessionId: "sess-f", workdir: "/tmp/x" },
      { DAYTONA_API_KEY: "k", SANDBOX_IMAGE: "debian:12", DAYTONA_EPHEMERAL: "false" },
    );
    expect(sandbox).toBeInstanceOf(DaytonaSandbox);
    const box = (sandbox as unknown as { box: SessionBoxProvider }).box;
    expect(box).toBeInstanceOf(SessionBoxProvider);
    expect(box.scope).toBe("session");
    expect(box.sessionDir()).toBeNull();
    expect(box.procDir()).toBe("/tmp/oma-procs");
  });
});
