// Phase 3a (evals-design §5) acceptance tests: extractTraceFacts over
// synthetic trajectories with both event storage shapes — CF (payload
// JSON-serialized inside a `data` envelope) and Node (flattened, payload
// fields at the top level).

// @ts-nocheck
import { describe, it, expect } from "vitest";
import { extractTraceFacts } from "@open-managed-agents/eval-core";
import type { Trajectory, TraceFacts } from "@open-managed-agents/eval-core";

/** CF shape: payload serialized into the `data` envelope. */
function ev(seq: number, type: string, data: object = {}) {
  return { seq, type, data: JSON.stringify({ type, ...data }), ts: "2026-07-24T10:00:00Z" };
}

/** Node shape: flattened — payload fields at the top level, no envelope. */
function flatEv(seq: number, type: string, data: object = {}) {
  return { seq, type, ts: "2026-07-24T10:00:00Z", ...data };
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
    summary: {
      num_events: events.length,
      num_turns: 2,
      num_tool_calls: 0,
      num_tool_errors: 0,
      num_threads: 0,
      duration_ms: 45_000,
      token_usage: {
        input_tokens: 1000,
        output_tokens: 200,
        cache_read_input_tokens: 50,
        cache_creation_input_tokens: 10,
      },
    },
    ...extra,
  };
}

// Same event content in both shapes, so every assertion runs against both.
function buildEvents(mk: typeof ev) {
  return [
    mk(1, "user.message", { content: [{ type: "text", text: "build the thing" }] }),
    mk(2, "agent.message", { content: [{ type: "text", text: "on it" }] }),
    // bash success with exit marker
    mk(3, "agent.tool_use", { id: "tu_1", name: "bash", input: { command: "npm test --silent" } }),
    mk(4, "agent.tool_result", { tool_use_id: "tu_1", content: "42 passing\nexit=0" }),
    // bash failure with exit marker
    mk(5, "agent.tool_use", { id: "tu_2", name: "bash", input: { command: "cat /missing" } }),
    mk(6, "agent.tool_result", { tool_use_id: "tu_2", content: "No such file\nexit=1" }),
    // file writes: two paths, second path written twice (last event wins)
    mk(7, "agent.tool_use", { id: "tu_3", name: "write", input: { file_path: "/workspace/a.md", content: "x" } }),
    mk(8, "agent.tool_result", { tool_use_id: "tu_3", content: "ok" }),
    mk(9, "agent.tool_use", { id: "tu_4", name: "write", input: { file_path: "/workspace/b.md", content: "y" } }),
    mk(10, "agent.tool_result", { tool_use_id: "tu_4", content: "ok" }),
    mk(11, "agent.tool_use", { id: "tu_5", name: "write", input: { file_path: "/workspace/b.md", content: "y2" } }),
    mk(12, "agent.tool_result", { tool_use_id: "tu_5", content: "ok" }),
    // mcp tool: 3 identical calls (loop) + 1 different input, one errored result
    mk(13, "agent.mcp_tool_use", { id: "tu_6", mcp_server_name: "srv", name: "search", input: { q: "same" } }),
    mk(14, "agent.mcp_tool_result", { mcp_tool_use_id: "tu_6", content: "nothing" }),
    mk(15, "agent.mcp_tool_use", { id: "tu_7", mcp_server_name: "srv", name: "search", input: { q: "same" } }),
    mk(16, "agent.mcp_tool_result", { mcp_tool_use_id: "tu_7", content: "nothing" }),
    mk(17, "agent.mcp_tool_use", { id: "tu_8", mcp_server_name: "srv", name: "search", input: { q: "same" } }),
    mk(18, "agent.mcp_tool_result", { mcp_tool_use_id: "tu_8", content: "boom", is_error: true }),
    mk(19, "agent.mcp_tool_use", { id: "tu_9", mcp_server_name: "srv", name: "search", input: { q: "different" } }),
    mk(20, "agent.mcp_tool_result", { mcp_tool_use_id: "tu_9", content: "found" }),
    // bash with no result (interrupted mid-call), carries a payload id
    mk(21, "agent.tool_use", { id: "tu_10", name: "bash", input: { command: "sleep 999" } }),
    // session error, no payload id → event_id falls back to seq
    mk(22, "session.error", { error: { type: "harness", message: "x".repeat(300) } }),
    mk(23, "agent.message", { content: [{ type: "text", text: "done-ish" }] }),
  ];
}

function assertFacts(facts: TraceFacts) {
  // scalars come from summary / trajectory
  expect(facts.outcome).toBe("success");
  expect(facts.turns).toBe(2);
  expect(facts.duration_ms).toBe(45_000);
  expect(facts.token_usage).toEqual({
    input_tokens: 1000,
    output_tokens: 200,
    cache_read_input_tokens: 50,
    cache_creation_input_tokens: 10,
  });

  // tools: aggregated calls + errors per name
  expect(facts.tools).toEqual([
    { name: "bash", calls: 3, errors: 0 },
    { name: "write", calls: 3, errors: 0 },
    { name: "search", calls: 4, errors: 1 },
  ]);

  // exec_commands: exit code parsed from exit=N; -1 when no result
  expect(facts.exec_commands).toEqual([
    { command_head: "npm test --silent", exit_code: 0, event_id: "tu_1" },
    { command_head: "cat /missing", exit_code: 1, event_id: "tu_2" },
    { command_head: "sleep 999", exit_code: -1, event_id: "tu_10" },
  ]);

  // files_written: deduped by path, last write's event id wins
  expect(facts.files_written).toEqual([
    { path: "/workspace/a.md", event_id: "tu_3" },
    { path: "/workspace/b.md", event_id: "tu_5" },
  ]);

  // errors: session.error with message head truncated at 200 chars,
  // event id falls back to seq when the payload has no id
  expect(facts.errors).toHaveLength(1);
  expect(facts.errors[0].event_id).toBe("seq:22");
  expect(facts.errors[0].message_head).toBe("x".repeat(200));

  // repeated_call_loops: same tool + identical input >= 3x; the
  // "different" input call does not join the group
  expect(facts.repeated_call_loops).toEqual([{ tool: "search", count: 3 }]);
}

describe("extractTraceFacts", () => {
  it("extracts every field from CF-shaped (enveloped) events", () => {
    assertFacts(extractTraceFacts(makeTrajectory(buildEvents(ev))));
  });

  it("extracts every field from Node-shaped (flattened) events", () => {
    assertFacts(extractTraceFacts(makeTrajectory(buildEvents(flatEv))));
  });

  it("does not flag < 3 identical calls as a loop", () => {
    const events = [
      ev(1, "agent.tool_use", { id: "t1", name: "bash", input: { command: "ls" } }),
      ev(2, "agent.tool_use", { id: "t2", name: "bash", input: { command: "ls" } }),
      ev(3, "agent.tool_use", { id: "t3", name: "bash", input: { command: "ls -la" } }),
    ];
    const facts = extractTraceFacts(makeTrajectory(events));
    expect(facts.repeated_call_loops).toEqual([]);
  });

  it("counts writes via Claude Code SDK harness tool names (Write/Edit)", () => {
    const events = [
      ev(1, "agent.tool_use", { id: "t1", name: "Write", input: { file_path: "/w/x.ts", content: "" } }),
      ev(2, "agent.tool_use", { id: "t2", name: "Edit", input: { file_path: "/w/y.ts" } }),
    ];
    const facts = extractTraceFacts(makeTrajectory(events));
    expect(facts.files_written).toEqual([
      { path: "/w/x.ts", event_id: "t1" },
      { path: "/w/y.ts", event_id: "t2" },
    ]);
  });

  it("tolerates a string session.error payload and missing summary fields", () => {
    const events = [
      ev(1, "agent.message", { content: [{ type: "text", text: "hi" }] }),
      ev(2, "session.error", { error: "plain string failure" }),
    ];
    const facts = extractTraceFacts(
      makeTrajectory(events, { summary: {} as any, outcome: "failure" }),
    );
    expect(facts.outcome).toBe("failure");
    // falls back to counting agent.message events when summary lacks num_turns
    expect(facts.turns).toBe(1);
    expect(facts.duration_ms).toBe(0);
    expect(facts.token_usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
    expect(facts.errors).toEqual([
      { event_id: "seq:2", message_head: "plain string failure" },
    ]);
  });

  it("uses is_error fallback for exec exit codes without an exit=N marker", () => {
    const events = [
      ev(1, "agent.tool_use", { id: "t1", name: "bash", input: { command: "true" } }),
      ev(2, "agent.tool_result", { tool_use_id: "t1", content: "no marker here" }),
      ev(3, "agent.tool_use", { id: "t2", name: "bash", input: { command: "false" } }),
      ev(4, "agent.tool_result", { tool_use_id: "t2", content: "failed", is_error: true }),
    ];
    const facts = extractTraceFacts(makeTrajectory(events));
    expect(facts.exec_commands).toEqual([
      { command_head: "true", exit_code: 0, event_id: "t1" },
      { command_head: "false", exit_code: 1, event_id: "t2" },
    ]);
    // is_error tool_result also counts toward the tool's error tally
    expect(facts.tools).toEqual([{ name: "bash", calls: 2, errors: 1 }]);
  });

  it("truncates long exec command heads at 200 chars", () => {
    const long = "echo " + "a".repeat(400);
    const events = [
      ev(1, "agent.tool_use", { id: "t1", name: "bash", input: { command: long } }),
      ev(2, "agent.tool_result", { tool_use_id: "t1", content: "exit=0" }),
    ];
    const facts = extractTraceFacts(makeTrajectory(events));
    expect(facts.exec_commands[0].command_head).toBe(long.slice(0, 200));
    expect(facts.exec_commands[0].command_head.length).toBe(200);
  });
});
