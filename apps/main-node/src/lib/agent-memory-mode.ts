// Agent-level memory mode (docs/memory-facts-design.md §6) — the Node
// implementation of the sessions `attachAgentMemory` lifecycle hook.
//
//   off      → no-op (agent's own store never provisioned or attached)
//   shared   → one store per agent: `agent.memory.store_id` if set, else
//              auto-provisioned on first use as `agent-<id>-memory` and
//              pinned back onto the agent config so every later session
//              reuses it (idempotent: a concurrent first-session race
//              re-resolves by name before creating).
//   per_user → one store per (agent, principal): `agent-<id>-user-<hash>`
//              provisioned lazily; without a principal we fall back to the
//              shared store name so anonymous callers still get memory but
//              never see another user's.
//
// Attachment = the same session_memory_stores upsert the REST route does.
// Explicit environment / per-session attachments compose with this — the
// mode only governs the agent's OWN store.

import { createHash } from "node:crypto";
import type { AgentConfig } from "@open-managed-agents/shared";

export interface AgentMemoryModeDeps {
  memoryService: {
    createStore(o: { tenantId: string; name: string; description?: string }): Promise<{ id: string }>;
    getStore(o: { tenantId: string; storeId: string }): Promise<{ id: string; name: string } | null>;
    listStores(o: { tenantId: string; status?: "active" | "archived" | "any" }): Promise<Array<{ id: string; name: string }>>;
  };
  attach(input: { sessionId: string; storeId: string; access: "read_only" | "read_write" }): Promise<void>;
  /** Pin an auto-provisioned shared store id back onto the agent so it's
   *  stable across sessions and visible in the console. Best-effort. */
  pinAgentStore?(input: { tenantId: string; agentId: string; storeId: string }): Promise<void>;
  log?: (msg: string, ctx?: Record<string, unknown>) => void;
}

export function agentMemoryMode(agent: Pick<AgentConfig, "memory">): "off" | "shared" | "per_user" {
  const m = agent.memory?.mode;
  return m === "shared" || m === "per_user" ? m : "off";
}

export function sharedStoreName(agentId: string): string {
  return `agent-${agentId}-memory`;
}

export function perUserStoreName(agentId: string, principalId: string): string {
  const h = createHash("sha256").update(principalId).digest("hex").slice(0, 12);
  return `agent-${agentId}-user-${h}`;
}

/** per_user callers with NO principal (API key without user_id, no
 *  end-user id on the wire) get an explicit anonymous bucket — never the
 *  shared-mode store, which would silently merge every anonymous caller's
 *  memory with the operator's. */
export function anonymousStoreName(agentId: string): string {
  return `agent-${agentId}-user-anonymous`;
}

/** The store name an agent's OWN memory lives in for a given principal.
 *  Used by the runtime to recognise the primary store among all attached
 *  stores (env bindings may attach others). */
export function ownStoreName(agentId: string, mode: "shared" | "per_user", principalId?: string): string {
  if (mode === "per_user") return principalId ? perUserStoreName(agentId, principalId) : anonymousStoreName(agentId);
  return sharedStoreName(agentId);
}

/**
 * Resolve (provisioning if needed) the store an agent should attach for
 * this session. Returns null when the mode is off.
 */
export async function resolveAgentMemoryStore(
  deps: AgentMemoryModeDeps,
  input: { tenantId: string; agentId: string; agent: AgentConfig; principalId?: string },
): Promise<{ storeId: string; mode: "shared" | "per_user"; provisioned: boolean } | null> {
  const mode = agentMemoryMode(input.agent);
  if (mode === "off") return null;

  // shared with an explicit, existing store → use it verbatim.
  if (mode === "shared" && input.agent.memory?.store_id) {
    const existing = await deps.memoryService.getStore({
      tenantId: input.tenantId,
      storeId: input.agent.memory.store_id,
    });
    if (existing) return { storeId: existing.id, mode, provisioned: false };
    deps.log?.("agent memory: pinned store missing; re-provisioning", {
      agent_id: input.agentId,
      store_id: input.agent.memory.store_id,
    });
  }

  if (mode === "per_user" && !input.principalId) {
    deps.log?.("agent memory: per_user session without a principal; using the anonymous bucket", {
      agent_id: input.agentId,
    });
  }
  const name = ownStoreName(input.agentId, mode, input.principalId);

  // Find-by-name first (idempotent across concurrent first sessions).
  const found = await findStoreByName(deps, input.tenantId, name);
  if (found) return { storeId: found, mode, provisioned: false };

  const created = await deps.memoryService.createStore({
    tenantId: input.tenantId,
    name,
    description:
      mode === "per_user"
        ? `Per-user memory for agent ${input.agentId}`
        : `Shared memory for agent ${input.agentId}`,
  });
  if (mode === "shared" && deps.pinAgentStore) {
    await deps.pinAgentStore({ tenantId: input.tenantId, agentId: input.agentId, storeId: created.id }).catch(
      (err) => deps.log?.("agent memory: pin failed", { err: String(err) }),
    );
  }
  return { storeId: created.id, mode, provisioned: true };
}

async function findStoreByName(deps: AgentMemoryModeDeps, tenantId: string, name: string): Promise<string | null> {
  const rows = await deps.memoryService.listStores({ tenantId, status: "active" });
  return rows.find((r) => r.name === name)?.id ?? null;
}

/** The lifecycle hook body: resolve + attach. Never throws (caller logs). */
export function buildAttachAgentMemory(deps: AgentMemoryModeDeps) {
  return async (input: {
    tenantId: string;
    sessionId: string;
    agentId: string;
    agentSnapshot: AgentConfig;
    principalId?: string;
  }): Promise<void> => {
    const resolved = await resolveAgentMemoryStore(deps, {
      tenantId: input.tenantId,
      agentId: input.agentId,
      agent: input.agentSnapshot,
      principalId: input.principalId,
    });
    if (!resolved) return;
    await deps.attach({ sessionId: input.sessionId, storeId: resolved.storeId, access: "read_write" });
    deps.log?.("agent memory: attached", {
      session_id: input.sessionId,
      agent_id: input.agentId,
      store_id: resolved.storeId,
      mode: resolved.mode,
      provisioned: resolved.provisioned,
    });
  };
}
