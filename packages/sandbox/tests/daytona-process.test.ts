// Background processes on Daytona (startProcess → DaytonaProcessHandle),
// driven through the in-memory fake. The fake does not execute runAsync
// session commands, so tests (a) assert the exact wrapper/session/env-file
// shapes the adapter emits, (b) run the wrapper synchronously through the
// fake's shell to prove it sources + deletes the env file, and (c) drive
// completion / kill through `fake.completeCommand` and the recorded kills.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FakeDaytona,
  FakeDaytonaHttpError,
  type FakeSandboxInstance,
  fakeDaytonaModule,
} from "./fake-daytona.js";
import { DaytonaSandbox, type DaytonaSandboxOptions } from "../src/adapters/daytona.js";
import { SessionBoxProvider, type SandboxBoxProvider } from "../src/adapters/daytona-box-provider.js";
import {
  DaytonaProcessHandle,
  buildEnvFileContents,
  buildProcessWrapperCommand,
  normalizeSignalName,
} from "../src/adapters/daytona-process.js";

const silent = { log() {}, warn() {} };
const bucket = { endpoint: "https://s3.test", accessKey: "ak", secretKey: "sk", bucketName: "bkt" };
const PID = 4242;

/** Simulate the wrapper's `echo $$ > <pidFile>` side effect for runAsync commands. */
function writePidfiles(fake: FakeDaytona, pid: number | null = PID) {
  fake.onSessionCommand = ({ sandbox, command }) => {
    const m = /'([^']*\.pid)'$/.exec(command.command);
    if (m && pid !== null) sandbox.writeText(m[1], `${pid}\n`);
  };
}

function makeSandbox(fake: FakeDaytona, extra: Partial<DaytonaSandboxOptions> = {}) {
  return new DaytonaSandbox({
    sessionId: "sess-p",
    apiKey: "test-key",
    daytonaModule: fakeDaytonaModule(fake),
    logger: silent,
    ...extra,
  });
}

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

function onlySession(sb: FakeSandboxInstance) {
  const sessions = [...sb.sessions.values()];
  expect(sessions).toHaveLength(1);
  expect(sessions[0].commands).toHaveLength(1);
  return { sessionName: sessions[0].sessionId, cmd: sessions[0].commands[0] };
}

/** Skip the handle's 500 ms status cache without sleeping. */
function advanceClock(ms: number) {
  vi.setSystemTime(new Date(Date.now() + ms));
}

function trackedProcesses(a: DaytonaSandbox): Map<string, DaytonaProcessHandle> {
  return (a as unknown as { processes: Map<string, DaytonaProcessHandle> }).processes;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("DaytonaSandbox.startProcess", () => {
  it("creates one process session per command with the wrapper, after uploading a 0600 env file", async () => {
    const fake = new FakeDaytona();
    writePidfiles(fake);
    const a = makeSandbox(fake, { maxFileBytes: 1024 * 1024 });
    await a.setEnvVars({ FOO: "bar's", PATH_EXTRA: "/opt/bin" });
    a.registerCommandSecrets("git", { GIT_TOKEN: "secret" });

    const h = await a.startProcess("echo $FOO > /workspace/out.txt");
    expect(h).not.toBeNull();
    expect(h!.id).toMatch(/^p[\w-]{10}$/);
    expect(h!.pid).toBe(PID);

    const sb = onlyBox(fake);
    const { sessionName, cmd } = onlySession(sb);
    expect(sessionName).toBe(`oma-proc-${h!.id}`);
    expect(cmd.runAsync).toBe(true);
    expect(cmd.exitCode).toBeUndefined();

    const envFile = `/tmp/oma-procs/${h!.id}.env`;
    const pidFile = `/tmp/oma-procs/${h!.id}.pid`;
    expect(sb.readText(envFile)).toBe(
      "export FOO='bar'\\''s'\nexport PATH_EXTRA='/opt/bin'\nexport OMA_SANDBOX_MAX_FILE_BYTES='1048576'\n",
    );
    // command-prefixed secrets only apply to matching commands
    expect(sb.readText(envFile)).not.toContain("GIT_TOKEN");

    expect(cmd.command).toBe(
      `cd '/workspace' && ulimit -f 2048 && set -a && . '${envFile}' && set +a && rm -f '${envFile}' && ` +
      `OMA_PROC_ID='${h!.id}' setsid sh -c 'echo $$ > "$2"; exec sh -c "$1"' _ 'echo $FOO > /workspace/out.txt' '${pidFile}'`,
    );

    // setup ran in order: mkdir/chmod procDir → upload → chmod 600 env → session
    const setup = sb.execLog.map((r) => r.command);
    expect(setup).toContain("mkdir -p '/tmp/oma-procs' && chmod 700 '/tmp/oma-procs'");
    expect(setup).toContain(`chmod 600 '${envFile}'`);
    expect(setup.indexOf("mkdir -p '/tmp/oma-procs' && chmod 700 '/tmp/oma-procs'")).toBeLessThan(setup.indexOf(`chmod 600 '${envFile}'`));
    expect(sb.modeChanges).toContainEqual({ path: "/tmp/oma-procs", mode: "700", recursive: false });
    expect(sb.modeChanges).toContainEqual({ path: envFile, mode: "600", recursive: false });
    // the pidfile was read back (cat) to populate handle.pid
    expect(setup).toContain(`cat '${pidFile}' 2>/dev/null`);

    // A second process gets its own session and id.
    const h2 = await a.startProcess("sleep 100");
    expect(h2!.id).not.toBe(h!.id);
    expect([...sb.sessions.keys()].sort()).toEqual([`oma-proc-${h!.id}`, `oma-proc-${h2!.id}`].sort());
    expect(trackedProcesses(a).size).toBe(2);
  });

  it("wrapper: sources the env file into the command, deletes it, writes the pidfile", async () => {
    const fake = new FakeDaytona();
    writePidfiles(fake, null); // let the wrapper itself write the pidfile below
    const a = makeSandbox(fake);
    await a.setEnvVars({ FOO: "bar's" });
    const h = await a.startProcess("echo \"$FOO|$OMA_PROC_ID\" > /workspace/out.txt; exit 7");
    const sb = onlyBox(fake);
    const { cmd } = onlySession(sb);
    const envFile = `/tmp/oma-procs/${h!.id}.env`;
    const pidFile = `/tmp/oma-procs/${h!.id}.pid`;
    expect(sb.isFile(envFile)).toBe(true);

    // Run the exact wrapper synchronously through the fake's shell.
    const r = await sb.process.executeCommand(cmd.command);
    expect(r.exitCode).toBe(7); // inner command's exit propagates
    expect(sb.readText("/workspace/out.txt")).toBe(`bar's|${h!.id}\n`);
    expect(sb.isFile(envFile)).toBe(false); // removed before the command ran
    expect(Number.parseInt(sb.readText(pidFile) ?? "", 10)).toBeGreaterThan(0);
  });

  it("status: running → completed with exitCode, logs split by stream", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fake = new FakeDaytona();
    writePidfiles(fake);
    const a = makeSandbox(fake);
    const h = (await a.startProcess("npm test"))!;
    const sb = onlyBox(fake);
    const { sessionName, cmd } = onlySession(sb);

    expect(await h.getStatus()).toBe("running");
    fake.appendCommandOutput(sessionName, cmd.id, "> running tests\n", "warn: slow\n");
    expect(await h.getLogs()).toEqual({ stdout: "> running tests\n", stderr: "warn: slow\n" });

    fake.completeCommand(sessionName, cmd.id, 0, "all green\n");
    expect(await h.getStatus()).toBe("running"); // 500 ms cache
    advanceClock(600);
    expect(await h.getStatus()).toBe("completed");
    expect((h as DaytonaProcessHandle).exitCode).toBe(0);
    expect(await h.getLogs()).toEqual({ stdout: "> running tests\nall green\n", stderr: "warn: slow\n" });
    // terminal state is sticky and no longer polls the session
    const before = sb.execLog.length;
    expect(await h.getStatus()).toBe("completed");
    expect(sb.execLog.length).toBe(before);
    expect(trackedProcesses(a).size).toBe(0); // onTerminal untracked it
  });

  it("status: failed on non-zero exit, exitCode exposed for the bash tool", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fake = new FakeDaytona();
    writePidfiles(fake);
    const a = makeSandbox(fake);
    const h = (await a.startProcess("git commit -m x"))!;
    const { sessionName, cmd } = onlySession(onlyBox(fake));
    expect(await h.getStatus()).toBe("running");
    fake.completeCommand(sessionName, cmd.id, 128, "", "Author identity unknown\n");
    advanceClock(600);
    expect(await h.getStatus()).toBe("failed");
    expect((h as DaytonaProcessHandle).exitCode).toBe(128);
    expect(await h.getLogs()).toEqual({ stdout: "", stderr: "Author identity unknown\n" });
  });

  it("getLogs falls back to `output` when the toolbox does not split streams (real SDK shape: empty strings, never undefined)", async () => {
    const fake = new FakeDaytona();
    writePidfiles(fake);
    const a = makeSandbox(fake);
    const h = (await a.startProcess("make"))!;
    const sb = onlyBox(fake);
    // @daytonaio/sdk Process.getSessionCommandLogs coerces every stream with
    // `?? ''`, so an unsplit toolbox response is `{ stdout: "", stderr: "", output }`.
    sb.process.getSessionCommandLogs = async () => ({ stdout: "", stderr: "", output: "combined\n" });
    expect(await h.getLogs()).toEqual({ stdout: "combined\n", stderr: "" });
    // split streams win and stderr is never duplicated out of `output`
    sb.process.getSessionCommandLogs = async () => ({ stdout: "", stderr: "warn\n", output: "warn\n" });
    expect(await h.getLogs()).toEqual({ stdout: "", stderr: "warn\n" });
    sb.process.getSessionCommandLogs = async () => ({ stdout: "out\n", stderr: "err\n", output: "out\nerr\n" });
    expect(await h.getLogs()).toEqual({ stdout: "out\n", stderr: "err\n" });
  });

  it("kill: process-group SIGTERM, then deleteSession; status killed; onTerminal once with outputs sync + key release", async () => {
    const fake = new FakeDaytona();
    writePidfiles(fake);
    const inner = new SessionBoxProvider({
      sessionId: "sess-p",
      apiKey: "test-key",
      daytonaModule: fakeDaytonaModule(fake),
      bootstrap: async () => {},
      logger: silent,
    });
    const setActivityKey = vi.fn();
    const provider: SandboxBoxProvider = {
      scope: "session",
      acquire: (o) => inner.acquire(o),
      release: () => inner.release(),
      sessionDir: () => inner.sessionDir(),
      procDir: () => inner.procDir(),
      lockShared: (fn) => inner.lockShared(fn),
      setActivityKey,
    };
    const a = makeSandbox(fake, { box: provider, memoryBucket: bucket });
    const sends = fakeS3(a);
    await a.mountSessionOutputs({ tenantId: "t1", sessionId: "sess-p" });

    const h = (await a.startProcess("python server.py"))!;
    expect(setActivityKey).toHaveBeenCalledWith(`proc:${h.id}`, true);
    const sb = onlyBox(fake);
    const { sessionName, cmd } = onlySession(sb);
    sb.writeText("/mnt/session/outputs/server.log", "listening\n");
    fake.appendCommandOutput(sessionName, cmd.id, "listening on :8000\n");

    const killed = h.kill("SIGTERM");
    await vi.waitFor(() => expect(sb.kills.length).toBeGreaterThan(0));
    expect(sb.kills).toEqual([{ signal: "TERM", targets: [`-${PID}`] }]);
    expect(sb.execLog.at(-1)?.command).toBe(
      `kill -s SIGTERM -- -${PID} 2>/dev/null || kill -s SIGTERM ${PID} 2>/dev/null; true`,
    );
    // the process obeys SIGTERM
    fake.completeCommand(sessionName, cmd.id, 143);
    await killed;

    expect(sb.sessions.size).toBe(0); // deleteSession ran
    expect(await h.getStatus()).toBe("killed");
    expect((h as DaytonaProcessHandle).exitCode).toBe(143);
    expect(await h.getLogs()).toEqual({ stdout: "listening on :8000\n", stderr: "" }); // snapshotted before delete
    expect(sb.kills).toHaveLength(1); // no SIGKILL escalation needed

    // onTerminal: outputs synced exactly once, key released, untracked
    expect(sends.filter((s) => s.type === "PutObject").map((s) => s.input.Key)).toEqual([
      "session-outputs/t1/sess-p/server.log",
    ]);
    expect(setActivityKey.mock.calls).toEqual([[`proc:${h.id}`, true], [`proc:${h.id}`, false]]);
    expect(trackedProcesses(a).size).toBe(0);
    await h.getStatus();
    await h.kill("SIGTERM"); // idempotent after the session is gone
    expect(sends.filter((s) => s.type === "PutObject")).toHaveLength(1);
    expect(setActivityKey).toHaveBeenCalledTimes(2);
  });

  it("natural exit: onTerminal fires once and syncs outputs on the first terminal observation", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fake = new FakeDaytona();
    writePidfiles(fake);
    const a = makeSandbox(fake, { memoryBucket: bucket });
    const sends = fakeS3(a);
    await a.mountSessionOutputs({ tenantId: "t1", sessionId: "sess-p" });
    const h = (await a.startProcess("python report.py"))!;
    const sb = onlyBox(fake);
    const { sessionName, cmd } = onlySession(sb);
    const putsBefore = sends.filter((s) => s.type === "PutObject").length;

    sb.writeText("/mnt/session/outputs/report.csv", "a,b\n");
    fake.completeCommand(sessionName, cmd.id, 0, "done\n");
    advanceClock(600);
    expect(await h.getStatus()).toBe("completed");
    expect(await h.getStatus()).toBe("completed");
    expect(await h.getStatus()).toBe("completed");
    const puts = sends.filter((s) => s.type === "PutObject").slice(putsBefore);
    expect(puts.map((s) => s.input.Key)).toEqual(["session-outputs/t1/sess-p/report.csv"]);
    // the finished session is deleted (no idle shell per bash call piles up
    // in the box) — the final logs stay readable from the handle's snapshot
    expect(sb.sessions.has(sessionName)).toBe(false);
    expect(await h.getLogs()).toEqual({ stdout: "done\n", stderr: "" });
    expect((h as DaytonaProcessHandle).exitCode).toBe(0);
    await h.kill("SIGTERM"); // no-op after the session is gone
    expect(sb.kills).toEqual([]);
  });

  it("every bash-tool style run (start → poll → logs) leaves no process session behind", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fake = new FakeDaytona();
    writePidfiles(fake);
    const a = makeSandbox(fake);
    const sb0 = (await a.startProcess("true"), onlyBox(fake));
    for (let i = 0; i < 5; i++) {
      const h = (await a.startProcess(`echo ${i}`))!;
      const sessionName = `oma-proc-${h.id}`;
      const cmd = sb0.sessions.get(sessionName)!.commands[0];
      fake.completeCommand(sessionName, cmd.id, 0, `${i}\n`);
      advanceClock(600);
      expect(await h.getStatus()).toBe("completed");
      expect(await h.getLogs()).toEqual({ stdout: `${i}\n`, stderr: "" });
    }
    // only the very first (never polled) process session remains
    expect(sb0.sessions.size).toBe(1);
    expect(trackedProcesses(a).size).toBe(1);
  });

  it("returns null for storage-policy violations without touching Daytona", async () => {
    const fake = new FakeDaytona();
    const a = makeSandbox(fake);
    expect(await a.startProcess("fallocate -l 30G /workspace/blob")).toBeNull();
    expect(await a.startProcess("ls /mnt/_oma_storage")).toBeNull();
    expect(await a.startProcess("dd if=/dev/zero of=/workspace/x count=1000")).toBeNull();
    expect(fake.createCalls).toHaveLength(0);
    // exec() surfaces the same policy error text to the model
    expect(await a.exec("fallocate -l 30G /workspace/blob")).toContain("blocked");
  });

  it("returns null (exec fallback) when the SDK refuses to start the session command", async () => {
    const fake = new FakeDaytona();
    writePidfiles(fake);
    const a = makeSandbox(fake);
    await a.exec("true");
    const sb = onlyBox(fake);
    sb.process.executeSessionCommand = async () => {
      throw new FakeDaytonaHttpError("toolbox unavailable", 502);
    };
    expect(await a.startProcess("sleep 5")).toBeNull();
    expect(sb.sessions.size).toBe(0); // the half-created session was removed
    expect(trackedProcesses(a).size).toBe(0);

    // and when the box cannot even be provisioned
    const prev = process.env.DAYTONA_API_KEY;
    delete process.env.DAYTONA_API_KEY;
    try {
      const noKey = makeSandbox(new FakeDaytona(), { apiKey: undefined });
      expect(await noKey.startProcess("sleep 5")).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.DAYTONA_API_KEY;
      else process.env.DAYTONA_API_KEY = prev;
    }
  });

  it("recovers a vanished box before starting the process", async () => {
    const fake = new FakeDaytona();
    writePidfiles(fake);
    const a = makeSandbox(fake);
    await a.exec("true");
    const first = onlyBox(fake);
    fake.vanish(first.id);
    const h = await a.startProcess("sleep 1");
    expect(h).not.toBeNull();
    expect(fake.createCalls).toHaveLength(2);
    const second = [...fake.sandboxes.values()].find((sb) => sb.id !== first.id)!;
    expect(second.sessions.has(`oma-proc-${h!.id}`)).toBe(true);
  });

  it("destroy() kills tracked processes before deleting the box", async () => {
    const fake = new FakeDaytona();
    writePidfiles(fake);
    const a = makeSandbox(fake);
    const h = (await a.startProcess("sleep 1000"))!;
    const sb = onlyBox(fake);
    const { sessionName, cmd } = onlySession(sb);
    // the process dies on SIGTERM
    sb.commandHandlers.set("kill", ({ args }) => {
      sb.kills.push({ signal: args[1].replace(/^SIG/, ""), targets: args.slice(3, 4) });
      fake.completeCommand(sessionName, cmd.id, 143);
      return { exitCode: 0 };
    });
    await a.destroy();
    expect(sb.kills).toEqual([{ signal: "TERM", targets: [`-${PID}`] }]);
    expect(await h.getStatus()).toBe("killed");
    expect(fake.deleteCalls).toEqual([sb.id]);
    expect(trackedProcesses(a).size).toBe(0);
  });
});

describe("DaytonaProcessHandle (direct)", () => {
  async function session(fake: FakeDaytona, name = "oma-proc-pX") {
    const sb = await fake.create();
    await sb.process.createSession(name);
    const { cmdId } = await sb.process.executeSessionCommand(name, { command: "sleep 1000", runAsync: true });
    return { sb, cmdId };
  }

  it("escalates to SIGKILL after the grace period, then deletes the session", async () => {
    const fake = new FakeDaytona();
    const { sb, cmdId } = await session(fake);
    sb.writeText("/tmp/oma-procs/pX.pid", "777\n");
    const onTerminal = vi.fn();
    const h = new DaytonaProcessHandle({
      sb, sessionName: "oma-proc-pX", cmdId, procId: "pX", pidFile: "/tmp/oma-procs/pX.pid",
      logger: silent, onTerminal, killGraceMs: 30, pollIntervalMs: 5,
    });
    expect(await h.resolvePid()).toBe(777);
    expect(h.pid).toBe(777);
    await h.kill(); // default SIGTERM
    expect(sb.kills).toEqual([
      { signal: "TERM", targets: ["-777"] },
      { signal: "KILL", targets: ["-777"] },
    ]);
    expect(sb.sessions.size).toBe(0);
    expect(await h.getStatus()).toBe("killed");
    expect(h.exitCode).toBeUndefined(); // never observed → bash tool maps killed → 137
    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(await h.getLogs()).toEqual({ stdout: "", stderr: "" });
  });

  it("kill('SIGKILL') skips the grace period", async () => {
    const fake = new FakeDaytona();
    const { sb, cmdId } = await session(fake);
    sb.writeText("/tmp/oma-procs/pX.pid", "778\n");
    const h = new DaytonaProcessHandle({
      sb, sessionName: "oma-proc-pX", cmdId, procId: "pX", pidFile: "/tmp/oma-procs/pX.pid",
      logger: silent, killGraceMs: 30, pollIntervalMs: 5,
    });
    await h.kill("SIGKILL");
    expect(sb.kills).toEqual([{ signal: "KILL", targets: ["-778"] }]);
    expect(sb.sessions.size).toBe(0);
  });

  it("pid is 0 when the pidfile never appears; kill then only deletes the session", async () => {
    const fake = new FakeDaytona();
    const { sb, cmdId } = await session(fake);
    const h = new DaytonaProcessHandle({
      sb, sessionName: "oma-proc-pX", cmdId, procId: "pX", pidFile: "/tmp/oma-procs/pX.pid",
      logger: silent, pidRetries: 3, pidRetryDelayMs: 1, killGraceMs: 10, pollIntervalMs: 1,
    });
    expect(await h.resolvePid()).toBe(0);
    expect(sb.execLog.filter((r) => r.command.startsWith("cat '/tmp/oma-procs/pX.pid'"))).toHaveLength(3);
    expect(h.pid).toBe(0);
    await h.kill("SIGTERM");
    expect(sb.kills).toEqual([]);
    expect(sb.sessions.size).toBe(0);
    expect(await h.getStatus()).toBe("killed");
  });

  it("a killed process that still exits 0 reports completed; non-zero after kill reports killed", async () => {
    const fake = new FakeDaytona();
    const { sb, cmdId } = await session(fake);
    sb.writeText("/tmp/oma-procs/pX.pid", "779\n");
    const h = new DaytonaProcessHandle({
      sb, sessionName: "oma-proc-pX", cmdId, procId: "pX", pidFile: "/tmp/oma-procs/pX.pid",
      logger: silent, killGraceMs: 200, pollIntervalMs: 5,
    });
    const killed = h.kill();
    await vi.waitFor(() => expect(sb.kills.length).toBe(1));
    fake.completeCommand("oma-proc-pX", cmdId, 0, "graceful shutdown\n");
    await killed;
    expect(await h.getStatus()).toBe("completed");
    expect(h.exitCode).toBe(0);
    expect(await h.getLogs()).toEqual({ stdout: "graceful shutdown\n", stderr: "" });
  });

  it("caps each log stream at 1 MiB keeping the tail", async () => {
    const fake = new FakeDaytona();
    const { sb, cmdId } = await session(fake);
    const big = "x".repeat(1024 * 1024 + 100);
    fake.appendCommandOutput("oma-proc-pX", cmdId, big, "e");
    const h = new DaytonaProcessHandle({
      sb, sessionName: "oma-proc-pX", cmdId, procId: "pX", pidFile: "/tmp/oma-procs/pX.pid", logger: silent,
    });
    const logs = await h.getLogs();
    expect(logs.stdout.startsWith("…[100 bytes truncated]\n")).toBe(true);
    expect(logs.stdout.length).toBe("…[100 bytes truncated]\n".length + 1024 * 1024);
    expect(logs.stderr).toBe("e");
  });

  it("reports failed (not an infinite loop) when the sandbox vanishes mid-run", async () => {
    const fake = new FakeDaytona();
    const { sb, cmdId } = await session(fake);
    const onTerminal = vi.fn();
    const h = new DaytonaProcessHandle({
      sb, sessionName: "oma-proc-pX", cmdId, procId: "pX", pidFile: "/tmp/oma-procs/pX.pid", logger: silent, onTerminal,
    });
    expect(await h.getStatus()).toBe("running");
    fake.vanish(sb.id);
    vi.useFakeTimers({ toFake: ["Date"] });
    advanceClock(600);
    expect(await h.getStatus()).toBe("failed");
    expect(onTerminal).toHaveBeenCalledTimes(1);
  });
});

describe("wrapper helpers", () => {
  it("buildEnvFileContents emits export lines with single quotes escaped and skips invalid names", () => {
    expect(buildEnvFileContents({ A: "1", B: "it's", "BAD-NAME": "x", _ok: "" })).toBe(
      "export A='1'\nexport B='it'\\''s'\nexport _ok=''\n",
    );
    expect(buildEnvFileContents({})).toBe("");
  });

  it("buildProcessWrapperCommand produces the documented shape", () => {
    expect(buildProcessWrapperCommand({
      procId: "p1",
      cwd: "/work dir",
      envFile: "/var/lib/oma/procs/p1.env",
      pidFile: "/var/lib/oma/procs/p1.pid",
      fileSizeBlocks: 10.9,
      command: "echo 'hi' && sleep 1",
    })).toBe(
      "cd '/work dir' && ulimit -f 10 && set -a && . '/var/lib/oma/procs/p1.env' && set +a && rm -f '/var/lib/oma/procs/p1.env' && " +
      `OMA_PROC_ID='p1' setsid sh -c 'echo $$ > "$2"; exec sh -c "$1"' _ 'echo '\\''hi'\\'' && sleep 1' '/var/lib/oma/procs/p1.pid'`,
    );
    expect(buildProcessWrapperCommand({ procId: "p", cwd: "/w", envFile: "/e", pidFile: "/p", fileSizeBlocks: 0, command: "x" })).toContain("ulimit -f 1 ");
  });

  it("normalizeSignalName", () => {
    expect(normalizeSignalName("SIGTERM")).toBe("SIGTERM");
    expect(normalizeSignalName("term")).toBe("SIGTERM");
    expect(normalizeSignalName("9")).toBe("SIGKILL");
    expect(normalizeSignalName("")).toBe("SIGTERM");
    expect(normalizeSignalName("42")).toBe("42");
  });
});
