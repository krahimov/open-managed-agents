// LocalSubprocessSandbox — Node child_process backed SandboxExecutor.
//
// Per-session workdir under <baseDir>/<sessionId>/. exec spawns
// `/bin/sh -c <cmd>` with cwd=workdir and a timeout watchdog. read/write
// resolve relative paths inside workdir; absolute paths are accepted as-is
// (so the harness's existing /workspace/foo conventions still land
// somewhere — we transparently rewrite /workspace → workdir).
//
// /mnt/memory and /mnt/session/outputs: when running inside the
// `openma/main-node` container, we create real symlinks at those root
// paths pointing into the workdir's `.mnt/...` tree. Bash that does
// `cat /mnt/memory/foo` then resolves the same dir as harness tools.
// Outside a container the host's `/mnt` is usually not writable as the
// `node` user — we fall back to the workdir-relative `.mnt/...` path
// rewriter so dev workflows still work; bash hardcoding `/mnt/memory/...`
// will see ENOENT in that mode (documented in self-host.md).
//
// SECURITY: this adapter has zero process isolation. An agent that runs
// `rm -rf /` will hit the host. ONLY use for trusted local development.
// Production / untrusted agents must use E2B / Daytona / LiteBox / BoxRun
// or CloudflareSandbox.
//
// Environment: child processes get a minimal allowlisted env (see
// buildSandboxProcessEnv) — NOT the host's process.env — so `env` inside the
// sandbox doesn't reveal PLATFORM_ROOT_SECRET, DATABASE_URL, provider API
// keys, S3 credentials, etc. This is defence-in-depth only: the child runs
// as the same OS user as main-node, so it can still read /proc/<ppid>/environ,
// the sqlite db, and the vault CA key off disk. It also cannot be forced
// through the egress proxy — a process that unsets HTTP(S)_PROXY connects
// directly. Use an isolated provider for anything untrusted.

import {
  spawn,
  type ChildProcess,
} from "node:child_process";
import { promises as fs } from "node:fs";
import {
  chmodSync,
  mkdirSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ProcessHandle, SandboxExecOptions, SandboxExecutor, SandboxFactory } from "../ports";
import { getLogger } from "@open-managed-agents/observability";
import { withSessionProxyContext } from "./outbound-proxy";

const moduleLogger = getLogger("local-sandbox");

export interface LocalSubprocessSandboxOptions {
  /** Per-session working directory. Created if missing. */
  workdir: string;
  /**
   * Default command timeout in milliseconds (matches the SandboxExecutor
   * port contract). Per-call timeout overrides this.
   */
  defaultTimeoutMs?: number;
  /** Logger for debug/warn output. Defaults to console. */
  logger?: { warn: (msg: string, ctx?: unknown) => void; log: (msg: string) => void };
  /**
   * Extra host env var names to pass through to sandbox processes on top of
   * the built-in allowlist (SANDBOX_ENV_ALLOWLIST). Merged with the
   * comma-separated `OMA_SUBPROCESS_ENV_PASSTHROUGH` host env var. Opt-in
   * only — anything listed here is readable by the agent.
   */
  envPassthrough?: string[];
  /**
   * Absolute path to the directory backing memory blob content. Required
   * to support mountMemoryStore — when set, mountMemoryStore symlinks
   * <workdir>/.mnt/memory/<storeName> → <memoryRoot>/<storeId>/, so reads
   * and writes flow directly to the BlobStore's on-disk layout. When omitted,
   * mountMemoryStore is a hard error (matches CF behaviour without
   * MEMORY_BUCKET).
   */
  memoryRoot?: string;
  /**
   * Absolute path to the directory backing per-session output deliveries
   * (the `/mnt/session/outputs/` magic dir). Required to support
   * mountSessionOutputs — when set, mountSessionOutputs symlinks
   * <workdir>/.mnt/session/outputs → <outputsRoot>/<tenantId>/<sessionId>/.
   * main-node's GET /v1/sessions/:id/outputs reads from the same root.
   * When omitted, mountSessionOutputs is a hard error (matches CF
   * behaviour without FILES_BUCKET).
   */
  outputsRoot?: string;
}

interface MemoryMount {
  storeName: string;
  storeId: string;
  readOnly: boolean;
  /** Real path the symlink targets — `<memoryRoot>/<storeId>/`. */
  targetDir: string;
  /** Workdir-relative mount path — `.mnt/memory/<storeName>`. */
  mountRel: string;
}

interface OutputsMount {
  tenantId: string;
  sessionId: string;
  /** Real path the symlink targets — `<outputsRoot>/<tenantId>/<sessionId>/`. */
  targetDir: string;
  /** Workdir-relative mount path — `.mnt/session/outputs`. */
  mountRel: string;
}

export class LocalSubprocessSandbox implements SandboxExecutor {
  private workdir: string;
  private defaultTimeoutMs: number;
  private envVars: Record<string, string> = {};
  private processes = new Map<string, BackgroundProcess>();
  private mounts = new Map<string, MemoryMount>();
  private outputsMount: OutputsMount | null = null;
  private memoryRoot: string | null;
  private outputsRoot: string | null;
  private logger: NonNullable<LocalSubprocessSandboxOptions["logger"]>;
  private envPassthrough: string[];

  constructor(opts: LocalSubprocessSandboxOptions) {
    this.workdir = resolve(opts.workdir);
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 120_000;
    this.memoryRoot = opts.memoryRoot ? resolve(opts.memoryRoot) : null;
    this.outputsRoot = opts.outputsRoot ? resolve(opts.outputsRoot) : null;
    this.envPassthrough = [
      ...(opts.envPassthrough ?? []),
      ...parseEnvPassthrough(process.env.OMA_SUBPROCESS_ENV_PASSTHROUGH),
    ];
    this.logger = opts.logger ?? {
      warn: (msg, ctx) => moduleLogger.warn({ ...(ctx as Record<string, unknown> ?? {}) }, msg),
      log: (msg) => moduleLogger.info(msg),
    };
    mkdirSync(this.workdir, { recursive: true });
  }

  async exec(command: string, timeout?: number, opts?: SandboxExecOptions): Promise<string> {
    const timeoutMs = timeout ?? this.defaultTimeoutMs;
    const env = this.buildEnv();
    const signal = opts?.signal;
    if (signal?.aborted) return "[aborted: command not started]";

    return new Promise<string>((resolveExec) => {
      // Own process group (detached) so a timeout / abort kills the whole
      // tree — `sleep 30; touch x` must not finish after its shell dies.
      const child = spawn("/bin/sh", ["-c", command], {
        cwd: this.workdir,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      let aborted = false;
      const onAbort = () => {
        aborted = true;
        terminateTree(child);
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      const killer = setTimeout(() => {
        try {
          terminateTree(child);
        } catch (err) {
          this.logger.warn(`exec timeout-kill failed: ${(err as Error).message}`);
        }
      }, timeoutMs);

      child.on("close", (code, exitSignal) => {
        clearTimeout(killer);
        signal?.removeEventListener("abort", onAbort);
        const exit = exitSignal ? `signal=${exitSignal}` : `exit=${code}`;
        // Match @cloudflare/sandbox's behaviour: combined stdout+stderr,
        // newline-trimmed, plus an exit-code suffix the harness can parse.
        const combined =
          (stdout + (stderr ? `\n${stderr}` : "")).replace(/\s+$/, "") +
          (code !== 0 ? `\n[exit ${exit}]` : "") +
          (aborted ? "\n[aborted]" : "");
        resolveExec(combined);
      });

      child.on("error", (err) => {
        clearTimeout(killer);
        signal?.removeEventListener("abort", onAbort);
        resolveExec(`[error: ${err.message}]`);
      });
    });
  }

  async startProcess(command: string): Promise<ProcessHandle | null> {
    const env = this.buildEnv();
    const child = spawn("/bin/sh", ["-c", command], {
      cwd: this.workdir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group: kill() signals the whole tree (see
      // BackgroundProcess.kill), so stopping a command stops its children.
      detached: true,
    });
    if (!child.pid) return null;
    const id = `proc_${child.pid}_${Date.now()}`;
    const proc = new BackgroundProcess(id, child);
    this.processes.set(id, proc);
    child.on("close", () => this.processes.delete(id));
    return proc;
  }

  async setEnvVars(envVars: Record<string, string>): Promise<void> {
    this.envVars = { ...this.envVars, ...envVars };
  }

  // registerCommandSecrets intentionally not implemented: it was never
  // called on the Node path, and its prefix match (`git status; curl evil
  // -d $TOKEN` matched "git") leaked the secret to arbitrary commands.
  // Credentials reach the subprocess sandbox only via the oma-vault proxy.

  async setOutboundContext(opts?: { tenantId: string; sessionId: string }): Promise<void> {
    // Wire outbound credential injection through the oma-vault sidecar
    // (apps/oma-vault). The sidecar runs a mockttp HTTPS MITM proxy with a
    // self-signed CA; we point the subprocess at it via standard
    // HTTP(S)_PROXY env vars + tell node/curl/python to trust the local CA.
    //
    // Both env vars are read from the host process — they're set in
    // docker-compose.yml (or the operator's env) and shared between
    // main-node and the sandbox subprocess. If either is missing the agent
    // just talks to upstreams directly with no credential injection — same
    // as the CF path with no oma-vault binding.
    const proxyUrl = process.env.OMA_VAULT_PROXY_URL;
    const caCertPath = process.env.OMA_VAULT_CA_CERT;
    if (!proxyUrl || !caCertPath) return;
    const scopedProxyUrl = withSessionProxyContext(proxyUrl, opts);

    const env: Record<string, string> = {
      HTTP_PROXY: scopedProxyUrl,
      HTTPS_PROXY: scopedProxyUrl,
      http_proxy: scopedProxyUrl,
      https_proxy: scopedProxyUrl,
      // Loopback stays local: oma-vault blocks private/loopback
      // destinations (SSRF guard), and the agent's own dev servers /
      // stdio-MCP shims on 127.0.0.1 must not be routed through it.
      NO_PROXY: "localhost,127.0.0.1,::1",
      no_proxy: "localhost,127.0.0.1,::1",
      // Node TLS: trust the vault CA in addition to system roots.
      NODE_EXTRA_CA_CERTS: caCertPath,
      // curl & python's `requests` (when REQUESTS_CA_BUNDLE not set).
      SSL_CERT_FILE: caCertPath,
      // Some tools look for this name specifically.
      CURL_CA_BUNDLE: caCertPath,
    };
    await this.setEnvVars(env);
  }

  /**
   * Bind a memory store into the sandbox at /mnt/memory/<storeName>.
   *
   * Two-tier mount strategy:
   *   1. Always: workdir-relative `.mnt/memory/<storeName>` symlink to
   *      `<memoryRoot>/<storeId>/`. The path resolver rewrites
   *      `/mnt/memory/<storeName>/...` → `.mnt/memory/<storeName>/...` so
   *      harness read/write/edit/glob/grep tools land directly on the
   *      BlobStore's on-disk layout — no copy, no sync-back.
   *   2. Best-effort: a real symlink at the root `/mnt/memory/<storeName>`
   *      → the workdir target. Created only when `/mnt/memory` is
   *      writable to this process (typical inside the
   *      `openma/main-node` container running as the `node` user).
   *      Bash that hard-codes `/mnt/memory/foo` then sees the same dir
   *      as the harness. Outside a container the root path usually isn't
   *      writable — bash that hard-codes `/mnt/memory/...` will hit
   *      ENOENT and the workdir-relative + `$OMA_MEMORY_DIR` paths
   *      remain the supported access pattern.
   *
   * read_only enforcement: chmod -w on the target dir's contents at
   * mount time (best effort — root-equivalent in container can still
   * write; documented in docs/self-host.md). The harness write tool also
   * checks `assertWritable` for a clearer error.
   */
  async mountMemoryStore(opts: {
    storeName: string;
    storeId: string;
    readOnly: boolean;
  }): Promise<void> {
    if (!this.memoryRoot) {
      throw new Error(
        `LocalSubprocessSandbox.mountMemoryStore: memoryRoot not configured — ` +
        `pass it to the constructor or skip memory mounts`,
      );
    }
    const targetDir = join(this.memoryRoot, opts.storeId);
    mkdirSync(targetDir, { recursive: true });

    const mountParent = join(this.workdir, ".mnt", "memory");
    mkdirSync(mountParent, { recursive: true });

    const workdirSymlink = join(mountParent, opts.storeName);
    try {
      rmSync(workdirSymlink, { recursive: true, force: true });
    } catch { /* best-effort */ }
    try {
      symlinkSync(targetDir, workdirSymlink, "dir");
    } catch (err) {
      throw new Error(
        `mountMemoryStore: symlink ${workdirSymlink} → ${targetDir} failed: ` +
        (err as Error).message,
      );
    }

    // Best-effort: real /mnt/memory/<storeName> root symlink — works inside
    // the docker image; silently no-ops on a host that hasn't pre-created
    // a writable /mnt/memory.
    const rootSymlink = `/mnt/memory/${opts.storeName}`;
    if (this.tryEnsureRootMountDir("/mnt/memory")) {
      try {
        rmSync(rootSymlink, { recursive: true, force: true });
      } catch { /* best-effort */ }
      try {
        symlinkSync(targetDir, rootSymlink, "dir");
      } catch (err) {
        this.logger.warn(
          `root symlink /mnt/memory/${opts.storeName} skipped: ${(err as Error).message}`,
        );
      }
    }

    if (opts.readOnly) {
      // Best-effort chmod -w. Bash root-equivalent inside the container
      // can still chmod +w, but normal agent processes get a clear
      // EACCES on writes — matches the harness assertWritable error
      // shape.
      try {
        chmodSync(targetDir, 0o555);
      } catch { /* best-effort */ }
    }

    this.mounts.set(opts.storeName, {
      storeName: opts.storeName,
      storeId: opts.storeId,
      readOnly: opts.readOnly,
      targetDir,
      mountRel: join(".mnt", "memory", opts.storeName),
    });

    // Expose to bash via env. Setting per-store too in case the agent
    // wants the absolute path without parsing.
    await this.setEnvVars({
      OMA_MEMORY_DIR: mountParent,
      [`OMA_MEMORY_${opts.storeName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`]: workdirSymlink,
    });
  }

  async mountSessionOutputs(opts: {
    tenantId: string;
    sessionId: string;
  }): Promise<void> {
    if (!this.outputsRoot) {
      throw new Error(
        `LocalSubprocessSandbox.mountSessionOutputs: outputsRoot not configured — ` +
        `pass it to the constructor or skip outputs mounts`,
      );
    }
    const targetDir = join(this.outputsRoot, opts.tenantId, opts.sessionId);
    mkdirSync(targetDir, { recursive: true });

    const mountParent = join(this.workdir, ".mnt", "session");
    mkdirSync(mountParent, { recursive: true });

    const workdirSymlink = join(mountParent, "outputs");
    try {
      rmSync(workdirSymlink, { recursive: true, force: true });
    } catch { /* best-effort */ }
    try {
      symlinkSync(targetDir, workdirSymlink, "dir");
    } catch (err) {
      throw new Error(
        `mountSessionOutputs: symlink ${workdirSymlink} → ${targetDir} failed: ` +
        (err as Error).message,
      );
    }

    const rootSymlink = `/mnt/session/outputs`;
    if (this.tryEnsureRootMountDir("/mnt/session")) {
      try {
        rmSync(rootSymlink, { recursive: true, force: true });
      } catch { /* best-effort */ }
      try {
        symlinkSync(targetDir, rootSymlink, "dir");
      } catch (err) {
        this.logger.warn(
          `root symlink /mnt/session/outputs skipped: ${(err as Error).message}`,
        );
      }
    }

    this.outputsMount = {
      tenantId: opts.tenantId,
      sessionId: opts.sessionId,
      targetDir,
      mountRel: join(".mnt", "session", "outputs"),
    };

    await this.setEnvVars({ OMA_OUTPUTS_DIR: workdirSymlink });
  }

  async readFile(path: string): Promise<string> {
    return fs.readFile(this.resolvePath(path), "utf8");
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    const buf = await fs.readFile(this.resolvePath(path));
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  async writeFile(path: string, content: string): Promise<string> {
    this.assertWritable(path);
    const full = this.resolvePath(path);
    await fs.mkdir(dirname(full), { recursive: true });
    await fs.writeFile(full, content, "utf8");
    return full;
  }

  async writeFileBytes(path: string, bytes: Uint8Array): Promise<string> {
    this.assertWritable(path);
    const full = this.resolvePath(path);
    await fs.mkdir(dirname(full), { recursive: true });
    await fs.writeFile(full, bytes);
    return full;
  }

  async destroy(): Promise<void> {
    for (const proc of this.processes.values()) {
      try { await proc.kill("SIGKILL"); } catch { /* best-effort */ }
    }
    this.processes.clear();
    try {
      rmSync(this.workdir, { recursive: true, force: true });
    } catch (err) {
      this.logger.warn(`destroy: failed to remove workdir ${this.workdir}`, err);
    }
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  /**
   * Resolve a sandbox-relative path to a host absolute path inside workdir.
   * The harness emits /workspace/foo conventions assuming a real container
   * mount; we transparently rewrite /workspace → workdir so existing tools
   * keep working without changes.
   *
   * /mnt/memory and /mnt/session/outputs paths: when the root symlinks
   * exist on disk (container case) they resolve naturally as absolute
   * paths; when they don't, we fall back to the workdir-relative
   * `.mnt/...` mirror so harness tools still land on the right files.
   */
  private resolvePath(p: string): string {
    let normalised = p;
    // Memory mount: /mnt/memory/<storeName>/<rest> → <workdir>/.mnt/memory/...
    if (normalised.startsWith("/mnt/memory/") || normalised === "/mnt/memory") {
      // When the real /mnt/memory symlink exists, prefer it — bash and
      // tools see the same path.
      if (this.rootMountExists("/mnt/memory")) return normalised;
      normalised = normalised === "/mnt/memory"
        ? ".mnt/memory"
        : ".mnt/memory/" + normalised.slice("/mnt/memory/".length);
    } else if (
      normalised.startsWith("/mnt/session/outputs/") ||
      normalised === "/mnt/session/outputs"
    ) {
      if (this.rootMountExists("/mnt/session/outputs")) return normalised;
      normalised = normalised === "/mnt/session/outputs"
        ? ".mnt/session/outputs"
        : ".mnt/session/outputs/" + normalised.slice("/mnt/session/outputs/".length);
    } else if (normalised.startsWith("/workspace/")) normalised = normalised.slice("/workspace/".length);
    else if (normalised === "/workspace") normalised = "";
    else if (normalised.startsWith("/")) normalised = normalised.slice(1);
    if (isAbsolute(normalised)) return normalised; // explicit absolute escape — caller's responsibility
    return join(this.workdir, normalised);
  }

  /** True if a path exists on the host filesystem (symlink-followed). */
  private rootMountExists(p: string): boolean {
    if (this.rootMountCache.has(p)) return this.rootMountCache.get(p)!;
    let ok = false;
    try {
      statSync(p);
      ok = true;
    } catch {
      ok = false;
    }
    this.rootMountCache.set(p, ok);
    return ok;
  }
  private rootMountCache = new Map<string, boolean>();

  /**
   * Best-effort: ensure `/mnt/<x>` exists and is writable so we can
   * symlink children into it. Returns false (no throw) when the
   * filesystem refuses — caller falls back to the workdir-relative
   * `.mnt/...` path. This is the typical state outside the container.
   */
  private tryEnsureRootMountDir(parent: string): boolean {
    try {
      mkdirSync(parent, { recursive: true });
      // Touch — if mkdir succeeded but writes are blocked (e.g. read-only
      // tmpfs), the symlink call below would also fail.
      this.rootMountCache.set(parent, true);
      return true;
    } catch (err) {
      this.logger.warn(
        `mkdir ${parent} not allowed (${(err as Error).message}); falling back to workdir-relative mounts`,
      );
      return false;
    }
  }

  /**
   * Throw if `p` resolves into a read-only memory mount and `mode` is "write".
   * Read/write tools call this so the agent gets a clear error rather than a
   * silent successful write that gets blown away on the next mount.
   */
  private assertWritable(p: string): void {
    if (!p.startsWith("/mnt/memory/")) return;
    const rest = p.slice("/mnt/memory/".length);
    const slash = rest.indexOf("/");
    const storeName = slash === -1 ? rest : rest.slice(0, slash);
    const mount = this.mounts.get(storeName);
    if (mount?.readOnly) {
      throw new Error(
        `EACCES: memory store ${storeName} mounted read-only at /mnt/memory/${storeName}/`,
      );
    }
  }

  private buildEnv(): NodeJS.ProcessEnv {
    return buildSandboxProcessEnv({
      hostEnv: process.env,
      sandboxEnv: this.envVars,
      workdir: this.workdir,
      passthrough: this.envPassthrough,
    });
  }
}

/**
 * Host env vars a sandbox process inherits by default. Everything else in
 * the host environment (secrets, DB URLs, API keys) is dropped. Locale
 * vars matching LC_* are also passed.
 */
export const SANDBOX_ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LANGUAGE",
  "TERM",
  "TZ",
  "TMPDIR",
  "COLORTERM",
];

/** Parse `OMA_SUBPROCESS_ENV_PASSTHROUGH=FOO,BAR` into a list of names. */
export function parseEnvPassthrough(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s));
}

/**
 * Build the env for a sandbox child process: the allowlisted subset of the
 * host env, plus operator-requested passthrough names, plus everything the
 * sandbox itself set via setEnvVars (proxy vars, CA bundle paths, memory
 * mount dirs, env_secret resources, …). Sandbox-set values win.
 */
export function buildSandboxProcessEnv(opts: {
  hostEnv: Record<string, string | undefined>;
  sandboxEnv: Record<string, string>;
  workdir: string;
  passthrough?: readonly string[];
}): Record<string, string> {
  const out: Record<string, string> = {};
  const allow = new Set<string>([...SANDBOX_ENV_ALLOWLIST, ...(opts.passthrough ?? [])]);
  for (const [k, v] of Object.entries(opts.hostEnv)) {
    if (typeof v !== "string") continue;
    if (allow.has(k) || k.startsWith("LC_")) out[k] = v;
  }
  if (!out.PATH) out.PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
  Object.assign(out, opts.sandboxEnv);
  out.PWD = opts.workdir;
  return out;
}

/**
 * Signal a child spawned with `detached: true` and everything in its
 * process group (negative pid). Falls back to the child alone when the
 * group is gone or group signalling isn't available.
 */
function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid && process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") return; // already gone
    }
  }
  child.kill(signal);
}

/** SIGTERM the process tree, then SIGKILL it after a short grace. */
function terminateTree(child: ChildProcess, graceMs = 1_000): void {
  signalTree(child, "SIGTERM");
  const t = setTimeout(() => {
    try { signalTree(child, "SIGKILL"); } catch { /* already gone */ }
  }, graceMs);
  t.unref?.();
}

class BackgroundProcess implements ProcessHandle {
  pid: number;
  private child: ChildProcess;
  private stdout = "";
  private stderr = "";
  private exitCode: number | null = null;
  private exitSignal: NodeJS.Signals | null = null;

  constructor(public id: string, child: ChildProcess) {
    this.child = child;
    this.pid = child.pid ?? 0;
    child.stdout?.on("data", (b: Buffer) => { this.stdout += b.toString("utf8"); });
    child.stderr?.on("data", (b: Buffer) => { this.stderr += b.toString("utf8"); });
    child.on("close", (code, signal) => {
      this.exitCode = code;
      this.exitSignal = signal as NodeJS.Signals | null;
    });
  }

  async kill(signal: string): Promise<void> {
    try {
      signalTree(this.child, signal as NodeJS.Signals);
    } catch (err) {
      throw new Error(`kill failed: ${(err as Error).message}`);
    }
  }

  async getLogs(): Promise<{ stdout: string; stderr: string }> {
    return { stdout: this.stdout, stderr: this.stderr };
  }

  async getStatus(): Promise<string> {
    if (this.exitCode === null && this.exitSignal === null) return "running";
    // Match the status vocabulary @cloudflare/sandbox uses — pollWithStrategies
    // in apps/agent/src/harness/tools.ts checks for "completed" / "error" /
    // "killed" exactly. Returning "exited:0" / "signaled:SIGTERM" silently
    // hangs the harness's tool-call wait loop until the watchdog fires.
    if (this.exitSignal) return "killed";
    return this.exitCode === 0 ? "completed" : "error";
  }
}

// ── Factory (DIP entry point) ───────────────────────────────────────

export const sandboxFactory: SandboxFactory = async (ctx) => {
  warnIfUnsafeInProduction(process.env);
  return new LocalSubprocessSandbox({
    workdir: ctx.workdir,
    memoryRoot: ctx.memoryRoot,
    outputsRoot: ctx.outputsRoot,
  });
};

let warnedUnsafeProd = false;

/**
 * Loud (once-per-process) warning when the zero-isolation subprocess
 * provider runs with NODE_ENV=production. Not a hard refusal: the default
 * docker-compose quickstart ships NODE_ENV=production with this provider,
 * and breaking it would push people off the vault/egress path entirely.
 * Operators who want a hard stop set OMA_REQUIRE_ISOLATED_SANDBOX=1
 * (enforced in main-node); OMA_ALLOW_UNSAFE_SUBPROCESS=1 silences the
 * warning after an explicit decision.
 */
export function warnIfUnsafeInProduction(env: Record<string, string | undefined>): boolean {
  if (env.NODE_ENV !== "production") return false;
  if (env.OMA_ALLOW_UNSAFE_SUBPROCESS === "1" || env.OMA_ALLOW_UNSAFE_SUBPROCESS === "true") return false;
  if (warnedUnsafeProd) return true;
  warnedUnsafeProd = true;
  moduleLogger.warn(
    { op: "local_sandbox.unsafe_in_production" },
    "SANDBOX_PROVIDER=subprocess in NODE_ENV=production: agent commands run as host subprocesses with " +
      "NO isolation (same OS user, same filesystem, direct network access that can bypass the vault proxy " +
      "and egress policy). Use daytona / e2b / litebox / boxrun for untrusted agents, or set " +
      "OMA_ALLOW_UNSAFE_SUBPROCESS=1 to acknowledge.",
  );
  return true;
}
