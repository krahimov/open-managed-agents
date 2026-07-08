import { and, desc, eq, isNull } from "drizzle-orm";
import {
  asBuilder,
  getAll,
  getOne,
  runOnce,
  type OmaDb,
  type OmaDbBuilder,
} from "@open-managed-agents/db-schema";
import { permission_grants } from "@open-managed-agents/db-schema/cf-auth";
import type {
  PermissionPrincipalType,
  PermissionRule,
} from "@open-managed-agents/shared";
import type {
  NewPermissionGrantInput,
  PermissionGrantRepo,
} from "../grants-ports";
import type { PermissionGrantRow } from "../grants-types";

export class SqlPermissionGrantRepo implements PermissionGrantRepo {
  private readonly db: OmaDbBuilder;

  constructor(db: OmaDb) {
    this.db = asBuilder(db);
  }

  async insert(input: NewPermissionGrantInput): Promise<PermissionGrantRow> {
    await runOnce(
      this.db.insert(permission_grants).values({
        id: input.id,
        tenant_id: input.tenantId,
        agent_id: input.agentId,
        principal_type: input.principalType,
        principal_id: input.principalId,
        rules: JSON.stringify(input.rules),
        version: input.version,
        enabled: input.enabled ? 1 : 0,
        proposed_by: input.proposedBy ?? null,
        approved_by: input.approvedBy,
        created_at: input.createdAt,
      }),
    );
    const row = await getOne<typeof permission_grants.$inferSelect>(
      this.db
        .select()
        .from(permission_grants)
        .where(eq(permission_grants.id, input.id)),
    );
    if (!row) throw new Error("permission grant vanished after insert");
    return toRow(row);
  }

  async getActive(
    tenantId: string,
    agentId: string,
    principalType: PermissionPrincipalType,
    principalId: string | null,
  ): Promise<PermissionGrantRow | null> {
    const row = await getOne<typeof permission_grants.$inferSelect>(
      this.db
        .select()
        .from(permission_grants)
        .where(keyWhere(tenantId, agentId, principalType, principalId))
        .orderBy(desc(permission_grants.version))
        .limit(1),
    );
    return row ? toRow(row) : null;
  }

  async listVersions(
    tenantId: string,
    agentId: string,
    principalType: PermissionPrincipalType,
    principalId: string | null,
  ): Promise<PermissionGrantRow[]> {
    const rows = await getAll<typeof permission_grants.$inferSelect>(
      this.db
        .select()
        .from(permission_grants)
        .where(keyWhere(tenantId, agentId, principalType, principalId))
        .orderBy(desc(permission_grants.version)),
    );
    return rows.map(toRow);
  }
}

function keyWhere(
  tenantId: string,
  agentId: string,
  principalType: PermissionPrincipalType,
  principalId: string | null,
) {
  return and(
    eq(permission_grants.tenant_id, tenantId),
    eq(permission_grants.agent_id, agentId),
    eq(permission_grants.principal_type, principalType),
    principalId === null
      ? isNull(permission_grants.principal_id)
      : eq(permission_grants.principal_id, principalId),
  );
}

function toRow(r: typeof permission_grants.$inferSelect): PermissionGrantRow {
  return {
    id: r.id,
    tenant_id: r.tenant_id,
    agent_id: r.agent_id,
    principal_type: r.principal_type as PermissionGrantRow["principal_type"],
    principal_id: r.principal_id,
    rules: JSON.parse(r.rules) as PermissionRule[],
    version: r.version,
    enabled: r.enabled === 1,
    ...(r.proposed_by ? { proposed_by: r.proposed_by } : {}),
    approved_by: r.approved_by,
    created_at: new Date(r.created_at).toISOString(),
  };
}
