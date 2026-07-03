import { generateAmbientRuleId } from "@open-managed-agents/shared";
import { AmbientRuleNotFoundError } from "./errors";
import type {
  AmbientRuleConfig,
  AmbientRuleRow,
  AmbientTriggerConfig,
  AmbientWakeMode,
} from "./ambient-types";
import {
  AMBIENT_TRIGGER_SOURCES,
  AMBIENT_WAKE_MODES,
  AMBIENT_DECISION_OUTCOMES,
} from "./ambient-types";
import type {
  AmbientRuleClock,
  AmbientRuleCreateInput,
  AmbientRuleIdGenerator,
  AmbientRuleRepo,
  AmbientRuleUpdateInput,
} from "./ambient-ports";

export interface AmbientRuleServiceDeps {
  repo: AmbientRuleRepo;
  clock?: AmbientRuleClock;
  ids?: AmbientRuleIdGenerator;
}

export class AmbientRuleService {
  private readonly repo: AmbientRuleRepo;
  private readonly clock: AmbientRuleClock;
  private readonly ids: AmbientRuleIdGenerator;

  constructor(deps: AmbientRuleServiceDeps) {
    this.repo = deps.repo;
    this.clock = deps.clock ?? defaultClock;
    this.ids = deps.ids ?? defaultIds;
  }

  async create(opts: {
    tenantId: string;
    agentId: string;
    input: AmbientRuleCreateInput;
  }): Promise<AmbientRuleRow> {
    const nowMs = this.clock.nowMs();
    const id = this.ids.ambientRuleId();
    const trigger = normalizeTrigger(opts.input.trigger);
    const wakeMode = normalizeWakeMode(opts.input.wake_mode ?? "decide");
    const nextWakeAt = parseOptionalIso(opts.input.next_wake_at, "next_wake_at");

    const config: AmbientRuleConfig = {
      id,
      agent_id: opts.agentId,
      name: normalizeName(opts.input.name),
      ...(opts.input.description ? { description: opts.input.description } : {}),
      enabled: opts.input.enabled ?? true,
      trigger,
      wake_mode: wakeMode,
      ...(opts.input.decision_policy !== undefined
        ? { decision_policy: normalizePlainObject(opts.input.decision_policy, "decision_policy") }
        : {}),
      ...(opts.input.execution_profile
        ? { execution_profile: opts.input.execution_profile }
        : {}),
      ...(opts.input.budget !== undefined
        ? { budget: normalizePlainObject(opts.input.budget, "budget") }
        : {}),
      ...(opts.input.created_by ? { created_by: opts.input.created_by } : {}),
      created_at: msToIso(nowMs),
      ...(nextWakeAt !== undefined ? { next_wake_at: msToIso(nextWakeAt) } : {}),
    };

    return this.repo.insert({
      id,
      tenantId: opts.tenantId,
      agentId: opts.agentId,
      config,
      createdAt: nowMs,
    });
  }

  get(opts: {
    tenantId: string;
    agentId: string;
    ruleId: string;
  }): Promise<AmbientRuleRow | null> {
    return this.repo.get(opts.tenantId, opts.agentId, opts.ruleId);
  }

  listByAgent(opts: {
    tenantId: string;
    agentId: string;
  }): Promise<AmbientRuleRow[]> {
    return this.repo.listByAgent(opts.tenantId, opts.agentId);
  }

  listDue(opts: {
    tenantId?: string;
    now?: number;
    limit?: number;
  }): Promise<AmbientRuleRow[]> {
    return this.repo.listDue({
      ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
      now: opts.now ?? this.clock.nowMs(),
      limit: opts.limit ?? 100,
    });
  }

  async update(opts: {
    tenantId: string;
    agentId: string;
    ruleId: string;
    input: AmbientRuleUpdateInput;
  }): Promise<AmbientRuleRow> {
    const existing = await this.repo.get(opts.tenantId, opts.agentId, opts.ruleId);
    if (!existing) throw new AmbientRuleNotFoundError();

    const nowMs = this.clock.nowMs();
    const nextWakeAt =
      opts.input.next_wake_at !== undefined
        ? parseOptionalIso(opts.input.next_wake_at, "next_wake_at")
        : parseOptionalIso(existing.next_wake_at, "next_wake_at");
    const lastWakeAt =
      opts.input.last_wake_at !== undefined
        ? parseOptionalIso(opts.input.last_wake_at, "last_wake_at")
        : parseOptionalIso(existing.last_wake_at, "last_wake_at");

    const config: AmbientRuleConfig = {
      ...stripTenantId(existing),
      ...(opts.input.name !== undefined
        ? { name: normalizeName(opts.input.name) }
        : {}),
      ...(opts.input.description !== undefined
        ? opts.input.description === null
          ? { description: undefined }
          : { description: opts.input.description }
        : {}),
      ...(opts.input.enabled !== undefined ? { enabled: opts.input.enabled } : {}),
      ...(opts.input.trigger !== undefined
        ? { trigger: normalizeTrigger(opts.input.trigger) }
        : {}),
      ...(opts.input.wake_mode !== undefined
        ? { wake_mode: normalizeWakeMode(opts.input.wake_mode) }
        : {}),
      ...(opts.input.decision_policy !== undefined
        ? opts.input.decision_policy === null
          ? { decision_policy: undefined }
          : {
              decision_policy: normalizePlainObject(
                opts.input.decision_policy,
                "decision_policy",
              ),
            }
        : {}),
      ...(opts.input.execution_profile !== undefined
        ? opts.input.execution_profile === null
          ? { execution_profile: undefined }
          : { execution_profile: opts.input.execution_profile }
        : {}),
      ...(opts.input.budget !== undefined
        ? opts.input.budget === null
          ? { budget: undefined }
          : { budget: normalizePlainObject(opts.input.budget, "budget") }
        : {}),
      ...(opts.input.last_decision !== undefined
        ? opts.input.last_decision === null
          ? { last_decision: undefined }
          : { last_decision: normalizeLastDecision(opts.input.last_decision) }
        : {}),
      updated_at: msToIso(nowMs),
      ...(nextWakeAt !== undefined ? { next_wake_at: msToIso(nextWakeAt) } : { next_wake_at: undefined }),
      ...(lastWakeAt !== undefined ? { last_wake_at: msToIso(lastWakeAt) } : { last_wake_at: undefined }),
    };

    return this.repo.update(opts.tenantId, opts.agentId, opts.ruleId, {
      config,
      enabled: config.enabled,
      triggerSource: config.trigger.source,
      wakeMode: config.wake_mode,
      updatedAt: nowMs,
      nextWakeAt: nextWakeAt ?? null,
      lastWakeAt: lastWakeAt ?? null,
    });
  }

  async delete(opts: {
    tenantId: string;
    agentId: string;
    ruleId: string;
  }): Promise<void> {
    const existing = await this.repo.get(opts.tenantId, opts.agentId, opts.ruleId);
    if (!existing) throw new AmbientRuleNotFoundError();
    await this.repo.softDelete(
      opts.tenantId,
      opts.agentId,
      opts.ruleId,
      this.clock.nowMs(),
    );
  }
}

function normalizeName(name: string): string {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new TypeError("name is required");
  }
  return name.trim();
}

function normalizeTrigger(input: AmbientTriggerConfig): AmbientTriggerConfig {
  if (!input || typeof input !== "object") {
    throw new TypeError("trigger is required");
  }
  const source = input.source;
  if (!AMBIENT_TRIGGER_SOURCES.includes(source)) {
    throw new TypeError(
      `trigger.source must be one of ${AMBIENT_TRIGGER_SOURCES.join("|")}`,
    );
  }
  return {
    source,
    config: normalizePlainObject(input.config ?? {}, "trigger.config"),
  };
}

function normalizeWakeMode(input: AmbientWakeMode): AmbientWakeMode {
  if (!AMBIENT_WAKE_MODES.includes(input)) {
    throw new TypeError(`wake_mode must be one of ${AMBIENT_WAKE_MODES.join("|")}`);
  }
  return input;
}

function normalizePlainObject(
  input: Record<string, unknown>,
  field: string,
): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError(`${field} must be an object`);
  }
  return input;
}

function normalizeLastDecision(
  input: NonNullable<AmbientRuleUpdateInput["last_decision"]>,
): NonNullable<AmbientRuleConfig["last_decision"]> {
  if (!input || typeof input !== "object") {
    throw new TypeError("last_decision must be an object");
  }
  if (!AMBIENT_DECISION_OUTCOMES.includes(input.outcome)) {
    throw new TypeError(
      `last_decision.outcome must be one of ${AMBIENT_DECISION_OUTCOMES.join("|")}`,
    );
  }
  parseRequiredIso(input.decided_at, "last_decision.decided_at");
  return input;
}

function parseOptionalIso(
  value: string | null | undefined,
  field: string,
): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  return parseRequiredIso(value, field);
}

function parseRequiredIso(value: string, field: string): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new TypeError(`${field} must be an ISO timestamp`);
  return ms;
}

function stripTenantId(row: AmbientRuleRow): AmbientRuleConfig {
  const { tenant_id: _tenantId, ...rest } = row;
  return rest;
}

function msToIso(ms: number): string {
  return new Date(ms).toISOString();
}

const defaultClock: AmbientRuleClock = { nowMs: () => Date.now() };
const defaultIds: AmbientRuleIdGenerator = {
  ambientRuleId: generateAmbientRuleId,
};
