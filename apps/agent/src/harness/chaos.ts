// Chaos injection for simulations — deterministic, seeded tool failures.
//
// A simulation task can declare `simulation.chaos.rules`; the eval runner
// stamps them into the session's `metadata.eval.chaos` at create time and
// the runtime's buildTools hook wraps the tool dictionary with
// `applyChaosRules()`. Failed calls return a normal tool-result string
// (the model sees a tool error exactly as it would a real one), prefixed
// with CHAOS_MARKER so trace facts / the judge can separate injected
// failures from genuine ones.
//
// Determinism: each rule's failure decisions come from a seeded PRNG keyed
// by (seed, tool) — the same spec produces the same failure sequence on
// every trial, so trials are comparable and a benchmark stays a benchmark.
// Failure decision = the k-th call to that tool fails iff prng() < rate,
// evaluated in call order.

export interface ChaosRule {
  /** Tool name to target (exact match, e.g. "web_search", "bash"). */
  tool: string;
  /** Probability 0..1 that any given call to this tool fails. */
  failure_rate: number;
  /** error: return an error result; timeout: hang for `timeout_ms` then
   *  error; empty: return an empty/blank successful result. Default error. */
  mode?: "error" | "timeout" | "empty";
  /** Error text the model sees. Default: a generic transient error. */
  error_text?: string;
  /** PRNG seed — default 1. Same seed ⇒ same failure sequence. */
  seed?: number;
  /** Cap on how many calls this rule fails in a session (default: no cap). */
  max_failures?: number;
  /** For mode "timeout": how long to hang before failing. Default 5000. */
  timeout_ms?: number;
}

/** Prefix on every injected failure result — trace facts count these as
 *  `chaos_failures_injected` and the judge is told they are simulated. */
export const CHAOS_MARKER = "[chaos-injected]";

const DEFAULT_ERROR_TEXT = "Error: transient failure — service unavailable (503). Please retry.";
const DEFAULT_TIMEOUT_MS = 5_000;
const TIMEOUT_CAP_MS = 60_000;

/** mulberry32 — tiny, deterministic, good enough for failure sampling. */
function makePrng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashTool(name: string): number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function normalizeChaosRules(raw: unknown): ChaosRule[] {
  const list = (raw as { rules?: unknown })?.rules ?? raw;
  if (!Array.isArray(list)) return [];
  const rules: ChaosRule[] = [];
  for (const item of list) {
    const r = item as Partial<ChaosRule> | null;
    if (!r || typeof r.tool !== "string" || !r.tool.trim()) continue;
    const rate = typeof r.failure_rate === "number" ? r.failure_rate : NaN;
    if (!Number.isFinite(rate) || rate < 0 || rate > 1) continue;
    rules.push({
      tool: r.tool.trim(),
      failure_rate: rate,
      mode: r.mode === "timeout" || r.mode === "empty" ? r.mode : "error",
      error_text: typeof r.error_text === "string" && r.error_text.trim() ? r.error_text : undefined,
      seed: typeof r.seed === "number" && Number.isFinite(r.seed) ? Math.floor(r.seed) : 1,
      max_failures:
        typeof r.max_failures === "number" && r.max_failures >= 0 ? Math.floor(r.max_failures) : undefined,
      timeout_ms:
        typeof r.timeout_ms === "number" && r.timeout_ms > 0
          ? Math.min(Math.floor(r.timeout_ms), TIMEOUT_CAP_MS)
          : DEFAULT_TIMEOUT_MS,
    });
  }
  return rules;
}

interface ChaosState {
  prng: () => number;
  failures: number;
  calls: number;
}

// Per-(session, tool) chaos state. buildTools() is rebuilt on EVERY turn,
// so state kept inside applyChaosRules would restart the PRNG and reset
// max_failures each turn — the failure sequence would no longer be the
// deterministic per-session sequence the benchmark relies on. Keyed here
// at module scope instead; bounded so a long-lived Node process can't
// grow it unboundedly (eviction just means a fresh sequence for a session
// that outlived MAX_CHAOS_SESSIONS others — never a missed injection).
const chaosStateBySession = new Map<string, Map<string, ChaosState>>();
const MAX_CHAOS_SESSIONS = 2000;

/** Drop a session's chaos state (call on session end; optional). */
export function clearChaosState(sessionId: string): void {
  chaosStateBySession.delete(sessionId);
}

function sessionChaosState(sessionId: string, tool: string, rule: ChaosRule): ChaosState {
  let perTool = chaosStateBySession.get(sessionId);
  if (!perTool) {
    if (chaosStateBySession.size >= MAX_CHAOS_SESSIONS) {
      const oldest = chaosStateBySession.keys().next().value;
      if (oldest !== undefined) chaosStateBySession.delete(oldest);
    }
    perTool = new Map();
    chaosStateBySession.set(sessionId, perTool);
  }
  let st = perTool.get(tool);
  if (!st) {
    st = { prng: makePrng((rule.seed ?? 1) ^ hashTool(tool)), failures: 0, calls: 0 };
    perTool.set(tool, st);
  }
  return st;
}

/**
 * Wrap a tool dictionary so calls to chaos-targeted tools fail per the
 * rules. Tools not named in any rule pass through untouched. Returns the
 * same dictionary object shape (`Record<string, Tool>`); only `execute` is
 * replaced on targeted tools. State is per (sessionId, tool) and survives
 * across buildTools() calls; without a sessionId it falls back to a fresh
 * per-call state (tests / one-shot use).
 */
export function applyChaosRules<T extends Record<string, any>>(
  tools: T,
  rulesRaw: unknown,
  opts: {
    sessionId?: string;
    onInjected?: (info: { tool: string; mode: string; call_index: number }) => void;
  } = {},
): T {
  const rules = normalizeChaosRules(rulesRaw);
  if (rules.length === 0) return tools;

  const byTool = new Map<string, { rule: ChaosRule; state: ChaosState }>();
  for (const rule of rules) {
    if (byTool.has(rule.tool)) continue; // first rule for a tool wins
    const state = opts.sessionId
      ? sessionChaosState(opts.sessionId, rule.tool, rule)
      : { prng: makePrng((rule.seed ?? 1) ^ hashTool(rule.tool)), failures: 0, calls: 0 };
    byTool.set(rule.tool, { rule, state });
  }

  for (const [name, entry] of byTool) {
    const tool = tools[name];
    if (!tool || typeof tool.execute !== "function") continue;
    const original = tool.execute.bind(tool);
    tool.execute = async (...args: unknown[]) => {
      const { rule, state } = entry;
      state.calls++;
      const capped = rule.max_failures !== undefined && state.failures >= rule.max_failures;
      const roll = state.prng();
      if (capped || roll >= rule.failure_rate) return original(...args);

      state.failures++;
      opts.onInjected?.({ tool: name, mode: rule.mode ?? "error", call_index: state.calls });
      const text = rule.error_text ?? DEFAULT_ERROR_TEXT;
      switch (rule.mode) {
        case "timeout":
          await new Promise((r) => setTimeout(r, rule.timeout_ms ?? DEFAULT_TIMEOUT_MS));
          return `${CHAOS_MARKER} Error: request timed out after ${rule.timeout_ms ?? DEFAULT_TIMEOUT_MS}ms`;
        case "empty":
          return `${CHAOS_MARKER} (completed with no output)`;
        default:
          return `${CHAOS_MARKER} ${text}`;
      }
    };
  }
  return tools;
}
