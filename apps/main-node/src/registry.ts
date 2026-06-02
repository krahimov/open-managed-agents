// SessionRegistry — Node thin shell around the unified SessionStateMachine.
//
// One SessionRegistry per process; one SessionStateMachine per active
// session, lazily created on first request. The shell's job is:
//
//   1. Hold the per-process deps (sql, hub, services, env-derived
//      config) in its closure.
//   2. Lazily build a SessionStateMachine on first access. The machine
//      itself owns the per-session sandbox + adapter.
//   3. Run a one-shot bootstrap() at process start to wake any session
//      whose row was left status='running' by a prior process (orphan
//      recovery via the unified machine.onWake path).
//
// Mirrors what apps/agent's SessionDO will become in Phase 3 (a thin
// shell around the same machine, with `alarm()` instead of bootstrap()
// as the orphan-detection trigger).
//
// Sandbox provisioning (memory mounts, /mnt/session/outputs, vault
// outbound, optional workspace-restore) is delegated to the
// SandboxOrchestrator from `@open-managed-agents/sandbox/orchestrator`
// — same interface CF wires for the OmaSandbox path. Per-runtime
// mounters were removed in P5.

import { join } from "node:path";
import {
  RuntimeAdapterImpl,
  SessionStateMachine,
} from "@open-managed-agents/session-runtime";
import type { SqlClient } from "@open-managed-agents/sql-client";
import { SqlStreamRepo, type SqlEventLog } from "@open-managed-agents/event-log/sql";
import type { SandboxExecutor } from "@open-managed-agents/sandbox";
import type {
  OrchestratorMemoryMount,
  SandboxOrchestrator,
} from "@open-managed-agents/sandbox/orchestrator";
import type { AgentService } from "@open-managed-agents/agents-store";
import type { MemoryStoreService } from "@open-managed-agents/memory-store";
import type {
  AgentConfig,
  EnvironmentConfig,
  SessionEvent,
  UserMessageEvent,
} from "@open-managed-agents/shared";
import type { LanguageModel } from "ai";
import { getLogger } from "@open-managed-agents/observability";
import type { EventStreamHub } from "./lib/event-stream-hub.js";
import {
  environmentMemoryStoreRefs,
  environmentMountsSessionOutputs,
} from "./lib/environment-runtime-config.js";

const log = getLogger("session-registry");

export interface SessionRegistryDeps {
  sql: SqlClient;
  hub: EventStreamHub;
  agentsService: AgentService;
  memoryService: MemoryStoreService;
  /** Sandbox provisioning — vault outbound, mounts, backup-restore.
   *  Replaces the per-runtime buildMemoryMounter / buildSessionOutputsMounter
   *  hooks from before P5. */
  sandboxOrchestrator: SandboxOrchestrator;

  /** Build the per-session event log. Mirrors main-node's existing
   *  newEventLog(sid) — keeps the stamp closure local to the shell. */
  newEventLog(sessionId: string): SqlEventLog;

  /** Build the per-session sandbox. The shell knows how to assemble a
   *  LocalSubprocess / E2B / Daytona / etc., the machine doesn't. */
  buildSandbox(
    sessionId: string,
    workdir: string,
    environment?: EnvironmentConfig | null,
  ): Promise<SandboxExecutor>;

  /** Build the LanguageModel for the agent. Reads env, applies custom
   *  headers, picks the right provider. */
  buildModel(agent: AgentConfig): LanguageModel | Promise<LanguageModel>;

  /** Build harness tools. Returns the tools dict the harness expects. */
  buildTools(
    agent: AgentConfig,
    sandbox: SandboxExecutor,
    context: {
      tenantId: string;
      sessionId: string;
      environment?: EnvironmentConfig | null;
    },
  ): Promise<unknown>;

  /** Build harness instance + context. Each is platform-neutral so the
   *  machine just calls .run(ctx). */
  buildHarness(): { run: (ctx: unknown) => Promise<void> };
  buildHarnessContext(input: {
    agent: AgentConfig;
    userMessage: UserMessageEvent;
    sandbox: SandboxExecutor;
    tools: unknown;
    model: LanguageModel;
    tenantId: string;
    sessionId: string;
    eventLog: SqlEventLog;
  }): Promise<unknown>;

  /** Sandbox workdir root, e.g. /app/data/sandboxes. Per-session dirs
   *  are joined under it. */
  sandboxWorkdirRoot: string;

  /** SQL dialect under the SqlClient. Threaded through to SqlStreamRepo
   *  so its appendChunk picks the right JSON-array append (json_insert
   *  on sqlite, jsonb concat on postgres). */
  sqlDialect?: "sqlite" | "postgres";
}

interface SessionEntry {
  machine: SessionStateMachine;
  sandbox: SandboxExecutor;
  eventLog: SqlEventLog;
}

export class SessionRegistry {
  private map = new Map<string, Promise<SessionEntry>>();

  constructor(private deps: SessionRegistryDeps) {}

  /**
   * Get-or-create the SessionStateMachine for a session. Lazy: the
   * sandbox + adapter aren't built until first access. Cached: the same
   * machine is reused across HTTP requests (so chokidar watcher /
   * recovery / repeated user.messages all hit the same in-memory state).
   */
  async getOrCreate(sessionId: string, tenantId: string): Promise<SessionEntry> {
    let p = this.map.get(sessionId);
    if (!p) {
      p = this.build(sessionId, tenantId);
      this.map.set(sessionId, p);
    }
    return p;
  }

  /**
   * Process-startup orphan reconciliation. Reads sessions WHERE
   * status='running' and calls onWake() on each. Survivors of a prior
   * crash get their event log cleaned up (placeholder agent.message +
   * tool_result events injected) and the row flips back to 'idle'.
   *
   * No automatic re-execution of the interrupted turn — the user gets
   * a clean state and can retry by sending a new user.message. Mirrors
   * what apps/main-node did inline before this refactor.
   */
  async bootstrap(): Promise<void> {
    const r = await this.deps.sql
      .prepare(
        `SELECT id, tenant_id FROM sessions WHERE status='running' AND turn_id IS NOT NULL`,
      )
      .all<{ id: string; tenant_id: string }>();
    const rows = r.results ?? [];
    if (rows.length === 0) return;
    log.info({ op: "session_registry.bootstrap", recovering: rows.length }, `bootstrap: recovering ${rows.length} interrupted session(s)`);
    for (const row of rows) {
      const entry = await this.getOrCreate(row.id, row.tenant_id);
      try {
        await entry.machine.onWake();
      } catch (err) {
        log.error(
          { err, op: "session_registry.bootstrap.on_wake_failed", session_id: row.id },
          `bootstrap onWake(${row.id}) failed`,
        );
      }
    }
  }

  /**
   * Tear down all in-process sessions on shutdown. Best-effort; the
   * sessions row stays as-is (status='idle' for normal exits, status=
   * 'running' for kill -9, which the next bootstrap will handle).
   */
  async shutdown(): Promise<void> {
    for (const p of this.map.values()) {
      try {
        const entry = await p;
        if (entry.sandbox.destroy) await entry.sandbox.destroy();
      } catch {
        /* best-effort */
      }
    }
    this.map.clear();
  }

  /**
   * Destroy one realized session sandbox and evict it from the in-process
   * cache. Used by DELETE /v1/sessions/:id. If the session was never
   * realized, there is no sandbox to tear down.
   */
  async destroy(sessionId: string): Promise<void> {
    const p = this.map.get(sessionId);
    if (!p) return;
    this.map.delete(sessionId);
    try {
      const entry = await p;
      if (entry.sandbox.destroy) await entry.sandbox.destroy();
    } catch (err) {
      log.warn(
        { err, op: "session_registry.destroy_failed", session_id: sessionId },
        "session sandbox destroy failed",
      );
    }
  }

  /**
   * Abort the in-flight harness for a session. Routed from
   * POST /v1/sessions/:id/events when the body contains a `user.interrupt`
   * event. No-op if the session has no machine yet (nothing to interrupt).
   * The machine's adapter handles emitting the session-side
   * agent.message_stream_end(status="aborted") event chain.
   */
  interrupt(sessionId: string): void {
    const p = this.map.get(sessionId);
    if (!p) return;
    p.then((entry) => {
      const m = entry.machine as unknown as {
        interrupt?: () => void;
        abortInFlight?: () => void;
      };
      if (typeof m.interrupt === "function") m.interrupt();
      else if (typeof m.abortInFlight === "function") m.abortInFlight();
      // If the machine doesn't expose either method, the user.interrupt
      // event is appended to the log by the route handler (P3 wires the
      // actual abort plumbing into SessionStateMachine).
    }).catch(() => {
      /* getOrCreate failed — nothing to abort */
    });
  }

  // ── helpers ─────────────────────────────────────────────────────────

  private async build(
    sessionId: string,
    tenantId: string,
  ): Promise<SessionEntry> {
    const sandboxWorkdir = join(this.deps.sandboxWorkdirRoot, sessionId);
    const sessionRuntime = await this.loadSessionRuntimeContext(sessionId, tenantId);
    const environment = sessionRuntime.environmentSnapshot;
    const sandbox = await this.deps.buildSandbox(sessionId, sandboxWorkdir, environment);

    try {
      // Resolve the per-session memory bindings + outputs flag, then hand
      // the whole bundle to the orchestrator. The orchestrator owns
      // ordering (vault outbound first, restore second, mounts last) so
      // the registry no longer reasons about it.
      const memoryBindings = await this.loadMemoryBindings(sessionId, tenantId, environment);
      const memoryMounts: OrchestratorMemoryMount[] = [];
      for (const binding of memoryBindings) {
        const store = await this.deps.memoryService.getStore({ tenantId, storeId: binding.store_id });
        if (!store) continue;
        memoryMounts.push({
          storeName: store.name,
          storeId: binding.store_id,
          readOnly: binding.access === "read_only",
        });
      }
      await this.deps.sandboxOrchestrator.provision(sandbox, {
        sessionId,
        tenantId,
        environmentId: sessionRuntime.environmentId ?? undefined,
        memoryMounts,
        mountOutputs: environmentMountsSessionOutputs(environment),
        backup: { restoreOnWarm: true },
      });

      const eventLog = this.deps.newEventLog(sessionId);
      const streams = new SqlStreamRepo(this.deps.sql, sessionId, this.deps.sqlDialect ?? "sqlite");

      const adapter = new RuntimeAdapterImpl({
        sql: this.deps.sql,
        eventLog,
        streams,
        sandbox,
        // Node has no eviction — leave hintTurnInFlight unset.
      });

      const machine = new SessionStateMachine({
        sessionId,
        tenantId,
        adapter,
        sandbox,
        loadAgent: async (agentId) => {
          const row = await this.deps.agentsService.get({ tenantId, agentId });
          return row ?? null;
        },
        // Memory + outputs mounting happens in the orchestrator above.
        // SessionStateMachine still accepts the hooks for CF parity but
        // Node passes no-ops since the work has already been done.
        mountMemoryStores: async () => {},
        mountSessionOutputs: async () => {},
        buildModel: (agent) => this.deps.buildModel(agent),
        buildTools: (agent, sb) => this.deps.buildTools(agent, sb, { tenantId, sessionId, environment }),
        buildHarness: () => this.deps.buildHarness(),
        buildHarnessContext: (input) =>
          this.deps.buildHarnessContext({
            ...input,
            tenantId,
            sessionId,
            eventLog,
          }),
        publish: (event: SessionEvent) => this.deps.hub.publish(sessionId, event),
      });

      return { machine, sandbox, eventLog };
    } catch (err) {
      try {
        if (sandbox.destroy) await sandbox.destroy();
      } catch (destroyErr) {
        log.warn(
          { err: destroyErr, op: "session_registry.build_cleanup_failed", session_id: sessionId },
          "failed to destroy sandbox after session build error",
        );
      }
      throw err;
    }
  }

  private async loadSessionRuntimeContext(
    sessionId: string,
    tenantId: string,
  ): Promise<{
    environmentId: string | null;
    environmentSnapshot: EnvironmentConfig | null;
  }> {
    const row = await this.deps.sql
      .prepare(
        `SELECT environment_id, environment_snapshot FROM sessions WHERE tenant_id = ? AND id = ?`,
      )
      .bind(tenantId, sessionId)
      .first<{ environment_id: string | null; environment_snapshot: string | null }>();
    return {
      environmentId: row?.environment_id ?? null,
      environmentSnapshot: parseEnvironmentSnapshot(row?.environment_snapshot),
    };
  }

  private async loadMemoryBindings(
    sessionId: string,
    tenantId: string,
    environment?: EnvironmentConfig | null,
  ): Promise<Array<{
    store_id: string;
    access: string;
    instructions?: string;
  }>> {
    const byStore = new Map<string, { store_id: string; access: string; instructions?: string }>();

    await this.addEnvironmentMemoryBindings(byStore, tenantId, environment);

    const legacyRows = await this.deps.sql
      .prepare(`SELECT store_id, access FROM session_memory_stores WHERE session_id = ?`)
      .bind(sessionId)
      .all<{ store_id: string; access: string }>();
    for (const row of legacyRows.results ?? []) {
      byStore.set(row.store_id, {
        store_id: row.store_id,
        access: row.access === "read_only" ? "read_only" : "read_write",
      });
    }

    if ((this.deps.sqlDialect ?? "sqlite") === "postgres") {
      const resourceRows = await this.deps.sql
        .prepare(
          `SELECT memory_store_id, access FROM session_resources
           WHERE session_id = ? AND type = 'memory_store'`,
        )
        .bind(sessionId)
        .all<{ memory_store_id: string | null; access: string | null }>();
      for (const row of resourceRows.results ?? []) {
        const storeId = row.memory_store_id ?? undefined;
        if (!storeId) continue;
        byStore.set(storeId, {
          store_id: storeId,
          access: row.access === "read_only" ? "read_only" : "read_write",
        });
      }
      return [...byStore.values()];
    }

    const resourceRows = await this.deps.sql
      .prepare(`SELECT config FROM session_resources WHERE session_id = ? AND type = 'memory_store'`)
      .bind(sessionId)
      .all<{ config: string }>();
    for (const row of resourceRows.results ?? []) {
      try {
        const resource = JSON.parse(row.config) as {
          memory_store_id?: string;
          store_id?: string;
          access?: string;
        };
        const storeId = resource.memory_store_id ?? resource.store_id;
        if (!storeId) continue;
        byStore.set(storeId, {
          store_id: storeId,
          access: resource.access === "read_only" ? "read_only" : "read_write",
        });
      } catch (err) {
        log.warn(
          { err, op: "session_registry.memory_resource_parse_failed", session_id: sessionId },
          "failed to parse session memory resource",
        );
      }
    }

    return [...byStore.values()];
  }

  private async addEnvironmentMemoryBindings(
    byStore: Map<string, { store_id: string; access: string; instructions?: string }>,
    tenantId: string,
    environment?: EnvironmentConfig | null,
  ): Promise<void> {
    const refs = environmentMemoryStoreRefs(environment);
    if (refs.length === 0) return;

    let storesByName: Map<string, string> | null = null;
    for (const ref of refs) {
      let storeId = ref.storeId;
      if (!storeId && ref.name) {
        storesByName ??= await this.loadMemoryStoresByName(tenantId);
        storeId = storesByName.get(ref.name);
      }
      if (!storeId) {
        log.warn(
          {
            op: "session_registry.environment_memory_unresolved",
            environment_id: environment?.id,
            store_name: ref.name,
          },
          "environment memory store could not be resolved",
        );
        continue;
      }
      byStore.set(storeId, {
        store_id: storeId,
        access: ref.access,
        ...(ref.instructions ? { instructions: ref.instructions } : {}),
      });
    }
  }

  private async loadMemoryStoresByName(tenantId: string): Promise<Map<string, string>> {
    const stores = await this.deps.memoryService.listStores({
      tenantId,
      status: "active",
    });
    return new Map(stores.map((store) => [store.name, store.id]));
  }
}

function parseEnvironmentSnapshot(value: string | null | undefined): EnvironmentConfig | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as EnvironmentConfig;
  } catch (err) {
    log.warn(
      { err, op: "session_registry.environment_snapshot_parse_failed" },
      "failed to parse environment snapshot",
    );
    return null;
  }
}
