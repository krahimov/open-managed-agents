// "New simulation" dialog — author simulated-user eval scenarios.
//
// Two steps in one modal. Setup: pick the agent under eval, optionally a
// focus, and POST /v1/evals/draft_scenarios — the backend's judge model
// drafts complete simulation task specs (persona, termination, rubric).
// Drafting can take up to a minute, so the request rides an
// AbortController wired to Cancel/close (same pattern as
// SaveAsEvalDialog). "Start blank" skips the LLM and seeds one empty
// scenario form. Edit: each scenario is a collapsible card with the
// persona/rubric fields editable; the rest of the drafted reward object
// (context, include_transcript, findings) is kept in state untouched.
// Actions mirror SaveAsEvalDialog: "Save to suite" and "Save & run"
// (suite save + POST /v1/evals/runs with the tasks directly).

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";

import { ApiError, useApi } from "../../lib/api";
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

interface SuiteSummary {
  id: string;
  name: string;
  task_count: number;
  updated_at: string;
}

interface SimPersonaDraft {
  name?: string;
  identity: string;
  goals: string[];
  hidden_knowledge?: string;
  communication_style?: string;
  termination: string;
  scripted_messages?: string[];
}

/** One drafted/authored scenario. The reward object is kept whole in
 *  state — only `rubric` is edited; `context` / `include_transcript` /
 *  `findings` stay exactly as drafted. */
interface SimTaskDraft {
  id: string;
  simulation: {
    scenario: string;
    persona: SimPersonaDraft;
    opening_message?: string;
    max_turns?: number;
  };
  timeout_ms?: number;
  trials?: number;
  pass_threshold?: number;
  reward: { type: string; rubric?: string; [key: string]: unknown };
  [key: string]: unknown;
}

interface DraftScenariosResponse {
  scenarios: SimTaskDraft[];
  drafted_by: string;
}

// Radix Select items can't carry an empty-string value.
const AUTO_JUDGE = "__auto__";
const NEW_SUITE = "__new__";

const REASONING_LEVELS = ["instant", "low", "medium", "high", "max"] as const;

/** Stamp judge config onto every llm_judge spec in the reward tree.
 *  Local copy of NewEvalRunDialog's helper (not exported there). */
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

/** Empty scenario for the "Start blank" / "+ Add scenario" paths — same
 *  envelope shape draft_scenarios returns. */
function blankScenario(n: number): SimTaskDraft {
  return {
    id: `sim-${n}`,
    simulation: {
      scenario: "",
      persona: { identity: "", goals: [""], termination: "" },
      max_turns: 12,
    },
    timeout_ms: 900_000,
    trials: 1,
    reward: {
      type: "llm_judge",
      rubric: "",
      include_transcript: true,
      findings: true,
    },
  };
}

/** Defensive normalize of a drafted scenario — the contract guarantees
 *  the shape, but empty arrays would leave the goals editor unusable. */
function normalizeScenario(s: SimTaskDraft, i: number): SimTaskDraft {
  return {
    ...blankScenario(i + 1),
    ...s,
    simulation: {
      ...s.simulation,
      persona: {
        ...s.simulation.persona,
        goals:
          Array.isArray(s.simulation.persona.goals) && s.simulation.persona.goals.length > 0
            ? s.simulation.persona.goals
            : [""],
      },
    },
    reward: s.reward ?? blankScenario(i + 1).reward,
  };
}

export function NewSimulationDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { api } = useApi();
  const nav = useNavigate();
  const queryClient = useQueryClient();

  // ── Setup step ────────────────────────────────────────────────────────
  const [agentId, setAgentId] = useState("");
  const [focus, setFocus] = useState("");
  const [count, setCount] = useState("3");
  const [drafting, setDrafting] = useState(false);
  const [draftUnavailable, setDraftUnavailable] = useState(false);
  const [draftedBy, setDraftedBy] = useState("");

  // ── Edit step (entered once scenarios exist) ──────────────────────────
  const [scenarios, setScenarios] = useState<SimTaskDraft[]>([]);
  const [expanded, setExpanded] = useState<Set<number>>(new Set([0]));

  const [environmentId, setEnvironmentId] = useState("");
  const [judgeCardId, setJudgeCardId] = useState(AUTO_JUDGE);
  const [judgeLevel, setJudgeLevel] = useState("max");
  const [suiteChoice, setSuiteChoice] = useState(NEW_SUITE);
  const [newSuiteName, setNewSuiteName] = useState("");
  const [error, setError] = useState("");

  // In-flight draft request — aborted by Cancel/close/unmount so a slow
  // LLM draft never lands into a closed dialog.
  const acRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open) return;
    setAgentId("");
    setFocus("");
    setCount("3");
    setDrafting(false);
    setDraftUnavailable(false);
    setDraftedBy("");
    setScenarios([]);
    setExpanded(new Set([0]));
    setEnvironmentId("");
    setJudgeCardId(AUTO_JUDGE);
    setJudgeLevel("max");
    setSuiteChoice(NEW_SUITE);
    setNewSuiteName("");
    setError("");
    return () => acRef.current?.abort();
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
  const { data: suitesRes } = useApiQuery<{ data: SuiteSummary[] }>(
    "/v1/evals/suites",
    undefined,
    { enabled: open },
  );

  const agents = agentsRes?.data ?? [];
  const environments = envsRes?.data ?? [];
  const cards = cardsRes?.data ?? [];
  const suites = suitesRes?.data ?? [];
  const agentName = agents.find((a) => a.id === agentId)?.name;

  function enterEditStep(next: SimTaskDraft[], by: string) {
    setScenarios(next.map(normalizeScenario));
    setDraftedBy(by);
    setExpanded(new Set([0]));
    setNewSuiteName((cur) => cur || `${agentName || "agent"} simulations`);
  }

  function generate() {
    setError("");
    const countN = Math.min(5, Math.max(1, Math.round(Number(count) || 3)));
    setDrafting(true);
    const ac = new AbortController();
    acRef.current = ac;
    api<DraftScenariosResponse>("/v1/evals/draft_scenarios", {
      method: "POST",
      body: JSON.stringify({
        agent_id: agentId,
        count: countN,
        ...(focus.trim() ? { focus: focus.trim() } : {}),
      }),
      signal: ac.signal,
      // Failures render inline (the blank-authoring path still works),
      // and a runtime without the endpoint would toast on every attempt.
      silentErrors: true,
    })
      .then((res) => {
        enterEditStep(
          res.scenarios.length > 0 ? res.scenarios : [blankScenario(1)],
          res.drafted_by,
        );
        setDrafting(false);
      })
      .catch((e) => {
        if (ac.signal.aborted) return;
        // Drafting lives only in the Node runtime — CF answers 501
        // (older deploys 404). Not an error: point at "Start blank".
        if (e instanceof ApiError && (e.status === 501 || e.status === 404)) {
          setDraftUnavailable(true);
        } else {
          setError(e instanceof Error ? e.message : "Failed to draft scenarios");
        }
        setDrafting(false);
      });
  }

  function startBlank() {
    setError("");
    enterEditStep([blankScenario(1)], "");
  }

  function toggleCard(i: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  function patchScenario(i: number, patch: Partial<SimTaskDraft>) {
    setScenarios((prev) => prev.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  }

  function patchSimulation(i: number, patch: Partial<SimTaskDraft["simulation"]>) {
    setScenarios((prev) =>
      prev.map((s, j) => (j === i ? { ...s, simulation: { ...s.simulation, ...patch } } : s)),
    );
  }

  function patchPersona(i: number, patch: Partial<SimPersonaDraft>) {
    setScenarios((prev) =>
      prev.map((s, j) =>
        j === i
          ? {
              ...s,
              simulation: {
                ...s.simulation,
                persona: { ...s.simulation.persona, ...patch },
              },
            }
          : s,
      ),
    );
  }

  function removeScenario(i: number) {
    setScenarios((prev) => prev.filter((_, j) => j !== i));
    setExpanded((prev) => {
      const next = new Set<number>();
      for (const j of prev) {
        if (j < i) next.add(j);
        else if (j > i) next.add(j - 1);
      }
      return next;
    });
  }

  /** Validate + assemble the EvalTaskSpec array (judge injected), or
   *  null with an inline error. Reward objects are deep-cloned so
   *  injectJudge never mutates dialog state. */
  function buildTasks(): SimTaskDraft[] | null {
    if (scenarios.length === 0) {
      setError("At least one scenario is required.");
      return null;
    }
    const seen = new Set<string>();
    const out: SimTaskDraft[] = [];
    for (let i = 0; i < scenarios.length; i++) {
      const s = scenarios[i];
      const label = s.id.trim() || `scenario ${i + 1}`;
      const id = s.id.trim();
      if (!id) {
        setError(`Scenario ${i + 1} needs a task id.`);
        return null;
      }
      if (seen.has(id)) {
        setError(`Duplicate task id: ${id}.`);
        return null;
      }
      seen.add(id);
      if (!s.simulation.scenario.trim()) {
        setError(`${label}: scenario description is required.`);
        return null;
      }
      const p = s.simulation.persona;
      if (!p.identity.trim()) {
        setError(`${label}: persona identity is required.`);
        return null;
      }
      const goals = p.goals.map((g) => g.trim()).filter(Boolean);
      if (goals.length === 0) {
        setError(`${label}: at least one persona goal is required.`);
        return null;
      }
      if (!p.termination.trim()) {
        setError(`${label}: a termination rule is required.`);
        return null;
      }
      const maxTurns = s.simulation.max_turns;
      if (maxTurns !== undefined && (!Number.isInteger(maxTurns) || maxTurns < 1)) {
        setError(`${label}: max turns must be a whole number ≥ 1.`);
        return null;
      }
      if (!String(s.reward.rubric ?? "").trim()) {
        setError(`${label}: rubric is required.`);
        return null;
      }
      const reward = JSON.parse(JSON.stringify(s.reward)) as SimTaskDraft["reward"];
      reward.rubric = String(s.reward.rubric).trim();
      injectJudge(reward, {
        ...(judgeCardId !== AUTO_JUDGE ? { model_card_id: judgeCardId } : {}),
        reasoning_level: judgeLevel,
      });
      out.push({
        ...s,
        id,
        simulation: {
          ...s.simulation,
          scenario: s.simulation.scenario.trim(),
          persona: {
            ...p,
            ...(p.name?.trim() ? { name: p.name.trim() } : { name: undefined }),
            identity: p.identity.trim(),
            goals,
            ...(p.hidden_knowledge?.trim()
              ? { hidden_knowledge: p.hidden_knowledge.trim() }
              : { hidden_knowledge: undefined }),
            ...(p.communication_style?.trim()
              ? { communication_style: p.communication_style.trim() }
              : { communication_style: undefined }),
            termination: p.termination.trim(),
          },
        },
        reward,
      });
    }
    return out;
  }

  /** Create the target suite, or append to the chosen one. The update
   *  route's `tasks` field REPLACES the suite's tasks, so appending to
   *  an existing suite goes one `append_task` at a time. */
  async function saveToSuite(tasks: SimTaskDraft[]): Promise<{ id: string; name: string }> {
    if (suiteChoice === NEW_SUITE) {
      const name = newSuiteName.trim();
      if (!name) throw new Error("Suite name is required.");
      return api<{ id: string; name: string }>("/v1/evals/suites", {
        method: "POST",
        body: JSON.stringify({
          name,
          ...(agentId ? { agent_id: agentId } : {}),
          tasks,
        }),
      });
    }
    let suite: { id: string; name: string } | undefined;
    for (const t of tasks) {
      suite = await api<{ id: string; name: string }>(`/v1/evals/suites/${suiteChoice}`, {
        method: "POST",
        body: JSON.stringify({ append_task: t }),
      });
    }
    if (!suite) throw new Error("Nothing to save.");
    return suite;
  }

  const save = useAsyncAction(async () => {
    setError("");
    const tasks = buildTasks();
    if (!tasks) return;
    if (suiteChoice === NEW_SUITE && !newSuiteName.trim()) {
      setError("Suite name is required.");
      return;
    }
    try {
      const suite = await saveToSuite(tasks);
      void queryClient.invalidateQueries({ queryKey: ["/v1/evals/suites"] });
      toast.success(`Saved ${tasks.length} scenario${tasks.length === 1 ? "" : "s"} to ${suite.name}`);
      onClose();
    } catch (e) {
      // api() toasted API failures; local validation errors go inline.
      if (e instanceof Error && !(e instanceof ApiError)) setError(e.message);
    }
  });

  const saveAndRun = useAsyncAction(async () => {
    setError("");
    const tasks = buildTasks();
    if (!tasks) return;
    if (suiteChoice === NEW_SUITE && !newSuiteName.trim()) {
      setError("Suite name is required.");
      return;
    }
    if (!agentId || !environmentId) return;
    try {
      const suite = await saveToSuite(tasks);
      void queryClient.invalidateQueries({ queryKey: ["/v1/evals/suites"] });
      const res = await api<{ run_id: string }>("/v1/evals/runs", {
        method: "POST",
        body: JSON.stringify({
          agent_id: agentId,
          environment_id: environmentId,
          tasks,
        }),
      });
      void queryClient.invalidateQueries({ queryKey: ["/v1/evals/runs"] });
      toast.success(`Saved to ${suite.name} — run started`);
      onClose();
      nav(`/evals/${res.run_id}`);
    } catch (e) {
      // The suite save may have landed even when the run failed — the
      // suites cache was already invalidated, so the list stays truthful.
      if (e instanceof Error && !(e instanceof ApiError)) setError(e.message);
    }
  });

  const busy = save.loading || saveAndRun.loading;
  const editStep = scenarios.length > 0;
  const inputCls =
    "w-full px-3 py-1.5 rounded-md bg-bg border border-border text-sm text-fg placeholder:text-fg-subtle focus:outline-none focus:ring-1 focus:ring-brand";
  const smallLabelCls = "text-xs text-fg-muted block mb-1";

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New simulation"
      subtitle="A persona model plays the user against your agent; the judge grades the whole conversation and files findings."
      maxWidth="max-w-3xl"
      footer={
        drafting || !editStep ? (
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
            <span
              title={
                !agentId
                  ? "Pick an agent first"
                  : !environmentId
                  ? "Pick an environment to run against"
                  : undefined
              }
            >
              <Button
                onClick={saveAndRun.run}
                disabled={busy || !agentId || !environmentId}
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
          <span>Drafting scenarios with the cross-family judge… this can take up to a minute.</span>
        </div>
      ) : !editStep ? (
        // ── Setup step ──────────────────────────────────────────────────
        <div className="space-y-3">
          {draftUnavailable && (
            <div className="text-sm text-fg-muted bg-bg-surface border border-border rounded-lg px-3 py-2">
              Automatic drafting isn&apos;t available on this runtime — start blank and
              author the scenarios by hand.
            </div>
          )}
          {error && (
            <div className="text-sm text-danger bg-danger-subtle border border-danger/30 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
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
              <label htmlFor="nsim-count" className="text-sm text-fg-muted block mb-1">
                Scenarios
              </label>
              <input
                id="nsim-count"
                type="number"
                min={1}
                max={5}
                step={1}
                value={count}
                onChange={(e) => setCount(e.target.value)}
                className={inputCls}
              />
            </div>
          </div>

          <div>
            <label htmlFor="nsim-focus" className="text-sm text-fg-muted block mb-1">
              Focus <span className="text-fg-subtle">(optional)</span>
            </label>
            <input
              id="nsim-focus"
              value={focus}
              onChange={(e) => setFocus(e.target.value)}
              className={inputCls}
              placeholder="billing disputes, prompt-injection resistance"
            />
          </div>

          <div className="flex items-center gap-3 pt-1">
            <Button onClick={generate} disabled={!agentId}>
              Generate scenarios
            </Button>
            <button
              onClick={startBlank}
              className="text-sm text-fg-muted hover:text-fg"
            >
              Start blank
            </button>
          </div>
        </div>
      ) : (
        // ── Edit step ───────────────────────────────────────────────────
        <div className="space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => {
                setScenarios([]);
                setError("");
              }}
              className="text-xs text-fg-muted hover:text-fg"
              title="Discard these scenarios and draft again"
            >
              ← back to setup
            </button>
            {draftedBy && (
              <span
                className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-bg-surface text-fg-muted font-mono"
                title={
                  draftedBy === "template"
                    ? "Drafting failed — this is the TODO template; edit before saving"
                    : "Model that drafted these scenarios"
                }
              >
                drafted by {draftedBy}
              </span>
            )}
          </div>

          {error && (
            <div className="text-sm text-danger bg-danger-subtle border border-danger/30 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <div className="space-y-1.5">
            {scenarios.map((s, i) => {
              const isOpen = expanded.has(i);
              const p = s.simulation.persona;
              return (
                <div key={i} className="rounded-lg bg-bg-surface/60">
                  <div
                    className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-bg-surface rounded-lg transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
                    onClick={() => toggleCard(i)}
                  >
                    <span className="text-fg-subtle text-xs">{isOpen ? "▾" : "▸"}</span>
                    <span className="font-mono text-xs text-fg shrink-0">
                      {s.id || `scenario ${i + 1}`}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs text-fg-subtle">
                      {s.simulation.scenario}
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        removeScenario(i);
                      }}
                      className="text-fg-subtle hover:text-danger text-sm"
                      title="Remove scenario"
                      aria-label={`Remove scenario ${i + 1}`}
                    >
                      ✕
                    </button>
                  </div>

                  {isOpen && (
                    <div className="px-3 pb-3 space-y-2">
                      <div className="grid grid-cols-3 gap-2">
                        <div className="col-span-2">
                          <label className={smallLabelCls}>Task id *</label>
                          <input
                            value={s.id}
                            onChange={(e) => patchScenario(i, { id: e.target.value })}
                            className={inputCls}
                            spellCheck={false}
                          />
                        </div>
                        <div>
                          <label className={smallLabelCls}>Max turns</label>
                          <input
                            type="number"
                            min={1}
                            step={1}
                            value={s.simulation.max_turns ?? ""}
                            onChange={(e) =>
                              patchSimulation(i, {
                                max_turns:
                                  e.target.value === "" ? undefined : Number(e.target.value),
                              })
                            }
                            className={inputCls}
                          />
                        </div>
                      </div>

                      <div>
                        <label className={smallLabelCls}>Scenario *</label>
                        <textarea
                          value={s.simulation.scenario}
                          onChange={(e) => patchSimulation(i, { scenario: e.target.value })}
                          className={`${inputCls} min-h-16 resize-y`}
                          placeholder="What situation is being simulated?"
                        />
                      </div>

                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className={smallLabelCls}>Persona name</label>
                          <input
                            value={p.name ?? ""}
                            onChange={(e) => patchPersona(i, { name: e.target.value })}
                            className={inputCls}
                            placeholder="optional"
                          />
                        </div>
                        <div>
                          <label className={smallLabelCls}>Communication style</label>
                          <input
                            value={p.communication_style ?? ""}
                            onChange={(e) =>
                              patchPersona(i, { communication_style: e.target.value })
                            }
                            className={inputCls}
                            placeholder="terse, non-technical, easily frustrated…"
                          />
                        </div>
                      </div>

                      <div>
                        <label className={smallLabelCls}>Identity *</label>
                        <textarea
                          value={p.identity}
                          onChange={(e) => patchPersona(i, { identity: e.target.value })}
                          className={`${inputCls} min-h-12 resize-y`}
                          placeholder="Who the persona is and what they know."
                        />
                      </div>

                      <div>
                        <span className={smallLabelCls}>Goals *</span>
                        <div className="space-y-1.5">
                          {p.goals.map((g, gi) => (
                            <div key={gi} className="flex items-start gap-2">
                              <input
                                value={g}
                                onChange={(e) =>
                                  patchPersona(i, {
                                    goals: p.goals.map((pg, gj) =>
                                      gj === gi ? e.target.value : pg,
                                    ),
                                  })
                                }
                                className={inputCls}
                                placeholder={`Goal ${gi + 1}`}
                                aria-label={`Goal ${gi + 1}`}
                              />
                              {p.goals.length > 1 && (
                                <button
                                  onClick={() =>
                                    patchPersona(i, {
                                      goals: p.goals.filter((_, gj) => gj !== gi),
                                    })
                                  }
                                  className="mt-1.5 text-fg-subtle hover:text-danger text-sm"
                                  title="Remove goal"
                                  aria-label={`Remove goal ${gi + 1}`}
                                >
                                  ✕
                                </button>
                              )}
                            </div>
                          ))}
                        </div>
                        <button
                          onClick={() => patchPersona(i, { goals: [...p.goals, ""] })}
                          className="mt-1 text-xs text-fg-muted hover:text-fg"
                        >
                          + Add goal
                        </button>
                      </div>

                      <div>
                        <label className={smallLabelCls}>
                          Hidden knowledge{" "}
                          <span className="text-fg-subtle">
                            (revealed only when the agent asks the right question)
                          </span>
                        </label>
                        <textarea
                          value={p.hidden_knowledge ?? ""}
                          onChange={(e) => patchPersona(i, { hidden_knowledge: e.target.value })}
                          className={`${inputCls} min-h-12 resize-y`}
                          placeholder="optional"
                        />
                      </div>

                      <div>
                        <label className={smallLabelCls}>Termination *</label>
                        <textarea
                          value={p.termination}
                          onChange={(e) => patchPersona(i, { termination: e.target.value })}
                          className={`${inputCls} min-h-12 resize-y`}
                          placeholder="When the persona should end the conversation."
                        />
                      </div>

                      <div>
                        <label className={smallLabelCls}>
                          Rubric *
                          {draftedBy && (
                            <span className="text-fg-subtle">
                              {" "}
                              — drafted by <span className="font-mono">{draftedBy}</span>
                            </span>
                          )}
                        </label>
                        <textarea
                          value={String(s.reward.rubric ?? "")}
                          onChange={(e) =>
                            patchScenario(i, { reward: { ...s.reward, rubric: e.target.value } })
                          }
                          className={`${inputCls} min-h-32 font-mono text-xs resize-y`}
                          spellCheck={false}
                        />
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <button
            onClick={() => {
              setScenarios((prev) => [...prev, blankScenario(prev.length + 1)]);
              setExpanded((prev) => new Set(prev).add(scenarios.length));
            }}
            className="text-xs text-fg-muted hover:text-fg"
          >
            + Add scenario
          </button>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm text-fg-muted block mb-1">
                Judge model <span className="text-fg-subtle">(llm_judge tasks)</span>
              </label>
              <Select value={judgeCardId} onValueChange={setJudgeCardId}>
                <SelectOption value={AUTO_JUDGE}>Auto — top-tier, cross-family</SelectOption>
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

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm text-fg-muted block mb-1">
                Environment <span className="text-fg-subtle">(for Save &amp; run)</span>
              </label>
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
        </div>
      )}
    </Modal>
  );
}
