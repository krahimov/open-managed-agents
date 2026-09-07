// In-memory fake of the @daytonaio/sdk surface the Daytona adapter and the
// agent-machine manager use. It exists so the sandbox package's tests can
// drive the real adapter code paths (create → bootstrap → exec → mount sync →
// process sessions → self-heal) without a Daytona account, deterministically
// and in milliseconds.
//
// Shape (structural, mirrors @daytonaio/sdk 0.171.0):
//   FakeDaytona          ≈ Daytona     (create / get / list / start / stop / delete)
//   FakeSandboxInstance  ≈ Sandbox     (state, labels, autoStop, start/stop/
//                                        refreshActivity, getPreviewLink, fs, process)
//   fakeDaytonaModule()  → { Daytona, DaytonaNotFoundError } — satisfies the
//                          adapter's dynamic-import seam (`daytonaModule`).
//
// `process.executeCommand` runs a tiny POSIX-sh interpreter over an in-memory
// filesystem. It understands the command shapes the adapter emits (mkdir -p,
// rm -rf, touch, test/[ ], cat, echo > file, find -type f -printf, chmod, ls,
// curl -sf http://127.0.0.1:9222/json/version, kill, sh -c, if/for/while,
// &&, ||, ;, redirections, $VAR, $(...)). Anything it does not know is recorded
// in `unhandledCommands` and succeeds with empty output — so an unexpected
// `apt-get install` never fails a test, but a test can still assert it ran.
//
// Realism notes worth knowing when writing adapter code against this fake:
//   • fs.downloadFile() of a MISSING FILE throws DaytonaNotFoundError(404),
//     exactly like the real SDK — so `instanceof DaytonaNotFoundError` alone
//     is NOT a "sandbox is gone" signal.
//   • process/fs calls on a destroyed box throw the plain-Error prod message
//     "not found: sandbox <id> not found (it has been deleted)" (the string
//     `DaytonaSandbox.isSandboxGone` matches); on an archived box they throw
//     "sandbox <id> has been archived"; on a stopped/created box they throw
//     "sandbox <id> is not started (state: …)" (statusCode 400). Set
//     `fake.strictState = false` to allow toolbox calls in any live state.
//   • `create()` returns a `started` box (like the real API).
//   • executeCommand output: the REAL SDK returns `{ exitCode, result,
//     artifacts: { stdout: result } }` — there is no `artifacts.stderr`
//     (ExecutionArtifacts is `{ stdout; charts? }`) and the toolbox's `result`
//     is the command's combined output. By default the fake keeps stdout and
//     stderr apart (`artifacts.stderr`) so tests can assert on each stream;
//     set `fake.execOutputMode = "combined"` to get the real SDK shape
//     (stderr appended to stdout, no `stderr` key). Plan §13 verifies the
//     live behaviour; production code must not rely on `artifacts.stderr`.
//   • `sleep` returns immediately (polling loops run in zero time).

import { createHash } from "node:crypto";

// ─── Errors ─────────────────────────────────────────────────────────────────

/** Mirrors @daytonaio/sdk's DaytonaError base (statusCode / errorCode). */
export class DaytonaError extends Error {
  statusCode?: number;
  errorCode?: string;
  constructor(message: string, statusCode?: number, errorCode?: string) {
    super(message);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.errorCode = errorCode;
  }
}

/** Mirrors @daytonaio/sdk's DaytonaNotFoundError (HTTP 404). */
export class DaytonaNotFoundError extends DaytonaError {
  statusCode = 404;
  constructor(message: string, errorCode?: string) {
    super(message, 404, errorCode);
  }
}

/** Generic non-404 API failure (409 duplicate session, 400 bad state, …). */
export class FakeDaytonaHttpError extends DaytonaError {
  constructor(message: string, statusCode: number) {
    super(message, statusCode);
  }
}

export function sandboxGoneMessage(id: string): string {
  return `not found: sandbox ${id} not found (it has been deleted)`;
}

// ─── Types ──────────────────────────────────────────────────────────────────

export type FakeSandboxState = "created" | "started" | "stopped" | "archived" | "destroyed";

export interface FakeCreateParams {
  image?: string;
  snapshot?: string;
  name?: string;
  labels?: Record<string, string>;
  envVars?: Record<string, string>;
  ephemeral?: boolean;
  autoStopInterval?: number;
  autoDeleteInterval?: number;
  autoArchiveInterval?: number;
  resources?: unknown;
  public?: boolean;
  [key: string]: unknown;
}

export interface FakeExecuteResponse {
  exitCode: number;
  /** Mirrors the SDK doc ("artifacts.stdout — same as result"). */
  result: string;
  /** `stderr` is only present in the default "separate" execOutputMode; the
   *  real SDK never sets it (see header note). */
  artifacts: { stdout: string; stderr?: string };
}

/** How `process.executeCommand` reports output — see the header note. */
export type FakeExecOutputMode = "separate" | "combined";

export interface FakeExecRecord {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface FakeSessionCommand {
  id: string;
  command: string;
  /** undefined while running (what the real API returns for async commands). */
  exitCode?: number;
  stdout: string;
  stderr: string;
  runAsync: boolean;
  startedAt: number;
  completedAt?: number;
}

export interface FakeSession {
  sessionId: string;
  commands: FakeSessionCommand[];
  cwd: string;
  env: Record<string, string>;
}

export interface FakeHttpResponse {
  status: number;
  body: string;
  headers?: Record<string, string>;
}
export type FakeHttpResponder = FakeHttpResponse | string | (() => FakeHttpResponse | string);

export interface ShellCommandContext {
  name: string;
  args: string[];
  stdin: string;
  cwd: string;
  env: Record<string, string>;
  sandbox: FakeSandboxInstance;
  /** Run a nested shell command line inside the same sandbox. */
  runShell: (script: string) => Promise<ShellResult>;
}
export interface ShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
export type FakeCommandHandler = (
  ctx: ShellCommandContext,
) => Promise<Partial<ShellResult> & { exitCode: number }> | (Partial<ShellResult> & { exitCode: number });

export interface FakeKillRecord {
  signal: string;
  targets: string[];
}
export interface FakeModeChange {
  path: string;
  mode: string;
  recursive: boolean;
}

export const CDP_VERSION_URL = "http://127.0.0.1:9222/json/version";

// ─── FakeSandboxInstance ────────────────────────────────────────────────────

let instanceCounter = 0;

export class FakeSandboxInstance {
  id: string;
  name: string;
  state: FakeSandboxState;
  labels: Record<string, string>;
  autoStopInterval: number;
  autoDeleteInterval: number;
  autoArchiveInterval: number;
  activityRefreshes = 0;
  /** Frozen copy of the params `create()` was called with (assertions). */
  readonly createParams: FakeCreateParams;
  errorReason?: string;
  lastActivityAt: number;
  createdAt: number;

  /** In-memory filesystem: absolute path → bytes. Directories are implicit
   *  (any prefix of a file) plus whatever `dirs` holds explicitly. */
  readonly files = new Map<string, Buffer>();
  readonly dirs = new Set<string>(["/", "/tmp", "/workspace", "/etc", "/etc/ssl", "/mnt", "/var", "/var/lib", "/root", "/home", "/usr", "/usr/bin", "/dev", "/proc"]);
  readonly mtimes = new Map<string, number>();

  /** Every executeCommand call, in order, with its outcome. */
  readonly execLog: FakeExecRecord[] = [];
  /** Simple commands the interpreter did not recognise (they still succeed). */
  readonly unhandledCommands: Array<{ name: string; args: string[]; line: string }> = [];
  readonly kills: FakeKillRecord[] = [];
  readonly modeChanges: FakeModeChange[] = [];
  readonly sessions = new Map<string, FakeSession>();
  /** Per-URL canned HTTP responses served to in-box `curl`/`wget`. */
  readonly httpResponses = new Map<string, FakeHttpResponder>();
  /** Every in-box curl/wget call, in order (also the refused ones). */
  readonly httpRequests: Array<{ url: string; method: string; headers: string[]; body?: string }> = [];
  /** Test seam: override or add commands (`node`, `chromium`, `apt-get`, …). */
  readonly commandHandlers = new Map<string, FakeCommandHandler>();
  /** `command -v X` / `which X` fail for names listed here. */
  readonly missingCommands = new Set<string>();
  /** Exit code the in-box `kill` builtin returns (default 0). */
  killExitCode = 0;
  /** Exit code unknown commands return (default 0 = succeed). */
  unknownCommandExitCode = 0;

  private owner: FakeDaytona | null;
  private commandCounter = 0;
  private timers = new Set<ReturnType<typeof setTimeout>>();

  readonly fs: {
    uploadFile(file: Buffer | string, remotePath: string, timeout?: number): Promise<void>;
    downloadFile(remotePath: string, timeout?: number): Promise<Buffer>;
    createFolder(path: string, mode: string): Promise<void>;
    deleteFile(path: string, recursive?: boolean): Promise<void>;
    listFiles(path: string): Promise<Array<{ name: string; isDir: boolean; size: number; modTime: string }>>;
    moveFiles(source: string, destination: string): Promise<void>;
  };

  readonly process: {
    executeCommand(command: string, cwd?: string, env?: Record<string, string>, timeout?: number): Promise<FakeExecuteResponse>;
    createSession(sessionId: string): Promise<void>;
    getSession(sessionId: string): Promise<{ sessionId: string; commands: Array<{ id: string; command: string; exitCode?: number }> }>;
    executeSessionCommand(
      sessionId: string,
      req: { command: string; runAsync?: boolean; async?: boolean; suppressInputEcho?: boolean },
      timeout?: number,
    ): Promise<{ cmdId: string; exitCode?: number; stdout?: string; stderr?: string; output?: string }>;
    getSessionCommand(sessionId: string, commandId: string): Promise<{ id: string; command: string; exitCode?: number }>;
    getSessionCommandLogs(sessionId: string, commandId: string): Promise<{ stdout: string; stderr: string; output: string }>;
    listSessions(): Promise<Array<{ sessionId: string; commands: Array<{ id: string; command: string; exitCode?: number }> }>>;
    deleteSession(sessionId: string): Promise<void>;
  };

  constructor(opts: {
    id?: string;
    name?: string;
    state?: FakeSandboxState;
    labels?: Record<string, string>;
    createParams?: FakeCreateParams;
    owner?: FakeDaytona;
    now?: number;
  } = {}) {
    instanceCounter += 1;
    const params = opts.createParams ?? {};
    this.id = opts.id ?? `sb-${String(instanceCounter).padStart(4, "0")}-${randomHex(8)}`;
    this.name = opts.name ?? params.name ?? this.id;
    this.state = opts.state ?? "started";
    this.labels = { ...(opts.labels ?? params.labels ?? {}) };
    this.autoStopInterval = params.autoStopInterval ?? 15;
    this.autoDeleteInterval = params.autoDeleteInterval ?? -1;
    this.autoArchiveInterval = params.autoArchiveInterval ?? 7 * 24 * 60;
    this.createParams = JSON.parse(JSON.stringify(params)) as FakeCreateParams;
    this.owner = opts.owner ?? null;
    this.createdAt = opts.now ?? Date.now();
    this.lastActivityAt = this.createdAt;

    const self = this;
    this.fs = {
      async uploadFile(file, remotePath) {
        self.assertToolboxReachable();
        if (typeof file === "string") {
          throw new Error("FakeSandboxInstance.fs.uploadFile: local-path uploads are not supported by the fake; pass a Buffer");
        }
        self.writeFileAt(self.resolve(remotePath, "/"), Buffer.from(file));
      },
      async downloadFile(remotePath) {
        self.assertToolboxReachable();
        const p = self.resolve(remotePath, "/");
        const buf = self.files.get(p);
        if (!buf) throw new DaytonaNotFoundError(`open ${p}: no such file or directory`);
        return Buffer.from(buf);
      },
      async createFolder(path) {
        self.assertToolboxReachable();
        self.mkdirp(self.resolve(path, "/"));
      },
      async deleteFile(path, recursive) {
        self.assertToolboxReachable();
        const p = self.resolve(path, "/");
        if (!self.exists(p)) throw new DaytonaNotFoundError(`remove ${p}: no such file or directory`);
        if (self.isDir(p) && !recursive && self.listDir(p).length > 0) {
          throw new FakeDaytonaHttpError(`remove ${p}: directory not empty`, 400);
        }
        self.removeTree(p);
      },
      async listFiles(path) {
        self.assertToolboxReachable();
        const p = self.resolve(path, "/");
        if (!self.isDir(p)) throw new DaytonaNotFoundError(`open ${p}: no such file or directory`);
        return self.listDir(p).map((name) => {
          const full = joinPath(p, name);
          const isDir = self.isDir(full);
          return {
            name,
            isDir,
            size: isDir ? 4096 : (self.files.get(full)?.byteLength ?? 0),
            modTime: new Date(self.mtimes.get(full) ?? self.createdAt).toISOString(),
          };
        });
      },
      async moveFiles(source, destination) {
        self.assertToolboxReachable();
        const src = self.resolve(source, "/");
        const dst = self.resolve(destination, "/");
        if (!self.exists(src)) throw new DaytonaNotFoundError(`rename ${src}: no such file or directory`);
        self.moveTree(src, dst);
      },
    };

    this.process = {
      async executeCommand(command, cwd, env, timeout) {
        self.assertToolboxReachable();
        self.touchActivity();
        const r = await runShellScript(self, command, {
          cwd: cwd ? self.resolve(cwd, "/") : "/workspace",
          env: { ...(env ?? {}) },
        });
        self.execLog.push({ command, cwd, env, timeout, exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr });
        if (self.owner?.execOutputMode === "combined") {
          // Real SDK shape: one combined stream, `artifacts.stdout === result`, no `stderr` key.
          const combined = r.stdout + r.stderr;
          return { exitCode: r.exitCode, result: combined, artifacts: { stdout: combined } };
        }
        return { exitCode: r.exitCode, result: r.stdout, artifacts: { stdout: r.stdout, stderr: r.stderr } };
      },
      async createSession(sessionId) {
        self.assertToolboxReachable();
        if (self.sessions.has(sessionId)) {
          throw new FakeDaytonaHttpError(`session ${sessionId} already exists`, 409);
        }
        self.sessions.set(sessionId, { sessionId, commands: [], cwd: "/workspace", env: {} });
      },
      async getSession(sessionId) {
        self.assertToolboxReachable();
        const s = self.requireSession(sessionId);
        return { sessionId: s.sessionId, commands: s.commands.map(publicCommand) };
      },
      async executeSessionCommand(sessionId, req) {
        self.assertToolboxReachable();
        self.touchActivity();
        const session = self.requireSession(sessionId);
        self.commandCounter += 1;
        const cmd: FakeSessionCommand = {
          id: `cmd-${self.commandCounter}`,
          command: req.command,
          stdout: "",
          stderr: "",
          runAsync: !!(req.runAsync || req.async),
          startedAt: self.now(),
        };
        session.commands.push(cmd);
        if (self.owner?.onSessionCommand) {
          await self.owner.onSessionCommand({ sandbox: self, sessionId, command: cmd });
        }
        if (cmd.runAsync) {
          const auto = self.owner?.autoCompleteMs;
          if (typeof auto === "number" && auto >= 0) {
            const t = setTimeout(() => {
              self.timers.delete(t);
              // Do not look the command up again: the session may have been
              // deleted (kill → deleteSession) before the timer fired, and a
              // throw here would surface as an unhandled error in the test run.
              if (cmd.exitCode === undefined) {
                cmd.exitCode = 0;
                cmd.completedAt = self.now();
              }
            }, auto);
            (t as { unref?: () => void }).unref?.();
            self.timers.add(t);
          }
          return { cmdId: cmd.id };
        }
        const r = await runShellScript(self, req.command, { cwd: session.cwd, env: session.env, session });
        cmd.exitCode = r.exitCode;
        cmd.stdout = r.stdout;
        cmd.stderr = r.stderr;
        cmd.completedAt = self.now();
        return { cmdId: cmd.id, exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, output: r.stdout + r.stderr };
      },
      async getSessionCommand(sessionId, commandId) {
        self.assertToolboxReachable();
        return publicCommand(self.requireCommand(sessionId, commandId));
      },
      async getSessionCommandLogs(sessionId, commandId) {
        self.assertToolboxReachable();
        const c = self.requireCommand(sessionId, commandId);
        return { stdout: c.stdout, stderr: c.stderr, output: c.stdout + c.stderr };
      },
      async listSessions() {
        self.assertToolboxReachable();
        return [...self.sessions.values()].map((s) => ({
          sessionId: s.sessionId,
          commands: s.commands.map(publicCommand),
        }));
      },
      async deleteSession(sessionId) {
        self.assertToolboxReachable();
        self.requireSession(sessionId);
        self.sessions.delete(sessionId);
      },
    };
  }

  // ── Sandbox lifecycle (SDK surface) ──────────────────────────────────────

  async start(_timeout?: number): Promise<void> {
    this.assertNotDestroyed();
    this.state = "started";
    this.touchActivity();
  }

  async stop(_timeout?: number, _force?: boolean): Promise<void> {
    this.assertNotDestroyed();
    if (this.state === "archived") {
      throw new FakeDaytonaHttpError(`sandbox ${this.id} is archived; cannot stop`, 400);
    }
    this.state = "stopped";
  }

  async archive(): Promise<void> {
    this.assertNotDestroyed();
    if (this.state !== "stopped") {
      throw new FakeDaytonaHttpError(`sandbox ${this.id} must be stopped before archiving (state: ${this.state})`, 400);
    }
    this.state = "archived";
  }

  async recover(_timeout?: number): Promise<void> {
    this.assertNotDestroyed();
    this.errorReason = undefined;
    this.state = "started";
  }

  async delete(_timeout?: number): Promise<void> {
    this.assertNotDestroyed();
    if (this.owner) await this.owner.delete(this);
    else this.markDestroyed();
  }

  async refreshData(): Promise<void> {
    if (this.state === "destroyed") throw new DaytonaNotFoundError(`Sandbox with ID ${this.id} not found`);
  }

  async refreshActivity(): Promise<void> {
    this.assertNotDestroyed();
    this.activityRefreshes += 1;
    this.touchActivity();
  }

  async setAutostopInterval(interval: number): Promise<void> {
    this.assertNotDestroyed();
    if (!Number.isInteger(interval) || interval < 0) {
      throw new FakeDaytonaHttpError("autoStopInterval must be a non-negative integer", 400);
    }
    this.autoStopInterval = interval;
  }

  async setAutoArchiveInterval(interval: number): Promise<void> {
    this.assertNotDestroyed();
    this.autoArchiveInterval = interval;
  }

  async setAutoDeleteInterval(interval: number): Promise<void> {
    this.assertNotDestroyed();
    this.autoDeleteInterval = interval;
  }

  async setLabels(labels: Record<string, string>): Promise<Record<string, string>> {
    this.assertNotDestroyed();
    this.labels = { ...labels };
    return { ...this.labels };
  }

  async getPreviewLink(port: number): Promise<{ url: string; token: string; sandboxId: string }> {
    this.assertNotDestroyed();
    return { url: `https://${port}-${this.id}.fake.daytona.app`, token: `tok-${this.id}`, sandboxId: this.id };
  }

  async getSignedPreviewUrl(
    port: number,
    expiresInSeconds = 60,
  ): Promise<{ url: string; token: string; port: number; sandboxId: string }> {
    this.assertNotDestroyed();
    const token = `signed-${this.id}-${port}-${expiresInSeconds}`;
    return {
      url: `https://${port}-${this.id}.fake.daytona.app?DAYTONA_SANDBOX_AUTH_KEY=${token}`,
      token,
      port,
      sandboxId: this.id,
    };
  }

  async waitUntilStarted(): Promise<void> {
    this.assertNotDestroyed();
    if (this.state !== "started") throw new FakeDaytonaHttpError(`sandbox ${this.id} is ${this.state}`, 400);
  }

  async waitUntilStopped(): Promise<void> {
    this.assertNotDestroyed();
    if (this.state !== "stopped") throw new FakeDaytonaHttpError(`sandbox ${this.id} is ${this.state}`, 400);
  }

  // ── Test helpers ─────────────────────────────────────────────────────────

  /** Serve `{ webSocketDebuggerUrl, ... }` from in-box curl of :9222/json/version. */
  setCdpVersion(version: Record<string, unknown> | null): void {
    const urls = [CDP_VERSION_URL, "http://localhost:9222/json/version"];
    for (const u of urls) {
      if (version) this.httpResponses.set(u, { status: 200, body: JSON.stringify(version) });
      else this.httpResponses.delete(u);
    }
  }

  completeCommand(sessionId: string, cmdId: string, exitCode: number, stdout = "", stderr = ""): void {
    const c = this.requireCommand(sessionId, cmdId);
    c.stdout += stdout;
    c.stderr += stderr;
    c.exitCode = exitCode;
    c.completedAt = this.now();
  }

  appendCommandOutput(sessionId: string, cmdId: string, stdout = "", stderr = ""): void {
    const c = this.requireCommand(sessionId, cmdId);
    c.stdout += stdout;
    c.stderr += stderr;
  }

  findCommand(sessionId: string, cmdId: string): FakeSessionCommand | null {
    return this.sessions.get(sessionId)?.commands.find((c) => c.id === cmdId) ?? null;
  }

  /** Text of an in-box file (utf8) or null. */
  readText(path: string): string | null {
    const buf = this.files.get(this.resolve(path, "/"));
    return buf ? buf.toString("utf8") : null;
  }

  writeText(path: string, text: string): void {
    this.writeFileAt(this.resolve(path, "/"), Buffer.from(text, "utf8"));
  }

  markDestroyed(): void {
    this.state = "destroyed";
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  now(): number {
    return this.owner ? this.owner.now() : Date.now();
  }

  // ── Filesystem model (used by fs API and the shell) ──────────────────────

  resolve(p: string, cwd: string): string {
    const abs = p.startsWith("/") ? p : `${cwd.replace(/\/+$/, "")}/${p}`;
    return normalizePath(abs);
  }

  exists(p: string): boolean {
    return this.files.has(p) || this.isDir(p);
  }

  isFile(p: string): boolean {
    return this.files.has(p);
  }

  isDir(p: string): boolean {
    if (p === "/") return true;
    if (this.dirs.has(p)) return true;
    const prefix = `${p}/`;
    for (const f of this.files.keys()) if (f.startsWith(prefix)) return true;
    for (const d of this.dirs) if (d.startsWith(prefix)) return true;
    return false;
  }

  listDir(p: string): string[] {
    const prefix = p === "/" ? "/" : `${p}/`;
    const names = new Set<string>();
    const add = (path: string) => {
      if (!path.startsWith(prefix) || path === p) return;
      const rest = path.slice(prefix.length);
      const head = rest.split("/")[0];
      if (head) names.add(head);
    };
    for (const f of this.files.keys()) add(f);
    for (const d of this.dirs) add(d);
    return [...names].sort();
  }

  /** All entries under `root` (exclusive) as { path, isDir, depth }. */
  walk(root: string): Array<{ path: string; isDir: boolean; depth: number }> {
    const prefix = root === "/" ? "/" : `${root}/`;
    const seen = new Map<string, boolean>();
    const addWithParents = (path: string, isDir: boolean) => {
      if (!path.startsWith(prefix)) return;
      seen.set(path, isDir);
      let parent = parentPath(path);
      while (parent.startsWith(prefix) && parent !== root) {
        if (!seen.has(parent)) seen.set(parent, true);
        parent = parentPath(parent);
      }
    };
    for (const f of this.files.keys()) addWithParents(f, false);
    for (const d of this.dirs) if (d !== root) addWithParents(d, true);
    const rootDepth = root === "/" ? 0 : root.split("/").length - 1;
    return [...seen.entries()]
      .map(([path, isDir]) => ({ path, isDir, depth: path.split("/").length - 1 - rootDepth }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  mkdirp(p: string): void {
    if (this.files.has(p)) throw new FakeDaytonaHttpError(`mkdir ${p}: not a directory`, 400);
    this.dirs.add(p);
    this.mtimes.set(p, this.now());
  }

  writeFileAt(p: string, data: Buffer): void {
    if (this.isDir(p)) throw new FakeDaytonaHttpError(`open ${p}: is a directory`, 400);
    this.files.set(p, data);
    this.mtimes.set(p, this.now());
  }

  removeTree(p: string): void {
    const prefix = `${p}/`;
    for (const f of [...this.files.keys()]) if (f === p || f.startsWith(prefix)) { this.files.delete(f); this.mtimes.delete(f); }
    for (const d of [...this.dirs]) if (d === p || d.startsWith(prefix)) { this.dirs.delete(d); this.mtimes.delete(d); }
  }

  moveTree(src: string, dst: string): void {
    const target = this.isDir(dst) ? joinPath(dst, baseName(src)) : dst;
    if (this.isFile(src)) {
      const data = this.files.get(src)!;
      const mtime = this.mtimes.get(src);
      this.files.delete(src);
      this.mtimes.delete(src);
      this.files.set(target, data);
      this.mtimes.set(target, mtime ?? this.now());
      return;
    }
    const prefix = `${src}/`;
    const moves: Array<[string, string]> = [];
    for (const f of this.files.keys()) if (f.startsWith(prefix)) moves.push([f, target + f.slice(src.length)]);
    for (const [from, to] of moves) {
      const data = this.files.get(from)!;
      const mtime = this.mtimes.get(from);
      this.files.delete(from);
      this.mtimes.delete(from);
      this.files.set(to, data);
      if (mtime !== undefined) this.mtimes.set(to, mtime);
    }
    for (const d of [...this.dirs]) {
      if (d === src || d.startsWith(prefix)) {
        this.dirs.delete(d);
        this.dirs.add(target + d.slice(src.length));
      }
    }
    this.dirs.add(target);
  }

  copyTree(src: string, dst: string): void {
    if (this.isFile(src)) {
      const target = this.isDir(dst) ? joinPath(dst, baseName(src)) : dst;
      this.writeFileAt(target, Buffer.from(this.files.get(src)!));
      return;
    }
    const target = this.isDir(dst) ? joinPath(dst, baseName(src)) : dst;
    this.mkdirp(target);
    const prefix = `${src}/`;
    for (const [f, data] of [...this.files.entries()]) {
      if (f.startsWith(prefix)) this.writeFileAt(target + f.slice(src.length), Buffer.from(data));
    }
    for (const d of [...this.dirs]) if (d.startsWith(prefix)) this.dirs.add(target + d.slice(src.length));
  }

  // ── internals ────────────────────────────────────────────────────────────

  private touchActivity(): void {
    this.lastActivityAt = this.now();
  }

  private assertNotDestroyed(): void {
    if (this.state === "destroyed") throw new DaytonaNotFoundError(`Sandbox with ID ${this.id} not found`);
  }

  /** Toolbox (process/fs) reachability, mirroring what the proxy returns. */
  private assertToolboxReachable(): void {
    if (this.state === "destroyed") throw new Error(sandboxGoneMessage(this.id));
    if (this.owner && !this.owner.strictState) return;
    if (this.state === "archived") throw new FakeDaytonaHttpError(`sandbox ${this.id} has been archived`, 400);
    if (this.state !== "started") {
      throw new FakeDaytonaHttpError(`sandbox ${this.id} is not started (state: ${this.state})`, 400);
    }
  }

  private requireSession(sessionId: string): FakeSession {
    const s = this.sessions.get(sessionId);
    if (!s) throw new DaytonaNotFoundError(`session ${sessionId} not found`);
    return s;
  }

  private requireCommand(sessionId: string, cmdId: string): FakeSessionCommand {
    const c = this.requireSession(sessionId).commands.find((x) => x.id === cmdId);
    if (!c) throw new DaytonaNotFoundError(`command ${cmdId} not found in session ${sessionId}`);
    return c;
  }
}

function publicCommand(c: FakeSessionCommand): { id: string; command: string; exitCode?: number } {
  return c.exitCode === undefined
    ? { id: c.id, command: c.command }
    : { id: c.id, command: c.command, exitCode: c.exitCode };
}

// ─── FakeDaytona (client) ───────────────────────────────────────────────────

export class FakeDaytona {
  readonly sandboxes = new Map<string, FakeSandboxInstance>();
  readonly createCalls: unknown[] = [];
  readonly createOptions: unknown[] = [];
  readonly clientConfigs: unknown[] = [];
  readonly deleteCalls: string[] = [];
  /** When set, runAsync session commands auto-complete (exit 0) after this many ms. */
  autoCompleteMs: number | null = null;
  /** Enforce that toolbox calls need a `started` box (default true). */
  strictState = true;
  /** "separate" (default): `artifacts.stderr` carries stderr. "combined":
   *  the real SDK shape — stderr appended to stdout/result, no `stderr` key. */
  execOutputMode: FakeExecOutputMode = "separate";
  /** Injectable clock (ms epoch) for mtimes / timestamps. */
  now: () => number = () => Date.now();
  /** Hook fired for every session command start (simulate side effects such
   *  as writing a pidfile for the adapter's process wrapper). */
  onSessionCommand?: (ctx: { sandbox: FakeSandboxInstance; sessionId: string; command: FakeSessionCommand }) => void | Promise<void>;
  /** Optional hook to seed every newly created box (bootstrap markers, …). */
  onCreate?: (sandbox: FakeSandboxInstance) => void | Promise<void>;

  private pendingCreateFailures: unknown[] = [];
  private pendingIds: string[] = [];

  failNextCreate(err: unknown): void {
    this.pendingCreateFailures.push(err);
  }

  /** Force the id of the next created sandbox (FIFO when called repeatedly). */
  queueSandboxId(id: string): void {
    this.pendingIds.push(id);
  }

  async create(params: FakeCreateParams = {}, options?: unknown): Promise<FakeSandboxInstance> {
    this.createCalls.push(JSON.parse(JSON.stringify(params ?? {})));
    this.createOptions.push(options);
    if (this.pendingCreateFailures.length > 0) {
      const err = this.pendingCreateFailures.shift();
      throw err instanceof Error ? err : new Error(String(err));
    }
    if (params.name && [...this.sandboxes.values()].some((s) => s.state !== "destroyed" && s.name === params.name)) {
      throw new FakeDaytonaHttpError(`sandbox with name ${params.name} already exists`, 409);
    }
    const sb = new FakeSandboxInstance({
      id: this.pendingIds.shift(),
      createParams: params,
      owner: this,
      now: this.now(),
    });
    this.sandboxes.set(sb.id, sb);
    if (this.onCreate) await this.onCreate(sb);
    return sb;
  }

  async get(sandboxIdOrName: string): Promise<FakeSandboxInstance> {
    const byId = this.sandboxes.get(sandboxIdOrName);
    if (byId && byId.state !== "destroyed") return byId;
    for (const sb of this.sandboxes.values()) {
      if (sb.state !== "destroyed" && sb.name === sandboxIdOrName) return sb;
    }
    throw new DaytonaNotFoundError(`Sandbox with ID ${sandboxIdOrName} not found`);
  }

  async list(
    labels?: Record<string, string>,
    page = 1,
    limit = 100,
  ): Promise<{ items: FakeSandboxInstance[]; total: number; page: number; totalPages: number }> {
    const all = [...this.sandboxes.values()].filter((sb) => {
      if (sb.state === "destroyed") return false;
      if (!labels) return true;
      return Object.entries(labels).every(([k, v]) => sb.labels[k] === v);
    });
    const start = (page - 1) * limit;
    return {
      items: all.slice(start, start + limit),
      total: all.length,
      page,
      totalPages: Math.max(1, Math.ceil(all.length / limit)),
    };
  }

  async start(sandbox: FakeSandboxInstance, timeout?: number): Promise<void> {
    await this.live(sandbox).start(timeout);
  }

  async stop(sandbox: FakeSandboxInstance, timeout?: number): Promise<void> {
    await this.live(sandbox).stop(timeout);
  }

  async delete(sandbox: FakeSandboxInstance, _timeout?: number): Promise<void> {
    const sb = this.live(sandbox);
    this.deleteCalls.push(sb.id);
    sb.markDestroyed();
  }

  /** Simulate Daytona deleting the box server-side (idle sweep, org quota…):
   *  get()/list() no longer see it, process/fs calls throw the prod message. */
  vanish(id: string): void {
    const sb = this.sandboxes.get(id);
    if (!sb) throw new Error(`FakeDaytona.vanish: unknown sandbox ${id}`);
    sb.markDestroyed();
  }

  completeCommand(sessionId: string, cmdId: string, exitCode: number, stdout = "", stderr = ""): void {
    this.requireSessionOwner(sessionId).completeCommand(sessionId, cmdId, exitCode, stdout, stderr);
  }

  appendCommandOutput(sessionId: string, cmdId: string, stdout = "", stderr = ""): void {
    this.requireSessionOwner(sessionId).appendCommandOutput(sessionId, cmdId, stdout, stderr);
  }

  findSession(sessionId: string): { sandbox: FakeSandboxInstance; session: FakeSession } | null {
    for (const sb of this.sandboxes.values()) {
      const session = sb.sessions.get(sessionId);
      if (session) return { sandbox: sb, session };
    }
    return null;
  }

  private requireSessionOwner(sessionId: string): FakeSandboxInstance {
    const hit = this.findSession(sessionId);
    if (!hit) throw new Error(`FakeDaytona: no sandbox has a process session ${sessionId}`);
    return hit.sandbox;
  }

  private live(sandbox: FakeSandboxInstance): FakeSandboxInstance {
    const sb = this.sandboxes.get(sandbox.id);
    if (!sb || sb.state === "destroyed") throw new DaytonaNotFoundError(`Sandbox with ID ${sandbox.id} not found`);
    return sb;
  }
}

// ─── Module seam ────────────────────────────────────────────────────────────

/**
 * Build the object the adapter expects from `await import("@daytonaio/sdk")`.
 * `new Daytona(cfg)` returns the shared fake (constructor return-override) and
 * records `cfg` on `fake.clientConfigs` so tests can assert apiKey/apiUrl.
 */
export function fakeDaytonaModule(fake: FakeDaytona): {
  Daytona: new (config: { apiKey?: string; apiUrl?: string; [k: string]: unknown }) => FakeDaytona;
  DaytonaError: typeof DaytonaError;
  DaytonaNotFoundError: typeof DaytonaNotFoundError;
} {
  const Daytona = class FakeDaytonaCtor {
    constructor(config: { apiKey?: string; apiUrl?: string; [k: string]: unknown }) {
      fake.clientConfigs.push(config);
      return fake as unknown as FakeDaytonaCtor;
    }
  } as unknown as new (config: { apiKey?: string; apiUrl?: string; [k: string]: unknown }) => FakeDaytona;
  return { Daytona, DaytonaError, DaytonaNotFoundError };
}

// ─── Path helpers ───────────────────────────────────────────────────────────

export function normalizePath(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") { parts.pop(); continue; }
    parts.push(seg);
  }
  return `/${parts.join("/")}`;
}

function joinPath(dir: string, name: string): string {
  return dir === "/" ? `/${name}` : `${dir}/${name}`;
}

function parentPath(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

function baseName(p: string): string {
  if (p === "/") return "/";
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}

function randomHex(n: number): string {
  let out = "";
  while (out.length < n) out += Math.floor(Math.random() * 16).toString(16);
  return out.slice(0, n);
}

// ═══════════════════════════════════════════════════════════════════════════
// Tiny POSIX-sh interpreter (module-private). Enough of the language to run
// the scripts the adapter builds; not a shell.
// ═══════════════════════════════════════════════════════════════════════════

// ─── Tokenizer ──────────────────────────────────────────────────────────────

type WordPart =
  | { kind: "lit"; text: string; quoted: boolean }
  | { kind: "var"; name: string; op?: ":-" | "-" | ":+" | ":=" | "#"; word?: string; quoted: boolean }
  | { kind: "subst"; script: string; quoted: boolean }
  | { kind: "arith"; expr: string; quoted: boolean };

interface WordTok { kind: "word"; parts: WordPart[]; plain: boolean; raw: string }
interface OpTok { kind: "op"; value: string }
interface RedirTok {
  kind: "redir";
  fd: number;
  op: ">" | ">>" | "<" | ">&" | "&>" | "<<";
  dupFd?: number;
  heredoc?: { body: string; expand: boolean };
}
type Tok = WordTok | OpTok | RedirTok;

class ShellSyntaxError extends Error {}

const WORD_BREAK = new Set([" ", "\t", "\r", "\n", ";", "&", "|", "(", ")", "<", ">"]);

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  const pending: Array<{ tok: RedirTok; delim: string; stripTabs: boolean }> = [];
  let i = 0;
  const n = src.length;

  const lastIsOpOrStart = () => toks.length === 0 || toks[toks.length - 1].kind === "op";

  while (i < n) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\r") { i++; continue; }
    if (c === "\\" && src[i + 1] === "\n") { i += 2; continue; }
    if (c === "#" && lastIsOpOrStart()) { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "\n") {
      toks.push({ kind: "op", value: "\n" });
      i++;
      if (pending.length > 0) {
        for (const h of pending) {
          const lines: string[] = [];
          for (;;) {
            if (i >= n) break;
            let eol = src.indexOf("\n", i);
            if (eol < 0) eol = n;
            const rawLine = src.slice(i, eol);
            i = eol + 1;
            const line = h.stripTabs ? rawLine.replace(/^\t+/, "") : rawLine;
            if (line === h.delim) break;
            lines.push(line);
          }
          h.tok.heredoc = { body: lines.length ? `${lines.join("\n")}\n` : "", expand: h.tok.heredoc?.expand ?? true };
        }
        pending.length = 0;
        if (i > n) i = n;
      }
      continue;
    }
    if (c === ";") {
      if (src[i + 1] === ";") { toks.push({ kind: "op", value: ";;" }); i += 2; } else { toks.push({ kind: "op", value: ";" }); i++; }
      continue;
    }
    if (c === "&") {
      if (src[i + 1] === "&") { toks.push({ kind: "op", value: "&&" }); i += 2; continue; }
      if (src[i + 1] === ">") {
        i += 2;
        if (src[i] === ">") i++;
        toks.push({ kind: "redir", fd: 1, op: "&>" });
        continue;
      }
      toks.push({ kind: "op", value: "&" }); i++; continue;
    }
    if (c === "|") {
      if (src[i + 1] === "|") { toks.push({ kind: "op", value: "||" }); i += 2; } else { toks.push({ kind: "op", value: "|" }); i++; }
      continue;
    }
    if (c === "(" || c === ")") { toks.push({ kind: "op", value: c }); i++; continue; }

    // Redirections, optionally prefixed by a single fd digit: 2>/dev/null, 2>&1, >file, >>file, <file, <<EOF
    let fd: number | null = null;
    let j = i;
    if (/[0-9]/.test(c) && (src[i + 1] === ">" || src[i + 1] === "<")) { fd = Number(c); j = i + 1; }
    if (src[j] === ">" || src[j] === "<") {
      const isOut = src[j] === ">";
      if (isOut && src[j + 1] === ">") { toks.push({ kind: "redir", fd: fd ?? 1, op: ">>" }); i = j + 2; continue; }
      if (isOut && src[j + 1] === "&" && /[0-9]/.test(src[j + 2] ?? "")) {
        toks.push({ kind: "redir", fd: fd ?? 1, op: ">&", dupFd: Number(src[j + 2]) });
        i = j + 3;
        continue;
      }
      if (!isOut && src[j + 1] === "<") {
        let k = j + 2;
        const stripTabs = src[k] === "-";
        if (stripTabs) k++;
        while (src[k] === " " || src[k] === "\t") k++;
        // delimiter word (quotes disable expansion)
        let delim = "";
        let quoted = false;
        while (k < n && !WORD_BREAK.has(src[k])) {
          const ch = src[k];
          if (ch === "'" || ch === "\"") {
            quoted = true;
            const close = src.indexOf(ch, k + 1);
            delim += src.slice(k + 1, close < 0 ? n : close);
            k = close < 0 ? n : close + 1;
          } else if (ch === "\\") { quoted = true; delim += src[k + 1] ?? ""; k += 2; }
          else { delim += ch; k++; }
        }
        const tok: RedirTok = { kind: "redir", fd: fd ?? 0, op: "<<", heredoc: { body: "", expand: !quoted } };
        toks.push(tok);
        pending.push({ tok, delim, stripTabs });
        i = k;
        continue;
      }
      toks.push({ kind: "redir", fd: fd ?? (isOut ? 1 : 0), op: isOut ? ">" : "<" });
      i = j + 1;
      continue;
    }

    // Word
    const start = i;
    const parts: WordPart[] = [];
    let plain = true;
    let buf = "";
    const flush = () => { if (buf) { parts.push({ kind: "lit", text: buf, quoted: false }); buf = ""; } };
    while (i < n && !WORD_BREAK.has(src[i])) {
      const ch = src[i];
      if (ch === "'") {
        plain = false; flush();
        const close = src.indexOf("'", i + 1);
        if (close < 0) throw new ShellSyntaxError("Unterminated quoted string");
        parts.push({ kind: "lit", text: src.slice(i + 1, close), quoted: true });
        i = close + 1;
      } else if (ch === "\"") {
        plain = false; flush();
        i++;
        let dq = "";
        const flushDq = () => { if (dq) { parts.push({ kind: "lit", text: dq, quoted: true }); dq = ""; } };
        for (;;) {
          if (i >= n) throw new ShellSyntaxError("Unterminated quoted string");
          const d = src[i];
          if (d === "\"") { i++; break; }
          if (d === "\\" && ["\"", "\\", "$", "`", "\n"].includes(src[i + 1] ?? "")) { dq += src[i + 1]; i += 2; continue; }
          if (d === "$") { flushDq(); const r = parseDollar(src, i, true); parts.push(r.part); i = r.next; continue; }
          if (d === "`") { flushDq(); const close = src.indexOf("`", i + 1); parts.push({ kind: "subst", script: src.slice(i + 1, close < 0 ? n : close), quoted: true }); i = close < 0 ? n : close + 1; continue; }
          dq += d; i++;
        }
        flushDq();
        if (parts.length === 0 || parts[parts.length - 1].kind !== "lit") parts.push({ kind: "lit", text: "", quoted: true });
      } else if (ch === "\\") {
        plain = false; flush();
        parts.push({ kind: "lit", text: src[i + 1] ?? "", quoted: true });
        i += 2;
      } else if (ch === "$") {
        plain = false; flush();
        const r = parseDollar(src, i, false);
        parts.push(r.part);
        i = r.next;
      } else if (ch === "`") {
        plain = false; flush();
        const close = src.indexOf("`", i + 1);
        parts.push({ kind: "subst", script: src.slice(i + 1, close < 0 ? n : close), quoted: false });
        i = close < 0 ? n : close + 1;
      } else { buf += ch; i++; }
    }
    flush();
    toks.push({ kind: "word", parts, plain, raw: src.slice(start, i) });
  }
  return toks;
}

function parseDollar(src: string, i: number, quoted: boolean): { part: WordPart; next: number } {
  const n = src.length;
  if (src.startsWith("$((", i)) {
    const close = matchParen(src, i + 3, 2);
    return { part: { kind: "arith", expr: src.slice(i + 3, close), quoted }, next: close + 2 };
  }
  if (src.startsWith("$(", i)) {
    const close = matchParen(src, i + 2, 1);
    return { part: { kind: "subst", script: src.slice(i + 2, close), quoted }, next: close + 1 };
  }
  if (src.startsWith("${", i)) {
    let depth = 1;
    let k = i + 2;
    while (k < n && depth > 0) { if (src[k] === "{") depth++; else if (src[k] === "}") depth--; if (depth > 0) k++; }
    const inner = src.slice(i + 2, k);
    const m = /^(#)?([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$!])(?:(:-|:\+|:=|-)([\s\S]*))?$/.exec(inner);
    if (!m) return { part: { kind: "lit", text: `\${${inner}}`, quoted }, next: k + 1 };
    if (m[1] === "#") return { part: { kind: "var", name: m[2], op: "#", quoted }, next: k + 1 };
    return { part: { kind: "var", name: m[2], op: m[3] as ":-" | ":+" | ":=" | "-" | undefined, word: m[4], quoted }, next: k + 1 };
  }
  const m = /^\$([A-Za-z_][A-Za-z0-9_]*|[0-9]|[@*#?$!])/.exec(src.slice(i));
  if (m) return { part: { kind: "var", name: m[1], quoted }, next: i + m[0].length };
  return { part: { kind: "lit", text: "$", quoted }, next: i + 1 };
}

/** Index of the char closing `depth` parens opened before `from`. */
function matchParen(src: string, from: number, depth: number): number {
  let d = depth;
  let k = from;
  let quote: string | null = null;
  while (k < src.length) {
    const c = src[k];
    if (quote) { if (c === quote) quote = null; else if (c === "\\" && quote === "\"") k++; k++; continue; }
    if (c === "'" || c === "\"") { quote = c; k++; continue; }
    if (c === "(") d++;
    else if (c === ")") {
      d--;
      // `$(…)` closes at depth 0; `$((…))` closes at the first `)` of the final `))`.
      if (d === 0 || (depth === 2 && d === 1 && src[k + 1] === ")")) return k;
    }
    k++;
  }
  throw new ShellSyntaxError("Unterminated command substitution");
}

// ─── AST + parser ───────────────────────────────────────────────────────────

interface Redirect { fd: number; op: RedirTok["op"]; target?: WordTok; dupFd?: number; heredoc?: { body: string; expand: boolean } }
interface SimpleCmd { kind: "simple"; words: WordTok[]; redirects: Redirect[] }
interface IfCmd { kind: "if"; branches: Array<{ cond: List; body: List }>; elseBody?: List; redirects: Redirect[] }
interface ForCmd { kind: "for"; varName: string; words: WordTok[] | null; body: List; redirects: Redirect[] }
interface WhileCmd { kind: "while"; until: boolean; cond: List; body: List; redirects: Redirect[] }
interface GroupCmd { kind: "group"; body: List; subshell: boolean; redirects: Redirect[] }
interface CaseCmd { kind: "case"; word: WordTok; items: Array<{ patterns: WordTok[]; body: List }>; redirects: Redirect[] }
interface FuncDef { kind: "func"; name: string; body: Cmd; redirects: Redirect[] }
type Cmd = SimpleCmd | IfCmd | ForCmd | WhileCmd | GroupCmd | CaseCmd | FuncDef;
interface Pipeline { negate: boolean; cmds: Cmd[] }
interface AndOr { first: Pipeline; rest: Array<{ op: "&&" | "||"; pipeline: Pipeline }> }
type List = AndOr[];

const CLOSERS = new Set(["then", "elif", "else", "fi", "do", "done", "esac", "}"]);

class ShellParser {
  private pos = 0;
  constructor(private toks: Tok[]) {}

  parseProgram(): List {
    const list = this.parseList([]);
    const t = this.peek();
    if (t) throw new ShellSyntaxError(`Syntax error: "${tokText(t)}" unexpected`);
    return list;
  }

  private peek(): Tok | undefined { return this.toks[this.pos]; }
  private next(): Tok { return this.toks[this.pos++]; }
  private peekWord(w: string): boolean { const t = this.peek(); return !!t && t.kind === "word" && t.plain && t.raw === w; }
  private peekOp(v: string): boolean { const t = this.peek(); return !!t && t.kind === "op" && t.value === v; }
  private expectWord(w: string): void { if (!this.peekWord(w)) throw new ShellSyntaxError(`Syntax error: expected "${w}" near "${tokText(this.peek())}"`); this.pos++; }
  private expectOp(v: string): void { if (!this.peekOp(v)) throw new ShellSyntaxError(`Syntax error: expected "${v}" near "${tokText(this.peek())}"`); this.pos++; }
  private skipNewlines(): void { while (this.peekOp("\n")) this.pos++; }
  private skipSeparators(): void { while (this.peekOp("\n") || this.peekOp(";") || this.peekOp("&")) this.pos++; }

  private parseList(terminators: string[]): List {
    const items: List = [];
    for (;;) {
      this.skipSeparators();
      const t = this.peek();
      if (!t) break;
      if (t.kind === "op" && (t.value === ")" || t.value === ";;")) break;
      if (t.kind === "word" && t.plain && terminators.includes(t.raw)) break;
      if (t.kind === "word" && t.plain && CLOSERS.has(t.raw)) throw new ShellSyntaxError(`Syntax error: "${t.raw}" unexpected`);
      items.push(this.parseAndOr());
      const s = this.peek();
      if (!s) break;
      if (s.kind === "op" && (s.value === ";" || s.value === "\n" || s.value === "&")) continue;
      if (s.kind === "op" && (s.value === ")" || s.value === ";;")) break;
      if (s.kind === "word" && s.plain && terminators.includes(s.raw)) break;
      throw new ShellSyntaxError(`Syntax error: "${tokText(s)}" unexpected`);
    }
    return items;
  }

  private parseAndOr(): AndOr {
    const first = this.parsePipeline();
    const rest: AndOr["rest"] = [];
    while (this.peekOp("&&") || this.peekOp("||")) {
      const op = (this.next() as OpTok).value as "&&" | "||";
      this.skipNewlines();
      rest.push({ op, pipeline: this.parsePipeline() });
    }
    return { first, rest };
  }

  private parsePipeline(): Pipeline {
    let negate = false;
    while (this.peekWord("!")) { this.pos++; negate = !negate; }
    const cmds = [this.parseCommand()];
    while (this.peekOp("|")) { this.pos++; this.skipNewlines(); cmds.push(this.parseCommand()); }
    return { negate, cmds };
  }

  private parseCommand(): Cmd {
    const t = this.peek();
    if (!t) throw new ShellSyntaxError("Syntax error: unexpected end of file");
    if (t.kind === "word" && t.plain) {
      switch (t.raw) {
        case "if": return this.parseIf();
        case "for": return this.parseFor();
        case "while": case "until": return this.parseWhile();
        case "case": return this.parseCase();
        case "{": return this.parseGroup(false);
      }
      const t1 = this.toks[this.pos + 1];
      const t2 = this.toks[this.pos + 2];
      if (t1?.kind === "op" && t1.value === "(" && t2?.kind === "op" && t2.value === ")" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(t.raw)) {
        this.pos += 3;
        this.skipNewlines();
        const body = this.parseCommand();
        return { kind: "func", name: t.raw, body, redirects: [] };
      }
    }
    if (t.kind === "op" && t.value === "(") return this.parseGroup(true);
    return this.parseSimple();
  }

  private parseIf(): IfCmd {
    this.expectWord("if");
    const branches: IfCmd["branches"] = [];
    let cond = this.parseList(["then"]);
    this.expectWord("then");
    let body = this.parseList(["elif", "else", "fi"]);
    branches.push({ cond, body });
    while (this.peekWord("elif")) {
      this.pos++;
      cond = this.parseList(["then"]);
      this.expectWord("then");
      body = this.parseList(["elif", "else", "fi"]);
      branches.push({ cond, body });
    }
    let elseBody: List | undefined;
    if (this.peekWord("else")) { this.pos++; elseBody = this.parseList(["fi"]); }
    this.expectWord("fi");
    return { kind: "if", branches, elseBody, redirects: this.parseTrailingRedirects() };
  }

  private parseFor(): ForCmd {
    this.expectWord("for");
    const nameTok = this.next();
    if (!nameTok || nameTok.kind !== "word") throw new ShellSyntaxError("Syntax error: bad for loop variable");
    this.skipNewlines();
    let words: WordTok[] | null = null;
    if (this.peekWord("in")) {
      this.pos++;
      words = [];
      while (this.peek()?.kind === "word") words.push(this.next() as WordTok);
    }
    this.skipSeparators();
    this.expectWord("do");
    const body = this.parseList(["done"]);
    this.expectWord("done");
    return { kind: "for", varName: nameTok.raw, words, body, redirects: this.parseTrailingRedirects() };
  }

  private parseWhile(): WhileCmd {
    const kw = (this.next() as WordTok).raw;
    const cond = this.parseList(["do"]);
    this.expectWord("do");
    const body = this.parseList(["done"]);
    this.expectWord("done");
    return { kind: "while", until: kw === "until", cond, body, redirects: this.parseTrailingRedirects() };
  }

  private parseGroup(subshell: boolean): GroupCmd {
    this.pos++;
    const body = this.parseList(subshell ? [] : ["}"]);
    if (subshell) this.expectOp(")"); else this.expectWord("}");
    return { kind: "group", body, subshell, redirects: this.parseTrailingRedirects() };
  }

  private parseCase(): CaseCmd {
    this.expectWord("case");
    const word = this.next();
    if (!word || word.kind !== "word") throw new ShellSyntaxError("Syntax error: bad case word");
    this.skipNewlines();
    this.expectWord("in");
    this.skipNewlines();
    const items: CaseCmd["items"] = [];
    while (!this.peekWord("esac")) {
      if (this.peekOp("(")) this.pos++;
      const patterns: WordTok[] = [];
      const p0 = this.next();
      if (!p0 || p0.kind !== "word") throw new ShellSyntaxError("Syntax error: bad case pattern");
      patterns.push(p0);
      while (this.peekOp("|")) { this.pos++; const p = this.next(); if (!p || p.kind !== "word") throw new ShellSyntaxError("Syntax error: bad case pattern"); patterns.push(p); }
      this.expectOp(")");
      const body = this.parseList(["esac"]);
      if (this.peekOp(";;")) this.pos++;
      this.skipNewlines();
      items.push({ patterns, body });
    }
    this.expectWord("esac");
    return { kind: "case", word, items, redirects: this.parseTrailingRedirects() };
  }

  private parseSimple(): SimpleCmd {
    const words: WordTok[] = [];
    const redirects: Redirect[] = [];
    for (;;) {
      const t = this.peek();
      if (!t || t.kind === "op") break;
      if (t.kind === "redir") { this.pos++; redirects.push(this.finishRedirect(t)); continue; }
      words.push(t);
      this.pos++;
    }
    if (words.length === 0 && redirects.length === 0) throw new ShellSyntaxError(`Syntax error: "${tokText(this.peek())}" unexpected`);
    return { kind: "simple", words, redirects };
  }

  private parseTrailingRedirects(): Redirect[] {
    const out: Redirect[] = [];
    while (this.peek()?.kind === "redir") out.push(this.finishRedirect(this.next() as RedirTok));
    return out;
  }

  private finishRedirect(t: RedirTok): Redirect {
    const r: Redirect = { fd: t.fd, op: t.op, dupFd: t.dupFd, heredoc: t.heredoc };
    if (t.op !== "<<" && t.dupFd === undefined) {
      const target = this.next();
      if (!target || target.kind !== "word") throw new ShellSyntaxError("Syntax error: redirection needs a target");
      r.target = target;
    }
    return r;
  }
}

function tokText(t: Tok | undefined): string {
  if (!t) return "end of file";
  if (t.kind === "word") return t.raw;
  if (t.kind === "op") return t.value === "\n" ? "newline" : t.value;
  return t.op;
}

// ─── Executor ───────────────────────────────────────────────────────────────

class ExitSignal { constructor(public code: number) {} }
class ReturnSignal { constructor(public code: number) {} }
class LoopSignal { constructor(public kind: "break" | "continue", public levels: number) {} }

interface ShellState {
  cwd: string;
  env: Record<string, string>;
  /** [$0, $1, …] */
  positional: string[];
  errexit: boolean;
  lastExit: number;
  funcs: Map<string, Cmd>;
}

interface Frame { stdout: string; stderr: string }
type Sink = { type: "stdout" } | { type: "stderr" } | { type: "file"; path: string } | { type: "null" };
interface IoPlan { stdin: string; sinks: { 1: Sink; 2: Sink }; error?: string }

let pidCounter = 1000;

function res(exitCode: number, stdout = "", stderr = ""): ShellResult {
  return { exitCode, stdout, stderr };
}

async function runShellScript(
  sb: FakeSandboxInstance,
  script: string,
  opts: { cwd: string; env: Record<string, string>; session?: FakeSession },
): Promise<ShellResult> {
  let list: List;
  try {
    list = new ShellParser(tokenize(script)).parseProgram();
  } catch (err) {
    if (err instanceof ShellSyntaxError) return res(2, "", `sh: 1: ${err.message}\n`);
    throw err;
  }
  const shell = new Shell(sb, {
    cwd: opts.cwd,
    env: { ...opts.env },
    positional: ["sh"],
    errexit: false,
    lastExit: 0,
    funcs: new Map(),
  });
  const code = await shell.runTop(list, "");
  if (opts.session) {
    opts.session.cwd = shell.st.cwd;
    opts.session.env = shell.st.env;
  }
  return res(code, shell.frames[0].stdout, shell.frames[0].stderr);
}

class Shell {
  readonly frames: Frame[] = [{ stdout: "", stderr: "" }];
  readonly pid: number;
  private pendingExit: number | null = null;
  private loopDepth = 0;

  constructor(public readonly sb: FakeSandboxInstance, public st: ShellState) {
    pidCounter += 1;
    this.pid = pidCounter;
  }

  /** Run a whole program, turning exit/return signals into an exit status. */
  async runTop(list: List, stdin: string): Promise<number> {
    try {
      return await this.execList(list, stdin);
    } catch (err) {
      if (err instanceof ExitSignal || err instanceof ReturnSignal) return err.code;
      if (err instanceof LoopSignal) return 0;
      throw err;
    }
  }

  // ── frames ──

  private emit(stdout: string, stderr: string): void {
    const f = this.frames[this.frames.length - 1];
    f.stdout += stdout;
    f.stderr += stderr;
  }
  private pushFrame(): void { this.frames.push({ stdout: "", stderr: "" }); }
  private popFrame(): Frame { return this.frames.pop()!; }

  /** Run nested code and capture what it emitted (functions, sh -c, eval…). */
  private async capture(fn: () => Promise<number>): Promise<ShellResult> {
    this.pushFrame();
    let code: number;
    try { code = await fn(); } finally { /* frame popped below */ }
    const f = this.popFrame();
    return res(code, f.stdout, f.stderr);
  }

  /** New shell (copied state) for `$(...)`, `( ... )`, `sh -c`. */
  private async subshell(
    run: (sh: Shell) => Promise<number>,
    override: Partial<ShellState> = {},
  ): Promise<ShellResult> {
    const child = new Shell(this.sb, {
      cwd: this.st.cwd,
      env: { ...this.st.env },
      positional: [...this.st.positional],
      errexit: this.st.errexit,
      lastExit: this.st.lastExit,
      funcs: new Map(this.st.funcs),
      ...override,
    });
    let code: number;
    try {
      code = await run(child);
    } catch (err) {
      if (err instanceof ExitSignal || err instanceof ReturnSignal) code = err.code;
      else if (err instanceof LoopSignal) code = 0;
      else throw err;
    }
    return res(code, child.frames[0].stdout, child.frames[0].stderr);
  }

  async runScriptCaptured(script: string, stdin: string, override: Partial<ShellState> = {}): Promise<ShellResult> {
    let list: List;
    try {
      list = new ShellParser(tokenize(script)).parseProgram();
    } catch (err) {
      if (err instanceof ShellSyntaxError) return res(2, "", `sh: 1: ${err.message}\n`);
      throw err;
    }
    return this.subshell((sh) => sh.execList(list, stdin), override);
  }

  // ── lists / pipelines ──

  async execList(list: List, stdin: string): Promise<number> {
    let code = 0;
    for (const ao of list) {
      const r = await this.execAndOr(ao, stdin);
      code = r.code;
      if (this.st.errexit && code !== 0 && r.eligible) throw new ExitSignal(code);
    }
    return code;
  }

  private async execAndOr(ao: AndOr, stdin: string): Promise<{ code: number; eligible: boolean }> {
    let code = await this.execPipeline(ao.first, stdin);
    let eligible = ao.rest.length === 0 && !ao.first.negate;
    for (let i = 0; i < ao.rest.length; i++) {
      const { op, pipeline } = ao.rest[i];
      const shouldRun = op === "&&" ? code === 0 : code !== 0;
      if (!shouldRun) { eligible = false; continue; }
      code = await this.execPipeline(pipeline, stdin);
      eligible = i === ao.rest.length - 1 && !pipeline.negate;
    }
    this.st.lastExit = code;
    return { code, eligible };
  }

  private async execPipeline(p: Pipeline, stdin: string): Promise<number> {
    let input = stdin;
    let code = 0;
    for (let i = 0; i < p.cmds.length; i++) {
      const last = i === p.cmds.length - 1;
      if (last) {
        code = await this.execCmd(p.cmds[i], input);
      } else {
        this.pushFrame();
        try { code = await this.execCmd(p.cmds[i], input); } finally {
          const f = this.popFrame();
          input = f.stdout;
          this.emit("", f.stderr);
        }
      }
    }
    if (p.negate) code = code === 0 ? 1 : 0;
    this.st.lastExit = code;
    return code;
  }

  // ── commands ──

  private async execCmd(cmd: Cmd, stdin: string): Promise<number> {
    const io = await this.prepareRedirects(cmd.redirects, stdin);
    if (io.error) { this.emit("", io.error); this.st.lastExit = 1; return 1; }
    if (cmd.kind === "simple") {
      const r = await this.execSimple(cmd, io.stdin);
      this.route(r, io.sinks);
      this.st.lastExit = r.exitCode;
      if (this.pendingExit !== null) { const c = this.pendingExit; this.pendingExit = null; throw new ExitSignal(c); }
      return r.exitCode;
    }
    const routed = cmd.redirects.some((r) => r.op !== "<" && r.op !== "<<");
    if (!routed) return this.execCompound(cmd, io.stdin);
    this.pushFrame();
    let code = 0;
    try {
      code = await this.execCompound(cmd, io.stdin);
    } finally {
      const f = this.popFrame();
      this.route(res(code, f.stdout, f.stderr), io.sinks);
    }
    return code;
  }

  private async execCompound(cmd: Exclude<Cmd, SimpleCmd>, stdin: string): Promise<number> {
    switch (cmd.kind) {
      case "func":
        this.st.funcs.set(cmd.name, cmd.body);
        return 0;
      case "group": {
        if (!cmd.subshell) return this.execList(cmd.body, stdin);
        const r = await this.subshell((sh) => sh.execList(cmd.body, stdin));
        this.emit(r.stdout, r.stderr);
        return r.exitCode;
      }
      case "if": {
        for (const br of cmd.branches) {
          if ((await this.execCondition(br.cond, stdin)) === 0) return this.execList(br.body, stdin);
        }
        return cmd.elseBody ? this.execList(cmd.elseBody, stdin) : 0;
      }
      case "for": {
        const words = cmd.words === null
          ? this.st.positional.slice(1)
          : (await Promise.all(cmd.words.map((w) => this.expandWord(w)))).flat();
        let code = 0;
        this.loopDepth++;
        try {
          for (const w of words) {
            this.st.env[cmd.varName] = w;
            try {
              code = await this.execList(cmd.body, stdin);
            } catch (err) {
              if (err instanceof LoopSignal) {
                if (err.levels > 1) throw new LoopSignal(err.kind, err.levels - 1);
                if (err.kind === "break") break;
                continue;
              }
              throw err;
            }
          }
        } finally { this.loopDepth--; }
        return code;
      }
      case "while": {
        let code = 0;
        let iterations = 0;
        this.loopDepth++;
        try {
          for (;;) {
            if (++iterations > 100_000) throw new Error("fake shell: loop iteration cap exceeded (infinite loop?)");
            const c = await this.execCondition(cmd.cond, stdin);
            if (cmd.until ? c === 0 : c !== 0) break;
            try {
              code = await this.execList(cmd.body, stdin);
            } catch (err) {
              if (err instanceof LoopSignal) {
                if (err.levels > 1) throw new LoopSignal(err.kind, err.levels - 1);
                if (err.kind === "break") break;
                continue;
              }
              throw err;
            }
          }
        } finally { this.loopDepth--; }
        return code;
      }
      case "case": {
        const value = (await this.expandWord(cmd.word)).join(" ");
        for (const item of cmd.items) {
          for (const p of item.patterns) {
            const pat = await this.expandPattern(p);
            if (globToRegex(pat, false, true).test(value)) return this.execList(item.body, stdin);
          }
        }
        return 0;
      }
    }
  }

  private async execCondition(list: List, stdin: string): Promise<number> {
    const saved = this.st.errexit;
    this.st.errexit = false;
    try { return await this.execList(list, stdin); } finally { this.st.errexit = saved; }
  }

  private async execSimple(cmd: SimpleCmd, stdin: string): Promise<ShellResult> {
    const argv: string[] = [];
    const assigns: Array<[string, string]> = [];
    for (const w of cmd.words) {
      if (argv.length === 0) {
        const asg = assignmentOf(w);
        if (asg) { assigns.push([asg.name, await this.expandParts(asg.valueParts)]); continue; }
      }
      argv.push(...(await this.expandWord(w)));
    }
    if (argv.length === 0) {
      for (const [k, v] of assigns) this.st.env[k] = v;
      return res(0);
    }
    const env = assigns.length ? { ...this.st.env, ...Object.fromEntries(assigns) } : this.st.env;
    return this.dispatch(argv[0], argv.slice(1), stdin, env);
  }

  // ── redirections ──

  private async prepareRedirects(redirects: Redirect[], stdin: string): Promise<IoPlan> {
    const plan: IoPlan = { stdin, sinks: { 1: { type: "stdout" }, 2: { type: "stderr" } } };
    for (const r of redirects) {
      if (r.op === "<<") {
        const body = r.heredoc?.body ?? "";
        plan.stdin = r.heredoc?.expand ? await this.expandText(body) : body;
        continue;
      }
      if (r.op === ">&") {
        const from = r.fd === 2 ? 2 : 1;
        const to = r.dupFd === 2 ? 2 : 1;
        plan.sinks[from] = plan.sinks[to];
        continue;
      }
      const target = r.target ? (await this.expandWord(r.target)).join(" ") : "";
      if (r.op === "<") {
        const p = this.sb.resolve(target, this.st.cwd);
        if (target === "/dev/null") { plan.stdin = ""; continue; }
        const buf = this.sb.files.get(p);
        if (!buf) { plan.error = `sh: 1: cannot open ${target}: No such file\n`; return plan; }
        plan.stdin = buf.toString("utf8");
        continue;
      }
      // > >> &>
      let sink: Sink;
      if (target === "/dev/null") sink = { type: "null" };
      else if (target === "/dev/stdout") sink = { type: "stdout" };
      else if (target === "/dev/stderr") sink = { type: "stderr" };
      else {
        const p = this.sb.resolve(target, this.st.cwd);
        if (this.sb.isDir(p)) { plan.error = `sh: 1: cannot create ${target}: Is a directory\n`; return plan; }
        if (!this.sb.isDir(parentPath(p))) { plan.error = `sh: 1: cannot create ${target}: Directory nonexistent\n`; return plan; }
        if (r.op === ">" || !this.sb.files.has(p)) this.sb.writeFileAt(p, Buffer.alloc(0));
        sink = { type: "file", path: p };
      }
      if (r.op === "&>") { plan.sinks[1] = sink; plan.sinks[2] = sink; }
      else plan.sinks[r.fd === 2 ? 2 : 1] = sink;
    }
    return plan;
  }

  private route(r: ShellResult, sinks: IoPlan["sinks"]): void {
    const write = (sink: Sink, text: string) => {
      if (!text) return;
      switch (sink.type) {
        case "stdout": this.emit(text, ""); break;
        case "stderr": this.emit("", text); break;
        case "null": break;
        case "file": {
          const prev = this.sb.files.get(sink.path) ?? Buffer.alloc(0);
          this.sb.writeFileAt(sink.path, Buffer.concat([prev, Buffer.from(text, "utf8")]));
        }
      }
    };
    write(sinks[1], r.stdout);
    write(sinks[2], r.stderr);
  }

  // ── expansion ──

  async expandWord(w: WordTok): Promise<string[]> {
    const fields: Array<{ text: string; glob: boolean }> = [{ text: "", glob: false }];
    let hasQuotedOrLit = false;
    const append = (text: string, globbable: boolean) => {
      const f = fields[fields.length - 1];
      f.text += text;
      if (globbable && /[*?[]/.test(text)) f.glob = true;
    };
    for (const part of w.parts) {
      if (part.kind === "lit") { hasQuotedOrLit = true; append(part.text, !part.quoted); continue; }
      if (part.kind === "var" && part.name === "@" && part.quoted) {
        const params = this.st.positional.slice(1);
        hasQuotedOrLit = true;
        params.forEach((p, i) => { if (i > 0) fields.push({ text: "", glob: false }); append(p, false); });
        continue;
      }
      let value: string;
      if (part.kind === "var") value = await this.varValue(part);
      else if (part.kind === "subst") {
        const r = await this.runScriptCaptured(part.script, "");
        this.emit("", r.stderr);
        value = r.stdout.replace(/\n+$/, "");
      } else value = String(this.arith(await this.expandText(part.expr)));
      if (part.quoted) { hasQuotedOrLit = true; append(value, false); continue; }
      const pieces = value.split(/[ \t\n]+/);
      pieces.forEach((piece, i) => { if (i > 0) fields.push({ text: "", glob: false }); append(piece, true); });
    }
    const kept = fields.filter((f) => f.text !== "" || (hasQuotedOrLit && fields.length === 1));
    const out: string[] = [];
    for (const f of kept) out.push(...(f.glob ? this.glob(f.text) : [f.text]));
    return out;
  }

  private async expandParts(parts: WordPart[]): Promise<string> {
    return (await this.expandWord({ kind: "word", parts, plain: false, raw: "" })).join(" ");
  }

  /** Expand `$…` in free text (heredoc bodies, ${X:-word}) — double-quote rules. */
  async expandText(text: string): Promise<string> {
    let out = "";
    let i = 0;
    while (i < text.length) {
      const c = text[i];
      if (c === "\\" && ["$", "`", "\\"].includes(text[i + 1] ?? "")) { out += text[i + 1]; i += 2; continue; }
      if (c === "$") {
        const r = parseDollar(text, i, true);
        out += await this.expandParts([r.part]);
        i = r.next;
        continue;
      }
      if (c === "`") {
        const close = text.indexOf("`", i + 1);
        const script = text.slice(i + 1, close < 0 ? text.length : close);
        const r = await this.runScriptCaptured(script, "");
        out += r.stdout.replace(/\n+$/, "");
        i = close < 0 ? text.length : close + 1;
        continue;
      }
      out += c;
      i++;
    }
    return out;
  }

  /** Expand a case/glob pattern keeping quoted glob chars literal (escaped). */
  private async expandPattern(w: WordTok): Promise<string> {
    let out = "";
    for (const part of w.parts) {
      if (part.kind === "lit") { out += part.quoted ? part.text.replace(/[*?[\]\\]/g, "\\$&") : part.text; continue; }
      const v = await this.expandParts([part]);
      out += part.quoted ? v.replace(/[*?[\]\\]/g, "\\$&") : v;
    }
    return out;
  }

  private async varValue(part: Extract<WordPart, { kind: "var" }>): Promise<string> {
    const name = part.name;
    let v: string | undefined;
    if (name === "?") v = String(this.st.lastExit);
    else if (name === "$") v = String(this.pid);
    else if (name === "!") v = String(this.pid + 1);
    else if (name === "#") v = String(Math.max(0, this.st.positional.length - 1));
    else if (name === "@" || name === "*") v = this.st.positional.slice(1).join(" ");
    else if (/^[0-9]+$/.test(name)) v = this.st.positional[Number(name)];
    else v = this.st.env[name];
    if (part.op === "#") return String((v ?? "").length);
    if (!part.op) return v ?? "";
    const nullish = part.op === "-" ? v === undefined : v === undefined || v === "";
    switch (part.op) {
      case ":-": case "-": return nullish ? this.expandText(part.word ?? "") : v ?? "";
      case ":+": return nullish ? "" : this.expandText(part.word ?? "");
      case ":=": {
        if (!nullish) return v ?? "";
        const w = await this.expandText(part.word ?? "");
        this.st.env[name] = w;
        return w;
      }
    }
    return v ?? "";
  }

  private arith(expr: string): number {
    return new ArithEvaluator(expr, this.st.env).evaluate();
  }

  glob(pattern: string): string[] {
    const cwd = this.st.cwd;
    const absolute = pattern.startsWith("/");
    const segs = (absolute ? pattern : `${cwd}/${pattern}`).split("/").filter((s) => s.length > 0);
    let current = ["/"];
    for (const seg of segs) {
      const next: string[] = [];
      if (!/[*?[]/.test(seg)) {
        for (const c of current) { const p = seg === "." ? c : seg === ".." ? parentPath(c) : joinPath(c, seg); if (this.sb.exists(p)) next.push(p); }
      } else {
        const re = globToRegex(seg, false, false);
        for (const c of current) {
          for (const name of this.sb.listDir(c)) {
            if (!seg.startsWith(".") && name.startsWith(".")) continue;
            if (re.test(name)) next.push(joinPath(c, name));
          }
        }
      }
      current = next;
      if (current.length === 0) break;
    }
    if (current.length === 0) return [pattern];
    current.sort();
    if (absolute) return current;
    const prefix = cwd === "/" ? "/" : `${cwd}/`;
    return current.map((p) => (p.startsWith(prefix) ? p.slice(prefix.length) : p));
  }

  // ── dispatch ──

  async dispatch(name: string, args: string[], stdin: string, env: Record<string, string>): Promise<ShellResult> {
    const handler = this.sb.commandHandlers.get(name);
    if (handler) {
      const r = await handler({
        name, args, stdin, cwd: this.st.cwd, env, sandbox: this.sb,
        runShell: (script) => this.runScriptCaptured(script, "", { env: { ...env } }),
      });
      return res(r.exitCode, r.stdout ?? "", r.stderr ?? "");
    }
    const fn = this.st.funcs.get(name);
    if (fn) {
      const savedPos = this.st.positional;
      this.st.positional = [name, ...args];
      try {
        return await this.capture(async () => {
          try { return await this.execCmd(fn, stdin); } catch (err) {
            if (err instanceof ReturnSignal) return err.code;
            throw err;
          }
        });
      } finally { this.st.positional = savedPos; }
    }
    const builtin = await this.builtin(name, args, stdin, env);
    if (builtin) return builtin;
    const util = UTILS[name];
    if (util) return util(this, args, stdin, env);
    this.sb.unhandledCommands.push({ name, args, line: [name, ...args].join(" ") });
    return res(this.sb.unknownCommandExitCode);
  }

  isKnownCommand(name: string): boolean {
    if (this.sb.missingCommands.has(name)) return false;
    return true; // builtins, utilities, handlers — and anything else "installed" (unknown commands succeed)
  }

  private async builtin(name: string, args: string[], stdin: string, env: Record<string, string>): Promise<ShellResult | null> {
    switch (name) {
      case ":": case "true": return res(0);
      case "false": return res(1);
      case "cd": {
        const target = args.find((a) => !a.startsWith("-")) ?? this.st.env.HOME ?? "/root";
        const p = this.sb.resolve(target === "-" ? (this.st.env.OLDPWD ?? this.st.cwd) : target, this.st.cwd);
        if (!this.sb.isDir(p)) return res(1, "", `sh: 1: cd: can't cd to ${target}\n`);
        this.st.env.OLDPWD = this.st.cwd;
        this.st.cwd = p;
        this.st.env.PWD = p;
        return res(0);
      }
      case "pwd": return res(0, `${this.st.cwd}\n`);
      case "export": case "readonly": case "local": case "declare": case "typeset": {
        if (args[0] === "-p" || args.length === 0) return res(0, Object.entries(this.st.env).map(([k, v]) => `export ${k}='${v}'\n`).join(""));
        for (const a of args) {
          if (a.startsWith("-")) continue;
          const eq = a.indexOf("=");
          if (eq > 0) this.st.env[a.slice(0, eq)] = a.slice(eq + 1);
          else if (this.st.env[a] === undefined && env[a] !== undefined) this.st.env[a] = env[a];
        }
        return res(0);
      }
      case "unset": { for (const a of args) if (!a.startsWith("-")) delete this.st.env[a]; return res(0); }
      case "set": {
        for (let i = 0; i < args.length; i++) {
          const a = args[i];
          if (a === "--") { this.st.positional = [this.st.positional[0], ...args.slice(i + 1)]; break; }
          if (a === "-o" || a === "+o") { i++; continue; }
          if (/^[-+][a-zA-Z]+$/.test(a)) { if (a.includes("e")) this.st.errexit = a.startsWith("-"); continue; }
          this.st.positional = [this.st.positional[0], ...args.slice(i)];
          break;
        }
        if (args.length === 0) return res(0, Object.entries(this.st.env).map(([k, v]) => `${k}='${v}'\n`).join(""));
        return res(0);
      }
      case "shift": {
        const n = args[0] ? Number(args[0]) : 1;
        if (n > this.st.positional.length - 1) return res(1, "", "sh: 1: shift: can't shift that many\n");
        this.st.positional = [this.st.positional[0], ...this.st.positional.slice(1 + n)];
        return res(0);
      }
      case "exit": throw new ExitSignal(args[0] !== undefined ? Number(args[0]) & 255 : this.st.lastExit);
      case "return": throw new ReturnSignal(args[0] !== undefined ? Number(args[0]) & 255 : this.st.lastExit);
      case "break": case "continue": {
        if (this.loopDepth === 0) return res(0);
        throw new LoopSignal(name, args[0] ? Math.max(1, Number(args[0])) : 1);
      }
      case "eval": {
        const script = args.join(" ");
        if (!script.trim()) return res(0);
        let list: List;
        try { list = new ShellParser(tokenize(script)).parseProgram(); } catch (err) {
          if (err instanceof ShellSyntaxError) return res(2, "", `sh: 1: eval: ${err.message}\n`);
          throw err;
        }
        return this.capture(() => this.execList(list, stdin));
      }
      case ".": case "source": {
        const file = args[0];
        if (!file) return res(2, "", `sh: 1: ${name}: filename argument required\n`);
        const buf = this.sb.files.get(this.sb.resolve(file, this.st.cwd));
        if (!buf) return res(1, "", `sh: 1: ${name}: ${file}: not found\n`);
        let list: List;
        try { list = new ShellParser(tokenize(buf.toString("utf8"))).parseProgram(); } catch (err) {
          if (err instanceof ShellSyntaxError) return res(2, "", `sh: 1: ${err.message}\n`);
          throw err;
        }
        return this.capture(() => this.execList(list, stdin));
      }
      case "exec": {
        if (args.length === 0) return res(0);
        const r = await this.dispatch(args[0], args.slice(1), stdin, env);
        this.pendingExit = r.exitCode;
        return r;
      }
      case "command": {
        if (args[0] === "-v" || args[0] === "-V") {
          const target = args[1];
          if (!target) return res(1);
          if (!this.isKnownCommand(target)) return res(1);
          const isBuiltin = BUILTIN_NAMES.has(target) || this.st.funcs.has(target);
          return res(0, `${isBuiltin ? target : `/usr/bin/${target}`}\n`);
        }
        const rest = args.filter((a, i) => !(i === 0 && a === "-p"));
        if (rest.length === 0) return res(0);
        return this.dispatch(rest[0], rest.slice(1), stdin, env);
      }
      case "type": case "which": case "whereis": {
        let code = 0;
        let out = "";
        let err = "";
        for (const a of args.filter((x) => !x.startsWith("-"))) {
          if (!this.isKnownCommand(a)) { code = 1; if (name === "type") err += `sh: 1: type: ${a}: not found\n`; continue; }
          if (name === "type") out += BUILTIN_NAMES.has(a) ? `${a} is a shell builtin\n` : `${a} is /usr/bin/${a}\n`;
          else out += `/usr/bin/${a}\n`;
        }
        return res(code, out, err);
      }
      case "hash": case "alias": case "unalias": case "ulimit": case "umask": case "trap": case "wait": case "times": case "getopts": return res(0);
      case "test": return res(evalTest(this, args) ? 0 : 1);
      case "[": {
        if (args[args.length - 1] !== "]") return res(2, "", "sh: 1: [: missing ]\n");
        return res(evalTest(this, args.slice(0, -1)) ? 0 : 1);
      }
      case "[[": {
        if (args[args.length - 1] !== "]]") return res(2, "", "sh: 1: [[: missing ]]\n");
        return res(evalTest(this, args.slice(0, -1)) ? 0 : 1);
      }
      case "sh": case "bash": case "dash": case "ash": case "zsh": {
        let i = 0;
        let errexit = this.st.errexit;
        let inline: string | null = null;
        while (i < args.length && args[i].startsWith("-") && args[i] !== "-") {
          const a = args[i++];
          if (a === "-c") { inline = args[i++] ?? ""; break; }
          if (a === "--") break;
          if (a.includes("e")) errexit = true;
        }
        if (inline !== null) {
          const rest = args.slice(i);
          const positional = rest.length ? rest : ["sh"];
          return this.runScriptCaptured(inline, stdin, { errexit, positional, env: { ...env } });
        }
        if (i < args.length) {
          const file = args[i];
          const buf = this.sb.files.get(this.sb.resolve(file, this.st.cwd));
          if (!buf) return res(127, "", `${name}: 0: cannot open ${file}: No such file\n`);
          return this.runScriptCaptured(buf.toString("utf8"), stdin, { errexit, positional: args.slice(i), env: { ...env } });
        }
        return this.runScriptCaptured(stdin, "", { errexit, env: { ...env } });
      }
      case "setsid": case "nohup": case "sudo": case "time": case "nice": case "ionice": case "stdbuf": case "unbuffer": {
        const rest = args.filter((a, idx) => !(a.startsWith("-") && idx === 0 && name !== "sudo") && !(name === "sudo" && (a === "-E" || a === "-n" || a === "-H")));
        if (rest.length === 0) return res(0);
        return this.dispatch(rest[0], rest.slice(1), stdin, env);
      }
      case "timeout": {
        let i = 0;
        while (i < args.length && args[i].startsWith("-")) { if (args[i] === "-s" || args[i] === "-k" || args[i] === "--signal") i++; i++; }
        i++; // duration
        if (i >= args.length) return res(125, "", "timeout: missing command\n");
        return this.dispatch(args[i], args.slice(i + 1), stdin, env);
      }
      case "env": {
        let i = 0;
        const extra: Record<string, string> = {};
        let cleared = false;
        while (i < args.length) {
          const a = args[i];
          if (a === "-i") { cleared = true; i++; continue; }
          if (a === "-u") { i += 2; continue; }
          if (a === "-0" || a === "--") { i++; continue; }
          const eq = a.indexOf("=");
          if (eq > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(a.slice(0, eq))) { extra[a.slice(0, eq)] = a.slice(eq + 1); i++; continue; }
          break;
        }
        const merged = { ...(cleared ? {} : env), ...extra };
        if (i >= args.length) return res(0, Object.entries(merged).map(([k, v]) => `${k}=${v}\n`).join(""));
        return this.dispatch(args[i], args.slice(i + 1), stdin, merged);
      }
      case "xargs": {
        let i = 0;
        let nul = false;
        let noRunIfEmpty = false;
        let replace: string | null = null;
        let perBatch = Infinity;
        while (i < args.length && args[i].startsWith("-")) {
          const a = args[i++];
          if (a === "-0" || a === "--null") nul = true;
          else if (a === "-r" || a === "--no-run-if-empty") noRunIfEmpty = true;
          else if (a === "-I") replace = args[i++] ?? "{}";
          else if (a === "-n") perBatch = Number(args[i++] ?? "1");
          else if (a === "-d" || a === "-P" || a === "-s" || a === "-L" || a === "-E") i++;
        }
        const items = (nul ? stdin.split("\0") : stdin.split(/\s+/)).filter((s) => s.length > 0);
        const cmd = args[i] ?? "echo";
        const cmdArgs = args.slice(i + 1);
        if (items.length === 0 && noRunIfEmpty) return res(0);
        let out = res(0);
        const runWith = async (batch: string[]) => {
          const argv = replace !== null ? cmdArgs.map((a) => a.split(replace!).join(batch.join(" "))) : [...cmdArgs, ...batch];
          const r = await this.dispatch(cmd, argv, "", env);
          out = res(r.exitCode !== 0 ? 123 : out.exitCode, out.stdout + r.stdout, out.stderr + r.stderr);
        };
        if (replace !== null) { for (const it of items) await runWith([it]); }
        else if (items.length === 0) await runWith([]);
        else for (let k = 0; k < items.length; k += Math.max(1, perBatch === Infinity ? items.length : perBatch)) await runWith(items.slice(k, k + (perBatch === Infinity ? items.length : perBatch)));
        return out;
      }
      case "kill": {
        let signal = "TERM";
        const targets: string[] = [];
        let i = 0;
        if (args[0] === "-l" || args[0] === "-L") return res(0, "HUP INT QUIT KILL TERM USR1 USR2 CONT STOP\n");
        while (i < args.length) {
          const a = args[i];
          if (a === "--") { targets.push(...args.slice(i + 1)); break; }
          if (a === "-s" || a === "--signal") { signal = normalizeSignal(args[i + 1] ?? "TERM"); i += 2; continue; }
          if (/^-[A-Za-z0-9]+$/.test(a) && targets.length === 0) { signal = normalizeSignal(a.slice(1)); i++; continue; }
          targets.push(a);
          i++;
        }
        const bad = targets.filter((t) => !/^-?[0-9]+$/.test(t) && !/^%[0-9]+$/.test(t));
        if (bad.length > 0) return res(1, "", bad.map((b) => `sh: 1: kill: ${b}: arguments must be process or job IDs\n`).join(""));
        if (targets.length === 0) return res(2, "", "sh: 1: kill: usage: kill [-s sigspec | -signum | -sigspec] [pid | job]... or kill -l [sigspec]\n");
        this.sb.kills.push({ signal, targets });
        return res(this.sb.killExitCode, "", this.sb.killExitCode === 0 ? "" : targets.map((t) => `sh: 1: kill: ${t}: No such process\n`).join(""));
      }
      case "sleep": return res(0);
      default: return null;
    }
  }
}

const BUILTIN_NAMES = new Set([":", "true", "false", "cd", "pwd", "export", "readonly", "local", "declare", "typeset", "unset", "set", "shift", "exit", "return", "break", "continue", "eval", ".", "source", "exec", "command", "type", "hash", "alias", "unalias", "ulimit", "umask", "trap", "wait", "times", "getopts", "test", "[", "[[", "kill", "echo", "printf", "read"]);

function normalizeSignal(sig: string): string {
  const s = sig.toUpperCase().replace(/^SIG/, "");
  const byNumber: Record<string, string> = { "1": "HUP", "2": "INT", "3": "QUIT", "9": "KILL", "15": "TERM", "10": "USR1", "12": "USR2", "18": "CONT", "19": "STOP", "0": "0" };
  return byNumber[s] ?? s;
}

function assignmentOf(w: WordTok): { name: string; valueParts: WordPart[] } | null {
  const first = w.parts[0];
  if (!first || first.kind !== "lit" || first.quoted) return null;
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(first.text);
  if (!m) return null;
  return { name: m[1], valueParts: [{ kind: "lit", text: m[2], quoted: false }, ...w.parts.slice(1)] };
}

// ─── test / [ ] ─────────────────────────────────────────────────────────────

function evalTest(sh: Shell, toks: string[]): boolean {
  if (toks.length === 0) return false;
  const oIdx = toks.indexOf("-o");
  if (oIdx > 0 && oIdx < toks.length - 1) return evalTest(sh, toks.slice(0, oIdx)) || evalTest(sh, toks.slice(oIdx + 1));
  const orIdx = toks.indexOf("||");
  if (orIdx > 0 && orIdx < toks.length - 1) return evalTest(sh, toks.slice(0, orIdx)) || evalTest(sh, toks.slice(orIdx + 1));
  const aIdx = toks.indexOf("-a");
  if (aIdx > 0 && aIdx < toks.length - 1) return evalTest(sh, toks.slice(0, aIdx)) && evalTest(sh, toks.slice(aIdx + 1));
  const andIdx = toks.indexOf("&&");
  if (andIdx > 0 && andIdx < toks.length - 1) return evalTest(sh, toks.slice(0, andIdx)) && evalTest(sh, toks.slice(andIdx + 1));
  if (toks[0] === "!") return !evalTest(sh, toks.slice(1));
  if (toks[0] === "(" && toks[toks.length - 1] === ")") return evalTest(sh, toks.slice(1, -1));
  if (toks.length === 1) return toks[0] !== "";
  const sb = sh.sb;
  const path = (p: string) => sb.resolve(p, sh.st.cwd);
  if (toks.length === 2) {
    const [op, arg] = toks;
    switch (op) {
      case "-d": return sb.isDir(path(arg));
      case "-f": return sb.isFile(path(arg));
      case "-e": case "-r": case "-w": case "-x": case "-O": case "-G": return sb.exists(path(arg));
      case "-s": return (sb.files.get(path(arg))?.byteLength ?? 0) > 0;
      case "-L": case "-h": case "-p": case "-S": case "-b": case "-c": case "-g": case "-u": case "-k": case "-t": return false;
      case "-n": return arg !== "";
      case "-z": return arg === "";
      default: return op !== "";
    }
  }
  if (toks.length === 3) {
    const [a, op, b] = toks;
    const num = (s: string) => { const v = Number(s.trim()); if (!Number.isFinite(v)) throw new Error(`integer expression expected: ${s}`); return v; };
    try {
      switch (op) {
        case "=": case "==": return a === b;
        case "!=": return a !== b;
        case "<": return a < b;
        case ">": return a > b;
        case "=~": return new RegExp(b).test(a);
        case "-eq": return num(a) === num(b);
        case "-ne": return num(a) !== num(b);
        case "-lt": return num(a) < num(b);
        case "-le": return num(a) <= num(b);
        case "-gt": return num(a) > num(b);
        case "-ge": return num(a) >= num(b);
        case "-nt": return (sb.mtimes.get(path(a)) ?? 0) > (sb.mtimes.get(path(b)) ?? 0);
        case "-ot": return (sb.mtimes.get(path(a)) ?? 0) < (sb.mtimes.get(path(b)) ?? 0);
        case "-ef": return path(a) === path(b);
      }
    } catch { return false; }
  }
  return toks[0] !== "";
}

// ─── $(( … )) ───────────────────────────────────────────────────────────────

class ArithEvaluator {
  private toks: string[];
  private pos = 0;
  constructor(src: string, private env: Record<string, string>) {
    this.toks = src.match(/0x[0-9a-fA-F]+|\d+|[A-Za-z_]\w*|\*\*|<<|>>|<=|>=|==|!=|&&|\|\||\+\+|--|\+=|-=|\*=|\/=|%=|[-+*/%()<>!~&|^=?:,]/g) ?? [];
  }
  evaluate(): number {
    if (this.toks.length === 0) return 0;
    const v = this.parseComma();
    if (this.pos < this.toks.length) throw new Error(`arithmetic syntax error near "${this.toks[this.pos]}"`);
    return Math.trunc(v);
  }
  private peek(): string | undefined { return this.toks[this.pos]; }
  private parseComma(): number { let v = this.parseAssign(); while (this.peek() === ",") { this.pos++; v = this.parseAssign(); } return v; }
  private parseAssign(): number {
    const t = this.peek();
    const nxt = this.toks[this.pos + 1];
    if (t && /^[A-Za-z_]\w*$/.test(t) && nxt && ["=", "+=", "-=", "*=", "/=", "%="].includes(nxt)) {
      this.pos += 2;
      const rhs = this.parseAssign();
      const cur = this.lookup(t);
      const v = nxt === "=" ? rhs : nxt === "+=" ? cur + rhs : nxt === "-=" ? cur - rhs : nxt === "*=" ? cur * rhs : nxt === "/=" ? Math.trunc(cur / rhs) : cur % rhs;
      this.env[t] = String(v);
      return v;
    }
    return this.parseTernary();
  }
  private parseTernary(): number {
    const c = this.parseBinary(0);
    if (this.peek() === "?") { this.pos++; const a = this.parseAssign(); if (this.peek() !== ":") throw new Error("arithmetic: expected ':'"); this.pos++; const b = this.parseAssign(); return c !== 0 ? a : b; }
    return c;
  }
  private static PREC: Record<string, number> = { "||": 1, "&&": 2, "|": 3, "^": 4, "&": 5, "==": 6, "!=": 6, "<": 7, "<=": 7, ">": 7, ">=": 7, "<<": 8, ">>": 8, "+": 9, "-": 9, "*": 10, "/": 10, "%": 10, "**": 11 };
  private parseBinary(minPrec: number): number {
    let left = this.parseUnary();
    for (;;) {
      const op = this.peek();
      const prec = op !== undefined ? ArithEvaluator.PREC[op] : undefined;
      if (prec === undefined || prec < minPrec) return left;
      this.pos++;
      const right = this.parseBinary(op === "**" ? prec : prec + 1);
      switch (op) {
        case "||": left = left !== 0 || right !== 0 ? 1 : 0; break;
        case "&&": left = left !== 0 && right !== 0 ? 1 : 0; break;
        case "|": left = left | right; break;
        case "^": left = left ^ right; break;
        case "&": left = left & right; break;
        case "==": left = left === right ? 1 : 0; break;
        case "!=": left = left !== right ? 1 : 0; break;
        case "<": left = left < right ? 1 : 0; break;
        case "<=": left = left <= right ? 1 : 0; break;
        case ">": left = left > right ? 1 : 0; break;
        case ">=": left = left >= right ? 1 : 0; break;
        case "<<": left = left << right; break;
        case ">>": left = left >> right; break;
        case "+": left = left + right; break;
        case "-": left = left - right; break;
        case "*": left = left * right; break;
        case "/": if (right === 0) throw new Error("division by zero"); left = Math.trunc(left / right); break;
        case "%": if (right === 0) throw new Error("division by zero"); left = left % right; break;
        case "**": left = Math.pow(left, right); break;
      }
    }
  }
  private parseUnary(): number {
    const t = this.peek();
    if (t === "-") { this.pos++; return -this.parseUnary(); }
    if (t === "+") { this.pos++; return this.parseUnary(); }
    if (t === "!") { this.pos++; return this.parseUnary() === 0 ? 1 : 0; }
    if (t === "~") { this.pos++; return ~this.parseUnary(); }
    if ((t === "++" || t === "--") && /^[A-Za-z_]\w*$/.test(this.toks[this.pos + 1] ?? "")) {
      const name = this.toks[this.pos + 1];
      this.pos += 2;
      const v = this.lookup(name) + (t === "++" ? 1 : -1);
      this.env[name] = String(v);
      return v;
    }
    return this.parsePrimary();
  }
  private parsePrimary(): number {
    const t = this.peek();
    if (t === undefined) throw new Error("arithmetic: unexpected end of expression");
    this.pos++;
    if (t === "(") { const v = this.parseComma(); if (this.peek() !== ")") throw new Error("arithmetic: expected ')'"); this.pos++; return v; }
    if (/^0x[0-9a-fA-F]+$/.test(t)) return parseInt(t, 16);
    if (/^\d+$/.test(t)) return Number(t);
    if (/^[A-Za-z_]\w*$/.test(t)) {
      const nxt = this.peek();
      if (nxt === "++" || nxt === "--") { this.pos++; const cur = this.lookup(t); this.env[t] = String(cur + (nxt === "++" ? 1 : -1)); return cur; }
      return this.lookup(t);
    }
    throw new Error(`arithmetic syntax error near "${t}"`);
  }
  private lookup(name: string): number {
    const raw = this.env[name];
    if (raw === undefined || raw.trim() === "") return 0;
    if (/^[A-Za-z_]\w*$/.test(raw.trim())) return this.lookup(raw.trim());
    const v = Number(raw.trim());
    if (!Number.isFinite(v)) throw new Error(`arithmetic: invalid number "${raw}"`);
    return Math.trunc(v);
  }
}

// ─── glob → RegExp ──────────────────────────────────────────────────────────

/** Shell glob to anchored RegExp. `matchSlash` lets `*` cross `/` (find -path, case). */
function globToRegex(pattern: string, ignoreCase = false, matchSlash = false): RegExp {
  let re = "^";
  const any = matchSlash ? "[\\s\\S]" : "[^/]";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\" && i + 1 < pattern.length) { re += escapeRegex(pattern[++i]); continue; }
    if (c === "*") { re += `${any}*`; continue; }
    if (c === "?") { re += any; continue; }
    if (c === "[") {
      const close = pattern.indexOf("]", i + 2);
      if (close > i) {
        let cls = pattern.slice(i + 1, close);
        if (cls.startsWith("!") || cls.startsWith("^")) cls = `^${cls.slice(1)}`;
        cls = cls.replace(/\[:alpha:\]/g, "a-zA-Z").replace(/\[:digit:\]/g, "0-9").replace(/\[:alnum:\]/g, "a-zA-Z0-9").replace(/\[:space:\]/g, "\\s").replace(/\[:upper:\]/g, "A-Z").replace(/\[:lower:\]/g, "a-z");
        re += `[${cls.replace(/\\/g, "\\\\")}]`;
        i = close;
        continue;
      }
    }
    re += escapeRegex(c);
  }
  return new RegExp(`${re}$`, ignoreCase ? "i" : "");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

// ─── Utilities (external commands the adapter relies on) ────────────────────

type Util = (sh: Shell, args: string[], stdin: string, env: Record<string, string>) => Promise<ShellResult> | ShellResult;

/** POSIX-ish option split: clustered short flags, `--long[=v]`, `--` ends. */
function splitFlags(args: string[], withValue: Set<string> = new Set()): { flags: Set<string>; values: Map<string, string>; rest: string[] } {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") { rest.push(...args.slice(i + 1)); break; }
    if (a.startsWith("--") && a.length > 2) {
      const eq = a.indexOf("=");
      if (eq > 0) values.set(a.slice(2, eq), a.slice(eq + 1)); else flags.add(a.slice(2));
      continue;
    }
    if (a.startsWith("-") && a.length > 1 && !/^-\d/.test(a)) {
      for (let k = 1; k < a.length; k++) {
        const f = a[k];
        if (withValue.has(f)) {
          const v = k + 1 < a.length ? a.slice(k + 1) : args[++i] ?? "";
          values.set(f, v);
          break;
        }
        flags.add(f);
      }
      continue;
    }
    rest.push(a);
  }
  return { flags, values, rest };
}

function readInputs(sh: Shell, files: string[], stdin: string, tool: string): { items: Array<{ name: string; text: string }>; err: string; code: number } {
  const items: Array<{ name: string; text: string }> = [];
  let err = "";
  let code = 0;
  if (files.length === 0) return { items: [{ name: "-", text: stdin }], err, code };
  for (const f of files) {
    if (f === "-") { items.push({ name: "-", text: stdin }); continue; }
    const p = sh.sb.resolve(f, sh.st.cwd);
    const buf = sh.sb.files.get(p);
    if (!buf) { err += sh.sb.isDir(p) ? `${tool}: ${f}: Is a directory\n` : `${tool}: ${f}: No such file or directory\n`; code = tool === "grep" || tool === "ls" ? 2 : 1; continue; }
    items.push({ name: f, text: buf.toString("utf8") });
  }
  return { items, err, code };
}

function unescapeC(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== "\\") { out += c; continue; }
    const n = s[++i];
    switch (n) {
      case "n": out += "\n"; break;
      case "t": out += "\t"; break;
      case "r": out += "\r"; break;
      case "a": out += "\x07"; break;
      case "b": out += "\b"; break;
      case "f": out += "\f"; break;
      case "v": out += "\v"; break;
      case "e": case "E": out += "\x1b"; break;
      case "\\": out += "\\"; break;
      case "0": { const m = /^[0-7]{1,3}/.exec(s.slice(i + 1)); if (m) { out += String.fromCharCode(parseInt(m[0], 8)); i += m[0].length; } else out += "\0"; break; }
      case "x": { const m = /^[0-9a-fA-F]{1,2}/.exec(s.slice(i + 1)); if (m) { out += String.fromCharCode(parseInt(m[0], 16)); i += m[0].length; } else out += "\\x"; break; }
      case "c": return out;
      case undefined: out += "\\"; break;
      default: out += `\\${n}`;
    }
  }
  return out;
}

function formatPrintf(fmt: string, args: string[]): { text: string; consumed: number } {
  let out = "";
  let consumed = 0;
  const next = () => { if (consumed < args.length) return args[consumed++]; consumed++; return undefined; };
  for (let i = 0; i < fmt.length; i++) {
    const c = fmt[i];
    if (c === "\\") {
      const r = unescapeC(fmt.slice(i, i + 5));
      const m = /^\\(0[0-7]{0,3}|x[0-9a-fA-F]{1,2}|.)/.exec(fmt.slice(i));
      out += unescapeC(m ? m[0] : "\\");
      i += (m ? m[0].length : 1) - 1;
      void r;
      continue;
    }
    if (c !== "%") { out += c; continue; }
    const m = /^%([-+ 0#]*)(\d+|\*)?(?:\.(\d+|\*))?([sdiouxXcbeEfgGq%])/.exec(fmt.slice(i));
    if (!m) { out += "%"; continue; }
    i += m[0].length - 1;
    const [, flags, widthRaw, precRaw, conv] = m;
    if (conv === "%") { out += "%"; continue; }
    const width = widthRaw === "*" ? Number(next() ?? 0) : widthRaw ? Number(widthRaw) : 0;
    const prec = precRaw === "*" ? Number(next() ?? 0) : precRaw !== undefined ? Number(precRaw) : undefined;
    const arg = next();
    let s: string;
    switch (conv) {
      case "s": s = arg ?? ""; if (prec !== undefined) s = s.slice(0, prec); break;
      case "b": s = unescapeC(arg ?? ""); break;
      case "q": s = arg === undefined ? "''" : /^[A-Za-z0-9_./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`; break;
      case "c": s = (arg ?? "").slice(0, 1); break;
      case "d": case "i": case "u": { const n = toInt(arg); s = String(n); if (flags.includes("+") && n >= 0) s = `+${s}`; break; }
      case "o": s = Math.trunc(toInt(arg)).toString(8); break;
      case "x": s = Math.trunc(toInt(arg)).toString(16); break;
      case "X": s = Math.trunc(toInt(arg)).toString(16).toUpperCase(); break;
      case "e": case "E": s = Number(arg ?? 0).toExponential(prec ?? 6); if (conv === "E") s = s.toUpperCase(); break;
      case "f": s = Number(arg ?? 0).toFixed(prec ?? 6); break;
      case "g": case "G": s = String(Number(arg ?? 0)); break;
      default: s = arg ?? "";
    }
    if (width > s.length) {
      if (flags.includes("-")) s = s.padEnd(width);
      else if (flags.includes("0") && "diouxXeEfgG".includes(conv)) s = s.startsWith("-") ? `-${s.slice(1).padStart(width - 1, "0")}` : s.padStart(width, "0");
      else s = s.padStart(width);
    }
    out += s;
  }
  return { text: out, consumed };
}

function toInt(s: string | undefined): number {
  if (s === undefined) return 0;
  const t = s.trim();
  if (/^0x[0-9a-fA-F]+$/i.test(t)) return parseInt(t, 16);
  if (/^0[0-7]+$/.test(t)) return parseInt(t, 8);
  const n = parseInt(t, 10);
  return Number.isFinite(n) ? n : 0;
}

function formatDate(fmt: string, ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return fmt.replace(/%(\d)?([a-zA-Z%])/g, (_m, digits: string | undefined, k: string) => {
    switch (k) {
      case "Y": return String(d.getUTCFullYear());
      case "y": return p(d.getUTCFullYear() % 100);
      case "m": return p(d.getUTCMonth() + 1);
      case "d": return p(d.getUTCDate());
      case "e": return String(d.getUTCDate()).padStart(2, " ");
      case "H": return p(d.getUTCHours());
      case "I": return p(d.getUTCHours() % 12 || 12);
      case "M": return p(d.getUTCMinutes());
      case "S": return p(d.getUTCSeconds());
      case "s": return String(Math.floor(ms / 1000));
      case "N": { const ns = String((ms % 1000) * 1_000_000).padStart(9, "0"); return digits ? ns.slice(0, Number(digits)) : ns; }
      case "z": return "+0000";
      case "Z": return "UTC";
      case "F": return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
      case "T": return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
      case "R": return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
      case "D": return `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}/${p(d.getUTCFullYear() % 100)}`;
      case "a": return days[d.getUTCDay()];
      case "A": return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d.getUTCDay()];
      case "b": case "h": return months[d.getUTCMonth()];
      case "B": return ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][d.getUTCMonth()];
      case "j": return p(Math.floor((ms - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86_400_000) + 1, 3);
      case "u": return String(d.getUTCDay() || 7);
      case "w": return String(d.getUTCDay());
      case "n": return "\n";
      case "t": return "\t";
      case "%": return "%";
      default: return `%${k}`;
    }
  });
}

function parseHttpUrl(url: string): { host: string; port: string } {
  const m = /^https?:\/\/([^/:?#]+)(?::(\d+))?/.exec(url);
  return { host: m?.[1] ?? url, port: m?.[2] ?? (url.startsWith("https") ? "443" : "80") };
}

function resolveHttp(sb: FakeSandboxInstance, url: string): FakeHttpResponse | null {
  const candidates = [url, url.replace(/\/+$/, ""), `${url}/`];
  for (const c of candidates) {
    const r = sb.httpResponses.get(c);
    if (r === undefined) continue;
    const v = typeof r === "function" ? r() : r;
    return typeof v === "string" ? { status: 200, body: v } : v;
  }
  return null;
}

const HTTP_STATUS_TEXT: Record<number, string> = { 200: "OK", 201: "Created", 204: "No Content", 301: "Moved Permanently", 302: "Found", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 409: "Conflict", 500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable" };

const UTILS: Record<string, Util> = {
  echo(_sh, args) {
    let i = 0;
    let newline = true;
    let escapes = false;
    while (i < args.length && /^-[neE]+$/.test(args[i])) {
      if (args[i].includes("n")) newline = false;
      if (args[i].includes("e")) escapes = true;
      if (args[i].includes("E")) escapes = false;
      i++;
    }
    const text = args.slice(i).join(" ");
    return res(0, (escapes ? unescapeC(text) : text) + (newline ? "\n" : ""));
  },

  printf(_sh, args) {
    if (args.length === 0) return res(2, "", "printf: usage: printf format [arguments]\n");
    const fmt = args[0] === "--" ? args[1] ?? "" : args[0];
    let rest = args.slice(args[0] === "--" ? 2 : 1);
    let out = "";
    for (;;) {
      const r = formatPrintf(fmt, rest);
      out += r.text;
      if (r.consumed === 0 || r.consumed >= rest.length) break;
      rest = rest.slice(r.consumed);
    }
    return res(0, out);
  },

  cat(sh, args, stdin) {
    const { rest } = splitFlags(args);
    const { items, err, code } = readInputs(sh, rest, stdin, "cat");
    return res(code, items.map((i) => i.text).join(""), err);
  },

  mkdir(sh, args) {
    const { flags, rest } = splitFlags(args, new Set(["m"]));
    if (rest.length === 0) return res(1, "", "mkdir: missing operand\n");
    const parents = flags.has("p") || flags.has("parents");
    let err = "";
    let code = 0;
    for (const d of rest) {
      const p = sh.sb.resolve(d, sh.st.cwd);
      if (sh.sb.exists(p)) {
        if (!parents || sh.sb.isFile(p)) { err += `mkdir: cannot create directory '${d}': File exists\n`; code = 1; }
        continue;
      }
      if (!parents && !sh.sb.isDir(parentPath(p))) { err += `mkdir: cannot create directory '${d}': No such file or directory\n`; code = 1; continue; }
      sh.sb.mkdirp(p);
    }
    return res(code, "", err);
  },

  rmdir(sh, args) {
    const { rest } = splitFlags(args);
    let err = "";
    let code = 0;
    for (const d of rest) {
      const p = sh.sb.resolve(d, sh.st.cwd);
      if (!sh.sb.isDir(p)) { err += `rmdir: failed to remove '${d}': ${sh.sb.exists(p) ? "Not a directory" : "No such file or directory"}\n`; code = 1; continue; }
      if (sh.sb.listDir(p).length > 0) { err += `rmdir: failed to remove '${d}': Directory not empty\n`; code = 1; continue; }
      sh.sb.removeTree(p);
    }
    return res(code, "", err);
  },

  rm(sh, args) {
    const { flags, rest } = splitFlags(args);
    const recursive = flags.has("r") || flags.has("R") || flags.has("recursive");
    const force = flags.has("f") || flags.has("force");
    if (rest.length === 0) return force ? res(0) : res(1, "", "rm: missing operand\n");
    let err = "";
    let code = 0;
    for (const t of rest) {
      const p = sh.sb.resolve(t, sh.st.cwd);
      if (!sh.sb.exists(p)) { if (!force) { err += `rm: cannot remove '${t}': No such file or directory\n`; code = 1; } continue; }
      if (sh.sb.isDir(p) && !recursive) { err += `rm: cannot remove '${t}': Is a directory\n`; code = 1; continue; }
      if (p === "/") { err += "rm: it is dangerous to operate recursively on '/'\n"; code = 1; continue; }
      sh.sb.removeTree(p);
    }
    return res(code, "", err);
  },

  touch(sh, args) {
    const { flags, rest } = splitFlags(args, new Set(["d", "t", "r"]));
    if (rest.length === 0) return res(1, "", "touch: missing file operand\n");
    let err = "";
    let code = 0;
    for (const t of rest) {
      const p = sh.sb.resolve(t, sh.st.cwd);
      if (sh.sb.exists(p)) { sh.sb.mtimes.set(p, sh.sb.now()); continue; }
      if (flags.has("c")) continue;
      if (!sh.sb.isDir(parentPath(p))) { err += `touch: cannot touch '${t}': No such file or directory\n`; code = 1; continue; }
      sh.sb.writeFileAt(p, Buffer.alloc(0));
    }
    return res(code, "", err);
  },

  chmod(sh, args) { return changeMode(sh, "chmod", args, true); },
  chown(sh, args) { return changeMode(sh, "chown", args, false); },
  chgrp(sh, args) { return changeMode(sh, "chgrp", args, false); },

  cp(sh, args) { return copyOrMove(sh, "cp", args); },
  mv(sh, args) { return copyOrMove(sh, "mv", args); },

  ln(sh, args) {
    // No symlink model: `ln -s target link` materialises a copy when the target exists.
    const { rest } = splitFlags(args);
    if (rest.length < 2) return res(1, "", "ln: missing file operand\n");
    const src = sh.sb.resolve(rest[0], sh.st.cwd);
    const dst = sh.sb.resolve(rest[1], sh.st.cwd);
    if (sh.sb.exists(src)) sh.sb.copyTree(src, dst); else sh.sb.writeFileAt(dst, Buffer.alloc(0));
    return res(0);
  },

  ls(sh, args) {
    const { flags, rest } = splitFlags(args);
    const paths = rest.length ? rest : ["."];
    const all = flags.has("a") || flags.has("A") || flags.has("all");
    const long = flags.has("l");
    let out = "";
    let err = "";
    let code = 0;
    const fmtEntry = (full: string, shown: string) => {
      if (!long) return `${shown}\n`;
      const isDir = sh.sb.isDir(full);
      const size = isDir ? 4096 : (sh.sb.files.get(full)?.byteLength ?? 0);
      const d = new Date(sh.sb.mtimes.get(full) ?? sh.sb.createdAt);
      const stamp = `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, " ")} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
      return `${isDir ? "drwxr-xr-x" : "-rw-r--r--"} 1 root root ${String(size).padStart(6, " ")} ${stamp} ${shown}\n`;
    };
    for (const t of paths) {
      const p = sh.sb.resolve(t, sh.st.cwd);
      if (!sh.sb.exists(p)) { err += `ls: cannot access '${t}': No such file or directory\n`; code = 2; continue; }
      if (sh.sb.isFile(p) || flags.has("d")) { out += fmtEntry(p, t); continue; }
      if (paths.length > 1) out += `${out ? "\n" : ""}${t}:\n`;
      const names = sh.sb.listDir(p).filter((n) => all || !n.startsWith("."));
      if (long) out += `total ${names.length}\n`;
      for (const n of names) out += fmtEntry(joinPath(p, n), n);
    }
    return res(code, out, err);
  },

  async find(sh, args) { return findUtil(sh, args); },

  head(sh, args, stdin) { return headTail(sh, "head", args, stdin); },
  tail(sh, args, stdin) { return headTail(sh, "tail", args, stdin); },

  grep(sh, args, stdin) {
    const { flags, values, rest } = splitFlags(args, new Set(["e", "m", "A", "B", "C"]));
    let pattern = values.get("e");
    let files = rest;
    if (pattern === undefined) { if (rest.length === 0) return res(2, "", "grep: missing pattern\n"); pattern = rest[0]; files = rest.slice(1); }
    const fixed = flags.has("F");
    const word = flags.has("w");
    const line = flags.has("x");
    let source = fixed ? escapeRegex(pattern) : pattern;
    if (word) source = `\\b(?:${source})\\b`;
    if (line) source = `^(?:${source})$`;
    let re: RegExp;
    try { re = new RegExp(source, flags.has("i") ? "i" : ""); } catch (e) { return res(2, "", `grep: ${(e as Error).message}\n`); }
    const invert = flags.has("v");
    const { items, err, code } = readInputs(sh, files, stdin, "grep");
    if (flags.has("s")) { /* suppress file errors */ }
    const showName = (flags.has("H") || (items.length > 1 && !flags.has("h")));
    let out = "";
    let matched = false;
    const max = values.has("m") ? Number(values.get("m")) : Infinity;
    for (const it of items) {
      const lines = it.text.split("\n");
      if (lines[lines.length - 1] === "") lines.pop();
      let count = 0;
      for (let idx = 0; idx < lines.length; idx++) {
        const l = lines[idx];
        const hit = re.test(l) !== invert;
        if (!hit) continue;
        matched = true;
        count++;
        if (flags.has("q")) return res(0);
        if (!flags.has("c") && !flags.has("l")) {
          const prefix = `${showName ? `${it.name === "-" ? "(standard input)" : it.name}:` : ""}${flags.has("n") ? `${idx + 1}:` : ""}`;
          if (flags.has("o")) { const m = l.match(new RegExp(re.source, `g${flags.has("i") ? "i" : ""}`)); for (const piece of m ?? []) out += `${prefix}${piece}\n`; }
          else out += `${prefix}${l}\n`;
        }
        if (count >= max) break;
      }
      if (flags.has("c")) out += `${showName ? `${it.name}:` : ""}${count}\n`;
      if (flags.has("l") && count > 0) out += `${it.name === "-" ? "(standard input)" : it.name}\n`;
    }
    return res(code === 2 && !flags.has("s") ? 2 : matched ? 0 : 1, out, flags.has("s") ? "" : err);
  },

  wc(sh, args, stdin) {
    const { flags, rest } = splitFlags(args);
    const { items, err, code } = readInputs(sh, rest, stdin, "wc");
    const want = { l: flags.has("l"), w: flags.has("w"), c: flags.has("c") || flags.has("m") };
    if (!want.l && !want.w && !want.c) { want.l = true; want.w = true; want.c = true; }
    let out = "";
    const totals = { l: 0, w: 0, c: 0 };
    for (const it of items) {
      const l = (it.text.match(/\n/g) ?? []).length;
      const w = it.text.split(/\s+/).filter(Boolean).length;
      const c = Buffer.byteLength(it.text, "utf8");
      totals.l += l; totals.w += w; totals.c += c;
      const cols = [want.l ? l : null, want.w ? w : null, want.c ? c : null].filter((x): x is number => x !== null);
      out += `${cols.join(" ")}${it.name === "-" ? "" : ` ${it.name}`}\n`;
    }
    if (items.length > 1) out += `${[want.l ? totals.l : null, want.w ? totals.w : null, want.c ? totals.c : null].filter((x) => x !== null).join(" ")} total\n`;
    return res(code, out, err);
  },

  sort(sh, args, stdin) {
    const { flags, rest } = splitFlags(args, new Set(["k", "t"]));
    const { items, err, code } = readInputs(sh, rest, stdin, "sort");
    let lines = items.flatMap((i) => i.text.split("\n"));
    if (lines[lines.length - 1] === "") lines.pop();
    lines = lines.filter((l, idx, arr) => !(l === "" && idx === arr.length - 1 && arr.length > 1) || true);
    const numeric = flags.has("n");
    lines.sort((a, b) => numeric ? (parseFloat(a) || 0) - (parseFloat(b) || 0) : a < b ? -1 : a > b ? 1 : 0);
    if (flags.has("r")) lines.reverse();
    if (flags.has("u")) lines = lines.filter((l, i, arr) => i === 0 || l !== arr[i - 1]);
    return res(code, lines.length ? `${lines.join("\n")}\n` : "", err);
  },

  uniq(sh, args, stdin) {
    const { flags, rest } = splitFlags(args);
    const { items, err, code } = readInputs(sh, rest.slice(0, 1), stdin, "uniq");
    const lines = items.flatMap((i) => i.text.split("\n"));
    if (lines[lines.length - 1] === "") lines.pop();
    const groups: Array<{ line: string; n: number }> = [];
    for (const l of lines) { const last = groups[groups.length - 1]; if (last && last.line === l) last.n++; else groups.push({ line: l, n: 1 }); }
    const chosen = groups.filter((g) => flags.has("d") ? g.n > 1 : flags.has("u") ? g.n === 1 : true);
    const out = chosen.map((g) => flags.has("c") ? `${String(g.n).padStart(7, " ")} ${g.line}\n` : `${g.line}\n`).join("");
    return res(code, out, err);
  },

  cut(sh, args, stdin) {
    const { flags, values, rest } = splitFlags(args, new Set(["d", "f", "c", "b"]));
    const { items, err, code } = readInputs(sh, rest, stdin, "cut");
    const delim = values.get("d") ?? "\t";
    const parseList = (spec: string): Array<[number, number]> => spec.split(",").map((part) => {
      const m = /^(\d*)(?:-(\d*))?$/.exec(part.trim());
      if (!m) return [1, 1];
      const a = m[1] ? Number(m[1]) : 1;
      const b = part.includes("-") ? (m[2] ? Number(m[2]) : Infinity) : a;
      return [a, b];
    });
    const inRange = (idx: number, ranges: Array<[number, number]>) => ranges.some(([a, b]) => idx >= a && idx <= b);
    let out = "";
    for (const it of items) {
      const lines = it.text.split("\n");
      if (lines[lines.length - 1] === "") lines.pop();
      for (const l of lines) {
        if (values.has("f")) {
          if (!l.includes(delim)) { if (!flags.has("s")) out += `${l}\n`; continue; }
          const ranges = parseList(values.get("f")!);
          out += `${l.split(delim).filter((_f, i) => inRange(i + 1, ranges)).join(delim)}\n`;
        } else {
          const ranges = parseList(values.get("c") ?? values.get("b") ?? "1-");
          out += `${[...l].filter((_ch, i) => inRange(i + 1, ranges)).join("")}\n`;
        }
      }
    }
    return res(code, out, err);
  },

  tr(_sh, args, stdin) {
    const { flags, rest } = splitFlags(args);
    const expand = (set: string) => {
      let s = unescapeC(set)
        .replace(/\[:upper:\]/g, "ABCDEFGHIJKLMNOPQRSTUVWXYZ").replace(/\[:lower:\]/g, "abcdefghijklmnopqrstuvwxyz")
        .replace(/\[:digit:\]/g, "0123456789").replace(/\[:space:\]/g, " \t\n\r\f\v").replace(/\[:alpha:\]/g, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz")
        .replace(/\[:alnum:\]/g, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789").replace(/\[:punct:\]/g, "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~");
      s = s.replace(/(.)-(.)/g, (_m, a: string, b: string) => { let r = ""; for (let c = a.charCodeAt(0); c <= b.charCodeAt(0); c++) r += String.fromCharCode(c); return r; });
      return [...s];
    };
    const set1 = expand(rest[0] ?? "");
    if (flags.has("d")) return res(0, [...stdin].filter((c) => !set1.includes(c)).join(""));
    const set2 = expand(rest[1] ?? "");
    let out = [...stdin].map((c) => { const i = set1.indexOf(c); return i < 0 ? c : (set2[i] ?? set2[set2.length - 1] ?? c); }).join("");
    if (flags.has("s")) out = out.replace(new RegExp(`([${set2.map(escapeRegex).join("")}])\\1+`, "g"), "$1");
    return res(0, out);
  },

  tee(sh, args, stdin) {
    const { flags, rest } = splitFlags(args);
    for (const f of rest) {
      const p = sh.sb.resolve(f, sh.st.cwd);
      const prev = flags.has("a") ? sh.sb.files.get(p) ?? Buffer.alloc(0) : Buffer.alloc(0);
      sh.sb.writeFileAt(p, Buffer.concat([prev, Buffer.from(stdin, "utf8")]));
    }
    return res(0, stdin);
  },

  base64(sh, args, stdin) {
    const { flags, rest } = splitFlags(args, new Set(["w"]));
    const { items, err, code } = readInputs(sh, rest, stdin, "base64");
    const input = items.map((i) => i.text).join("");
    if (flags.has("d") || flags.has("decode")) return res(code, Buffer.from(input.replace(/\s+/g, ""), "base64").toString("utf8"), err);
    return res(code, `${Buffer.from(input, "utf8").toString("base64")}\n`, err);
  },

  sha256sum(sh, args, stdin) { return checksum(sh, "sha256", args, stdin); },
  md5sum(sh, args, stdin) { return checksum(sh, "md5", args, stdin); },
  sha1sum(sh, args, stdin) { return checksum(sh, "sha1", args, stdin); },

  date(sh, args) {
    const { rest } = splitFlags(args, new Set(["d", "r", "s"]));
    const fmt = rest.find((a) => a.startsWith("+"));
    const ms = sh.sb.now();
    if (fmt) return res(0, `${formatDate(fmt.slice(1), ms)}\n`);
    return res(0, `${formatDate("%a %b %e %H:%M:%S UTC %Y", ms)}\n`);
  },

  stat(sh, args) {
    const { flags, values, rest } = splitFlags(args, new Set(["c"]));
    const fmt = values.get("c") ?? values.get("format") ?? null;
    let out = "";
    let err = "";
    let code = 0;
    for (const t of rest) {
      const p = sh.sb.resolve(t, sh.st.cwd);
      if (!sh.sb.exists(p)) { err += `stat: cannot statx '${t}': No such file or directory\n`; code = 1; continue; }
      const isDir = sh.sb.isDir(p);
      const size = isDir ? 4096 : (sh.sb.files.get(p)?.byteLength ?? 0);
      const mtime = Math.floor((sh.sb.mtimes.get(p) ?? sh.sb.createdAt) / 1000);
      const fields: Record<string, string> = {
        s: String(size), Y: String(mtime), X: String(mtime), Z: String(mtime), n: t, N: `'${t}'`,
        F: isDir ? "directory" : "regular file", a: isDir ? "755" : "644", A: isDir ? "drwxr-xr-x" : "-rw-r--r--",
        U: "root", G: "root", u: "0", g: "0", h: "1", i: String(hashInt(p)), d: "0", W: "0", b: String(Math.ceil(size / 512)), B: "512",
      };
      if (fmt) out += `${fmt.replace(/%([a-zA-Z%])/g, (_m, k: string) => k === "%" ? "%" : fields[k] ?? `%${k}`)}\n`;
      else out += `  File: ${t}\n  Size: ${size}\tBlocks: ${Math.ceil(size / 512)}\tIO Block: 4096   ${fields.F}\nAccess: (0${fields.a}/${fields.A})  Uid: (    0/    root)   Gid: (    0/    root)\nModify: ${new Date(mtime * 1000).toISOString()}\n`;
    }
    void flags;
    return res(code, out, err);
  },

  dirname(_sh, args) {
    const { rest } = splitFlags(args);
    if (rest.length === 0) return res(1, "", "dirname: missing operand\n");
    return res(0, rest.map((p) => { const s = p.replace(/\/+$/, "") || "/"; const i = s.lastIndexOf("/"); return i < 0 ? "." : i === 0 ? "/" : s.slice(0, i); }).join("\n") + "\n");
  },

  basename(_sh, args) {
    const { flags, values, rest } = splitFlags(args, new Set(["s"]));
    if (rest.length === 0) return res(1, "", "basename: missing operand\n");
    const suffix = values.get("s") ?? (flags.has("a") ? undefined : rest[1]);
    const names = flags.has("a") || values.has("s") ? rest : rest.slice(0, 1);
    return res(0, names.map((p) => { let b = baseName(p.replace(/\/+$/, "") || "/"); if (suffix && b.endsWith(suffix) && b !== suffix) b = b.slice(0, -suffix.length); return b; }).join("\n") + "\n");
  },

  readlink(sh, args) {
    const { flags, rest } = splitFlags(args);
    if (rest.length === 0) return res(1, "", "readlink: missing operand\n");
    if (!flags.has("f") && !flags.has("e") && !flags.has("m")) return res(1); // no symlinks
    const p = sh.sb.resolve(rest[0], sh.st.cwd);
    if (flags.has("e") && !sh.sb.exists(p)) return res(1);
    return res(0, `${p}\n`);
  },

  realpath(sh, args) {
    const { flags, rest } = splitFlags(args);
    let out = "";
    let err = "";
    let code = 0;
    for (const t of rest) {
      const p = sh.sb.resolve(t, sh.st.cwd);
      if (!flags.has("m") && !sh.sb.exists(p)) { err += `realpath: ${t}: No such file or directory\n`; code = 1; continue; }
      out += `${p}\n`;
    }
    return res(code, out, err);
  },

  id(_sh, args) {
    const { flags } = splitFlags(args);
    if (flags.has("u")) return res(0, flags.has("n") ? "root\n" : "0\n");
    if (flags.has("g")) return res(0, flags.has("n") ? "root\n" : "0\n");
    return res(0, "uid=0(root) gid=0(root) groups=0(root)\n");
  },
  whoami: () => res(0, "root\n"),
  hostname: (sh) => res(0, `${sh.sb.id}\n`),
  uname(sh, args) {
    const { flags } = splitFlags(args);
    if (flags.has("a")) return res(0, `Linux ${sh.sb.id} 6.1.0-fake #1 SMP x86_64 GNU/Linux\n`);
    if (flags.has("m")) return res(0, "x86_64\n");
    if (flags.has("r")) return res(0, "6.1.0-fake\n");
    if (flags.has("n")) return res(0, `${sh.sb.id}\n`);
    return res(0, "Linux\n");
  },
  nproc: () => res(0, "2\n"),
  arch: () => res(0, "x86_64\n"),

  seq(_sh, args) {
    const { values, rest } = splitFlags(args, new Set(["s"]));
    const nums = rest.map(Number);
    if (nums.length === 0 || nums.some((n) => !Number.isFinite(n))) return res(1, "", "seq: invalid argument\n");
    const [first, incr, last] = nums.length === 1 ? [1, 1, nums[0]] : nums.length === 2 ? [nums[0], 1, nums[1]] : [nums[0], nums[1], nums[2]];
    const out: string[] = [];
    if (incr === 0) return res(1, "", "seq: zero increment\n");
    for (let v = first; incr > 0 ? v <= last : v >= last; v += incr) { out.push(String(v)); if (out.length > 1_000_000) break; }
    const sep = values.get("s") ?? "\n";
    return res(0, out.length ? `${out.join(sep)}\n` : "");
  },

  mktemp(sh, args) {
    const { flags, values, rest } = splitFlags(args, new Set(["p"]));
    const dir = values.get("p") ?? values.get("tmpdir") ?? "/tmp";
    const template = rest[0] ?? "tmp.XXXXXXXXXX";
    const name = template.replace(/X+$/, (m) => randomHex(m.length));
    const p = name.startsWith("/") ? name : sh.sb.resolve(name, dir);
    if (!sh.sb.isDir(parentPath(p))) return res(1, "", `mktemp: failed to create ${flags.has("d") ? "directory" : "file"} via template '${template}': No such file or directory\n`);
    if (flags.has("d") || flags.has("directory")) sh.sb.mkdirp(p); else sh.sb.writeFileAt(p, Buffer.alloc(0));
    return res(0, `${p}\n`);
  },

  curl(sh, args) {
    let url: string | null = null;
    let fail = false;
    let silent = false;
    let showErr = false;
    let outFile: string | null = null;
    let writeOut = "";
    let headOnly = false;
    let method = "GET";
    const headers: string[] = [];
    let body: string | undefined;
    const takesValue = new Set(["o", "w", "m", "H", "d", "X", "u", "A", "e", "b", "c", "E", "K", "T", "F", "x", "y", "Y", "z", "Q", "r", "t", "U", "D"]);
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "--") { url = args[i + 1] ?? url; break; }
      if (a.startsWith("--")) {
        const [name, inlineVal] = a.slice(2).split("=", 2);
        const needsVal = ["output", "write-out", "max-time", "connect-timeout", "header", "data", "data-raw", "data-binary", "request", "user", "user-agent", "referer", "retry", "retry-delay", "retry-max-time", "url", "upload-file", "form", "cookie", "proxy", "resolve", "cacert"].includes(name);
        const val = needsVal ? (inlineVal ?? args[++i] ?? "") : undefined;
        if (name === "fail" || name === "fail-with-body") fail = true;
        else if (name === "silent") silent = true;
        else if (name === "show-error") showErr = true;
        else if (name === "head") headOnly = true;
        else if (name === "output") outFile = val ?? null;
        else if (name === "write-out") writeOut = val ?? "";
        else if (name === "request") method = val ?? method;
        else if (name === "header") headers.push(val ?? "");
        else if (name?.startsWith("data")) { body = val; if (method === "GET") method = "POST"; }
        else if (name === "url") url = val ?? url;
        continue;
      }
      if (a.startsWith("-") && a.length > 1) {
        for (let k = 1; k < a.length; k++) {
          const f = a[k];
          if (takesValue.has(f)) {
            const v = k + 1 < a.length ? a.slice(k + 1) : args[++i] ?? "";
            if (f === "o") outFile = v; else if (f === "w") writeOut = v; else if (f === "X") method = v; else if (f === "H") headers.push(v); else if (f === "d") { body = v; if (method === "GET") method = "POST"; }
            break;
          }
          if (f === "f") fail = true; else if (f === "s") silent = true; else if (f === "S") showErr = true; else if (f === "I") headOnly = true;
        }
        continue;
      }
      url = a;
    }
    if (!url) return res(2, "", "curl: no URL specified!\n");
    sh.sb.httpRequests.push({ url, method: headOnly ? "HEAD" : method, headers, body });
    const r = resolveHttp(sh.sb, url);
    const { host, port } = parseHttpUrl(url);
    if (!r) return res(7, "", silent && !showErr ? "" : `curl: (7) Failed to connect to ${host} port ${port} after 0 ms: Couldn't connect to server\n`);
    if (fail && r.status >= 400) return res(22, "", silent && !showErr ? "" : `curl: (22) The requested URL returned error: ${r.status}\n`);
    let out = headOnly
      ? `HTTP/1.1 ${r.status} ${HTTP_STATUS_TEXT[r.status] ?? ""}\r\n${Object.entries(r.headers ?? {}).map(([k, v]) => `${k}: ${v}\r\n`).join("")}\r\n`
      : r.body;
    if (outFile && outFile !== "-") {
      const p = sh.sb.resolve(outFile, sh.st.cwd);
      if (!sh.sb.isDir(parentPath(p))) return res(23, "", `curl: (23) Failed writing body\n`);
      sh.sb.writeFileAt(p, Buffer.from(out, "utf8"));
      out = "";
    }
    if (writeOut) out += unescapeC(writeOut).replace(/%\{(\w+)\}/g, (_m, k: string) => k === "http_code" || k === "response_code" ? String(r.status) : k === "url_effective" ? url! : k === "size_download" ? String(Buffer.byteLength(r.body)) : "");
    return res(0, out);
  },

  wget(sh, args) {
    let url: string | null = null;
    let outFile: string | null = null;
    let quiet = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "-O" || a === "--output-document") { outFile = args[++i] ?? null; continue; }
      if (a.startsWith("--output-document=")) { outFile = a.split("=", 2)[1]; continue; }
      if (a === "-q" || a === "--quiet" || a === "-nv") { quiet = true; continue; }
      if (a === "-T" || a === "-t" || a === "--timeout" || a === "--tries" || a === "--header" || a === "--post-data") { i++; continue; }
      if (a.startsWith("-")) continue;
      url = a;
    }
    if (!url) return res(1, "", "wget: missing URL\n");
    sh.sb.httpRequests.push({ url, method: "GET", headers: [] });
    const r = resolveHttp(sh.sb, url);
    const { host } = parseHttpUrl(url);
    if (!r) return res(4, "", quiet ? "" : `wget: unable to resolve host address '${host}'\n`);
    if (r.status >= 400) return res(8, "", quiet ? "" : `wget: server returned error: HTTP/1.1 ${r.status} ${HTTP_STATUS_TEXT[r.status] ?? ""}\n`);
    if (outFile === "-") return res(0, r.body);
    const target = sh.sb.resolve(outFile ?? (baseName(url.replace(/[?#].*$/, "")) || "index.html"), sh.st.cwd);
    sh.sb.writeFileAt(target, Buffer.from(r.body, "utf8"));
    return res(0);
  },
};

function changeMode(sh: Shell, tool: string, args: string[], record: boolean): ShellResult {
  const { flags, rest } = splitFlags(args, new Set(["-reference"]));
  const recursive = flags.has("R") || flags.has("recursive");
  const quiet = flags.has("f") || flags.has("silent") || flags.has("quiet");
  const [mode, ...paths] = rest;
  if (!mode || paths.length === 0) return res(1, "", `${tool}: missing operand\n`);
  let err = "";
  let code = 0;
  for (const t of paths) {
    const p = sh.sb.resolve(t, sh.st.cwd);
    if (!sh.sb.exists(p)) { if (!quiet) err += `${tool}: cannot access '${t}': No such file or directory\n`; code = 1; continue; }
    if (record) sh.sb.modeChanges.push({ path: p, mode, recursive });
  }
  return res(code, "", err);
}

function copyOrMove(sh: Shell, tool: "cp" | "mv", args: string[]): ShellResult {
  const { flags, values, rest } = splitFlags(args, new Set(["t"]));
  const recursive = tool === "mv" || flags.has("r") || flags.has("R") || flags.has("a") || flags.has("recursive");
  const noClobber = flags.has("n");
  let dstArg = values.get("t") ?? values.get("target-directory");
  const srcs = dstArg ? rest : rest.slice(0, -1);
  if (!dstArg) dstArg = rest[rest.length - 1];
  if (!dstArg || srcs.length === 0) return res(1, "", `${tool}: missing file operand\n`);
  const dst = sh.sb.resolve(dstArg, sh.st.cwd);
  if (srcs.length > 1 && !sh.sb.isDir(dst)) return res(1, "", `${tool}: target '${dstArg}' is not a directory\n`);
  let err = "";
  let code = 0;
  for (const s of srcs) {
    const p = sh.sb.resolve(s, sh.st.cwd);
    if (!sh.sb.exists(p)) { err += `${tool}: cannot stat '${s}': No such file or directory\n`; code = 1; continue; }
    if (sh.sb.isDir(p) && !recursive) { err += `${tool}: -r not specified; omitting directory '${s}'\n`; code = 1; continue; }
    const target = sh.sb.isDir(dst) ? joinPath(dst, baseName(p)) : dst;
    if (!sh.sb.isDir(parentPath(target))) { err += `${tool}: cannot create '${target}': No such file or directory\n`; code = 1; continue; }
    if (noClobber && sh.sb.exists(target)) continue;
    if (target === p) continue;
    if (sh.sb.isDir(p) && target.startsWith(`${p}/`)) { err += `${tool}: cannot ${tool === "cp" ? "copy" : "move"} '${s}' into itself\n`; code = 1; continue; }
    if (sh.sb.isFile(target) && sh.sb.isDir(p)) { err += `${tool}: cannot overwrite non-directory '${target}' with directory '${s}'\n`; code = 1; continue; }
    if (tool === "cp") sh.sb.copyTree(p, target); else sh.sb.moveTree(p, target);
  }
  return res(code, "", err);
}

function headTail(sh: Shell, tool: "head" | "tail", args: string[], stdin: string): ShellResult {
  let n = 10;
  let bytes: number | null = null;
  const files: string[] = [];
  let fromStart = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-n" || a === "--lines") { const v = args[++i] ?? "10"; fromStart = v.startsWith("+"); n = Number(v.replace(/^[+-]/, "")); continue; }
    if (a.startsWith("-n")) { const v = a.slice(2); fromStart = v.startsWith("+"); n = Number(v.replace(/^[+-]/, "")); continue; }
    if (a === "-c" || a === "--bytes") { bytes = Number((args[++i] ?? "0").replace(/^[+-]/, "")); continue; }
    if (a.startsWith("-c")) { bytes = Number(a.slice(2).replace(/^[+-]/, "")); continue; }
    if (/^-\d+$/.test(a)) { n = Number(a.slice(1)); continue; }
    if (a === "-q" || a === "-v" || a === "-f" || a === "-F" || a === "--quiet" || a === "--follow") continue;
    if (a === "--") { files.push(...args.slice(i + 1)); break; }
    files.push(a);
  }
  const { items, err, code } = readInputs(sh, files, stdin, tool);
  let out = "";
  for (const it of items) {
    if (items.length > 1) out += `==> ${it.name === "-" ? "standard input" : it.name} <==\n`;
    if (bytes !== null) { out += tool === "head" ? it.text.slice(0, bytes) : it.text.slice(Math.max(0, it.text.length - bytes)); continue; }
    const lines = it.text.split("\n");
    const trailing = lines[lines.length - 1] === "";
    if (trailing) lines.pop();
    let picked: string[];
    if (tool === "head") picked = lines.slice(0, n);
    else picked = fromStart ? lines.slice(Math.max(0, n - 1)) : lines.slice(Math.max(0, lines.length - n));
    out += picked.length ? `${picked.join("\n")}${trailing || picked.length < lines.length || tool === "head" ? "\n" : ""}` : "";
  }
  return res(code, out, err);
}

function checksum(sh: Shell, algo: string, args: string[], stdin: string): ShellResult {
  const { rest } = splitFlags(args);
  const { items, err, code } = readInputs(sh, rest, stdin, `${algo}sum`);
  const out = items.map((it) => `${createHash(algo).update(it.text, "utf8").digest("hex")}  ${it.name}\n`).join("");
  return res(code, out, err);
}

function hashInt(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 1_000_000;
}

// ─── find ───────────────────────────────────────────────────────────────────

interface FindEntry { path: string; isDir: boolean; depth: number }

async function findUtil(sh: Shell, args: string[]): Promise<ShellResult> {
  const sb = sh.sb;
  let i = 0;
  while (i < args.length && ["-L", "-H", "-P", "-O0", "-O1", "-O2", "-O3"].includes(args[i])) i++;
  const starts: string[] = [];
  while (i < args.length && !args[i].startsWith("-") && args[i] !== "!" && args[i] !== "(") starts.push(args[i++]);
  if (starts.length === 0) starts.push(".");
  const preds: Array<(e: FindEntry, start: string) => boolean> = [];
  type Action = { type: "print" } | { type: "print0" } | { type: "printf"; fmt: string } | { type: "delete" } | { type: "exec"; argv: string[]; batch: boolean };
  const actions: Action[] = [];
  let mindepth = 0;
  let maxdepth = Infinity;
  let negate = false;
  const push = (p: (e: FindEntry, start: string) => boolean) => { preds.push(negate ? (e, s) => !p(e, s) : p); negate = false; };
  const mtimeOf = (e: FindEntry) => sb.mtimes.get(e.path) ?? sb.createdAt;
  while (i < args.length) {
    const a = args[i++];
    switch (a) {
      case "-type": { const t = args[i++]; push((e) => t === "f" ? !e.isDir : t === "d" ? e.isDir : false); break; }
      case "-name": case "-iname": { const re = globToRegex(args[i++] ?? "*", a === "-iname", false); push((e) => re.test(baseName(e.path))); break; }
      case "-path": case "-wholename": case "-ipath": { const re = globToRegex(args[i++] ?? "*", a === "-ipath", true); push((e, s) => re.test(shownPath(e, s))); break; }
      case "-regex": { const re = new RegExp(`^(?:${args[i++] ?? ".*"})$`); push((e, s) => re.test(shownPath(e, s))); break; }
      case "-newer": {
        const ref = sb.resolve(args[i++] ?? "", sh.st.cwd);
        if (!sb.exists(ref)) return res(1, "", `find: '${ref}': No such file or directory\n`);
        const refTime = sb.mtimes.get(ref) ?? sb.createdAt;
        push((e) => mtimeOf(e) > refTime);
        break;
      }
      case "-mmin": case "-mtime": {
        const spec = args[i++] ?? "0";
        const unit = a === "-mmin" ? 60_000 : 86_400_000;
        const n = Number(spec.replace(/^[+-]/, ""));
        push((e) => {
          const age = (sb.now() - mtimeOf(e)) / unit;
          return spec.startsWith("+") ? age > n : spec.startsWith("-") ? age < n : Math.floor(age) === n;
        });
        break;
      }
      case "-empty": push((e) => e.isDir ? sb.listDir(e.path).length === 0 : (sb.files.get(e.path)?.byteLength ?? 0) === 0); break;
      case "-size": {
        const spec = args[i++] ?? "0";
        const m = /^([+-]?)(\d+)([ckMGb]?)$/.exec(spec);
        if (!m) return res(1, "", `find: Invalid argument \`${spec}' to -size\n`);
        const mult = { c: 1, k: 1024, M: 1024 ** 2, G: 1024 ** 3, b: 512, "": 512 }[m[3]] ?? 512;
        const n = Number(m[2]);
        push((e) => { const units = Math.ceil((e.isDir ? 4096 : sb.files.get(e.path)?.byteLength ?? 0) / mult); return m[1] === "+" ? units > n : m[1] === "-" ? units < n : units === n; });
        break;
      }
      case "-mindepth": mindepth = Number(args[i++] ?? "0"); break;
      case "-maxdepth": maxdepth = Number(args[i++] ?? "0"); break;
      case "-print": actions.push({ type: "print" }); break;
      case "-print0": actions.push({ type: "print0" }); break;
      case "-printf": actions.push({ type: "printf", fmt: args[i++] ?? "" }); break;
      case "-delete": actions.push({ type: "delete" }); break;
      case "-exec": case "-execdir": {
        const argv: string[] = [];
        let batch = false;
        while (i < args.length) {
          const t = args[i++];
          if (t === ";") break;
          if (t === "+") { batch = true; break; }
          argv.push(t);
        }
        actions.push({ type: "exec", argv, batch });
        break;
      }
      case "-not": case "!": negate = !negate; break;
      case "-a": case "-and": case "(": case ")": break;
      case "-o": case "-or": sb.unhandledCommands.push({ name: "find", args: ["-o"], line: "find -o (treated as -a)" }); break;
      case "-perm": case "-user": case "-group": case "-uid": case "-gid": case "-newermt": case "-links": case "-inum": case "-fstype": case "-samefile": case "-used": case "-amin": case "-atime": case "-cmin": case "-ctime": i++; break;
      case "-prune": case "-xdev": case "-mount": case "-depth": case "-noleaf": case "-follow": case "-quit": case "-true": break;
      case "-false": push(() => false); break;
      case "-readable": case "-writable": case "-executable": break;
      default: return res(1, "", `find: unknown predicate \`${a}'\n`);
    }
  }
  if (actions.length === 0) actions.push({ type: "print" });

  let out = "";
  let err = "";
  let code = 0;
  const toDelete: string[] = [];
  const execBatches: Array<{ argv: string[]; items: string[] }> = [];
  for (const start of starts) {
    const abs = sb.resolve(start, sh.st.cwd);
    if (!sb.exists(abs)) { err += `find: '${start}': No such file or directory\n`; code = 1; continue; }
    const entries: FindEntry[] = [{ path: abs, isDir: sb.isDir(abs), depth: 0 }, ...(sb.isDir(abs) ? sb.walk(abs) : [])];
    const startShown = start.replace(/\/+$/, "") || (start.startsWith("/") ? "/" : start);
    function shownPathFor(e: FindEntry): string {
      if (e.depth === 0) return startShown;
      const rel = e.path.slice(abs.length + (abs === "/" ? 0 : 1));
      return startShown === "/" ? `/${rel}` : `${startShown}/${rel}`;
    }
    for (const e of entries) {
      if (e.depth < mindepth || e.depth > maxdepth) continue;
      if (!preds.every((p) => p(e, start))) continue;
      const shown = shownPathFor(e);
      for (const action of actions) {
        switch (action.type) {
          case "print": out += `${shown}\n`; break;
          case "print0": out += `${shown}\0`; break;
          case "printf": out += formatFind(action.fmt, e, shown, abs, sb); break;
          case "delete": toDelete.push(e.path); break;
          case "exec": {
            if (action.batch) {
              const b = execBatches.find((x) => x.argv === action.argv) ?? (execBatches.push({ argv: action.argv, items: [] }), execBatches[execBatches.length - 1]);
              b.items.push(shown);
            } else {
              const argv = action.argv.map((x) => x.split("{}").join(shown));
              const r = await sh.dispatch(argv[0], argv.slice(1), "", sh.st.env);
              out += r.stdout;
              err += r.stderr;
              if (r.exitCode !== 0) code = 1;
            }
            break;
          }
        }
      }
    }
  }
  for (const b of execBatches) {
    const argv = b.argv.flatMap((x) => x === "{}" ? b.items : [x]);
    const r = await sh.dispatch(argv[0], argv.slice(1), "", sh.st.env);
    out += r.stdout;
    err += r.stderr;
    if (r.exitCode !== 0) code = 1;
  }
  for (const p of toDelete.sort((a, b) => b.length - a.length)) {
    if (sb.isDir(p) && sb.listDir(p).length > 0) { err += `find: cannot delete '${p}': Directory not empty\n`; code = 1; continue; }
    sb.removeTree(p);
  }
  return res(code, out, err);

  function shownPath(e: FindEntry, start: string): string {
    const abs = sb.resolve(start, sh.st.cwd);
    if (e.depth === 0) return start.replace(/\/+$/, "") || start;
    return `${(start.replace(/\/+$/, "") || start).replace(/\/$/, "")}/${e.path.slice(abs.length + (abs === "/" ? 0 : 1))}`;
  }
}

function formatFind(fmt: string, e: FindEntry, shown: string, start: string, sb: FakeSandboxInstance): string {
  let out = "";
  for (let i = 0; i < fmt.length; i++) {
    const c = fmt[i];
    if (c === "\\") {
      const n = fmt[++i];
      out += n === "n" ? "\n" : n === "t" ? "\t" : n === "0" ? "\0" : n === "\\" ? "\\" : n === "r" ? "\r" : `\\${n ?? ""}`;
      continue;
    }
    if (c !== "%") { out += c; continue; }
    const k = fmt[++i];
    const size = e.isDir ? 4096 : (sb.files.get(e.path)?.byteLength ?? 0);
    const mtime = sb.mtimes.get(e.path) ?? sb.createdAt;
    switch (k) {
      case "p": out += shown; break;
      case "P": out += e.depth === 0 ? "" : e.path.slice(start.length + (start === "/" ? 0 : 1)); break;
      case "f": out += baseName(e.path); break;
      case "h": { const idx = shown.lastIndexOf("/"); out += idx < 0 ? "." : idx === 0 ? "/" : shown.slice(0, idx); break; }
      case "s": out += String(size); break;
      case "y": out += e.isDir ? "d" : "f"; break;
      case "m": out += e.isDir ? "755" : "644"; break;
      case "M": out += e.isDir ? "drwxr-xr-x" : "-rw-r--r--"; break;
      case "u": out += "root"; break;
      case "g": out += "root"; break;
      case "d": out += String(e.depth); break;
      case "T": {
        const spec = fmt[++i];
        out += spec === "@" ? `${Math.floor(mtime / 1000)}.${String(mtime % 1000).padStart(3, "0")}000000` : formatDate(`%${spec}`, mtime);
        break;
      }
      case "%": out += "%"; break;
      default: out += `%${k ?? ""}`;
    }
  }
  return out;
}
