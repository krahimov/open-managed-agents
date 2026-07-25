// Default judge-card selection (evals-design §4.1).
//
// Pure functions over plain card shapes so both runtimes (and tests)
// share one implementation: when a spec omits `judge.model_card_id`, the
// resolver picks the tenant's highest-tier card from a DIFFERENT
// provider family than the agent under eval (cross-family judging
// measurably reduces self-preference bias), falling back to the
// highest-tier same-family card.

/** The slice of ModelCardRow the selection needs — kept structural so
 *  fakes in tests don't have to build full rows. */
export interface JudgeCandidateCard {
  id: string;
  model_id: string;
  /** Wire-level model string ("claude-opus-4-8", "gpt-5.6-sol", …). */
  model: string;
  /** Provider tag ("ant" | "ant-compatible" | "oai" | "oai-compatible"). */
  provider: string;
  archived_at?: string | null;
}

export type ProviderFamily = "anthropic" | "openai" | "other";

/** Family from the wire model string first (a gateway card can serve a
 *  Claude model under an oai-compatible provider tag), provider tag as
 *  the fallback. */
export function providerFamily(model: string, provider: string): ProviderFamily {
  if (/^(anthropic\/)?claude/i.test(model)) return "anthropic";
  if (/^(openai\/)?(gpt-|o[1-9]|chatgpt-)/i.test(model)) return "openai";
  if (provider.startsWith("ant")) return "anthropic";
  if (provider.startsWith("oai")) return "openai";
  return "other";
}

/**
 * Heuristic tier rank — only compared WITHIN a family (cross-family
 * candidates are filtered before ranking), so the scales don't need to
 * be calibrated against each other. Base rank by class keyword +
 * version number; small-model suffixes are penalized.
 */
export function judgeTier(model: string): number {
  const m = model.toLowerCase();
  let base = 0;
  if (m.includes("claude")) {
    if (m.includes("opus") || m.includes("fable")) base = 300;
    else if (m.includes("sonnet")) base = 200;
    else if (m.includes("haiku")) base = 100;
    else base = 150;
    // Trailing version digits: claude-opus-4-8 → 4.8, claude-fable-5 → 5.
    // Date stamps ("claude-sonnet-4-20250514") are NOT minor versions —
    // strip 6+-digit runs first or the stamp inflates the tier by ~20M.
    const undated = m.replace(/-\d{6,}(?=$|-)/g, "");
    const v = /-(\d+)(?:-(\d+))?(?:$|-)/.exec(undated);
    if (v) base += Number(v[1]) * 10 + (v[2] ? Number(v[2]) : 0);
  } else {
    const gpt = /gpt-(\d+)(?:\.(\d+))?/.exec(m);
    if (gpt) base = 200 + Number(gpt[1]) * 10 + (gpt[2] ? Number(gpt[2]) : 0);
    else if (/^o[1-9]/.test(m)) base = 200 + Number(m[1]) * 10;
    else base = 100;
  }
  if (m.includes("mini")) base -= 50;
  if (m.includes("nano")) base -= 80;
  return base;
}

/**
 * Pick the default judge card. Returns null when the tenant has no
 * usable (non-archived) cards at all.
 */
export function selectJudgeCard<C extends JudgeCandidateCard>(
  cards: C[],
  opts: { agentFamily: ProviderFamily; crossFamily?: boolean },
): C | null {
  const usable = cards.filter((c) => !c.archived_at);
  if (usable.length === 0) return null;
  const crossFamily = opts.crossFamily !== false;
  const byTier = (pool: C[]): C | null =>
    pool.length === 0
      ? null
      : pool.reduce((best, c) => (judgeTier(c.model) > judgeTier(best.model) ? c : best));
  if (crossFamily) {
    const other = usable.filter(
      (c) => providerFamily(c.model, c.provider) !== opts.agentFamily,
    );
    const pick = byTier(other);
    if (pick) return pick;
  }
  return byTier(usable);
}
