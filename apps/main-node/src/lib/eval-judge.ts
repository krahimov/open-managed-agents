// Node judge resolver — maps an `llm_judge` RewardSpec to a runtime
// JudgeFn for the eval runner (evals-design §4.1).
//
// Resolution order:
//   1. spec.judge.model_card_id → that exact card, or null (⇒ trial
//      scores 0 "unavailable") when it's missing/keyless.
//   2. Default: the tenant's highest-tier card from a DIFFERENT provider
//      family than the agent under eval (cross_family default true), at
//      reasoning level "max"; same-family highest tier as fallback.
//
// The resolved model rides the same resolveModel + reasoningProviderOptions
// path as agent turns, so Responses-API routing / adaptive-thinking gates
// apply to the judge identically.

import { generateText } from "ai";
import {
  resolveModel,
  reasoningProviderOptions,
  type ApiCompat,
} from "@open-managed-agents/agent/harness/provider";
import {
  REASONING_LEVELS,
  type ReasoningLevel,
} from "@open-managed-agents/api-types";
import type { ModelCardService, ModelCardRow } from "@open-managed-agents/model-cards-store";
import type { AgentService } from "@open-managed-agents/agents-store";
import {
  selectJudgeCard,
  providerFamily,
  type EvalRunnerContext,
} from "@open-managed-agents/evals-runner";
import type {
  LlmJudgeRewardSpec,
  ResolvedJudge,
  JudgeFn,
} from "@open-managed-agents/shared";
import { extractTextFromContent } from "@open-managed-agents/shared";
import { getLogger } from "@open-managed-agents/observability";

const log = getLogger("eval-judge");

// Generous on purpose: at reasoning_level "max" Anthropic's adaptive
// thinking counts against maxOutputTokens, and a complex grading prompt can
// burn >4k tokens of thinking BEFORE emitting the verdict — the call then
// returns empty text, the parser retries, and the trial degrades to 0
// (seen live on prod: csv-clean judge "verdict parse failure text=" ×4).
// Cost is bounded by actual generation, not this ceiling.
const JUDGE_MAX_OUTPUT_TOKENS = 32768;

function providerToCompat(provider: string): ApiCompat {
  return provider === "oai" || provider === "oai-compatible"
    ? provider
    : provider === "ant-compatible"
      ? "ant-compatible"
      : "ant";
}

function sanitizeLevel(raw: string | undefined): ReasoningLevel {
  return raw && (REASONING_LEVELS as readonly string[]).includes(raw)
    ? (raw as ReasoningLevel)
    : "max";
}

export function buildNodeJudgeResolver(deps: {
  modelCards: ModelCardService;
  agents: AgentService;
}): NonNullable<EvalRunnerContext["resolveJudge"]> {
  return async (
    tenantId: string,
    agentId: string,
    spec: LlmJudgeRewardSpec,
  ): Promise<ResolvedJudge | null> => {
    try {
      const card = await pickCard(deps, tenantId, agentId, spec);
      if (!card) return null;
      const apiKey = await deps.modelCards.getApiKey({ tenantId, cardId: card.id });
      if (!apiKey) return null;

      const level = sanitizeLevel(spec.judge?.reasoning_level);
      const model = resolveModel(
        card.model,
        apiKey,
        card.base_url || undefined,
        providerToCompat(card.provider),
        card.custom_headers ?? undefined,
        level,
      );
      const providerOptions = reasoningProviderOptions(
        model,
        card.model,
        level,
        /* hasTools */ false,
      );

      const judge: JudgeFn = async (prompt, signal) => {
        const result = await generateText({
          model,
          system: prompt.system,
          messages: [{ role: "user", content: prompt.user }],
          maxOutputTokens: JUDGE_MAX_OUTPUT_TOKENS,
          abortSignal: signal,
          ...(providerOptions ? { providerOptions } : {}),
        });
        const text =
          result.text ||
          extractTextFromContent((result as unknown as { content?: unknown }).content);
        const u = (result as unknown as {
          usage?: {
            inputTokens?: number;
            outputTokens?: number;
            cachedInputTokens?: number;
            cacheReadInputTokens?: number;
            cacheCreationInputTokens?: number;
          };
        }).usage;
        const usage = u
          ? {
              input_tokens: u.inputTokens ?? 0,
              output_tokens: u.outputTokens ?? 0,
              cache_creation_input_tokens:
                u.cacheCreationInputTokens ?? u.cachedInputTokens,
              cache_read_input_tokens: u.cacheReadInputTokens,
            }
          : undefined;
        return { text, usage };
      };

      return { judge, judgeModelId: card.model, judgeReasoningLevel: level };
    } catch (err) {
      // Any resolution failure degrades to "unavailable" — the trial gets
      // a 0 score with a clear reason instead of a crashed run.
      log.warn(
        { err, op: "eval_judge.resolve_failed", tenant_id: tenantId, agent_id: agentId },
        "llm_judge resolution failed; trial will score 0 as unavailable",
      );
      return null;
    }
  };
}

async function pickCard(
  deps: { modelCards: ModelCardService; agents: AgentService },
  tenantId: string,
  agentId: string,
  spec: LlmJudgeRewardSpec,
): Promise<ModelCardRow | null> {
  if (spec.judge?.model_card_id) {
    return deps.modelCards.get({ tenantId, cardId: spec.judge.model_card_id });
  }

  const cards = await deps.modelCards.list({ tenantId });
  if (cards.length === 0) return null;

  // Family of the agent under eval: its model handle → the card serving
  // it (the handle string itself is the fallback when no card matches).
  let agentModel = "";
  let agentProvider = "";
  try {
    const agent = await deps.agents.get({ tenantId, agentId });
    const handle =
      typeof agent?.model === "string" ? agent.model : agent?.model?.id ?? "";
    agentModel = handle;
    const agentCard = handle
      ? await deps.modelCards.findByModelId({ tenantId, modelId: handle })
      : null;
    if (agentCard) {
      agentModel = agentCard.model;
      agentProvider = agentCard.provider;
    }
  } catch {
    // agent lookup is best-effort — selection falls back to "other" family
  }

  return selectJudgeCard(cards, {
    agentFamily: providerFamily(agentModel, agentProvider),
    crossFamily: spec.judge?.cross_family !== false,
  });
}
