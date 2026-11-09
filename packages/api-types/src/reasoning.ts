// Unified reasoning levels — the ONE place that knows which models reason
// and how each user-facing level maps onto each provider's knob. Pure
// functions, zero deps: imported by the agent harness (provider.ts, pi),
// main-node (codex / claude-agent-sdk harnesses, eval judge), the HTTP
// routes (validation) and the console (picker).
//
//   level  | OpenAI reasoning_effort      | Claude (adaptive, 4.6+)     | Claude (legacy ≤4.5)
//   -------|------------------------------|-----------------------------|----------------------
//   low    | low                          | effort low                  | thinking budget 4k
//   medium | medium   (default)           | effort medium               | 16k
//   high   | high                         | effort high                 | 32k
//   xhigh  | xhigh (→ high where absent)  | effort xhigh (4.6 → high)   | 48k
//   max    | highest the model accepts    | effort max                  | 64k (clamped < cap)
//   instant| legacy: low (official OAI)   | 5.x: effort low; 4.6–4.8:   | off
//          |                              | thinking off                |
//
// Unset = "medium". Unsupported levels degrade to the nearest supported
// one — never a 400.

/** Per-agent / per-session reasoning control. `instant` is a legacy value
 *  (pre-picker): still accepted on the wire so stored agents keep loading,
 *  but the console only offers the five {@link UI_REASONING_LEVELS}. */
export type ReasoningLevel = "instant" | "low" | "medium" | "high" | "xhigh" | "max";

/** Every value the API accepts (validation). */
export const REASONING_LEVELS: readonly ReasoningLevel[] = [
  "instant",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** The levels the console picker offers, in order. */
export const UI_REASONING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type UiReasoningLevel = (typeof UI_REASONING_LEVELS)[number];

/** What an unset `reasoning_level` means. */
export const DEFAULT_REASONING_LEVEL: UiReasoningLevel = "medium";

export const REASONING_LEVEL_LABELS: Record<ReasoningLevel, string> = {
  instant: "Instant",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

export function isReasoningLevel(value: unknown): value is ReasoningLevel {
  return typeof value === "string" && (REASONING_LEVELS as readonly string[]).includes(value);
}

/** Unset → the default level. */
export function effectiveReasoningLevel(level: ReasoningLevel | null | undefined): ReasoningLevel {
  return level ?? DEFAULT_REASONING_LEVEL;
}

/** The level a picker should show as selected (legacy `instant` → low,
 *  its nearest UI level). */
export function uiReasoningLevel(level: ReasoningLevel | null | undefined): UiReasoningLevel {
  const l = effectiveReasoningLevel(level);
  return l === "instant" ? "low" : l;
}

/** "openai/gpt-6.1-sol" → "gpt-6.1-sol". */
export function bareModelId(modelId: string): string {
  return modelId.includes("/") ? modelId.split("/").slice(1).join("/") : modelId;
}

// ─── OpenAI ──────────────────────────────────────────────────────────────

/** Parse "gpt-N[.M]…" → [N, M]. */
function gptVersion(bare: string): [number, number] | null {
  const m = /^gpt-(\d+)(?:\.(\d+))?/i.exec(bare);
  return m ? [Number(m[1]), m[2] !== undefined ? Number(m[2]) : 0] : null;
}

/**
 * True for every OpenAI reasoning model: the o-series (o1, o3, o4-mini…)
 * and every GPT from the GPT-5 era onward (gpt-5*, gpt-6*, gpt-7, … — any
 * gpt-N with N ≥ 5). No per-name list: gpt-6.1-sol, gpt-6-astra,
 * gpt-6.1-terra and future gpt-7 all qualify by shape. The one carve-out
 * is the `gpt-5-chat` alias, which OpenAI serves as a non-reasoning chat
 * model. Accepts a provider-prefixed id.
 */
export function isOpenAiReasoningModel(modelId: string): boolean {
  const bare = bareModelId(modelId).toLowerCase();
  if (/^o\d/.test(bare)) return true;
  if (bare.startsWith("gpt-5-chat")) return false;
  const v = gptVersion(bare);
  return v !== null && v[0] >= 5;
}

export type OpenAiReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh";

/** Highest reasoning_effort the model accepts. `xhigh` arrived with
 *  gpt-5.1-codex-max / gpt-5.2; the o-series, gpt-5 and gpt-5.1 top out
 *  at high (gpt-5-pro only accepts high). */
export function openAiMaxReasoningEffort(modelId: string): "high" | "xhigh" {
  const bare = bareModelId(modelId).toLowerCase();
  if (bare.startsWith("gpt-5.1-codex-max")) return "xhigh";
  const v = gptVersion(bare);
  if (!v) return "high"; // o-series
  const [major, minor] = v;
  return major > 5 || minor >= 2 ? "xhigh" : "high";
}

/** OMA level → OpenAI reasoning_effort for an official reasoning model on
 *  the Responses API. Legacy `instant` maps to `low`: not every reasoning
 *  model accepts `none` (gpt-6-astra, gpt-5), so the lowest effort every
 *  one of them takes is the safe "fast" floor. */
export function openAiReasoningEffort(
  modelId: string,
  level: ReasoningLevel | null | undefined,
): Exclude<OpenAiReasoningEffort, "none"> {
  const l = effectiveReasoningLevel(level);
  const bare = bareModelId(modelId).toLowerCase();
  if (bare.startsWith("gpt-5-pro")) return "high";
  switch (l) {
    case "instant":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
    case "max":
      return openAiMaxReasoningEffort(bare);
  }
}

// ─── Anthropic Claude ────────────────────────────────────────────────────

export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type ClaudeReasoning =
  /** thinking:{type:"adaptive"} + output_config.effort (Claude 4.6+). */
  | { mode: "adaptive"; effort: ClaudeEffort }
  /** Legacy extended thinking (≤4.5): thinking:{type:"enabled",budget_tokens}. */
  | { mode: "budget"; budgetTokens: number }
  /** Send no thinking parameter at all. */
  | { mode: "off" };

/** "claude-opus-5-5" → [5, 5]; "claude-sonnet-4-6-20260101" → [4, 6];
 *  "claude-opus-4-20250514" → [4, 0]; old "claude-3-5-sonnet" → [3, 5]. */
export function claudeVersion(modelId: string): [number, number] | null {
  const bare = bareModelId(modelId)
    .toLowerCase()
    .replace(/^claude-([a-z]+)-(\d+)\.(\d+)/, "claude-$1-$2-$3");
  const named = /^claude-[a-z]+(?:-[a-z]+)*?-(\d{1,2})(?:-(\d{1,2}))?(?=$|-|@)/.exec(bare);
  if (named) return [Number(named[1]), named[2] !== undefined ? Number(named[2]) : 0];
  const legacy = /^claude-(\d)(?:-(\d))?-/.exec(bare);
  if (legacy) return [Number(legacy[1]), legacy[2] !== undefined ? Number(legacy[2]) : 0];
  return null;
}

const CLAUDE_LEGACY_BUDGET: Record<Exclude<ReasoningLevel, "instant">, number> = {
  low: 4096,
  medium: 16384,
  high: 32768,
  xhigh: 49152,
  max: 65536,
};

/** Known max-output caps for legacy (budget-thinking) Claude models. The
 *  API rejects budget_tokens >= max_tokens and @ai-sdk/anthropic clamps
 *  max_tokens to the model cap without shrinking the budget — so the
 *  budget must stay under the cap. Conservative 64k for unlisted ids. */
function claudeLegacyMaxOutput(bare: string): number {
  if (/^claude-opus-4(-1)?($|-\d{6,})/.test(bare)) return 32_000;
  if (/^claude-3-5-/.test(bare)) return 8_192;
  return 64_000;
}
const CLAUDE_THINKING_HEADROOM = 8_192;

/**
 * OMA level → Claude thinking configuration, per model generation:
 *   - 4.7, 4.8, 5.x (Opus/Sonnet/Haiku/Fable): adaptive + effort
 *     low|medium|high|xhigh|max. `budget_tokens` 400s on all of them.
 *     5.x can't (or by default doesn't) turn thinking off, so legacy
 *     `instant` → effort low; 4.7/4.8 → thinking off.
 *   - 4.6 (Opus/Sonnet): adaptive + effort low|medium|high|max (no xhigh
 *     → high). `instant` → off.
 *   - ≤4.5 (Haiku 4.5, Sonnet 4.5, Opus 4.5/4.1/4, 3.x): legacy
 *     enabled + budget_tokens, clamped under the model's output cap.
 * Returns null for ids that aren't recognisable Claude models.
 */
export function claudeReasoning(
  modelId: string,
  level: ReasoningLevel | null | undefined,
): ClaudeReasoning | null {
  const bare = bareModelId(modelId).toLowerCase();
  if (!bare.startsWith("claude-")) return null;
  const v = claudeVersion(bare);
  if (!v) return null;
  const [major, minor] = v;
  const l = effectiveReasoningLevel(level);

  if (major >= 5 || (major === 4 && minor >= 7)) {
    if (l === "instant") return major >= 5 ? { mode: "adaptive", effort: "low" } : { mode: "off" };
    return { mode: "adaptive", effort: l };
  }
  if (major === 4 && minor === 6) {
    if (l === "instant") return { mode: "off" };
    return { mode: "adaptive", effort: l === "xhigh" ? "high" : l };
  }
  if (l === "instant") return { mode: "off" };
  const ceiling = claudeLegacyMaxOutput(bare) - CLAUDE_THINKING_HEADROOM;
  // 1024 is Anthropic's minimum thinking budget.
  return { mode: "budget", budgetTokens: Math.max(1024, Math.min(CLAUDE_LEGACY_BUDGET[l], ceiling)) };
}

// ─── Model-card level support (console + harness) ────────────────────────

/** True when a model card's provider + model actually take a reasoning
 *  knob. Gateways (`*-compatible`) and non-reasoning models (gpt-4o)
 *  ignore the level — the picker still renders it, disabled. */
export function modelSupportsReasoning(provider: string, model: string): boolean {
  if (provider === "oai") return isOpenAiReasoningModel(model);
  if (provider === "ant") return claudeReasoning(model, "medium") !== null;
  return false;
}
