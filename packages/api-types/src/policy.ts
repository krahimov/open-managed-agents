// Access-control policy DTOs (Phase 1: agent-baseline layer).
//
// A permission grant is a versioned, append-only rules document attached to
// an agent (and, in later phases, to a principal — user or role). The rules
// are DATA evaluated by deterministic code; the model never enforces them.
// Evaluation logic lives in @open-managed-agents/shared (policy.ts) — this
// module is wire-format types only.

export const PERMISSION_EFFECTS = ["allow", "ask", "deny"] as const;

export type PermissionEffect = (typeof PERMISSION_EFFECTS)[number];

/** Grant layers. Phase 1 ships "baseline" only; "role" and "user" overlays
 *  land in Phase 3 with intersection semantics (overlays only restrict). */
export const PERMISSION_PRINCIPAL_TYPES = ["baseline", "role", "user"] as const;

export type PermissionPrincipalType =
  (typeof PERMISSION_PRINCIPAL_TYPES)[number];

/**
 * One rule: an effect applied to every tool whose name matches `selector`.
 * Selectors are globs over the harness tool namespace (`*` = any run of
 * characters): "bash", "mcp__linear__*", "mcp__github__get_*".
 * Most-specific match wins; on specificity ties, deny > ask > allow.
 */
export interface PermissionRule {
  effect: PermissionEffect;
  selector: string;
  /** Human-readable intent, carried into diffs and the console. */
  description?: string;
}

/**
 * The policy pinned into a session at init — resolved from the agent's
 * active grant(s) and immutable for the session's lifetime (same snapshot
 * determinism as agent_snapshot). Absent policy = legacy behavior (allow).
 */
export interface EffectivePolicy {
  /** Grant row the rules came from, for audit lineage. */
  grant_id?: string;
  grant_version?: number;
  rules: PermissionRule[];
}

/** Result of evaluating a tool name against an EffectivePolicy. */
export interface PolicyDecision {
  tool_name: string;
  effect: PermissionEffect;
  /** Selector of the winning rule; absent when no rule matched (default allow). */
  selector?: string;
}
