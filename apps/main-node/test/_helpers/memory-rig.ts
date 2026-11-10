// Real services over the consolidated SQLite schema + a temp local-fs blob
// dir — the same wiring main-node's index.ts does for agent memory, minus
// the HTTP server. Shared by the agent-memory tests.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSqliteAgentService,
  createSqliteAmbientRuleService,
} from "@open-managed-agents/agents-store";
import { createSqliteSessionService } from "@open-managed-agents/sessions-store";
import {
  createSqliteMemoryStoreService,
  r2Key,
  SqlMemoryRepo,
} from "@open-managed-agents/memory-store";
import { LocalFsBlobStore } from "@open-managed-agents/memory-store/adapters/local-fs-blob";
import { buildAttachAgentMemory, type AgentMemoryDeps } from "../../src/lib/agent-memory-mode";
import { MemoryPromptBuilder, createSessionMemoryContext } from "../../src/lib/memory-prompt";
import { bootstrapTestDb } from "./bootstrap-test-db";

export const TENANT = "tenant-agent-memory";

export async function buildMemoryRig() {
  const { sql, db, cleanup: cleanupDb } = await bootstrapTestDb();
  await sql
    .prepare('INSERT INTO "tenant" (id, name, "createdAt", "updatedAt") VALUES (?, ?, ?, ?)')
    .bind(TENANT, "Agent memory", Date.now(), Date.now())
    .run();
  const memoryRoot = mkdtempSync(join(tmpdir(), "oma-memory-blobs-"));
  const blobs = new LocalFsBlobStore({ baseDir: memoryRoot });
  const agents = createSqliteAgentService({ db });
  const ambientRules = createSqliteAmbientRuleService({ db });
  const sessions = createSqliteSessionService({ db });
  const memoryService = createSqliteMemoryStoreService({ db, blobs });
  const memoryRepo = new SqlMemoryRepo(db);

  const deps: AgentMemoryDeps = {
    memoryService,
    agents,
    attach: async ({ tenantId, sessionId, storeId, access }) => {
      const existing = await sessions.listResourcesBySession({ sessionId });
      if (
        existing.some(
          (r) =>
            r.type === "memory_store" &&
            (r.resource as { memory_store_id?: string }).memory_store_id === storeId,
        )
      ) {
        return;
      }
      await sessions.addResource({
        tenantId,
        sessionId,
        resource: { type: "memory_store", memory_store_id: storeId, access } as never,
      });
    },
  };
  const attachAgentMemory = buildAttachAgentMemory(deps);
  const prompt = new MemoryPromptBuilder({
    list: async (storeId) =>
      (await memoryRepo.list(storeId, {})).map((r) => ({
        path: r.path,
        sizeBytes: r.size_bytes,
        updatedAt: r.updated_at,
      })),
    read: async (storeId, path) => (await blobs.getText(r2Key(storeId, path)))?.text ?? null,
  });
  const sessionMemory = createSessionMemoryContext({
    sessions,
    memoryService,
    legacyBindings: async (sessionId) =>
      (
        await sql
          .prepare(`SELECT store_id, access FROM session_memory_stores WHERE session_id = ?`)
          .bind(sessionId)
          .all<{ store_id: string; access: string }>()
      ).results ?? [],
    prompt,
  });

  const createAgent = (name = "Competitor watch", extra: Record<string, unknown> = {}) =>
    agents.create({ tenantId: TENANT, input: { name, model: "test-model", ...extra } });

  /** A session created the way a non-REST creator does it: row first, then
   *  the attach hook. */
  const createSession = async (agentId: string, metadata?: Record<string, unknown>) => {
    const agent = (await agents.get({ tenantId: TENANT, agentId }))!;
    const { session } = await sessions.create({
      tenantId: TENANT,
      agentId,
      environmentId: "env_local_runtime",
      agentSnapshot: agent,
      environmentSnapshot: { id: "env_local_runtime", runtime: "local", sandbox_template: null } as never,
      metadata,
    });
    await attachAgentMemory({
      tenantId: TENANT,
      sessionId: session.id,
      agentId,
      agentSnapshot: agent,
      metadata,
    });
    return session;
  };

  const memoryStoreIdsOf = async (sessionId: string) =>
    (await sessions.listResourcesBySession({ sessionId }))
      .filter((r) => r.type === "memory_store")
      .map((r) => (r.resource as { memory_store_id: string }).memory_store_id);

  return {
    sql,
    db,
    agents,
    ambientRules,
    sessions,
    memoryService,
    memoryRepo,
    memoryRoot,
    blobs,
    deps,
    attachAgentMemory,
    sessionMemory,
    createAgent,
    createSession,
    memoryStoreIdsOf,
    cleanup: () => {
      cleanupDb();
      rmSync(memoryRoot, { recursive: true, force: true });
    },
  };
}

export type MemoryRig = Awaited<ReturnType<typeof buildMemoryRig>>;
