// "New eval run": give an agent a set of tasks.
//
// Tasks are written with the task form "Save as eval" uses (name, messages,
// rubric, trials, pass mark, time limit: components/evals/TaskForm), one
// card per task. "Edit as JSON" is the second way in, for what the form does
// not cover (a simulated user, setup scripts, a composite reward): the
// form's tasks become JSON, and valid JSON goes back to the form with
// nothing it did not show changed (components/evals/task-draft). In JSON the
// dialog reads the text as you type and says, in words, what will run or
// what is wrong with it, so a mistake is caught here rather than by the
// server. A task the form cannot show is kept as it is and edited as JSON.
//
// The judge chosen
// below is written into every `llm_judge` reward at submit, including
// ones nested inside a composite, so nobody has to hand-edit
// `judge.{model_card_id,reasoning_level}` into the JSON. "Automatic"
// leaves the model unset: the runner then picks the strongest model from
// a different provider than the agent's.

import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { BracesIcon, ChevronRightIcon, CircleAlertIcon, CircleCheckIcon, ListChecksIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import { Callout } from "../../components/Callout";
import { Disclosure } from "../../components/Disclosure";
import { Modal } from "../../components/Modal";
import { Select, SelectOption, SelectSeparator } from "../../components/Select";
import { RUNS_KEY, SUITES_KEY, useEvalSuites } from "../../components/evals/data";
import { AgentField, DialogSection, EnvironmentField, JudgeFields, defaultEnvironmentOf } from "../../components/evals/fields";
import { clearFor, TaskBasics, TaskGrading } from "../../components/evals/TaskForm";
import {
  blankTask,
  checkTasks,
  draftToTask,
  hasErrors,
  taskToDraft,
  type TaskDraft,
  type TaskFieldErrors,
} from "../../components/evals/task-draft";
import { Tip } from "../../components/Tip";
import { useAsyncAction } from "../../hooks/useAsyncAction";
import { useApi } from "../../lib/api";
import { useAgents } from "../../lib/directory";
import { AUTO_JUDGE, injectJudge, type EvalSuite } from "../../lib/evals";
import { plural } from "../../lib/format";
import { useQueryClient } from "../../lib/useApiQuery";
import { failureSentence, withReason } from "../../lib/failure-text";

/** The JSON for a list of tasks as the form holds them. */
const toJson = (tasks: TaskDraft[]) => JSON.stringify(tasks.map(draftToTask), null, 2);
const firstTask = () => [blankTask()];

const TEMPLATE = "__template__";

/** Does this reward ask the judge model for anything? */
function usesJudge(reward: unknown): boolean {
  if (!reward || typeof reward !== "object") return false;
  const r = reward as { type?: string; components?: Array<{ verifier?: unknown }> };
  if (r.type === "llm_judge") return true;
  return r.type === "composite" && Array.isArray(r.components) && r.components.some((c) => usesJudge(c?.verifier));
}

type Reading = { ok: true; tasks: unknown[]; trials: number; judged: number } | { ok: false; problem: string };

/** Read the tasks JSON the way the server will, and say what is wrong in words. */
function readTasks(json: string): Reading {
  let tasks: unknown;
  try {
    tasks = JSON.parse(json);
  } catch (e) {
    return { ok: false, problem: `This is not valid JSON yet. ${failureSentence(e)}` };
  }
  if (!Array.isArray(tasks) || tasks.length === 0) return { ok: false, problem: "Tasks must be a list with at least one task in it." };
  const seen = new Set<string>();
  let trials = 0;
  let judged = 0;
  for (const [i, raw] of tasks.entries()) {
    const t = raw as { id?: unknown; messages?: unknown; simulation?: unknown; trials?: unknown; reward?: unknown };
    if (!t || typeof t !== "object" || typeof t.id !== "string" || !t.id) {
      return { ok: false, problem: `Task ${i + 1} needs an "id": a short name in quotes.` };
    }
    if (seen.has(t.id)) return { ok: false, problem: `Two tasks are called "${t.id}". Each id must be used once.` };
    seen.add(t.id);
    // The server's rule: exactly one of `messages` / `simulation`.
    const hasMessages = Array.isArray(t.messages) && t.messages.length > 0;
    const hasSimulation =
      t.simulation !== undefined && t.simulation !== null && typeof t.simulation === "object" && !Array.isArray(t.simulation);
    if (hasMessages === hasSimulation) {
      return { ok: false, problem: `Task "${t.id}" needs exactly one of "messages" (a list that is not empty) or "simulation".` };
    }
    trials += typeof t.trials === "number" && t.trials >= 1 ? Math.floor(t.trials) : 1;
    if (usesJudge(t.reward)) judged += 1;
  }
  return { ok: true, tasks, trials, judged };
}

export function NewEvalRunDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { api } = useApi();
  const nav = useNavigate();
  const queryClient = useQueryClient();
  const { suites } = useEvalSuites(open);
  const { byId } = useAgents();

  const [agentId, setAgentId] = useState("");
  const [environmentId, setEnvironmentId] = useState("");
  const [envTouched, setEnvTouched] = useState(false);
  const [judgeCardId, setJudgeCardId] = useState(AUTO_JUDGE);
  const [judgeLevel, setJudgeLevel] = useState("max");
  // The tasks: the form's cards, or the JSON while "Edit as JSON" is open.
  const [mode, setMode] = useState<"form" | "json">("form");
  const [tasks, setTasks] = useState<TaskDraft[]>(firstTask);
  const [openTask, setOpenTask] = useState(0);
  const [taskErrors, setTaskErrors] = useState<TaskFieldErrors[]>([]);
  const [tasksJson, setTasksJson] = useState(() => toJson(firstTask()));
  const [source, setSource] = useState(TEMPLATE);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [error, setError] = useState("");
  const tasksRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setAgentId("");
    setEnvironmentId("");
    setEnvTouched(false);
    setJudgeCardId(AUTO_JUDGE);
    setJudgeLevel("max");
    setMode("form");
    setTasks(firstTask());
    setOpenTask(0);
    setTaskErrors([]);
    setTasksJson(toJson(firstTask()));
    setSource(TEMPLATE);
    setError("");
  }, [open]);

  // Fill in the agent's own environment until the person picks one.
  const agent = byId.get(agentId);
  const agentDefault = defaultEnvironmentOf(agent);
  useEffect(() => {
    if (open && !envTouched && agentDefault) setEnvironmentId(agentDefault);
  }, [open, agentDefault, envTouched]);

  const reading = useMemo(() => readTasks(tasksJson), [tasksJson]);
  // On the form a problem is shown on its field, so the summary only counts.
  const formReading = useMemo<Reading>(() => {
    let trials = 0;
    let judged = 0;
    for (const t of tasks) {
      const n = Number(t.trials);
      trials += Number.isInteger(n) && n >= 1 ? n : 1;
      if (t.formable ? usesJudge(t.raw?.reward) : true) judged += 1;
    }
    return { ok: true, tasks, trials, judged };
  }, [tasks]);
  const formProblems = taskErrors.some(hasErrors);

  /** Put these tasks in front of the person, in whichever view is open. */
  const showTasks = (next: TaskDraft[]) => {
    setTasks(next);
    setTaskErrors([]);
    setOpenTask(0);
    setTasksJson(toJson(next));
  };

  /** Start from the template, or from the tasks of a saved suite. */
  async function startFrom(choice: string) {
    setSource(choice);
    if (choice === TEMPLATE) {
      showTasks(firstTask());
      return;
    }
    setSourceLoading(true);
    try {
      const suite = await api<EvalSuite>(`${SUITES_KEY}/${choice}`, { silentErrors: true });
      const copied = (suite.tasks ?? []).map(taskToDraft);
      showTasks(copied.length > 0 ? copied : firstTask());
      if (!agentId && suite.agent_id) setAgentId(suite.agent_id);
    } catch (e) {
      toast.error(withReason("That suite could not be loaded", e));
      setSource(TEMPLATE);
    } finally {
      setSourceLoading(false);
    }
  }

  const editTask = (i: number, patch: Partial<TaskDraft>) => {
    setTasks((prev) => prev.map((t, j) => (j === i ? { ...t, ...patch } : t)));
    setTaskErrors((prev) => prev.map((e, j) => (j === i ? clearFor(e, patch) : e)));
  };
  const addTask = () => {
    setTasks((prev) => [...prev, blankTask(prev.map((t) => t.id.trim()))]);
    setTaskErrors((prev) => [...prev, {}]);
    setOpenTask(tasks.length);
  };
  const removeTask = (i: number) => {
    setTasks((prev) => prev.filter((_, j) => j !== i));
    setTaskErrors((prev) => prev.filter((_, j) => j !== i));
    setOpenTask((cur) => (cur > i ? cur - 1 : cur === i ? -1 : cur));
  };

  /** The form's tasks become JSON; valid JSON comes back to the form. */
  const toJsonView = () => {
    setTasksJson(toJson(tasks));
    setMode("json");
  };
  const toFormView = () => {
    const read = readTasks(tasksJson);
    if (!read.ok) return;
    showTasks(read.tasks.map(taskToDraft));
    setMode("form");
  };

  const create = useAsyncAction(async () => {
    setError("");
    let payload: Array<{ reward?: unknown }>;
    if (mode === "form") {
      const errs = checkTasks(tasks);
      setTaskErrors(errs);
      const bad = errs.findIndex(hasErrors);
      if (bad >= 0) {
        setOpenTask(bad);
        // Take the person to the first field that needs them, once its card is open.
        window.setTimeout(() => {
          const field = tasksRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
          field?.focus({ preventScroll: true });
          field?.scrollIntoView({ block: "center" });
        }, 60);
        return;
      }
      payload = tasks.map(draftToTask);
    } else {
      const read = readTasks(tasksJson);
      if (!read.ok) return;
      // Parse again so the judge is written into a copy, not into what is on screen.
      payload = JSON.parse(tasksJson) as Array<{ reward?: unknown }>;
    }
    for (const t of payload) {
      injectJudge(t.reward, {
        ...(judgeCardId !== AUTO_JUDGE ? { model_card_id: judgeCardId } : {}),
        reasoning_level: judgeLevel,
      });
    }
    try {
      const res = await api<{ run_id: string }>(RUNS_KEY, {
        method: "POST",
        body: JSON.stringify({ agent_id: agentId, environment_id: environmentId, tasks: payload }),
        silentErrors: true,
      });
      void queryClient.invalidateQueries({ queryKey: [RUNS_KEY] });
      onClose();
      nav(`/evals/${res.run_id}`);
    } catch (e) {
      setError(failureSentence(e));
    }
  });

  const ready = !!agentId && !!environmentId && (mode === "form" || reading.ok);

  return (
    <Modal
      open={open}
      onClose={() => !create.loading && onClose()}
      title="New eval run"
      subtitle="Give an agent a set of tasks. Each trial runs as its own session, and a judge model grades what the agent did."
      maxWidth="max-w-2xl"
      footer={
        <>
          <span className="mr-auto hidden min-w-0 truncate text-small text-fg-subtle sm:block">
            {!agentId
              ? "Choose an agent to start."
              : !environmentId
                ? "Choose an environment to run in."
                : mode === "json" && !reading.ok
                  ? "Fix the tasks to continue."
                  : formProblems
                    ? "Fix the marked fields to continue."
                    : ""}
          </span>
          <Button variant="ghost" onClick={onClose} disabled={create.loading}>
            Cancel
          </Button>
          <Button onClick={create.run} disabled={!ready} loading={create.loading}>
            Start run
          </Button>
        </>
      }
    >
      <div className="space-y-8">
        {error && (
          <Callout tone="danger" title="The run could not be started">
            {error}
          </Callout>
        )}

        <div className="grid gap-x-4 gap-y-5 sm:grid-cols-2">
          <AgentField value={agentId} onChange={(id) => setAgentId(id)} fallbackName={agent?.name} hint="The agent being tested." />
          <EnvironmentField
            value={environmentId}
            onChange={(id) => {
              setEnvTouched(true);
              setEnvironmentId(id);
            }}
          />
        </div>

        <DialogSection
          title="Tasks"
          description="What the agent is told, how many times to try, and how each attempt is graded."
          action={
            suites.length > 0 ? (
              <Select
                value={source}
                onValueChange={(v) => void startFrom(v)}
                disabled={sourceLoading}
                aria-label="Start the tasks from"
                className="h-8 w-[220px]"
              >
                <SelectOption value={TEMPLATE}>Start from a blank task</SelectOption>
                <SelectSeparator />
                {suites.map((s) => (
                  <SelectOption key={s.id} value={s.id}>
                    Copy from {s.name}
                  </SelectOption>
                ))}
              </Select>
            ) : undefined
          }
        >
          {mode === "form" ? (
            <div ref={tasksRef} className="space-y-2.5">
              {tasks.map((task, i) => (
                <TaskCard
                  key={i}
                  index={i}
                  task={task}
                  errors={taskErrors[i] ?? {}}
                  open={openTask === i}
                  onOpenChange={(o) => setOpenTask(o ? i : -1)}
                  onChange={(patch) => editTask(i, patch)}
                  onRemove={tasks.length > 1 ? () => removeTask(i) : undefined}
                  onEditAsJson={toJsonView}
                />
              ))}
              <div className="flex items-center justify-between gap-3 pt-1">
                <Button variant="ghost" size="sm" className="-ml-2" onClick={addTask}>
                  <PlusIcon data-icon="inline-start" />
                  Add task
                </Button>
                <Tip label="For a simulated user, setup scripts or a composite reward">
                  <Button variant="ghost" size="sm" className="-mr-2" onClick={toJsonView}>
                    <BracesIcon data-icon="inline-start" />
                    Edit as JSON
                  </Button>
                </Tip>
              </div>
            </div>
          ) : (
            <>
              <Textarea
                id="eval-tasks-json"
                aria-label="Tasks, as JSON"
                aria-describedby="eval-tasks-json-status"
                aria-invalid={!reading.ok || undefined}
                value={tasksJson}
                onChange={(e) => setTasksJson(e.target.value)}
                spellCheck={false}
                autoFocus
                className="h-64 resize-y overflow-auto font-mono text-xs leading-relaxed whitespace-pre [field-sizing:fixed] md:text-xs"
              />
              <div className="mt-2 flex items-start justify-between gap-4">
                <TasksReading id="eval-tasks-json-status" reading={reading} />
                {/* Back to the form only with JSON the form can read, so nothing is lost on the way. */}
                <Tip label={reading.ok ? undefined : "Fix the JSON first: the form shows only tasks it can read"}>
                  <span className="inline-flex shrink-0">
                    <Button variant="ghost" size="sm" className="-mr-2" onClick={toFormView} disabled={!reading.ok}>
                      <ListChecksIcon data-icon="inline-start" />
                      Back to the form
                    </Button>
                  </span>
                </Tip>
              </div>

              <Disclosure title="What a task can contain" className="mt-4">
                <dl className="space-y-2.5 text-small">
                  {TASK_FIELDS.map(([name, text]) => (
                    <div key={name} className="grid grid-cols-[8.5rem_minmax(0,1fr)] gap-3">
                      <dt className="font-mono text-xs leading-5 text-fg">{name}</dt>
                      <dd className="text-fg-muted">{text}</dd>
                    </div>
                  ))}
                </dl>
              </Disclosure>
            </>
          )}
          {mode === "form" && <TasksReading reading={formReading} className="mt-3" />}
        </DialogSection>

        <DialogSection title="Judge" description="Used for every task that is graded by a judge. It is written into the tasks when the run starts.">
          <JudgeFields cardId={judgeCardId} onCardChange={setJudgeCardId} level={judgeLevel} onLevelChange={setJudgeLevel} enabled={open} />
        </DialogSection>
      </div>
    </Modal>
  );
}

/** What the tasks add up to, in words; or, in JSON, what is wrong with them. Updates as you type. */
function TasksReading({ reading, id, className }: { reading: Reading; id?: string; className?: string }) {
  return (
    <p id={id} role="status" className={cn("flex items-start gap-2 text-small", className)}>
      {reading.ok ? (
        <>
          <CircleCheckIcon className="mt-0.5 size-4 shrink-0 text-success" />
          <span className="text-fg-muted">
            <span className="font-medium text-fg">
              {plural(reading.tasks.length, "task")}, {plural(reading.trials, "trial")} in all.
            </span>{" "}
            {reading.judged === reading.tasks.length
              ? "The judge grades every one."
              : reading.judged === 0
                ? "None is graded by the judge."
                : `The judge grades ${reading.judged} of them.`}
          </span>
        </>
      ) : (
        <>
          <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-danger" />
          <span className="text-danger">{reading.problem}</span>
        </>
      )}
    </p>
  );
}

/**
 * One task on the form: a row that says what it is (its name, how many
 * messages and trials), opening to the task form. A task the form cannot
 * show truthfully says why and offers JSON.
 */
function TaskCard({
  index,
  task,
  errors,
  open,
  onOpenChange,
  onChange,
  onRemove,
  onEditAsJson,
}: {
  index: number;
  task: TaskDraft;
  errors: TaskFieldErrors;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (patch: Partial<TaskDraft>) => void;
  onRemove?: () => void;
  onEditAsJson: () => void;
}) {
  const invalid = hasErrors(errors);
  const messages = task.messages.filter((m) => m.trim()).length;
  const trials = Number(task.trials);
  const meta = task.formable
    ? "Edited as JSON"
    : [messages === 0 ? "No message yet" : plural(messages, "message"), Number.isInteger(trials) && trials >= 1 ? plural(trials, "trial") : null]
        .filter(Boolean)
        .join(" · ");
  const prefix = `eval-task-${index}`;
  return (
    <Collapsible
      open={open}
      onOpenChange={onOpenChange}
      className={cn("rounded-lg border bg-bg-surface", invalid ? "border-danger/60" : "border-border")}
    >
      <div className="flex items-center gap-1 pr-1.5">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg px-3.5 py-2.5 text-left transition-quick hover:bg-bg-hover"
          >
            <ChevronRightIcon
              aria-hidden="true"
              className={cn("size-4 shrink-0 text-fg-subtle transition-transform duration-[var(--dur-base)] ease-[var(--ease-rise)]", open && "rotate-90")}
            />
            <span className="min-w-0 flex-1 truncate font-mono text-small-size text-fg" title={task.id || undefined}>
              {task.id.trim() || <span className="font-sans text-fg-subtle">Task {index + 1}, not named yet</span>}
            </span>
            {invalid && !open ? (
              <span className="shrink-0 text-xs text-danger">Needs a fix</span>
            ) : (
              <span className="shrink-0 text-xs text-fg-subtle">{meta}</span>
            )}
          </button>
        </CollapsibleTrigger>
        {onRemove && (
          <Tip label="Remove this task">
            <Button variant="ghost" size="icon-sm" aria-label={`Remove ${task.id.trim() || `task ${index + 1}`}`} onClick={onRemove}>
              <Trash2Icon />
            </Button>
          </Tip>
        )}
      </div>
      <CollapsibleContent className="collapsible-content overflow-hidden">
        <div className="space-y-6 border-t border-border px-4 pt-4 pb-5">
          {task.formable ? (
            <Callout
              title="This task is edited as JSON"
              action={
                <Button variant="outline" size="sm" onClick={onEditAsJson}>
                  Edit as JSON
                </Button>
              }
            >
              {task.formable} It is kept exactly as it is.
            </Callout>
          ) : (
            <>
              <TaskBasics task={task} onChange={onChange} errors={errors} idPrefix={prefix} />
              <TaskGrading task={task} onChange={onChange} errors={errors} idPrefix={prefix} />
            </>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

const TASK_FIELDS: Array<[string, string]> = [
  ["id", "A short name for the task. It is how the task appears in results."],
  ["messages", "What the agent is told: one user message per entry, sent in order."],
  ["simulation", "Instead of messages: a persona that plays the user. New simulation writes these for you."],
  ["trials", "How many times to run the task. More trials show whether a pass is reliable. Default 1."],
  ["pass_threshold", "The score a trial needs to pass, from 0 to 1. Default 1, a full pass."],
  ["timeout_ms", "How long one trial may take before it is stopped."],
  ["setup_script", "Shell commands run in the sandbox before the first message. setup_files places files there."],
  [
    "reward",
    'How a trial is graded. "llm_judge" has the judge model grade it against your rubric. A "composite" can add pass-or-fail gates (components named gate:*); a failing gate ends grading before the judge is asked.',
  ],
];
