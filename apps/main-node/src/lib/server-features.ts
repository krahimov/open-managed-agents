// GET /v1/server_features — what this server can do, so the console shows
// only the surfaces it can back (one cached read instead of a probe per
// surface; write-only features have nothing to probe).
//
// The console knows these keys (apps/console/src/lib/server-features.ts):
// operations, workspace_access, usage, missions, workspace_admin, budgets,
// scoped_keys, simulations, draft_scenarios, comparisons, memory_writes,
// skill_versions, runtimes, cap_cli, ambient_run_now, engine_claude_agent_sdk,
// engine_codex_sdk. Unknown keys are ignored there.
//
// Add a key here in the same change that ships its endpoints.

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
 * The engines that run a CLI on the API host, each on only where the
 * operator opted in (the same env checks the harness router makes before a
 * turn). Listed so the console offers an engine only where a session on it
 * can run: prod 2026-11-24, an agent created on "Claude Agent SDK" on a
 * server with it switched off failed its first turn instead.
 */
export const ENGINE_FEATURES = {
  engine_claude_agent_sdk: "OMA_ENABLE_CLAUDE_AGENT_SDK",
  engine_codex_sdk: "OMA_ENABLE_CODEX_SDK",
} as const;

export function serverFeaturesBody(
  env: Record<string, string | undefined> = process.env,
): { features: string[]; ambient_trigger_sources: string[] } {
  const engines = Object.entries(ENGINE_FEATURES)
    .filter(([, flag]) => env[flag] === "1")
    .map(([key]) => key);
  return {
    features: [...SERVER_FEATURES, ...engines],
    ambient_trigger_sources: [...AMBIENT_TRIGGER_SOURCES],
  };
}
