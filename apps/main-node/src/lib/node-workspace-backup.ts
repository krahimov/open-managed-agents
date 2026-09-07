// NodeWorkspaceBackupService — tar+upload workspace snapshots to a
// BlobStore on demand, restore on cold start. Backs the
// SandboxOrchestrator's snapshot/restore for providers that don't ship
// native CF-style createBackup (everything except CloudflareSandbox).
//
// Strategy:
//   - Snapshot: spawn `tar -C <workdir> -cf - .` under the sandbox's
//     readFileBytes path; pipe to a tar.zst-compressed buffer; upload to
//     BlobStore key `workspace-backups/<tenant>/<sessionId>/<ts>.tar.zst`.
//     For LocalSubprocess this means tar-ing the workdir directly on
//     the host — bypasses the SandboxExecutor port for speed/efficiency.
//     For LiteBox / Daytona / E2B / BoxRun, drive tar through the
//     sandbox's exec primitive and round-trip via readFileBytes.
//   - Restore: download the tar from BlobStore, write to a temp file,
//     drive tar -xf inside the sandbox via exec.
//
// Persistence: every snapshot inserts a `workspace_backups` row keyed by
// session_id; restore picks the most recent unexpired row.
//
// Two key spaces share the table, both living in `source_session_id`:
//   - session scope: `source_session_id = <sessionId>`, `environment_id =
//     <sessionId>` (today's behaviour, unchanged);
//   - agent-machine scope: `source_session_id = "machine:" + machineId`,
//     `environment_id = machineId`. Session ids are `sess-…` so the two
//     prefixes cannot collide. Machine snapshots additionally exclude
//     `/workspace/.oma` (per-box bookkeeping that must never be
//     resurrected on a fresh box) plus any caller-supplied excludes.
//
// Best-effort throughout: any provider where tar+exec fails returns
// ok=false and the orchestrator proceeds with an empty workspace.

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type { BlobStore } from "@open-managed-agents/blob-store";
import type {
  OrchestratorBackupHandle,
  WorkspaceBackupService,
} from "@open-managed-agents/sandbox/orchestrator";
import type { SandboxExecutor } from "@open-managed-agents/sandbox";
import { getLogger } from "@open-managed-agents/observability";

const moduleLogger = getLogger("node-workspace-backup");
const DEFAULT_MAX_WORKSPACE_BACKUP_BYTES = 256 * 1024 * 1024;

export interface NodeWorkspaceBackupServiceDeps {
  sql: SqlClient;
  blobs: BlobStore;
  /** TTL on snapshots — rows older than this are GC-eligible (cron not
   *  yet wired; kept as metadata for the GC pass to use). */
  ttlSec?: number;
  /** Optional logger. */
  logger?: { warn(msg: string, ctx?: unknown): void; log(msg: string): void };
  /** Maximum /workspace size to snapshot. Prevents remote sandboxes from
   *  creating huge temporary tar files before upload. Defaults to 256 MiB. */
  maxBytes?: number;
  /** Optional clock for tests. */
  nowMs?: () => number;
}

const DEFAULT_TTL_SEC = 7 * 24 * 3600;

/** tar `--exclude` entries (relative to /workspace) applied to EVERY
 *  snapshot. Order is preserved in the generated command. */
const DEFAULT_TAR_EXCLUDES: readonly string[] = [
  "node_modules",
  ".cache",
  "__pycache__",
  ".next",
];

/** Extra excludes for machine snapshots only. */
const MACHINE_TAR_EXCLUDES: readonly string[] = [".oma"];

/** `source_session_id` prefix for machine-keyed rows. */
export const MACHINE_BACKUP_SCOPE_PREFIX = "machine:";

/** The `source_session_id` value used for an agent machine's rows. */
export function machineBackupScopeKey(machineId: string): string {
  return `${MACHINE_BACKUP_SCOPE_PREFIX}${machineId}`;
}

/** Internal: everything a snapshot needs beyond the sandbox. */
interface SnapshotScope {
  tenantId: string;
  /** Value stored in `source_session_id`; also the `latest*` lookup key. */
  scopeKey: string;
  /** Value stored in `environment_id` (NOT NULL column). */
  environmentId: string;
  /** Path segment(s) under `workspace-backups/<tenant>/` for the blob. */
  blobScope: string;
  /** Extra blob customMetadata (tenant_id is always added). */
  metadata: Record<string, string>;
  /** Fully-resolved tar excludes, relative to /workspace. */
  excludes: readonly string[];
  /** Short label for the log line. */
  label: string;
}

export class NodeWorkspaceBackupService implements WorkspaceBackupService {
  private readonly ttlSec: number;
  private readonly logger: NonNullable<NodeWorkspaceBackupServiceDeps["logger"]>;
  private readonly nowMs: () => number;
  private readonly maxBytes: number;

  constructor(private deps: NodeWorkspaceBackupServiceDeps) {
    this.ttlSec = deps.ttlSec ?? DEFAULT_TTL_SEC;
    this.maxBytes = normalizeMaxBytes(deps.maxBytes);
    this.logger = deps.logger ?? {
      warn: (msg, ctx) => moduleLogger.warn({ ...(ctx as Record<string, unknown> ?? {}) }, msg),
      log: (msg) => moduleLogger.info(msg),
    };
    this.nowMs = deps.nowMs ?? (() => Date.now());
  }

  async snapshot(input: {
    sessionId: string;
    tenantId: string;
    sandbox: SandboxExecutor;
  }): Promise<OrchestratorBackupHandle | null> {
    return this.snapshotScope(input.sandbox, {
      tenantId: input.tenantId,
      scopeKey: input.sessionId,
      // environment_id: Node sessions today are single-env; the backup
      // is logically scoped by session, so use the session id as a
      // synthetic env id when the caller doesn't supply one.
      environmentId: input.sessionId,
      blobScope: input.sessionId,
      metadata: { session_id: input.sessionId },
      excludes: DEFAULT_TAR_EXCLUDES,
      label: `session=${input.sessionId.slice(0, 12)}`,
    });
  }

  async restore(input: {
    sessionId: string;
    tenantId: string;
    sandbox: SandboxExecutor;
    handle: OrchestratorBackupHandle;
  }): Promise<{ ok: boolean; error?: string }> {
    return this.restoreFromHandle(input.sandbox, input.handle);
  }

  async latest(input: {
    sessionId: string;
    tenantId: string;
  }): Promise<OrchestratorBackupHandle | null> {
    return this.latestForScope({ tenantId: input.tenantId, scopeKey: input.sessionId });
  }

  // ── agent-machine scope ──────────────────────────────────────────────
  //
  // Same table, same blob store, different key: rows carry
  // `source_session_id = "machine:<machineId>"` and `environment_id =
  // <machineId>` so a recreated box (new Daytona sandbox, same machine
  // row) can find and restore the last /workspace of its predecessor.

  /** Snapshot an agent machine's /workspace. `excludes` are
   *  /workspace-relative paths (or tar patterns) added on top of the
   *  defaults and `.oma`. Best-effort: null when the workspace exceeds the
   *  cap or tar/read fails. */
  async snapshotMachine(input: {
    tenantId: string;
    machineId: string;
    sandbox: SandboxExecutor;
    excludes?: string[];
  }): Promise<OrchestratorBackupHandle | null> {
    return this.snapshotScope(input.sandbox, {
      tenantId: input.tenantId,
      scopeKey: machineBackupScopeKey(input.machineId),
      environmentId: input.machineId,
      blobScope: `machines/${input.machineId}`, // keep in sync with machineBlobPrefix()
      metadata: { machine_id: input.machineId },
      excludes: resolveTarExcludes([...MACHINE_TAR_EXCLUDES, ...(input.excludes ?? [])]),
      label: `machine=${input.machineId.slice(0, 20)}`,
    });
  }

  /** Most recent unexpired machine-keyed row, or null. Never returns
   *  session-keyed rows (and `latest()` never returns machine rows). */
  async latestForMachine(input: {
    tenantId: string;
    machineId: string;
  }): Promise<OrchestratorBackupHandle | null> {
    return this.latestForScope({
      tenantId: input.tenantId,
      scopeKey: machineBackupScopeKey(input.machineId),
    });
  }

  /** Restore a machine backup into a (fresh) box's /workspace. The
   *  handle must have been produced by `snapshotMachine` for the SAME
   *  tenant + machine (its blob key carries both); anything else is
   *  refused with ok=false so a caller bug can never pour another
   *  tenant's (or another machine's) workspace into this box. */
  async restoreMachine(input: {
    tenantId: string;
    machineId: string;
    sandbox: SandboxExecutor;
    handle: OrchestratorBackupHandle;
  }): Promise<{ ok: boolean; error?: string }> {
    const blobKey = input.handle.dir ?? "";
    if (!blobKey) return { ok: false, error: "no blob_key on handle" };
    const expectedPrefix = machineBlobPrefix(input.tenantId, input.machineId);
    if (!blobKey.startsWith(expectedPrefix)) {
      this.logger.warn(
        `restoreMachine refused: handle ${blobKey.slice(0, 120)} does not belong to machine=${input.machineId} tenant=${input.tenantId}`,
      );
      return { ok: false, error: "handle does not belong to this machine" };
    }
    return this.restoreFromHandle(input.sandbox, input.handle);
  }

  // ── scope-parameterised bodies ───────────────────────────────────────

  private async snapshotScope(
    sandbox: SandboxExecutor,
    scope: SnapshotScope,
  ): Promise<OrchestratorBackupHandle | null> {
    const tarBytes = await this.tarWorkspace(sandbox, scope.excludes);
    if (!tarBytes) return null;
    const id = `wsb_${randomBytes(8).toString("hex")}`;
    const blobKey = `workspace-backups/${scope.tenantId}/${scope.blobScope}/${id}.tar`;
    await this.deps.blobs.put(blobKey, tarBytes, {
      httpMetadata: { contentType: "application/x-tar" },
      customMetadata: {
        tenant_id: scope.tenantId,
        ...scope.metadata,
      },
    });
    const now = this.nowMs();
    // Schema after apps/main/migrations/0011_workspace_backups.sql:
    //   id              BIGSERIAL PRIMARY KEY  (auto)
    //   tenant_id       TEXT
    //   environment_id  TEXT NOT NULL  ← required
    //   backup_handle   TEXT NOT NULL  ← was blob_key in pre-0011 applySchema
    //   created_at, expires_at  BIGINT
    //   source_session_id  TEXT  ← was session_id in pre-0011
    // The pre-0011 columns (id=TEXT, session_id, blob_key, size_bytes) are
    // gone; we serialize the handle JSON into backup_handle so the existing
    // BackupHandle shape (id+dir) round-trips through one column.
    const handleJson = JSON.stringify({ id, dir: blobKey });
    await this.deps.sql
      .prepare(
        `INSERT INTO workspace_backups (tenant_id, environment_id, backup_handle, created_at, expires_at, source_session_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        scope.tenantId,
        scope.environmentId,
        handleJson,
        now,
        now + this.ttlSec * 1000,
        scope.scopeKey,
      )
      .run();
    this.logger.log(`snapshot ${scope.label} bytes=${tarBytes.byteLength}`);
    return { id, dir: blobKey };
  }

  private async restoreFromHandle(
    sandbox: SandboxExecutor,
    handle: OrchestratorBackupHandle,
  ): Promise<{ ok: boolean; error?: string }> {
    const blobKey = handle.dir ?? "";
    if (!blobKey) return { ok: false, error: "no blob_key on handle" };
    const obj = await this.deps.blobs.get(blobKey);
    if (!obj) return { ok: false, error: "backup blob missing" };
    const bytes = await obj.bytes();
    return this.untarIntoSandbox(sandbox, bytes);
  }

  private async latestForScope(input: {
    tenantId: string;
    scopeKey: string;
  }): Promise<OrchestratorBackupHandle | null> {
    const now = this.nowMs();
    const row = await this.deps.sql
      .prepare(
        `SELECT id, backup_handle FROM workspace_backups
         WHERE source_session_id = ? AND tenant_id = ? AND expires_at > ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(input.scopeKey, input.tenantId, now)
      .first<{ id: string | number; backup_handle: string }>();
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.backup_handle) as OrchestratorBackupHandle;
      return parsed;
    } catch {
      return null;
    }
  }

  // ── helpers ──────────────────────────────────────────────────────────

  /** tar the sandbox's /workspace into bytes. Best-effort: returns null on
   *  any failure (caller treats as "no backup", proceeds). */
  private async tarWorkspace(
    sandbox: SandboxExecutor,
    excludes: readonly string[],
  ): Promise<Uint8Array | null> {
    const workspaceBytes = await this.estimateWorkspaceBytes(sandbox, excludes);
    if (workspaceBytes !== null && workspaceBytes > this.maxBytes) {
      this.logger.warn(
        `tarWorkspace skipped: workspace size ${workspaceBytes} exceeds cap ${this.maxBytes}`,
      );
      return null;
    }
    const tmpInside = `/tmp/oma-ws-${randomBytes(6).toString("hex")}.tar`;
    // Member names produced by `tar … .` are `./<path>`, so every exclude
    // is anchored with `./` and single-quoted for the shell.
    const excludeFlags = excludes
      .map((e) => `--exclude=${shellQuote(`./${e}`)}`)
      .join(" ");
    const out = await sandbox.exec(
      `cd /workspace 2>/dev/null && tar -cf '${tmpInside}' ${excludeFlags} . 2>&1 || echo '[exit 1]'`,
      120_000,
    );
    if (out.includes("[exit ")) {
      this.logger.warn(`tarWorkspace tar failed: ${out.slice(0, 200)}`);
      return null;
    }
    if (!sandbox.readFileBytes) {
      this.logger.warn("tarWorkspace: sandbox missing readFileBytes; skipping");
      return null;
    }
    try {
      return await sandbox.readFileBytes(tmpInside);
    } catch (err) {
      this.logger.warn(`tarWorkspace read failed: ${(err as Error).message}`);
      return null;
    } finally {
      // Best-effort cleanup of the tar inside the sandbox.
      void sandbox.exec(`rm -f '${tmpInside}'`, 5_000).catch(() => undefined);
    }
  }

  /** Approximate size of what the tar will contain: sums `du -sk` over the
   *  top-level entries of /workspace that are NOT excluded, so a large
   *  `node_modules`/`.cache` (which tar skips anyway) cannot trip the cap
   *  and silently drop the backup of a small source tree. Excludes that
   *  contain a `/` (nested paths) cannot be expressed as a top-level
   *  `-name` filter and are simply still counted — the estimate is an
   *  upper bound on the tar payload, never an under-estimate. Uses only
   *  POSIX `find -mindepth/-maxdepth/-name/-exec … +`, `du -sk` and `awk`
   *  so it works on GNU, BSD and busybox userlands. Returns null when the
   *  probe produced nothing usable (caller then skips the cap check, as
   *  before). */
  private async estimateWorkspaceBytes(
    sandbox: SandboxExecutor,
    excludes: readonly string[],
  ): Promise<number | null> {
    try {
      const nameFilters = excludes
        .filter((e) => !e.includes("/"))
        .map((e) => `! -name ${shellQuote(e)}`)
        .join(" ");
      const raw = await sandbox.exec(
        `cd /workspace 2>/dev/null && find . -mindepth 1 -maxdepth 1 ${nameFilters} -exec du -sk {} + 2>/dev/null | awk '{ s += $1 } END { if (NR) print s }'`,
        10_000,
      );
      const match = raw.match(/^\s*(\d+)/);
      if (!match) return null;
      return Number(match[1]) * 1024;
    } catch (err) {
      this.logger.warn(`tarWorkspace size probe failed: ${(err as Error).message}`);
      return null;
    }
  }

  private async untarIntoSandbox(
    sandbox: SandboxExecutor,
    tarBytes: Uint8Array,
  ): Promise<{ ok: boolean; error?: string }> {
    if (!sandbox.writeFileBytes) {
      return { ok: false, error: "sandbox missing writeFileBytes" };
    }
    const tmpHost = join(tmpdir(), `oma-ws-restore-${randomBytes(6).toString("hex")}.tar`);
    await fs.writeFile(tmpHost, tarBytes);
    const tmpInside = `/tmp/oma-ws-restore-${randomBytes(6).toString("hex")}.tar`;
    try {
      await sandbox.writeFileBytes(tmpInside, tarBytes);
      const out = await sandbox.exec(
        `mkdir -p /workspace && tar -xf '${tmpInside}' -C /workspace 2>&1 || echo '[exit 1]'`,
        120_000,
      );
      if (out.includes("[exit ")) {
        return { ok: false, error: `untar failed: ${out.slice(0, 200)}` };
      }
      return { ok: true };
    } finally {
      await fs.rm(tmpHost, { force: true }).catch(() => undefined);
      void sandbox.exec(`rm -f '${tmpInside}'`, 5_000).catch(() => undefined);
    }
  }
}

/** Merge caller excludes onto the defaults: trim, strip any leading `./`
 *  or `/` and trailing `/`, drop empties / `.` / `..` / entries with
 *  control characters, de-duplicate while preserving order. */
function resolveTarExcludes(extra: readonly string[]): string[] {
  const out: string[] = [...DEFAULT_TAR_EXCLUDES];
  const seen = new Set(out);
  for (const raw of extra) {
    if (typeof raw !== "string") continue;
    const cleaned = raw
      .trim()
      .replace(/^(?:\.\/|\/)+/, "")
      .replace(/\/+$/, "");
    if (!cleaned || cleaned === "." || cleaned === "..") continue;
    if (/[\0\r\n]/.test(cleaned)) continue;
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
}

/** Blob-key prefix every `snapshotMachine` blob for (tenant, machine)
 *  lives under; `restoreMachine` refuses handles outside it. */
function machineBlobPrefix(tenantId: string, machineId: string): string {
  return `workspace-backups/${tenantId}/machines/${machineId}/`;
}

/** POSIX single-quote a string for `sh -c`. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function normalizeMaxBytes(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined || value <= 0) {
    return DEFAULT_MAX_WORKSPACE_BACKUP_BYTES;
  }
  return Math.floor(value);
}
