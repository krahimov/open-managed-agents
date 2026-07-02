// Per-tenant agent cap — interim production guard until billing-based
// entitlements own this (docs/billing-subscriptions-plan.md). Enabled by
// MAX_AGENTS_PER_TENANT (unset/0 = unlimited, the OSS default); applies
// to EVERY tenant uniformly, unlike the Clerk gate which only meters
// Clerk-managed tenants.
//
// Counts non-archived agents: archiving an agent frees a slot, so users
// at the cap have a self-serve way to make room.

import type { SqlClient } from "@open-managed-agents/sql-client";

export function resolveMaxAgentsPerTenant(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.MAX_AGENTS_PER_TENANT?.trim();
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function buildAgentPreCreateGate(deps: {
  sql: SqlClient;
  maxAgents: number;
}): (input: { tenantId: string }) => Promise<{ status: number; body: unknown } | null> {
  return async ({ tenantId }) => {
    const row = await deps.sql
      .prepare(
        `SELECT COUNT(*) AS n FROM agents WHERE tenant_id = ? AND archived_at IS NULL`,
      )
      .bind(tenantId)
      .first<{ n: number }>();
    const count = Number(row?.n ?? 0);
    if (count < deps.maxAgents) return null;
    return {
      status: 403,
      body: {
        type: "error",
        error: {
          type: "agent_limit_reached",
          message:
            `This workspace is limited to ${deps.maxAgents} agents ` +
            `(${count} in use). Archive an agent you no longer need to free a slot.`,
        },
      },
    };
  };
}
