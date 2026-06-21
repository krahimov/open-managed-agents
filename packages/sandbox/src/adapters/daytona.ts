// Daytona SaaS implementation of SandboxExecutor.
//
// Each session gets its own Daytona Sandbox (a managed Linux VM with
// FileSystem + Process APIs). Lazy-created on first use because sandbox
// boot is ~5–10s and the harness's first call is usually a real exec —
// we don't want to pay the latency before we know we need it.
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

import type { ProcessHandle, SandboxExecutor, SandboxFactory } from "../ports";
import { readS3MemoryBucket } from "../ports";
import { promises as fs } from "node:fs";
import { getLogger } from "@open-managed-agents/observability";
import { withSessionProxyContext } from "./outbound-proxy";

const moduleLogger = getLogger("daytona-sandbox");
const DEFAULT_MAX_FILE_BYTES = 512 * 1024 * 1024;
const DEFAULT_SANDBOX_IMAGE = "node:22-bookworm";
const DEFAULT_WORKDIR = "/workspace";
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
}

// Minimal structural types so this file compiles without `@daytonaio/sdk`
// installed. The actual driver is dynamic-imported inside ensureSandbox.
interface DaytonaExecuteResponse {
  exitCode: number;
  result: string;
  artifacts?: { stdout?: string; stderr?: string };
}
interface DaytonaProcess {
  executeCommand(
    command: string,
    cwd?: string,
    env?: Record<string, string>,
    timeout?: number,
  ): Promise<DaytonaExecuteResponse>;
}
interface DaytonaFileSystem {
  uploadFile(file: Buffer, remotePath: string, timeout?: number): Promise<void>;
  downloadFile(remotePath: string, timeout?: number): Promise<Buffer>;
  createFolder(path: string, mode: string): Promise<void>;
}
interface DaytonaSandboxInstance {
  id: string;
  process: DaytonaProcess;
  fs: DaytonaFileSystem;
}
interface DaytonaClient {
  create(params: {
    image?: string;
    labels?: Record<string, string>;
    envVars?: Record<string, string>;
    ephemeral?: boolean;
    autoDeleteInterval?: number;
  }): Promise<DaytonaSandboxInstance>;
  delete(sandbox: DaytonaSandboxInstance, timeout?: number): Promise<void>;
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
  private daytona: DaytonaClient | null = null;
  private logger: NonNullable<DaytonaSandboxOptions["logger"]>;
  private maxFileBytes: number;
  private s3RuntimePromise: Promise<S3Runtime> | null = null;
  private mountedMemoryStores = new Map<string, MountedMemoryStore>();
  private mountedOutputs: MountedOutputs | null = null;

  constructor(private opts: DaytonaSandboxOptions) {
    this.maxFileBytes = normalizeMaxFileBytes(opts.maxFileBytes);
    this.logger = opts.logger ?? {
      warn: (msg, ctx) => console.warn(`[daytona-sandbox] ${msg}`, ctx ?? ""),
      log: (msg) => console.log(`[daytona-sandbox] ${msg}`),
    };
  }

  async exec(command: string, timeout?: number): Promise<string> {
    const storagePolicyError = this.validateCommandStoragePolicy(command);
    if (storagePolicyError) return `[error: ${storagePolicyError}]`;
    const sb = await this.ensureSandbox();
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
      const stdout = r.artifacts?.stdout ?? "";
      const stderr = r.artifacts?.stderr ?? "";
      // Match @cloudflare/sandbox + LocalSubprocess: combined output, exit
      // suffix on non-zero. The harness's bash tool parser keys off this.
      const combined =
        (stdout + (stderr ? `\n${stderr}` : "")).replace(/\s+$/, "") +
        (r.exitCode !== 0 ? `\n[exit ${r.exitCode}]` : "");
      return combined;
    } catch (err) {
      return `[error: ${(err as Error).message}]`;
    } finally {
      await this.syncMountedResourcesToS3(sb).catch((err) => {
        this.logger.warn(`resource sync after exec failed: ${(err as Error).message}`);
      });
    }
  }

  async startProcess(command: string): Promise<ProcessHandle | null> {
    // Daytona has session-based async commands but mapping that onto our
    // ProcessHandle (with kill/getStatus/getLogs) needs a session-per-pid
    // bookkeeping pass we haven't done yet. Returning null means the
    // harness's startProcess callers fall back to exec() with a longer
    // timeout — correct behaviour, just no kill primitive.
    void command;
    return null;
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
    const sb = await this.ensureSandbox();
    const buf = await sb.fs.downloadFile(this.normalise(path));
    return buf.toString("utf8");
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    const sb = await this.ensureSandbox();
    const buf = await sb.fs.downloadFile(this.normalise(path));
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  async writeFile(path: string, content: string): Promise<string> {
    const target = this.normalise(path);
    this.assertAllowedWrite(target, Buffer.byteLength(content, "utf8"));
    const sb = await this.ensureSandbox();
    await this.ensureParentDir(sb, target);
    await sb.fs.uploadFile(Buffer.from(content, "utf8"), target);
    return target;
  }

  async writeFileBytes(path: string, bytes: Uint8Array): Promise<string> {
    const target = this.normalise(path);
    this.assertAllowedWrite(target, bytes.byteLength);
    const sb = await this.ensureSandbox();
    await this.ensureParentDir(sb, target);
    await sb.fs.uploadFile(Buffer.from(bytes), target);
    return target;
  }

  async destroy(): Promise<void> {
    if (!this.sandboxPromise) return;
    try {
      const sb = await this.sandboxPromise;
      await this.daytona?.delete(sb);
    } catch (err) {
      this.logger.warn(`destroy failed: ${(err as Error).message}`);
    } finally {
      this.sandboxPromise = null;
    }
  }

  async mountMemoryStore(opts: {
    storeName: string;
    storeId: string;
    readOnly: boolean;
  }): Promise<void> {
    this.memoryBucketConfig("mountMemoryStore");
    const sb = await this.ensureSandbox();
    const mountPoint = `/mnt/memory/${opts.storeName}`;
    await this.runSetup(
      sb,
      `mkdir -p /mnt/memory && rm -rf ${shellEscape(mountPoint)} && mkdir -p ${shellEscape(mountPoint)}`,
      "create memory mount",
    );
    const mount = { ...opts, mountPoint };
    this.mountedMemoryStores.set(opts.storeId, mount);
    await this.syncMemoryStoreFromS3(sb, mount);
    this.logger.log(`mounted memory store ${opts.storeName} at ${mountPoint} ${opts.readOnly ? "(ro)" : ""}`);
  }

  async mountSessionOutputs(opts: {
    tenantId: string;
    sessionId: string;
  }): Promise<void> {
    this.memoryBucketConfig("mountSessionOutputs");
    const sb = await this.ensureSandbox();
    const mountPoint = "/mnt/session/outputs";
    await this.runSetup(
      sb,
      `mkdir -p /mnt/session && rm -rf ${shellEscape(mountPoint)} && mkdir -p ${shellEscape(mountPoint)}`,
      "create outputs mount",
    );
    this.mountedOutputs = { ...opts, mountPoint };
    this.logger.log(`mounted session outputs at ${mountPoint}`);
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private pendingCaUpload: { hostPath: string } | null = null;

  private async ensureSandbox(): Promise<DaytonaSandboxInstance> {
    if (this.sandboxPromise) return this.sandboxPromise;
    this.sandboxPromise = (async () => {
      const apiKey = this.opts.apiKey ?? process.env.DAYTONA_API_KEY;
      if (!apiKey) {
        throw new Error(
          "DaytonaSandbox: apiKey not provided and DAYTONA_API_KEY env var not set",
        );
      }
      type DaytonaModule = {
        Daytona: new (config: { apiKey: string; apiUrl?: string }) => DaytonaClient;
      };
      const mod = (await import(
        /* @vite-ignore */ "@daytonaio/sdk" as string,
      ).catch((err) => {
        throw new Error(
          `DaytonaSandbox: failed to load '@daytonaio/sdk' — ` +
          `pnpm add @daytonaio/sdk (cause: ${String(err)})`,
        );
      })) as DaytonaModule;
      this.daytona = new mod.Daytona({
        apiKey,
        apiUrl: this.opts.apiUrl ?? process.env.DAYTONA_API_URL,
      });
      this.logger.log(`creating sandbox for session ${this.opts.sessionId}`);
      const sb = await this.daytona.create(buildDaytonaCreateParams(this.opts));
      this.logger.log(`sandbox ${sb.id} ready`);
      await this.bootstrapSandbox(sb);

      // Apply pending CA upload now that the box exists. Fire-and-forget
      // so a CA-less image doesn't block the harness on first exec; if
      // upload fails the per-exec env vars still point at the missing path
      // and outbound TLS will fail with cert errors — surfaced naturally.
      if (this.pendingCaUpload) {
        try {
          const buf = await fs.readFile(this.pendingCaUpload.hostPath);
          await sb.fs.createFolder("/etc/ssl", "0755").catch(() => { /* exists */ });
          await sb.fs.uploadFile(buf, "/etc/ssl/oma-vault-ca.crt");
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
    return this.sandboxPromise;
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

  private withFileSizeLimit(command: string): string {
    const blocks512 = Math.max(1, Math.floor(this.maxFileBytes / 512));
    return `ulimit -f ${blocks512}; ${command}`;
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

export function buildDaytonaCreateParams(opts: Pick<DaytonaSandboxOptions, "image" | "sessionId" | "ephemeral">): {
  image: string;
  labels: Record<string, string>;
  ephemeral?: boolean;
  autoDeleteInterval?: number;
} {
  return {
    image: opts.image ?? DEFAULT_SANDBOX_IMAGE,
    labels: { "oma-session-id": opts.sessionId },
    ...(opts.ephemeral ?? true
      ? { ephemeral: true }
      : { autoDeleteInterval: -1 }),
  };
}

export function buildDaytonaBootstrapScript(opts: {
  workdir?: string;
  bootstrapTools: boolean;
  aptPackages: string[];
}): string {
  const workdir = shellEscape(opts.workdir || DEFAULT_WORKDIR);
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
  return [
    "set -e",
    `mkdir -p ${workdir}`,
    "if [ ! -f /tmp/.oma-daytona-tools-ready ]; then",
    installTools,
    "  touch /tmp/.oma-daytona-tools-ready",
    "fi",
    `cd ${workdir}`,
  ].join("\n");
}

// ── Factory (DIP entry point) ───────────────────────────────────────

export const sandboxFactory: SandboxFactory = async (ctx, env) => {
  return new DaytonaSandbox({
    sessionId: ctx.sessionId,
    apiKey: env.DAYTONA_API_KEY,
    apiUrl: env.DAYTONA_API_URL,
    image: env.SANDBOX_IMAGE,
    workdir: env.DAYTONA_WORKDIR,
    memoryBucket: readS3MemoryBucket(env),
    maxFileBytes: parsePositiveInt(env.DAYTONA_MAX_FILE_BYTES),
    ephemeral: parseBoolean(env.DAYTONA_EPHEMERAL, true),
    bootstrapTools: parseBoolean(env.DAYTONA_BOOTSTRAP_TOOLS, true),
    bootstrapAptPackages: parseCsv(env.DAYTONA_BOOTSTRAP_APT_PACKAGES),
  });
};
