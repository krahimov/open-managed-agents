// "Save as eval": turn a session that went well into a task that can be
// run again.
//
// Opened from a session's header. Opening it starts nothing the person did
// not ask for. The form needs the session's own words, so it asks
// POST /v1/evals/draft_task_from_session for those alone
// (`draft_rubric: false`): the server rebuilds the task's messages from
// what the user said and hands back a rubric template. No model runs, and
// it answers at once.
//
// Having the judge model write the rubric from what the agent actually
// delivered is the same endpoint without that flag. It costs a model call
// and can take up to a minute, so it is a button ("Draft the rubric"),
// next to the rubric it fills in. While it runs the dialog says what is
// happening and offers a way back to the form; nothing else on the form is
// overwritten when it lands, only the rubric.
//
// Everything is editable before it is saved to a new or existing suite. A
// server without the endpoint answers 501 (older ones 404): the form then
// opens empty, to be filled in by hand.

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

import { Callout } from "../../components/Callout";
import { Modal } from "../../components/Modal";
import { Tip } from "../../components/Tip";
import { RUNS_KEY, SUITES_KEY, useEvalSuites } from "../../components/evals/data";
import { DialogSection, DraftingState, NEW_SUITE, SuiteFields } from "../../components/evals/fields";
import { clearFor, TaskBasics, TaskGrading } from "../../components/evals/TaskForm";
import { blankTask, checkTask, draftToTask, hasErrors, taskToDraft, type TaskDraft, type TaskFieldErrors } from "../../components/evals/task-draft";
import { useAsyncAction } from "../../hooks/useAsyncAction";
import { ApiError, useApi } from "../../lib/api";
import { describeModel } from "../../lib/models";
import { useQueryClient } from "../../lib/useApiQuery";
import { failureSentence, withReason } from "../../lib/failure-text";

interface DraftedTask {
  id: string;
  messages: string[];
  timeout_ms?: number;
  trials?: number;
  reward?: { type: string; rubric?: string };
}

interface DraftResponse {
  task: DraftedTask;
  agent_id?: string;
  environment_id?: string;
  rubric_drafted_by: string;
}

type FieldErrors = TaskFieldErrors & { suiteName?: string };

/** The form before the session's words arrive, or when they cannot: empty, to be written by hand. */
const emptyTask = (): TaskDraft => ({ ...blankTask(), id: "", rubric: "" });

export function SaveAsEvalDialog({
  open,
  onClose,
  sessionId,
  agentId,
  agentName,
  environmentId,
}: {
  open: boolean;
  onClose: () => void;
  sessionId: string;
  agentId?: string;
  agentName?: string;
  environmentId?: string;
}) {
  const { api } = useApi();
  const nav = useNavigate();
  const queryClient = useQueryClient();
  const { suites } = useEvalSuites(open);

  // "reading": the session's messages are on their way (no model).
  // "drafting": the judge model is writing the rubric, because it was asked to.
  const [phase, setPhase] = useState<"reading" | "form" | "drafting">("reading");
  const drafting = phase === "drafting";
  const [rubricDraftedBy, setRubricDraftedBy] = useState("");
  const [draftUnavailable, setDraftUnavailable] = useState(false);
  const [draftError, setDraftError] = useState("");
  /** Which request failed: reading the session ("task") or the model's rubric. */
  const [draftFailedOn, setDraftFailedOn] = useState<"task" | "rubric">("task");
  const [error, setError] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});

  // The task, as the shared task form holds it (components/evals/TaskForm).
  const [task, setTask] = useState<TaskDraft>(emptyTask);
  const editTask = (patch: Partial<TaskDraft>) => {
    setTask((prev) => ({ ...prev, ...patch }));
    setErrors((prev) => clearFor(prev, patch));
  };

  const [suiteChoice, setSuiteChoice] = useState(NEW_SUITE);
  const [newSuiteName, setNewSuiteName] = useState("");

  // The draft request in flight. Cancel, close and unmount abort it.
  const acRef = useRef<AbortController | null>(null);

  /**
   * Ask the server about this session. Without `withRubric` it returns the
   * session's messages and a rubric template at once, with no model call:
   * that is what opening the dialog does. With it, the judge model writes
   * the rubric: only ever on the person's click.
   */
  function draft(withRubric: boolean) {
    acRef.current?.abort();
    const ac = new AbortController();
    acRef.current = ac;
    setPhase(withRubric ? "drafting" : "reading");
    setDraftError("");
    api<DraftResponse>("/v1/evals/draft_task_from_session", {
      method: "POST",
      body: JSON.stringify({ session_id: sessionId, ...(withRubric ? {} : { draft_rubric: false }) }),
      signal: ac.signal,
      // A failure is shown in the form (which still works by hand), and
      // a server without the endpoint would otherwise toast on every open.
      silentErrors: true,
    })
      .then((res) => {
        if (withRubric) {
          // The person may have edited the task while they decided: the
          // model's draft fills in the rubric and touches nothing else.
          editTask({ rubric: res.task.reward?.rubric ?? "" });
        } else {
          setTask(taskToDraft(res.task));
        }
        setRubricDraftedBy(res.rubric_drafted_by);
        setPhase("form");
      })
      .catch((e) => {
        if (ac.signal.aborted) return;
        if (e instanceof ApiError && (e.status === 501 || e.status === 404)) setDraftUnavailable(true);
        else setDraftError(failureSentence(e));
        setDraftFailedOn(withRubric ? "rubric" : "task");
        setPhase("form");
      });
  }

  /** Stop waiting for the model and go back to the form as it was. */
  function stopDrafting() {
    acRef.current?.abort();
    setPhase("form");
  }

  useEffect(() => {
    if (!open) return;
    setError("");
    setErrors({});
    setDraftUnavailable(false);
    setRubricDraftedBy("");
    setTask(emptyTask());
    setSuiteChoice(NEW_SUITE);
    setNewSuiteName(`${agentName || "Agent"} suite`);
    // The session's own messages, and a template: no model is asked for anything here.
    draft(false);
    return () => acRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sessionId, agentName, api]);

  /** Check the form. Returns the task, or null with each problem on its field. */
  function buildTask(): DraftedTask | null {
    const next: FieldErrors = checkTask(task);
    if (suiteChoice === NEW_SUITE && !newSuiteName.trim()) next.suiteName = "Give the suite a name.";
    setErrors(next);
    if (hasErrors(next)) return null;
    return draftToTask(task) as unknown as DraftedTask;
  }

  /** Create the suite, or add the task to the chosen one. */
  async function saveToSuite(task: DraftedTask): Promise<{ id: string; name: string }> {
    if (suiteChoice === NEW_SUITE) {
      return api<{ id: string; name: string }>(SUITES_KEY, {
        method: "POST",
        body: JSON.stringify({
          name: newSuiteName.trim(),
          ...(agentId ? { agent_id: agentId } : {}),
          tasks: [task],
          source_sessions: [sessionId],
        }),
        silentErrors: true,
      });
    }
    return api<{ id: string; name: string }>(`${SUITES_KEY}/${suiteChoice}`, {
      method: "POST",
      body: JSON.stringify({ append_task: task }),
      silentErrors: true,
    });
  }

  const save = useAsyncAction(async () => {
    setError("");
    const task = buildTask();
    if (!task) return;
    try {
      const suite = await saveToSuite(task);
      void queryClient.invalidateQueries({ queryKey: [SUITES_KEY] });
      toast.success(`Saved ${task.id} to ${suite.name}`);
      onClose();
    } catch (e) {
      // Stay open so nothing typed is lost.
      setError(failureSentence(e));
    }
  });

  const saveAndRun = useAsyncAction(async () => {
    setError("");
    const task = buildTask();
    if (!task) return;
    if (!environmentId) return;
    try {
      const suite = await saveToSuite(task);
      void queryClient.invalidateQueries({ queryKey: [SUITES_KEY] });
      const res = await api<{ run_id: string }>(`${SUITES_KEY}/${suite.id}/run`, {
        method: "POST",
        // The agent rides along so a suite with none of its own still runs.
        body: JSON.stringify({ environment_id: environmentId, ...(agentId ? { agent_id: agentId } : {}) }),
        silentErrors: true,
      });
      void queryClient.invalidateQueries({ queryKey: [RUNS_KEY] });
      toast.success(`Saved ${task.id} to ${suite.name}. The run has started.`);
      onClose();
      nav(`/evals/${res.run_id}`);
    } catch (e) {
      // The task may have been saved even though the run did not start;
      // the suites list was refreshed above, so nothing on screen is stale.
      setError(withReason("The run could not be started", e));
    }
  });

  const busy = save.loading || saveAndRun.loading;
  const isTemplate = rubricDraftedBy === "template";
  const clear = (key: keyof FieldErrors) => setErrors((prev) => (prev[key] ? { ...prev, [key]: undefined } : prev));

  return (
    <Modal
      open={open}
      onClose={() => !busy && onClose()}
      title="Save as eval"
      subtitle="Keep this session as a task you can run again: what the user asked becomes the task, and a rubric grades each new attempt."
      maxWidth="max-w-2xl"
      footer={
        phase === "reading" ? (
          <Button variant="ghost" onClick={onClose} className="mr-auto">
            Cancel
          </Button>
        ) : drafting ? (
          <>
            <Button variant="ghost" onClick={onClose} className="mr-auto">
              Cancel
            </Button>
            <Tip label="Go back to the form. The template rubric is still there to fill in.">
              <Button variant="outline" onClick={stopDrafting}>
                Stop and write it myself
              </Button>
            </Tip>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={busy} className="mr-auto">
              Cancel
            </Button>
            <Button variant="outline" onClick={save.run} disabled={busy} loading={save.loading}>
              Save to suite
            </Button>
            {/* A disabled button takes no pointer events, so the reason rides a wrapper. */}
            <Tip label={environmentId ? undefined : "This session has no environment to run in"}>
              <span className="inline-flex">
                <Button onClick={saveAndRun.run} disabled={busy || !environmentId} loading={saveAndRun.loading}>
                  Save and run
                </Button>
              </span>
            </Tip>
          </>
        )
      }
    >
      {phase === "reading" ? (
        <DraftingState title="Reading this session" body="Collecting what the user asked, to use as the task." />
      ) : drafting ? (
        <DraftingState
          title="Drafting the rubric"
          body="The judge model is reading what the agent did and writing the checks a new attempt should pass. This can take up to a minute."
        />
      ) : (
        <div className="space-y-8">
          {(error || draftError || draftUnavailable) && (
            <div className="space-y-3">
              {error && (
                <Callout tone="danger" title="That did not save">
                  {error}
                </Callout>
              )}
              {draftError && (
                <Callout tone="danger" title={draftFailedOn === "rubric" ? "The rubric could not be drafted" : "This session could not be read"}>
                  {draftError} You can still write {draftFailedOn === "rubric" ? "it" : "the task"} by hand below.
                </Callout>
              )}
              {draftUnavailable && (
                <Callout title="This server cannot draft tasks">Write the task by hand below. Saving to a suite works as usual.</Callout>
              )}
            </div>
          )}

          <DialogSection title="The task" description="What a new attempt is given. Taken from what the user said in this session.">
            <TaskBasics task={task} onChange={editTask} errors={errors} idPrefix="sae" />
          </DialogSection>

          <DialogSection
            title="Grading"
            description={
              rubricDraftedBy && !isTemplate
                ? `The rubric was drafted by ${describeModel(rubricDraftedBy).label} from what the agent delivered. Read it before you trust it.`
                : "The rubric the judge grades each new attempt against."
            }
          >
            <TaskGrading
              task={task}
              onChange={editTask}
              errors={errors}
              idPrefix="sae"
              notice={
                isTemplate && !draftUnavailable ? (
                  // The one thing here that calls a model, so it is asked for, never assumed.
                  <Callout
                    tone="warning"
                    title="This rubric is a template"
                    action={
                      <Button variant="outline" size="sm" onClick={() => draft(true)} disabled={busy}>
                        Draft the rubric
                      </Button>
                    }
                  >
                    It still has placeholders. Replace them with what a good answer must contain, or have the judge model draft it from
                    what the agent delivered in this session (up to a minute).
                  </Callout>
                ) : undefined
              }
            />
          </DialogSection>

          <DialogSection title="Save to" description="Put it with the tasks it belongs with.">
            <SuiteFields
              suites={suites}
              choice={suiteChoice}
              onChoiceChange={setSuiteChoice}
              name={newSuiteName}
              onNameChange={(v) => {
                setNewSuiteName(v);
                clear("suiteName");
              }}
              nameError={errors.suiteName}
            />
          </DialogSection>
        </div>
      )}
    </Modal>
  );
}
