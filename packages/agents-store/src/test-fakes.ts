// In-memory implementations of every port for unit tests. Mirrors the
// cascade-on-delete behavior + history-snapshot atomicity of the D1 adapter
// so tests catch the same integrity violations.

import type { AgentConfig } from "@open-managed-agents/shared";
import { AgentNotFoundError } from "./errors";
import type {
  AgentRepo,
  AgentUpdateFields,
  AgentVersionSnapshotInput,
  Clock,
  IdGenerator,
  Logger,
  NewAgentInput,
} from "./ports";
import type {
  AmbientRuleClock,
  AmbientRuleIdGenerator,
  AmbientRuleRepo,
  AmbientRuleUpdateFields,
  NewAmbientRuleInput,
} from "./ambient-ports";
import type { AmbientRuleRow } from "./ambient-types";
import { AmbientRuleService } from "./ambient-service";
import { AgentService } from "./service";
import type { AgentRow, AgentVersionRow } from "./types";

interface InMemAgent {
  id: string;
  tenant_id: string;
  config: AgentConfig;
  version: number;
  created_at: number;
  updated_at: number | null;
  archived_at: number | null;
}

interface InMemVersion {
  agent_id: string;
  tenant_id: string;
  version: number;
  snapshot: AgentConfig;
  created_at: number;
}

export class InMemoryAgentRepo implements AgentRepo {
  private readonly byId = new Map<string, InMemAgent>();
  /** Keyed by `${agentId}:v${version}` for O(1) lookup + cascade delete. */
  private readonly versionsByKey = new Map<string, InMemVersion>();

  async insert(input: NewAgentInput): Promise<AgentRow> {
    const row: InMemAgent = {
      id: input.id,
      tenant_id: input.tenantId,
      config: input.config,
      version: input.config.version,
      created_at: input.createdAt,
      updated_at: input.createdAt,
      archived_at: null,
    };
    this.byId.set(input.id, row);
    return toRow(row);
  }

  async get(tenantId: string, agentId: string): Promise<AgentRow | null> {
    const row = this.byId.get(agentId);
    if (!row || row.tenant_id !== tenantId) return null;
    return toRow(row);
  }

  async getById(agentId: string): Promise<AgentRow | null> {
    const row = this.byId.get(agentId);
    return row ? toRow(row) : null;
  }

  async list(
    tenantId: string,
    opts: { includeArchived: boolean },
  ): Promise<AgentRow[]> {
    return Array.from(this.byId.values())
      .filter((r) => r.tenant_id === tenantId)
      .filter((r) => opts.includeArchived || r.archived_at === null)
      .sort((a, b) => a.created_at - b.created_at)
      .map(toRow);
  }

  async listPage(
    tenantId: string,
    opts: {
      status?: "active" | "archived" | "any";
      createdAfter?: number;
      createdBefore?: number;
      limit: number;
      after?: import("@open-managed-agents/shared").PageCursor;
      q?: string;
    },
  ): Promise<{ items: AgentRow[]; hasMore: boolean }> {
    const qLower = opts.q?.toLowerCase();
    let rows = Array.from(this.byId.values())
      .filter((r) => r.tenant_id === tenantId)
      .filter((r) => {
        if (opts.status === "active") return r.archived_at === null;
        if (opts.status === "archived") return r.archived_at !== null;
        return true;
      })
      .filter((r) =>
        opts.createdAfter === undefined ? true : r.created_at >= opts.createdAfter,
      )
      .filter((r) =>
        opts.createdBefore === undefined ? true : r.created_at < opts.createdBefore,
      )
      .filter((r) =>
        qLower ? (r.config.name ?? "").toLowerCase().includes(qLower) : true,
      )
      // Mirror the D1 query order: created_at DESC, id DESC.
      .sort((a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id));
    if (opts.after) {
      const { createdAt: t, id } = opts.after;
      rows = rows.filter(
        (r) => r.created_at < t || (r.created_at === t && r.id < id),
      );
    }
    const hasMore = rows.length > opts.limit;
    return {
      items: (hasMore ? rows.slice(0, opts.limit) : rows).map(toRow),
      hasMore,
    };
  }

  async count(
    tenantId: string,
    opts: { includeArchived: boolean },
  ): Promise<number> {
    return Array.from(this.byId.values())
      .filter((r) => r.tenant_id === tenantId)
      .filter((r) => opts.includeArchived || r.archived_at === null)
      .length;
  }

  async updateWithVersionSnapshot(
    tenantId: string,
    agentId: string,
    update: AgentUpdateFields,
    priorSnapshot: AgentVersionSnapshotInput,
  ): Promise<AgentRow> {
    const row = this.byId.get(agentId);
    if (!row || row.tenant_id !== tenantId) throw new AgentNotFoundError();
    // Atomic: write the prior snapshot to history, then bump the current row.
    const versionKey = `${priorSnapshot.agentId}:v${priorSnapshot.version}`;
    this.versionsByKey.set(versionKey, {
      agent_id: priorSnapshot.agentId,
      tenant_id: priorSnapshot.tenantId,
      version: priorSnapshot.version,
      snapshot: priorSnapshot.snapshot,
      created_at: priorSnapshot.createdAt,
    });
    row.config = update.config;
    row.version = update.version;
    row.updated_at = update.updatedAt;
    return toRow(row);
  }

  async archive(
    tenantId: string,
    agentId: string,
    archivedAt: number,
  ): Promise<AgentRow> {
    const row = this.byId.get(agentId);
    if (!row || row.tenant_id !== tenantId) throw new AgentNotFoundError();
    row.archived_at = archivedAt;
    row.updated_at = archivedAt;
    // Mirror archived_at into the embedded config so consumers reading from
    // either the row or the JSON see a consistent value.
    row.config = { ...row.config, archived_at: msToIso(archivedAt) };
    return toRow(row);
  }

  async deleteWithVersions(tenantId: string, agentId: string): Promise<void> {
    const row = this.byId.get(agentId);
    if (!row || row.tenant_id !== tenantId) return;
    this.byId.delete(agentId);
    for (const [key, ver] of this.versionsByKey.entries()) {
      if (ver.agent_id === agentId) this.versionsByKey.delete(key);
    }
  }

  async listVersions(
    tenantId: string,
    agentId: string,
  ): Promise<AgentVersionRow[]> {
    return Array.from(this.versionsByKey.values())
      .filter((v) => v.agent_id === agentId && v.tenant_id === tenantId)
      .sort((a, b) => a.version - b.version)
      .map(toVersionRow);
  }

  async getVersion(
    tenantId: string,
    agentId: string,
    version: number,
  ): Promise<AgentVersionRow | null> {
    const row = this.versionsByKey.get(`${agentId}:v${version}`);
    if (!row || row.tenant_id !== tenantId) return null;
    return toVersionRow(row);
  }
}

interface InMemAmbientRule {
  id: string;
  tenant_id: string;
  agent_id: string;
  config: Omit<AmbientRuleRow, "tenant_id">;
  enabled: number;
  trigger_source: string;
  wake_mode: string;
  created_at: number;
  updated_at: number | null;
  next_wake_at: number | null;
  last_wake_at: number | null;
  deleted_at: number | null;
}

export class InMemoryAmbientRuleRepo implements AmbientRuleRepo {
  private readonly byId = new Map<string, InMemAmbientRule>();

  async insert(input: NewAmbientRuleInput): Promise<AmbientRuleRow> {
    const row: InMemAmbientRule = {
      id: input.id,
      tenant_id: input.tenantId,
      agent_id: input.agentId,
      config: input.config,
      enabled: input.config.enabled ? 1 : 0,
      trigger_source: input.config.trigger.source,
      wake_mode: input.config.wake_mode,
      created_at: input.createdAt,
      updated_at: input.createdAt,
      next_wake_at: input.config.next_wake_at
        ? Date.parse(input.config.next_wake_at)
        : null,
      last_wake_at: input.config.last_wake_at
        ? Date.parse(input.config.last_wake_at)
        : null,
      deleted_at: null,
    };
    this.byId.set(input.id, row);
    return toAmbientRow(row);
  }

  async get(
    tenantId: string,
    agentId: string,
    ruleId: string,
  ): Promise<AmbientRuleRow | null> {
    const row = this.byId.get(ruleId);
    if (!row || row.tenant_id !== tenantId || row.agent_id !== agentId) return null;
    if (row.deleted_at !== null) return null;
    return toAmbientRow(row);
  }

  async listByAgent(
    tenantId: string,
    agentId: string,
  ): Promise<AmbientRuleRow[]> {
    return Array.from(this.byId.values())
      .filter((r) => r.tenant_id === tenantId)
      .filter((r) => r.agent_id === agentId)
      .filter((r) => r.deleted_at === null)
      .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id))
      .map(toAmbientRow);
  }

  async listDue(opts: {
    tenantId?: string;
    now: number;
    limit: number;
  }): Promise<AmbientRuleRow[]> {
    return Array.from(this.byId.values())
      .filter((r) => (opts.tenantId ? r.tenant_id === opts.tenantId : true))
      .filter((r) => r.enabled === 1)
      .filter((r) => r.deleted_at === null)
      .filter((r) => r.next_wake_at !== null && r.next_wake_at <= opts.now)
      .sort((a, b) => (a.next_wake_at ?? 0) - (b.next_wake_at ?? 0) || a.id.localeCompare(b.id))
      .slice(0, opts.limit)
      .map(toAmbientRow);
  }

  async update(
    tenantId: string,
    agentId: string,
    ruleId: string,
    fields: AmbientRuleUpdateFields,
  ): Promise<AmbientRuleRow> {
    const row = this.byId.get(ruleId);
    if (!row || row.tenant_id !== tenantId || row.agent_id !== agentId || row.deleted_at !== null) {
      throw new Error("Ambient rule not found");
    }
    row.config = fields.config;
    row.enabled = fields.enabled ? 1 : 0;
    row.trigger_source = fields.triggerSource;
    row.wake_mode = fields.wakeMode;
    row.updated_at = fields.updatedAt;
    row.next_wake_at = fields.nextWakeAt ?? null;
    row.last_wake_at = fields.lastWakeAt ?? null;
    return toAmbientRow(row);
  }

  async softDelete(
    tenantId: string,
    agentId: string,
    ruleId: string,
    deletedAt: number,
  ): Promise<void> {
    const row = this.byId.get(ruleId);
    if (!row || row.tenant_id !== tenantId || row.agent_id !== agentId) return;
    row.enabled = 0;
    row.deleted_at = deletedAt;
    row.updated_at = deletedAt;
  }
}

export class SequentialIdGenerator implements IdGenerator {
  private n = 0;
  agentId(): string {
    return `agent-${++this.n}`;
  }
}

export class SequentialAmbientRuleIdGenerator implements AmbientRuleIdGenerator {
  private n = 0;
  ambientRuleId(): string {
    return `ambrule-${++this.n}`;
  }
}

export class ManualClock implements Clock {
  constructor(private ms: number = 0) {}
  nowMs(): number {
    return this.ms;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
  set(ms: number): void {
    this.ms = ms;
  }
}

export class SilentLogger implements Logger {
  warn(): void {}
}

/**
 * Convenience factory — full in-memory wiring with sane defaults. Tests can
 * pass overrides for any port (e.g. a ManualClock for deterministic timestamps).
 */
export function createInMemoryAgentService(opts?: {
  clock?: Clock;
  ids?: IdGenerator;
  logger?: Logger;
}): {
  service: AgentService;
  repo: InMemoryAgentRepo;
} {
  const repo = new InMemoryAgentRepo();
  const service = new AgentService({
    repo,
    clock: opts?.clock,
    ids: opts?.ids ?? new SequentialIdGenerator(),
    logger: opts?.logger ?? new SilentLogger(),
  });
  return { service, repo };
}

export function createInMemoryAmbientRuleService(opts?: {
  clock?: AmbientRuleClock;
  ids?: AmbientRuleIdGenerator;
}): {
  service: AmbientRuleService;
  repo: InMemoryAmbientRuleRepo;
} {
  const repo = new InMemoryAmbientRuleRepo();
  const service = new AmbientRuleService({
    repo,
    clock: opts?.clock,
    ids: opts?.ids ?? new SequentialAmbientRuleIdGenerator(),
  });
  return { service, repo };
}

// ── helpers ──

function toRow(a: InMemAgent): AgentRow {
  // Surface the mutable state into the embedded config for round-trip consistency.
  return {
    ...a.config,
    tenant_id: a.tenant_id,
    version: a.version,
    created_at: msToIso(a.created_at),
    updated_at: a.updated_at !== null ? msToIso(a.updated_at) : undefined,
    archived_at: a.archived_at !== null ? msToIso(a.archived_at) : undefined,
  };
}

function toVersionRow(v: InMemVersion): AgentVersionRow {
  return {
    agent_id: v.agent_id,
    tenant_id: v.tenant_id,
    version: v.version,
    snapshot: v.snapshot,
    created_at: msToIso(v.created_at),
  };
}

function msToIso(ms: number): string {
  return new Date(ms).toISOString();
}

function toAmbientRow(a: InMemAmbientRule): AmbientRuleRow {
  return {
    ...a.config,
    tenant_id: a.tenant_id,
    agent_id: a.agent_id,
    enabled: a.enabled === 1,
    trigger: {
      ...a.config.trigger,
      source: a.trigger_source as AmbientRuleRow["trigger"]["source"],
    },
    wake_mode: a.wake_mode as AmbientRuleRow["wake_mode"],
    created_at: msToIso(a.created_at),
    updated_at: a.updated_at !== null ? msToIso(a.updated_at) : undefined,
    next_wake_at:
      a.next_wake_at !== null ? msToIso(a.next_wake_at) : a.config.next_wake_at,
    last_wake_at:
      a.last_wake_at !== null ? msToIso(a.last_wake_at) : a.config.last_wake_at,
  };
}
