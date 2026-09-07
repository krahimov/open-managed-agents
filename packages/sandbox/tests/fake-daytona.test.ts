// Self-tests for the in-memory Daytona fake (tests/fake-daytona.ts). These
// pin the behaviours the adapter/manager tests lean on: the shell interpreter
// understands the exact command shapes daytona.ts emits, process sessions
// model runAsync commands, and vanish()/lifecycle produce the same error
// surface the real SDK does.

import { describe, it, expect, vi } from "vitest";
import {
  CDP_VERSION_URL,
  DaytonaError,
  DaytonaNotFoundError,
  FakeDaytona,
  FakeSandboxInstance,
  fakeDaytonaModule,
  sandboxGoneMessage,
} from "./fake-daytona.js";
import { DaytonaSandbox, buildDaytonaBootstrapScript } from "../src/adapters/daytona.js";

async function box(fake = new FakeDaytona()) {
  const sb = await fake.create({ image: "node:22-bookworm", labels: { "oma-session-id": "s1" } });
  return { fake, sb };
}

const run = (sb: FakeSandboxInstance, cmd: string, cwd?: string, env?: Record<string, string>, timeout?: number) =>
  sb.process.executeCommand(cmd, cwd, env, timeout);

const silent = { log() {}, warn() {} };

describe("FakeDaytona shell interpreter", () => {
  it("mkdir -p / echo > / cat / test -f / find -printf round-trip", async () => {
    const { sb } = await box();
    const r = await run(sb, "mkdir -p /workspace/a/b && echo hello > /workspace/a/b/f.txt && echo ' world' >> /workspace/a/b/f.txt");
    expect(r.exitCode).toBe(0);
    expect((await run(sb, "cat /workspace/a/b/f.txt")).artifacts.stdout).toBe("hello\n world\n");
    expect((await run(sb, "test -f /workspace/a/b/f.txt")).exitCode).toBe(0);
    expect((await run(sb, "test -f /workspace/a/b/nope")).exitCode).toBe(1);
    expect((await run(sb, "[ -d /workspace/a ]")).exitCode).toBe(0);
    expect((await run(sb, "[ ! -f /workspace/a/b/f.txt ]")).exitCode).toBe(1);
    const find = await run(sb, "find /workspace/a -type f -printf '%P\\t%s\\n'");
    expect(find.artifacts.stdout).toBe("b/f.txt\t13\n");
    expect(sb.readText("/workspace/a/b/f.txt")).toBe("hello\n world\n");
    const missingCat = await run(sb, "cat /workspace/none");
    expect(missingCat.exitCode).toBe(1);
    expect(missingCat.artifacts.stderr).toBe("cat: /workspace/none: No such file or directory\n");
    // `>` into a missing directory fails like sh does
    const badRedirect = await run(sb, "echo x > /var/lib/oma/missing/file");
    expect(badRedirect.exitCode).toBe(1);
    expect(badRedirect.artifacts.stderr).toMatch(/cannot create/);
  });

  it("runs the adapter's mount-setup and list-files command shapes verbatim", async () => {
    const { sb } = await box();
    const mp = "/mnt/memory/notes";
    const setup = await run(sb, `mkdir -p /mnt/memory && rm -rf '${mp}' && mkdir -p '${mp}'`);
    expect(setup.exitCode).toBe(0);
    await sb.fs.uploadFile(Buffer.from("abc"), `${mp}/a.md`);
    await sb.fs.uploadFile(Buffer.from("hello"), `${mp}/sub/b.md`);
    const prep = await run(sb, `mkdir -p '${mp}' && chmod -R u+w '${mp}' 2>/dev/null || true`);
    expect(prep.exitCode).toBe(0);
    expect(sb.modeChanges).toContainEqual({ path: mp, mode: "u+w", recursive: true });
    const list = await run(sb, `if [ -d '${mp}' ]; then find '${mp}' -type f -printf '%P\\t%s\\n'; fi`);
    expect(list.exitCode).toBe(0);
    expect(list.artifacts.stdout.split("\n").filter(Boolean).sort()).toEqual(["a.md\t3", "sub/b.md\t5"]);
    const missing = await run(sb, `if [ -d '/mnt/memory/other' ]; then find '/mnt/memory/other' -type f -printf '%P\\t%s\\n'; fi`);
    expect(missing).toMatchObject({ exitCode: 0, artifacts: { stdout: "" } });
    // chmod on a missing path fails, but the adapter's `2>/dev/null || true` absorbs it
    const ro = await run(sb, "chmod -R a-w '/mnt/memory/none' 2>/dev/null || true");
    expect(ro).toMatchObject({ exitCode: 0, artifacts: { stdout: "", stderr: "" } });
    // and `rm -rf` on the mount followed by re-mkdir wipes content
    await run(sb, `rm -rf '${mp}' && mkdir -p '${mp}'`);
    expect(sb.isDir(mp)).toBe(true);
    expect(sb.isFile(`${mp}/a.md`)).toBe(false);
  });

  it("runs buildDaytonaBootstrapScript green and honours the tools-ready marker", async () => {
    const { sb } = await box();
    const script = buildDaytonaBootstrapScript({ workdir: "/workspace", bootstrapTools: true, aptPackages: ["git", "curl"] });
    const first = await run(sb, script, undefined, undefined, 300);
    expect(first.exitCode).toBe(0);
    expect(sb.isFile("/tmp/.oma-daytona-tools-ready")).toBe(true);
    expect(sb.unhandledCommands.map((c) => c.name)).toEqual(["apt-get", "apt-get"]);
    expect(sb.unhandledCommands[1].args).toEqual(["install", "-y", "-qq", "--no-install-recommends", "git", "curl"]);
    sb.unhandledCommands.length = 0;
    const second = await run(sb, script);
    expect(second.exitCode).toBe(0);
    expect(sb.unhandledCommands).toEqual([]); // marker short-circuits apt

    // Without apt-get the script's else-branch exits 127 with its message on stderr
    const bare = await box();
    bare.sb.missingCommands.add("apt-get");
    const failed = await run(bare.sb, script);
    expect(failed.exitCode).toBe(127);
    expect(failed.artifacts.stderr).toContain("apt-get not found");
    expect(failed.artifacts.stdout).toBe("");
    expect(bare.sb.isFile("/tmp/.oma-daytona-tools-ready")).toBe(false);
  });

  it("separates stderr from stdout and propagates non-zero exit codes", async () => {
    const { sb } = await box();
    const r = await run(sb, "echo out; echo err >&2; exit 3");
    expect(r).toEqual({ exitCode: 3, result: "out\n", artifacts: { stdout: "out\n", stderr: "err\n" } });
    expect(sb.execLog.at(-1)).toMatchObject({ command: "echo out; echo err >&2; exit 3", exitCode: 3, stdout: "out\n", stderr: "err\n" });
    expect((await run(sb, "echo both 2>&1 >/dev/null; echo shown")).artifacts.stdout).toBe("shown\n");
  });

  it("set -e aborts at the first failing command", async () => {
    const { sb } = await box();
    const r = await run(sb, "set -e\necho one\nfalse\necho two");
    expect(r.exitCode).toBe(1);
    expect(r.artifacts.stdout).toBe("one\n");
    const tolerated = await run(sb, "set -e\nfalse || true\nif false; then :; fi\n! false\necho reached");
    expect(tolerated).toMatchObject({ exitCode: 0, artifacts: { stdout: "reached\n" } });
  });

  it("expands variables, command substitution, arithmetic, loops and sh -c positionals", async () => {
    const { sb } = await box();
    const r = await run(sb, 'N=3; for i in $(seq 1 $N); do echo "item-$((i * 2)) ${PREFIX:-none} $HOME"; done', "/workspace", { HOME: "/root" });
    expect(r.artifacts.stdout).toBe("item-2 none /root\nitem-4 none /root\nitem-6 none /root\n");
    const sub = await run(sb, `sh -c 'echo "$1 has $# arg(s) via $0"' _ payload`);
    expect(sub.artifacts.stdout).toBe("payload has 1 arg(s) via _\n");
    const pipes = await run(sb, "printf 'b\\na\\nc\\n' | sort | head -n 2 | wc -l");
    expect(pipes.artifacts.stdout.trim()).toBe("2");
    const loop = await run(sb, "i=0; while [ $i -lt 5 ]; do i=$((i+1)); [ $i -eq 3 ] && continue; [ $i -eq 5 ] && break; echo $i; done; echo end");
    expect(loop.artifacts.stdout).toBe("1\n2\n4\nend\n");
    const kase = await run(sb, 'for f in a.md b.txt; do case "$f" in *.md) echo "md:$f";; *) echo "other:$f";; esac; done');
    expect(kase.artifacts.stdout).toBe("md:a.md\nother:b.txt\n");
  });

  it("serves curl -sf against the CDP version endpoint only when configured", async () => {
    const { sb } = await box();
    const refused = await run(sb, `curl -sf ${CDP_VERSION_URL}`);
    expect(refused.exitCode).toBe(7);
    expect(refused.artifacts.stdout).toBe("");
    sb.setCdpVersion({ Browser: "Chrome/130", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/abc" });
    const ok = await run(sb, `curl -sf ${CDP_VERSION_URL}`);
    expect(ok.exitCode).toBe(0);
    expect(JSON.parse(ok.artifacts.stdout)).toMatchObject({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/abc" });
    sb.httpResponses.set("http://127.0.0.1:9223/json/version", { status: 502, body: "bad gateway" });
    const failed = await run(sb, "curl -sf http://127.0.0.1:9223/json/version");
    expect(failed.exitCode).toBe(22);
    expect(sb.httpRequests.map((q) => q.url)).toEqual([CDP_VERSION_URL, CDP_VERSION_URL, "http://127.0.0.1:9223/json/version"]);
    // a polling loop over the endpoint terminates once the responder flips
    let calls = 0;
    sb.httpResponses.set(CDP_VERSION_URL, () => (++calls < 3 ? { status: 503, body: "" } : { status: 200, body: "{}" }));
    const poll = await run(sb, `for i in $(seq 1 10); do curl -sf ${CDP_VERSION_URL} >/dev/null && echo ready-after-$i && exit 0; sleep 0.5; done; exit 1`);
    expect(poll).toMatchObject({ exitCode: 0, artifacts: { stdout: "ready-after-3\n" } });
  });

  it("records kill invocations (process-group form included)", async () => {
    const { sb } = await box();
    sb.writeText("/var/lib/oma/procs/p1.pid", "4242\n");
    const r = await run(sb, "kill -s TERM -- -$(cat /var/lib/oma/procs/p1.pid) && kill -9 4242");
    expect(r.exitCode).toBe(0);
    expect(sb.kills).toEqual([{ signal: "TERM", targets: ["-4242"] }, { signal: "KILL", targets: ["4242"] }]);
    sb.killExitCode = 1;
    expect((await run(sb, "kill 4242")).exitCode).toBe(1);
  });

  it("records unknown commands and lets them succeed; handlers can override", async () => {
    const { sb } = await box();
    const r = await run(sb, "apt-get install -y chromium && node --version");
    expect(r.exitCode).toBe(0);
    expect(sb.unhandledCommands.map((c) => c.line)).toEqual(["apt-get install -y chromium", "node --version"]);
    sb.commandHandlers.set("node", ({ args }) => ({ exitCode: 0, stdout: args[0] === "--version" ? "v22.0.0\n" : "" }));
    expect((await run(sb, "node --version")).artifacts.stdout).toBe("v22.0.0\n");
    expect((await run(sb, "command -v chromium && which node")).artifacts.stdout).toBe("/usr/bin/chromium\n/usr/bin/node\n");
    sb.missingCommands.add("chromium");
    expect((await run(sb, "command -v chromium")).exitCode).toBe(1);
  });

  it("reports syntax errors like sh (exit 2) instead of throwing", async () => {
    const { sb } = await box();
    const r = await run(sb, "if true; then echo x");
    expect(r.exitCode).toBe(2);
    expect(r.artifacts.stderr).toMatch(/Syntax error/);
  });

  it("supports heredocs, cwd, mv and a find -newer sweep with -exec", async () => {
    const fake = new FakeDaytona();
    let t = 1_000_000;
    fake.now = () => t;
    const sb = await fake.create();
    const seeded = await run(sb, "mkdir -p /mnt/session/outputs /mnt/sessions/s1/outputs && cat > /mnt/session/outputs/old.txt <<'EOF'\nold $NOT_EXPANDED\nEOF");
    expect(seeded.exitCode).toBe(0);
    expect(sb.readText("/mnt/session/outputs/old.txt")).toBe("old $NOT_EXPANDED\n");
    t += 60_000;
    await run(sb, "touch /mnt/sessions/s1/.exec-stamp");
    t += 60_000;
    await run(sb, "echo new > /mnt/session/outputs/new.txt");
    const sweep = await run(sb, "find /mnt/session/outputs -mindepth 1 -maxdepth 1 -newer /mnt/sessions/s1/.exec-stamp -exec mv {} /mnt/sessions/s1/outputs/ \\;");
    expect(sweep.exitCode).toBe(0);
    expect(sb.isFile("/mnt/sessions/s1/outputs/new.txt")).toBe(true);
    expect(sb.isFile("/mnt/session/outputs/old.txt")).toBe(true);
    expect(sb.isFile("/mnt/session/outputs/new.txt")).toBe(false);
    const cwd = await run(sb, "cd /mnt/sessions/s1 && pwd && ls outputs && ls -a . | head -n 2", "/workspace");
    expect(cwd.artifacts.stdout).toBe("/mnt/sessions/s1\nnew.txt\n.exec-stamp\noutputs\n");
    expect((await run(sb, "ls /nope")).exitCode).toBe(2);
  });
});

describe("FakeDaytona process sessions", () => {
  it("runAsync commands stay running until completeCommand, then expose exit code and logs", async () => {
    const { fake, sb } = await box();
    await sb.process.createSession("oma-proc-p1");
    const { cmdId } = await sb.process.executeSessionCommand("oma-proc-p1", { command: "sleep 100", runAsync: true });
    expect(await sb.process.getSessionCommand("oma-proc-p1", cmdId)).toEqual({ id: cmdId, command: "sleep 100" });
    expect((await sb.process.getSessionCommand("oma-proc-p1", cmdId)).exitCode).toBeUndefined();
    fake.appendCommandOutput("oma-proc-p1", cmdId, "partial\n");
    expect(await sb.process.getSessionCommandLogs("oma-proc-p1", cmdId)).toEqual({ stdout: "partial\n", stderr: "", output: "partial\n" });
    fake.completeCommand("oma-proc-p1", cmdId, 137, "done\n", "killed\n");
    expect(await sb.process.getSessionCommand("oma-proc-p1", cmdId)).toEqual({ id: cmdId, command: "sleep 100", exitCode: 137 });
    expect(await sb.process.getSessionCommandLogs("oma-proc-p1", cmdId)).toEqual({
      stdout: "partial\ndone\n",
      stderr: "killed\n",
      output: "partial\ndone\nkilled\n",
    });
    expect((await sb.process.listSessions()).map((s) => s.sessionId)).toEqual(["oma-proc-p1"]);
    await sb.process.deleteSession("oma-proc-p1");
    expect(await sb.process.listSessions()).toEqual([]);
    await expect(sb.process.getSessionCommand("oma-proc-p1", cmdId)).rejects.toBeInstanceOf(DaytonaNotFoundError);
    await expect(sb.process.createSession("dup")).resolves.toBeUndefined();
    await expect(sb.process.createSession("dup")).rejects.toMatchObject({ statusCode: 409 });
  });

  it("synchronous session commands run through the interpreter and keep cwd/env", async () => {
    const { sb } = await box();
    await sb.process.createSession("shell");
    await sb.process.executeSessionCommand("shell", { command: "cd /tmp && export FOO=bar" });
    const r = await sb.process.executeSessionCommand("shell", { command: "pwd; echo $FOO" });
    expect(r).toMatchObject({ exitCode: 0, stdout: "/tmp\nbar\n" });
  });

  it("autoCompleteMs completes async commands; onSessionCommand can fake side effects", async () => {
    const fake = new FakeDaytona();
    fake.autoCompleteMs = 5;
    fake.onSessionCommand = ({ sandbox, command }) => {
      if (command.command.includes("PIDFILE")) sandbox.writeText("/var/lib/oma/procs/p9.pid", "777\n");
    };
    const sb = await fake.create();
    await sb.process.createSession("s");
    const { cmdId } = await sb.process.executeSessionCommand("s", { command: "echo $$ > PIDFILE; exec sleep 5", runAsync: true });
    expect(sb.readText("/var/lib/oma/procs/p9.pid")).toBe("777\n");
    expect(fake.findSession("s")?.sandbox).toBe(sb);
    await vi.waitFor(async () => {
      expect((await sb.process.getSessionCommand("s", cmdId)).exitCode).toBe(0);
    });
  });

  it("autoCompleteMs timer is harmless when the session was deleted first (kill → deleteSession)", async () => {
    // Regression: the timer used to re-look-up the command via the session and
    // threw DaytonaNotFoundError inside setTimeout → unhandled error failing the run.
    const fake = new FakeDaytona();
    fake.autoCompleteMs = 10;
    const sb = await fake.create();
    await sb.process.createSession("oma-proc-gone");
    const { cmdId } = await sb.process.executeSessionCommand("oma-proc-gone", { command: "sleep 100", runAsync: true });
    await sb.process.deleteSession("oma-proc-gone");
    await new Promise((r) => setTimeout(r, 40));
    await expect(sb.process.getSessionCommand("oma-proc-gone", cmdId)).rejects.toBeInstanceOf(DaytonaNotFoundError);
    // and a completed-by-hand command is not clobbered by a late timer
    const fake2 = new FakeDaytona();
    fake2.autoCompleteMs = 10;
    const sb2 = await fake2.create();
    await sb2.process.createSession("p");
    const c2 = await sb2.process.executeSessionCommand("p", { command: "sleep 1", runAsync: true });
    fake2.completeCommand("p", c2.cmdId, 137);
    await new Promise((r) => setTimeout(r, 40));
    expect((await sb2.process.getSessionCommand("p", c2.cmdId)).exitCode).toBe(137);
  });
});

describe("FakeDaytona client", () => {
  it("records create params, lists by label, gets by id or name, deletes", async () => {
    const fake = new FakeDaytona();
    fake.queueSandboxId("box-a");
    const a = await fake.create({
      image: "node:22-bookworm",
      name: "machine-a",
      labels: { "oma-machine-id": "m1" },
      autoStopInterval: 30,
      autoDeleteInterval: -1,
      ephemeral: false,
    });
    const b = await fake.create({ snapshot: "oma-base", labels: { "oma-machine-id": "m2" } }, { timeout: 60 });
    expect(a.id).toBe("box-a");
    expect(a.state).toBe("started");
    expect(a.autoStopInterval).toBe(30);
    expect(a.autoDeleteInterval).toBe(-1);
    expect(fake.createCalls).toHaveLength(2);
    expect(fake.createCalls[0]).toEqual({
      image: "node:22-bookworm",
      name: "machine-a",
      labels: { "oma-machine-id": "m1" },
      autoStopInterval: 30,
      autoDeleteInterval: -1,
      ephemeral: false,
    });
    expect(fake.createOptions[1]).toEqual({ timeout: 60 });
    expect((await fake.list({ "oma-machine-id": "m2" })).items).toEqual([b]);
    expect((await fake.list()).items).toHaveLength(2);
    expect(await fake.get("box-a")).toBe(a);
    expect(await fake.get("machine-a")).toBe(a);
    await fake.delete(b);
    expect(b.state).toBe("destroyed");
    expect(fake.deleteCalls).toEqual([b.id]);
    expect((await fake.list()).items).toEqual([a]);
    await expect(fake.get(b.id)).rejects.toBeInstanceOf(DaytonaNotFoundError);
    await expect(fake.create({ name: "machine-a" })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("failNextCreate throws once and the queue drains in order", async () => {
    const fake = new FakeDaytona();
    fake.failNextCreate(new Error("quota exceeded"));
    await expect(fake.create({})).rejects.toThrow("quota exceeded");
    await expect(fake.create({})).resolves.toBeInstanceOf(FakeSandboxInstance);
    expect(fake.createCalls).toHaveLength(2);
  });

  it("vanish(): get() throws DaytonaNotFoundError; process/fs throw the prod gone message", async () => {
    const { fake, sb } = await box();
    fake.vanish(sb.id);
    expect(sb.state).toBe("destroyed");
    await expect(fake.get(sb.id)).rejects.toBeInstanceOf(DaytonaNotFoundError);
    await expect(fake.get(sb.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(run(sb, "echo hi")).rejects.toThrow(sandboxGoneMessage(sb.id));
    await expect(sb.fs.downloadFile("/workspace/x")).rejects.toThrow(`not found: sandbox ${sb.id} not found (it has been deleted)`);
    await expect(sb.process.createSession("x")).rejects.toThrow(/has been deleted/);
    expect((await fake.list()).items).toEqual([]);
    // the adapter's gone-detector recognises the fake's message verbatim
    const adapter = new DaytonaSandbox({ sessionId: "s", logger: silent }) as unknown as { isSandboxGone(e: unknown): boolean };
    const err = await run(sb, "true").catch((e: unknown) => e);
    expect(adapter.isSandboxGone(err)).toBe(true);
    expect(() => fake.vanish("nope")).toThrow(/unknown sandbox/);
  });

  it("lifecycle: stopped boxes reject toolbox calls until start(); archive needs stopped", async () => {
    const { sb } = await box();
    await sb.stop();
    expect(sb.state).toBe("stopped");
    await expect(run(sb, "true")).rejects.toMatchObject({ statusCode: 400 });
    await expect(sb.archive()).resolves.toBeUndefined();
    await expect(run(sb, "true")).rejects.toThrow(/has been archived/);
    await sb.start();
    expect(sb.state).toBe("started");
    expect((await run(sb, "true")).exitCode).toBe(0);
    await expect(sb.archive()).rejects.toMatchObject({ statusCode: 400 });
    await sb.refreshActivity();
    await sb.refreshActivity();
    expect(sb.activityRefreshes).toBe(2);
    await sb.setAutostopInterval(45);
    expect(sb.autoStopInterval).toBe(45);
    await expect(sb.setAutostopInterval(-5)).rejects.toMatchObject({ statusCode: 400 });
    await sb.setLabels({ "oma-machine-id": "m1", generation: "2" });
    expect(sb.labels).toEqual({ "oma-machine-id": "m1", generation: "2" });
    expect(await sb.getPreviewLink(9223)).toEqual({ url: `https://9223-${sb.id}.fake.daytona.app`, token: `tok-${sb.id}`, sandboxId: sb.id });
    const signed = await sb.getSignedPreviewUrl(9223, 120);
    expect(signed.url).toContain("DAYTONA_SANDBOX_AUTH_KEY=");
    expect(signed.port).toBe(9223);
  });

  it("strictState=false allows toolbox calls on a stopped box (opt-in leniency)", async () => {
    const { fake, sb } = await box();
    fake.strictState = false;
    await sb.stop();
    expect((await run(sb, "echo lenient")).artifacts.stdout).toBe("lenient\n");
  });

  it("fs: downloadFile of a missing path is a 404 DaytonaNotFoundError, not a gone error", async () => {
    const { sb } = await box();
    await sb.fs.createFolder("/workspace/dir", "0755");
    await sb.fs.uploadFile(Buffer.from("payload"), "/workspace/dir/f.bin");
    expect((await sb.fs.downloadFile("/workspace/dir/f.bin")).toString()).toBe("payload");
    const err = await sb.fs.downloadFile("/workspace/dir/missing").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DaytonaNotFoundError);
    expect(String((err as Error).message)).not.toMatch(/not found: sandbox|has been deleted/);
    expect(await sb.fs.listFiles("/workspace/dir")).toEqual([{ name: "f.bin", isDir: false, size: 7, modTime: expect.any(String) }]);
    await sb.fs.moveFiles("/workspace/dir/f.bin", "/workspace/dir/g.bin");
    expect(sb.isFile("/workspace/dir/g.bin")).toBe(true);
    await sb.fs.deleteFile("/workspace/dir", true);
    expect(sb.isDir("/workspace/dir")).toBe(false);
  });

  it("fakeDaytonaModule(): new Daytona(cfg) returns the fake and records the config", () => {
    const fake = new FakeDaytona();
    const mod = fakeDaytonaModule(fake);
    const client = new mod.Daytona({ apiKey: "k", apiUrl: "https://api.example" });
    expect(client).toBe(fake);
    expect(fake.clientConfigs).toEqual([{ apiKey: "k", apiUrl: "https://api.example" }]);
    expect(mod.DaytonaNotFoundError).toBe(DaytonaNotFoundError);
    expect(mod.DaytonaError).toBe(DaytonaError);
    expect(new mod.DaytonaNotFoundError("x").statusCode).toBe(404);
    expect(new mod.DaytonaNotFoundError("x")).toBeInstanceOf(Error);
    expect(new mod.DaytonaNotFoundError("x")).toBeInstanceOf(DaytonaError);
    expect(new mod.DaytonaNotFoundError("x").name).toBe("DaytonaNotFoundError");
  });

  it("execOutputMode='combined' reproduces the real SDK response shape (no artifacts.stderr)", async () => {
    const fake = new FakeDaytona();
    fake.execOutputMode = "combined";
    const sb = await fake.create();
    const r = await run(sb, "echo out; echo err >&2; exit 3");
    expect(r).toEqual({ exitCode: 3, result: "out\nerr\n", artifacts: { stdout: "out\nerr\n" } });
    expect("stderr" in r.artifacts).toBe(false);
    // execLog still keeps the streams apart for assertions
    expect(sb.execLog.at(-1)).toMatchObject({ stdout: "out\n", stderr: "err\n", exitCode: 3 });
  });
});

describe("DaytonaSandbox driven by the fake", () => {
  function adapterOn(sb: FakeSandboxInstance) {
    const a = new DaytonaSandbox({ sessionId: "sess-fake", logger: silent }) as unknown as {
      exec(command: string, timeout?: number): Promise<string>;
      readFile(path: string): Promise<string>;
      writeFile(path: string, content: string): Promise<string>;
      sandboxPromise: Promise<unknown> | null;
      ensureSandbox: () => Promise<unknown>;
    };
    a.sandboxPromise = Promise.resolve(sb);
    a.ensureSandbox = async () => a.sandboxPromise;
    return a;
  }

  it("exec / writeFile / readFile round-trip through the fake with the adapter's ulimit prefix", async () => {
    const { sb } = await box();
    const a = adapterOn(sb);
    expect(await a.exec("echo hi && pwd")).toBe("hi\n/workspace");
    expect(sb.execLog.at(-1)?.command).toMatch(/^ulimit -f \d+; echo hi && pwd$/);
    expect(sb.execLog.at(-1)?.cwd).toBe("/workspace");
    expect(sb.execLog.at(-1)?.env).toMatchObject({ OMA_SANDBOX_MAX_FILE_BYTES: expect.any(String) });
    expect(await a.exec("echo nope >&2; exit 4")).toBe("\nnope\n[exit 4]");
    expect(await a.writeFile("notes/a.txt", "content")).toBe("/workspace/notes/a.txt");
    expect(await a.readFile("/workspace/notes/a.txt")).toBe("content");
    expect(await a.exec("cat notes/a.txt")).toBe("content");
  });

  it("exec output is identical under the real-SDK 'combined' shape (adapter must not depend on artifacts.stderr)", async () => {
    const fake = new FakeDaytona();
    fake.execOutputMode = "combined";
    const sb = await fake.create();
    const a = adapterOn(sb);
    expect(await a.exec("echo hi && pwd")).toBe("hi\n/workspace");
    expect(await a.exec("echo nope >&2; exit 4")).toBe("nope\n[exit 4]");
  });
});
