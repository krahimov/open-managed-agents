// File resources vs. the session sandbox lifecycle (SessionRegistry).
//
// Resource mounting used to be tied to sandbox start. A user who attaches
// a file in chat does it AFTER the sandbox exists, then immediately sends
// the message that starts the next turn — so the file has to be written
// by the time `mountFileResource` resolves, at a path the caller can hand
// to the agent.

import { describe, expect, it } from "vitest";
import { generateEventId, generateFileId, fileR2Key } from "@open-managed-agents/shared";
import type { SessionEvent, UserMessageEvent } from "@open-managed-agents/shared";
import { SqlEventLog, ensureSchema as ensureEventLogSchema } from "@open-managed-agents/event-log/sql";
import type { SandboxExecutor } from "@open-managed-agents/sandbox";
import type { SandboxOrchestrator } from "@open-managed-agents/sandbox/orchestrator";
import { createSqliteAgentService } from "@open-managed-agents/agents-store";
import { createSqliteSessionService } from "@open-managed-agents/sessions-store";
import { createSqliteMemoryStoreService } from "@open-managed-agents/memory-store";
import { createSqliteFileService } from "@open-managed-agents/files-store";
import { InMemoryBlobStore } from "@open-managed-agents/blob-store";
import { SessionRegistry, sessionUploadsDir } from "../src/registry";
import { bootstrapTestDb } from "./_helpers/bootstrap-test-db";

const TENANT = "tn_file_resources";

/** In-memory sandbox that records every byte write, in order. */
function recordingSandbox(overrides: Partial<SandboxExecutor> = {}) {
  const files = new Map<string, string>();
  const writes: string[] = [];
  const sandbox: SandboxExecutor = {
    exec: async () => "",
    readFile: async (path) => files.get(path) ?? "",
    writeFile: async (path, content) => {
      files.set(path, content);
      writes.push(path);
      return path;
    },
    writeFileBytes: async (path, bytes) => {
      files.set(path, new TextDecoder().decode(bytes));
      writes.push(path);
      return path;
    },
    ...overrides,
  };
  return { sandbox, files, writes };
}

const noopOrchestrator: SandboxOrchestrator = {
  capabilities: () => ({
    enforceReadOnlyMemory: false,
    hasSessionOutputs: false,
    hasVaultOutbound: false,
    hasWorkspaceBackup: false,
  }),
  provision: async () => {},
  snapshotWorkspaceNow: async () => null,
  renewActivityTimeout: async () => {},
};

async function setup(opts: { sandbox: SandboxExecutor; setupSession?: boolean }) {
  const { sql, db, cleanup } = await bootstrapTestDb();
  await sql
    .prepare(`INSERT INTO "tenant" (id, name, "createdAt", "updatedAt") VALUES (?, ?, ?, ?)`)
    .bind(TENANT, "File Resources", Date.now(), Date.now())
    .run();
  const agents = createSqliteAgentService({ db });
  const sessions = createSqliteSessionService({ db });
  const memory = createSqliteMemoryStoreService({ db });
  const files = createSqliteFileService({ db });
  const blobs = new InMemoryBlobStore();
  await ensureEventLogSchema(sql);

  const agent = await agents.create({
    tenantId: TENANT,
    input: { name: "Files Agent", model: "claude-haiku-4-5-20251001" },
  });
  const { session } = await sessions.create({
    tenantId: TENANT,
    agentId: agent.id,
    environmentId: "env-local-runtime",
    title: "file resources",
    metadata: opts.setupSession ? { oma_setup: true } : {},
    vaultIds: [],
    agentSnapshot: agent,
    environmentSnapshot: { id: "env-local-runtime", runtime: "local", sandbox_template: null } as never,
  });

  /** What the harness could read at the moment each turn ran. */
  const seenByTurn: string[][] = [];
  let sandboxFiles: Map<string, string> | null = null;
  const registry = new SessionRegistry({
    sql,
    hub: { attach: () => () => {}, publish: () => {}, closeSession: () => {} },
    agentsService: agents,
    sessionsService: sessions,
    memoryService: memory,
    filesService: files,
    filesBlob: blobs,
    sandboxOrchestrator: noopOrchestrator,
    newEventLog: (sessionId) =>
      new SqlEventLog(sql, sessionId, (event: SessionEvent) => {
        (event as { id?: string }).id ??= generateEventId();
        (event as { processed_at?: string }).processed_at ??= new Date().toISOString();
      }),
    buildSandbox: async () => opts.sandbox,
    sandboxWorkdirRoot: "/tmp/oma-file-resources-test",
    buildModel: async () => ({}) as never,
    buildTools: async () => ({}),
    buildHarness: () => ({
      run: async () => {
        seenByTurn.push([...(sandboxFiles?.keys() ?? [])]);
      },
    }),
    buildHarnessContext: async (input) => input,
  });

  /** Upload a file and add it to the session as a file resource (what
   *  POST /v1/files + POST /v1/sessions/:id/resources do). */
  const addFile = async (filename: string, content: string, mountPath?: string) => {
    const id = generateFileId();
    const r2Key = fileR2Key(TENANT, id);
    await blobs.put(r2Key, new TextEncoder().encode(content), {
      httpMetadata: { contentType: "text/plain" },
    });
    await files.create({
      id,
      tenantId: TENANT,
      sessionId: session.id,
      filename,
      mediaType: "text/plain",
      sizeBytes: content.length,
      r2Key,
      downloadable: true,
    });
    await sessions.addResource({
      tenantId: TENANT,
      sessionId: session.id,
      resource: { type: "file", file_id: id, mount_path: mountPath } as never,
    });
    return id;
  };

  const runTurn = async (text: string) => {
    const entry = await registry.getOrCreate(session.id, TENANT);
    await entry.machine.runHarnessTurn(agent.id, {
      type: "user.message",
      content: [{ type: "text", text }],
    } as UserMessageEvent);
  };

  return {
    registry,
    session,
    addFile,
    runTurn,
    seenByTurn,
    trackFiles: (m: Map<string, string>) => { sandboxFiles = m; },
    cleanup,
  };
}

describe("SessionRegistry file resources", () => {
  it("mounts a file added mid-session before the next turn runs", async () => {
    const { sandbox, files, writes } = recordingSandbox();
    const t = await setup({ sandbox });
    t.trackFiles(files);
    try {
      // Turn 1 realizes the sandbox with no attachments.
      await t.runTurn("hello");
      expect(t.seenByTurn[0]).toEqual([]);

      // The user attaches a file to the now-running session…
      const fileId = await t.addFile("q3-sales.csv", "region,revenue\nemea,120\n");
      const path = await t.registry.mountFileResource(t.session.id, TENANT, { fileId });

      // …it is on disk as soon as the attach resolves, at the reported path…
      expect(path).toBe("/mnt/session/uploads/q3-sales.csv");
      expect(files.get(path!)).toBe("region,revenue\nemea,120\n");
      expect(writes).toEqual(["/mnt/session/uploads/q3-sales.csv"]);

      // …so the very next turn's harness can read it.
      await t.runTurn("summarise the attached file");
      expect(t.seenByTurn[1]).toContain("/mnt/session/uploads/q3-sales.csv");
    } finally {
      t.cleanup();
    }
  });

  it("writes only the new file on later attaches and on resource refresh", async () => {
    const { sandbox, files, writes } = recordingSandbox();
    const t = await setup({ sandbox });
    try {
      await t.runTurn("hello");
      const first = await t.addFile("first.txt", "original");
      await t.registry.mountFileResource(t.session.id, TENANT, { fileId: first });
      // The agent edits its copy in the sandbox.
      files.set("/mnt/session/uploads/first.txt", "edited by agent");

      const second = await t.addFile("second.txt", "second");
      await t.registry.mountFileResource(t.session.id, TENANT, { fileId: second });
      // A later resource refresh (e.g. a memory store attach) must not
      // put the original back either.
      await t.registry.refreshResources(t.session.id, TENANT);

      expect(writes).toEqual(["/mnt/session/uploads/first.txt", "/mnt/session/uploads/second.txt"]);
      expect(files.get("/mnt/session/uploads/first.txt")).toBe("edited by agent");
    } finally {
      t.cleanup();
    }
  });

  it("realizes a cold session, mounting every attached file exactly once", async () => {
    const { sandbox, files, writes } = recordingSandbox();
    const t = await setup({ sandbox });
    try {
      const earlier = await t.addFile("earlier.txt", "earlier");
      const fileId = await t.addFile("now.txt", "now");
      const path = await t.registry.mountFileResource(t.session.id, TENANT, { fileId });

      expect(path).toBe("/mnt/session/uploads/now.txt");
      expect(files.get("/mnt/session/uploads/earlier.txt")).toBe("earlier");
      expect(files.get("/mnt/session/uploads/now.txt")).toBe("now");
      expect([...writes].sort()).toEqual(["/mnt/session/uploads/earlier.txt", "/mnt/session/uploads/now.txt"]);
      void earlier;
    } finally {
      t.cleanup();
    }
  });

  it("keeps uploads per-session on an agent-scoped sandbox", async () => {
    const { sandbox, files } = recordingSandbox({
      sessionOutputsPath: () => "/mnt/sessions/sess_abc/outputs",
    });
    expect(sessionUploadsDir(sandbox)).toBe("/mnt/sessions/sess_abc/uploads");
    const t = await setup({ sandbox });
    try {
      const fileId = await t.addFile("brief.md", "# brief");
      const path = await t.registry.mountFileResource(t.session.id, TENANT, { fileId });
      expect(path).toBe("/mnt/sessions/sess_abc/uploads/brief.md");
      expect(files.get(path!)).toBe("# brief");
    } finally {
      t.cleanup();
    }
  });

  it("honours an explicit mount_path", async () => {
    const { sandbox, files } = recordingSandbox();
    const t = await setup({ sandbox });
    try {
      const fileId = await t.addFile("data.json", "{}", "/workspace/input/data.json");
      const path = await t.registry.mountFileResource(t.session.id, TENANT, {
        fileId,
        mountPath: "/workspace/input/data.json",
      });
      expect(path).toBe("/workspace/input/data.json");
      expect(files.get("/workspace/input/data.json")).toBe("{}");
    } finally {
      t.cleanup();
    }
  });

  it("never lets a stored filename steer the mount outside the uploads dir", async () => {
    const { sandbox, files } = recordingSandbox();
    const t = await setup({ sandbox });
    try {
      // Rows written before upload validation existed (or by another
      // writer) can still carry a path-like filename.
      const fileId = await t.addFile("../../../etc/cron.d/evil", "payload");
      const path = await t.registry.mountFileResource(t.session.id, TENANT, { fileId });
      expect(path).toBe("/mnt/session/uploads/evil");
      expect([...files.keys()]).toEqual(["/mnt/session/uploads/evil"]);
    } finally {
      t.cleanup();
    }
  });

  it("rejects when the sandbox write fails instead of reporting a path", async () => {
    const { sandbox } = recordingSandbox({
      writeFileBytes: async () => {
        throw new Error("Sandbox write rejected: disk full");
      },
    });
    const t = await setup({ sandbox });
    try {
      await t.runTurn("hello");
      const fileId = await t.addFile("big.bin", "x");
      await expect(
        t.registry.mountFileResource(t.session.id, TENANT, { fileId }),
      ).rejects.toThrow("disk full");
    } finally {
      t.cleanup();
    }
  });

  it("returns null for setup sessions, which never get a computer", async () => {
    const { sandbox, writes } = recordingSandbox();
    const t = await setup({ sandbox, setupSession: true });
    try {
      const fileId = await t.addFile("notes.txt", "notes");
      expect(await t.registry.mountFileResource(t.session.id, TENANT, { fileId })).toBeNull();
      expect(writes).toEqual([]);
    } finally {
      t.cleanup();
    }
  });
});
