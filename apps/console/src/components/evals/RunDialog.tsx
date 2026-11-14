import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useApi } from "@/lib/api";
import { useAgents } from "@/lib/directory";
import { runKind, runName, runShape, runSummary, type EvalRun, type EvalSuiteSummary } from "@/lib/evals";
import { plural } from "@/lib/format";
import { useQueryClient } from "@/lib/useApiQuery";

import { Callout } from "../Callout";
import { Modal } from "../Modal";
import { RUNS_KEY, useEvalSuites } from "./data";
import { AgentField, EnvironmentField, defaultEnvironmentOf } from "./fields";
import { failureSentence } from "../../lib/failure-text";

/** What the dialog starts: a saved suite, or the tasks of an earlier run again. */
export type RunTarget = { kind: "suite"; suite: EvalSuiteSummary } | { kind: "rerun"; run: EvalRun };

/**
 * Start a run from something that already exists.
 *
 *   suite   runs the suite's current tasks (`POST /v1/evals/suites/:id/run`)
 *   rerun   a run that came from a suite runs that suite again, so the new
 *           run keeps the suite's name and history; any other run sends
 *           its own tasks again (`POST /v1/evals/runs`)
 *
 * It asks only what the run cannot know: which agent (filled in from the
 * suite or the earlier run, and changeable) and which environment (filled
 * in from the earlier run, or the agent's default).
 */
export function RunDialog({ target, onClose }: { target: RunTarget | null; onClose: () => void }) {
  return target ? <RunDialogBody key={target.kind === "suite" ? target.suite.id : target.run.id} target={target} onClose={onClose} /> : null;
}

function RunDialogBody({ target, onClose }: { target: RunTarget; onClose: () => void }) {
  const { api } = useApi();
  const nav = useNavigate();
  const queryClient = useQueryClient();
  const { byId } = useAgents();
  const { suites, isLoading: suitesLoading } = useEvalSuites(target.kind === "rerun" && !!target.run.suite_id);

  const run = target.kind === "rerun" ? target.run : null;
  const pinnedAgentId = target.kind === "suite" ? target.suite.agent_id ?? "" : target.run.agent_id;

  const [agentId, setAgentId] = useState(pinnedAgentId);
  const [environmentId, setEnvironmentId] = useState(run?.environment_id ?? "");
  const [envTouched, setEnvTouched] = useState(!!run?.environment_id);
  const [error, setError] = useState("");

  // Fill in the agent's default environment until the person picks one.
  const agent = byId.get(agentId);
  const agentDefault = defaultEnvironmentOf(agent);
  useEffect(() => {
    if (!envTouched && agentDefault) setEnvironmentId(agentDefault);
  }, [agentDefault, envTouched]);

  // A run from a suite runs the suite again, unless the suite is gone.
  const suiteId = target.kind === "suite" ? target.suite.id : target.run.suite_id;
  const suiteGone = target.kind === "rerun" && !!suiteId && !suitesLoading && !suites.some((s) => s.id === suiteId);
  const viaSuite = !!suiteId && !suiteGone;

  const name = target.kind === "suite" ? target.suite.name : runName(target.run);
  const taskCount = target.kind === "suite" ? target.suite.task_count : target.run.tasks.length;
  const shape = run ? runShape(runSummary(run)) : plural(taskCount, "task");

  const start = useAsyncAction(async () => {
    setError("");
    try {
      const res = viaSuite
        ? await api<{ run_id: string }>(`/v1/evals/suites/${suiteId}/run`, {
            method: "POST",
            // The agent rides along so a suite with none pinned still runs,
            // and so a suite can be pointed at another agent for one run.
            body: JSON.stringify({ environment_id: environmentId, ...(agentId ? { agent_id: agentId } : {}) }),
            silentErrors: true,
          })
        : await api<{ run_id: string }>(RUNS_KEY, {
            method: "POST",
            body: JSON.stringify({ agent_id: agentId, environment_id: environmentId, tasks: run!.tasks.map((t) => t.spec) }),
            silentErrors: true,
          });
      void queryClient.invalidateQueries({ queryKey: [RUNS_KEY] });
      toast.success(`Run started: ${name}`);
      onClose();
      nav(`/evals/${res.run_id}`);
    } catch (e) {
      setError(failureSentence(e));
    }
  });

  const kind = run ? runKind(run) : "suite";
  const subtitle =
    target.kind === "suite"
      ? `Runs the ${plural(taskCount, "task")} in this suite and grades every trial.`
      : viaSuite
        ? "Runs the suite again with its current tasks, so you can compare the result with this run."
        : `The same ${shape} again, against the agent as it is now.`;

  return (
    <Modal
      open
      onClose={() => !start.loading && onClose()}
      title={target.kind === "suite" ? `Run ${name}` : "Run again"}
      subtitle={subtitle}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={start.loading}>
            Cancel
          </Button>
          <Button onClick={start.run} disabled={!agentId || !environmentId || taskCount === 0} loading={start.loading}>
            Start run
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {error && (
          <Callout tone="danger" title="The run could not be started">
            {error}
          </Callout>
        )}
        {taskCount === 0 && (
          <Callout tone="warning" title="Nothing to run">
            {target.kind === "suite"
              ? "This suite has no tasks yet. Save a session as an eval to add one."
              : "That run never recorded its tasks, so there is nothing to send again."}
          </Callout>
        )}
        {suiteGone && (
          <Callout title="The suite this run came from was deleted">
            The same tasks will run as a one-off, without the suite's name.
          </Callout>
        )}
        <AgentField
          value={agentId}
          onChange={(id) => setAgentId(id)}
          fallbackName={byId.get(pinnedAgentId)?.name}
          hint={
            target.kind === "suite" && !target.suite.agent_id
              ? "This suite has no agent of its own, so choose one for this run."
              : kind === "suite"
                ? "Filled in from the suite. Pick another to try the same tasks on a different agent."
                : "Every trial uses the agent's latest version."
          }
        />
        <EnvironmentField
          value={environmentId}
          onChange={(id) => {
            setEnvTouched(true);
            setEnvironmentId(id);
          }}
          hint={run ? "Filled in from the earlier run." : "The sandbox each trial runs in. The agent's default is filled in for you."}
        />
      </div>
    </Modal>
  );
}
