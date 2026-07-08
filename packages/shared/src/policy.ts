// Deterministic access-policy evaluation (Phase 1: agent-baseline layer).
//
// The single evaluator behind every enforcement backend: buildTools() filters
// the DefaultHarness tool dict with it, and the claude-agent-sdk harness
// compiles the same policy into SDK-native options via
// compileSdkPermissionOptions(). Pure functions, no I/O — evaluation runs
// per turn against the policy pinned in the session snapshot, so it must
// never touch the DB.

import type {
  EffectivePolicy,
  PermissionEffect,
  PermissionRule,
  PolicyDecision,
} from "@open-managed-agents/api-types";

/** deny beats ask beats allow when two rules tie on specificity. */
const EFFECT_RANK: Record<PermissionEffect, number> = {
  deny: 2,
  ask: 1,
  allow: 0,
};

/** Glob match over the tool namespace: `*` = any run of characters. */
export function matchesSelector(selector: string, toolName: string): boolean {
  if (selector === "*") return true;
  if (!selector.includes("*")) return selector === toolName;
  const pattern = selector
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${pattern}$`).test(toolName);
}

/** Specificity = literal (non-wildcard) characters. "mcp__linear__get_*" (17)
 *  beats "mcp__linear__*" (13) beats "*" (0). */
export function selectorSpecificity(selector: string): number {
  return selector.replace(/\*/g, "").length;
}

/**
 * Evaluate one tool name against a policy. Most-specific matching rule wins;
 * on ties, deny > ask > allow. No matching rule (or no policy) = allow —
 * the baseline grant is the ceiling and its absence is the legacy world.
 */
export function evaluatePolicy(
  policy: EffectivePolicy | null | undefined,
  toolName: string,
): PolicyDecision {
  if (!policy || policy.rules.length === 0) {
    return { tool_name: toolName, effect: "allow" };
  }
  let winner: PermissionRule | null = null;
  let winnerScore = -1;
  for (const rule of policy.rules) {
    if (!matchesSelector(rule.selector, toolName)) continue;
    const score = selectorSpecificity(rule.selector);
    if (
      score > winnerScore ||
      (score === winnerScore &&
        winner !== null &&
        EFFECT_RANK[rule.effect] > EFFECT_RANK[winner.effect])
    ) {
      winner = rule;
      winnerScore = score;
    }
  }
  if (!winner) return { tool_name: toolName, effect: "allow" };
  return { tool_name: toolName, effect: winner.effect, selector: winner.selector };
}

/** Validate a rules array (service + approval endpoint both call this). */
export function validatePermissionRules(rules: unknown): PermissionRule[] {
  if (!Array.isArray(rules)) throw new TypeError("rules must be an array");
  return rules.map((r, i) => {
    if (!r || typeof r !== "object" || Array.isArray(r)) {
      throw new TypeError(`rules[${i}] must be an object`);
    }
    const rule = r as Record<string, unknown>;
    if (rule.effect !== "allow" && rule.effect !== "ask" && rule.effect !== "deny") {
      throw new TypeError(`rules[${i}].effect must be allow|ask|deny`);
    }
    if (typeof rule.selector !== "string" || rule.selector.trim().length === 0) {
      throw new TypeError(`rules[${i}].selector is required`);
    }
    const out: PermissionRule = {
      effect: rule.effect,
      selector: rule.selector.trim(),
    };
    if (typeof rule.description === "string" && rule.description) {
      out.description = rule.description;
    }
    return out;
  });
}

// ---------------------------------------------------------------------------
// claude-agent-sdk compilation
//
// The SDK harness never runs buildTools(), so the pinned policy is compiled
// into SDK-native controls instead. Two layers, belt and suspenders:
//   - disallowedTools: static deny list the SDK strips before the model
//     ever sees the tools (OMA selectors mapped to Claude Code tool names).
//   - canUseTool: per-call backstop that re-evaluates the OMA policy for
//     names disallowedTools couldn't enumerate statically (dynamic MCP
//     tools, glob selectors with no CC equivalent).
// Phase 1 enforces deny only on this path; ask passes through (the SDK
// harness has no confirmation round-trip yet — see plan Phase 4).
// ---------------------------------------------------------------------------

/** OMA built-in tool name → Claude Code tool name. */
const OMA_TO_CC_TOOL: Record<string, string> = {
  bash: "Bash",
  read: "Read",
  write: "Write",
  edit: "Edit",
  glob: "Glob",
  grep: "Grep",
  web_fetch: "WebFetch",
  web_search: "WebSearch",
};

/** CC tool name → OMA name (for canUseTool evaluating CC callbacks). */
const CC_TO_OMA_TOOL: Record<string, string> = Object.fromEntries(
  Object.entries(OMA_TO_CC_TOOL).map(([oma, cc]) => [cc, oma]),
);

/** Normalize a Claude Code tool name into the OMA namespace so one policy
 *  evaluates identically on both harnesses. MCP names (`mcp__srv__tool`)
 *  are already shared; unknown CC tools pass through unchanged (a selector
 *  can still target them verbatim). */
export function ccToolNameToOma(ccName: string): string {
  return CC_TO_OMA_TOOL[ccName] ?? ccName;
}

/**
 * Static disallowedTools for the SDK child: every exact-name (wildcard-free)
 * deny selector, mapped to its CC name when it's a built-in. Glob deny
 * selectors can't be enumerated statically — canUseTool covers those.
 */
export function compileSdkDisallowedTools(
  policy: EffectivePolicy | null | undefined,
): string[] {
  if (!policy) return [];
  const out = new Set<string>();
  for (const rule of policy.rules) {
    if (rule.effect !== "deny" || rule.selector.includes("*")) continue;
    out.add(OMA_TO_CC_TOOL[rule.selector] ?? rule.selector);
  }
  return [...out];
}

/** True when the policy contains any deny rule that needs the canUseTool
 *  backstop (i.e. can't be fully expressed via compileSdkDisallowedTools). */
export function policyNeedsSdkCallback(
  policy: EffectivePolicy | null | undefined,
): boolean {
  return !!policy?.rules.some((r) => r.effect === "deny" && r.selector.includes("*"));
}
