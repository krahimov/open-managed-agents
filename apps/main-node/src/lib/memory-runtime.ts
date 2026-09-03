// Memory runtime wiring for the Node main (memory-facts-design §5–§7):
// prompt-context (catalog + guidance reminders + primary-store resolution),
// the memory_* tools port, and per-turn push. Extracted from index.ts so
// the composition root stays a composition root. All IO goes through the
// injected deps; nothing here reaches module-scope singletons.

import type { AgentConfig, EnvironmentConfig } from "@open-managed-agents/shared";
import { extractTextFromContent } from "@open-managed-agents/shared";
import { memoryGuidance } from "@open-managed-agents/agent/harness/platform-guidance";
import type { buildTools } from "@open-managed-agents/agent/harness/tools";
import type { MemoryStoreService } from "@open-managed-agents/memory-store";
import type { SessionService } from "@open-managed-agents/sessions-store";
import type { SqlClient } from "@open-managed-agents/sql-client";
import { environmentMemoryStoreRefs } from "./environment-runtime-config.js";
import { sharedStoreName, anonymousStoreName } from "./agent-memory-mode.js";

export interface MemoryRuntimeDeps {
  memoryService: MemoryStoreService;
  sessionsService: SessionService;
  sql: SqlClient;
  /** Event log accessor for a session (turn counting for the first-turn briefing). */
  newEventLog: (sessionId: string) => { getEventsAsync(afterSeq?: number): Promise<unknown[]> };
  logger: { warn: (o: Record<string, unknown>, msg?: string) => void };
}

export type MemoryToolsPort = NonNullable<Parameters<typeof buildTools>[2]>["memory"];

export interface MemoryPromptContext {
  storeIds: string[];
  access: Map<string, "read_only" | "read_write">;
  /** The agent's own store when memory mode is on and it is attached; else null. */
  primaryStoreId: string | null;
  mode: "off" | "shared" | "per_user";
  reminders: Array<{ source: string; text: string }>;
}

/**
 * Compare-and-swap append to <store>/facts.md. Reads the current file,
 * writes it back with the CAS precondition (content_sha256 of what was
 * read); on a precondition conflict — another remember landed in between —
 * re-read and retry. Bounded retries; the LAST attempt is unconditional so
 * an unusually hot store still converges rather than dropping the line.
 * Exported for tests.
 */
export async function appendFactsMdLine(
  memoryService: Pick<MemoryStoreService, "readByPath" | "writeByPath">,
  input: { tenantId: string; storeId: string; actor: { type: "agent_session" | "system" | "user" | "api_key"; id: string }; line: string },
  maxAttempts = 5,
): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const existing = await memoryService.readByPath({ tenantId: input.tenantId, storeId: input.storeId, path: "facts.md" }).catch(() => null);
    const base = existing?.content ? existing.content.replace(/\s+$/, "") + "\n" : "# Facts\n\n";
    const content = base + input.line + "\n";
    const precondition = attempt < maxAttempts
      ? existing
        ? ({ type: "content_sha256", content_sha256: existing.content_sha256 } as const)
        : ({ type: "not_exists" } as const)
      : undefined;
    try {
      await memoryService.writeByPath({
        tenantId: input.tenantId,
        storeId: input.storeId,
        path: "facts.md",
        content,
        ...(precondition ? { precondition } : {}),
        actor: input.actor as never,
      });
      return;
    } catch (err) {
      // Precondition conflicts (another writer landed between our read and
      // write — covers both ifMatch and not_exists races) are retryable.
      if ((err as { code?: string })?.code === "memory_precondition_failed" && attempt < maxAttempts) continue;
      throw err;
    }
  }
}

export function createMemoryRuntime(deps: MemoryRuntimeDeps) {
  const { memoryService, sessionsService, sql, newEventLog, logger } = deps;

  async function buildNodeMemoryPromptContext(
    tenantId: string,
    sessionId: string,
  ): Promise<{
    storeIds: string[];
    access: Map<string, "read_only" | "read_write">;
    primaryStoreId: string | null;
    mode: "off" | "shared" | "per_user";
    reminders: Array<{ source: string; text: string }>;
  }> {
    const attachments = new Map<string, {
      storeId: string;
      access: "read_only" | "read_write";
      instructions?: string;
    }>();

    const session = await sessionsService.get({ tenantId, sessionId }).catch(() => null);
    await addEnvironmentMemoryPromptBindings(attachments, tenantId, session?.environment_snapshot);

    {
      // Both dialects use the shared service (JSON `config` blob) since
      // migration 0002 reconciled PG session_resources with the cf-auth shape.
      const resources = await sessionsService
        .listResourcesBySession({ sessionId })
        .catch(() => []);
      for (const row of resources) {
        if (row.type !== "memory_store") continue;
        const resource = row.resource as {
          memory_store_id?: string;
          store_id?: string;
          access?: string;
          instructions?: string;
        };
        const storeId = resource.memory_store_id ?? resource.store_id;
        if (!storeId) continue;
        attachments.set(storeId, {
          storeId,
          access: resource.access === "read_only" ? "read_only" : "read_write",
          instructions:
            typeof resource.instructions === "string"
              ? resource.instructions.slice(0, 4096)
              : undefined,
        });
      }
    }

    const legacyRows = await sql
      .prepare(`SELECT store_id, access FROM session_memory_stores WHERE session_id = ?`)
      .bind(sessionId)
      .all<{ store_id: string; access: string }>()
      .catch(() => ({ results: [] }));
    for (const row of legacyRows.results ?? []) {
      if (attachments.has(row.store_id)) continue;
      attachments.set(row.store_id, {
        storeId: row.store_id,
        access: row.access === "read_only" ? "read_only" : "read_write",
      });
    }

    const reminders: Array<{ source: string; text: string }> = [];
    // Harness-agnostic memory usage guidance, only when ≥1 store is attached
    // (memory-facts-design §7). Prepended so it precedes the per-store blocks.
    if (attachments.size > 0) {
      reminders.push({ source: "memory:guidance", text: memoryGuidance });
    }
    for (const attachment of attachments.values()) {
      const store = await memoryService.getStore({
        tenantId,
        storeId: attachment.storeId,
      });
      if (!store) continue;
      const accessLabel = attachment.access === "read_only" ? "read-only" : "read-write";
      const lines = [
        `## Memory store: ${store.name}`,
        `Mounted at /mnt/memory/${store.name}/ (${accessLabel})`,
      ];
      // Catalog line (memory-facts-design §5): constant-size summary of the
      // indexed facts so the agent knows what memory_search can find without
      // reading the store. Best-effort — absent when the facts index is off.
      if (memoryService.factsEnabled()) {
        try {
          const st = await memoryService.factStats({ tenantId, storeId: attachment.storeId });
          if (st.total > 0) {
            const kinds = ["rule", "preference", "decision", "entity", "note"]
              .filter((k) => (st.byKind[k] ?? 0) > 0)
              .map((k) => `${st.byKind[k]} ${k}${st.byKind[k] === 1 ? "" : "s"}`)
              .join(" · ");
            // No wall-clock "last updated" here on purpose: this text is part
            // of the cached system prefix and must not change between turns.
            lines.push(
              `Indexed facts: ${st.total} (${kinds}). Use memory_search to look them up; memory_remember to add.`,
            );
          } else {
            lines.push("Indexed facts: none yet. Use memory_remember when the user states a durable preference, rule, or decision.");
          }
        } catch {
          // catalog is best-effort
        }
      }
      if (store.description) lines.push(store.description);
      if (attachment.instructions) lines.push(attachment.instructions);
      if (attachment.access === "read_only") {
        lines.push("(read-only mount - write attempts to this directory will fail)");
      }
      reminders.push({
        source: `memory:${attachment.storeId}`,
        text: lines.join("\n"),
      });
    }

    // The agent's OWN store (memory-facts-design §6) is the PRIMARY target for
    // push, extraction, and default memory_remember. Environment bindings may
    // attach additional stores; in per_user mode those are shared across
    // principals, so writing a user's facts there would leak them. Resolve
    // the primary by the deterministic own-store NAME for this agent+mode
    // (+ the pinned store_id for shared), and match it against attachments.
    let primaryStoreId: string | null = null;
    const snap = session?.agent_snapshot as { id?: string; memory?: { mode?: string; store_id?: string } } | null;
    const mode = snap?.memory?.mode;
    if (snap?.id && (mode === "shared" || mode === "per_user")) {
      const candidates = new Set<string>();
      if (mode === "shared" && snap.memory?.store_id) candidates.add(snap.memory.store_id);
      // principal is not persisted on the session row; match by name for both
      // the principal-keyed and the anonymous bucket.
      const names = new Set<string>([
        sharedStoreName(snap.id),
        anonymousStoreName(snap.id),
      ]);
      for (const storeId of attachments.keys()) {
        if (candidates.has(storeId)) { primaryStoreId = storeId; break; }
      }
      if (!primaryStoreId) {
        for (const storeId of attachments.keys()) {
          const st = await memoryService.getStore({ tenantId, storeId }).catch(() => null);
          if (st && (names.has(st.name) || st.name.startsWith(`agent-${snap.id}-user-`))) { primaryStoreId = storeId; break; }
        }
      }
    }
    return {
      storeIds: [...attachments.keys()],
      access: new Map([...attachments.values()].map((a) => [a.storeId, a.access] as const)),
      /** The agent's own store when memory mode is on and it is attached; else null. */
      primaryStoreId,
      mode: mode === "shared" || mode === "per_user" ? mode : "off",
      reminders,
    };
  }

  const MEMORY_PUSH_MAX = 5;
  const MEMORY_PUSH_CHAR_CAP = 1_600; // ≈400 tokens

  /** Was this the session's first user turn? Cheap event-log scan bounded to
   *  the head of the log. First turns also get the "always know" briefing. */
  async function isFirstUserTurn(sessionId: string): Promise<boolean> {
    const evs = await newEventLog(sessionId).getEventsAsync(0);
    let userTurns = 0;
    for (const e of evs) {
      if ((e as { type?: string }).type === "user.message") userTurns++;
      if (userTurns > 1) return false;
    }
    return userTurns <= 1;
  }

  async function buildMemoryPushReminder(input: {
    tenantId: string;
    storeIds: string[];
    userMessage: { content?: unknown };
    isFirstTurn: boolean;
  }): Promise<{ text: string; factIds: string[] } | null> {
    const turnText = extractTextFromContent(input.userMessage.content).trim();
    const picks = new Map<string, Awaited<ReturnType<typeof memoryService.searchFacts>>[number]>();
    // 1) Match the turn against standing rules/preferences (always eligible)
    //    and other kinds on strong match (they rank below rules by kind boost).
    if (turnText) {
      const hits = await memoryService.searchFacts({
        tenantId: input.tenantId,
        storeIds: input.storeIds,
        query: turnText.slice(0, 500),
        limit: MEMORY_PUSH_MAX,
      });
      for (const f of hits) picks.set(f.id, f);
    }
    // 2) First turn: brief the model with the most recent rules/preferences
    //    regardless of match ("what you should always know").
    if (input.isFirstTurn && picks.size < MEMORY_PUSH_MAX) {
      const brief = await memoryService.searchFacts({
        tenantId: input.tenantId,
        storeIds: input.storeIds,
        kinds: ["rule", "preference"],
        limit: MEMORY_PUSH_MAX,
      });
      for (const f of brief) {
        if (picks.size >= MEMORY_PUSH_MAX) break;
        picks.set(f.id, f);
      }
    }
    if (picks.size === 0) return null;
    const lines: string[] = [
      "Relevant from memory (apply if pertinent to this turn; verify with memory_get if unsure):",
    ];
    let used = lines[0].length;
    const factIds: string[] = [];
    for (const f of picks.values()) {
      const when = new Date(f.observed_at).toISOString().slice(0, 10);
      const line = `- [${f.kind}] ${f.statement}${f.applies_when ? ` (applies when: ${f.applies_when})` : ""} (${when}${f.source_session_id ? `, session ${f.source_session_id}` : ""}; id ${f.id})`;
      if (used + line.length > MEMORY_PUSH_CHAR_CAP) break;
      lines.push(line);
      used += line.length;
      factIds.push(f.id);
    }
    if (factIds.length === 0) return null;
    return { text: lines.join("\n"), factIds };
  }


  /**
   * Facts port for the memory_* tools (memory-facts-design §5). Resolves the
   * session's attached stores (env bindings + session_memory_stores — same
   * sources as the prompt reminder) and closes over the memory service.
   * Returns null when nothing is attached or the facts index is unavailable.
   */
  async function buildNodeMemoryToolsPort(
    tenantId: string,
    sessionId: string,
    agentId: string,
  ): Promise<NonNullable<Parameters<typeof buildTools>[2]>["memory"] | null> {
    if (!memoryService.factsEnabled()) return null;
    const ctx = await buildNodeMemoryPromptContext(tenantId, sessionId);
    if (ctx.storeIds.length === 0) return null;
    const stores: Array<{ id: string; name: string; access: "read_only" | "read_write" }> = [];
    for (const storeId of ctx.storeIds) {
      const store = await memoryService.getStore({ tenantId, storeId });
      if (!store) continue;
      const access = ctx.access.get(storeId) ?? "read_write";
      stores.push({ id: store.id, name: store.name, access });
    }
    if (stores.length === 0) return null;
    // Scope: in per_user mode the ONLY store this principal may read/write
    // through the facts tools is the agent's own (primary) store — env-bound
    // stores are shared across principals. In shared/off modes all attached
    // stores are in scope.
    const perUser = (ctx.mode === "per_user");
    const scoped = perUser && ctx.primaryStoreId ? stores.filter((s) => s.id === ctx.primaryStoreId) : stores;
    const storeIds = scoped.map((s) => s.id);
    const primary = ctx.primaryStoreId ? scoped.find((s) => s.id === ctx.primaryStoreId) ?? null : null;
    const writable = (primary && primary.access === "read_write" ? primary : null) ?? scoped.find((s) => s.access === "read_write");
    return {
      stores: scoped,
      search: async (args) =>
        (
          await memoryService.searchFacts({
            tenantId,
            storeIds,
            query: args.query,
            kinds: args.kinds as never,
            subject: args.subject,
            includeHistory: args.include_history,
            limit: args.limit,
          })
        ).map((f) => ({
          id: f.id,
          kind: f.kind,
          subject: f.subject,
          statement: f.statement,
          applies_when: f.applies_when,
          observed_at: f.observed_at,
          status: f.status,
          source_path: f.source_path,
          source_session_id: f.source_session_id,
        })),
      get: async (id) => {
        const got = await memoryService.getFact({ tenantId, factId: id });
        if (!got || !storeIds.includes(got.fact.store_id)) return null;
        let source_excerpt: string | undefined;
        if (got.fact.source_path) {
          try {
            const row = await memoryService.readByPath({ tenantId, storeId: got.fact.store_id, path: got.fact.source_path });
            if (row?.content) source_excerpt = row.content.slice(0, 1_500);
          } catch {
            // excerpt is best-effort
          }
        }
        return {
          fact: {
            id: got.fact.id, kind: got.fact.kind, subject: got.fact.subject, statement: got.fact.statement,
            applies_when: got.fact.applies_when, observed_at: got.fact.observed_at, status: got.fact.status,
            source_path: got.fact.source_path, source_session_id: got.fact.source_session_id,
          },
          chain: got.chain.map((c) => ({ id: c.id, statement: c.statement, observed_at: c.observed_at, status: c.status })),
          source_excerpt,
        };
      },
      remember: async (args) => {
        const target = args.store_id ? stores.find((s) => s.id === args.store_id) : writable;
        if (!target) throw new Error("no writable memory store attached to this session");
        if (target.access !== "read_write") throw new Error(`memory store ${target.name} is read-only`);
        const fact = await memoryService.rememberFact({
          tenantId,
          storeId: target.id,
          agentId,
          kind: args.kind as never,
          subject: args.subject,
          statement: args.statement,
          appliesWhen: args.applies_when ?? null,
          sourceSessionId: sessionId,
        });
        // Keep the file substrate authoritative + human-visible: append a
        // line to <store>/facts.md (best-effort; the row is the index).
        // ATOMIC: concurrent memory_remember calls in one turn each did a
        // read-modify-write here and LOST lines (seen live: 3 remembers → 2
        // lines). Use the store's CAS precondition and retry on conflict.
        try {
          await appendFactsMdLine(memoryService, {
            tenantId,
            storeId: target.id,
            actor: { type: "agent_session", id: sessionId },
            line: `- ${new Date(fact.observed_at).toISOString().slice(0, 10)} [${fact.kind}] ${fact.subject}: ${fact.statement}${fact.applies_when ? ` (applies when: ${fact.applies_when})` : ""}`,
          });
        } catch (err) {
          logger.warn({ op: "memory.remember.facts_md", err }, "facts.md append failed; fact row saved");
        }
        return { id: fact.id, superseded_id: fact.supersedes_id, store_id: target.id };
      },
    };
  }

  async function addEnvironmentMemoryPromptBindings(
    attachments: Map<string, {
      storeId: string;
      access: "read_only" | "read_write";
      instructions?: string;
    }>,
    tenantId: string,
    environment?: EnvironmentConfig | null,
  ): Promise<void> {
    const refs = environmentMemoryStoreRefs(environment);
    if (refs.length === 0) return;

    let storesByName: Map<string, string> | null = null;
    for (const ref of refs) {
      let storeId = ref.storeId;
      if (!storeId && ref.name) {
        storesByName ??= await loadNodeMemoryStoresByName(tenantId);
        storeId = storesByName.get(ref.name);
      }
      if (!storeId) continue;
      attachments.set(storeId, {
        storeId,
        access: ref.access,
        ...(ref.instructions ? { instructions: ref.instructions } : {}),
      });
    }
  }

  async function loadNodeMemoryStoresByName(tenantId: string): Promise<Map<string, string>> {
    const stores = await memoryService.listStores({ tenantId, status: "active" });
    return new Map(stores.map((store) => [store.name, store.id]));
  }

  return {
    buildNodeMemoryPromptContext,
    buildNodeMemoryToolsPort,
    buildMemoryPushReminder,
    isFirstUserTurn,
    addEnvironmentMemoryPromptBindings,
    loadNodeMemoryStoresByName,
  };
}
