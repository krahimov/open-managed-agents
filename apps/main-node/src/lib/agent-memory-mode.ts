// Agent-level memory (`_oma.memory.mode`) — the one place that turns memory
// on for an agent and attaches the agent's own store to its sessions.
//
//   off      → nothing attached; every session starts blank. An EXPLICIT
//              off is a user decision the platform never overrides.
//   shared   → one store per agent: `agent.memory.store_id`, provisioned as
//              `<agent id>-memory` and pinned back onto the agent config so
//              every later session reuses it (find-by-name before create
//              keeps a concurrent first-use race from minting two).
//   per_user → one store per (agent, principal), provisioned lazily; a
//              caller with no principal gets an explicit anonymous bucket,
//              never another user's store.
//
// Memory itself is the existing memory-store system (blobs + index, mounted
// at /mnt/memory/<store name>/ and read/written with the normal file
// tools). Nothing here is a second storage path — it only decides WHICH
// store an agent owns and makes sure every working session gets it.
//
// Three ways in, all through `enableAgentMemory`:
//   - the setup agent's enable_memory tool (setup-harness.ts)
//   - automatically when an ambient rule is created on an agent that never
//     had memory configured (each firing is a fresh session, so memory is
//     the only continuity a recurring agent has)
//   - the console toggle (PUT /v1/agents/:id/memory)

import { createHash } from "node:crypto";
import { Hono } from "hono";
import type { AgentConfig, AgentMemoryConfig, AgentMemoryMode } from "@open-managed-agents/shared";

interface StoreLike {
  id: string;
  name: string;
  archived_at?: string | null;
}

export interface AgentMemoryDeps {
  memoryService: {
    createStore(o: { tenantId: string; name: string; description?: string }): Promise<StoreLike>;
    getStore(o: { tenantId: string; storeId: string }): Promise<StoreLike | null>;
    listStores(o: { tenantId: string; status?: "active" | "archived" | "any" }): Promise<StoreLike[]>;
    listMemories?(o: { tenantId: string; storeId: string }): Promise<Array<{ path: string; updated_at: string }>>;
  };
  agents: {
    get(o: { tenantId: string; agentId: string }): Promise<AgentConfig | null>;
    update(o: {
      tenantId: string;
      agentId: string;
      input: { memory: AgentMemoryConfig };
    }): Promise<AgentConfig>;
  };
  /** Attach a store to a session (idempotent). */
  attach(input: {
    tenantId: string;
    sessionId: string;
    storeId: string;
    access: "read_only" | "read_write";
  }): Promise<void>;
  log?: (msg: string, ctx?: Record<string, unknown>) => void;
}

export function agentMemoryMode(agent: Pick<AgentConfig, "memory"> | null | undefined): AgentMemoryMode {
  const m = agent?.memory?.mode;
  return m === "shared" || m === "per_user" ? m : "off";
}

export function sharedStoreName(agentId: string): string {
  return agentId.startsWith("agent-") ? `${agentId}-memory` : `agent-${agentId}-memory`;
}

export function perUserStoreName(agentId: string, principalId: string): string {
  const h = createHash("sha256").update(principalId).digest("hex").slice(0, 12);
  return `${sharedStoreName(agentId).replace(/-memory$/, "")}-user-${h}`;
}

/** per_user callers with NO principal get an explicit anonymous bucket —
 *  never the shared store, which would merge every anonymous caller's
 *  memory with the operator's. */
export function anonymousStoreName(agentId: string): string {
  return `${sharedStoreName(agentId).replace(/-memory$/, "")}-user-anonymous`;
}

async function findActiveStoreByName(
  deps: Pick<AgentMemoryDeps, "memoryService">,
  tenantId: string,
  name: string,
): Promise<StoreLike | null> {
  const rows = await deps.memoryService.listStores({ tenantId, status: "active" });
  return rows.find((r) => r.name === name) ?? null;
}

async function getActiveStore(
  deps: Pick<AgentMemoryDeps, "memoryService">,
  tenantId: string,
  storeId: string,
): Promise<StoreLike | null> {
  const store = await deps.memoryService.getStore({ tenantId, storeId }).catch(() => null);
  return store && !store.archived_at ? store : null;
}

async function findOrCreateStore(
  deps: Pick<AgentMemoryDeps, "memoryService">,
  tenantId: string,
  name: string,
  description: string,
): Promise<{ store: StoreLike; provisioned: boolean }> {
  const found = await findActiveStoreByName(deps, tenantId, name);
  if (found) return { store: found, provisioned: false };
  const created = await deps.memoryService.createStore({ tenantId, name, description });
  return { store: created, provisioned: true };
}

function storeDescription(agent: Pick<AgentConfig, "name">, perUser = false): string {
  const label = agent.name ? `agent "${agent.name}"` : "this agent";
  return perUser
    ? `Per-user memory for ${label} — notes it keeps for one user across sessions.`
    : `Memory for ${label} — notes it keeps across sessions (what it reported, standing preferences, decisions).`;
}

// ─── Enable / disable / inspect ─────────────────────────────────────────

export interface AgentMemoryState {
  enabled: boolean;
  mode: AgentMemoryMode;
  /** True when the user (or API caller) explicitly set mode "off" — the
   *  platform's automatic enable leaves such agents alone. */
  explicit_off: boolean;
  /** The agent's own store. Present while off too when one is still pinned
   *  (its notes are kept and reused on re-enable). Where a session finds
   *  it depends on the harness (/mnt/memory/<name>/ in a sandbox,
   *  ./memory/<name>/ for host-workdir SDK harnesses), so no path is
   *  reported here — each working session is told its own. */
  store: { id: string; name: string } | null;
}

export async function getAgentMemoryState(
  deps: Pick<AgentMemoryDeps, "memoryService" | "agents">,
  input: { tenantId: string; agentId: string; agent?: AgentConfig | null },
): Promise<AgentMemoryState | null> {
  const agent = input.agent ?? (await deps.agents.get(input));
  if (!agent) return null;
  const mode = agentMemoryMode(agent);
  // Reported even when off: a disabled agent keeps its store pinned so
  // re-enabling finds the same notes.
  const storeId = mode === "per_user" ? undefined : agent.memory?.store_id;
  const store = storeId ? await getActiveStore(deps, input.tenantId, storeId) : null;
  return {
    enabled: mode !== "off",
    mode,
    explicit_off: agent.memory?.mode === "off",
    store: store ? { id: store.id, name: store.name } : null,
  };
}

export interface EnableMemoryResult extends AgentMemoryState {
  /** False when memory was already on with a live store — nothing changed. */
  newly_enabled: boolean;
}

/**
 * Turn memory on for an agent: make sure its store exists and that the
 * agent config says `{ mode: "shared", store_id }`. Idempotent — a second
 * call finds the same store and writes nothing. An agent already in
 * per_user mode is left as is (it is already "on").
 */
export async function enableAgentMemory(
  deps: Pick<AgentMemoryDeps, "memoryService" | "agents" | "log">,
  input: { tenantId: string; agentId: string },
): Promise<EnableMemoryResult> {
  const agent = await deps.agents.get(input);
  if (!agent) throw new Error("Agent not found");

  if (agentMemoryMode(agent) === "per_user") {
    return { enabled: true, mode: "per_user", explicit_off: false, store: null, newly_enabled: false };
  }

  const wasOn = agentMemoryMode(agent) === "shared";
  const pinned = agent.memory?.store_id
    ? await getActiveStore(deps, input.tenantId, agent.memory.store_id)
    : null;
  const { store, provisioned } = pinned
    ? { store: pinned, provisioned: false }
    : await findOrCreateStore(deps, input.tenantId, sharedStoreName(input.agentId), storeDescription(agent));

  if (!wasOn || agent.memory?.store_id !== store.id) {
    await deps.agents.update({
      tenantId: input.tenantId,
      agentId: input.agentId,
      input: { memory: { mode: "shared", store_id: store.id } },
    });
  }
  deps.log?.("agent memory: enabled", {
    agent_id: input.agentId,
    store_id: store.id,
    provisioned,
    newly_enabled: !wasOn,
  });
  return {
    enabled: true,
    mode: "shared",
    explicit_off: false,
    store: { id: store.id, name: store.name },
    newly_enabled: !wasOn,
  };
}

/** Explicit off. The store and its notes are kept (re-enabling reuses the
 *  pinned store); only attachment to new sessions stops. */
export async function disableAgentMemory(
  deps: Pick<AgentMemoryDeps, "memoryService" | "agents">,
  input: { tenantId: string; agentId: string },
): Promise<AgentMemoryState> {
  const agent = await deps.agents.get(input);
  if (!agent) throw new Error("Agent not found");
  const storeId = agent.memory?.store_id;
  const updated = await deps.agents.update({
    tenantId: input.tenantId,
    agentId: input.agentId,
    // Keeping store_id on the row is what lets a later re-enable find the
    // same notes.
    input: { memory: { mode: "off", ...(storeId ? { store_id: storeId } : {}) } },
  });
  return (await getAgentMemoryState(deps, { ...input, agent: updated }))!;
}

/**
 * The default for recurring agents: creating an ambient rule switches
 * memory on — unless the user explicitly turned it off. Returns what
 * happened so the caller can say so truthfully.
 */
export async function autoEnableMemoryForAmbientRule(
  deps: Pick<AgentMemoryDeps, "memoryService" | "agents" | "log">,
  input: { tenantId: string; agentId: string },
): Promise<{ action: "enabled" | "already_on" | "left_off"; state: AgentMemoryState }> {
  const agent = await deps.agents.get(input);
  if (!agent) throw new Error("Agent not found");
  if (agent.memory?.mode === "off") {
    return { action: "left_off", state: (await getAgentMemoryState(deps, { ...input, agent }))! };
  }
  const result = await enableAgentMemory(deps, input);
  return { action: result.newly_enabled ? "enabled" : "already_on", state: result };
}

// ─── Truthful wording for tool results ──────────────────────────────────

/** Result text for the enable_memory tool. States only what is now true. */
export function describeMemoryEnabled(r: EnableMemoryResult): string {
  if (r.mode === "per_user") {
    return "Memory is already ON for this agent in per-user mode: each user gets their own memory store, attached to every new working session.";
  }
  const where = r.store
    ? ` Store "${r.store.name}" is attached read-write to every new working session (including scheduled runs), where it appears as a directory of notes.`
    : "";
  const head = r.newly_enabled
    ? "Memory is now ON for this agent."
    : "Memory was already ON for this agent — nothing changed.";
  return `${head}${where} Working sessions are told what is saved there and save notes with their normal file tools; this setup conversation itself has no access to the store. Tell the user memory is on, and make your system prompt say what to record at the end of each run (e.g. what was reported, with the date).`;
}

/** Appended to the create_ambient_rule result (setup AND working sessions,
 *  so it must not assume either toolset). */
export function describeAmbientMemory(r: { action: "enabled" | "already_on" | "left_off"; state: AgentMemoryState }): string {
  if (r.action === "left_off") {
    return "Memory is OFF for this agent (turned off explicitly), so each scheduled run starts with no memory of earlier runs. Tell the user; memory can be turned on from the agent page (or with enable_memory during setup).";
  }
  const where = r.state.store ? ` (store "${r.state.store.name}")` : "";
  return r.action === "enabled"
    ? `Memory was switched ON automatically for this agent${where}, because each scheduled run is a fresh session and memory is its only continuity. It is attached to NEW sessions — every scheduled run included — not to this conversation. Tell the user, and make sure the rule prompt / system prompt says what to record at the end of each run.`
    : `Memory is ON for this agent${where} — each scheduled run can read what earlier runs saved.`;
}

// ─── Session attach ─────────────────────────────────────────────────────

/**
 * Resolve (provisioning if needed) the store a session of this agent should
 * get. Null when the mode is off.
 */
export async function resolveAgentMemoryStore(
  deps: Pick<AgentMemoryDeps, "memoryService" | "agents" | "log">,
  input: { tenantId: string; agentId: string; agent: AgentConfig; principalId?: string },
): Promise<{ storeId: string; mode: "shared" | "per_user"; provisioned: boolean } | null> {
  const mode = agentMemoryMode(input.agent);
  if (mode === "off") return null;

  if (mode === "shared") {
    if (input.agent.memory?.store_id) {
      const pinned = await getActiveStore(deps, input.tenantId, input.agent.memory.store_id);
      if (pinned) return { storeId: pinned.id, mode, provisioned: false };
      deps.log?.("agent memory: pinned store missing; re-provisioning", {
        agent_id: input.agentId,
        store_id: input.agent.memory.store_id,
      });
    }
    // Mode set without a (live) store — e.g. `_oma.memory.mode: "shared"`
    // written straight through the agents API. Same path as the explicit
    // enable, which also pins the store id back onto the agent.
    const enabled = await enableAgentMemory(deps, input);
    return enabled.store ? { storeId: enabled.store.id, mode, provisioned: true } : null;
  }

  if (!input.principalId) {
    deps.log?.("agent memory: per_user session without a principal; using the anonymous bucket", {
      agent_id: input.agentId,
    });
  }
  const name = input.principalId
    ? perUserStoreName(input.agentId, input.principalId)
    : anonymousStoreName(input.agentId);
  const { store, provisioned } = await findOrCreateStore(
    deps,
    input.tenantId,
    name,
    storeDescription(input.agent, true),
  );
  return { storeId: store.id, mode, provisioned };
}

export interface AttachAgentMemoryInput {
  tenantId: string;
  sessionId: string;
  agentId: string;
  agentSnapshot: AgentConfig;
  metadata?: Record<string, unknown> | null;
  principalId?: string;
}

/**
 * Attach the agent's own store to a freshly created session. Every path
 * that creates a working session calls this (REST, ambient dispatch,
 * integration webhooks, Telegram) — a path that skips it produces a session
 * with no memory. Setup sessions are skipped: they have no file tools and
 * never read the store.
 */
export function buildAttachAgentMemory(deps: AgentMemoryDeps) {
  return async (input: AttachAgentMemoryInput): Promise<void> => {
    if (input.metadata?.oma_setup === true) return;
    const resolved = await resolveAgentMemoryStore(deps, {
      tenantId: input.tenantId,
      agentId: input.agentId,
      agent: input.agentSnapshot,
      principalId: input.principalId,
    });
    if (!resolved) return;
    await deps.attach({
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      storeId: resolved.storeId,
      access: "read_write",
    });
    deps.log?.("agent memory: attached", {
      session_id: input.sessionId,
      agent_id: input.agentId,
      store_id: resolved.storeId,
      mode: resolved.mode,
      provisioned: resolved.provisioned,
    });
  };
}

// ─── REST: the console's memory toggle ──────────────────────────────────

export interface AgentMemoryRouteDeps {
  memory: Pick<AgentMemoryDeps, "memoryService" | "agents" | "log">;
}

/**
 * GET  /v1/agents/:id/memory            → state (+ note count for the store)
 * PUT  /v1/agents/:id/memory {enabled}  → enable (provision + pin) / disable
 *
 * The generic agents API also accepts `_oma.memory`; this route exists so
 * the toggle provisions the store immediately and can show which one.
 */
export function buildAgentMemoryRoutes(deps: AgentMemoryRouteDeps) {
  const app = new Hono<{ Variables: { tenant_id: string } }>();

  const withCounts = async (tenantId: string, state: AgentMemoryState) => {
    if (!state.store || !deps.memory.memoryService.listMemories) return { type: "agent_memory", ...state };
    const notes = await deps.memory.memoryService
      .listMemories({ tenantId, storeId: state.store.id })
      .catch(() => []);
    const last = notes.map((n) => n.updated_at).sort().at(-1) ?? null;
    // One file can be indexed as both "x.md" and "/x.md" depending on which
    // writer recorded it (API / SDK write-back vs the local fs watcher).
    const files = new Set(notes.map((n) => n.path.replace(/^\/+/, "")));
    return {
      type: "agent_memory",
      ...state,
      store: { ...state.store, note_count: files.size, last_written_at: last },
    };
  };

  app.get("/:id/memory", async (c) => {
    const tenantId = c.get("tenant_id");
    const state = await getAgentMemoryState(deps.memory, { tenantId, agentId: c.req.param("id") });
    if (!state) return c.json({ error: "Agent not found" }, 404);
    return c.json(await withCounts(tenantId, state));
  });

  app.put("/:id/memory", async (c) => {
    const tenantId = c.get("tenant_id");
    const agentId = c.req.param("id");
    const body = (await c.req.json().catch(() => null)) as { enabled?: unknown } | null;
    if (!body || typeof body.enabled !== "boolean") {
      return c.json({ error: "enabled (boolean) is required" }, 400);
    }
    if (!(await deps.memory.agents.get({ tenantId, agentId }))) {
      return c.json({ error: "Agent not found" }, 404);
    }
    const state = body.enabled
      ? await enableAgentMemory(deps.memory, { tenantId, agentId })
      : await disableAgentMemory(deps.memory, { tenantId, agentId });
    const { newly_enabled: _n, ...rest } = state as EnableMemoryResult;
    return c.json(await withCounts(tenantId, rest));
  });

  return app;
}
