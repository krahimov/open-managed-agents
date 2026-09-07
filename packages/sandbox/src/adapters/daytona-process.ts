// Background processes on Daytona = one Daytona *process session* per
// command, started with `runAsync: true`.
//
//   startProcess(cmd)
//     ├ upload  <procDir>/<procId>.env   (0600; `export K='v'` lines)
//     ├ createSession("oma-proc-<procId>")
//     └ executeSessionCommand(wrapper, runAsync)   → cmdId
//
// The wrapper (buildProcessWrapperCommand) sources + deletes the env file,
// applies the per-file ulimit, and runs the command under `setsid` so it
// becomes its own process group; `$$` of that shell is written to a pidfile
// so `kill -- -<pid>` can take the whole tree down later.
//
// The wrapper deliberately does NOT `exec` into setsid: a Daytona session is
// a persistent shell that records each command's exit code after it returns
// — replacing that shell would leave `getSessionCommand().exitCode`
// undefined forever (status stuck on "running").
//
//   getStatus()  → getSessionCommand(...).exitCode   (undefined → running,
//                  0 → completed, killed → killed, else failed; 500 ms cache;
//                  first terminal observation snapshots the logs and deletes
//                  the session — one idle shell per bash call must not pile up)
//   getLogs()    → getSessionCommandLogs(...)        (non-streaming, 1 MiB cap)
//   kill(sig)    → kill -s SIG -- -<pid>; after the grace period SIGKILL;
//                  then deleteSession(...)
//
// Works for both box scopes: only `procDir` differs (/tmp/oma-procs vs
// /var/lib/oma/procs).

import type { ProcessHandle } from "../ports";
import type { DaytonaSandboxInstance } from "./daytona-types";
import { isDaytonaNotFound } from "./daytona-types";

const LOG_CAP_BYTES = 1024 * 1024;
const STATUS_CACHE_MS = 500;
const DEFAULT_KILL_GRACE_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_PID_RETRIES = 5;
const DEFAULT_PID_RETRY_DELAY_MS = 200;

export interface DaytonaProcessHandleDeps {
  sb: DaytonaSandboxInstance;
  /** Daytona process session that owns the command (`oma-proc-<procId>`). */
  sessionName: string;
  cmdId: string;
  procId: string;
  pidFile: string;
  logger: { warn: (msg: string, ctx?: unknown) => void; log: (msg: string) => void };
  now?: () => number;
  /** Fired exactly once, on the first observation of a terminal state
   *  (natural exit or kill). Used to sync outputs and release keep-alive. */
  onTerminal?: () => Promise<void> | void;
  /** Grace between SIGTERM and SIGKILL in kill(). Default 5 s. */
  killGraceMs?: number;
  /** Poll interval while waiting for exit inside kill(). Default 250 ms. */
  pollIntervalMs?: number;
  /** Pidfile read attempts / delay. Default 5 × 200 ms. */
  pidRetries?: number;
  pidRetryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class DaytonaProcessHandle implements ProcessHandle {
  readonly id: string;
  /** Process-group leader pid (the `setsid sh` in the wrapper); 0 when the
   *  pidfile could not be read. Populated by `resolvePid()`. */
  pid = 0;
  /** Exit code once observed; read by the bash tool's poll loop. */
  exitCode?: number;

  private killed = false;
  private terminalStatus: string | null = null;
  private terminalFired = false;
  private sessionDeleted = false;
  private statusCache: { at: number; status: string } | null = null;
  private lastLogs: { stdout: string; stderr: string } = { stdout: "", stderr: "" };
  private pidInflight: Promise<number> | null = null;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: DaytonaProcessHandleDeps) {
    this.id = deps.procId;
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Read the pidfile written by the wrapper (retrying while the process is
   *  still starting). Resolves 0 when it never appears. */
  async resolvePid(): Promise<number> {
    if (this.pid > 0) return this.pid;
    if (this.pidInflight) return this.pidInflight;
    const retries = Math.max(1, this.deps.pidRetries ?? DEFAULT_PID_RETRIES);
    const delay = this.deps.pidRetryDelayMs ?? DEFAULT_PID_RETRY_DELAY_MS;
    this.pidInflight = (async () => {
      for (let attempt = 0; attempt < retries; attempt++) {
        try {
          const r = await this.deps.sb.process.executeCommand(
            `cat ${shellEscape(this.deps.pidFile)} 2>/dev/null`,
            undefined,
            undefined,
            10,
          );
          const text = (r.artifacts?.stdout ?? r.result ?? "").trim();
          const n = Number.parseInt(text, 10);
          if (r.exitCode === 0 && Number.isFinite(n) && n > 0) {
            this.pid = n;
            return n;
          }
        } catch (err) {
          this.deps.logger.warn(
            `process ${this.id}: pidfile read failed: ${(err as Error).message}`,
          );
          if (isDaytonaNotFound(err)) break;
        }
        if (attempt < retries - 1) await this.sleep(delay);
      }
      return 0;
    })().finally(() => {
      this.pidInflight = null;
    });
    return this.pidInflight;
  }

  async getStatus(): Promise<string> {
    if (this.terminalStatus) return this.terminalStatus;
    const now = this.now();
    if (this.statusCache && now - this.statusCache.at < STATUS_CACHE_MS) {
      return this.statusCache.status;
    }
    let status: string;
    let sandboxGone = false;
    try {
      const cmd = await this.deps.sb.process.getSessionCommand(this.deps.sessionName, this.deps.cmdId);
      if (cmd.exitCode === undefined || cmd.exitCode === null) {
        status = "running";
      } else {
        this.exitCode = cmd.exitCode;
        status = this.statusForExit(cmd.exitCode);
      }
    } catch (err) {
      if (this.killed || this.sessionDeleted) {
        // kill() removed the session underneath us.
        status = this.exitCode !== undefined ? this.statusForExit(this.exitCode) : "killed";
      } else if (isDaytonaNotFound(err)) {
        // The sandbox itself is gone — the process died with it.
        this.deps.logger.warn(`process ${this.id}: sandbox gone while polling status`);
        sandboxGone = true;
        status = "failed";
      } else {
        throw err;
      }
    }
    if (status === "running") {
      this.statusCache = { at: now, status };
      return status;
    }
    // Terminal: keep the final logs/exit code on the handle and drop the
    // Daytona session. Every bash tool call is a process session, so leaving
    // finished sessions behind leaks one idle shell (still carrying the
    // sourced secrets in its environment) per command for the box lifetime.
    if (!this.sessionDeleted && !sandboxGone) {
      await this.snapshotFinal();
      await this.deleteSession();
    }
    await this.markTerminal(status);
    return status;
  }

  private async deleteSession(): Promise<void> {
    if (this.sessionDeleted) return;
    this.sessionDeleted = true;
    await this.deps.sb.process.deleteSession(this.deps.sessionName).catch((err) => {
      this.deps.logger.warn(
        `process ${this.id}: deleteSession(${this.deps.sessionName}) failed: ${(err as Error).message}`,
      );
    });
  }

  async getLogs(): Promise<{ stdout: string; stderr: string }> {
    if (this.sessionDeleted) return this.lastLogs;
    try {
      const r = await this.deps.sb.process.getSessionCommandLogs(this.deps.sessionName, this.deps.cmdId);
      this.lastLogs = splitLogs(r);
    } catch (err) {
      if (this.sessionDeleted || this.killed) return this.lastLogs;
      throw err;
    }
    return this.lastLogs;
  }

  async kill(signal = "SIGTERM"): Promise<void> {
    if (this.sessionDeleted) return;
    this.killed = true;
    this.statusCache = null;
    const sig = normalizeSignalName(signal);
    const graceMs = this.deps.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    try {
      const pid = await this.resolvePid();
      if (pid > 0) {
        await this.signal(sig, pid);
        if (sig !== "SIGKILL") {
          const exited = await this.waitForExit(graceMs);
          if (!exited) {
            await this.signal("SIGKILL", pid);
            await this.waitForExit(Math.min(1_000, graceMs));
          }
        } else {
          await this.waitForExit(Math.min(1_000, graceMs));
        }
      }
      // Capture the final state before the session (and its logs) disappear.
      await this.snapshotFinal();
    } finally {
      await this.deleteSession();
    }
    await this.markTerminal(this.exitCode !== undefined ? this.statusForExit(this.exitCode) : "killed");
  }

  private statusForExit(exitCode: number): string {
    if (exitCode === 0) return "completed";
    if (this.killed) return "killed";
    return "failed";
  }

  private async markTerminal(status: string): Promise<void> {
    this.terminalStatus = status;
    this.statusCache = null;
    if (this.terminalFired) return;
    this.terminalFired = true;
    try {
      await this.deps.onTerminal?.();
    } catch (err) {
      this.deps.logger.warn(`process ${this.id}: onTerminal hook failed: ${(err as Error).message}`);
    }
  }

  private async signal(sig: string, pid: number): Promise<void> {
    // Process-group kill first (setsid made `pid` the group leader); fall
    // back to the single pid in case the group is already gone.
    const cmd = `kill -s ${sig} -- -${pid} 2>/dev/null || kill -s ${sig} ${pid} 2>/dev/null; true`;
    try {
      await this.deps.sb.process.executeCommand(cmd, undefined, undefined, 10);
    } catch (err) {
      this.deps.logger.warn(`process ${this.id}: ${sig} failed: ${(err as Error).message}`);
    }
  }

  /** Poll getSessionCommand until an exit code shows up or `ms` elapses. */
  private async waitForExit(ms: number): Promise<boolean> {
    const interval = Math.max(1, this.deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    const deadline = this.now() + ms;
    for (;;) {
      try {
        const cmd = await this.deps.sb.process.getSessionCommand(this.deps.sessionName, this.deps.cmdId);
        if (cmd.exitCode !== undefined && cmd.exitCode !== null) {
          this.exitCode = cmd.exitCode;
          return true;
        }
      } catch {
        return false;
      }
      if (this.now() >= deadline) return false;
      await this.sleep(interval);
    }
  }

  private async snapshotFinal(): Promise<void> {
    try {
      const r = await this.deps.sb.process.getSessionCommandLogs(this.deps.sessionName, this.deps.cmdId);
      this.lastLogs = splitLogs(r);
    } catch {
      /* keep whatever we had */
    }
    if (this.exitCode === undefined) {
      try {
        const cmd = await this.deps.sb.process.getSessionCommand(this.deps.sessionName, this.deps.cmdId);
        if (cmd.exitCode !== undefined && cmd.exitCode !== null) this.exitCode = cmd.exitCode;
      } catch {
        /* session already gone */
      }
    }
  }
}

/**
 * The command handed to `executeSessionCommand(..., { runAsync: true })`.
 *
 *   cd <cwd> && ulimit -f <N> && set -a && . <envFile> && set +a &&
 *   rm -f <envFile> && setsid sh -c 'echo $$ > "$2"; exec sh -c "$1"' _ <cmd> <pidFile>
 *
 * The env file is sourced into the session shell (so the secrets never appear
 * on a command line) and removed before the command starts.
 */
export function buildProcessWrapperCommand(opts: {
  procId: string;
  cwd: string;
  envFile: string;
  pidFile: string;
  fileSizeBlocks: number;
  command: string;
}): string {
  const blocks = Math.max(1, Math.floor(opts.fileSizeBlocks));
  const envFile = shellEscape(opts.envFile);
  return [
    `cd ${shellEscape(opts.cwd)}`,
    `ulimit -f ${blocks}`,
    "set -a",
    `. ${envFile}`,
    "set +a",
    `rm -f ${envFile}`,
    `OMA_PROC_ID=${shellEscape(opts.procId)} setsid sh -c 'echo $$ > "$2"; exec sh -c "$1"' _ ${shellEscape(opts.command)} ${shellEscape(opts.pidFile)}`,
  ].join(" && ");
}

/** `export K='v'` per entry, single quotes escaped; invalid names skipped. */
export function buildEnvFileContents(env: Record<string, string>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    lines.push(`export ${key}=${shellEscape(String(value ?? ""))}`);
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

/** "term" / "SIGTERM" / "15" → "SIGTERM"; unknown numbers pass through as-is. */
export function normalizeSignalName(signal: string): string {
  const s = String(signal ?? "").trim().toUpperCase();
  if (!s) return "SIGTERM";
  if (/^[0-9]+$/.test(s)) {
    const byNumber: Record<string, string> = {
      "1": "SIGHUP", "2": "SIGINT", "3": "SIGQUIT", "9": "SIGKILL", "15": "SIGTERM",
    };
    return byNumber[s] ?? s;
  }
  return s.startsWith("SIG") ? s : `SIG${s}`;
}

/**
 * The real SDK coerces every stream to a string (`stdout: data.stdout ?? ''`),
 * so a toolbox that only fills the combined `output` shows up as
 * `{ stdout: "", stderr: "", output: "…" }` — `r.stdout ?? r.output` would
 * silently drop it. Fall back to `output` only when BOTH split streams are
 * empty, so a toolbox that does split streams never gets stderr duplicated.
 */
function splitLogs(r: { stdout?: string; stderr?: string; output?: string }): { stdout: string; stderr: string } {
  const stdout = r.stdout ?? "";
  const stderr = r.stderr ?? "";
  if (stdout === "" && stderr === "" && r.output) {
    return { stdout: capLog(r.output), stderr: "" };
  }
  return { stdout: capLog(stdout), stderr: capLog(stderr) };
}

function capLog(s: string): string {
  if (Buffer.byteLength(s, "utf8") <= LOG_CAP_BYTES) return s;
  const buf = Buffer.from(s, "utf8");
  const dropped = buf.byteLength - LOG_CAP_BYTES;
  return `…[${dropped} bytes truncated]\n${buf.subarray(dropped).toString("utf8")}`;
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
