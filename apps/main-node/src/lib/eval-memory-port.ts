// Node adapter for the eval runner's EvalMemoryPort — memory-aware
// simulations. Bridges the runner (a leaf package that can't import the
// memory service) to memoryService + the session_memory_stores table the
// harness reads at turn time (buildNodeMemoryPromptContext).

import type { EvalMemoryPort } from "@open-managed-agents/evals-runner";
import type { SqlClient } from "@open-managed-agents/sql-client";

interface MemoryServiceLike {
  createStore(o: { tenantId: string; name: string; description?: string }): Promise<{ id: string }>;
  getStore(o: { tenantId: string; storeId: string }): Promise<{ id: string } | null>;
  writeByPath(o: {
    tenantId: string;
    storeId: string;
    path: string;
    content: string;
    actor: { type: string; id: string };
  }): Promise<unknown>;
  listMemories(o: { tenantId: string; storeId: string }): Promise<Array<{ path: string }>>;
  readByPath(o: { tenantId: string; storeId: string; path: string }): Promise<{ content: string } | null>;
}

export function buildNodeEvalMemoryPort(deps: {
  memoryService: MemoryServiceLike;
  sql: SqlClient;
}): EvalMemoryPort {
  return {
    async provisionStore({ tenantId, name, description }) {
      const row = await deps.memoryService.createStore({ tenantId, name, description });
      return { id: row.id };
    },
    async attachToSession({ tenantId, sessionId, storeId, access, instructions }) {
      const store = await deps.memoryService.getStore({ tenantId, storeId });
      if (!store) throw new Error(`memory store ${storeId} not found`);
      // Same upsert the POST /sessions/:id/memory_stores route performs.
      // `instructions` are carried on the environment binding today, not
      // this table — surface them via the store description fallback in
      // the reminder is out of scope; the runner passes them for forward
      // compat.
      void instructions;
      await deps.sql
        .prepare(
          `INSERT INTO session_memory_stores (session_id, store_id, access, created_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(session_id, store_id) DO UPDATE SET access = excluded.access`,
        )
        .bind(sessionId, storeId, access, Date.now())
        .run();
    },
    async writeFile({ tenantId, storeId, path, content }) {
      await deps.memoryService.writeByPath({
        tenantId,
        storeId,
        path,
        content,
        actor: { type: "system", id: "eval-runner" },
      });
    },
    async listFiles({ tenantId, storeId }) {
      const rows = await deps.memoryService.listMemories({ tenantId, storeId });
      const out: Array<{ path: string; content: string }> = [];
      for (const r of rows.slice(0, 50)) {
        const full = await deps.memoryService.readByPath({ tenantId, storeId, path: r.path });
        out.push({ path: r.path, content: full?.content ?? "" });
      }
      return out;
    },
  };
}
