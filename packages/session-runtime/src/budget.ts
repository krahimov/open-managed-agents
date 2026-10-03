// Budgets (usage limits) — shared by the default and Pi harnesses, the
// SessionStateMachine (Node) and SessionDO (CF). See docs/budgets.md.
//
// Everything here is pure: usage is DERIVED from the session event log
// (`span.model_request_end.model_usage`, one per model call, keyed by
// `model_request_start_id`) plus the calls the current harness run made.
// That keeps enforcement crash-consistent — a resumed turn rebuilds the
// same totals from the log, and nothing is double counted.
//
// Enforcement point: before every model call. A call is not started when a
// limit is already reached OR when the projected next call (the previous
// call's input + output tokens — the minimum the next prompt re-sends)
// would push usage past it. The harness then ends its loop cleanly (all
// tool calls of the last step already have results) and persists a
// `session.warning` with source `budget_exhausted`; the runtime turns that
// marker into `stop_reason: { type: "budget_exhausted", ... }`.

import type {
  AgentBudget,
  AgentConfig,
  BudgetExhaustedStopReason,
  BudgetName,
  SessionEvent,
} from "@open-managed-agents/shared";

export const BUDGET_WARNING_SOURCE = "budget_exhausted";
/** The harness step cap when `max_steps_per_turn` is unset (legacy behaviour:
 *  the loop just ends, no budget stop_reason). */
export const DEFAULT_MAX_STEPS_PER_TURN = 100;

const INTEGER_FIELDS = ["max_tokens_per_turn", "max_tokens_per_session", "max_steps_per_turn"] as const;
const NUMBER_FIELDS = ["max_cost_usd_per_session", "max_turn_wall_clock_seconds"] as const;
export const AGENT_BUDGET_FIELDS: ReadonlyArray<keyof AgentBudget> = [...INTEGER_FIELDS, ...NUMBER_FIELDS];

/**
 * Validate an `agent.metadata.budget` value. `null` / `undefined` mean "no
 * budget". Unknown keys and non-positive / non-finite values are rejected so
 * a typo can't silently disable a limit.
 */
export function parseAgentBudget(raw: unknown): { budget: AgentBudget | null; error?: string } {
  if (raw === undefined || raw === null) return { budget: null };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { budget: null, error: "metadata.budget must be an object" };
  }
  const out: AgentBudget = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(AGENT_BUDGET_FIELDS as readonly string[]).includes(key)) {
      return {
        budget: null,
        error: `metadata.budget.${key} is not a budget field (allowed: ${AGENT_BUDGET_FIELDS.join(", ")})`,
      };
    }
    if (value === null || value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      return { budget: null, error: `metadata.budget.${key} must be a positive number` };
    }
    if ((INTEGER_FIELDS as readonly string[]).includes(key) && !Number.isInteger(value)) {
      return { budget: null, error: `metadata.budget.${key} must be a positive integer` };
    }
    out[key as keyof AgentBudget] = value;
  }
  return { budget: Object.keys(out).length > 0 ? out : null };
}

/** The agent's budget, leniently: invalid fields (pre-validation rows) are dropped. */
export function agentBudgetOf(agent: Pick<AgentConfig, "metadata"> | null | undefined): AgentBudget | null {
  const raw = (agent?.metadata as Record<string, unknown> | undefined)?.budget;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: AgentBudget = {};
  for (const key of AGENT_BUDGET_FIELDS) {
    const v = (raw as Record<string, unknown>)[key];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) out[key] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

// ── Pricing ──────────────────────────────────────────────────────────────

/** USD per million tokens. Cache prices default to 0.1x / 1.25x input. */
export interface ModelPricing {
  input_per_mtok: number;
  output_per_mtok: number;
  cache_read_per_mtok?: number;
  cache_write_per_mtok?: number;
}

/**
 * Built-in first-party list prices (Anthropic API, 2026-09). Keys are
 * normalized model ids; lookup falls back to the longest matching prefix, so
 * dated snapshots resolve to their family. Unknown models → no price (usage
 * is still recorded, cost is null). Self-hosters override or extend this via
 * OMA_MODEL_PRICING (Node; JSON `{ "<model>": ModelPricing }`).
 */
export const DEFAULT_MODEL_PRICING: Readonly<Record<string, ModelPricing>> = {
  "claude-fable-5-1": { input_per_mtok: 10, output_per_mtok: 50, cache_read_per_mtok: 0.25, cache_write_per_mtok: 12.5 },
  "claude-fable-5": { input_per_mtok: 10, output_per_mtok: 50 },
  "claude-opus-5-5": { input_per_mtok: 4, output_per_mtok: 20, cache_read_per_mtok: 0.2, cache_write_per_mtok: 5 },
  "claude-opus-5": { input_per_mtok: 5, output_per_mtok: 25 },
  "claude-opus-4-8": { input_per_mtok: 5, output_per_mtok: 25 },
  "claude-opus-4-7": { input_per_mtok: 5, output_per_mtok: 25 },
  "claude-opus-4-6": { input_per_mtok: 5, output_per_mtok: 25 },
  "claude-opus-4-5": { input_per_mtok: 5, output_per_mtok: 25 },
  "claude-opus-4-1": { input_per_mtok: 15, output_per_mtok: 75 },
  "claude-opus-4": { input_per_mtok: 15, output_per_mtok: 75 },
  "claude-sonnet-5-5": { input_per_mtok: 2, output_per_mtok: 10, cache_read_per_mtok: 0.2, cache_write_per_mtok: 2.5 },
  "claude-sonnet-5": { input_per_mtok: 2, output_per_mtok: 10 },
  "claude-sonnet-4": { input_per_mtok: 3, output_per_mtok: 15 },
  "claude-haiku-4-5": { input_per_mtok: 1, output_per_mtok: 5 },
  "claude-3-5-haiku": { input_per_mtok: 0.8, output_per_mtok: 4 },
};

/** Normalize provider-decorated ids: `anthropic/claude-sonnet-4.6`,
 *  `us.anthropic.claude-opus-4-8`, `claude-opus-4-5@20251101`,
 *  `claude-sonnet-4-6[1m]`, `claude-sonnet-4-5-20250929` → bare family id. */
export function normalizeModelId(model: string): string {
  let m = model.trim().toLowerCase();
  m = m.replace(/\[[^\]]*\]$/, "");
  m = m.replace(/@.*$/, "");
  const slash = m.lastIndexOf("/");
  if (slash >= 0) m = m.slice(slash + 1);
  const anth = m.lastIndexOf("anthropic.");
  if (anth >= 0) m = m.slice(anth + "anthropic.".length);
  m = m.replace(/-v\d+(:\d+)?$/, "");
  m = m.replace(/-\d{8}$/, "");
  m = m.replace(/(\d)\.(\d)/g, "$1-$2");
  return m;
}

export function resolveModelPricing(
  model: string | undefined | null,
  overrides?: Readonly<Record<string, ModelPricing>> | null,
): ModelPricing | null {
  if (!model) return null;
  const raw = model.trim().toLowerCase();
  const id = normalizeModelId(model);
  if (overrides) {
    const lower = Object.fromEntries(Object.entries(overrides).map(([k, v]) => [k.toLowerCase(), v]));
    const hit = lower[raw] ?? lower[id];
    if (hit) return hit;
  }
  const table = { ...DEFAULT_MODEL_PRICING, ...(overrides ?? {}) };
  if (table[id]) return table[id];
  let best: string | null = null;
  for (const key of Object.keys(table)) {
    const k = normalizeModelId(key);
    if ((id === k || id.startsWith(`${k}-`)) && (!best || k.length > best.length)) best = key;
  }
  return best ? table[best] : null;
}

/** Parse OMA_MODEL_PRICING-style JSON; invalid entries are skipped. */
export function parseModelPricingOverrides(json: string | undefined | null): Record<string, ModelPricing> | null {
  if (!json || !json.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const out: Record<string, ModelPricing> = {};
  for (const [model, p] of Object.entries(parsed as Record<string, unknown>)) {
    const v = p as Partial<ModelPricing> | null;
    if (!v || typeof v.input_per_mtok !== "number" || typeof v.output_per_mtok !== "number") continue;
    out[model.toLowerCase()] = {
      input_per_mtok: v.input_per_mtok,
      output_per_mtok: v.output_per_mtok,
      ...(typeof v.cache_read_per_mtok === "number" ? { cache_read_per_mtok: v.cache_read_per_mtok } : {}),
      ...(typeof v.cache_write_per_mtok === "number" ? { cache_write_per_mtok: v.cache_write_per_mtok } : {}),
    };
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Same shape as `span.model_request_end.model_usage`. `input_tokens`
 *  includes cached input (AI SDK / harness convention). */
export interface ModelCallUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** Tokens a call counts against token budgets. */
export function callTokens(u: ModelCallUsage | null | undefined): number {
  if (!u) return 0;
  return (u.input_tokens || 0) + (u.output_tokens || 0);
}

export function estimateCostUsd(u: ModelCallUsage, pricing: ModelPricing | null): number | null {
  if (!pricing) return null;
  const cacheRead = Math.max(0, u.cache_read_input_tokens || 0);
  const cacheWrite = Math.max(0, u.cache_creation_input_tokens || 0);
  const uncached = Math.max(0, (u.input_tokens || 0) - cacheRead - cacheWrite);
  const usd =
    (uncached * pricing.input_per_mtok +
      cacheRead * (pricing.cache_read_per_mtok ?? pricing.input_per_mtok * 0.1) +
      cacheWrite * (pricing.cache_write_per_mtok ?? pricing.input_per_mtok * 1.25) +
      Math.max(0, u.output_tokens || 0) * pricing.output_per_mtok) /
    1_000_000;
  return Math.round(usd * 1e9) / 1e9;
}

// ── Usage derived from the event log ─────────────────────────────────────

const TURN_INPUT_TYPES = new Set(["user.message", "user.tool_confirmation", "user.custom_tool_result"]);

function threadOf(e: SessionEvent): string {
  return (e as { session_thread_id?: string }).session_thread_id ?? "sthr_primary";
}

/** A promoted (not cancelled) client input — the start of a machine turn. */
export function isTurnInputEvent(e: SessionEvent): boolean {
  if (!TURN_INPUT_TYPES.has(e.type)) return false;
  return (e as { cancelled_at?: unknown; cancelled_at_ms?: unknown }).cancelled_at == null &&
    (e as { cancelled_at_ms?: unknown }).cancelled_at_ms == null;
}

export interface UsageTotals {
  tokens: number;
  cost_usd: number;
}

export interface UsageSnapshot {
  session: UsageTotals;
  /** Since the last turn input on the thread. `steps` = model calls. */
  turn: UsageTotals & { steps: number };
  /** The most recent call (any turn on the thread) — next-call projection. */
  last_call: UsageTotals | null;
}

/** Usage carried by one `span.model_request_end` event, or null. */
export function spanUsageOf(e: SessionEvent): (ModelCallUsage & { model?: string; cost_usd?: number | null; model_request_start_id?: string }) | null {
  if (e.type !== "span.model_request_end") return null;
  const ev = e as {
    model_usage?: ModelCallUsage;
    model?: string;
    cost_usd?: number | null;
    model_request_start_id?: string;
  };
  if (!ev.model_usage) return null;
  return {
    input_tokens: Number(ev.model_usage.input_tokens) || 0,
    output_tokens: Number(ev.model_usage.output_tokens) || 0,
    cache_read_input_tokens: Number(ev.model_usage.cache_read_input_tokens) || 0,
    cache_creation_input_tokens: Number(ev.model_usage.cache_creation_input_tokens) || 0,
    ...(ev.model ? { model: ev.model } : {}),
    ...(ev.cost_usd !== undefined ? { cost_usd: ev.cost_usd } : {}),
    ...(ev.model_request_start_id ? { model_request_start_id: ev.model_request_start_id } : {}),
  };
}

/**
 * Session / turn usage from the log. `costOf` prices calls whose event has
 * no stamped `cost_usd` (events written before costs were stamped).
 */
export function usageSnapshotFromEvents(
  events: SessionEvent[],
  opts: { threadId?: string; costOf?: (u: ModelCallUsage, model?: string) => number | null } = {},
): UsageSnapshot {
  const thread = opts.threadId ?? "sthr_primary";
  const snap: UsageSnapshot = {
    session: { tokens: 0, cost_usd: 0 },
    turn: { tokens: 0, cost_usd: 0, steps: 0 },
    last_call: null,
  };
  const seen = new Set<string>();
  for (const e of events) {
    if (isTurnInputEvent(e) && threadOf(e) === thread) {
      snap.turn = { tokens: 0, cost_usd: 0, steps: 0 };
      continue;
    }
    if (e.type !== "span.model_request_end") continue;
    const id = (e as { model_request_start_id?: string }).model_request_start_id;
    if (id) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    const u = spanUsageOf(e);
    const onThread = threadOf(e) === thread;
    if (onThread) snap.turn.steps++;
    if (!u) continue;
    const tokens = callTokens(u);
    const cost = typeof u.cost_usd === "number" ? u.cost_usd : (opts.costOf?.(u, u.model) ?? 0);
    snap.session.tokens += tokens;
    snap.session.cost_usd += cost;
    if (onThread) {
      snap.turn.tokens += tokens;
      snap.turn.cost_usd += cost;
      snap.last_call = { tokens, cost_usd: cost };
    }
  }
  return snap;
}

// ── Tracker (one per harness run) ────────────────────────────────────────

export interface TenantBudgetState {
  limits: { daily_tokens?: number | null; daily_cost_usd?: number | null };
  /** Usage recorded for the tenant today (UTC) BEFORE this harness run. */
  used: UsageTotals;
}

/** Optional runtime-supplied budget inputs (HarnessContext.budget). */
export interface HarnessBudgetContext {
  /** Overrides agent.metadata.budget when set. */
  budget?: AgentBudget | null;
  /** Tenant daily caps (self-host env) with today's usage so far. */
  tenant?: TenantBudgetState | null;
  /** Pricing overrides merged over DEFAULT_MODEL_PRICING. */
  pricing?: Readonly<Record<string, ModelPricing>> | null;
}

export class BudgetTracker {
  readonly budget: AgentBudget | null;
  readonly maxSteps: number;
  private snap: UsageSnapshot;
  private tenant: TenantBudgetState | null;
  private pricing: ModelPricing | null;

  private constructor(opts: {
    budget: AgentBudget | null;
    snapshot: UsageSnapshot;
    tenant: TenantBudgetState | null;
    pricing: ModelPricing | null;
  }) {
    this.budget = opts.budget;
    this.maxSteps = opts.budget?.max_steps_per_turn ?? DEFAULT_MAX_STEPS_PER_TURN;
    this.snap = opts.snapshot;
    this.tenant = opts.tenant;
    this.pricing = opts.pricing;
  }

  /**
   * Build from the log at harness start. `events` must be the log BEFORE
   * this run's model calls (later calls are added via record()).
   * `pricingModel` is the provider model id actually called (an agent's
   * `model` may be a model-card handle).
   */
  static forRun(opts: {
    agent: Pick<AgentConfig, "metadata" | "model">;
    events: SessionEvent[];
    threadId?: string;
    context?: HarnessBudgetContext | null;
    pricingModel?: string;
  }): BudgetTracker {
    const overrides = opts.context?.pricing ?? null;
    const agentModel = typeof opts.agent.model === "string" ? opts.agent.model : opts.agent.model?.id;
    // The provider model actually called decides the price; the agent's
    // `model` (possibly a model-card handle) is only a fallback when the
    // harness can't tell.
    const pricing = resolveModelPricing(opts.pricingModel || agentModel, overrides);
    const snapshot = usageSnapshotFromEvents(opts.events, {
      threadId: opts.threadId,
      costOf: (u, model) => estimateCostUsd(u, resolveModelPricing(model, overrides) ?? pricing),
    });
    const budget = opts.context?.budget !== undefined ? opts.context.budget : agentBudgetOf(opts.agent);
    return new BudgetTracker({ budget: budget ?? null, snapshot, tenant: opts.context?.tenant ?? null, pricing });
  }

  /** Estimated cost of one call of this run's model (null: unpriced). */
  costOf(u: ModelCallUsage): number | null {
    return estimateCostUsd(u, this.pricing);
  }

  /** Account one finished model call of this run. */
  record(u: ModelCallUsage | null | undefined): void {
    this.snap.turn.steps++;
    if (!u) return;
    const tokens = callTokens(u);
    const cost = this.costOf(u) ?? 0;
    this.snap.session.tokens += tokens;
    this.snap.session.cost_usd += cost;
    this.snap.turn.tokens += tokens;
    this.snap.turn.cost_usd += cost;
    this.snap.last_call = { tokens, cost_usd: cost };
    if (this.tenant) {
      this.tenant = {
        ...this.tenant,
        used: { tokens: this.tenant.used.tokens + tokens, cost_usd: this.tenant.used.cost_usd + cost },
      };
    }
  }

  get usage(): Readonly<UsageSnapshot> {
    return this.snap;
  }

  /** check() as if `calls` (this run's finished calls, not yet record()ed)
   *  had been recorded. For loops that hand over their step list (AI SDK
   *  stopWhen) instead of reporting calls one by one. */
  checkAfter(calls: ReadonlyArray<ModelCallUsage | null | undefined>): BudgetExhaustedStopReason | null {
    const copy = new BudgetTracker({
      budget: this.budget,
      snapshot: {
        session: { ...this.snap.session },
        turn: { ...this.snap.turn },
        last_call: this.snap.last_call ? { ...this.snap.last_call } : null,
      },
      tenant: this.tenant ? { limits: this.tenant.limits, used: { ...this.tenant.used } } : null,
      pricing: this.pricing,
    });
    for (const c of calls) copy.record(c);
    return copy.check();
  }

  /**
   * May the next model call start? Returns the first exhausted limit, or
   * null. Configured step caps report `max_steps_per_turn`; the default cap
   * is enforced by the harness loop itself without a budget stop.
   */
  check(): BudgetExhaustedStopReason | null {
    const b = this.budget ?? {};
    const next = this.snap.last_call ?? { tokens: 0, cost_usd: 0 };
    const over = (used: number, projected: number, limit: number | null | undefined) =>
      typeof limit === "number" && (used >= limit || used + projected > limit);
    const stop = (budget: BudgetName, limit: number, used: number): BudgetExhaustedStopReason => ({
      type: "budget_exhausted",
      budget,
      limit,
      used: Math.round(used * 1e6) / 1e6,
    });

    if (b.max_steps_per_turn !== undefined && this.snap.turn.steps >= b.max_steps_per_turn) {
      return stop("max_steps_per_turn", b.max_steps_per_turn, this.snap.turn.steps);
    }
    if (over(this.snap.turn.tokens, next.tokens, b.max_tokens_per_turn)) {
      return stop("max_tokens_per_turn", b.max_tokens_per_turn!, this.snap.turn.tokens);
    }
    if (over(this.snap.session.tokens, next.tokens, b.max_tokens_per_session)) {
      return stop("max_tokens_per_session", b.max_tokens_per_session!, this.snap.session.tokens);
    }
    if (over(this.snap.session.cost_usd, next.cost_usd, b.max_cost_usd_per_session)) {
      return stop("max_cost_usd_per_session", b.max_cost_usd_per_session!, this.snap.session.cost_usd);
    }
    const t = this.tenant;
    if (t && over(t.used.tokens, next.tokens, t.limits.daily_tokens)) {
      return stop("tenant_daily_tokens", t.limits.daily_tokens!, t.used.tokens);
    }
    if (t && over(t.used.cost_usd, next.cost_usd, t.limits.daily_cost_usd)) {
      return stop("tenant_daily_cost_usd", t.limits.daily_cost_usd!, t.used.cost_usd);
    }
    return null;
  }
}

// ── Turn-end marker ──────────────────────────────────────────────────────

const UNIT: Partial<Record<BudgetName, string>> = {
  max_tokens_per_turn: "tokens",
  max_tokens_per_session: "tokens",
  tenant_daily_tokens: "tokens",
  max_cost_usd_per_session: "USD",
  tenant_daily_cost_usd: "USD",
  max_turn_wall_clock_seconds: "seconds",
  max_steps_per_turn: "model calls",
};

export function describeBudgetStop(stop: BudgetExhaustedStopReason): string {
  const unit = UNIT[stop.budget] ?? "";
  const fmt = (n: number) => (unit === "USD" ? `$${n.toFixed(4)}` : n.toLocaleString("en-US"));
  const when =
    stop.budget === "max_turn_wall_clock_seconds"
      ? "The turn was aborted."
      : "The turn was stopped before the next model call.";
  return `Budget exhausted: ${stop.budget} (used ${fmt(stop.used)} of ${fmt(stop.limit)}${
    unit && unit !== "USD" ? ` ${unit}` : ""
  }). ${when}`;
}

/**
 * The durable marker a budget stop leaves in the log. Doubles as the
 * console-visible notice; runtimes read it back (budgetStopFromEvents) to
 * build the turn's stop_reason, so a crash between this write and the
 * turn's idle still ends the turn with the budget reason.
 */
export function budgetWarningEvent(stop: BudgetExhaustedStopReason, threadId?: string): SessionEvent {
  return {
    type: "session.warning",
    source: BUDGET_WARNING_SOURCE,
    message: describeBudgetStop(stop),
    details: { budget: stop.budget, limit: stop.limit, used: stop.used },
    ...(threadId && threadId !== "sthr_primary" ? { session_thread_id: threadId } : {}),
  } as unknown as SessionEvent;
}

/** The budget stop recorded in `turnEvents` (events of one turn), if any. */
export function budgetStopFromEvents(turnEvents: SessionEvent[], threadId?: string): BudgetExhaustedStopReason | null {
  const thread = threadId ?? "sthr_primary";
  for (let i = turnEvents.length - 1; i >= 0; i--) {
    const e = turnEvents[i] as unknown as {
      type: string;
      source?: string;
      details?: { budget?: BudgetName; limit?: number; used?: number };
    };
    if (threadOf(turnEvents[i]) !== thread) continue;
    if (isTurnInputEvent(turnEvents[i])) return null;
    if (e.type !== "session.warning" || e.source !== BUDGET_WARNING_SOURCE || !e.details?.budget) continue;
    return {
      type: "budget_exhausted",
      budget: e.details.budget,
      limit: Number(e.details.limit) || 0,
      used: Number(e.details.used) || 0,
    };
  }
  return null;
}

/** Wall-clock deadline (ms epoch) for a turn that started at `startedAtMs`. */
export function turnDeadlineMs(budget: AgentBudget | null, startedAtMs: number): number | null {
  const s = budget?.max_turn_wall_clock_seconds;
  return typeof s === "number" && s > 0 ? startedAtMs + s * 1000 : null;
}
