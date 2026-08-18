// Pure-helper tests for POST /v1/evals/draft_scenarios — draft parsing,
// validation gate, task assembly (reward pre-attached), prompt
// composition, and the static fallback template.

import { describe, expect, it } from "vitest";
import {
  scenarioDraftError,
  scenarioDraftToTask,
  staticScenarioTemplate,
  buildScenarioAuthorPrompt,
  parseScenarioDrafts,
  buildSimJudgeContext,
  SIM_STANDING_CRITERIA,
  type ScenarioDraft,
} from "../src/lib/scenario-drafting";

const GOOD: ScenarioDraft = {
  id: "lost-invoice",
  scenario: "Customer lost their March invoice and finance is chasing them.",
  persona: {
    name: "Dana",
    identity: "office manager at a 40-person startup",
    goals: ["get the invoice re-sent"],
    hidden_knowledge: "invoice number INV-2093",
    communication_style: "terse",
    termination: "invoice received or clearly impossible",
  },
  max_turns: 8,
  rubric: "- id: goal-achieved — the invoice was located.\n" + SIM_STANDING_CRITERIA,
};

describe("parseScenarioDrafts", () => {
  it("parses a bare array, a fenced array, and an array embedded in prose", () => {
    const arr = JSON.stringify([GOOD]);
    expect(parseScenarioDrafts(arr)).toHaveLength(1);
    expect(parseScenarioDrafts("```json\n" + arr + "\n```")).toHaveLength(1);
    expect(parseScenarioDrafts("Here you go:\n" + arr + "\nEnjoy!")).toHaveLength(1);
  });

  it("wraps a lone object as a one-element array", () => {
    expect(parseScenarioDrafts(JSON.stringify(GOOD))).toEqual([GOOD]);
  });

  it("never extracts a nested string array out of a single object", () => {
    // The bracket-slice fallback must not grab GOOD.persona.goals.
    const drafts = parseScenarioDrafts("prose " + JSON.stringify(GOOD) + " prose");
    expect(drafts).toEqual([GOOD]);
  });

  it("returns [] for garbage", () => {
    expect(parseScenarioDrafts("not json")).toEqual([]);
    expect(parseScenarioDrafts("")).toEqual([]);
    expect(parseScenarioDrafts('["just", "strings"]')).toEqual([]);
  });
});

describe("scenarioDraftError", () => {
  it("accepts a complete draft", () => {
    expect(scenarioDraftError(GOOD)).toBeNull();
  });

  it("rejects missing scenario / persona fields / rubric / bad max_turns", () => {
    expect(scenarioDraftError({ ...GOOD, scenario: " " })).toContain("scenario");
    expect(scenarioDraftError({ ...GOOD, persona: undefined })).toContain("persona");
    expect(
      scenarioDraftError({ ...GOOD, persona: { ...GOOD.persona!, identity: "" } }),
    ).toContain("identity");
    expect(
      scenarioDraftError({ ...GOOD, persona: { ...GOOD.persona!, goals: [] } }),
    ).toContain("goals");
    expect(
      scenarioDraftError({ ...GOOD, persona: { ...GOOD.persona!, termination: "" } }),
    ).toContain("termination");
    expect(scenarioDraftError({ ...GOOD, rubric: "" })).toContain("rubric");
    expect(scenarioDraftError({ ...GOOD, max_turns: 0 })).toContain("max_turns");
    expect(scenarioDraftError({ ...GOOD, max_turns: 99 })).toContain("max_turns");
  });
});

describe("scenarioDraftToTask", () => {
  it("assembles the full EvalTaskSpec with the judge reward pre-attached", () => {
    const task = scenarioDraftToTask(GOOD, 0) as {
      id: string;
      simulation: { scenario: string; persona: { identity: string }; max_turns: number };
      timeout_ms: number;
      trials: number;
      reward: {
        type: string;
        rubric: string;
        context: string;
        include_transcript: boolean;
        findings: boolean;
      };
    };
    expect(task.id).toBe("lost-invoice");
    expect(task.simulation.scenario).toContain("March invoice");
    expect(task.simulation.max_turns).toBe(8);
    expect(task.timeout_ms).toBe(900_000);
    expect(task.trials).toBe(1);
    expect(task.reward.type).toBe("llm_judge");
    expect(task.reward.include_transcript).toBe(true);
    expect(task.reward.findings).toBe(true);
    expect(task.reward.context).toContain("SIMULATED user");
    expect(task.reward.context).toContain("get the invoice re-sent");
    expect(task.reward.context).toContain("INV-2093");
  });

  it("slugs a fallback id from the scenario text and defaults max_turns", () => {
    const task = scenarioDraftToTask({ ...GOOD, id: undefined, max_turns: undefined }, 2) as {
      id: string;
      simulation: { max_turns: number };
    };
    expect(task.id).toMatch(/^customer-lost-their-march-invoice/);
    expect(task.simulation.max_turns).toBe(10);
  });
});

describe("buildSimJudgeContext", () => {
  it("omits the hidden-knowledge line when absent", () => {
    const ctx = buildSimJudgeContext({
      scenario: "s",
      persona: { goals: ["g"], termination: "t" },
    });
    expect(ctx).not.toContain("held back");
  });
});

describe("buildScenarioAuthorPrompt", () => {
  it("carries agent config, count, focus, and the standing criteria", () => {
    const { system, user } = buildScenarioAuthorPrompt({
      agent: { name: "Support Bot", system: "You help with billing." },
      toolNames: ["bash", "web_fetch"],
      mcpNames: ["stripe"],
      count: 3,
      focus: "prompt injection resistance",
    });
    expect(system).toContain("no-safety-violation");
    expect(system).toContain("JSON array");
    expect(user).toContain("Support Bot");
    expect(user).toContain("You help with billing.");
    expect(user).toContain("bash, web_fetch");
    expect(user).toContain("stripe");
    expect(user).toContain("prompt injection resistance");
    expect(user).toContain("Write 3 scenarios now.");
  });
});

describe("staticScenarioTemplate", () => {
  it("is itself a valid draft (fallback must survive the validation gate)", () => {
    expect(scenarioDraftError(staticScenarioTemplate({ name: "X" }))).toBeNull();
  });
});
