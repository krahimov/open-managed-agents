import { describe, expect, it } from "vitest";

import { blankTask, checkTask, checkTasks, draftToTask, isTemplateRubric, taskToDraft } from "./task-draft";

const judged = {
  id: "refund-after-thirty-days",
  messages: ["A customer asks for a refund 34 days after purchase.", "They insist."],
  trials: 3,
  timeout_ms: 300000,
  pass_threshold: 0.8,
  setup_script: "seed-orders.sh",
  reward: { type: "llm_judge", rubric: "- [policy] Declines politely and cites the 30-day policy.", include_transcript: true, judge: { reasoning_level: "high" } },
};
const simulated = {
  id: "angry-customer",
  simulation: { persona: "An angry customer", max_turns: 6 },
  trials: 2,
  reward: { type: "llm_judge", rubric: "Stays calm." },
};
const composite = {
  id: "migrates-and-passes",
  messages: ["Migrate the billing module."],
  reward: { type: "composite", components: [{ name: "gate:tests", verifier: { type: "command", command: "pnpm test" } }] },
};

describe("task drafts", () => {
  it("goes from JSON to the form and back without changing anything", () => {
    for (const task of [judged, simulated, composite]) {
      expect(draftToTask(taskToDraft(task))).toEqual(task);
    }
  });

  it("puts a judged task's fields on the form", () => {
    const d = taskToDraft(judged);
    expect(d.formable).toBeNull();
    expect(d).toMatchObject({
      id: "refund-after-thirty-days",
      messages: judged.messages,
      rubric: judged.reward.rubric,
      trials: "3",
      passThreshold: "0.8",
      timeoutSec: "300",
    });
  });

  it("keeps a task the form cannot show truthfully as it is, and says why", () => {
    expect(taskToDraft(simulated).formable).toMatch(/simulated user/);
    expect(taskToDraft(composite).formable).toMatch(/composite/);
    // Only its name can change on the form.
    const renamed = { ...taskToDraft(simulated), id: "calm-under-fire" };
    expect(draftToTask(renamed)).toEqual({ ...simulated, id: "calm-under-fire" });
  });

  it("writes what was edited on the form, and keeps what the form does not show", () => {
    const d = { ...taskToDraft(judged), rubric: "- [policy] Declines.", trials: "5", messages: ["Only this.", "  "] };
    const t = draftToTask(d);
    expect(t).toMatchObject({ trials: 5, messages: ["Only this."], setup_script: "seed-orders.sh" });
    expect(t.reward).toEqual({ type: "llm_judge", rubric: "- [policy] Declines.", include_transcript: true, judge: { reasoning_level: "high" } });
  });

  it("says each problem on its field", () => {
    const e = checkTask({ ...blankTask(), id: " ", messages: [""], rubric: "", trials: "0", passThreshold: "2", timeoutSec: "0" });
    expect(e).toEqual({
      taskId: "Give the task a name.",
      messages: "Add at least one message for the agent.",
      rubric: "Write the rubric the judge grades against.",
      trials: "A whole number, 1 or more.",
      threshold: "Between 0 and 1.",
      timeout: "At least 1 second.",
    });
    expect(checkTask({ ...blankTask(), messages: ["Do it."] })).toEqual({});
  });

  it("does not let two tasks share a name", () => {
    const a = { ...blankTask(), messages: ["One."] };
    const errs = checkTasks([a, { ...a }]);
    expect(errs[0].taskId).toMatch(/Another task is also called “task-1”/);
    expect(errs[1].taskId).toMatch(/Another task/);
  });

  it("names a new task after the ones there", () => {
    expect(blankTask().id).toBe("task-1");
    expect(blankTask(["task-1", "task-2"]).id).toBe("task-3");
    expect(blankTask(["task-2"]).id).toBe("task-3");
    expect(isTemplateRubric(blankTask().rubric)).toBe(true);
    expect(isTemplateRubric(judged.reward.rubric)).toBe(false);
  });
});
