// "Save as eval" dialog (evals-design §8 save-as-eval).
//
// Opened from a session's header. On open we POST
// /v1/evals/draft_task_from_session: the backend rebuilds the task
// messages from the session's user.message events and asks the tenant's
// cross-family judge to author a §4.3 rubric (static-template fallback).
// Drafting can take up to a minute, so the dialog stays responsive with
// a Cancel that aborts the in-flight draft. The drafted task is fully
// editable before saving into a new or existing suite. The draft endpoint
// is Node-only — the CF eval router 501s it — so on such runtimes the
// dialog falls back to hand-authoring (suites CRUD still works there).

import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";

import { ApiError, useApi } from "../../lib/api";
import { useApiQuery, useQueryClient } from "../../lib/useApiQuery";
import { useAsyncAction } from "../../hooks/useAsyncAction";
import { Modal } from "../../components/Modal";
import { Select, SelectOption } from "../../components/Select";
import { Button } from "@/components/ui/button";

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

interface SuiteSummary {
  id: string;
  name: string;
  agent_id?: string;
  task_count: number;
  updated_at: string;
}

// Radix Select items can't carry an empty-string value.
const NEW_SUITE = "__new__";

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

  const [drafting, setDrafting] = useState(false);
  const [rubricDraftedBy, setRubricDraftedBy] = useState("");
  const [draftUnavailable, setDraftUnavailable] = useState(false);
  const [error, setError] = useState("");

  const [taskId, setTaskId] = useState("");
  const [messages, setMessages] = useState<string[]>([""]);
  const [rubric, setRubric] = useState("");
  const [trials, setTrials] = useState("1");
  const [passThreshold, setPassThreshold] = useState("1");
  const [timeoutSec, setTimeoutSec] = useState("600");

  const [suiteChoice, setSuiteChoice] = useState(NEW_SUITE);
  const [newSuiteName, setNewSuiteName] = useState("");

  // Draft on open. The AbortController doubles as the Cancel path — the
  // effect cleanup fires it too, so navigating away mid-draft is safe.
  useEffect(() => {
    if (!open) return;
    setError("");
    setDraftUnavailable(false);
    setRubricDraftedBy("");
    setTaskId("");
    setMessages([""]);
    setRubric("");
    setTrials("1");
    setPassThreshold("1");
    setTimeoutSec("600");
    setSuiteChoice(NEW_SUITE);
    setNewSuiteName(`${agentName || "agent"} suite`);

    setDrafting(true);
    const ac = new AbortController();
    api<DraftResponse>("/v1/evals/draft_task_from_session", {
      method: "POST",
      body: JSON.stringify({ session_id: sessionId }),
      signal: ac.signal,
      // Draft failures are handled inline below (the form still works
      // hand-authored), and a runtime without the endpoint would toast on
      // every open otherwise.
      silentErrors: true,
    })
      .then((res) => {
        setTaskId(res.task.id);
        setMessages(res.task.messages.length > 0 ? res.task.messages : [""]);
        setRubric(res.task.reward?.rubric ?? "");
        setTrials(String(res.task.trials ?? 1));
        setTimeoutSec(String(Math.round((res.task.timeout_ms ?? 600_000) / 1000)));
        setRubricDraftedBy(res.rubric_drafted_by);
        setDrafting(false);
      })
      .catch((e) => {
        if (ac.signal.aborted) return;
        // Drafting lives only in the Node runtime (apps/main-node); the
        // CF eval router answers 501 (older deploys 404). That's not an
        // error — show hand-author mode with a note instead.
        if (e instanceof ApiError && (e.status === 501 || e.status === 404)) {
          setDraftUnavailable(true);
        } else {
          // Keep the dialog open with an inline error so the user can
          // still hand-author the task.
          setError(e instanceof Error ? e.message : "Failed to draft task from session");
        }
        setDrafting(false);
      });
    return () => ac.abort();
  }, [open, sessionId, agentName, api]);

  const { data: suitesRes } = useApiQuery<{ data: SuiteSummary[] }>(
    "/v1/evals/suites",
    undefined,
    { enabled: open },
  );
  const suites = suitesRes?.data ?? [];

  /** Validate the form into an EvalTaskSpec, or null (with inline error). */
  function buildTask(): (DraftedTask & { pass_threshold: number }) | null {
    const id = taskId.trim();
    if (!id) {
      setError("Task id is required.");
      return null;
    }
    const msgs = messages.filter((m) => m.trim());
    if (msgs.length === 0) {
      setError("At least one non-empty message is required.");
      return null;
    }
    if (!rubric.trim()) {
      setError("Rubric is required.");
      return null;
    }
    const trialsN = Number(trials);
    if (!Number.isInteger(trialsN) || trialsN < 1) {
      setError("Trials must be a whole number ≥ 1.");
      return null;
    }
    const thresholdN = Number(passThreshold);
    if (!Number.isFinite(thresholdN) || thresholdN < 0 || thresholdN > 1) {
      setError("Pass threshold must be between 0 and 1.");
      return null;
    }
    const timeoutN = Number(timeoutSec);
    if (!Number.isFinite(timeoutN) || timeoutN < 1) {
      setError("Timeout must be at least 1 second.");
      return null;
    }
    return {
      id,
      messages: msgs,
      timeout_ms: Math.round(timeoutN * 1000),
      trials: trialsN,
      pass_threshold: thresholdN,
      reward: { type: "llm_judge", rubric: rubric.trim() },
    };
  }

  /** Create the target suite (or append to the chosen one). Throws on
   *  API failure — api() has already toasted by then. */
  async function saveToSuite(task: DraftedTask): Promise<{ id: string; name: string }> {
    if (suiteChoice === NEW_SUITE) {
      const name = newSuiteName.trim();
      if (!name) throw new Error("Suite name is required.");
      return api<{ id: string; name: string }>("/v1/evals/suites", {
        method: "POST",
        body: JSON.stringify({
          name,
          ...(agentId ? { agent_id: agentId } : {}),
          tasks: [task],
          source_sessions: [sessionId],
        }),
      });
    }
    return api<{ id: string; name: string }>(`/v1/evals/suites/${suiteChoice}`, {
      method: "POST",
      body: JSON.stringify({ append_task: task }),
    });
  }

  const save = useAsyncAction(async () => {
    setError("");
    const task = buildTask();
    if (!task) return;
    if (suiteChoice === NEW_SUITE && !newSuiteName.trim()) {
      setError("Suite name is required.");
      return;
    }
    try {
      const suite = await saveToSuite(task);
      void queryClient.invalidateQueries({ queryKey: ["/v1/evals/suites"] });
      toast.success(`Saved ${task.id} to ${suite.name}`);
      onClose();
    } catch {
      // api() toasted; leave the dialog open so nothing typed is lost.
    }
  });

  const saveAndRun = useAsyncAction(async () => {
    setError("");
    const task = buildTask();
    if (!task) return;
    if (suiteChoice === NEW_SUITE && !newSuiteName.trim()) {
      setError("Suite name is required.");
      return;
    }
    if (!environmentId) return;
    try {
      const suite = await saveToSuite(task);
      void queryClient.invalidateQueries({ queryKey: ["/v1/evals/suites"] });
      const res = await api<{ run_id: string }>(`/v1/evals/suites/${suite.id}/run`, {
        method: "POST",
        // agent_id rides along so appending to a suite without a pinned
        // agent still runs (the route 400s otherwise).
        body: JSON.stringify({
          environment_id: environmentId,
          ...(agentId ? { agent_id: agentId } : {}),
        }),
      });
      void queryClient.invalidateQueries({ queryKey: ["/v1/evals/runs"] });
      toast.success(`Saved ${task.id} to ${suite.name} — run started`);
      onClose();
      nav(`/evals/${res.run_id}`);
    } catch {
      // Save may have landed even when the run failed — the suites cache
      // was already invalidated above, so the list stays truthful.
    }
  });

  const busy = save.loading || saveAndRun.loading;
  const inputCls =
    "w-full px-3 py-1.5 rounded-md bg-bg border border-border text-sm text-fg placeholder:text-fg-subtle focus:outline-none focus:ring-1 focus:ring-brand";

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Save as eval"
      subtitle="Snapshot this session into a suite task — its user messages become the task input; the rubric grades fresh attempts."
      maxWidth="max-w-2xl"
      footer={
        drafting ? (
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="outline"
              onClick={save.run}
              disabled={busy}
              loading={save.loading}
              loadingLabel="Saving…"
            >
              Save to suite
            </Button>
            {/* Disabled shadcn buttons are pointer-events-none, so the
                "why is this disabled" tooltip rides a wrapping span. */}
            <span title={environmentId ? undefined : "Session has no environment to run against"}>
              <Button
                onClick={saveAndRun.run}
                disabled={busy || !environmentId}
                loading={saveAndRun.loading}
                loadingLabel="Starting…"
              >
                Save &amp; run
              </Button>
            </span>
          </>
        )
      }
    >
      {drafting ? (
        <div className="flex items-center gap-3 py-10 justify-center text-sm text-fg-muted">
          <svg className="animate-spin h-4 w-4 text-fg-subtle" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <span>
            Drafting rubric with the cross-family judge… this can take up to a minute.
          </span>
        </div>
      ) : (
        <div className="space-y-3">
          {draftUnavailable && (
            <div className="text-sm text-fg-muted bg-bg-surface border border-border rounded-lg px-3 py-2">
              Automatic drafting isn&apos;t available on this runtime — author the
              task by hand. Saving to a suite still works.
            </div>
          )}
          {error && (
            <div className="text-sm text-danger bg-danger-subtle border border-danger/30 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <div>
            <label htmlFor="sae-task-id" className="text-sm text-fg-muted block mb-1">
              Task id *
            </label>
            <input
              id="sae-task-id"
              value={taskId}
              onChange={(e) => setTaskId(e.target.value)}
              className={inputCls}
              placeholder="task-id"
              spellCheck={false}
            />
          </div>

          <div>
            <span className="text-sm text-fg-muted block mb-1">Messages *</span>
            <div className="space-y-2">
              {messages.map((m, i) => (
                <div key={i} className="flex items-start gap-2">
                  <textarea
                    value={m}
                    onChange={(e) =>
                      setMessages((prev) => prev.map((p, j) => (j === i ? e.target.value : p)))
                    }
                    className={`${inputCls} min-h-16 resize-y`}
                    placeholder={`User message ${i + 1}`}
                    aria-label={`Message ${i + 1}`}
                  />
                  {messages.length > 1 && (
                    <button
                      onClick={() => setMessages((prev) => prev.filter((_, j) => j !== i))}
                      className="mt-1 text-fg-subtle hover:text-danger text-sm"
                      title="Remove message"
                      aria-label={`Remove message ${i + 1}`}
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))}
            </div>
            <button
              onClick={() => setMessages((prev) => [...prev, ""])}
              className="mt-1.5 text-xs text-fg-muted hover:text-fg"
            >
              + Add message
            </button>
          </div>

          <div>
            <label htmlFor="sae-rubric" className="text-sm text-fg-muted block mb-1">
              Rubric *
              {rubricDraftedBy && (
                <span className="text-fg-subtle">
                  {" "}
                  — drafted by{" "}
                  <span className="font-mono">{rubricDraftedBy}</span>
                </span>
              )}
            </label>
            <textarea
              id="sae-rubric"
              value={rubric}
              onChange={(e) => setRubric(e.target.value)}
              className={`${inputCls} min-h-48 font-mono text-xs resize-y`}
              spellCheck={false}
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label htmlFor="sae-trials" className="text-sm text-fg-muted block mb-1">
                Trials
              </label>
              <input
                id="sae-trials"
                type="number"
                min={1}
                step={1}
                value={trials}
                onChange={(e) => setTrials(e.target.value)}
                className={inputCls}
              />
            </div>
            <div>
              <label htmlFor="sae-threshold" className="text-sm text-fg-muted block mb-1">
                Pass threshold
              </label>
              <input
                id="sae-threshold"
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={passThreshold}
                onChange={(e) => setPassThreshold(e.target.value)}
                className={inputCls}
              />
            </div>
            <div>
              <label htmlFor="sae-timeout" className="text-sm text-fg-muted block mb-1">
                Timeout (s)
              </label>
              <input
                id="sae-timeout"
                type="number"
                min={1}
                step={30}
                value={timeoutSec}
                onChange={(e) => setTimeoutSec(e.target.value)}
                className={inputCls}
              />
            </div>
          </div>

          <div>
            <label className="text-sm text-fg-muted block mb-1">Suite</label>
            <Select value={suiteChoice} onValueChange={setSuiteChoice}>
              <SelectOption value={NEW_SUITE}>New suite…</SelectOption>
              {suites.map((s) => (
                <SelectOption key={s.id} value={s.id}>
                  {s.name} ({s.task_count} task{s.task_count === 1 ? "" : "s"})
                </SelectOption>
              ))}
            </Select>
            {suiteChoice === NEW_SUITE && (
              <input
                value={newSuiteName}
                onChange={(e) => setNewSuiteName(e.target.value)}
                className={`${inputCls} mt-2`}
                placeholder="Suite name"
                aria-label="New suite name"
              />
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
