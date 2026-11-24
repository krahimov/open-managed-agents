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
 * a bare `tenant` approves nothing and is dropped. Space around either part
 * is not part of an id.
 */
export function parseEngineAllowlist(raw: string | undefined): EngineAllowlistEntry[] | null {
  if (raw === undefined) return null;
  const entries: EngineAllowlistEntry[] = [];
  for (const value of raw.split(",")) {
    const slash = value.indexOf("/");
    if (slash < 0) continue;
    const tenant = value.slice(0, slash).trim();
    const agent = value.slice(slash + 1).trim();
    if (!tenant || !agent || agent.includes("/")) continue;
    entries.push({ tenant, agent });
  }
  return entries;
}

/** What an allowlist grants one workspace. */
export interface EngineApprovals {
  /** Every agent of the workspace, including ones not created yet. */
  all: boolean;
  /** Agents approved one by one. */
  agents: string[];
}

function approvalsFor(raw: string | undefined, tenantId: string | undefined, wildcard: boolean): EngineApprovals {
  const entries = parseEngineAllowlist(raw);
  if (entries === null) return { all: true, agents: [] };
  const mine = tenantId ? entries.filter((entry) => entry.tenant === tenantId) : [];
  return {
    all: wildcard && mine.some((entry) => entry.agent === "*"),
    agents: [...new Set(mine.filter((entry) => entry.agent !== "*").map((entry) => entry.agent))],
  };
}

/**
 * OMA_CLAUDE_ALLOWED_AGENTS: the agents that may bill this server's Claude
 * subscription, as `tenant_id/agent_id` pairs, or `tenant_id/*` for every
 * agent of a workspace. Unset: no restriction (a single-operator
 * deployment). Set but empty: nobody.
 */
export function claudeSdkApprovals(env: EnvLike, tenantId: string | undefined): EngineApprovals {
  return approvalsFor(env.OMA_CLAUDE_ALLOWED_AGENTS, tenantId, true);
}

export function claudeSdkAllowed(env: EnvLike, tenantId: string | undefined, agentId: string | undefined): boolean {
  if (env.OMA_CLAUDE_ALLOWED_AGENTS === undefined) return true;
  if (!tenantId || !agentId || agentId === "*") return false;
  const approvals = claudeSdkApprovals(env, tenantId);
  return approvals.all || approvals.agents.includes(agentId);
}

/**
 * OMA_CODEX_ALLOWED_AGENTS takes exact `tenant_id/agent_id` pairs only: a
 * `tenant/*` entry approves nothing there, so no workspace can put a new
 * agent on Codex while the list is set.
 */
export function codexSdkApprovals(env: EnvLike, tenantId: string | undefined): EngineApprovals {
  return approvalsFor(env.OMA_CODEX_ALLOWED_AGENTS, tenantId, false);
}

export function codexSdkAllowed(env: EnvLike, tenantId: string | undefined, agentId: string | undefined): boolean {
  if (env.OMA_CODEX_ALLOWED_AGENTS === undefined) return true;
  if (!tenantId || !agentId) return false;
  return codexSdkApprovals(env, tenantId).agents.includes(agentId);
}
