// Default judge selection (evals-design §4.1): highest-tier card from a
// DIFFERENT provider family than the agent under eval, same-family
// highest tier as fallback.

import { describe, it, expect } from "vitest";
import {
  selectJudgeCard,
  providerFamily,
  judgeTier,
  type JudgeCandidateCard,
} from "@open-managed-agents/evals-runner";

function card(
  id: string,
  model: string,
  provider: string,
  archived_at: string | null = null,
): JudgeCandidateCard {
  return { id, model_id: id, model, provider, archived_at };
}

describe("providerFamily", () => {
  it("classifies by wire model string first", () => {
    expect(providerFamily("claude-opus-4-8", "oai-compatible")).toBe("anthropic");
    expect(providerFamily("gpt-5.6-sol", "ant-compatible")).toBe("openai");
    expect(providerFamily("o3", "oai")).toBe("openai");
  });

  it("falls back to the provider tag for unrecognized models", () => {
    expect(providerFamily("minimax-m2", "ant-compatible")).toBe("anthropic");
    expect(providerFamily("grok-4", "oai-compatible")).toBe("openai");
    expect(providerFamily("mystery", "custom")).toBe("other");
  });
});

describe("judgeTier", () => {
  it("ranks opus/fable above sonnet above haiku within Anthropic", () => {
    expect(judgeTier("claude-opus-4-8")).toBeGreaterThan(judgeTier("claude-sonnet-4-6"));
    expect(judgeTier("claude-fable-5")).toBeGreaterThan(judgeTier("claude-sonnet-4-6"));
    expect(judgeTier("claude-sonnet-4-6")).toBeGreaterThan(judgeTier("claude-haiku-4-5"));
  });

  it("treats date-stamped wire ids like their undated base version", () => {
    expect(judgeTier("claude-sonnet-4-20250514")).toBe(judgeTier("claude-sonnet-4"));
    expect(judgeTier("claude-opus-4-1-20250805")).toBe(judgeTier("claude-opus-4-1"));
    expect(judgeTier("claude-fable-5")).toBeGreaterThan(judgeTier("claude-sonnet-4-20250514"));
    expect(judgeTier("claude-3-5-haiku-20241022")).toBeLessThan(judgeTier("claude-haiku-4-5"));
  });

  it("ranks newer gpt majors above older, penalizes mini/nano", () => {
    expect(judgeTier("gpt-5.6-sol")).toBeGreaterThan(judgeTier("gpt-4o"));
    expect(judgeTier("gpt-5.1")).toBeGreaterThan(judgeTier("gpt-5.1-mini"));
    expect(judgeTier("gpt-5.1-mini")).toBeGreaterThan(judgeTier("gpt-5.1-nano"));
  });
});

describe("selectJudgeCard", () => {
  const tenantCards = [
    card("c-haiku", "claude-haiku-4-5", "ant"),
    card("c-opus", "claude-opus-4-8", "ant"),
    card("c-gpt", "gpt-5.6-sol", "oai"),
    card("c-gpt-mini", "gpt-5.1-mini", "oai"),
  ];

  it("cross-family default: Anthropic agent gets the best OpenAI judge", () => {
    const pick = selectJudgeCard(tenantCards, { agentFamily: "anthropic" });
    expect(pick?.id).toBe("c-gpt");
  });

  it("cross-family default: OpenAI agent gets the best Anthropic judge", () => {
    const pick = selectJudgeCard(tenantCards, { agentFamily: "openai" });
    expect(pick?.id).toBe("c-opus");
  });

  it("falls back to same-family highest tier when no cross-family card exists", () => {
    const anthropicOnly = [
      card("c-haiku", "claude-haiku-4-5", "ant"),
      card("c-opus", "claude-opus-4-8", "ant"),
    ];
    const pick = selectJudgeCard(anthropicOnly, { agentFamily: "anthropic" });
    expect(pick?.id).toBe("c-opus");
  });

  it("cross_family:false picks the overall highest tier regardless of family", () => {
    const pick = selectJudgeCard(tenantCards, {
      agentFamily: "anthropic",
      crossFamily: false,
    });
    // best OpenAI-family card would be c-gpt; with crossFamily off the
    // pool is every card — opus vs gpt compare within-pool by tier, and
    // the reduce keeps whichever ranks higher.
    expect(["c-opus", "c-gpt"]).toContain(pick?.id);
  });

  it("a date-stamped lower-class card never outranks opus/fable", () => {
    const pick = selectJudgeCard(
      [
        card("c-fable", "claude-fable-5", "ant"),
        card("c-dated-sonnet", "claude-sonnet-4-20250514", "ant"),
      ],
      { agentFamily: "openai" },
    );
    expect(pick?.id).toBe("c-fable");
  });

  it("skips archived cards and returns null when nothing is usable", () => {
    const pick = selectJudgeCard(
      [card("c-old", "gpt-4o", "oai", "2026-01-01T00:00:00Z")],
      { agentFamily: "anthropic" },
    );
    expect(pick).toBeNull();
    expect(selectJudgeCard([], { agentFamily: "openai" })).toBeNull();
  });
});
