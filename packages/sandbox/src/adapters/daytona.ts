// Daytona SaaS implementation of SandboxExecutor.
//
// One DaytonaSandbox per session. Where its Daytona Sandbox (a managed Linux
// VM with FileSystem + Process APIs) comes from is decided by a
// `SandboxBoxProvider` (daytona-box-provider.ts): the default
// `SessionBoxProvider` creates a box per session on first use and deletes it
// on destroy; the agent-machine provider hands out a persistent per-agent
// box instead. Lazy-created on first use because sandbox boot is ~5–10s and
// the harness's first call is usually a real exec — we don't want to pay the
// latency before we know we need it.
//
// Background processes (`startProcess`) are Daytona process sessions, see
// daytona-process.ts.
//
// Driver dep is a peer with peerDependenciesMeta.optional so this package
// compiles + runs without `@daytonaio/sdk` installed. self-host deploys that
// want this adapter install it: `pnpm add @daytonaio/sdk`.
//
// Auth: pass apiKey in opts OR set DAYTONA_API_KEY in process.env.
//
// Outbound credential injection (oma-vault): on first sandbox creation we
// upload OMA_VAULT_CA_CERT into the box at /etc/ssl/oma-vault-ca.crt, then
// every exec gets HTTP(S)_PROXY / NODE_EXTRA_CA_CERTS / SSL_CERT_FILE /
// CURL_CA_BUNDLE pointing at the proxy + uploaded cert. The proxy URL must
// be reachable from inside the Daytona sandbox network — set OMA_VAULT_
// PROXY_URL to a public host (or a tunneled URL like ngrok) when running
// remote.
//
// Memory/output resources: Daytona containers do not reliably support FUSE
// installs, so this adapter avoids s3fs. It syncs the configured S3/R2 prefix
// through Daytona's file API into normal sandbox paths:
//   /mnt/memory/<storeName>
//   /mnt/session/outputs
// Writes are synced back to S3/R2 after each exec.
//
// SECURITY: Daytona runs each sandbox in an isolated VM so this is the
// safer choice for production / untrusted agents vs LocalSubprocessSandbox.

import type { ProcessHandle, SandboxExecutor, SandboxFactory, SandboxProcessInfo } from "../ports";
import type { AgentMachineManager } from "../machines/manager";
import { readS3MemoryBucket } from "../ports";
import { promises as fs } from "node:fs";
import { nanoid } from "nanoid";
import { getLogger } from "@open-managed-agents/observability";
import { withSessionProxyContext } from "./outbound-proxy";
import type {
  DaytonaExecuteResponse,
  DaytonaModule,
  DaytonaSandboxInstance,
} from "./daytona-types";
import { isDaytonaNotFound } from "./daytona-types";
import type { SandboxBoxProvider } from "./daytona-box-provider";
import { SessionBoxProvider } from "./daytona-box-provider";
import {
  DaytonaProcessHandle,
  buildEnvFileContents,
  buildProcessWrapperCommand,
} from "./daytona-process";

// Box creation params live next to the SessionBoxProvider; re-exported here
// so existing importers (test/unit/sandbox-storage-policy) keep working.
export { buildDaytonaCreateParams } from "./daytona-box-provider";

const moduleLogger = getLogger("daytona-sandbox");
const DEFAULT_MAX_FILE_BYTES = 512 * 1024 * 1024;
const DEFAULT_WORKDIR = "/workspace";
const DEFAULT_TOOLS_READY_MARKER = "/tmp/.oma-daytona-tools-ready";
const DEFAULT_BOOTSTRAP_APT_PACKAGES = [
  "build-essential",
  "ca-certificates",
  "coreutils",
  "curl",
  "file",
  "findutils",
  "gawk",
  "git",
  "grep",
  "jq",
  "less",
  "procps",
  "python3",
  "python3-pip",
  "python3-venv",
  "ripgrep",
  "sed",
  "unzip",
  "zip",
];

export interface DaytonaSandboxOptions {
  /** Per-session identifier — used as the Sandbox label so existing
   *  sandboxes can be looked up after a process restart. */
  sessionId: string;
  /** Daytona API key. Falls back to DAYTONA_API_KEY env var. */
  apiKey?: string;
  /** Daytona API URL (when self-hosting). Falls back to DAYTONA_API_URL. */
  apiUrl?: string;
  /** Container image to run. Default: `node:22-bookworm`. The adapter
   *  bootstraps a coding-tool baseline on first use, so Debian/Ubuntu images
   *  with apt are strongly preferred. */
  image?: string;
  /** Directory used as cwd for agent commands. Defaults to /workspace. */
  workdir?: string;
  /** Install the default coding-tool baseline on sandbox creation. Defaults
   *  to true; set DAYTONA_BOOTSTRAP_TOOLS=false to skip. */
  bootstrapTools?: boolean;
  /** Apt package list for Daytona bootstrap. Defaults to Python, Git, curl,
   *  jq, ripgrep, build-essential, and common shell utilities. */
  bootstrapAptPackages?: string[];
  /** Default per-call timeout (ms). Per-call timeout overrides this. */
  defaultTimeoutMs?: number;
  /** Logger for debug/warn output. */
  logger?: { warn: (msg: string, ctx?: unknown) => void; log: (msg: string) => void };
  /** Optional S3/R2 bucket config for memory/output sync. When set,
   *  Daytona memory stores and session outputs are copied through the
   *  Daytona file API instead of FUSE-mounted. */
  memoryBucket?: {
    endpoint: string;       // e.g. https://s3.amazonaws.com or your minio
    accessKey: string;
    secretKey: string;
    bucketName: string;
    region?: string;
  };
  /** Per-file write ceiling inside the Daytona sandbox. This is a guardrail
   *  against accidentally filling the provider quota with generated blobs or
   *  workspace backup temp files. Defaults to 512 MiB. */
  maxFileBytes?: number;
  /** Delete the Daytona sandbox as soon as Daytona stops it. Defaults to true
   *  because durable state lives in the session log, R2 outputs, and memory
   *  stores, not in the sandbox's scratch filesystem. */
  ephemeral?: boolean;
  /** Where the box comes from. Default: a `SessionBoxProvider` (create on
   *  first use, delete on destroy — today's per-session behaviour). Agent
   *  scope passes the per-agent machine provider instead. */
  box?: SandboxBoxProvider;
  /** Pre-loaded `@daytonaio/sdk` module (tests pass the in-memory fake).
   *  Default: dynamic import on first use. */
  daytonaModule?: DaytonaModule;
}

interface S3Runtime {
  client: { send(command: unknown): Promise<unknown> };
  ListObjectsV2Command: new (input: unknown) => unknown;
  GetObjectCommand: new (input: unknown) => unknown;
  PutObjectCommand: new (input: unknown) => unknown;
}

interface MountedMemoryStore {
  storeName: string;
  storeId: string;
  readOnly: boolean;
  mountPoint: string;
}

interface MountedOutputs {
  tenantId: string;
  sessionId: string;
  mountPoint: string;
}

export class DaytonaSandbox implements SandboxExecutor {
  private envVars: Record<string, string> = {};
  private commandSecrets: Array<{ prefix: string; secrets: Record<string, string> }> = [];
  private sandboxPromise: Promise<DaytonaSandboxInstance> | null = null;
  private readonly box: SandboxBoxProvider;
  private readonly daytonaModule: DaytonaModule | null;
  private logger: NonNullable<DaytonaSandboxOptions["logger"]>;
  private maxFileBytes: number;
  private s3RuntimePromise: Promise<S3Runtime> | null = null;
  private mountedMemoryStores = new Map<string, MountedMemoryStore>();
  private mountedOutputs: MountedOutputs | null = null;
  /** Generation of the box `sandboxPromise` currently resolves to. */
  private currentGeneration: number | null = null;
  /** Generation the vault CA cert was last uploaded into. */
  private caGeneration: number | null = null;
  /** Generation the memory/outputs mounts were last materialised on; null
   *  while nothing is mounted. */
  private mountedGeneration: number | null = null;
  /** True while ensureSandbox() runs on behalf of withSandboxRecovery. */
  private recovering = false;
  private recoverFromSandboxId: string | null = null;
  /** In-flight replacement of a vanished box, shared by concurrent callers. */
  private recovery: { failedSandboxId: string; promise: Promise<DaytonaSandboxInstance> } | null = null;
  private processes = new Map<string, DaytonaProcessHandle>();
  private processStartedAt = new Map<string, number>();

  constructor(private opts: DaytonaSandboxOptions) {
    this.maxFileBytes = normalizeMaxFileBytes(opts.maxFileBytes);
    this.logger = opts.logger ?? {
      warn: (msg, ctx) => console.warn(`[daytona-sandbox] ${msg}`, ctx ?? ""),
      log: (msg) => console.log(`[daytona-sandbox] ${msg}`),
    };
    this.daytonaModule = opts.daytonaModule ?? null;
    this.box = opts.box ?? new SessionBoxProvider({
      sessionId: opts.sessionId,
      apiKey: opts.apiKey,
      apiUrl: opts.apiUrl,
      image: opts.image,
      ephemeral: opts.ephemeral,
      daytonaModule: opts.daytonaModule,
      bootstrap: (sb) => this.bootstrapSandbox(sb),
      logger: this.logger,
    });
  }

  async exec(command: string, timeout?: number): Promise<string> {
    const storagePolicyError = this.validateCommandStoragePolicy(command);
    if (storagePolicyError) return `[error: ${storagePolicyError}]`;
    try {
      return await this.withSandboxRecovery("exec", async (sb) => {
        await this.syncMountedResourcesFromS3(sb);
        const env = this.buildEnv(command);
        const timeoutMs = timeout ?? this.opts.defaultTimeoutMs ?? 120_000;
        const guardedCommand = this.withFileSizeLimit(command);
        try {
          // Daytona's executeCommand timeout is in seconds; round up to the
          // nearest second so a 100ms timeout doesn't degenerate to 0.
          const r = await sb.process.executeCommand(
            guardedCommand,
            this.workdir(),
            env,
            Math.max(1, Math.ceil(timeoutMs / 1000)),
          );
          const stdout = r.artifacts?.stdout ?? r.result ?? "";
          const stderr = r.artifacts?.stderr ?? "";
          // Match @cloudflare/sandbox + LocalSubprocess: combined output, exit
          // suffix on non-zero. The harness's bash tool parser keys off this.
          const combined =
            (stdout + (stderr ? `\n${stderr}` : "")).replace(/\s+$/, "") +
            (r.exitCode !== 0 ? `\n[exit ${r.exitCode}]` : "");
          return combined;
        } finally {
          await this.syncMountedResourcesToS3(sb).catch((err) => {
            this.logger.warn(`resource sync after exec failed: ${(err as Error).message}`);
          });
        }
      });
    } catch (err) {
      return `[error: ${(err as Error).message}]`;
    }
  }

  /**
   * Background process = one Daytona process session per command (see
   * daytona-process.ts). Returns null — so the bash tool falls back to
   * exec() — when the command violates the storage policy (exec() then
   * surfaces the same error text) or when the SDK refuses to start it.
   */
  async startProcess(command: string): Promise<ProcessHandle | null> {
    const storagePolicyError = this.validateCommandStoragePolicy(command);
    if (storagePolicyError) {
      this.logger.warn(`startProcess refused by storage policy: ${storagePolicyError}`);
      return null;
    }
    try {
      return await this.withSandboxRecovery("startProcess", async (sb) => {
        await this.syncMountedResourcesFromS3(sb);
        const procId = `p${nanoid(10)}`;
        const procDir = this.box.procDir();
        const envFile = `${procDir}/${procId}.env`;
        const pidFile = `${procDir}/${procId}.pid`;
        const sessionName = `oma-proc-${procId}`;
        await this.runSetup(
          sb,
          `mkdir -p ${shellEscape(procDir)} && chmod 700 ${shellEscape(procDir)}`,
          "create process dir",
        );
        await sb.fs.uploadFile(
          Buffer.from(buildEnvFileContents(this.buildEnv(command)), "utf8"),
          envFile,
        );
        await this.runSetup(sb, `chmod 600 ${shellEscape(envFile)}`, "protect process env file");
        const wrapper = buildProcessWrapperCommand({
          procId,
          cwd: this.workdir(),
          envFile,
          pidFile,
          fileSizeBlocks: this.fileSizeBlocks(),
          command,
        });
        await sb.process.createSession(sessionName);
        let cmdId: string;
        try {
          const started = await sb.process.executeSessionCommand(
            sessionName,
            { command: wrapper, runAsync: true },
          );
          cmdId = started.cmdId;
        } catch (err) {
          await sb.process.deleteSession(sessionName).catch(() => { /* best effort */ });
          throw err;
        }
        const handle = new DaytonaProcessHandle({
          sb,
          sessionName,
          cmdId,
          procId,
          pidFile,
          logger: this.logger,
          onTerminal: async () => {
            this.processes.delete(procId);
            this.processStartedAt.delete(procId);
            this.box.unwatchProcess?.(procId);
            this.box.setActivityKey?.(`proc:${procId}`, false);
            if (this.mountedMemoryStores.size > 0 || this.mountedOutputs) {
              await this.syncMountedResourcesToS3(sb).catch((err) => {
                this.logger.warn(
                  `resource sync after process ${procId} exit failed: ${(err as Error).message}`,
                );
              });
            }
          },
        });
        await handle.resolvePid();
        this.processes.set(procId, handle);
        this.processStartedAt.set(procId, Date.now());
        this.box.watchProcess?.(procId, () => handle.getStatus());
        this.box.setActivityKey?.(`proc:${procId}`, true);
        this.logger.log(`started process ${procId} (pid ${handle.pid}) in session ${sessionName}`);
        return handle;
      });
    } catch (err) {
      this.logger.warn(
        `startProcess failed: ${(err as Error).message} — falling back to exec()`,
      );
      return null;
    }
  }

  /** Keep the box alive while a long turn / background task is running. A
   *  no-op until the box exists — a keep-alive ping must never create one. */
  async renewActivityTimeout(): Promise<void> {
    if (!this.sandboxPromise) return;
    const sb = await this.ensureSandbox();
    await sb.refreshActivity();
  }

  async setTurnActive(active: boolean): Promise<void> {
    await this.box.setTurnActive?.(active);
  }

  sessionOutputsPath(): string {
    return `${this.box.sessionDir() ?? "/mnt/session"}/outputs`;
  }

  async getBrowserEndpoint() {
    return this.box.getBrowserEndpoint?.() ?? null;
  }

  sandboxCapabilities() {
    return { scope: this.box.scope, browser: this.box.browserEnabled === true };
  }

  async listProcesses(): Promise<SandboxProcessInfo[]> {
    return Promise.all([...this.processes.values()].map(async (handle) => ({
      id: handle.id, pid: handle.pid, startedAt: this.processStartedAt.get(handle.id) ?? 0,
      status: await handle.getStatus(),
    })));
  }

  async setEnvVars(envVars: Record<string, string>): Promise<void> {
    this.envVars = { ...this.envVars, ...envVars };
  }

  registerCommandSecrets(commandPrefix: string, secrets: Record<string, string>): void {
    this.commandSecrets.push({ prefix: commandPrefix, secrets });
  }

  async setOutboundContext(opts?: { tenantId: string; sessionId: string }): Promise<void> {
    const proxyUrl = process.env.OMA_VAULT_PROXY_URL;
    const caCertPath = process.env.OMA_VAULT_CA_CERT;
    if (!proxyUrl || !caCertPath) return;
    // Defer the actual cert upload until the sandbox is created — we need
    // the box to exist before we can fs.uploadFile into it. The proxy URL
    // must be reachable from inside the Daytona sandbox network; if it's
    // a localhost URL the operator probably wants ngrok / a public URL
    // for remote deploys.
    if (proxyUrl.startsWith("http://localhost") || proxyUrl.startsWith("http://127.")) {
      this.logger.warn(
        `[daytona] OMA_VAULT_PROXY_URL points at localhost (${proxyUrl}) — ` +
        `this is unreachable from inside Daytona's network. Set a public URL ` +
        `or tunnel the vault (e.g. ngrok http 14322).`,
      );
    }
    this.pendingCaUpload = { hostPath: caCertPath };
    const inBoxCaPath = "/etc/ssl/oma-vault-ca.crt";
    const scopedProxyUrl = withSessionProxyContext(proxyUrl, opts);
    await this.setEnvVars({
      HTTP_PROXY: scopedProxyUrl,
      HTTPS_PROXY: scopedProxyUrl,
      http_proxy: scopedProxyUrl,
      https_proxy: scopedProxyUrl,
      NODE_EXTRA_CA_CERTS: inBoxCaPath,
      SSL_CERT_FILE: inBoxCaPath,
      CURL_CA_BUNDLE: inBoxCaPath,
    });
  }

  async readFile(path: string): Promise<string> {
    return this.withSandboxRecovery("readFile", async (sb) => {
      const buf = await sb.fs.downloadFile(this.normalise(path));
      return buf.toString("utf8");
    });
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    return this.withSandboxRecovery("readFileBytes", async (sb) => {
      const buf = await sb.fs.downloadFile(this.normalise(path));
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    });
  }

  async writeFile(path: string, content: string): Promise<string> {
    const target = this.normalise(path);
    this.assertAllowedWrite(target, Buffer.byteLength(content, "utf8"));
    return this.withSandboxRecovery("writeFile", async (sb) => {
      await this.ensureParentDir(sb, target);
      await sb.fs.uploadFile(Buffer.from(content, "utf8"), target);
      await this.syncAfterMutation(sb, target);
      return target;
    });
  }

  async writeFileBytes(path: string, bytes: Uint8Array): Promise<string> {
    const target = this.normalise(path);
    this.assertAllowedWrite(target, bytes.byteLength);
    return this.withSandboxRecovery("writeFileBytes", async (sb) => {
      await this.ensureParentDir(sb, target);
      await sb.fs.uploadFile(Buffer.from(bytes), target);
      await this.syncAfterMutation(sb, target);
      return target;
    });
  }

  /**
   * Write-back after a FILE-TOOL mutation. exec() already syncs mounted
   * resources in its finally (bash edits), but the write/edit tools go
   * through fs.uploadFile — without this, a file written into
   * /mnt/memory/<store>/ via the write tool never reached S3, so the
   * "durable" memory evaporated with the sandbox (verified live on prod
   * 2026-07-16: session 1 wrote codeword.md via the write tool, a fresh
   * session's mount came up empty). Scoped to mutations under a mounted
   * resource so plain workdir writes don't pay the sync round-trip.
   */
  private async syncAfterMutation(
    sb: DaytonaSandboxInstance,
    target: string,
  ): Promise<void> {
    const underMount =
      [...this.mountedMemoryStores.values()].some((m) =>
        target.startsWith(`${m.mountPoint}/`),
      ) ||
      (this.mountedOutputs
        ? target.startsWith(`${this.mountedOutputs.mountPoint}/`)
        : false);
    if (!underMount) return;
    await this.syncMountedResourcesToS3(sb).catch((err) => {
      this.logger.warn(
        `resource sync after file write failed: ${(err as Error).message}`,
      );
    });
  }

  async destroy(): Promise<void> {
    if (this.box.scope === "session") await this.killTrackedProcesses();
    if (this.sandboxPromise) {
      try {
        const sb = await this.sandboxPromise;
        if (this.mountedMemoryStores.size > 0 || this.mountedOutputs) {
          await this.syncMountedResourcesToS3(sb).catch((err) => {
            this.logger.warn(`resource sync before destroy failed: ${(err as Error).message}`);
          });
        }
      } catch {
        // The box never came up; nothing to flush.
      }
    }
    try {
      await this.box.release();
    } catch (err) {
      this.logger.warn(`destroy failed: ${(err as Error).message}`);
    } finally {
      this.sandboxPromise = null;
      this.currentGeneration = null;
    }
  }

  private async killTrackedProcesses(): Promise<void> {
    const handles = [...this.processes.values()];
    this.processes.clear();
    if (handles.length === 0) return;
    await Promise.all(
      handles.map((h) =>
        h.kill("SIGTERM").catch((err) => {
          this.logger.warn(`kill of process ${h.id} during destroy failed: ${(err as Error).message}`);
        }),
      ),
    );
  }

  async mountMemoryStore(opts: {
    storeName: string;
    storeId: string;
    readOnly: boolean;
  }): Promise<void> {
    this.memoryBucketConfig("mountMemoryStore");
    await this.withSandboxRecovery("mountMemoryStore", async (sb) => {
      const mountPoint = `/mnt/memory/${opts.storeName}`;
      await this.runSetup(
        sb,
        this.box.scope === "agent"
          ? `mkdir -p ${shellEscape(mountPoint)}`
          : `mkdir -p /mnt/memory && rm -rf ${shellEscape(mountPoint)} && mkdir -p ${shellEscape(mountPoint)}`,
        "create memory mount",
      );
      const mount = { ...opts, mountPoint };
      this.mountedMemoryStores.set(opts.storeId, mount);
      this.mountedGeneration = this.currentGeneration;
      await this.syncMemoryStoreFromS3(sb, mount);
      this.logger.log(`mounted memory store ${opts.storeName} at ${mountPoint} ${opts.readOnly ? "(ro)" : ""}`);
    });
  }

  async mountSessionOutputs(opts: {
    tenantId: string;
    sessionId: string;
  }): Promise<void> {
    if (opts.sessionId !== this.opts.sessionId) throw new Error("outputs mount belongs to another session");
    if (this.box.scope === "session") this.memoryBucketConfig("mountSessionOutputs");
    await this.withSandboxRecovery("mountSessionOutputs", async (sb) => {
      const mountPoint = this.sessionOutputsPath();
      await this.runSetup(
        sb,
        this.box.scope === "agent"
          ? `mkdir -p ${shellEscape(mountPoint)}`
          : `mkdir -p /mnt/session && rm -rf ${shellEscape(mountPoint)} && mkdir -p ${shellEscape(mountPoint)}`,
        "create outputs mount",
      );
      this.mountedOutputs = { ...opts, mountPoint };
      this.mountedGeneration = this.currentGeneration;
      this.logger.log(`mounted session outputs at ${mountPoint}`);
    });
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private pendingCaUpload: { hostPath: string } | null = null;

  /** Daytona 404s a deleted/archived box with messages like
   *  "not found: sandbox <uuid> not found (it has been deleted)". Keep the
   *  match narrow — a missing FILE error must not trigger re-provisioning
   *  (see isDaytonaNotFound for why `instanceof DaytonaNotFoundError` alone
   *  is not enough). */
  private isSandboxGone(err: unknown): boolean {
    return isDaytonaNotFound(err, this.daytonaModule);
  }

  /**
   * Daytona auto-stops idle sandboxes and eventually deletes them
   * server-side, while the Node registry can hold this adapter (and its
   * cached sandbox handle) in memory for hours. Without recovery, every
   * exec/file op on such a session fails "sandbox <id> not found (it has
   * been deleted)" forever — seen live on prod 2026-07-25 (docs-agent
   * session bricked after 7h idle). Recovery: drop the dead handle,
   * provision a fresh box (bootstrap + CA upload re-run inside
   * ensureSandbox), replay recorded memory/output mounts so durable state
   * re-syncs from S3, then retry the operation once. Non-mounted workspace
   * files are gone with the old box — callers see a fresh workdir instead
   * of a permanent error loop.
   */
  private async withSandboxRecovery<T>(
    op: string,
    fn: (sb: DaytonaSandboxInstance) => Promise<T>,
  ): Promise<T> {
    return this.box.lockShared(async () => {
    const sb = await this.ensureSandbox();
    const promiseAtStart = this.sandboxPromise;
    // Agent scope: the provider may have swapped the box underneath us
    // (another session triggered a recreate). Mounts recorded on an older
    // generation have to be materialised again before touching the box.
    if (this.mountedGeneration !== null && this.mountedGeneration !== this.currentGeneration) {
      await this.replayMounts(sb);
    }
    try {
      return await fn(sb);
    } catch (err) {
      if (!this.isSandboxGone(err)) throw err;
      const fresh = await this.recoverFrom(sb, promiseAtStart, op);
      return await fn(fresh);
    }
    });
  }

  /**
   * Provision the replacement for `dead` exactly once, even when several
   * concurrent operations (parallel tool calls) observe the same gone box:
   * the first caller starts the recovery, later callers for the same box
   * join it, and a caller that failed after the recovery already finished
   * reuses the replacement instead of creating a third box (which leaked
   * the second one and ran the retried op on an orphan).
   */
  private async recoverFrom(
    dead: DaytonaSandboxInstance,
    promiseAtStart: Promise<DaytonaSandboxInstance> | null,
    op: string,
  ): Promise<DaytonaSandboxInstance> {
    if (this.recovery && this.recovery.failedSandboxId === dead.id) {
      return this.recovery.promise;
    }
    if (this.sandboxPromise && this.sandboxPromise !== promiseAtStart) {
      // Someone already swapped the box (recovery finished); its mounts were
      // replayed by that recovery.
      return this.sandboxPromise;
    }
    this.logger.warn(
      `sandbox deleted upstream during ${op} — provisioning a replacement`,
    );
    const promise = (async () => {
      this.sandboxPromise = null;
      this.recovering = true;
      this.recoverFromSandboxId = dead.id;
      let fresh: DaytonaSandboxInstance;
      try {
        fresh = await this.ensureSandbox();
      } finally {
        this.recovering = false;
        this.recoverFromSandboxId = null;
      }
      await this.replayMounts(fresh);
      return fresh;
    })();
    const entry = { failedSandboxId: dead.id, promise };
    this.recovery = entry;
    try {
      return await promise;
    } finally {
      if (this.recovery === entry) this.recovery = null;
    }
  }

  private async replayMounts(sb: DaytonaSandboxInstance): Promise<void> {
    this.mountedGeneration = this.currentGeneration;
    for (const mount of this.mountedMemoryStores.values()) {
      await this.runSetup(
        sb,
        this.box.scope === "agent"
          ? `mkdir -p ${shellEscape(mount.mountPoint)}`
          : `mkdir -p /mnt/memory && rm -rf ${shellEscape(mount.mountPoint)} && mkdir -p ${shellEscape(mount.mountPoint)}`,
        "re-create memory mount",
      );
    }
    if (this.mountedOutputs) {
      await this.runSetup(
        sb,
        `mkdir -p ${shellEscape(this.mountedOutputs.mountPoint)}`,
        "re-create outputs mount",
      );
    }
    if (this.mountedMemoryStores.size > 0 || this.mountedOutputs) {
      await this.syncMountedResourcesFromS3(sb).catch((err) => {
        this.logger.warn(
          `mount re-sync after sandbox recovery failed: ${(err as Error).message}`,
        );
      });
    }
  }

  private async ensureSandbox(): Promise<DaytonaSandboxInstance> {
    // A different session or host can stop/recreate an agent machine.
    // Re-resolve the durable provider identity while holding the lease.
    if (this.sandboxPromise && this.box.scope === "session") return this.sandboxPromise;
    const promise = (async () => {
      const acquired = await this.box.acquire({
        reason: this.recovering ? "recover" : "use",
        ...(this.recoverFromSandboxId ? { failedSandboxId: this.recoverFromSandboxId } : {}),
      });
      const sb = acquired.sb;
      this.currentGeneration = acquired.generation;

      // Apply pending CA upload now that the box exists (once per box
      // generation). If upload fails the per-exec env vars still point at
      // the missing path and outbound TLS will fail with cert errors —
      // surfaced naturally.
      if (
        this.pendingCaUpload &&
        (acquired.freshlyCreated || acquired.generation !== this.caGeneration)
      ) {
        try {
          const buf = await fs.readFile(this.pendingCaUpload.hostPath);
          await sb.fs.createFolder("/etc/ssl", "0755").catch(() => { /* exists */ });
          await sb.fs.uploadFile(buf, "/etc/ssl/oma-vault-ca.crt");
          this.caGeneration = acquired.generation;
          this.logger.log(`uploaded vault CA cert (${buf.byteLength} bytes)`);
        } catch (err) {
          this.logger.warn(
            `vault CA upload failed: ${(err as Error).message} — outbound ` +
            `TLS through oma-vault will fail with cert errors`,
          );
        }
      }
      return sb;
    })();
    this.sandboxPromise = promise;
    // Don't cache a failed provisioning attempt forever — the next call
    // retries (today's behaviour bricked the session on a transient error).
    promise.catch(() => {
      if (this.sandboxPromise === promise) this.sandboxPromise = null;
    });
    return promise;
  }

  private memoryBucketConfig(
    op: string,
  ): NonNullable<DaytonaSandboxOptions["memoryBucket"]> {
    const cfg = this.opts.memoryBucket;
    if (!cfg) {
      throw new Error(
        `DaytonaSandbox.${op}: no S3/R2 bucket config — set MEMORY_S3_ENDPOINT, ` +
        "MEMORY_S3_BUCKET, MEMORY_S3_ACCESS_KEY, and MEMORY_S3_SECRET_KEY so " +
        "remote memory/output resources can be synced.",
      );
    }
    return cfg;
  }

  private async ensureS3Runtime(): Promise<S3Runtime> {
    const cfg = this.opts.memoryBucket;
    if (!cfg) throw new Error("DaytonaSandbox: memoryBucket config missing");
    if (!this.s3RuntimePromise) {
      this.s3RuntimePromise = (async () => {
        const sdk = (await import(
          /* @vite-ignore */ "@aws-sdk/client-s3" as string
        )) as {
          S3Client: new (config: unknown) => { send(command: unknown): Promise<unknown> };
          ListObjectsV2Command: new (input: unknown) => unknown;
          GetObjectCommand: new (input: unknown) => unknown;
          PutObjectCommand: new (input: unknown) => unknown;
        };
        const client = new sdk.S3Client({
          region: cfg.region ?? process.env.MEMORY_S3_REGION ?? "auto",
          endpoint: cfg.endpoint,
          forcePathStyle: true,
          credentials: {
            accessKeyId: cfg.accessKey,
            secretAccessKey: cfg.secretKey,
          },
        });
        return {
          client,
          ListObjectsV2Command: sdk.ListObjectsV2Command,
          GetObjectCommand: sdk.GetObjectCommand,
          PutObjectCommand: sdk.PutObjectCommand,
        };
      })();
    }
    return this.s3RuntimePromise;
  }

  private async syncMountedResourcesFromS3(sb: DaytonaSandboxInstance): Promise<void> {
    for (const mount of this.mountedMemoryStores.values()) {
      await this.syncMemoryStoreFromS3(sb, mount);
    }
  }

  private async syncMountedResourcesToS3(sb: DaytonaSandboxInstance): Promise<void> {
    if (!this.opts.memoryBucket) return;
    for (const mount of this.mountedMemoryStores.values()) {
      if (!mount.readOnly) await this.syncDirectoryToS3(sb, mount.mountPoint, `${mount.storeId}/`);
    }
    if (this.mountedOutputs) {
      await this.syncDirectoryToS3(
        sb,
        this.mountedOutputs.mountPoint,
        `session-outputs/${this.mountedOutputs.tenantId}/${this.mountedOutputs.sessionId}/`,
      );
    }
  }

  private async syncMemoryStoreFromS3(
    sb: DaytonaSandboxInstance,
    mount: MountedMemoryStore,
  ): Promise<void> {
    await this.runSetup(
      sb,
      `mkdir -p ${shellEscape(mount.mountPoint)} && chmod -R u+w ${shellEscape(mount.mountPoint)} 2>/dev/null || true`,
      `prepare memory mount ${mount.storeName}`,
    );
    await this.syncS3PrefixToDirectory(sb, `${mount.storeId}/`, mount.mountPoint);
    if (mount.readOnly) {
      await this.runSetup(
        sb,
        `chmod -R a-w ${shellEscape(mount.mountPoint)} 2>/dev/null || true`,
        `mark memory mount ${mount.storeName} read-only`,
      );
    }
  }

  private async syncS3PrefixToDirectory(
    sb: DaytonaSandboxInstance,
    prefix: string,
    mountPoint: string,
  ): Promise<void> {
    const cfg = this.opts.memoryBucket;
    if (!cfg) throw new Error("DaytonaSandbox: memoryBucket config missing");
    const s3 = await this.ensureS3Runtime();
    let continuationToken: string | undefined;
    do {
      const page = await s3.client.send(new s3.ListObjectsV2Command({
        Bucket: cfg.bucketName,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })) as {
        Contents?: Array<{ Key?: string; Size?: number }>;
        IsTruncated?: boolean;
        NextContinuationToken?: string;
      };
      for (const obj of page.Contents ?? []) {
        if (!obj.Key || obj.Key === prefix || obj.Key.endsWith("/")) continue;
        if (obj.Size !== undefined && obj.Size > this.maxFileBytes) {
          this.logger.warn(`skipping oversized S3 object ${obj.Key} (${obj.Size} bytes)`);
          continue;
        }
        const rel = safeRelativePath(obj.Key.slice(prefix.length));
        if (!rel) continue;
        const got = await s3.client.send(new s3.GetObjectCommand({
          Bucket: cfg.bucketName,
          Key: obj.Key,
        })) as { Body?: unknown };
        const body = await bodyToBuffer(got.Body);
        if (body.byteLength > this.maxFileBytes) {
          this.logger.warn(`skipping oversized S3 object ${obj.Key} (${body.byteLength} bytes)`);
          continue;
        }
        const remotePath = remoteJoin(mountPoint, rel);
        await this.runSetup(sb, `mkdir -p ${shellEscape(remoteDirname(remotePath))}`, "create synced file parent");
        await sb.fs.uploadFile(body, remotePath);
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);
  }

  private async syncDirectoryToS3(
    sb: DaytonaSandboxInstance,
    mountPoint: string,
    prefix: string,
  ): Promise<void> {
    const cfg = this.opts.memoryBucket;
    if (!cfg) throw new Error("DaytonaSandbox: memoryBucket config missing");
    const s3 = await this.ensureS3Runtime();
    for (const file of await this.listSandboxFiles(sb, mountPoint)) {
      if (file.size > this.maxFileBytes) {
        this.logger.warn(`skipping oversized sandbox file ${remoteJoin(mountPoint, file.path)} (${file.size} bytes)`);
        continue;
      }
      const remotePath = remoteJoin(mountPoint, file.path);
      const body = await sb.fs.downloadFile(remotePath, 60);
      if (body.byteLength > this.maxFileBytes) {
        this.logger.warn(`skipping oversized sandbox file ${remotePath} (${body.byteLength} bytes)`);
        continue;
      }
      await s3.client.send(new s3.PutObjectCommand({
        Bucket: cfg.bucketName,
        Key: `${prefix}${file.path}`,
        Body: body,
      }));
    }
  }

  private async listSandboxFiles(
    sb: DaytonaSandboxInstance,
    mountPoint: string,
  ): Promise<Array<{ path: string; size: number }>> {
    const r = await sb.process.executeCommand(
      `if [ -d ${shellEscape(mountPoint)} ]; then find ${shellEscape(mountPoint)} -type f -printf '%P\\t%s\\n'; fi`,
      undefined,
      undefined,
      60,
    );
    if (r.exitCode !== 0) {
      throw new Error(`list sandbox files failed: ${commandOutput(r)}`);
    }
    return responseStdout(r)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const tab = line.lastIndexOf("\t");
        if (tab <= 0) return null;
        const path = safeRelativePath(line.slice(0, tab));
        if (!path) return null;
        const size = Number(line.slice(tab + 1));
        return { path, size: Number.isFinite(size) ? size : 0 };
      })
      .filter((file): file is { path: string; size: number } => !!file);
  }

  private async runSetup(
    sb: DaytonaSandboxInstance,
    command: string,
    label: string,
  ): Promise<void> {
    const r = await sb.process.executeCommand(command, undefined, undefined, 60);
    if (r.exitCode !== 0) {
      throw new Error(`Daytona ${label} failed (exit=${r.exitCode}): ${commandOutput(r)}`);
    }
  }

  /**
   * Map sandbox-relative paths to absolute container paths. Mirror
   * LocalSubprocessSandbox: /workspace/foo → /workspace/foo (Daytona's
   * default workdir is /workspace anyway), absolute paths pass through.
   */
  private normalise(p: string): string {
    if (p.startsWith("/")) return p;
    return `${this.workdir()}/${p}`;
  }

  private async ensureParentDir(sb: DaytonaSandboxInstance, filePath: string): Promise<void> {
    const slash = filePath.lastIndexOf("/");
    if (slash <= 0) return;
    const dir = filePath.slice(0, slash);
    try {
      await sb.fs.createFolder(dir, "0755");
    } catch {
      // Already exists or permission denied; let the upload's own error
      // surface if the dir really isn't writable.
    }
  }

  private buildEnv(command: string): Record<string, string> {
    const out: Record<string, string> = {
      ...this.envVars,
      OMA_SANDBOX_MAX_FILE_BYTES: String(this.maxFileBytes),
    };
    for (const { prefix, secrets } of this.commandSecrets) {
      if (command.startsWith(prefix)) Object.assign(out, secrets);
    }
    return out;
  }

  private fileSizeBlocks(): number {
    return Math.max(1, Math.floor(this.maxFileBytes / 512));
  }

  private withFileSizeLimit(command: string): string {
    return `ulimit -f ${this.fileSizeBlocks()}; ${command}`;
  }

  private async bootstrapSandbox(sb: DaytonaSandboxInstance): Promise<void> {
    const script = buildDaytonaBootstrapScript({
      workdir: this.workdir(),
      bootstrapTools: this.opts.bootstrapTools ?? true,
      aptPackages: this.opts.bootstrapAptPackages ?? DEFAULT_BOOTSTRAP_APT_PACKAGES,
    });
    const result = await sb.process.executeCommand(script, undefined, undefined, 300);
    if (result.exitCode !== 0) {
      throw new Error(
        `Daytona sandbox bootstrap failed (exit=${result.exitCode}): ` +
        `${result.artifacts?.stderr ?? result.artifacts?.stdout ?? result.result ?? ""}`,
      );
    }
  }

  private workdir(): string {
    const dir = this.opts.workdir?.trim() || DEFAULT_WORKDIR;
    return dir.startsWith("/") ? dir.replace(/\/+$/, "") || "/" : `/${dir.replace(/\/+$/, "")}`;
  }

  private validateCommandStoragePolicy(command: string): string | null {
    if (/(^|[^\w/])\/mnt\/_oma_storage(?:\/|$)/.test(command)) {
      return (
        "Direct sandbox access to /mnt/_oma_storage is blocked. Use " +
        "/mnt/session/outputs for small final artifacts, /mnt/memory for " +
        "configured memory stores, or the appropriate MCP/provider upload tool."
      );
    }
    if (/\b(fallocate|mkfile)\b/i.test(command)) {
      return "Large preallocation commands are blocked in Daytona sandboxes.";
    }
    if (/\btruncate\b[\s\S]*\s-s\s*[0-9]+[gGtT]/.test(command)) {
      return "Large truncate allocations are blocked in Daytona sandboxes.";
    }
    if (/\bdd\b[\s\S]*\bof=/i.test(command) && /\b(if=\/dev\/zero|if=\/dev\/random|if=\/dev\/urandom|count=)/i.test(command)) {
      return "Bulk dd writes are blocked in Daytona sandboxes.";
    }
    return null;
  }

  private assertAllowedWrite(target: string, bytes: number): void {
    if (target === "/mnt/_oma_storage" || target.startsWith("/mnt/_oma_storage/")) {
      throw new Error(
        "Direct writes to /mnt/_oma_storage are blocked. Use " +
        "/mnt/session/outputs, /mnt/memory, or a provider MCP upload flow.",
      );
    }
    if (bytes > this.maxFileBytes) {
      throw new Error(
        `Sandbox write rejected: ${bytes} bytes exceeds the Daytona per-file ` +
        `limit of ${this.maxFileBytes} bytes.`,
      );
    }
  }
}

/** Shell-escape an arbitrary string for safe inclusion in a `sh -c` command. */
function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function commandOutput(result: {
  artifacts?: { stdout?: string; stderr?: string };
  result?: string;
}): string {
  const parts = [
    result.artifacts?.stderr,
    result.artifacts?.stdout,
    result.result,
  ].filter((part): part is string => !!part && part.trim().length > 0);
  return parts.join("\n").trim();
}

function responseStdout(result: DaytonaExecuteResponse): string {
  return result.artifacts?.stdout ?? result.result ?? "";
}

async function bodyToBuffer(body: unknown): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body === "string") return Buffer.from(body);
  if (typeof (body as { transformToByteArray?: unknown }).transformToByteArray === "function") {
    const bytes = await (body as { transformToByteArray: () => Promise<Uint8Array> })
      .transformToByteArray();
    return Buffer.from(bytes);
  }
  if (typeof (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function") {
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  throw new Error("unsupported S3 body type");
}

function safeRelativePath(value: string): string | null {
  const parts = value
    .split("/")
    .filter((part) => part.length > 0);
  if (parts.length === 0) return null;
  if (parts.some((part) => part === "." || part === ".." || part.includes("\0"))) {
    return null;
  }
  return parts.join("/");
}

function remoteJoin(base: string, relativePath: string): string {
  return `${base.replace(/\/+$/, "")}/${relativePath.replace(/^\/+/, "")}`;
}

function remoteDirname(remotePath: string): string {
  const i = remotePath.lastIndexOf("/");
  return i <= 0 ? "/" : remotePath.slice(0, i);
}

function normalizeMaxFileBytes(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined || value <= 0) {
    return DEFAULT_MAX_FILE_BYTES;
  }
  return Math.floor(value);
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parseCsv(value: string | undefined): string[] | undefined {
  const parts = value
    ?.split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return parts && parts.length > 0 ? parts : undefined;
}

export function buildDaytonaBootstrapScript(opts: {
  workdir?: string;
  bootstrapTools: boolean;
  aptPackages: string[];
  /** Idempotency marker. Default `/tmp/.oma-daytona-tools-ready` (session
   *  scope); agent machines use a path under /var/lib/oma that survives
   *  stop/start and cannot be resurrected by a workspace restore. */
  markerPath?: string;
  /** Extra shell lines appended after the tool install, before `cd`. */
  extraLines?: string[];
}): string {
  const workdir = shellEscape(opts.workdir || DEFAULT_WORKDIR);
  const marker = opts.markerPath || DEFAULT_TOOLS_READY_MARKER;
  const packageList = opts.aptPackages
    .filter(Boolean)
    .map(shellEscape)
    .join(" ");
  const installTools = opts.bootstrapTools && packageList.length > 0
    ? [
        "if command -v apt-get >/dev/null 2>&1; then",
        "  export DEBIAN_FRONTEND=noninteractive",
        "  apt-get update -qq",
        `  apt-get install -y -qq --no-install-recommends ${packageList}`,
        "else",
        "  echo 'apt-get not found; cannot bootstrap Daytona coding tools' >&2",
        "  exit 127",
        "fi",
      ].join("\n")
    : "true";
  // The default marker is emitted verbatim (script text pinned by tests);
  // custom markers are quoted and get their parent dir created.
  const isDefaultMarker = marker === DEFAULT_TOOLS_READY_MARKER;
  const markerRef = isDefaultMarker ? marker : shellEscape(marker);
  const markerDir = marker.slice(0, marker.lastIndexOf("/")) || "/";
  return [
    "set -e",
    `mkdir -p ${workdir}`,
    ...(isDefaultMarker ? [] : [`mkdir -p ${shellEscape(markerDir)}`]),
    `if [ ! -f ${markerRef} ]; then`,
    installTools,
    `  touch ${markerRef}`,
    "fi",
    ...(opts.extraLines ?? []),
    `cd ${workdir}`,
  ].join("\n");
}

// ── Factory (DIP entry point) ───────────────────────────────────────

export const sandboxFactory: SandboxFactory = async (ctx, env) => {
  let box: SandboxBoxProvider | undefined;
  if (env.SANDBOX_SCOPE === "agent") {
    const binding = ctx.machines;
    const manager = binding?.manager as AgentMachineManager | undefined;
    if (!binding || !binding.spec || typeof manager?.provider !== "function") {
      throw new Error("agent sandbox scope requires an agent machine manager and machine specification");
    }
    box = manager.provider({ tenantId: binding.tenantId, agentId: binding.agentId, sessionId: ctx.sessionId, spec: binding.spec });
  }
  return new DaytonaSandbox({
    box,
    sessionId: ctx.sessionId,
    apiKey: env.DAYTONA_API_KEY,
    apiUrl: env.DAYTONA_API_URL,
    image: env.SANDBOX_IMAGE,
    workdir: ctx.machines?.spec?.workdir ?? env.DAYTONA_WORKDIR,
    memoryBucket: readS3MemoryBucket(env),
    maxFileBytes: parsePositiveInt(env.DAYTONA_MAX_FILE_BYTES),
    ephemeral: parseBoolean(env.DAYTONA_EPHEMERAL, true),
    bootstrapTools: parseBoolean(env.DAYTONA_BOOTSTRAP_TOOLS, true),
    bootstrapAptPackages: parseCsv(env.DAYTONA_BOOTSTRAP_APT_PACKAGES),
    // Production loads the real SDK lazily; only tests inject a module.
    daytonaModule: undefined,
  });
};
