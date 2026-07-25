// "New eval run" dialog (evals-design §7 run create).
//
// The tasks JSON textarea is the source of truth for the suite; the
// judge selectors (model card × reasoning level) are applied at submit
// time to every `llm_judge` reward spec in the parsed tasks — including
// ones nested inside composite components — so authors don't have to
// hand-edit `judge.{model_card_id,reasoning_level}` into the JSON.
// "Auto" leaves model_card_id unset: the runner's §4.1 default picks the
// highest-tier card from a different provider family than the agent
// under eval.

import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useApi } from "../../lib/api";
import { useApiQuery, useQueryClient } from "../../lib/useApiQuery";
import { useAsyncAction } from "../../hooks/useAsyncAction";
import { Modal } from "../../components/Modal";
import { Select, SelectOption } from "../../components/Select";
import { Button } from "@/components/ui/button";
import type { ModelCard } from "@open-managed-agents/api-types";

interface AgentRow {
  id: string;
  name: string;
}

interface EnvironmentRow {
  id: string;
  name: string;
}

// Radix Select items can't carry an empty-string value.
const AUTO_JUDGE = "__auto__";

const REASONING_LEVELS = ["instant", "low", "medium", "high", "max"] as const;

// JSON carries no comments — the rubric string doubles as the §4.3
// template (per-criterion ids, evidence demanded, ignore + anticipated
// shortcuts sections).
const TASKS_TEMPLATE = `[
  {
    "id": "task-1",
    "messages": [
      "Describe the task for the agent here — one user message per entry."
    ],
    "trials": 1,
    "timeout_ms": 600000,
    "pass_threshold": 1,
    "reward": {
      "type": "llm_judge",
      "rubric": "Grade each criterion independently and cite evidence (event ids or file paths) for every verdict.\\n\\n- [criterion-1] The agent produced <artifact> at <path> containing <required content>. Proof: the file exists and contains it.\\n- [criterion-2] <another independently checkable outcome>.\\n\\nIgnore: stylistic choices, extra exploratory commands, harmless warnings.\\nAnticipated shortcuts (fail them): hardcoding the expected output; claiming success without a produced artifact; deleting failing checks instead of fixing them.",
      "include_transcript": false
    }
  }
]`;

/** Stamp judge config onto every llm_judge spec in the reward tree. */
function injectJudge(
  spec: unknown,
  judge: { model_card_id?: string; reasoning_level: string },
): void {
  if (!spec || typeof spec !== "object") return;
  const s = spec as {
    type?: string;
    judge?: Record<string, unknown>;
    components?: Array<{ verifier?: unknown }>;
  };
  if (s.type === "llm_judge") {
    s.judge = {
      ...(s.judge ?? {}),
      ...(judge.model_card_id ? { model_card_id: judge.model_card_id } : {}),
      reasoning_level: judge.reasoning_level,
    };
  } else if (s.type === "composite" && Array.isArray(s.components)) {
    for (const c of s.components) injectJudge(c?.verifier, judge);
  }
}

export function NewEvalRunDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { api } = useApi();
  const nav = useNavigate();
  const queryClient = useQueryClient();

  const [agentId, setAgentId] = useState("");
  const [environmentId, setEnvironmentId] = useState("");
  const [judgeCardId, setJudgeCardId] = useState(AUTO_JUDGE);
  const [judgeLevel, setJudgeLevel] = useState("max");
  const [tasksJson, setTasksJson] = useState(TASKS_TEMPLATE);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setAgentId("");
    setEnvironmentId("");
    setJudgeCardId(AUTO_JUDGE);
    setJudgeLevel("max");
    setTasksJson(TASKS_TEMPLATE);
    setError("");
  }, [open]);

  const { data: agentsRes } = useApiQuery<{ data: AgentRow[] }>(
    "/v1/agents",
    { limit: "200" },
    { enabled: open },
  );
  const { data: envsRes } = useApiQuery<{ data: EnvironmentRow[] }>(
    "/v1/environments",
    { limit: "200" },
    { enabled: open },
  );
  const { data: cardsRes } = useApiQuery<{ data: ModelCard[] }>(
    "/v1/model_cards",
    { limit: "100" },
    { enabled: open },
  );

  const agents = agentsRes?.data ?? [];
  const environments = envsRes?.data ?? [];
  const cards = cardsRes?.data ?? [];

  const create = useAsyncAction(async () => {
    setError("");

    let tasks: unknown;
    try {
      tasks = JSON.parse(tasksJson);
    } catch (e) {
      setError(`Tasks JSON doesn't parse: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (!Array.isArray(tasks) || tasks.length === 0) {
      setError("Tasks must be a non-empty JSON array.");
      return;
    }
    for (const t of tasks as Array<{ id?: unknown; messages?: unknown }>) {
      if (!t || typeof t !== "object" || typeof t.id !== "string" || !t.id) {
        setError("Every task needs a string id.");
        return;
      }
      if (!Array.isArray(t.messages) || t.messages.length === 0) {
        setError(`Task ${t.id} needs a non-empty messages array.`);
        return;
      }
    }

    for (const t of tasks as Array<{ reward?: unknown }>) {
      injectJudge(t.reward, {
        ...(judgeCardId !== AUTO_JUDGE ? { model_card_id: judgeCardId } : {}),
        reasoning_level: judgeLevel,
      });
    }

    try {
      const res = await api<{ run_id: string }>("/v1/evals/runs", {
        method: "POST",
        body: JSON.stringify({
          agent_id: agentId,
          environment_id: environmentId,
          tasks,
        }),
      });
      void queryClient.invalidateQueries({ queryKey: ["/v1/evals/runs"] });
      onClose();
      nav(`/evals/${res.run_id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create eval run");
    }
  });

  const inputCls =
    "w-full px-3 py-1.5 rounded-md bg-bg border border-border text-sm text-fg placeholder:text-fg-subtle focus:outline-none focus:ring-1 focus:ring-brand";

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New eval run"
      subtitle="Outcome-based suite: tasks run against the agent, an LLM judge grades the trajectory against your rubric."
      maxWidth="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={create.loading}>
            Cancel
          </Button>
          <Button
            onClick={create.run}
            disabled={!agentId || !environmentId}
            loading={create.loading}
            loadingLabel="Creating…"
          >
            Start run
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {error && (
          <div className="text-sm text-danger bg-danger-subtle border border-danger/30 rounded-lg px-3 py-2">
            {error}
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-sm text-fg-muted block mb-1">Agent *</label>
            <Select value={agentId} onValueChange={setAgentId} placeholder="Select an agent…">
              {agents.map((a) => (
                <SelectOption key={a.id} value={a.id}>
                  {a.name}
                </SelectOption>
              ))}
            </Select>
          </div>
          <div>
            <label className="text-sm text-fg-muted block mb-1">Environment *</label>
            {environments.length > 0 ? (
              <Select
                value={environmentId}
                onValueChange={setEnvironmentId}
                placeholder="Select an environment…"
              >
                {environments.map((e) => (
                  <SelectOption key={e.id} value={e.id}>
                    {e.name}
                  </SelectOption>
                ))}
              </Select>
            ) : (
              // Node runtimes have no environments store yet — the route
              // accepts any id there, so fall back to free text.
              <input
                value={environmentId}
                onChange={(e) => setEnvironmentId(e.target.value)}
                className={inputCls}
                placeholder="environment id"
              />
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-sm text-fg-muted block mb-1">
              Judge model{" "}
              <span className="text-fg-subtle">(llm_judge tasks)</span>
            </label>
            <Select value={judgeCardId} onValueChange={setJudgeCardId}>
              <SelectOption value={AUTO_JUDGE}>
                Auto — top-tier, cross-family
              </SelectOption>
              {cards.map((c) => (
                <SelectOption key={c.id} value={c.id}>
                  {c.model_id} ({c.provider})
                </SelectOption>
              ))}
            </Select>
          </div>
          <div>
            <label className="text-sm text-fg-muted block mb-1">Judge reasoning level</label>
            <Select value={judgeLevel} onValueChange={setJudgeLevel}>
              {REASONING_LEVELS.map((l) => (
                <SelectOption key={l} value={l}>
                  {l}
                </SelectOption>
              ))}
            </Select>
          </div>
        </div>

        <div>
          <label htmlFor="eval-tasks-json" className="text-sm text-fg-muted block mb-1">
            Tasks (JSON) *
          </label>
          <textarea
            id="eval-tasks-json"
            value={tasksJson}
            onChange={(e) => setTasksJson(e.target.value)}
            className={`${inputCls} min-h-64 font-mono text-xs resize-y whitespace-pre`}
            spellCheck={false}
          />
          <p className="text-xs text-fg-subtle mt-1">
            The judge selectors above are written into every{" "}
            <code className="px-1 bg-bg-surface rounded">llm_judge</code> reward at submit.
            Deterministic hard gates go in a{" "}
            <code className="px-1 bg-bg-surface rounded">composite</code> with components named{" "}
            <code className="px-1 bg-bg-surface rounded">gate:*</code> — a failing gate
            short-circuits before judge tokens are spent.
          </p>
        </div>
      </div>
    </Modal>
  );
}
