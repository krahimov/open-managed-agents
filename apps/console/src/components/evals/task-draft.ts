/**
 * One eval task as a form holds it, and the way to and from the task the
 * server takes. Shared by "New eval run" and "Save as eval" (and their
 * "Edit as JSON" path), so a task is written the same way in both.
 *
 * The form edits what most tasks are: a name, the messages the agent is
 * sent, a rubric the judge grades against, trials, a pass mark and a time
 * limit. Everything else a task may carry (a simulation in place of the
 * messages, setup scripts and files, a composite reward, the judge's own
 * settings, include_transcript…) rides along untouched in `rest`, so
 * going from JSON to the form and back changes nothing the form did not
 * show. A task the form cannot show truthfully (a simulation, a reward
 * that is not a single judge) says so in `formable`, and is edited as JSON.
 */

export interface TaskDraft {
  /** The task's id: its name in results. */
  id: string;
  messages: string[];
  rubric: string;
  /** As typed: checked by `checkTask`. */
  trials: string;
  passThreshold: string;
  timeoutSec: string;
  /** What the task carries that the form does not edit. */
  rest: Record<string, unknown>;
  /** What the reward carries besides its type and rubric (the judge, include_transcript). */
  rewardRest: Record<string, unknown>;
  /** Null when the form can edit it; otherwise why it cannot ("A simulated user plays this task…"). */
  formable: string | null;
  /** A task the form cannot edit, exactly as it came (only its name can change). */
  raw?: Record<string, unknown>;
}

export type TaskFieldErrors = Partial<Record<"taskId" | "messages" | "rubric" | "trials" | "threshold" | "timeout", string>>;

/** What a rubric looks like before anyone wrote it: placeholders in angle brackets. */
export const RUBRIC_TEMPLATE =
  "Grade each criterion independently and cite evidence (event ids or file paths) for every verdict.\n\n" +
  "- [criterion-1] The agent produced <artifact> at <path> containing <required content>. Proof: the file exists and contains it.\n" +
  "- [criterion-2] <another independently checkable outcome>.\n\n" +
  "Ignore: stylistic choices, extra exploratory commands, harmless warnings.\n" +
  "Anticipated shortcuts (fail them): hardcoding the expected output; claiming success without a produced artifact; deleting failing checks instead of fixing them.";

/** Still has the template's placeholders ("<artifact>", "<path>"). */
export function isTemplateRubric(rubric: string): boolean {
  return /<(artifact|path|required content|another independently checkable outcome)>/.test(rubric);
}

/** A new task, numbered so its default name is unique among `taken`. */
export function blankTask(taken: string[] = []): TaskDraft {
  let n = taken.length + 1;
  while (taken.includes(`task-${n}`)) n += 1;
  return {
    id: `task-${n}`,
    messages: [""],
    rubric: RUBRIC_TEMPLATE,
    trials: "1",
    passThreshold: "1",
    timeoutSec: "600",
    rest: {},
    rewardRest: { include_transcript: false },
    formable: null,
  };
}

/** A task as the server takes it (from JSON, a suite, the session draft) → the form. */
export function taskToDraft(raw: unknown): TaskDraft {
  const t = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const { id, messages, trials, pass_threshold, timeout_ms, reward, ...rest } = t;
  const r = (reward && typeof reward === "object" ? reward : null) as Record<string, unknown> | null;
  const { type, rubric, ...rewardRest } = r ?? {};
  const hasMessages = Array.isArray(messages) && messages.every((m) => typeof m === "string");
  let formable: string | null = null;
  if (rest.simulation !== undefined && rest.simulation !== null) formable = "A simulated user plays this task, so it is edited as JSON.";
  else if (!hasMessages) formable = "Its messages are not plain text, so it is edited as JSON.";
  else if (r && type !== "llm_judge") formable = `It is graded by a ${String(type ?? "custom")} reward, not a single judge, so it is edited as JSON.`;
  return {
    id: typeof id === "string" ? id : "",
    messages: hasMessages && (messages as string[]).length > 0 ? [...(messages as string[])] : [""],
    rubric: typeof rubric === "string" ? rubric : "",
    trials: trials === undefined ? "1" : String(trials),
    passThreshold: pass_threshold === undefined ? "1" : String(pass_threshold),
    timeoutSec: typeof timeout_ms === "number" ? String(Math.round(timeout_ms / 1000)) : timeout_ms === undefined ? "600" : String(timeout_ms),
    rest,
    rewardRest,
    formable,
    ...(formable ? { raw: t } : {}),
  };
}

const num = (s: string): number | string => {
  const n = Number(s);
  return s.trim() !== "" && Number.isFinite(n) ? n : s;
};

/**
 * The form → the task as the server takes it, as it stands (numbers that do
 * not read as numbers are kept as typed, so "Edit as JSON" shows them and
 * says what is wrong). A task the form does not edit comes back as it was.
 */
export function draftToTask(d: TaskDraft): Record<string, unknown> {
  if (d.formable && d.raw) return { ...d.raw, id: d.id.trim() };
  const trials = num(d.trials);
  const threshold = num(d.passThreshold);
  const timeout = num(d.timeoutSec);
  return {
    id: d.id.trim(),
    messages: d.messages.map((m) => m.trim()).filter(Boolean),
    ...d.rest,
    trials,
    timeout_ms: typeof timeout === "number" ? Math.round(timeout * 1000) : timeout,
    pass_threshold: threshold,
    reward: { type: "llm_judge", rubric: d.rubric.trim(), ...d.rewardRest },
  };
}

/** Check one task. Every problem lands on its field, in words. */
export function checkTask(d: TaskDraft): TaskFieldErrors {
  const e: TaskFieldErrors = {};
  if (!d.id.trim()) e.taskId = "Give the task a name.";
  if (d.formable) return e;
  if (!d.messages.some((m) => m.trim())) e.messages = "Add at least one message for the agent.";
  if (!d.rubric.trim()) e.rubric = "Write the rubric the judge grades against.";
  const trials = Number(d.trials);
  if (!Number.isInteger(trials) || trials < 1) e.trials = "A whole number, 1 or more.";
  const threshold = Number(d.passThreshold);
  if (d.passThreshold.trim() === "" || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) e.threshold = "Between 0 and 1.";
  const timeout = Number(d.timeoutSec);
  if (!Number.isFinite(timeout) || timeout < 1) e.timeout = "At least 1 second.";
  return e;
}

/** Check a list: each task's own problems, and a name used twice. */
export function checkTasks(drafts: TaskDraft[]): TaskFieldErrors[] {
  const counts = new Map<string, number>();
  for (const d of drafts) counts.set(d.id.trim(), (counts.get(d.id.trim()) ?? 0) + 1);
  return drafts.map((d) => {
    const e = checkTask(d);
    if (!e.taskId && (counts.get(d.id.trim()) ?? 0) > 1) e.taskId = `Another task is also called “${d.id.trim()}”. Each name is used once.`;
    return e;
  });
}

export const hasErrors = (e: TaskFieldErrors) => Object.values(e).some(Boolean);
