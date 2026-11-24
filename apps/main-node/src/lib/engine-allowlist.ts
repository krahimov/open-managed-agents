// Operator allowlists for the subscription engines
// (OMA_CLAUDE_ALLOWED_AGENTS, OMA_CODEX_ALLOWED_AGENTS): comma-separated
// `tenant_id/agent_id` entries. Parsed in one place so what the console is
// told (GET /v1/server_features) and what a harness enforces before a turn
// cannot drift apart.

type EnvLike = Record<string, string | undefined>;

export interface EngineAllowlistEntry {
  tenant: string;
  /** An agent id, or "*" (every agent of the workspace, where the engine honours it). */
  agent: string;
}

/**
 * The valid entries of an allowlist value, or null when it is unset (no
 * restriction). An entry needs a workspace and an agent part: `tenant/` or
 * a bare `tenant` approves nothing and is dropped.
 */
export function parseEngineAllowlist(raw: string | undefined): EngineAllowlistEntry[] | null {
  if (raw === undefined) return null;
  const entries: EngineAllowlistEntry[] = [];
  for (const value of raw.split(",")) {
    const entry = value.trim();
    const slash = entry.indexOf("/");
    if (slash <= 0) continue;
    const tenant = entry.slice(0, slash);
    const agent = entry.slice(slash + 1);
    if (!agent || agent.includes("/")) continue;
    entries.push({ tenant, agent });
  }
  return entries;
}

/**
 * OMA_CLAUDE_ALLOWED_AGENTS: the agents that may bill this server's Claude
 * subscription, as `tenant_id/agent_id` pairs, or `tenant_id/*` for every
 * agent of a workspace. Unset: no restriction (a single-operator
 * deployment). Set but empty: nobody.
 * Pass no `agentId` to ask whether the workspace has any entry at all.
 */
export function claudeSdkAllowed(env: EnvLike, tenantId: string | undefined, agentId?: string): boolean {
  const entries = parseEngineAllowlist(env.OMA_CLAUDE_ALLOWED_AGENTS);
  if (entries === null) return true;
  if (!tenantId) return false;
  const mine = entries.filter((entry) => entry.tenant === tenantId);
  if (agentId === undefined) return mine.length > 0;
  return !!agentId && agentId !== "*" && mine.some((entry) => entry.agent === "*" || entry.agent === agentId);
}

/**
 * Whether a workspace has an agent the Codex engine would run.
 * OMA_CODEX_ALLOWED_AGENTS takes exact pairs only (codex-sdk-harness.ts), so
 * a `tenant/*` entry approves nothing there.
 */
export function codexSdkTenantAllowed(env: EnvLike, tenantId: string | undefined): boolean {
  const entries = parseEngineAllowlist(env.OMA_CODEX_ALLOWED_AGENTS);
  if (entries === null) return true;
  return !!tenantId && entries.some((entry) => entry.tenant === tenantId && entry.agent !== "*");
}
