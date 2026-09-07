// Unit tests for NodeWorkspaceBackupService — drives the snapshot/restore
// path against an in-memory blob store + sqlite. Verifies:
//
//   - snapshot tar's a workspace, uploads, inserts a row
//   - restore unpacks a snapshot back into a fresh sandbox
//   - latest() returns the most recent unexpired row, null otherwise
//   - agent-machine scope: snapshotMachine/latestForMachine/restoreMachine
//     key rows by source_session_id = "machine:<id>" (disjoint from the
//     session key space), exclude /workspace/.oma + caller excludes, and
//     round-trip through a second FakeSandbox
//
// Uses a fake SandboxExecutor that emulates exec/readFileBytes/writeFileBytes
// against a host tmp dir — no real subprocess, fast in CI.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import BetterSqlite3 from "better-sqlite3";
import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";
import type { SqlClient } from "@open-managed-agents/sql-client";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { fileURLToPath } from "node:url";
import { InMemoryBlobStore } from "@open-managed-agents/blob-store";
import type { SandboxExecutor } from "@open-managed-agents/sandbox";
import { NodeWorkspaceBackupService } from "../src/lib/node-workspace-backup.js";

class FakeSandbox implements SandboxExecutor {
  workdir: string;
  constructor() {
    this.workdir = join(tmpdir(), `oma-fake-${randomBytes(6).toString("hex")}`);
    mkdirSync(this.workdir, { recursive: true });
    mkdirSync(join(this.workdir, "workspace"), { recursive: true });
  }
  async exec(command: string, _timeout?: number): Promise<string> {
    // Run sh -c relative to <workdir>/workspace ... or /tmp emulated as
    // a workdir-relative subdir.
    const { spawnSync } = await import("node:child_process");
    // Map /tmp → workdir/.tmp + /workspace → workdir/workspace.
    const remapped = command
      .replace(/\/tmp\//g, `${this.workdir}/.tmp/`)
      .replace(/\/workspace\b/g, `${this.workdir}/workspace`);
    mkdirSync(join(this.workdir, ".tmp"), { recursive: true });
    const r = spawnSync("/bin/sh", ["-c", remapped]);
    const stdout = r.stdout?.toString() ?? "";
    const stderr = r.stderr?.toString() ?? "";
    const combined = stdout + (stderr ? `\n${stderr}` : "");
    return r.status === 0 ? combined.trim() : `${combined.trim()}\n[exit ${r.status}]`;
  }
  async readFile(path: string): Promise<string> {
    const buf = await fs.readFile(this.toHost(path));
    return buf.toString("utf8");
  }
  async readFileBytes(path: string): Promise<Uint8Array> {
    const buf = await fs.readFile(this.toHost(path));
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  async writeFile(path: string, content: string): Promise<string> {
    const host = this.toHost(path);
    await fs.mkdir(join(host, ".."), { recursive: true });
    await fs.writeFile(host, content);
    return path;
  }
  async writeFileBytes(path: string, bytes: Uint8Array): Promise<string> {
    const host = this.toHost(path);
    await fs.mkdir(join(host, ".."), { recursive: true });
    await fs.writeFile(host, bytes);
    return path;
  }
  async destroy(): Promise<void> {
    rmSync(this.workdir, { recursive: true, force: true });
  }
  private toHost(p: string): string {
    if (p.startsWith("/tmp/")) return join(this.workdir, ".tmp", p.slice("/tmp/".length));
    if (p.startsWith("/workspace/")) return join(this.workdir, "workspace", p.slice("/workspace/".length));
    if (p === "/workspace") return join(this.workdir, "workspace");
    return join(this.workdir, p);
  }
}

describe("NodeWorkspaceBackupService", () => {
  let dbPath: string;
  let sql: SqlClient;
  let blobs: InMemoryBlobStore;
  let svc: NodeWorkspaceBackupService;
  let sandbox: FakeSandbox;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `oma-wsb-${randomBytes(6).toString("hex")}.db`);
    const raw = new BetterSqlite3(dbPath);
    raw.exec("PRAGMA foreign_keys = OFF");
    const drz = drizzle(raw);
    const migrationsFolder = fileURLToPath(
      new URL("../migrations-sqlite", import.meta.url),
    );
    migrate(drz, { migrationsFolder });
    sql = await createBetterSqlite3SqlClient(dbPath);
    blobs = new InMemoryBlobStore();
    svc = new NodeWorkspaceBackupService({ sql, blobs });
    sandbox = new FakeSandbox();
  });

  afterEach(async () => {
    await sandbox.destroy().catch(() => {});
    try { rmSync(dbPath, { force: true }); } catch { /* ignore */ }
  });

  it("snapshot tars a workspace and inserts a row; restore unpacks it back", async () => {
    // Seed the workspace.
    await sandbox.writeFile("/workspace/hello.txt", "world");
    await sandbox.writeFile("/workspace/sub/deep.txt", "nested");

    const handle = await svc.snapshot({
      sessionId: "sess_1",
      tenantId: "tn_1",
      sandbox,
    });
    expect(handle).not.toBeNull();
    expect(handle!.id).toMatch(/^wsb_/);
    expect(handle!.dir).toContain("workspace-backups/tn_1/sess_1/");

    // Row landed in workspace_backups (post-0011 shape: handle JSON +
    // source_session_id, no blob_key).
    const r = await sql
      .prepare(
        `SELECT id, backup_handle, created_at FROM workspace_backups WHERE source_session_id = ?`,
      )
      .bind("sess_1")
      .first<{ id: number; backup_handle: string; created_at: number }>();
    expect(r).not.toBeNull();
    expect(r!.backup_handle).toContain("workspace-backups/tn_1/sess_1/");

    // latest() returns it.
    const latest = await svc.latest({ sessionId: "sess_1", tenantId: "tn_1" });
    expect(latest?.id).toBe(handle!.id);

    // Restore into a fresh sandbox.
    const fresh = new FakeSandbox();
    const restored = await svc.restore({
      sessionId: "sess_1",
      tenantId: "tn_1",
      sandbox: fresh,
      handle: handle!,
    });
    expect(restored.ok).toBe(true);
    expect(await fresh.readFile("/workspace/hello.txt")).toBe("world");
    expect(await fresh.readFile("/workspace/sub/deep.txt")).toBe("nested");
    await fresh.destroy();
  });

  it("latest() returns null when no backups exist", async () => {
    const r = await svc.latest({ sessionId: "sess_none", tenantId: "tn_1" });
    expect(r).toBeNull();
  });

  // ── agent-machine scope ───────────────────────────────────────────────

  /** List the member names of the tar blob behind `handle`, normalised to
   *  `<path>` (no leading `./`, no trailing `/`). */
  async function tarMembers(handle: { dir?: string }): Promise<string[]> {
    const obj = await blobs.get(handle.dir!);
    expect(obj).not.toBeNull();
    const tarPath = join(tmpdir(), `oma-wsb-list-${randomBytes(4).toString("hex")}.tar`);
    await fs.writeFile(tarPath, await obj!.bytes());
    try {
      const { spawnSync } = await import("node:child_process");
      const r = spawnSync("tar", ["-tf", tarPath]);
      expect(r.status).toBe(0);
      return r.stdout
        .toString()
        .split("\n")
        .map((l) => l.trim().replace(/^\.\//, "").replace(/\/$/, ""))
        .filter((l) => l.length > 0 && l !== ".");
    } finally {
      rmSync(tarPath, { force: true });
    }
  }

  it("snapshotMachine writes a row keyed source_session_id='machine:<id>'; latestForMachine finds it, latest() does not", async () => {
    await sandbox.writeFile("/workspace/hello.txt", "world");

    const handle = await svc.snapshotMachine({
      tenantId: "tn_1",
      machineId: "amch_1",
      sandbox,
    });
    expect(handle).not.toBeNull();
    expect(handle!.id).toMatch(/^wsb_/);
    expect(handle!.dir).toContain("workspace-backups/tn_1/machines/amch_1/");

    // Exactly one row, machine-keyed, environment_id = machineId.
    const rows = await sql
      .prepare(
        `SELECT tenant_id, environment_id, source_session_id, backup_handle, created_at, expires_at
         FROM workspace_backups`,
      )
      .bind()
      .all<{
        tenant_id: string;
        environment_id: string;
        source_session_id: string;
        backup_handle: string;
        created_at: number;
        expires_at: number;
      }>();
    expect(rows.results).toHaveLength(1);
    const row = rows.results![0]!;
    expect(row.tenant_id).toBe("tn_1");
    expect(row.source_session_id).toBe("machine:amch_1");
    expect(row.environment_id).toBe("amch_1");
    expect(JSON.parse(row.backup_handle)).toEqual({ id: handle!.id, dir: handle!.dir });
    expect(Number(row.expires_at)).toBeGreaterThan(Number(row.created_at));

    // Machine lookup finds it …
    const latestMachine = await svc.latestForMachine({ tenantId: "tn_1", machineId: "amch_1" });
    expect(latestMachine).toEqual({ id: handle!.id, dir: handle!.dir });
    // … a session lookup with the bare machine id does not …
    expect(await svc.latest({ sessionId: "amch_1", tenantId: "tn_1" })).toBeNull();
    // … and tenant scoping still applies.
    expect(await svc.latestForMachine({ tenantId: "tn_other", machineId: "amch_1" })).toBeNull();

    // The reverse holds too: a session snapshot never surfaces through a
    // machine lookup that happens to use the same id.
    const sess = await svc.snapshot({ sessionId: "sess_1", tenantId: "tn_1", sandbox });
    expect(sess).not.toBeNull();
    expect(await svc.latestForMachine({ tenantId: "tn_1", machineId: "sess_1" })).toBeNull();
    expect((await svc.latest({ sessionId: "sess_1", tenantId: "tn_1" }))?.id).toBe(sess!.id);
    // And the machine row is still the only machine row.
    expect((await svc.latestForMachine({ tenantId: "tn_1", machineId: "amch_1" }))?.id).toBe(
      handle!.id,
    );
  });

  it("restoreMachine restores files into a second FakeSandbox", async () => {
    await sandbox.writeFile("/workspace/hello.txt", "world");
    await sandbox.writeFile("/workspace/sub/deep.txt", "nested");

    const handle = await svc.snapshotMachine({
      tenantId: "tn_1",
      machineId: "amch_2",
      sandbox,
    });
    expect(handle).not.toBeNull();

    const fresh = new FakeSandbox();
    try {
      const restored = await svc.restoreMachine({
        tenantId: "tn_1",
        machineId: "amch_2",
        sandbox: fresh,
        handle: handle!,
      });
      expect(restored).toEqual({ ok: true });
      expect(await fresh.readFile("/workspace/hello.txt")).toBe("world");
      expect(await fresh.readFile("/workspace/sub/deep.txt")).toBe("nested");
    } finally {
      await fresh.destroy();
    }
  });

  it("restoreMachine reports a missing blob instead of throwing", async () => {
    const fresh = new FakeSandbox();
    try {
      const r = await svc.restoreMachine({
        tenantId: "tn_1",
        machineId: "amch_gone",
        sandbox: fresh,
        handle: { id: "wsb_gone", dir: "workspace-backups/tn_1/machines/amch_gone/wsb_gone.tar" },
      });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/missing/);
      expect(await svc.restoreMachine({
        tenantId: "tn_1",
        machineId: "amch_gone",
        sandbox: fresh,
        handle: { id: "wsb_nodir" },
      })).toEqual({ ok: false, error: "no blob_key on handle" });
    } finally {
      await fresh.destroy();
    }
  });

  it("machine snapshots exclude .oma, the default set, and caller excludes (other dot-dirs kept)", async () => {
    await sandbox.writeFile("/workspace/src/main.ts", "export {}");
    await sandbox.writeFile("/workspace/.hidden-keep/file", "kept");
    await sandbox.writeFile("/workspace/.oma/bootstrap.ok", "1");
    await sandbox.writeFile("/workspace/.oma/procs/p1.pid", "42");
    await sandbox.writeFile("/workspace/node_modules/dep/index.js", "x");
    await sandbox.writeFile("/workspace/.next/cache/page.js", "x");
    await sandbox.writeFile("/workspace/build/out.js", "x");
    await sandbox.writeFile("/workspace/dist/bundle.js", "x");

    const handle = await svc.snapshotMachine({
      tenantId: "tn_1",
      machineId: "amch_3",
      sandbox,
      // Deliberately un-normalised: leading "./" and trailing "/" on one,
      // a leading "/" on the other — both must resolve to /workspace-relative.
      excludes: ["./build/", "/dist"],
    });
    expect(handle).not.toBeNull();

    const members = await tarMembers(handle!);
    expect(members).toContain("src/main.ts");
    expect(members).toContain(".hidden-keep/file");
    expect(members.filter((m) => m === ".oma" || m.startsWith(".oma/"))).toEqual([]);
    expect(members.filter((m) => m === "node_modules" || m.startsWith("node_modules/"))).toEqual([]);
    expect(members.filter((m) => m === ".next" || m.startsWith(".next/"))).toEqual([]);
    expect(members.filter((m) => m === "build" || m.startsWith("build/"))).toEqual([]);
    expect(members.filter((m) => m === "dist" || m.startsWith("dist/"))).toEqual([]);

    // Restore confirms the same on disk.
    const fresh = new FakeSandbox();
    try {
      const r = await svc.restoreMachine({
        tenantId: "tn_1",
        machineId: "amch_3",
        sandbox: fresh,
        handle: handle!,
      });
      expect(r.ok).toBe(true);
      expect(await fresh.readFile("/workspace/src/main.ts")).toBe("export {}");
      expect(await fresh.readFile("/workspace/.hidden-keep/file")).toBe("kept");
      await expect(fresh.readFile("/workspace/.oma/bootstrap.ok")).rejects.toThrow();
      await expect(fresh.readFile("/workspace/build/out.js")).rejects.toThrow();
      await expect(fresh.readFile("/workspace/dist/bundle.js")).rejects.toThrow();
    } finally {
      await fresh.destroy();
    }
  });

  it("session snapshots keep the default exclude set", async () => {
    await sandbox.writeFile("/workspace/src/main.ts", "export {}");
    await sandbox.writeFile("/workspace/node_modules/dep/index.js", "x");
    await sandbox.writeFile("/workspace/__pycache__/m.pyc", "x");

    const handle = await svc.snapshot({ sessionId: "sess_ex", tenantId: "tn_1", sandbox });
    expect(handle).not.toBeNull();
    const members = await tarMembers(handle!);
    expect(members).toContain("src/main.ts");
    expect(members.filter((m) => m.startsWith("node_modules"))).toEqual([]);
    expect(members.filter((m) => m.startsWith("__pycache__"))).toEqual([]);
  });

  it("caller excludes with shell metacharacters are quoted, not interpreted", async () => {
    await sandbox.writeFile("/workspace/keep.txt", "k");
    await sandbox.writeFile("/workspace/it's odd/x.txt", "x");
    await sandbox.writeFile("/workspace/$(echo pwned)/y.txt", "y");

    const handle = await svc.snapshotMachine({
      tenantId: "tn_1",
      machineId: "amch_5",
      sandbox,
      // Quotes, a command substitution, whitespace-only, ".." and "/" —
      // the last three are dropped; the first two must match literally.
      excludes: ["it's odd", "$(echo pwned)", "   ", "..", "/", "./"],
    });
    expect(handle).not.toBeNull();
    const members = await tarMembers(handle!);
    expect(members).toContain("keep.txt");
    expect(members.filter((m) => m.startsWith("it's odd"))).toEqual([]);
    expect(members.filter((m) => m.startsWith("$(echo pwned)"))).toEqual([]);
  });

  it("latestForMachine returns the newest unexpired row and null once expired", async () => {
    let now = 1_000_000;
    const clocked = new NodeWorkspaceBackupService({
      sql,
      blobs,
      nowMs: () => now,
      ttlSec: 60,
    });
    await sandbox.writeFile("/workspace/a.txt", "1");

    const first = await clocked.snapshotMachine({ tenantId: "tn_1", machineId: "amch_4", sandbox });
    now += 10_000;
    const second = await clocked.snapshotMachine({ tenantId: "tn_1", machineId: "amch_4", sandbox });
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first!.id).not.toBe(second!.id);

    expect((await clocked.latestForMachine({ tenantId: "tn_1", machineId: "amch_4" }))?.id).toBe(
      second!.id,
    );

    // Advance past the TTL of both rows (created at t0 and t0+10s, ttl 60s).
    now += 61_000;
    expect(await clocked.latestForMachine({ tenantId: "tn_1", machineId: "amch_4" })).toBeNull();
  });

  it("restoreMachine refuses a handle that belongs to another tenant or machine", async () => {
    await sandbox.writeFile("/workspace/secret.txt", "tenant-A-data");
    const handle = await svc.snapshotMachine({ tenantId: "tn_A", machineId: "amch_A", sandbox });
    expect(handle).not.toBeNull();

    const fresh = new FakeSandbox();
    try {
      // Same machine id, different tenant → refused, nothing written.
      const crossTenant = await svc.restoreMachine({
        tenantId: "tn_B",
        machineId: "amch_A",
        sandbox: fresh,
        handle: handle!,
      });
      expect(crossTenant.ok).toBe(false);
      expect(crossTenant.error).toMatch(/does not belong/);
      await expect(fresh.readFile("/workspace/secret.txt")).rejects.toThrow();

      // Same tenant, different machine → refused, nothing written.
      const crossMachine = await svc.restoreMachine({
        tenantId: "tn_A",
        machineId: "amch_other",
        sandbox: fresh,
        handle: handle!,
      });
      expect(crossMachine.ok).toBe(false);
      await expect(fresh.readFile("/workspace/secret.txt")).rejects.toThrow();

      // A session-scope handle is never accepted by restoreMachine either.
      const sess = await svc.snapshot({ sessionId: "sess_A", tenantId: "tn_A", sandbox });
      expect(sess).not.toBeNull();
      expect(
        (await svc.restoreMachine({ tenantId: "tn_A", machineId: "sess_A", sandbox: fresh, handle: sess! })).ok,
      ).toBe(false);

      // The matching (tenant, machine) pair still restores.
      const ok = await svc.restoreMachine({
        tenantId: "tn_A",
        machineId: "amch_A",
        sandbox: fresh,
        handle: handle!,
      });
      expect(ok).toEqual({ ok: true });
      expect(await fresh.readFile("/workspace/secret.txt")).toBe("tenant-A-data");
    } finally {
      await fresh.destroy();
    }
  });

  it("size cap ignores excluded top-level dirs but still trips on included data", async () => {
    const capped = new NodeWorkspaceBackupService({ sql, blobs, maxBytes: 1024 * 1024 });
    await sandbox.writeFile("/workspace/src/main.ts", "export {}");
    // 3 MiB inside node_modules (default exclude): tar skips it, so it
    // must not count against the 1 MiB cap — for either scope.
    await sandbox.writeFileBytes("/workspace/node_modules/big.bin", new Uint8Array(3 * 1024 * 1024));
    expect(await capped.snapshot({ sessionId: "sess_cap", tenantId: "tn_1", sandbox })).not.toBeNull();

    // Machine-only exclude (.oma) and a caller exclude (build): same rule.
    await sandbox.writeFileBytes("/workspace/.oma/big.bin", new Uint8Array(3 * 1024 * 1024));
    await sandbox.writeFileBytes("/workspace/build/big.bin", new Uint8Array(3 * 1024 * 1024));
    // Session scope excludes neither, so it now (correctly) trips the cap …
    expect(await capped.snapshot({ sessionId: "sess_cap", tenantId: "tn_1", sandbox })).toBeNull();
    // … while the machine snapshot still goes through.
    const handle = await capped.snapshotMachine({
      tenantId: "tn_1",
      machineId: "amch_cap",
      sandbox,
      excludes: ["build"],
    });
    expect(handle).not.toBeNull();
    const members = await tarMembers(handle!);
    expect(members).toContain("src/main.ts");
    expect(members.filter((m) => m.startsWith("node_modules") || m.startsWith(".oma") || m.startsWith("build"))).toEqual([]);

    // But data that WILL be tarred still trips the cap.
    await sandbox.writeFileBytes("/workspace/assets/big.bin", new Uint8Array(3 * 1024 * 1024));
    expect(
      await capped.snapshotMachine({ tenantId: "tn_1", machineId: "amch_cap", sandbox, excludes: ["build"] }),
    ).toBeNull();
    // Excluding the offending dir brings it back under the cap.
    expect(
      await capped.snapshotMachine({ tenantId: "tn_1", machineId: "amch_cap", sandbox, excludes: ["build", "assets"] }),
    ).not.toBeNull();
  });
});
