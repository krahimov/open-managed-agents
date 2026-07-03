import { and, asc, eq, isNull, lte } from "drizzle-orm";
import {
  asBuilder,
  getAll,
  getOne,
  runOnce,
  type OmaDb,
  type OmaDbBuilder,
} from "@open-managed-agents/db-schema";
import { ambient_rules } from "@open-managed-agents/db-schema/cf-auth";
import { AmbientRuleNotFoundError } from "../errors";
import type {
  AmbientRuleRepo,
  AmbientRuleUpdateFields,
  NewAmbientRuleInput,
} from "../ambient-ports";
import type { AmbientRuleConfig, AmbientRuleRow } from "../ambient-types";

export class SqlAmbientRuleRepo implements AmbientRuleRepo {
  private readonly db: OmaDbBuilder;

  constructor(db: OmaDb) {
    this.db = asBuilder(db);
  }

  async insert(input: NewAmbientRuleInput): Promise<AmbientRuleRow> {
    await runOnce(
      this.db.insert(ambient_rules).values({
        id: input.id,
        tenant_id: input.tenantId,
        agent_id: input.agentId,
        config: JSON.stringify(input.config),
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
      }),
    );
    const row = await this.get(input.tenantId, input.agentId, input.id);
    if (!row) throw new Error("ambient rule vanished after insert");
    return row;
  }

  async get(
    tenantId: string,
    agentId: string,
    ruleId: string,
  ): Promise<AmbientRuleRow | null> {
    const row = await getOne<typeof ambient_rules.$inferSelect>(
      this.db
        .select()
        .from(ambient_rules)
        .where(
          and(
            eq(ambient_rules.id, ruleId),
            eq(ambient_rules.tenant_id, tenantId),
            eq(ambient_rules.agent_id, agentId),
            isNull(ambient_rules.deleted_at),
          ),
        ),
    );
    return row ? toRow(row) : null;
  }

  async listByAgent(
    tenantId: string,
    agentId: string,
  ): Promise<AmbientRuleRow[]> {
    const rows = await getAll<typeof ambient_rules.$inferSelect>(
      this.db
        .select()
        .from(ambient_rules)
        .where(
          and(
            eq(ambient_rules.tenant_id, tenantId),
            eq(ambient_rules.agent_id, agentId),
            isNull(ambient_rules.deleted_at),
          ),
        )
        .orderBy(asc(ambient_rules.created_at), asc(ambient_rules.id)),
    );
    return rows.map(toRow);
  }

  async listDue(opts: {
    tenantId?: string;
    now: number;
    limit: number;
  }): Promise<AmbientRuleRow[]> {
    const conds = [
      eq(ambient_rules.enabled, 1),
      isNull(ambient_rules.deleted_at),
      lte(ambient_rules.next_wake_at, opts.now),
    ];
    if (opts.tenantId) conds.push(eq(ambient_rules.tenant_id, opts.tenantId));
    const rows = await getAll<typeof ambient_rules.$inferSelect>(
      this.db
        .select()
        .from(ambient_rules)
        .where(and(...conds))
        .orderBy(asc(ambient_rules.next_wake_at), asc(ambient_rules.id))
        .limit(opts.limit),
    );
    return rows.map(toRow);
  }

  async update(
    tenantId: string,
    agentId: string,
    ruleId: string,
    fields: AmbientRuleUpdateFields,
  ): Promise<AmbientRuleRow> {
    await runOnce(
      this.db
        .update(ambient_rules)
        .set({
          config: JSON.stringify(fields.config),
          enabled: fields.enabled ? 1 : 0,
          trigger_source: fields.triggerSource,
          wake_mode: fields.wakeMode,
          updated_at: fields.updatedAt,
          next_wake_at: fields.nextWakeAt ?? null,
          last_wake_at: fields.lastWakeAt ?? null,
        })
        .where(
          and(
            eq(ambient_rules.id, ruleId),
            eq(ambient_rules.tenant_id, tenantId),
            eq(ambient_rules.agent_id, agentId),
            isNull(ambient_rules.deleted_at),
          ),
        ),
    );
    const row = await this.get(tenantId, agentId, ruleId);
    if (!row) throw new AmbientRuleNotFoundError();
    return row;
  }

  async softDelete(
    tenantId: string,
    agentId: string,
    ruleId: string,
    deletedAt: number,
  ): Promise<void> {
    await runOnce(
      this.db
        .update(ambient_rules)
        .set({
          enabled: 0,
          deleted_at: deletedAt,
          updated_at: deletedAt,
        })
        .where(
          and(
            eq(ambient_rules.id, ruleId),
            eq(ambient_rules.tenant_id, tenantId),
            eq(ambient_rules.agent_id, agentId),
            isNull(ambient_rules.deleted_at),
          ),
        ),
    );
  }
}

function toRow(r: typeof ambient_rules.$inferSelect): AmbientRuleRow {
  const config = JSON.parse(r.config) as AmbientRuleConfig;
  return {
    ...config,
    tenant_id: r.tenant_id,
    agent_id: r.agent_id,
    enabled: r.enabled === 1,
    trigger: {
      ...config.trigger,
      source: r.trigger_source as AmbientRuleConfig["trigger"]["source"],
    },
    wake_mode: r.wake_mode as AmbientRuleConfig["wake_mode"],
    created_at: msToIso(r.created_at),
    updated_at: r.updated_at !== null ? msToIso(r.updated_at) : config.updated_at,
    next_wake_at:
      r.next_wake_at !== null ? msToIso(r.next_wake_at) : config.next_wake_at,
    last_wake_at:
      r.last_wake_at !== null ? msToIso(r.last_wake_at) : config.last_wake_at,
  };
}

function msToIso(ms: number): string {
  return new Date(ms).toISOString();
}
