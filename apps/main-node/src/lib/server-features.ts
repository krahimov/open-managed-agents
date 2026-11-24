// GET /v1/server_features — what this server can do, so the console shows
// only the surfaces it can back (one cached read instead of a probe per
// surface; write-only features have nothing to probe).
//
// The console knows these keys (apps/console/src/lib/server-features.ts):
// operations, workspace_access, usage, missions, workspace_admin, budgets,
// scoped_keys, simulations, draft_scenarios, comparisons, memory_writes,
// skill_versions, runtimes, cap_cli, ambient_run_now. Unknown keys are
// ignored there.
//
// Add a key here in the same change that ships its endpoints.

import { claudeSdkApprovals, codexSdkApprovals } from "./engine-allowlist";

export const SERVER_FEATURES = [
  /** GET /v1/workspace/access (read-only role shim, workspace-access-routes.ts). */
  "workspace_access",
  /** GET /v1/usage (node-usage-tracker.ts). */
  "usage",
  /** POST /v1/agents/:id/ambient-rules/:ruleId/run ("Run now" / "Send test event"). */
  "ambient_run_now",
] as const;

export type ServerFeatureKey = (typeof SERVER_FEATURES)[number];

/**
 * The trigger sources something on this server actually fires: schedule
 * rules (node-ambient-dispatch.ts sweep) and webhook rules (POST
 * …/ambient-rules/:ruleId/events). Rules of any other source save, but
 * nothing here reads them, so the console must not offer them.
 */
export const AMBIENT_TRIGGER_SOURCES = ["schedule", "webhook"] as const;

/**
/**
 * The engines (an agent's `harness`) that run a vendor CLI on the API host.
 * Each is on only where the operator opted in (`flag`). Where the operator
 * also restricted it to approved agents, `approvals` says what the caller's
 * workspace was granted. These are the checks the harnesses make before a
 * turn, so the console offers an engine only where a session on it can run
 * (prod 2026-11-24: an agent created on "Claude Agent SDK" on a server with
 * it switched off failed its first turn instead).
 *
 * Two answers, because creating and editing differ:
 *   - `engines`: the engines a NEW agent of this workspace could run on.
 *   - `engine_agents`: per engine, the workspace's existing agents approved
 *     one by one. Such an approval does not cover an agent created next.
 *
 * Their own fields, not feature keys: an empty `engines` means "none",
 * while a server that predates the field leaves it out and the console
 * then offers every engine, as it always did.
 */
export const HOST_ENGINES = {
  "claude-agent-sdk": { flag: "OMA_ENABLE_CLAUDE_AGENT_SDK", approvals: claudeSdkApprovals },
  "codex-sdk": { flag: "OMA_ENABLE_CODEX_SDK", approvals: codexSdkApprovals },
} as const;

type Env = Record<string, string | undefined>;

export function serverFeaturesBody(
  env: Env = process.env,
  tenantId?: string,
): {
  features: string[];
  ambient_trigger_sources: string[];
  engines: string[];
  engine_agents: Record<string, string[]>;
} {
  const engines: string[] = [];
  const engineAgents: Record<string, string[]> = {};
  for (const [harness, engine] of Object.entries(HOST_ENGINES)) {
    if (env[engine.flag] !== "1") continue;
    const approvals = engine.approvals(env, tenantId);
    if (approvals.all) engines.push(harness);
    else if (approvals.agents.length > 0) engineAgents[harness] = approvals.agents;
  }
  return {
    features: [...SERVER_FEATURES],
    ambient_trigger_sources: [...AMBIENT_TRIGGER_SOURCES],
    engines,
    engine_agents: engineAgents,
  };
}
