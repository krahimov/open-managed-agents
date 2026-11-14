// GET /v1/server_features — what this server can do, so the console shows
// only the surfaces it can back (one cached read instead of a probe per
// surface; write-only features have nothing to probe).
//
// The console knows these keys (apps/console/src/lib/server-features.ts):
// operations, workspace_access, usage, missions, workspace_admin, budgets,
// scoped_keys, simulations, draft_scenarios, comparisons, memory_writes,
// skill_versions, runtimes, cap_cli. Unknown keys are ignored there.
//
// Add a key here in the same change that ships its endpoints.

export const SERVER_FEATURES = [
  /** GET /v1/workspace/access (read-only role shim, workspace-access-routes.ts). */
  "workspace_access",
  /** GET /v1/usage (node-usage-tracker.ts). */
  "usage",
] as const;

export type ServerFeatureKey = (typeof SERVER_FEATURES)[number];

export function serverFeaturesBody(): { features: string[] } {
  return { features: [...SERVER_FEATURES] };
}
