// Agent-machine ports — provider-agnostic types for the per-agent
// persistent cloud computer ("agent machine": one sandbox per
// (tenant_id, agent_id), see the agent-machine design §0-§3).
//
// This file deliberately contains no Daytona / Node specifics:
//   - `AgentMachineStore` is the persistence port. The production
//     implementation is `NodeAgentMachineStore` (apps/main-node/src/lib/
//     agent-machine-store.ts, sqlite + postgres over SqlClient); the
//     `InMemoryAgentMachineStore` below is the reference implementation
//     used by packages/sandbox tests and as the semantic spec the SQL
//     store is held to (main-node runs the same contract suite over both).
//   - Lifecycle / lock / attachment semantics are documented on the port
//     so every implementation agrees on them:
//       * `insertIfAbsent` is the only way a row is born (state
//         `creating`, desired `running`, generation 1); a concurrent
//         insert for the same (tenant, agent) returns the winner's row
//         with `created:false`.
//       * `transition` is a compare-and-set on `state`.
//       * The lifecycle lock is a lease: `tryAcquireLock` succeeds when
//         the row is unlocked, the lease expired (`lock_expires_at < now`),
//         or the caller already owns it (re-entrant). `renewLock` /
//         `releaseLock` are guarded by owner.
//       * An attachment is "live" while `heartbeat_at > now - staleMs`
//         (default 90 s = 3 missed 30 s heartbeats).
//
// The root tsconfig type-checks this file with Cloudflare types only, so
// keep it free of Node globals.

import { generateAgentMachineEventId } from "@open-managed-agents/shared";

// ─── Types ──────────────────────────────────────────────────────────

export type AgentMachineState =
  | "creating"
  | "bootstrapping"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "archived"
  | "recreating"
  | "deleting"
  | "error";

export type AgentMachineDesiredState = "running" | "stopped";

export type AgentMachineSdkMode = "tools" | "tools_only" | "off";

/** Frozen per-machine configuration (persisted as `config_json`). */
export interface AgentMachineSpec {
  image: string;
  /** Named provider snapshot. When set, `image`/resources are not sent
   *  to the provider at create time (design §0 "Configuration"). */
  snapshot?: string | null;
  workdir: string;
  aptPackages: string[];
  bootstrapTools: boolean;
  browser: boolean;
  /** Daytona desktop; omitted on existing headless computers. */
  desktop?: boolean;
  idleStopMinutes: number;
  maxFileBytes?: number;
  sdkMode: AgentMachineSdkMode;
}

export interface AgentMachineRow {
  id: string;
  tenantId: string;
  agentId: string;
  provider: string;
  /** Provider-side sandbox id; `null` until `create()` returned. */
  providerRef: string | null;
  state: AgentMachineState;
  desiredState: AgentMachineDesiredState;
  /** Bumped together with `providerRef` whenever the box is recreated. */
  generation: number;
  image: string;
  snapshot: string | null;
  bootstrapHash: string | null;
  workdir: string;
  config: AgentMachineSpec;
  idleStopMinutes: number;
  browserEnabled: boolean;
  lockOwner: string | null;
  lockExpiresAt: number | null;
  lastActiveAt: number | null;
  lastStartedAt: number | null;
  lastStoppedAt: number | null;
  lastStateSyncAt: number | null;
  lastBackupAt: number | null;
  errorReason: string | null;
  errorCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface AgentMachineAttachment {
  sessionId: string;
  machineId: string;
  tenantId: string;
  workerId: string;
  generation: number;
  turnActive: boolean;
  bgProcesses: number;
  viewers: number;
  attachedAt: number;
  heartbeatAt: number;
}

export interface AgentMachineEvent {
  id: string;
  machineId: string;
  tenantId: string;
  kind: string;
  detail: unknown;
  sessionId: string | null;
  createdAt: number;
}

/** Columns `update()`/`transition()` may patch. `undefined` values are
 *  ignored (not written); `null` is written explicitly. */
export type AgentMachinePatch = Partial<
  Pick<
    AgentMachineRow,
    | "providerRef"
    | "state"
    | "desiredState"
    | "generation"
    | "image"
    | "snapshot"
    | "bootstrapHash"
    | "config"
    | "idleStopMinutes"
    | "browserEnabled"
    | "lastActiveAt"
    | "lastStartedAt"
    | "lastStoppedAt"
    | "lastStateSyncAt"
    | "lastBackupAt"
    | "errorReason"
    | "errorCount"
  >
>;

export interface AgentMachineInsertInput {
  id: string;
  tenantId: string;
  agentId: string;
  provider: string;
  spec: AgentMachineSpec;
  bootstrapHash: string;
  now: number;
}

export type AgentMachineAttachmentInput = Omit<
  AgentMachineAttachment,
  "attachedAt" | "heartbeatAt"
> & { now: number };

export type AgentMachineAttachmentFlags = Partial<{
  turnActive: boolean;
  bgProcesses: number;
  viewers: number;
}>;

export interface AgentMachineEventInput {
  machineId: string;
  tenantId: string;
  kind: string;
  detail?: unknown;
  sessionId?: string | null;
  now: number;
}

/** Attachments older than this (no heartbeat) are considered dead. */
export const DEFAULT_ATTACHMENT_STALE_MS = 90_000;

/** Default page size for `listEvents`. */
export const DEFAULT_EVENT_LIST_LIMIT = 100;

/** States that hold (or are in the middle of acquiring) a running
 *  provider box. `countRunning` counts these so the per-tenant cap is
 *  enforced against in-flight creates/starts too, not only settled
 *  `running` rows. */
export const RUNNING_LIKE_STATES: readonly AgentMachineState[] = [
  "creating",
  "bootstrapping",
  "starting",
  "running",
  "recreating",
];

// ─── Store port ─────────────────────────────────────────────────────

export interface AgentMachineStore {
  /** Idempotent DDL (CREATE TABLE IF NOT EXISTS …). */
  ensureSchema(): Promise<void>;

  get(tenantId: string, agentId: string): Promise<AgentMachineRow | null>;
  getById(id: string): Promise<AgentMachineRow | null>;
  /** All machines (optionally one tenant's), oldest first. */
  list(tenantId?: string): Promise<AgentMachineRow[]>;
  /** Machines in any of `states`, oldest first. Empty input ⇒ `[]`. */
  listByState(states: AgentMachineState[]): Promise<AgentMachineRow[]>;

  /** Create the (tenant, agent) row if none exists. Returns the row that
   *  ended up in the store and whether this call created it. */
  insertIfAbsent(input: AgentMachineInsertInput): Promise<{ row: AgentMachineRow; created: boolean }>;
  update(id: string, patch: AgentMachinePatch, now: number): Promise<void>;
  /** CAS on `state`: applies `to` + `patch` only when the current state
   *  is one of `expected`. Returns whether the row changed. */
  transition(
    id: string,
    expected: AgentMachineState | AgentMachineState[],
    to: AgentMachineState,
    patch?: AgentMachinePatch,
    now?: number,
  ): Promise<boolean>;

  tryAcquireLock(id: string, owner: string, ttlMs: number, now: number): Promise<boolean>;
  renewLock(id: string, owner: string, ttlMs: number, now: number): Promise<boolean>;
  releaseLock(id: string, owner: string): Promise<void>;

  /** Hard-delete the machine row and its attachments. Events are kept
   *  until `purgeEvents` retention removes them. */
  delete(id: string): Promise<void>;

  upsertAttachment(a: AgentMachineAttachmentInput): Promise<void>;
  heartbeat(sessionId: string, now: number): Promise<void>;
  setAttachmentFlags(sessionId: string, flags: AgentMachineAttachmentFlags, now: number): Promise<void>;
  detach(sessionId: string): Promise<void>;
  liveAttachments(machineId: string, now: number, staleMs?: number): Promise<AgentMachineAttachment[]>;
  /** Delete attachments whose heartbeat is stale; returns how many. */
  deleteStaleAttachments(now: number, staleMs: number): Promise<number>;

  /** Machines in `RUNNING_LIKE_STATES` for the tenant. */
  countRunning(tenantId: string): Promise<number>;

  addEvent(e: AgentMachineEventInput): Promise<void>;
  /** Newest first. */
  listEvents(machineId: string, limit?: number): Promise<AgentMachineEvent[]>;
  /** Delete events with `createdAt < olderThan`; returns how many. */
  purgeEvents(olderThan: number): Promise<number>;
}

// ─── Errors ─────────────────────────────────────────────────────────

export type MachineErrorCode = "machine_busy" | "machine_quota" | "machine_locked" | "machine_config_mismatch";

/** Base for typed machine errors — `code` maps 1:1 onto the API error
 *  strings (`409 machine_busy`, `session.error{error:"machine_quota"}`). */
export abstract class AgentMachineError extends Error {
  abstract readonly code: MachineErrorCode;
  constructor(message: string, readonly detail?: unknown) {
    super(message);
  }
}

/** A stop/reset was refused because a live attachment has an active turn
 *  or background processes. */
export class MachineBusyError extends AgentMachineError {
  readonly code = "machine_busy" as const;
  constructor(message = "agent machine is busy", detail?: unknown) {
    super(message, detail);
    this.name = "MachineBusyError";
  }
}

/** The tenant already has `MACHINE_MAX_RUNNING_PER_TENANT` running machines. */
export class MachineQuotaError extends AgentMachineError {
  readonly code = "machine_quota" as const;
  constructor(message = "agent machine quota reached", detail?: unknown) {
    super(message, detail);
    this.name = "MachineQuotaError";
  }
}

/** The lifecycle lock is held by another owner. */
export class MachineLockedError extends AgentMachineError {
  readonly code = "machine_locked" as const;
  constructor(message = "agent machine is locked by another operation", detail?: unknown) {
    super(message, detail);
    this.name = "MachineLockedError";
  }
}

export class MachineConfigMismatchError extends AgentMachineError {
  readonly code = "machine_config_mismatch" as const;
  constructor() {
    super("This agent's existing computer uses another configuration. Use its current environment configuration to preserve the computer and its files.");
    this.name = "MachineConfigMismatchError";
  }
}

export function isAgentMachineError(err: unknown): err is AgentMachineError {
  return err instanceof AgentMachineError;
}

// ─── Shared helpers ─────────────────────────────────────────────────

/** Initial row for `insertIfAbsent` — single source of truth for both
 *  the in-memory and SQL stores. */
export function newAgentMachineRow(input: AgentMachineInsertInput): AgentMachineRow {
  return {
    id: input.id,
    tenantId: input.tenantId,
    agentId: input.agentId,
    provider: input.provider,
    providerRef: null,
    state: "creating",
    desiredState: "running",
    generation: 1,
    image: input.spec.image,
    snapshot: input.spec.snapshot ?? null,
    bootstrapHash: input.bootstrapHash,
    workdir: input.spec.workdir,
    config: cloneSpec(input.spec),
    idleStopMinutes: input.spec.idleStopMinutes,
    browserEnabled: input.spec.browser,
    lockOwner: null,
    lockExpiresAt: null,
    lastActiveAt: null,
    lastStartedAt: null,
    lastStoppedAt: null,
    lastStateSyncAt: null,
    lastBackupAt: null,
    errorReason: null,
    errorCount: 0,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export function normalizeExpectedStates(
  expected: AgentMachineState | AgentMachineState[],
): AgentMachineState[] {
  return Array.isArray(expected) ? expected : [expected];
}

function cloneSpec(spec: AgentMachineSpec): AgentMachineSpec {
  return JSON.parse(JSON.stringify(spec)) as AgentMachineSpec;
}

function cloneRow(row: AgentMachineRow): AgentMachineRow {
  return { ...row, config: cloneSpec(row.config) };
}

function cloneEvent(e: AgentMachineEvent): AgentMachineEvent {
  return {
    ...e,
    detail: e.detail === undefined ? undefined : (JSON.parse(JSON.stringify(e.detail)) as unknown),
  };
}

// ─── In-memory reference implementation ─────────────────────────────

/**
 * Map-backed `AgentMachineStore`. Semantics mirror the SQL store exactly
 * (same CAS / lease / staleness rules); rows are copied on the way in and
 * out so callers cannot mutate store state by reference.
 */
export class InMemoryAgentMachineStore implements AgentMachineStore {
  private readonly machines = new Map<string, AgentMachineRow>();
  private readonly attachments = new Map<string, AgentMachineAttachment>();
  private readonly events: AgentMachineEvent[] = [];

  async ensureSchema(): Promise<void> {
    // nothing to do
  }

  async get(tenantId: string, agentId: string): Promise<AgentMachineRow | null> {
    for (const row of this.machines.values()) {
      if (row.tenantId === tenantId && row.agentId === agentId) return cloneRow(row);
    }
    return null;
  }

  async getById(id: string): Promise<AgentMachineRow | null> {
    const row = this.machines.get(id);
    return row ? cloneRow(row) : null;
  }

  async list(tenantId?: string): Promise<AgentMachineRow[]> {
    return this.sorted()
      .filter((r) => tenantId === undefined || r.tenantId === tenantId)
      .map(cloneRow);
  }

  async listByState(states: AgentMachineState[]): Promise<AgentMachineRow[]> {
    if (states.length === 0) return [];
    const set = new Set(states);
    return this.sorted()
      .filter((r) => set.has(r.state))
      .map(cloneRow);
  }

  async insertIfAbsent(
    input: AgentMachineInsertInput,
  ): Promise<{ row: AgentMachineRow; created: boolean }> {
    // No await between checking the unique key and inserting. Match the
    // atomic INSERT ... ON CONFLICT contract used by the SQL store.
    for (const existing of this.machines.values()) {
      if (existing.tenantId === input.tenantId && existing.agentId === input.agentId) {
        return { row: cloneRow(existing), created: false };
      }
    }
    if (this.machines.has(input.id)) {
      throw new Error(`agent machine id already exists: ${input.id}`);
    }
    const row = newAgentMachineRow(input);
    this.machines.set(row.id, row);
    return { row: cloneRow(row), created: true };
  }

  async update(id: string, patch: AgentMachinePatch, now: number): Promise<void> {
    const row = this.machines.get(id);
    if (!row) return;
    applyPatch(row, patch);
    row.updatedAt = now;
  }

  async transition(
    id: string,
    expected: AgentMachineState | AgentMachineState[],
    to: AgentMachineState,
    patch?: AgentMachinePatch,
    now: number = Date.now(),
  ): Promise<boolean> {
    const row = this.machines.get(id);
    if (!row) return false;
    if (!normalizeExpectedStates(expected).includes(row.state)) return false;
    if (patch) applyPatch(row, patch);
    row.state = to;
    row.updatedAt = now;
    return true;
  }

  async tryAcquireLock(id: string, owner: string, ttlMs: number, now: number): Promise<boolean> {
    const row = this.machines.get(id);
    if (!row) return false;
    const free =
      row.lockOwner === null ||
      row.lockExpiresAt === null ||
      row.lockExpiresAt < now ||
      row.lockOwner === owner;
    if (!free) return false;
    row.lockOwner = owner;
    row.lockExpiresAt = now + ttlMs;
    row.updatedAt = now;
    return true;
  }

  async renewLock(id: string, owner: string, ttlMs: number, now: number): Promise<boolean> {
    const row = this.machines.get(id);
    if (!row || row.lockOwner !== owner) return false;
    row.lockExpiresAt = now + ttlMs;
    row.updatedAt = now;
    return true;
  }

  async releaseLock(id: string, owner: string): Promise<void> {
    const row = this.machines.get(id);
    if (!row || row.lockOwner !== owner) return;
    row.lockOwner = null;
    row.lockExpiresAt = null;
  }

  async delete(id: string): Promise<void> {
    this.machines.delete(id);
    for (const [sid, a] of this.attachments) {
      if (a.machineId === id) this.attachments.delete(sid);
    }
  }

  async upsertAttachment(a: AgentMachineAttachmentInput): Promise<void> {
    const prev = this.attachments.get(a.sessionId);
    const attachedAt = prev && prev.machineId === a.machineId ? prev.attachedAt : a.now;
    this.attachments.set(a.sessionId, {
      sessionId: a.sessionId,
      machineId: a.machineId,
      tenantId: a.tenantId,
      workerId: a.workerId,
      generation: a.generation,
      turnActive: a.turnActive,
      bgProcesses: a.bgProcesses,
      viewers: a.viewers,
      attachedAt,
      heartbeatAt: a.now,
    });
  }

  async heartbeat(sessionId: string, now: number): Promise<void> {
    const a = this.attachments.get(sessionId);
    if (a) a.heartbeatAt = now;
  }

  async setAttachmentFlags(
    sessionId: string,
    flags: AgentMachineAttachmentFlags,
    now: number,
  ): Promise<void> {
    const a = this.attachments.get(sessionId);
    if (!a) return;
    if (flags.turnActive !== undefined) a.turnActive = flags.turnActive;
    if (flags.bgProcesses !== undefined) a.bgProcesses = flags.bgProcesses;
    if (flags.viewers !== undefined) a.viewers = flags.viewers;
    a.heartbeatAt = now;
  }

  async detach(sessionId: string): Promise<void> {
    this.attachments.delete(sessionId);
  }

  async liveAttachments(
    machineId: string,
    now: number,
    staleMs: number = DEFAULT_ATTACHMENT_STALE_MS,
  ): Promise<AgentMachineAttachment[]> {
    const cutoff = now - staleMs;
    return [...this.attachments.values()]
      .filter((a) => a.machineId === machineId && a.heartbeatAt > cutoff)
      .sort((x, y) => x.attachedAt - y.attachedAt || x.sessionId.localeCompare(y.sessionId))
      .map((a) => ({ ...a }));
  }

  async deleteStaleAttachments(now: number, staleMs: number): Promise<number> {
    const cutoff = now - staleMs;
    let n = 0;
    for (const [sid, a] of this.attachments) {
      if (a.heartbeatAt <= cutoff) {
        this.attachments.delete(sid);
        n++;
      }
    }
    return n;
  }

  async countRunning(tenantId: string): Promise<number> {
    let n = 0;
    for (const row of this.machines.values()) {
      if (row.tenantId === tenantId && RUNNING_LIKE_STATES.includes(row.state)) n++;
    }
    return n;
  }

  async addEvent(e: AgentMachineEventInput): Promise<void> {
    this.events.push({
      id: generateAgentMachineEventId(),
      machineId: e.machineId,
      tenantId: e.tenantId,
      kind: e.kind,
      detail: e.detail === undefined ? null : (JSON.parse(JSON.stringify(e.detail)) as unknown),
      sessionId: e.sessionId ?? null,
      createdAt: e.now,
    });
  }

  async listEvents(
    machineId: string,
    limit: number = DEFAULT_EVENT_LIST_LIMIT,
  ): Promise<AgentMachineEvent[]> {
    // Newest first; insertion order breaks ties (later insert = newer).
    return this.events
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e.machineId === machineId)
      .sort((x, y) => y.e.createdAt - x.e.createdAt || y.i - x.i)
      .slice(0, Math.max(0, limit))
      .map(({ e }) => cloneEvent(e));
  }

  async purgeEvents(olderThan: number): Promise<number> {
    const before = this.events.length;
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i].createdAt < olderThan) this.events.splice(i, 1);
    }
    return before - this.events.length;
  }

  private sorted(): AgentMachineRow[] {
    return [...this.machines.values()].sort(
      (x, y) => x.createdAt - y.createdAt || x.id.localeCompare(y.id),
    );
  }
}

function applyPatch(row: AgentMachineRow, patch: AgentMachinePatch): void {
  for (const key of Object.keys(patch) as Array<keyof AgentMachinePatch>) {
    const value = patch[key];
    if (value === undefined) continue;
    if (key === "config") {
      row.config = cloneSpec(value as AgentMachineSpec);
      continue;
    }
    (row as unknown as Record<string, unknown>)[key] = value;
  }
}
