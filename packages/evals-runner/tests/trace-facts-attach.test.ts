// Smoke test for Phase 3b attach (evals-design §5): the runner's
// pre-storage enrichment must stamp trace_facts (via extractTraceFacts)
// alongside task_id/group_id/reward so the persisted trajectory is
// self-describing for the judge prompt and the Console.

// @ts-nocheck
import { describe, it, expect } from "vitest";
import { finalizeTrajectoryForStorage } from "@open-managed-agents/evals-runner";

/** CF event shape: payload JSON-serialized into the `data` envelope. */
function ev(seq: number, type: string, data: object = {}) {
  return { seq, type, data: JSON.stringify({ type, ...data }), ts: "2026-07-24T10:00:00Z" };
}

function makeTrajectory(events) {
  return {
    schema_version: "oma.trajectory.v1",
    trajectory_id: "tr-1",
    session_id: "sess-1",
    agent_config: {},
    environment_config: {},
    model: { id: "test-model", provider: "" },
    started_at: "2026-07-24T10:00:00Z",
    outcome: "success",
    events,
    summary: { num_turns: 2, duration_ms: 1234 },
  };
}

const reward = {
  raw_rewards: { value: 1 },
  final_reward: 1,
  verifier_id: "test.v1",
  computed_at: "2026-07-24T10:01:00Z",
};

describe("finalizeTrajectoryForStorage", () => {
  it("attaches trace_facts extracted from the event log", () => {
    const traj = makeTrajectory([
      ev(1, "user.message", { content: [{ type: "text", text: "build it" }] }),
      ev(2, "agent.tool_use", { id: "tu_1", name: "bash", input: { command: "npm test" } }),
      ev(3, "agent.tool_result", { tool_use_id: "tu_1", content: "exit=0\nok", is_error: false }),
      ev(4, "agent.tool_use", { id: "tu_2", name: "write", input: { file_path: "/workspace/out.md", content: "x" } }),
      ev(5, "agent.message", { content: [{ type: "text", text: "done" }] }),
    ]);

    finalizeTrajectoryForStorage(traj, { taskId: "task-1", groupId: "run-1", reward });

    expect(traj.task_id).toBe("task-1");
    expect(traj.group_id).toBe("run-1");
    expect(traj.reward).toBe(reward);

    const facts = traj.trace_facts;
    expect(facts).toBeDefined();
    expect(facts.outcome).toBe("success");
    expect(facts.turns).toBe(2);
    expect(facts.tools).toEqual([
      { name: "bash", calls: 1, errors: 0 },
      { name: "write", calls: 1, errors: 0 },
    ]);
    expect(facts.exec_commands).toEqual([
      { command_head: "npm test", exit_code: 0, event_id: "tu_1" },
    ]);
    expect(facts.files_written).toEqual([
      { path: "/workspace/out.md", event_id: "tu_2" },
    ]);
  });

  it("timeout-flavored trial errors flip the outcome (and the facts follow)", () => {
    const traj = makeTrajectory([]);
    finalizeTrajectoryForStorage(traj, {
      taskId: "task-1",
      groupId: "run-1",
      reward,
      trialError: "trial timeout: 3700s exceeded budget 3600s",
    });
    expect(traj.outcome).toBe("timeout");
    expect(traj.trace_facts.outcome).toBe("timeout");
  });

  it("explicit outcomeOverride wins over the error heuristic", () => {
    const traj = makeTrajectory([]);
    finalizeTrajectoryForStorage(traj, {
      taskId: "task-1",
      groupId: "run-1",
      reward,
      outcomeOverride: "failure",
      trialError: "timeout-ish message",
    });
    expect(traj.outcome).toBe("failure");
    expect(traj.trace_facts.outcome).toBe("failure");
  });
});
