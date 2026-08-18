// Simulation chaos injection (apps/agent/src/harness/chaos.ts) — seeded,
// deterministic tool failures wrapped around a tool dictionary — and the
// trace-facts accounting that separates injected from real failures.

// @ts-nocheck
import { describe, it, expect } from "vitest";
import { applyChaosRules, normalizeChaosRules, CHAOS_MARKER } from "../../apps/agent/src/harness/chaos";
import { extractTraceFacts } from "@open-managed-agents/eval-core";

function fakeTools() {
  const calls = { web_search: 0, bash: 0 };
  return {
    calls,
    tools: {
      web_search: { execute: async ({ query }) => { calls.web_search++; return `results for ${query}`; } },
      bash: { execute: async ({ command }) => { calls.bash++; return `exit=0\nran ${command}`; } },
    },
  };
}

async function runN(tool, n, args = {}) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(await tool.execute(args));
  return out;
}

describe("normalizeChaosRules", () => {
  it("accepts {rules:[...]} or a bare array, drops invalid rules, defaults fields", () => {
    const rules = normalizeChaosRules({
      rules: [
        { tool: "web_search", failure_rate: 0.3 },
        { tool: "", failure_rate: 0.5 },          // no tool → dropped
        { tool: "bash", failure_rate: 1.5 },      // out of range → dropped
        { tool: "read", failure_rate: 1, mode: "bogus", timeout_ms: 999999 },
      ],
    });
    expect(rules.map((r) => r.tool)).toEqual(["web_search", "read"]);
    expect(rules[0]).toMatchObject({ mode: "error", seed: 1 });
    expect(rules[1]).toMatchObject({ mode: "error", timeout_ms: 60_000 }); // capped
    expect(normalizeChaosRules([{ tool: "x", failure_rate: 0 }])).toHaveLength(1);
    expect(normalizeChaosRules(null)).toEqual([]);
  });
});

describe("applyChaosRules", () => {
  it("passes through untouched when there are no rules or the tool isn't targeted", async () => {
    const { tools, calls } = fakeTools();
    const wrapped = applyChaosRules(tools, { rules: [{ tool: "web_search", failure_rate: 1 }] });
    expect(await wrapped.bash.execute({ command: "ls" })).toContain("ran ls");
    expect(calls.bash).toBe(1);
    const untouched = applyChaosRules(fakeTools().tools, undefined);
    expect(await untouched.web_search.execute({ query: "q" })).toBe("results for q");
  });

  it("failure_rate 1 fails every call with the marker; original never runs", async () => {
    const { tools, calls } = fakeTools();
    applyChaosRules(tools, { rules: [{ tool: "web_search", failure_rate: 1, error_text: "Error: 503 upstream" }] });
    const out = await runN(tools.web_search, 3, { query: "q" });
    for (const o of out) expect(o).toBe(`${CHAOS_MARKER} Error: 503 upstream`);
    expect(calls.web_search).toBe(0);
  });

  it("is deterministic: same seed ⇒ identical failure sequence; different seed ⇒ different", async () => {
    const seq = async (seed) => {
      const { tools } = fakeTools();
      applyChaosRules(tools, { rules: [{ tool: "web_search", failure_rate: 0.5, seed }] });
      const out = await runN(tools.web_search, 20, { query: "q" });
      return out.map((o) => (o.startsWith(CHAOS_MARKER) ? "F" : ".")).join("");
    };
    const a = await seq(42);
    const b = await seq(42);
    const c = await seq(7);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toContain("F");
    expect(a).toContain(".");
  });

  it("max_failures caps injected failures; subsequent calls pass through", async () => {
    const { tools, calls } = fakeTools();
    applyChaosRules(tools, { rules: [{ tool: "web_search", failure_rate: 1, max_failures: 2 }] });
    const out = await runN(tools.web_search, 5, { query: "q" });
    expect(out.filter((o) => o.startsWith(CHAOS_MARKER))).toHaveLength(2);
    expect(calls.web_search).toBe(3);
  });

  it("state is per session and survives re-wrapping (buildTools runs every turn)", async () => {
    const seq = async (sessionId, rewrapEvery) => {
      const out = [];
      let calls = 0;
      let wrapped = null;
      for (let i = 0; i < 12; i++) {
        if (i % rewrapEvery === 0) {
          const { tools } = fakeTools();
          wrapped = applyChaosRules(tools, { rules: [{ tool: "web_search", failure_rate: 0.5, seed: 9, max_failures: 3 }] }, { sessionId });
        }
        const r = await wrapped.web_search.execute({ query: "q" });
        out.push(r.startsWith(CHAOS_MARKER) ? "F" : ".");
        calls++;
      }
      return out.join("");
    };
    // Same session: re-wrapping every turn (rewrapEvery=1) must produce the SAME
    // sequence as wrapping once (rewrapEvery=12), and max_failures=3 must hold
    // across the whole session, not per wrap.
    const once = await seq("sess-A", 12);
    const perTurn = await seq("sess-B", 1); // fresh session id → its own state
    expect(once).toEqual(perTurn);
    expect((once.match(/F/g) || []).length).toBeLessThanOrEqual(3);
    // Different sessions with the same seed start identical sequences.
    expect(await seq("sess-C", 4)).toEqual(once);
    // No sessionId → per-call state (legacy/one-shot): each wrap restarts.
    const { tools } = fakeTools();
    applyChaosRules(tools, { rules: [{ tool: "web_search", failure_rate: 1, max_failures: 1 }] });
    await tools.web_search.execute({ query: "q" });
    const t2 = fakeTools().tools;
    applyChaosRules(t2, { rules: [{ tool: "web_search", failure_rate: 1, max_failures: 1 }] });
    expect((await t2.web_search.execute({ query: "q" })).startsWith(CHAOS_MARKER)).toBe(true);
  });

  it("mode empty returns a marked blank result; onInjected fires per failure", async () => {
    const { tools } = fakeTools();
    const seen = [];
    applyChaosRules(tools, { rules: [{ tool: "bash", failure_rate: 1, mode: "empty" }] }, {
      onInjected: (i) => seen.push(i),
    });
    const out = await tools.bash.execute({ command: "ls" });
    expect(out).toBe(`${CHAOS_MARKER} (completed with no output)`);
    expect(seen).toEqual([{ tool: "bash", mode: "empty", call_index: 1 }]);
  });

  it("mode timeout hangs for timeout_ms then fails", async () => {
    const { tools } = fakeTools();
    applyChaosRules(tools, { rules: [{ tool: "bash", failure_rate: 1, mode: "timeout", timeout_ms: 30 }] });
    const t0 = Date.now();
    const out = await tools.bash.execute({ command: "ls" });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
    expect(out).toContain("timed out after 30ms");
    expect(out.startsWith(CHAOS_MARKER)).toBe(true);
  });
});

describe("trace facts: chaos accounting", () => {
  const ev = (seq, type, data) => ({ seq, type, data: JSON.stringify({ type, ...data }), ts: "2026-07-29T10:00:00Z" });
  const traj = (events) => ({
    schema_version: "oma.trajectory.v1", trajectory_id: "t", session_id: "s",
    agent_config: {}, environment_config: {}, model: { id: "m", provider: "" },
    started_at: "2026-07-29T10:00:00Z", outcome: "success", events, summary: {},
  });

  it("counts marked results as injected AND as tool errors, per tool", () => {
    const facts = extractTraceFacts(traj([
      ev(1, "agent.tool_use", { id: "t1", name: "web_search", input: { query: "a" } }),
      ev(2, "agent.tool_result", { tool_use_id: "t1", content: `${CHAOS_MARKER} Error: 503` }),
      ev(3, "agent.tool_use", { id: "t2", name: "web_search", input: { query: "a" } }),
      ev(4, "agent.tool_result", { tool_use_id: "t2", content: "real results" }),
      ev(5, "agent.tool_use", { id: "t3", name: "bash", input: { command: "ls" } }),
      ev(6, "agent.tool_result", { tool_use_id: "t3", content: "Error: real failure", is_error: true }),
    ]));
    expect(facts.chaos_failures_injected).toBe(1);
    expect(facts.chaos_failures_by_tool).toEqual([{ tool: "web_search", count: 1 }]);
    expect(facts.tools).toEqual([
      { name: "web_search", calls: 2, errors: 1 },
      { name: "bash", calls: 1, errors: 1 },
    ]);
  });

  it("omits chaos fields entirely when nothing was injected (old trajectories unchanged)", () => {
    const facts = extractTraceFacts(traj([
      ev(1, "agent.tool_use", { id: "t1", name: "bash", input: { command: "ls" } }),
      ev(2, "agent.tool_result", { tool_use_id: "t1", content: "exit=0\nok" }),
    ]));
    expect(facts).not.toHaveProperty("chaos_failures_injected");
    expect(facts).not.toHaveProperty("chaos_failures_by_tool");
  });
});
