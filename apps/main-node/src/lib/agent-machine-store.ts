// NodeAgentMachineStore — sqlite + postgres persistence for agent machines
// (per-agent persistent sandboxes), their session attachments and their
// lifecycle events. Implements the provider-agnostic `AgentMachineStore`
// port from `@open-managed-agents/sandbox/machines`.
//
// Pattern B, same as node-session-work-queue.ts / node-session-wakeups.ts:
// `ensureSchema()` owns its own DDL (CREATE … IF NOT EXISTS, no drizzle
// migration), `?` placeholders (the postgres SqlClient rewrites them to
// $n), ms-epoch integers (BIGINT on postgres, INTEGER on sqlite), 0/1
// booleans, JSON columns as TEXT.
//
// Concurrency primitives (design §0 "Concurrency", §2, §3):
//   - `insertIfAbsent`: unique (tenant_id, agent_id) + INSERT OR IGNORE /
//     ON CONFLICT DO NOTHING, then SELECT — two replicas racing to create
//     a machine for the same agent both end up with the same row.
//   - `transition`: UPDATE … WHERE id = ? AND state IN (…) — CAS on state.
//   - lifecycle lease: `tryAcquireLock` wins when the row is unlocked, the
//     lease expired, or the caller already holds it (re-entrant); renew /
//     release are guarded by owner.
//   - attachments: one row per session, liveness = heartbeat_at within
//     `staleMs` (90 s default; heartbeats every 30 s).
// All of these are single-statement so they are atomic on both engines
// without explicit transactions. `delete` uses `batch` (one transaction)
// to drop the row together with its attachments.

import type { SqlClient } from "@open-managed-agents/sql-client";
import { generateAgentMachineEventId } from "@open-managed-agents/shared";
import type {
  AgentMachineAttachment,
  AgentMachineAttachmentFlags,
  AgentMachineAttachmentInput,
  AgentMachineDesiredState,
  AgentMachineEvent,
  AgentMachineEventInput,
  AgentMachineInsertInput,
  AgentMachinePatch,
  AgentMachineRow,
  AgentMachineSpec,
  AgentMachineState,
  AgentMachineStore,
} from "@open-managed-agents/sandbox/machines";
import {
  DEFAULT_ATTACHMENT_STALE_MS,
  DEFAULT_EVENT_LIST_LIMIT,
  RUNNING_LIKE_STATES,
  newAgentMachineRow,
  normalizeExpectedStates,
} from "@open-managed-agents/sandbox/machines";

export interface NodeAgentMachineStoreDeps {
  sql: SqlClient;
  dialect: "sqlite" | "postgres";
}

export class NodeAgentMachineStore implements AgentMachineStore {
  private readonly sql: SqlClient;
  private readonly dialect: "sqlite" | "postgres";

  constructor(deps: NodeAgentMachineStoreDeps) {
    this.sql = deps.sql;
    this.dialect = deps.dialect;
  }

  // ─── Schema ───────────────────────────────────────────────────────

  async ensureSchema(): Promise<void> {
    const int = this.dialect === "postgres" ? "BIGINT" : "INTEGER";
    await this.sql.exec(`
      CREATE TABLE IF NOT EXISTS agent_machines (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        provider_ref TEXT,
        state TEXT NOT NULL,
        desired_state TEXT NOT NULL,
        generation INTEGER NOT NULL DEFAULT 1,
        image TEXT NOT NULL,
        snapshot TEXT,
        bootstrap_hash TEXT,
        workdir TEXT NOT NULL,
        config_json TEXT NOT NULL,
        idle_stop_minutes INTEGER NOT NULL,
        browser_enabled INTEGER NOT NULL DEFAULT 1,
        lock_owner TEXT,
        lock_expires_at ${int},
        last_active_at ${int},
        last_started_at ${int},
        last_stopped_at ${int},
        last_state_sync_at ${int},
        last_backup_at ${int},
        error_reason TEXT,
        error_count INTEGER NOT NULL DEFAULT 0,
        created_at ${int} NOT NULL,
        updated_at ${int} NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_machines_tenant_agent
        ON agent_machines (tenant_id, agent_id);
      CREATE INDEX IF NOT EXISTS idx_agent_machines_state
        ON agent_machines (state, last_state_sync_at);

      CREATE TABLE IF NOT EXISTS agent_machine_sessions (
        session_id TEXT PRIMARY KEY,
        machine_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        worker_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        turn_active INTEGER NOT NULL DEFAULT 0,
        bg_processes INTEGER NOT NULL DEFAULT 0,
        viewers INTEGER NOT NULL DEFAULT 0,
        attached_at ${int} NOT NULL,
        heartbeat_at ${int} NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_machine_sessions_machine
        ON agent_machine_sessions (machine_id, heartbeat_at);

      CREATE TABLE IF NOT EXISTS agent_machine_events (
        id TEXT PRIMARY KEY,
        machine_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        detail_json TEXT,
        session_id TEXT,
        created_at ${int} NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_machine_events_machine
        ON agent_machine_events (machine_id, created_at);
    `);
  }

  // ─── Machines: read ───────────────────────────────────────────────

  async get(tenantId: string, agentId: string): Promise<AgentMachineRow | null> {
    const row = await this.sql
      .prepare(`SELECT ${MACHINE_COLUMNS} FROM agent_machines WHERE tenant_id = ? AND agent_id = ?`)
      .bind(tenantId, agentId)
      .first<MachineDbRow>();
    return row ? toMachineRow(row) : null;
  }

  async getById(id: string): Promise<AgentMachineRow | null> {
    const row = await this.sql
      .prepare(`SELECT ${MACHINE_COLUMNS} FROM agent_machines WHERE id = ?`)
      .bind(id)
      .first<MachineDbRow>();
    return row ? toMachineRow(row) : null;
  }

  async list(tenantId?: string): Promise<AgentMachineRow[]> {
    const stmt =
      tenantId === undefined
        ? this.sql.prepare(
            `SELECT ${MACHINE_COLUMNS} FROM agent_machines ORDER BY created_at ASC, id ASC`,
          )
        : this.sql
            .prepare(
              `SELECT ${MACHINE_COLUMNS} FROM agent_machines WHERE tenant_id = ? ORDER BY created_at ASC, id ASC`,
            )
            .bind(tenantId);
    const res = await stmt.all<MachineDbRow>();
    return (res.results ?? []).map(toMachineRow);
  }

  async listByState(states: AgentMachineState[]): Promise<AgentMachineRow[]> {
    if (states.length === 0) return [];
    const res = await this.sql
      .prepare(
        `SELECT ${MACHINE_COLUMNS} FROM agent_machines
         WHERE state IN (${placeholders(states.length)})
         ORDER BY created_at ASC, id ASC`,
      )
      .bind(...states)
      .all<MachineDbRow>();
    return (res.results ?? []).map(toMachineRow);
  }

  // ─── Machines: write ──────────────────────────────────────────────

  async insertIfAbsent(
    input: AgentMachineInsertInput,
  ): Promise<{ row: AgentMachineRow; created: boolean }> {
    const row = newAgentMachineRow(input);
    const columns = `(id, tenant_id, agent_id, provider, provider_ref, state, desired_state, generation,
        image, snapshot, bootstrap_hash, workdir, config_json, idle_stop_minutes, browser_enabled,
        error_count, created_at, updated_at)`;
    const values = `VALUES (${placeholders(18)})`;
    const params = [
      row.id,
      row.tenantId,
      row.agentId,
      row.provider,
      row.providerRef,
      row.state,
      row.desiredState,
      row.generation,
      row.image,
      row.snapshot,
      row.bootstrapHash,
      row.workdir,
      JSON.stringify(row.config),
      row.idleStopMinutes,
      row.browserEnabled ? 1 : 0,
      row.errorCount,
      row.createdAt,
      row.updatedAt,
    ];

    const result =
      this.dialect === "postgres"
        ? await this.sql
            .prepare(
              `INSERT INTO agent_machines ${columns} ${values}
               ON CONFLICT (tenant_id, agent_id) DO NOTHING`,
            )
            .bind(...params)
            .run()
        : await this.sql
            .prepare(`INSERT OR IGNORE INTO agent_machines ${columns} ${values}`)
            .bind(...params)
            .run();
    const created = (result.meta.changes ?? 0) === 1;

    const stored = await this.get(input.tenantId, input.agentId);
    if (!stored) {
      // Only reachable when the insert was ignored for a reason other than
      // the (tenant, agent) uniqueness (e.g. a colliding primary key) or
      // the winning row was deleted between INSERT and SELECT.
      throw new Error(
        `agent machine insert for ${input.tenantId}/${input.agentId} was ignored but no row exists`,
      );
    }
    return { row: stored, created };
  }

  async update(id: string, patch: AgentMachinePatch, now: number): Promise<void> {
    const { sets, params } = patchAssignments(patch);
    await this.sql
      .prepare(
        `UPDATE agent_machines SET ${[...sets, "updated_at = ?"].join(", ")} WHERE id = ?`,
      )
      .bind(...params, now, id)
      .run();
  }

  async transition(
    id: string,
    expected: AgentMachineState | AgentMachineState[],
    to: AgentMachineState,
    patch?: AgentMachinePatch,
    now: number = Date.now(),
  ): Promise<boolean> {
    const states = normalizeExpectedStates(expected);
    if (states.length === 0) return false;
    // `to` is authoritative — a `state` key inside the patch would be a
    // duplicate assignment (postgres rejects those).
    const { state: _ignored, ...rest } = patch ?? {};
    void _ignored;
    const { sets, params } = patchAssignments(rest);
    const result = await this.sql
      .prepare(
        `UPDATE agent_machines
         SET ${["state = ?", ...sets, "updated_at = ?"].join(", ")}
         WHERE id = ? AND state IN (${placeholders(states.length)})`,
      )
      .bind(to, ...params, now, id, ...states)
      .run();
    return (result.meta.changes ?? 0) === 1;
  }

  // ─── Lifecycle lease ──────────────────────────────────────────────

  async tryAcquireLock(id: string, owner: string, ttlMs: number, now: number): Promise<boolean> {
    const result = await this.sql
      .prepare(
        `UPDATE agent_machines
         SET lock_owner = ?, lock_expires_at = ?, updated_at = ?
         WHERE id = ?
           AND (lock_owner IS NULL OR lock_expires_at IS NULL OR lock_expires_at < ? OR lock_owner = ?)`,
      )
      .bind(owner, now + ttlMs, now, id, now, owner)
      .run();
    return (result.meta.changes ?? 0) === 1;
  }

  async renewLock(id: string, owner: string, ttlMs: number, now: number): Promise<boolean> {
    const result = await this.sql
      .prepare(
        `UPDATE agent_machines SET lock_expires_at = ?, updated_at = ?
         WHERE id = ? AND lock_owner = ?`,
      )
      .bind(now + ttlMs, now, id, owner)
      .run();
    return (result.meta.changes ?? 0) === 1;
  }

  async releaseLock(id: string, owner: string): Promise<void> {
    await this.sql
      .prepare(
        `UPDATE agent_machines SET lock_owner = NULL, lock_expires_at = NULL
         WHERE id = ? AND lock_owner = ?`,
      )
      .bind(id, owner)
      .run();
  }

  async delete(id: string): Promise<void> {
    await this.sql.batch([
      this.sql.prepare(`DELETE FROM agent_machine_sessions WHERE machine_id = ?`).bind(id),
      this.sql.prepare(`DELETE FROM agent_machines WHERE id = ?`).bind(id),
    ]);
  }

  // ─── Attachments ──────────────────────────────────────────────────

  async upsertAttachment(a: AgentMachineAttachmentInput): Promise<void> {
    // `attached_at` survives a re-upsert for the same machine (heartbeat /
    // worker / generation refresh); it resets when the session moves to a
    // different machine row (after a reset).
    await this.sql
      .prepare(
        `INSERT INTO agent_machine_sessions
           (session_id, machine_id, tenant_id, worker_id, generation, turn_active, bg_processes, viewers, attached_at, heartbeat_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (session_id) DO UPDATE SET
           machine_id = excluded.machine_id,
           tenant_id = excluded.tenant_id,
           worker_id = excluded.worker_id,
           generation = excluded.generation,
           turn_active = excluded.turn_active,
           bg_processes = excluded.bg_processes,
           viewers = excluded.viewers,
           attached_at = CASE
             WHEN agent_machine_sessions.machine_id = excluded.machine_id THEN agent_machine_sessions.attached_at
             ELSE excluded.attached_at
           END,
           heartbeat_at = excluded.heartbeat_at`,
      )
      .bind(
        a.sessionId,
        a.machineId,
        a.tenantId,
        a.workerId,
        a.generation,
        a.turnActive ? 1 : 0,
        a.bgProcesses,
        a.viewers,
        a.now,
        a.now,
      )
      .run();
  }

  async heartbeat(sessionId: string, now: number): Promise<void> {
    await this.sql
      .prepare(`UPDATE agent_machine_sessions SET heartbeat_at = ? WHERE session_id = ?`)
      .bind(now, sessionId)
      .run();
  }

  async setAttachmentFlags(
    sessionId: string,
    flags: AgentMachineAttachmentFlags,
    now: number,
  ): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (flags.turnActive !== undefined) {
      sets.push("turn_active = ?");
      params.push(flags.turnActive ? 1 : 0);
    }
    if (flags.bgProcesses !== undefined) {
      sets.push("bg_processes = ?");
      params.push(flags.bgProcesses);
    }
    if (flags.viewers !== undefined) {
      sets.push("viewers = ?");
      params.push(flags.viewers);
    }
    // A flag change is also a liveness signal.
    sets.push("heartbeat_at = ?");
    params.push(now);
    await this.sql
      .prepare(`UPDATE agent_machine_sessions SET ${sets.join(", ")} WHERE session_id = ?`)
      .bind(...params, sessionId)
      .run();
  }

  async detach(sessionId: string): Promise<void> {
    await this.sql
      .prepare(`DELETE FROM agent_machine_sessions WHERE session_id = ?`)
      .bind(sessionId)
      .run();
  }

  async liveAttachments(
    machineId: string,
    now: number,
    staleMs: number = DEFAULT_ATTACHMENT_STALE_MS,
  ): Promise<AgentMachineAttachment[]> {
    const res = await this.sql
      .prepare(
        `SELECT ${ATTACHMENT_COLUMNS} FROM agent_machine_sessions
         WHERE machine_id = ? AND heartbeat_at > ?
         ORDER BY attached_at ASC, session_id ASC`,
      )
      .bind(machineId, now - staleMs)
      .all<AttachmentDbRow>();
    return (res.results ?? []).map(toAttachment);
  }

  async deleteStaleAttachments(now: number, staleMs: number): Promise<number> {
    const result = await this.sql
      .prepare(`DELETE FROM agent_machine_sessions WHERE heartbeat_at <= ?`)
      .bind(now - staleMs)
      .run();
    return result.meta.changes ?? 0;
  }

  // ─── Caps ─────────────────────────────────────────────────────────

  async countRunning(tenantId: string): Promise<number> {
    const row = await this.sql
      .prepare(
        `SELECT COUNT(*) AS n FROM agent_machines
         WHERE tenant_id = ? AND state IN (${placeholders(RUNNING_LIKE_STATES.length)})`,
      )
      .bind(tenantId, ...RUNNING_LIKE_STATES)
      .first<{ n: number | string | null }>();
    return Number(row?.n ?? 0);
  }

  // ─── Events ───────────────────────────────────────────────────────

  async addEvent(e: AgentMachineEventInput): Promise<void> {
    await this.sql
      .prepare(
        `INSERT INTO agent_machine_events (id, machine_id, tenant_id, kind, detail_json, session_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        generateAgentMachineEventId(),
        e.machineId,
        e.tenantId,
        e.kind,
        e.detail === undefined ? null : JSON.stringify(e.detail),
        e.sessionId ?? null,
        e.now,
      )
      .run();
  }

  async listEvents(
    machineId: string,
    limit: number = DEFAULT_EVENT_LIST_LIMIT,
  ): Promise<AgentMachineEvent[]> {
    const n = Math.max(0, Math.floor(limit));
    if (n === 0) return [];
    const res = await this.sql
      .prepare(
        `SELECT id, machine_id, tenant_id, kind, detail_json, session_id, created_at
         FROM agent_machine_events
         WHERE machine_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .bind(machineId, n)
      .all<EventDbRow>();
    return (res.results ?? []).map(toEvent);
  }

  async purgeEvents(olderThan: number): Promise<number> {
    const result = await this.sql
      .prepare(`DELETE FROM agent_machine_events WHERE created_at < ?`)
      .bind(olderThan)
      .run();
    return result.meta.changes ?? 0;
  }
}

// ─── Row mapping ────────────────────────────────────────────────────

const MACHINE_COLUMNS = `id, tenant_id, agent_id, provider, provider_ref, state, desired_state, generation,
  image, snapshot, bootstrap_hash, workdir, config_json, idle_stop_minutes, browser_enabled,
  lock_owner, lock_expires_at, last_active_at, last_started_at, last_stopped_at, last_state_sync_at,
  last_backup_at, error_reason, error_count, created_at, updated_at`;

const ATTACHMENT_COLUMNS = `session_id, machine_id, tenant_id, worker_id, generation, turn_active,
  bg_processes, viewers, attached_at, heartbeat_at`;

interface MachineDbRow {
  id: string;
  tenant_id: string;
  agent_id: string;
  provider: string;
  provider_ref: string | null;
  state: string;
  desired_state: string;
  generation: number | string;
  image: string;
  snapshot: string | null;
  bootstrap_hash: string | null;
  workdir: string;
  config_json: string;
  idle_stop_minutes: number | string;
  browser_enabled: number | string;
  lock_owner: string | null;
  lock_expires_at: number | string | null;
  last_active_at: number | string | null;
  last_started_at: number | string | null;
  last_stopped_at: number | string | null;
  last_state_sync_at: number | string | null;
  last_backup_at: number | string | null;
  error_reason: string | null;
  error_count: number | string | null;
  created_at: number | string;
  updated_at: number | string;
}

interface AttachmentDbRow {
  session_id: string;
  machine_id: string;
  tenant_id: string;
  worker_id: string;
  generation: number | string;
  turn_active: number | string;
  bg_processes: number | string;
  viewers: number | string;
  attached_at: number | string;
  heartbeat_at: number | string;
}

interface EventDbRow {
  id: string;
  machine_id: string;
  tenant_id: string;
  kind: string;
  detail_json: string | null;
  session_id: string | null;
  created_at: number | string;
}

// The postgres SqlClient coerces BIGINT to number already; Number() here
// keeps the mapping correct for INTEGER columns and for any driver that
// hands back strings.
function optNum(v: number | string | null | undefined): number | null {
  return v === null || v === undefined ? null : Number(v);
}

function toMachineRow(r: MachineDbRow): AgentMachineRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    agentId: r.agent_id,
    provider: r.provider,
    providerRef: r.provider_ref ?? null,
    state: r.state as AgentMachineState,
    desiredState: r.desired_state as AgentMachineDesiredState,
    generation: Number(r.generation),
    image: r.image,
    snapshot: r.snapshot ?? null,
    bootstrapHash: r.bootstrap_hash ?? null,
    workdir: r.workdir,
    config: parseSpec(r.config_json, r.id),
    idleStopMinutes: Number(r.idle_stop_minutes),
    browserEnabled: Number(r.browser_enabled) === 1,
    lockOwner: r.lock_owner ?? null,
    lockExpiresAt: optNum(r.lock_expires_at),
    lastActiveAt: optNum(r.last_active_at),
    lastStartedAt: optNum(r.last_started_at),
    lastStoppedAt: optNum(r.last_stopped_at),
    lastStateSyncAt: optNum(r.last_state_sync_at),
    lastBackupAt: optNum(r.last_backup_at),
    errorReason: r.error_reason ?? null,
    errorCount: Number(r.error_count ?? 0),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function parseSpec(json: string, machineId: string): AgentMachineSpec {
  try {
    return JSON.parse(json) as AgentMachineSpec;
  } catch (err) {
    throw new Error(
      `agent_machines.config_json for ${machineId} is not valid JSON: ${String(err)}`,
    );
  }
}

function toAttachment(r: AttachmentDbRow): AgentMachineAttachment {
  return {
    sessionId: r.session_id,
    machineId: r.machine_id,
    tenantId: r.tenant_id,
    workerId: r.worker_id,
    generation: Number(r.generation),
    turnActive: Number(r.turn_active) === 1,
    bgProcesses: Number(r.bg_processes),
    viewers: Number(r.viewers),
    attachedAt: Number(r.attached_at),
    heartbeatAt: Number(r.heartbeat_at),
  };
}

function toEvent(r: EventDbRow): AgentMachineEvent {
  return {
    id: r.id,
    machineId: r.machine_id,
    tenantId: r.tenant_id,
    kind: r.kind,
    detail: r.detail_json === null ? null : (JSON.parse(r.detail_json) as unknown),
    sessionId: r.session_id ?? null,
    createdAt: Number(r.created_at),
  };
}

// ─── SQL helpers ────────────────────────────────────────────────────

const PATCH_COLUMNS: Record<keyof AgentMachinePatch, string> = {
  providerRef: "provider_ref",
  state: "state",
  desiredState: "desired_state",
  generation: "generation",
  image: "image",
  snapshot: "snapshot",
  bootstrapHash: "bootstrap_hash",
  config: "config_json",
  idleStopMinutes: "idle_stop_minutes",
  browserEnabled: "browser_enabled",
  lastActiveAt: "last_active_at",
  lastStartedAt: "last_started_at",
  lastStoppedAt: "last_stopped_at",
  lastStateSyncAt: "last_state_sync_at",
  lastBackupAt: "last_backup_at",
  errorReason: "error_reason",
  errorCount: "error_count",
};

/** Turn a patch into `col = ?` fragments + bound params. `undefined`
 *  values are skipped (not written); `null` is bound explicitly. Unknown
 *  keys are ignored so a wider object cannot inject column names. */
function patchAssignments(patch: AgentMachinePatch): { sets: string[]; params: unknown[] } {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const key of Object.keys(patch) as Array<keyof AgentMachinePatch>) {
    const value = patch[key];
    if (value === undefined) continue;
    const column = PATCH_COLUMNS[key];
    if (!column) continue;
    sets.push(`${column} = ?`);
    if (key === "config") params.push(JSON.stringify(value));
    else if (key === "browserEnabled") params.push(value ? 1 : 0);
    else params.push(value);
  }
  return { sets, params };
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(", ");
}
