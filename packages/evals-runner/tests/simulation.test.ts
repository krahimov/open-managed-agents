// Pure units for the simulation module: persona prompt composition,
// tolerant turn parsing, transcript reconstruction (both event shapes),
// and the run-level findings rollup.

// @ts-nocheck
import { describe, it, expect } from "vitest";
import {
  buildPersonaPrompt,
  parsePersonaTurn,
  salvageRawMessage,
  transcriptFromEvents,
  aggregateFindings,
  clipFinding,
  maxTurnsOf,
  effectiveSim,
  episodeCount,
} from "@open-managed-agents/evals-runner";

const SIM = {
  scenario: "A customer cannot find their invoice from March.",
  persona: {
    name: "Dana",
    identity: "a busy office manager with low technical patience",
    goals: ["get the March invoice emailed to accounting", "avoid re-authenticating"],
    hidden_knowledge: "The invoice number is INV-2093, but only mention it if asked.",
    communication_style: "terse, impatient",
    termination: "the invoice is located or the agent gives up",
  },
};

describe("buildPersonaPrompt", () => {
  it("composes all persona sections and the JSON reply contract", () => {
    const { system, user } = buildPersonaPrompt(SIM, []);
    expect(system).toContain("role-playing a real human user");
    expect(system).toContain("Dana. a busy office manager");
    expect(system).toContain("- get the March invoice emailed to accounting");
    expect(system).toContain("only share when the agent asks");
    expect(system).toContain("INV-2093");
    expect(system).toContain("terse, impatient");
    expect(system).toContain("the invoice is located or the agent gives up");
    expect(system).toContain('{"action":"message","text":');
    expect(system).toContain('{"action":"end","reason":');
    expect(user).toContain("## Scenario");
    expect(user).toContain("(empty — write your opening message)");
  });

  it("omits optional sections when absent", () => {
    const { system } = buildPersonaPrompt(
      { scenario: "s", persona: { identity: "i", goals: ["g"], termination: "t" } },
      [],
    );
    expect(system).not.toContain("only share when the agent asks");
    expect(system).not.toContain("# How you communicate");
  });

  it("renders the transcript with You/Agent roles", () => {
    const { user } = buildPersonaPrompt(SIM, [
      { role: "persona", text: "where is my invoice" },
      { role: "agent", text: "let me check" },
    ]);
    expect(user).toContain("You: where is my invoice");
    expect(user).toContain("Agent: let me check");
    expect(user).toContain("Write your next turn");
  });

  it("truncates oldest turns first but always keeps the opener", () => {
    const transcript = [{ role: "persona", text: "OPENER-MARKER" }];
    for (let i = 0; i < 100; i++) {
      transcript.push({ role: "agent", text: `agent filler ${i} ${"x".repeat(400)}` });
      transcript.push({ role: "persona", text: `persona filler ${i} ${"y".repeat(400)}` });
    }
    const { user } = buildPersonaPrompt(SIM, transcript);
    expect(user).toContain("OPENER-MARKER");
    expect(user).toContain("…(earlier turns truncated)");
    expect(user).not.toContain("agent filler 0 ");
    expect(user).toContain("persona filler 99");
    expect(user.length).toBeLessThan(30_000);
  });
});

describe("parsePersonaTurn", () => {
  it("parses a bare message object", () => {
    expect(parsePersonaTurn('{"action":"message","text":"hi there"}')).toEqual({
      action: "message",
      text: "hi there",
    });
  });

  it("parses end with and without a reason", () => {
    expect(parsePersonaTurn('{"action":"end","reason":"goal met"}')).toEqual({
      action: "end",
      reason: "goal met",
    });
    expect(parsePersonaTurn('{"action":"end"}')).toEqual({ action: "end", reason: undefined });
  });

  it("extracts from fenced blocks and surrounding prose", () => {
    expect(
      parsePersonaTurn('Sure!\n```json\n{"action":"message","text":"fenced"}\n```'),
    ).toEqual({ action: "message", text: "fenced" });
    expect(
      parsePersonaTurn('Here: {"action":"message","text":"embedded"} — done'),
    ).toEqual({ action: "message", text: "embedded" });
  });

  it("rejects empty text, unknown actions, and non-JSON", () => {
    expect(parsePersonaTurn('{"action":"message","text":""}')).toBeNull();
    expect(parsePersonaTurn('{"action":"shrug"}')).toBeNull();
    expect(parsePersonaTurn("just some prose")).toBeNull();
    expect(parsePersonaTurn("")).toBeNull();
  });
});

describe("salvageRawMessage", () => {
  it("accepts plausible prose", () => {
    expect(salvageRawMessage("  Where is my invoice?  ")).toBe("Where is my invoice?");
  });
  it("rejects empty, JSON-ish, fenced, and oversized text", () => {
    expect(salvageRawMessage("")).toBeNull();
    expect(salvageRawMessage('{"broken": ')).toBeNull();
    expect(salvageRawMessage("```json\nnope")).toBeNull();
    expect(salvageRawMessage("x".repeat(2001))).toBeNull();
  });
});

describe("transcriptFromEvents", () => {
  it("reads CF-shaped events (data as JSON string)", () => {
    const events = [
      { seq: 1, type: "user.message", data: JSON.stringify({ content: [{ type: "text", text: "opener" }] }) },
      { seq: 2, type: "agent.thinking", data: JSON.stringify({ content: [{ type: "text", text: "hmm" }] }) },
      { seq: 3, type: "agent.message", data: JSON.stringify({ content: [{ type: "text", text: "reply" }] }) },
    ];
    expect(transcriptFromEvents(events)).toEqual([
      { role: "persona", text: "opener" },
      { role: "agent", text: "reply" },
    ]);
  });

  it("reads Node-shaped events (data as object) and skips textless ones", () => {
    const events = [
      { seq: 1, type: "user.message", data: { content: [{ type: "text", text: "opener" }] } },
      { seq: 2, type: "agent.message", data: { content: [] } },
      { seq: 3, type: "agent.message", data: { content: [{ type: "text", text: "reply" }] } },
    ];
    expect(transcriptFromEvents(events)).toEqual([
      { role: "persona", text: "opener" },
      { role: "agent", text: "reply" },
    ]);
  });
});

describe("maxTurnsOf", () => {
  it("defaults to 10 and hard-caps at 40", () => {
    expect(maxTurnsOf({ scenario: "s", persona: {} })).toBe(10);
    expect(maxTurnsOf({ scenario: "s", persona: {}, max_turns: 3 })).toBe(3);
    expect(maxTurnsOf({ scenario: "s", persona: {}, max_turns: 99 })).toBe(40);
    expect(maxTurnsOf({ scenario: "s", persona: {}, max_turns: 0 })).toBe(1);
  });
});

describe("aggregateFindings", () => {
  const finding = (over = {}) => ({
    category: "tool_use",
    severity: "minor",
    summary: "s",
    evidence: [],
    recommendation: "r",
    ...over,
  });

  it("is a no-op when no trial has findings", () => {
    const run = { tasks: [{ id: "t1", trials: [{ trial_index: 0 }] }] };
    aggregateFindings(run);
    expect(run.findings_report).toBeUndefined();
  });

  it("groups by category × severity and sorts top by severity with provenance", () => {
    const run = {
      tasks: [
        {
          id: "t1",
          trials: [
            { trial_index: 0, findings: [finding(), finding({ severity: "critical", category: "safety", summary: "bad" })] },
          ],
        },
        { id: "t2", trials: [{ trial_index: 1, findings: [finding({ severity: "major" })] }] },
      ],
    };
    aggregateFindings(run);
    const report = run.findings_report;
    expect(report.by_category).toEqual({
      tool_use: { minor: 1, major: 1 },
      safety: { critical: 1 },
    });
    expect(report.top).toHaveLength(3);
    expect(report.top[0]).toMatchObject({ severity: "critical", task_id: "t1", trial_index: 0 });
    expect(report.top[1]).toMatchObject({ severity: "major", task_id: "t2", trial_index: 1 });
    expect(report.generated_at).toBeTruthy();
  });

  it("clipFinding bounds summary/recommendation/evidence", () => {
    const clipped = clipFinding(
      finding({ summary: "s".repeat(500), recommendation: "r".repeat(500), evidence: Array(20).fill("e") }),
    );
    expect(clipped.summary).toHaveLength(300);
    expect(clipped.recommendation).toHaveLength(300);
    expect(clipped.evidence).toHaveLength(8);
  });
});


describe("effectiveSim / episodeCount", () => {
  const base = {
    scenario: "Base scenario.",
    persona: { name: "Sam", identity: "owner", goals: ["g1"], termination: "done" },
    max_turns: 8,
    persona_model: { model_card_id: "card" },
    memory_store: { fresh: true },
    episodes: [
      { gap_description: "two weeks later", persona: { goals: ["g2"] }, max_turns: 3 },
      { scenario: "Totally new situation.", opening_message: "hey again" },
    ],
  };

  it("counts episode 0 plus follow-ups", () => {
    expect(episodeCount(base)).toBe(3);
    expect(episodeCount({ ...base, episodes: undefined })).toBe(1);
  });

  it("episode 0 is the top-level spec verbatim", () => {
    expect(effectiveSim(base, 0)).toBe(base);
  });

  it("follow-up episodes overlay overrides, merge persona shallowly, surface the gap to the persona", () => {
    const ep1 = effectiveSim(base, 1);
    expect(ep1.scenario).toContain("two weeks later");
    expect(ep1.scenario).toContain("does not automatically remember");
    expect(ep1.scenario).toContain("Base scenario.");
    expect(ep1.persona).toEqual({ name: "Sam", identity: "owner", goals: ["g2"], termination: "done" });
    expect(ep1.max_turns).toBe(3);
    expect(ep1.opening_message).toBeUndefined();
    expect(ep1.persona_model).toEqual({ model_card_id: "card" });
    expect(ep1.memory_store).toEqual({ fresh: true });
    expect(ep1.episodes).toBeUndefined();

    const ep2 = effectiveSim(base, 2);
    expect(ep2.scenario).toBe("Totally new situation.");
    expect(ep2.opening_message).toBe("hey again");
    expect(ep2.max_turns).toBe(8);
  });

  it("out-of-range index falls back to the top-level spec", () => {
    expect(effectiveSim(base, 9)).toBe(base);
  });
});
