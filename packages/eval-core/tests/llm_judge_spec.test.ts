// Phase 2 (evals-design §4) acceptance tests: serializable llm_judge
// RewardSpec, spec-driven judge verifier, and the composite gate
// short-circuit. The JudgeFn is always a fake — model resolution is the
// consumer's job and is tested at the runner/wiring layer.

// @ts-nocheck
import { describe, it, expect } from "vitest";
import {
  verifierForSpec,
  SpecLlmJudgeVerifier,
  parseJudgeVerdict,
} from "@open-managed-agents/eval-core";
import type { Trajectory } from "@open-managed-agents/eval-core";

function ev(seq: number, type: string, data: object = {}) {
  return { seq, type, data: JSON.stringify({ type, ...data }), ts: "2026-07-24T10:00:00Z" };
}

function makeTrajectory(events: any[], extra: object = {}): Trajectory {
  return {
    schema_version: "oma.trajectory.v1",
    trajectory_id: "tr-1",
    session_id: "sess-1",
    agent_config: {} as any,
    environment_config: {} as any,
    model: { id: "test-model", provider: "" },
    started_at: "2026-07-24T10:00:00Z",
    outcome: "success",
    events,
    summary: {} as any,
    ...extra,
  };
}

const baseEvents = [
  ev(1, "user.message", { content: [{ type: "text", text: "Write a revenue model" }] }),
  ev(2, "agent.message", { content: [{ type: "text", text: "Working on it, hold tight…" }] }),
  ev(3, "user.message", { content: [{ type: "text", text: "Also add a 5yr projection" }] }),
  ev(4, "agent.message", { content: [{ type: "text", text: "Done — model written to /workspace/model.md" }] }),
];

const goodVerdict = {
  criteria: [
    { id: "revenue-5yr", pass: true, evidence: ["sevt_abc123"], reasoning: "projection present" },
    { id: "sources-cited", pass: false, evidence: [], reasoning: "no citations found" },
  ],
  pass: false,
  score: 0.5,
  summary: "5yr projection present but sources are missing",
};

function judgeReturning(text: string, usage?: object) {
  const calls: Array<{ system: string; user: string }> = [];
  const fn = async (prompt) => {
    calls.push(prompt);
    return { text, usage };
  };
  return { fn, calls };
}

function ctxWith(judge, extras: object = {}) {
  return {
    sessionId: "sess-1",
    runExec: async () => ({ exit_code: 0, output: "" }),
    resolveJudge: async () => ({
      judge,
      judgeModelId: "claude-opus-4-8",
      judgeReasoningLevel: "max",
    }),
    ...extras,
  };
}

describe("verifierForSpec dispatch: llm_judge", () => {
  it("resolves type:'llm_judge' to SpecLlmJudgeVerifier", () => {
    const v = verifierForSpec(
      { type: "llm_judge", rubric: "## Criteria\n- works" },
      { sessionId: "s", runExec: async () => ({ exit_code: 0, output: "" }) },
    );
    expect(v).toBeInstanceOf(SpecLlmJudgeVerifier);
    expect(v.id).toBe("llm_judge_spec.v2");
  });
});

describe("SpecLlmJudgeVerifier", () => {
  it("maps a structured verdict onto Score (value, pass, criteria, verdict, usage, judge identity)", async () => {
    const { fn } = judgeReturning(JSON.stringify(goodVerdict), {
      input_tokens: 100,
      output_tokens: 50,
    });
    const v = verifierForSpec(
      { type: "llm_judge", rubric: "## Criteria\n- revenue-5yr\n- sources-cited" },
      ctxWith(fn),
    );
    const score = await v.check(makeTrajectory(baseEvents));
    expect(score.value).toBe(0.5);
    expect(score.pass).toBe(false);
    expect(score.reason).toBe("5yr projection present but sources are missing");
    expect(score.metadata.criteria).toEqual({ "revenue-5yr": 1, "sources-cited": 0 });
    expect(score.metadata.verdict.criteria[0].evidence).toEqual(["sevt_abc123"]);
    expect(score.metadata.usage).toEqual({ input_tokens: 100, output_tokens: 50 });
    expect(score.metadata.judge_model_id).toBe("claude-opus-4-8");
    expect(score.metadata.judge_reasoning_level).toBe("max");
    // reward.verifier_id (read after check) records judge identity
    expect(v.id).toBe("llm_judge_spec.claude-opus-4-8.v2");
  });

  it("scores 0 with 'unavailable' when ctx.resolveJudge is absent", async () => {
    const v = verifierForSpec(
      { type: "llm_judge", rubric: "r" },
      { sessionId: "s", runExec: async () => ({ exit_code: 0, output: "" }) },
    );
    const score = await v.check(makeTrajectory(baseEvents));
    expect(score.pass).toBe(false);
    expect(score.value).toBe(0);
    expect(score.reason).toBe("llm_judge unavailable on this runtime");
  });

  it("scores 0 with 'unavailable' when resolveJudge returns null or throws", async () => {
    for (const resolveJudge of [async () => null, async () => { throw new Error("boom"); }]) {
      const v = verifierForSpec(
        { type: "llm_judge", rubric: "r" },
        { sessionId: "s", runExec: async () => ({ exit_code: 0, output: "" }), resolveJudge },
      );
      const score = await v.check(makeTrajectory(baseEvents));
      expect(score.value).toBe(0);
      expect(score.reason).toBe("llm_judge unavailable on this runtime");
    }
  });

  it("retries on unparseable output, then succeeds", async () => {
    let attempt = 0;
    const judge = async () => {
      attempt++;
      return { text: attempt === 1 ? "sorry, thinking…" : "```json\n" + JSON.stringify(goodVerdict) + "\n```" };
    };
    const v = new SpecLlmJudgeVerifier({ type: "llm_judge", rubric: "r" }, ctxWith(judge), {
      maxRetries: 2,
    });
    const score = await v.check(makeTrajectory(baseEvents));
    expect(attempt).toBe(2);
    expect(score.value).toBe(0.5);
  });

  it("exhausts retries into a 0 score, never throws", async () => {
    const judge = async () => ({ text: "not json at all" });
    const v = new SpecLlmJudgeVerifier({ type: "llm_judge", rubric: "r" }, ctxWith(judge), {
      maxRetries: 0,
    });
    const score = await v.check(makeTrajectory(baseEvents));
    expect(score.pass).toBe(false);
    expect(score.value).toBe(0);
    expect(score.reason).toMatch(/exhausted retries/);
  });

  it("prompt carries task + rubric + FINAL agent message only (no intermediate prose by default)", async () => {
    const { fn, calls } = judgeReturning(JSON.stringify(goodVerdict));
    const v = verifierForSpec({ type: "llm_judge", rubric: "RUBRIC-MARKER" }, ctxWith(fn));
    await v.check(makeTrajectory(baseEvents));
    const user = calls[0].user;
    expect(user).toContain("Write a revenue model");
    expect(user).toContain("Also add a 5yr projection");
    expect(user).toContain("RUBRIC-MARKER");
    expect(user).toContain("Done — model written to /workspace/model.md");
    // anti-anchoring: the intermediate agent message is excluded
    expect(user).not.toContain("Working on it, hold tight");
  });

  it("include_transcript:true adds the full agent transcript", async () => {
    const { fn, calls } = judgeReturning(JSON.stringify(goodVerdict));
    const v = verifierForSpec(
      { type: "llm_judge", rubric: "r", include_transcript: true },
      ctxWith(fn),
    );
    await v.check(makeTrajectory(baseEvents));
    expect(calls[0].user).toContain("Working on it, hold tight");
  });

  it("adds a bounded workspace section via runExec and cats files from trace_facts", async () => {
    const execCalls: string[] = [];
    const runExec = async (cmd: string) => {
      execCalls.push(cmd);
      if (cmd === "ls -la") return { exit_code: 0, output: "total 8\n-rw-r--r-- model.md" };
      return { exit_code: 0, output: "## Revenue model\nyear1: 100" };
    };
    const { fn, calls } = judgeReturning(JSON.stringify(goodVerdict));
    const v = verifierForSpec({ type: "llm_judge", rubric: "r" }, ctxWith(fn, { runExec }));
    const traj = makeTrajectory(baseEvents, {
      trace_facts: {
        files_written: [{ path: "/workspace/model.md", event_id: "sevt_f1" }],
      },
    });
    await v.check(traj);
    expect(execCalls[0]).toBe("ls -la");
    expect(execCalls[1]).toContain("'/workspace/model.md'");
    const user = calls[0].user;
    expect(user).toContain("-rw-r--r-- model.md");
    expect(user).toContain("file:/workspace/model.md");
    expect(user).toContain("year1: 100");
    // trace facts serialized + labeled as code-extracted
    expect(user).toContain("Extracted by code");
    expect(user).toContain("sevt_f1");
  });

  it("renders trace_facts as a terse table (not raw JSON), event ids included", async () => {
    const { fn, calls } = judgeReturning(JSON.stringify(goodVerdict));
    const v = verifierForSpec({ type: "llm_judge", rubric: "r" }, ctxWith(fn));
    const traj = makeTrajectory(baseEvents, {
      trace_facts: {
        outcome: "success",
        turns: 4,
        duration_ms: 61_000,
        token_usage: { input_tokens: 1200, output_tokens: 340 },
        tools: [{ name: "bash", calls: 5, errors: 1 }],
        exec_commands: [{ command_head: "npm test", exit_code: 0, event_id: "sevt_ex1" }],
        files_written: [{ path: "/workspace/model.md", event_id: "sevt_f1" }],
        errors: [{ event_id: "sevt_er1", message_head: "boom" }],
        repeated_call_loops: [{ tool: "bash", count: 4 }],
      },
    });
    await v.check(traj);
    const user = calls[0].user;
    expect(user).toContain("outcome=success | turns=4 | duration_ms=61000 | tokens_in=1200 | tokens_out=340");
    expect(user).toContain("bash | 5 | 1");
    expect(user).toContain("sevt_ex1 | exit=0 | npm test");
    expect(user).toContain("sevt_f1 | /workspace/model.md");
    expect(user).toContain("sevt_er1 | boom");
    expect(user).toContain("bash | x4");
    // terse table, not a JSON dump of the facts object
    expect(user).not.toContain('"exec_commands"');
  });

  it("falls back to raw JSON for unrecognized trace_facts shapes", async () => {
    const { fn, calls } = judgeReturning(JSON.stringify(goodVerdict));
    const v = verifierForSpec({ type: "llm_judge", rubric: "r" }, ctxWith(fn));
    const traj = makeTrajectory(baseEvents, {
      trace_facts: { some_future_field: "still-reaches-the-judge" },
    });
    await v.check(traj);
    expect(calls[0].user).toContain("still-reaches-the-judge");
  });

  it("sweeps /mnt/session/outputs for bash-created artifacts the cwd sweep misses", async () => {
    const execCalls: string[] = [];
    const runExec = async (cmd: string) => {
      execCalls.push(cmd);
      if (cmd === "ls -la") return { exit_code: 0, output: "total 0" };
      if (cmd.startsWith("find .")) return { exit_code: 0, output: "" };
      if (cmd.startsWith("find /mnt/session/outputs")) {
        return { exit_code: 0, output: "/mnt/session/outputs/report.md\n" };
      }
      return { exit_code: 0, output: "# Delivered report" };
    };
    const { fn, calls } = judgeReturning(JSON.stringify(goodVerdict));
    const v = verifierForSpec({ type: "llm_judge", rubric: "r" }, ctxWith(fn, { runExec }));
    await v.check(makeTrajectory(baseEvents));
    expect(execCalls.some((c) => c.startsWith("find /mnt/session/outputs"))).toBe(true);
    const user = calls[0].user;
    expect(user).toContain("file:/mnt/session/outputs/report.md");
    expect(user).toContain("# Delivered report");
  });

  it("system prompt teaches the outputs-directory platform convention", async () => {
    const { fn, calls } = judgeReturning(JSON.stringify(goodVerdict));
    await verifierForSpec({ type: "llm_judge", rubric: "r" }, ctxWith(fn))
      .check(makeTrajectory(baseEvents));
    expect(calls[0].system).toContain("/mnt/session/outputs/");
    expect(calls[0].system).toContain("never as data leaving the workspace");
  });

  it("renders prior_episodes and memory_store sections when the trajectory carries them", async () => {
    const { fn, calls } = judgeReturning(JSON.stringify(goodVerdict));
    const v = verifierForSpec({ type: "llm_judge", rubric: "r" }, ctxWith(fn));
    await v.check(makeTrajectory(baseEvents, {
      prior_episodes: [{ index: 0, transcript: "User: remember I hate Mondays\nAgent: noted", trajectory_id: "tr-0" }],
      memory_store: { store_id: "mem_1", files: [{ path: "prefs.md", content: "hates Mondays" }] },
    }));
    const user = calls[0].user;
    expect(user).toContain("## Prior episodes");
    expect(user).toContain("### Episode 1");
    expect(user).toContain("remember I hate Mondays");
    expect(user).toContain("NO shared chat history");
    expect(user).toContain("## Memory store (final contents");
    expect(user).toContain("file:memory/prefs.md");
    expect(user).toContain("hates Mondays");
  });

  it("marks an empty memory store explicitly and omits sections when fields are absent", async () => {
    const a = judgeReturning(JSON.stringify(goodVerdict));
    await verifierForSpec({ type: "llm_judge", rubric: "r" }, ctxWith(a.fn))
      .check(makeTrajectory(baseEvents, { memory_store: { store_id: "m", files: [] } }));
    expect(a.calls[0].user).toContain("store is EMPTY");
    const b = judgeReturning(JSON.stringify(goodVerdict));
    await verifierForSpec({ type: "llm_judge", rubric: "r" }, ctxWith(b.fn)).check(makeTrajectory(baseEvents));
    expect(b.calls[0].user).not.toContain("## Memory store");
    expect(b.calls[0].user).not.toContain("## Prior episodes");
  });

  it("survives runExec failure (workspace section skipped, verdict still produced)", async () => {
    const runExec = async () => { throw new Error("sandbox gone"); };
    const { fn } = judgeReturning(JSON.stringify(goodVerdict));
    const v = verifierForSpec({ type: "llm_judge", rubric: "r" }, ctxWith(fn, { runExec }));
    const score = await v.check(makeTrajectory(baseEvents));
    expect(score.value).toBe(0.5);
  });
});

describe("parseJudgeVerdict tolerance", () => {
  it("derives score/pass from criteria when the judge omits them", () => {
    const verdict = parseJudgeVerdict(
      JSON.stringify({
        criteria: [
          { id: "a", pass: true },
          { id: "b", pass: true },
          { id: "c", pass: false },
        ],
        summary: "2 of 3",
      }),
    );
    expect(verdict.score).toBeCloseTo(2 / 3, 5);
    expect(verdict.pass).toBe(false);
    expect(verdict.criteria[0].evidence).toEqual([]);
  });

  it("extracts a nested object from surrounding prose", () => {
    const verdict = parseJudgeVerdict(
      `Here's my judgement:\n${JSON.stringify(goodVerdict)}\nHope that helps!`,
    );
    expect(verdict.score).toBe(0.5);
    expect(verdict.criteria).toHaveLength(2);
  });

  it("rejects objects without a criteria array", () => {
    expect(parseJudgeVerdict(JSON.stringify({ pass: true, score: 1 }))).toBeNull();
    expect(parseJudgeVerdict("")).toBeNull();
  });

  it("clamps out-of-range scores to 0..1", () => {
    const verdict = parseJudgeVerdict(
      JSON.stringify({ criteria: [{ id: "a", pass: true }], score: 3, pass: true, summary: "s" }),
    );
    expect(verdict.score).toBe(1);
  });
});

describe("judge context + findings (simulations)", () => {
  it("spec.context is prepended as ## Context before ## Task", async () => {
    const { fn, calls } = judgeReturning(JSON.stringify(goodVerdict));
    const v = verifierForSpec(
      { type: "llm_judge", rubric: "r", context: "CONTEXT-MARKER: persona wants the March invoice" },
      ctxWith(fn),
    );
    await v.check(makeTrajectory(baseEvents));
    const user = calls[0].user;
    expect(user).toContain("## Context\nCONTEXT-MARKER");
    expect(user.indexOf("## Context")).toBeLessThan(user.indexOf("## Task"));
  });

  it("spec.findings:true adds the findings contract to the system prompt; absent otherwise", async () => {
    const { fn, calls } = judgeReturning(JSON.stringify(goodVerdict));
    await verifierForSpec({ type: "llm_judge", rubric: "r", findings: true }, ctxWith(fn))
      .check(makeTrajectory(baseEvents));
    expect(calls[0].system).toContain('"findings"');
    expect(calls[0].system).toContain("OPERATOR");

    const plain = judgeReturning(JSON.stringify(goodVerdict));
    await verifierForSpec({ type: "llm_judge", rubric: "r" }, ctxWith(plain.fn))
      .check(makeTrajectory(baseEvents));
    expect(plain.calls[0].system).not.toContain('"findings"');
  });

  it("parses findings tolerantly: valid kept, invalid dropped, unknown enums defaulted", async () => {
    const verdictWithFindings = {
      ...goodVerdict,
      findings: [
        {
          category: "tool_use",
          severity: "major",
          summary: "agent ran rm -rf on user data without confirmation",
          evidence: ["sevt_x1"],
          recommendation: "add a deny rule for destructive bash commands",
        },
        { category: "made-up", severity: "catastrophic", summary: "weird enums", evidence: [], recommendation: "" },
        { severity: "minor" }, // no summary → dropped
        "not an object",
      ],
    };
    const { fn } = judgeReturning(JSON.stringify(verdictWithFindings));
    const v = verifierForSpec({ type: "llm_judge", rubric: "r", findings: true }, ctxWith(fn));
    const score = await v.check(makeTrajectory(baseEvents));
    const findings = score.metadata.verdict.findings;
    expect(findings).toHaveLength(2);
    expect(findings[0]).toEqual({
      category: "tool_use",
      severity: "major",
      summary: "agent ran rm -rf on user data without confirmation",
      evidence: ["sevt_x1"],
      recommendation: "add a deny rule for destructive bash commands",
    });
    expect(findings[1].category).toBe("task");
    expect(findings[1].severity).toBe("info");
  });

  it("verdicts without findings still parse (old prompts / non-simulation specs)", () => {
    const verdict = parseJudgeVerdict(JSON.stringify(goodVerdict));
    expect(verdict.findings).toBeUndefined();
  });
});

describe("composite gate short-circuit (§4.4)", () => {
  const gateSpec = (gateExit: number, judgeFlag: { invoked: boolean }) => ({
    spec: {
      type: "composite",
      components: [
        { name: "gate:no-error", weight: 0, verifier: { type: "script", verify_script: "check" } },
        { name: "judge", weight: 1, verifier: { type: "llm_judge", rubric: "r" } },
      ],
    },
    ctx: {
      sessionId: "s",
      runExec: async () => ({ exit_code: gateExit, output: gateExit === 0 ? "" : "crashed" }),
      resolveJudge: async () => {
        judgeFlag.invoked = true;
        return {
          judge: async () => ({ text: JSON.stringify({ criteria: [{ id: "a", pass: true }], pass: true, score: 1, summary: "ok" }) }),
          judgeModelId: "gpt-5.6-sol",
          judgeReasoningLevel: "max",
        };
      },
    },
  });

  it("a gate:* component scoring 0 skips the judge and scores 0 naming the gate", async () => {
    const judgeFlag = { invoked: false };
    const { spec, ctx } = gateSpec(1, judgeFlag);
    const score = await verifierForSpec(spec, ctx).check(makeTrajectory(baseEvents));
    expect(score.pass).toBe(false);
    expect(score.value).toBe(0);
    expect(score.reason).toContain('gate "gate:no-error" failed');
    expect(score.metadata.gate_failed).toBe("gate:no-error");
    expect(judgeFlag.invoked).toBe(false);
  });

  it("a passing gate lets later components run and aggregate normally", async () => {
    const judgeFlag = { invoked: false };
    const { spec, ctx } = gateSpec(0, judgeFlag);
    const score = await verifierForSpec(spec, ctx).check(makeTrajectory(baseEvents));
    expect(judgeFlag.invoked).toBe(true);
    expect(score.pass).toBe(true);
    // weights: gate 0, judge 1 → value = judge score
    expect(score.value).toBe(1);
    expect(score.metadata.criteria).toEqual({ "gate:no-error": 1, judge: 1 });
  });

  it("specs without gate:* components keep the parallel aggregation path", async () => {
    let calls = 0;
    const ctx = {
      sessionId: "s",
      runExec: async () => {
        calls++;
        return { exit_code: calls === 1 ? 0 : 1, output: "" };
      },
    };
    const score = await verifierForSpec(
      {
        type: "composite",
        components: [
          { name: "tests", weight: 3, verifier: { type: "script", verify_script: "a" } },
          { name: "lint", weight: 1, verifier: { type: "script", verify_script: "b" } },
        ],
      },
      ctx,
    ).check(makeTrajectory([]));
    expect(score.value).toBeCloseTo(0.75, 5);
  });
});
