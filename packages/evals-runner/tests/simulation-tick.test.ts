// End-to-end simulation trials through tickEvalRuns with a fully faked
// runtime: in-memory eval-run service, stub agents/environments/sessions,
// a fake SandboxFetcher that synthesizes agent replies, and a scripted
// resolveJudge that plays both the persona (rubric === "") and the judge
// (rubric set). simTickBudgetMs: 0 → exactly one persona turn per tick,
// so the state machine is stepped deterministically with no sleeps.

// @ts-nocheck
import { describe, it, expect } from "vitest";
import { tickEvalRuns, regradeRun } from "@open-managed-agents/evals-runner";
import { InMemoryKvStore } from "@open-managed-agents/kv-store";
import { createInMemoryEvalRunService } from "@open-managed-agents/evals-store/test-fakes";

const TENANT = "tenant_a";

/** Fake sandbox: per-session event log; every posted user.message gets an
 *  immediate synthesized agent reply; status is always idle. */
function makeFakeSandbox() {
  const logs = new Map(); // sessionId → events[]
  const eventsOf = (id) => {
    if (!logs.has(id)) logs.set(id, []);
    return logs.get(id);
  };
  const fetcher = {
    fetch: async (input) => {
      const req = input instanceof Request ? input : new Request(input);
      const url = new URL(req.url);
      const m = url.pathname.match(/^\/sessions\/([^/]+)(\/.*)?$/);
      const sessionId = m?.[1];
      const rest = m?.[2] ?? "";
      const json = (body, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

      if (rest === "/init") return json({ ok: true });
      if (rest === "/exec") return json({ exit_code: 0, output: "" });
      if (rest === "/status") return json({ status: "idle" });
      if (rest === "/full-status") return json({}, 404);
      if (rest === "/event") {
        const body = await req.json();
        const events = eventsOf(sessionId);
        events.push({ seq: events.length + 1, type: body.type, data: JSON.stringify(body), ts: new Date().toISOString() });
        if (body.type === "user.message") {
          const n = events.filter((e) => e.type === "agent.message").length + 1;
          events.push({
            seq: events.length + 1,
            type: "agent.message",
            data: JSON.stringify({ content: [{ type: "text", text: `agent reply ${n}` }] }),
            ts: new Date().toISOString(),
          });
        }
        return json({ ok: true });
      }
      if (rest.startsWith("/events")) {
        const afterSeq = Number(url.searchParams.get("after_seq") ?? 0);
        const data = eventsOf(sessionId).filter((e) => e.seq > afterSeq);
        return json({ data, has_more: false });
      }
      return json({ error: `unhandled ${rest}` }, 500);
    },
  };
  return { fetcher, logs, eventsOf };
}

const CANNED_VERDICT = {
  criteria: [{ id: "goal-met", pass: true, evidence: ["sevt_1"], reasoning: "ok" }],
  pass: true,
  score: 1,
  summary: "goal achieved",
  findings: [
    {
      category: "tool_use",
      severity: "major",
      summary: "agent used bash where a dedicated tool existed",
      evidence: ["sevt_2"],
      recommendation: "restrict bash in the agent policy",
    },
  ],
};

/**
 * opts.personaScript: array of raw persona-LLM reply strings, consumed in
 * order (opener first). opts.resolveJudge: override the resolver entirely
 * (null → no resolver on the runtime).
 */
function makeHarness(taskSpec, opts = {}) {
  const kv = new InMemoryKvStore();
  const { service: evals } = createInMemoryEvalRunService();
  const sandbox = makeFakeSandbox();
  const sessions = new Map();
  let sessionSeq = 0;

  const personaScript = [...(opts.personaScript ?? [])];
  const personaPrompts = [];

  const services = {
    agents: {
      get: async ({ agentId }) =>
        agentId === "agent_1" ? { id: "agent_1", tenant_id: TENANT, name: "Agent One", model: "test-model" } : null,
    },
    environments: { get: async () => null },
    sessions: {
      create: async (input) => {
        const id = `sess_${++sessionSeq}`;
        const row = {
          id,
          agent_id: input.agentId,
          environment_id: input.environmentId,
          title: input.title,
          status: "active",
          created_at: new Date().toISOString(),
          metadata: null,
          agent_snapshot: input.agentSnapshot ?? null,
          environment_snapshot: input.environmentSnapshot ?? null,
        };
        sessions.set(id, row);
        return { session: row };
      },
      update: async ({ sessionId, metadata }) => {
        const row = sessions.get(sessionId);
        if (row && metadata) row.metadata = metadata;
        return row;
      },
      get: async ({ sessionId }) => sessions.get(sessionId) ?? null,
    },
    evals,
    kv,
  };

  const defaultResolver = async (_tenant, _agent, spec) => {
    if (spec.rubric === "") {
      // persona
      return {
        judge: async (prompt) => {
          personaPrompts.push(prompt);
          const text = personaScript.shift() ?? '{"action":"end","reason":"script drained"}';
          return { text, usage: { input_tokens: 10, output_tokens: 5 } };
        },
        judgeModelId: "persona-model",
        judgeReasoningLevel: "low",
      };
    }
    return {
      judge: async () => ({ text: JSON.stringify(CANNED_VERDICT), usage: { input_tokens: 50, output_tokens: 20 } }),
      judgeModelId: "judge-model",
      judgeReasoningLevel: "max",
    };
  };

  // Fake memory port: in-memory stores + attachments; mirrors the Node
  // adapter's contract closely enough for the runner's control flow.
  const memory = {
    stores: new Map(),        // storeId → Map(path → content)
    attachments: [],          // {sessionId, storeId, access}
    port: {
      provisionStore: async ({ name }) => {
        const id = `mem_${memory.stores.size + 1}`;
        memory.stores.set(id, new Map());
        memory.lastName = name;
        return { id };
      },
      attachToSession: async ({ sessionId, storeId, access }) => {
        if (!memory.stores.has(storeId)) memory.stores.set(storeId, new Map());
        memory.attachments.push({ sessionId, storeId, access });
      },
      writeFile: async ({ storeId, path, content }) => {
        if (!memory.stores.has(storeId)) memory.stores.set(storeId, new Map());
        memory.stores.get(storeId).set(path, content);
      },
      listFiles: async ({ storeId }) =>
        [...(memory.stores.get(storeId) ?? new Map())].map(([path, content]) => ({ path, content })),
    },
  };

  const ctx = {
    forEachShard: async (fn) => [await fn(services)],
    getServicesForTenant: async () => services,
    getSandboxBinding: async () => sandbox.fetcher,
    resolveJudge: opts.resolveJudge === null ? undefined : (opts.resolveJudge ?? defaultResolver),
    simTickBudgetMs: 0,
    ...(opts.memory === null ? {} : { memory: memory.port }),
  };

  const createRun = () =>
    evals.create({
      tenantId: TENANT,
      agentId: "agent_1",
      environmentId: "env_1",
      results: {
        task_count: 1,
        completed_count: 0,
        failed_count: 0,
        tasks: [
          {
            id: taskSpec.id,
            spec: taskSpec,
            status: "pending",
            trials: [{ trial_index: 0, status: "pending" }],
            trial_total: 1,
          },
        ],
      },
    });

  const tickUntilTerminal = async (maxTicks = 25) => {
    for (let i = 0; i < maxTicks; i++) {
      await tickEvalRuns(ctx);
      const active = await evals.listActive();
      if (active.length === 0) break;
    }
    const rows = await evals.list({ tenantId: TENANT, limit: 10 });
    return rows[0];
  };

  return { ctx, evals, kv, sandbox, sessions, createRun, tickUntilTerminal, personaPrompts, memory };
}

const SIM_SPEC = {
  id: "sim-1",
  simulation: {
    scenario: "Customer lost their March invoice.",
    persona: {
      identity: "busy office manager",
      goals: ["get the invoice"],
      termination: "invoice found",
    },
    max_turns: 10,
  },
  reward: { type: "llm_judge", rubric: "- goal-met", include_transcript: true, findings: true },
};

describe("simulation trials through tickEvalRuns", () => {
  it("runs a persona-driven conversation to a persona end, judges it, and rolls up findings", async () => {
    const h = makeHarness(SIM_SPEC, {
      personaScript: [
        '{"action":"message","text":"where is my March invoice?"}',
        '{"action":"message","text":"it is INV-2093"}',
        '{"action":"end","reason":"invoice located"}',
      ],
    });
    await h.createRun();
    const row = await h.tickUntilTerminal();

    expect(row.status).toBe("completed");
    const task = row.results.tasks[0];
    const trial = task.trials[0];
    expect(trial.status).toBe("completed");
    expect(trial.persona_turns).toBe(2);
    expect(trial.sim_ended_by).toBe("persona");
    expect(trial.persona_model_id).toBe("persona-model");
    expect(trial.persona_usage.calls).toBe(3);
    expect(trial.reward).toBe(1);
    expect(trial.ungraded).toBeUndefined();
    expect(task.pass_at_k).toBe(true);

    // Conversation actually reached the session event log, in order.
    const events = h.sandbox.eventsOf(trial.session_id);
    const userTexts = events
      .filter((e) => e.type === "user.message")
      .map((e) => JSON.parse(e.data).content[0].text);
    expect(userTexts).toEqual(["where is my March invoice?", "it is INV-2093"]);

    // Persona saw the agent's replies in its prompt on the second turn.
    expect(h.personaPrompts[1].user).toContain("Agent: agent reply 1");
    expect(h.personaPrompts[1].user).toContain("You: where is my March invoice?");

    // Findings copied onto the trial and rolled up on the run.
    expect(trial.findings).toHaveLength(1);
    expect(trial.findings[0].recommendation).toContain("restrict bash");
    expect(row.results.findings_report.by_category).toEqual({ tool_use: { major: 1 } });
    expect(row.results.findings_report.top[0]).toMatchObject({ task_id: "sim-1", trial_index: 0 });

    // Stored trajectory carries the judged reward.
    const rawTraj = await h.kv.get(`t:${TENANT}:trajectory:${trial.trajectory_id}`);
    expect(JSON.parse(rawTraj).reward.final_reward).toBe(1);
  });

  it("uses a fixed opening_message verbatim as turn 1", async () => {
    const spec = {
      ...SIM_SPEC,
      simulation: { ...SIM_SPEC.simulation, opening_message: "EXACT OPENER" },
    };
    const h = makeHarness(spec, {
      personaScript: ['{"action":"end","reason":"done"}'],
    });
    await h.createRun();
    const row = await h.tickUntilTerminal();
    const trial = row.results.tasks[0].trials[0];
    const events = h.sandbox.eventsOf(trial.session_id);
    const userTexts = events
      .filter((e) => e.type === "user.message")
      .map((e) => JSON.parse(e.data).content[0].text);
    expect(userTexts).toEqual(["EXACT OPENER"]);
    expect(trial.sim_ended_by).toBe("persona");
  });

  it("cuts the conversation at max_turns", async () => {
    const spec = {
      ...SIM_SPEC,
      simulation: { ...SIM_SPEC.simulation, max_turns: 2 },
    };
    const h = makeHarness(spec, {
      personaScript: Array(10).fill('{"action":"message","text":"still going"}'),
    });
    await h.createRun();
    const row = await h.tickUntilTerminal();
    const trial = row.results.tasks[0].trials[0];
    expect(trial.status).toBe("completed");
    expect(trial.sim_ended_by).toBe("max_turns");
    expect(trial.persona_turns).toBe(2);
    const userCount = h.sandbox
      .eventsOf(trial.session_id)
      .filter((e) => e.type === "user.message").length;
    expect(userCount).toBe(2);
  });

  it("scripted_messages runs deterministically without any resolver for the persona", async () => {
    const spec = {
      id: "sim-scripted",
      simulation: {
        scenario: "s",
        persona: {
          identity: "i",
          goals: ["g"],
          termination: "t",
          scripted_messages: ["first", "second"],
        },
      },
      // no reward → default trial-status reward 1, judge never resolved
    };
    const h = makeHarness(spec, { resolveJudge: null });
    await h.createRun();
    const row = await h.tickUntilTerminal();
    const trial = row.results.tasks[0].trials[0];
    expect(row.status).toBe("completed");
    expect(trial.sim_ended_by).toBe("persona");
    const userTexts = h.sandbox
      .eventsOf(trial.session_id)
      .filter((e) => e.type === "user.message")
      .map((e) => JSON.parse(e.data).content[0].text);
    expect(userTexts).toEqual(["first", "second"]);
    expect(trial.reward).toBe(1);
  });

  it("fails the trial with a clear error when the runtime has no resolver", async () => {
    const h = makeHarness(SIM_SPEC, { resolveJudge: null });
    await h.createRun();
    const row = await h.tickUntilTerminal();
    expect(row.status).toBe("failed");
    const trial = row.results.tasks[0].trials[0];
    expect(trial.status).toBe("failed");
    expect(trial.error).toContain("requires an LLM resolver");
  });

  it("fails the trial on persistent persona parse failure (no silent loop)", async () => {
    const h = makeHarness(SIM_SPEC, {
      personaScript: ['{"broken', '{"also broken'],
    });
    await h.createRun();
    const row = await h.tickUntilTerminal();
    expect(row.status).toBe("failed");
    const trial = row.results.tasks[0].trials[0];
    expect(trial.error).toContain("persona_parse_failure");
  });

  it("salvages a plausible prose reply as the message after JSON retries", async () => {
    const h = makeHarness(SIM_SPEC, {
      personaScript: [
        "not json",
        "Where is my invoice, please?",
        '{"action":"end","reason":"ok"}',
      ],
    });
    await h.createRun();
    const row = await h.tickUntilTerminal();
    const trial = row.results.tasks[0].trials[0];
    expect(trial.status).toBe("completed");
    const userTexts = h.sandbox
      .eventsOf(trial.session_id)
      .filter((e) => e.type === "user.message")
      .map((e) => JSON.parse(e.data).content[0].text);
    expect(userTexts).toEqual(["Where is my invoice, please?"]);
  });

  it("regradeRun re-runs only the verifier on stored trajectories and recomputes rollups", async () => {
    const h = makeHarness(SIM_SPEC, {
      personaScript: [
        '{"action":"message","text":"where is my invoice?"}',
        '{"action":"end","reason":"done"}',
      ],
    });
    await h.createRun();
    let row = await h.tickUntilTerminal();
    const trial = row.results.tasks[0].trials[0];
    expect(trial.reward).toBe(1);
    expect(row.results.findings_report.by_category).toEqual({ tool_use: { major: 1 } });

    // A "fixed judge" now acquits: passes everything, emits no findings.
    const acquittal = {
      criteria: [{ id: "goal-met", pass: true, evidence: ["sevt_1"], reasoning: "ok" }],
      pass: true, score: 1, summary: "clean", findings: [],
    };
    const userMsgsBefore = h.sandbox.eventsOf(trial.session_id)
      .filter((e) => e.type === "user.message").length;
    const result = await regradeRun(h.ctx, TENANT, row.id, {});
    expect(result.regraded).toBe(1);
    expect(result.skipped).toBe(0);

    const ctxNewJudge = {
      ...h.ctx,
      resolveJudge: async (_t, _a, spec) =>
        spec.rubric === ""
          ? null
          : {
              judge: async () => ({ text: JSON.stringify(acquittal) }),
              judgeModelId: "judge-v2",
              judgeReasoningLevel: "max",
            },
    };
    const result2 = await regradeRun(ctxNewJudge, TENANT, row.id, {});
    expect(result2.regraded).toBe(1);

    row = (await h.evals.list({ tenantId: TENANT, limit: 10 }))[0];
    const regradedTrial = row.results.tasks[0].trials[0];
    expect(regradedTrial.reward).toBe(1);
    expect(regradedTrial.findings).toBeUndefined();      // acquittal wiped them
    expect(row.results.findings_report).toBeUndefined(); // rollup recomputed
    expect(row.status).toBe("completed");                // status untouched
    // No conversation re-execution: same number of user messages.
    const userMsgsAfter = h.sandbox.eventsOf(trial.session_id)
      .filter((e) => e.type === "user.message").length;
    expect(userMsgsAfter).toBe(userMsgsBefore);
    // Stored trajectory carries the new judge identity.
    const raw = await h.kv.get(`t:${TENANT}:trajectory:${regradedTrial.trajectory_id}`);
    expect(JSON.parse(raw).reward.metadata.judge_model_id).toBe("judge-v2");
  });

  it("regradeRun skips failed/ungraded-missing trials and 404s unknown runs", async () => {
    const h = makeHarness(SIM_SPEC, { resolveJudge: null });
    await h.createRun();
    const row = await h.tickUntilTerminal();
    expect(row.results.tasks[0].trials[0].status).toBe("failed");
    const result = await regradeRun(h.ctx, TENANT, row.id, {});
    expect(result.regraded).toBe(0);
    expect(result.skipped).toBe(1);
    expect(await regradeRun(h.ctx, TENANT, "evrun-nope", {})).toBeNull();
  });

  it("memory_store fresh: provisions a store, plants seed_files, attaches before turn 1, snapshots for the judge", async () => {
    const spec = {
      ...SIM_SPEC,
      simulation: {
        ...SIM_SPEC.simulation,
        persona: { ...SIM_SPEC.simulation.persona, scripted_messages: ["hello"] },
        memory_store: {
          fresh: true,
          access: "read_write",
          seed_files: [{ path: "preferences.md", content: "User prefers CC legal on vendor contracts." }],
        },
      },
    };
    const h = makeHarness(spec);
    await h.createRun();
    const row = await h.tickUntilTerminal();
    const trial = row.results.tasks[0].trials[0];
    expect(trial.status).toBe("completed");
    expect(trial.memory_store_id).toBe("mem_1");
    expect(h.memory.lastName).toMatch(/^sim-.*-sim-1-0$/);
    // seeded before conversation
    expect(h.memory.stores.get("mem_1").get("preferences.md")).toContain("CC legal");
    // attached to the trial's session, read_write
    expect(h.memory.attachments).toEqual([{ sessionId: trial.session_id, storeId: "mem_1", access: "read_write" }]);
    // snapshot rides the stored trajectory for the judge / console
    const traj = JSON.parse(await h.kv.get(`t:${TENANT}:trajectory:${trial.trajectory_id}`));
    expect(traj.memory_store.store_id).toBe("mem_1");
    expect(traj.memory_store.files).toEqual([{ path: "preferences.md", content: "User prefers CC legal on vendor contracts." }]);
  });

  it("memory_store store_id reuses an existing store and skips provisioning", async () => {
    const spec = {
      ...SIM_SPEC,
      simulation: {
        ...SIM_SPEC.simulation,
        persona: { ...SIM_SPEC.simulation.persona, scripted_messages: ["hello"] },
        memory_store: { store_id: "mem_existing" },
      },
    };
    const h = makeHarness(spec);
    await h.createRun();
    const row = await h.tickUntilTerminal();
    const trial = row.results.tasks[0].trials[0];
    expect(trial.memory_store_id).toBe("mem_existing");
    expect(h.memory.lastName).toBeUndefined();
    expect(h.memory.attachments[0].storeId).toBe("mem_existing");
  });

  it("fails fast with a clear error when the runtime has no memory port", async () => {
    const spec = {
      ...SIM_SPEC,
      simulation: {
        ...SIM_SPEC.simulation,
        persona: { ...SIM_SPEC.simulation.persona, scripted_messages: ["hello"] },
        memory_store: { fresh: true },
      },
    };
    const h = makeHarness(spec, { memory: null });
    await h.createRun();
    const row = await h.tickUntilTerminal();
    expect(row.results.tasks[0].trials[0].status).toBe("failed");
    expect(row.results.tasks[0].trials[0].error).toContain("memory port");
  });

  it("episodes: runs sequential sessions sharing one store, judges once with prior transcripts", async () => {
    const spec = {
      ...SIM_SPEC,
      simulation: {
        ...SIM_SPEC.simulation,
        persona: { ...SIM_SPEC.simulation.persona, scripted_messages: ["ep1 first", "ep1 second"] },
        memory_store: { fresh: true },
        episodes: [
          {
            gap_description: "two weeks later",
            scenario: "Follow-up visit.",
            persona: { scripted_messages: ["ep2 only"] },
            max_turns: 3,
          },
        ],
      },
    };
    const h = makeHarness(spec);
    await h.createRun();
    const row = await h.tickUntilTerminal(40);
    const trial = row.results.tasks[0].trials[0];
    expect(row.status).toBe("completed");
    expect(trial.status).toBe("completed");
    // Two distinct sessions, same store attached to both.
    expect(trial.episodes).toHaveLength(1);
    expect(trial.episodes[0]).toMatchObject({ index: 0, persona_turns: 2, sim_ended_by: "persona" });
    expect(trial.episodes[0].trajectory_id).toBeTruthy();
    expect(trial.episode_index).toBe(1);
    expect(trial.session_id).not.toBe(trial.episodes[0].session_id);
    expect(h.memory.attachments.map((a) => a.sessionId)).toEqual([trial.episodes[0].session_id, trial.session_id]);
    expect(new Set(h.memory.attachments.map((a) => a.storeId)).size).toBe(1);
    // Episode 1's messages went to session 1; episode 2's to session 2.
    const texts = (sid) => h.sandbox.eventsOf(sid).filter((e) => e.type === "user.message").map((e) => JSON.parse(e.data).content[0].text);
    expect(texts(trial.episodes[0].session_id)).toEqual(["ep1 first", "ep1 second"]);
    expect(texts(trial.session_id)).toEqual(["ep2 only"]);
    // Final trajectory carries prior episode transcripts for the judge.
    const traj = JSON.parse(await h.kv.get(`t:${TENANT}:trajectory:${trial.trajectory_id}`));
    expect(traj.prior_episodes).toHaveLength(1);
    expect(traj.prior_episodes[0].transcript).toContain("User: ep1 first");
    expect(traj.prior_episodes[0].transcript).toContain("Agent: agent reply");
    // Judge ran exactly once (one reward on the final trajectory).
    expect(trial.reward).toBe(1);
    // Session titles distinguish episodes.
    expect(h.sessions.get(trial.session_id).title).toMatch(/:: ep2$/);
  });

  it("crash consistency: a snapshot taken mid-startEpisode still reads the previous state", async () => {
    // Persona LLM is the last await inside startEpisode before the atomic
    // commit. Snapshot the run row from INSIDE that await and assert the
    // trial is still 'pending' with no session_id — i.e. a sibling's saveRun
    // at that instant would not persist a half-initialized 'running' trial.
    let snapshot = null;
    const h = makeHarness(SIM_SPEC, {
      resolveJudge: async (_t, _a, spec) => {
        if (spec.rubric === "") {
          return {
            judge: async () => {
              const rows = await h.evals.list({ tenantId: TENANT, limit: 10 });
              snapshot = rows[0].results.tasks[0].trials[0];
              // simulate a concurrent sibling persisting the run mid-flight
              return { text: '{"action":"end","reason":"done"}' };
            },
            judgeModelId: "persona-model", judgeReasoningLevel: "low",
          };
        }
        return { judge: async () => ({ text: JSON.stringify(CANNED_VERDICT) }), judgeModelId: "judge-model", judgeReasoningLevel: "max" };
      },
    });
    await h.createRun();
    // First tick: pending → startEpisode. The persona ends before the opener
    // → startEpisode throws → trial fails. Either way, the mid-flight
    // snapshot must show the pre-commit state.
    await tickEvalRuns(h.ctx);
    expect(snapshot).toBeTruthy();
    expect(snapshot.status).toBe("pending");
    expect(snapshot.session_id).toBeUndefined();
  });

  it("episode roll-over failure leaves the finished episode's session as the trial's session", async () => {
    // Episode 1 completes; starting episode 2 fails (persona ends before the
    // opener). The trial must fail while still pointing at episode 1's
    // session — not a half-created episode-2 session — so the failure
    // trajectory captures the real conversation.
    const spec = {
      ...SIM_SPEC,
      simulation: {
        ...SIM_SPEC.simulation,
        persona: { ...SIM_SPEC.simulation.persona, scripted_messages: ["ep1 only"] },
        memory_store: { fresh: true },
        // episode 2 has an EMPTY scripted list → nextPersonaTurn returns "end" on the opener → startEpisode throws
        episodes: [{ scenario: "later", persona: { scripted_messages: [] } }],
      },
    };
    const h = makeHarness(spec);
    await h.createRun();
    const row = await h.tickUntilTerminal(40);
    const trial = row.results.tasks[0].trials[0];
    expect(trial.status).toBe("failed");
    expect(trial.error).toContain("persona ended the conversation before the opening message");
    // Still episode 0's session; no episode was recorded as finished (commit never happened).
    expect(trial.episode_index).toBe(0);
    expect(trial.episodes ?? []).toHaveLength(0);
    const texts = h.sandbox.eventsOf(trial.session_id).filter((e) => e.type === "user.message").map((e) => JSON.parse(e.data).content[0].text);
    expect(texts).toEqual(["ep1 only"]);
    // Only ONE session was ever attached to the store... plus the aborted one — but the trial's own pointer is stable.
    expect(h.sessions.get(trial.session_id).title).not.toMatch(/ep2/);
  });

  it("regradeRun refuses active runs", async () => {
    const h = makeHarness(SIM_SPEC, { personaScript: ['{"action":"message","text":"hi"}', '{"action":"message","text":"more"}'] });
    await h.createRun();
    await tickEvalRuns(h.ctx); // now running, not terminal
    const rows = await h.evals.list({ tenantId: TENANT, limit: 10 });
    expect(rows[0].status).toBe("running");
    const res = await regradeRun(h.ctx, TENANT, rows[0].id, {});
    expect(res).toEqual({ error: "run_active" });
  });

  it("scripted (non-simulation) tasks still work end-to-end", async () => {
    const h = makeHarness({ id: "classic", messages: ["do it", "and again"] }, { resolveJudge: null });
    await h.createRun();
    const row = await h.tickUntilTerminal();
    expect(row.status).toBe("completed");
    const trial = row.results.tasks[0].trials[0];
    const userTexts = h.sandbox
      .eventsOf(trial.session_id)
      .filter((e) => e.type === "user.message")
      .map((e) => JSON.parse(e.data).content[0].text);
    expect(userTexts).toEqual(["do it", "and again"]);
  });
});
