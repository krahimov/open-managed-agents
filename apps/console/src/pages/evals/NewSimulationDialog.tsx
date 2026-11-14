// "New simulation": test an agent against a simulated user.
//
// Three steps in one dialog:
//   1 Agent        pick the agent and what to probe. "Draft scenarios"
//                  asks POST /v1/evals/draft_scenarios, where the judge
//                  model reads the agent's setup and writes complete
//                  scenarios (situation, persona, when it ends, rubric).
//                  It can take a minute, so the request can be cancelled.
//                  "Write them myself" skips the model.
//   2 Scenarios    each scenario is a card that opens to edit. The parts
//                  of the drafted reward this form does not show (context,
//                  include_transcript, findings) are kept untouched.
//   3 Save and run where they are saved (a new suite or an existing one),
//                  who grades, and where to run. "Save to suite" keeps
//                  them; "Save and run" also starts a run with them.
//
// Going back never loses work: the scenarios stay until "Draft again"
// replaces them.

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { ChevronRightIcon, DramaIcon, PlusIcon, SparklesIcon, Trash2Icon, XIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

import { EntityAvatar } from "../../components/AgentAvatar";
import { Chip } from "../../components/Badge";
import { Callout } from "../../components/Callout";
import { Field } from "../../components/Field";
import { Modal } from "../../components/Modal";
import { Property, PropertyList } from "../../components/PropertyList";
import { SegmentedControl } from "../../components/SegmentedControl";
import { Steps } from "../../components/Steps";
import { Tip } from "../../components/Tip";
import { RUNS_KEY, SUITES_KEY, useEvalSuites } from "../../components/evals/data";
import {
  AgentField,
  DialogSection,
  DraftingState,
  EnvironmentField,
  JudgeFields,
  NEW_SUITE,
  SuiteFields,
  defaultEnvironmentOf,
} from "../../components/evals/fields";
import { useAsyncAction } from "../../hooks/useAsyncAction";
import { ApiError, useApi } from "../../lib/api";
import { useAgents } from "../../lib/directory";
import { AUTO_JUDGE, injectJudge, type SimulationPersona } from "../../lib/evals";
import { plural } from "../../lib/format";
import { describeModel } from "../../lib/models";
import { useQueryClient } from "../../lib/useApiQuery";
import { cn } from "../../lib/utils";
import { failureSentence, withReason } from "../../lib/failure-text";

/** One drafted or hand-written scenario. The reward object is kept whole:
 *  only `rubric` is edited; `context` / `include_transcript` / `findings`
 *  stay exactly as drafted. */
interface SimTaskDraft {
  id: string;
  simulation: {
    scenario: string;
    persona: SimulationPersona;
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

const STEPS = ["Agent", "Scenarios", "Save and run"];
const COUNTS = ["1", "2", "3", "4", "5"] as const;

/** An empty scenario, in the same envelope draft_scenarios returns. */
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
    reward: { type: "llm_judge", rubric: "", include_transcript: true, findings: true },
  };
}

/** The contract guarantees the shape, but an empty goals array would
 *  leave the goals editor with nothing to type into. */
function normalizeScenario(s: SimTaskDraft, i: number): SimTaskDraft {
  return {
    ...blankScenario(i + 1),
    ...s,
    simulation: {
      ...s.simulation,
      persona: {
        ...s.simulation.persona,
        goals:
          Array.isArray(s.simulation.persona.goals) && s.simulation.persona.goals.length > 0 ? s.simulation.persona.goals : [""],
      },
    },
    reward: s.reward ?? blankScenario(i + 1).reward,
  };
}

/** What a scenario still needs before it can be saved, or null. */
function scenarioProblem(s: SimTaskDraft): string | null {
  if (!s.id.trim()) return "Give it a name.";
  if (!s.simulation.scenario.trim()) return "Describe the situation.";
  const p = s.simulation.persona;
  if (!p.identity.trim()) return "Say who the simulated user is.";
  if (p.goals.map((g) => g.trim()).filter(Boolean).length === 0) return "Give the simulated user at least one goal.";
  if (!p.termination.trim()) return "Say when the conversation ends.";
  const maxTurns = s.simulation.max_turns;
  if (maxTurns !== undefined && (!Number.isInteger(maxTurns) || maxTurns < 1)) return "The turn limit must be a whole number, 1 or more.";
  if (!String(s.reward.rubric ?? "").trim()) return "Write the rubric the judge grades against.";
  return null;
}

export function NewSimulationDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { api } = useApi();
  const nav = useNavigate();
  const queryClient = useQueryClient();
  const { byId: agentsById } = useAgents();
  const { suites } = useEvalSuites(open);

  const [step, setStep] = useState(0);

  // Step 1
  const [agentId, setAgentId] = useState("");
  const [focus, setFocus] = useState("");
  const [count, setCount] = useState<(typeof COUNTS)[number]>("3");
  const [drafting, setDrafting] = useState(false);
  const [draftUnavailable, setDraftUnavailable] = useState(false);
  const [draftedBy, setDraftedBy] = useState("");

  // Step 2
  const [scenarios, setScenarios] = useState<SimTaskDraft[]>([]);
  const [expanded, setExpanded] = useState<Set<number>>(new Set([0]));
  const [showProblems, setShowProblems] = useState(false);

  // Step 3
  const [environmentId, setEnvironmentId] = useState("");
  const [envTouched, setEnvTouched] = useState(false);
  const [judgeCardId, setJudgeCardId] = useState(AUTO_JUDGE);
  const [judgeLevel, setJudgeLevel] = useState("max");
  const [suiteChoice, setSuiteChoice] = useState(NEW_SUITE);
  const [newSuiteName, setNewSuiteName] = useState("");
  const [suiteNameMissing, setSuiteNameMissing] = useState(false);
  const [error, setError] = useState("");

  // The draft request in flight. Cancel, close and unmount abort it, so a
  // slow draft never lands in a closed dialog.
  const acRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open) return;
    setStep(0);
    setAgentId("");
    setFocus("");
    setCount("3");
    setDrafting(false);
    setDraftUnavailable(false);
    setDraftedBy("");
    setScenarios([]);
    setExpanded(new Set([0]));
    setShowProblems(false);
    setEnvironmentId("");
    setEnvTouched(false);
    setJudgeCardId(AUTO_JUDGE);
    setJudgeLevel("max");
    setSuiteChoice(NEW_SUITE);
    setNewSuiteName("");
    setSuiteNameMissing(false);
    setError("");
    return () => acRef.current?.abort();
  }, [open]);

  const agent = agentsById.get(agentId);
  const agentName = agent?.name;
  const agentDefault = defaultEnvironmentOf(agent);
  useEffect(() => {
    if (open && !envTouched && agentDefault) setEnvironmentId(agentDefault);
  }, [open, agentDefault, envTouched]);

  function enterScenarios(next: SimTaskDraft[], by: string) {
    setScenarios(next.map(normalizeScenario));
    setDraftedBy(by);
    setExpanded(new Set([0]));
    setShowProblems(false);
    setNewSuiteName((cur) => cur || `${agentName || "Agent"} simulations`);
    setStep(1);
  }

  function generate() {
    setError("");
    setDraftUnavailable(false);
    setDrafting(true);
    const ac = new AbortController();
    acRef.current = ac;
    api<DraftScenariosResponse>("/v1/evals/draft_scenarios", {
      method: "POST",
      body: JSON.stringify({
        agent_id: agentId,
        count: Number(count),
        ...(focus.trim() ? { focus: focus.trim() } : {}),
      }),
      signal: ac.signal,
      // Failures are shown here (writing by hand still works), and a server
      // without the endpoint would otherwise raise a toast on every try.
      silentErrors: true,
    })
      .then((res) => {
        enterScenarios(res.scenarios.length > 0 ? res.scenarios : [blankScenario(1)], res.drafted_by);
        setDrafting(false);
      })
      .catch((e) => {
        if (ac.signal.aborted) return;
        // Drafting exists only on some servers: the others answer 501
        // (older ones 404). Not a failure: point at writing by hand.
        if (e instanceof ApiError && (e.status === 501 || e.status === 404)) setDraftUnavailable(true);
        else setError(failureSentence(e));
        setDrafting(false);
      });
  }

  function cancelDraft() {
    acRef.current?.abort();
    setDrafting(false);
  }

  function startBlank() {
    setError("");
    enterScenarios([blankScenario(1)], "");
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
    setScenarios((prev) => prev.map((s, j) => (j === i ? { ...s, simulation: { ...s.simulation, ...patch } } : s)));
  }
  function patchPersona(i: number, patch: Partial<SimulationPersona>) {
    setScenarios((prev) =>
      prev.map((s, j) => (j === i ? { ...s, simulation: { ...s.simulation, persona: { ...s.simulation.persona, ...patch } } } : s)),
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

  /** The first thing wrong with the set, with the card it is on. */
  function firstProblem(): { index: number; message: string } | null {
    if (scenarios.length === 0) return { index: -1, message: "Add at least one scenario." };
    const seen = new Set<string>();
    for (let i = 0; i < scenarios.length; i++) {
      const problem = scenarioProblem(scenarios[i]);
      if (problem) return { index: i, message: problem };
      const id = scenarios[i].id.trim();
      if (seen.has(id)) return { index: i, message: `Two scenarios are called "${id}". Give each its own name.` };
      seen.add(id);
    }
    return null;
  }

  /** Check the scenarios and open the first card that needs attention. */
  function reviewScenarios(): boolean {
    const problem = firstProblem();
    if (!problem) {
      setError("");
      return true;
    }
    setShowProblems(true);
    setError(problem.index >= 0 ? `${scenarios[problem.index].id.trim() || `Scenario ${problem.index + 1}`}: ${problem.message}` : problem.message);
    if (problem.index >= 0) setExpanded((prev) => new Set(prev).add(problem.index));
    return false;
  }

  /** The scenarios as task specs, trimmed, with the judge written in.
   *  Rewards are deep-cloned so the judge never lands in dialog state. */
  function buildTasks(): SimTaskDraft[] {
    return scenarios.map((s) => {
      const p = s.simulation.persona;
      const reward = JSON.parse(JSON.stringify(s.reward)) as SimTaskDraft["reward"];
      reward.rubric = String(s.reward.rubric).trim();
      injectJudge(reward, {
        ...(judgeCardId !== AUTO_JUDGE ? { model_card_id: judgeCardId } : {}),
        reasoning_level: judgeLevel,
      });
      return {
        ...s,
        id: s.id.trim(),
        simulation: {
          ...s.simulation,
          scenario: s.simulation.scenario.trim(),
          persona: {
            ...p,
            name: p.name?.trim() || undefined,
            identity: p.identity.trim(),
            goals: p.goals.map((g) => g.trim()).filter(Boolean),
            hidden_knowledge: p.hidden_knowledge?.trim() || undefined,
            communication_style: p.communication_style?.trim() || undefined,
            termination: p.termination.trim(),
          },
        },
        reward,
      };
    });
  }

  /** Create the suite, or add to the chosen one. The update route's
   *  `tasks` field REPLACES a suite's tasks, so adding to an existing
   *  suite goes one `append_task` at a time. */
  async function saveToSuite(tasks: SimTaskDraft[]): Promise<{ id: string; name: string }> {
    if (suiteChoice === NEW_SUITE) {
      return api<{ id: string; name: string }>(SUITES_KEY, {
        method: "POST",
        body: JSON.stringify({ name: newSuiteName.trim(), ...(agentId ? { agent_id: agentId } : {}), tasks }),
        silentErrors: true,
      });
    }
    let suite: { id: string; name: string } | undefined;
    for (const t of tasks) {
      suite = await api<{ id: string; name: string }>(`${SUITES_KEY}/${suiteChoice}`, {
        method: "POST",
        body: JSON.stringify({ append_task: t }),
        silentErrors: true,
      });
    }
    if (!suite) throw new Error("There is nothing to save.");
    return suite;
  }

  function readyToSave(): boolean {
    if (!reviewScenarios()) {
      setStep(1);
      return false;
    }
    if (suiteChoice === NEW_SUITE && !newSuiteName.trim()) {
      setSuiteNameMissing(true);
      return false;
    }
    setSuiteNameMissing(false);
    return true;
  }

  const save = useAsyncAction(async () => {
    setError("");
    if (!readyToSave()) return;
    const tasks = buildTasks();
    try {
      const suite = await saveToSuite(tasks);
      void queryClient.invalidateQueries({ queryKey: [SUITES_KEY] });
      toast.success(`Saved ${plural(tasks.length, "scenario")} to ${suite.name}`);
      onClose();
    } catch (e) {
      setError(withReason("The scenarios could not be saved", e));
    }
  });

  const saveAndRun = useAsyncAction(async () => {
    setError("");
    if (!readyToSave()) return;
    if (!agentId || !environmentId) return;
    const tasks = buildTasks();
    try {
      const suite = await saveToSuite(tasks);
      void queryClient.invalidateQueries({ queryKey: [SUITES_KEY] });
      const res = await api<{ run_id: string }>(RUNS_KEY, {
        method: "POST",
        body: JSON.stringify({ agent_id: agentId, environment_id: environmentId, tasks }),
        silentErrors: true,
      });
      void queryClient.invalidateQueries({ queryKey: [RUNS_KEY] });
      toast.success(`Saved to ${suite.name}. The run has started.`);
      onClose();
      nav(`/evals/${res.run_id}`);
    } catch (e) {
      // The suite may have been saved even though the run did not start;
      // its list was refreshed above, so nothing on screen is stale.
      setError(withReason("The run could not be started", e));
    }
  });

  const busy = save.loading || saveAndRun.loading;
  const hasScenarios = scenarios.length > 0;
  const isTemplate = draftedBy === "template";

  const footer = drafting ? (
    <Button variant="ghost" onClick={cancelDraft}>
      Cancel drafting
    </Button>
  ) : step === 0 ? (
    <>
      <Button variant="ghost" onClick={onClose} className="mr-auto">
        Cancel
      </Button>
      {hasScenarios ? (
        <>
          <Tip label={`Replaces the ${plural(scenarios.length, "scenario")} you have now`}>
            <Button variant="outline" onClick={generate} disabled={!agentId}>
              Draft again
            </Button>
          </Tip>
          <Button onClick={() => setStep(1)}>Continue</Button>
        </>
      ) : (
        <>
          <Button variant="outline" onClick={startBlank}>
            Write them myself
          </Button>
          <Button onClick={generate} disabled={!agentId}>
            <SparklesIcon data-icon="inline-start" />
            Draft scenarios
          </Button>
        </>
      )}
    </>
  ) : step === 1 ? (
    <>
      <Button variant="ghost" onClick={() => setStep(0)} className="mr-auto">
        Back
      </Button>
      <Button
        onClick={() => {
          if (reviewScenarios()) setStep(2);
        }}
      >
        Continue
      </Button>
    </>
  ) : (
    <>
      <Button variant="ghost" onClick={() => setStep(1)} disabled={busy} className="mr-auto">
        Back
      </Button>
      <Button variant="outline" onClick={save.run} disabled={busy} loading={save.loading}>
        Save to suite
      </Button>
      {/* A disabled button takes no pointer events, so the reason rides a wrapper. */}
      <Tip label={!agentId ? "Choose an agent on the first step" : !environmentId ? "Choose an environment to run in" : undefined}>
        <span className="inline-flex">
          <Button onClick={saveAndRun.run} disabled={busy || !agentId || !environmentId} loading={saveAndRun.loading}>
            Save and run
          </Button>
        </span>
      </Tip>
    </>
  );

  return (
    <Modal
      open={open}
      onClose={() => !busy && onClose()}
      title="New simulation"
      subtitle="A model plays a user with a goal, your agent answers, and the judge grades the whole conversation."
      maxWidth="max-w-3xl"
      footer={footer}
    >
      <Steps
        steps={STEPS}
        current={step}
        onStepClick={drafting || busy ? undefined : (i) => setStep(i)}
        className="mb-6"
      />

      {drafting ? (
        <DraftingState
          title={`Drafting ${plural(Number(count), "scenario")} for ${agentName ?? "your agent"}`}
          body="The judge model is reading the agent's instructions and tools, and writing who the user is, what they want and how to grade the conversation. This can take up to a minute."
        />
      ) : step === 0 ? (
        <div className="space-y-5">
          {draftUnavailable && (
            <Callout title="This server cannot draft scenarios">Choose Write them myself to describe each scenario by hand.</Callout>
          )}
          {error && (
            <Callout tone="danger" title="The scenarios could not be drafted">
              {error}
            </Callout>
          )}
          <AgentField
            value={agentId}
            onChange={(id) => setAgentId(id)}
            fallbackName={agentName}
            hint="The agent that will talk to the simulated users."
          />
          <Field label="Scenarios to draft" hint="Each one is a different user in a different situation. You can add, edit or remove them next.">
            <SegmentedControl<(typeof COUNTS)[number]>
              label="Scenarios to draft"
              value={count}
              onChange={setCount}
              options={COUNTS.map((c) => ({ value: c, label: c }))}
            />
          </Field>
          <Field label="What to probe" hint="Optional. Leave it empty to cover what the agent's instructions say it is for.">
            <Input
              value={focus}
              onChange={(e) => setFocus(e.target.value)}
              placeholder="Billing disputes, prompt-injection resistance"
              autoComplete="off"
            />
          </Field>
        </div>
      ) : step === 1 ? (
        <div className="space-y-4">
          {isTemplate ? (
            <Callout tone="warning" title="This is a starting template, not a draft">
              The judge model could not write scenarios this time. Replace each placeholder before you save.
            </Callout>
          ) : (
            <p className="text-small text-fg-muted">
              {draftedBy ? (
                <>
                  Drafted by {describeModel(draftedBy).label} from {agentName ?? "the agent"}'s setup. Read each one and change
                  what does not fit.
                </>
              ) : (
                "Describe each simulated user: who they are, what they want, and how the judge should grade the conversation."
              )}
            </p>
          )}
          {error && <Callout tone="danger">{error}</Callout>}

          <ul className="space-y-2">
            {scenarios.map((s, i) => (
              <ScenarioCard
                key={i}
                index={i}
                scenario={s}
                open={expanded.has(i)}
                problem={showProblems ? scenarioProblem(s) : null}
                onToggle={() => toggleCard(i)}
                onRemove={() => removeScenario(i)}
                patchScenario={(p) => patchScenario(i, p)}
                patchSimulation={(p) => patchSimulation(i, p)}
                patchPersona={(p) => patchPersona(i, p)}
              />
            ))}
          </ul>

          <Button
            variant="ghost"
            size="sm"
            className="-ml-2"
            onClick={() => {
              setScenarios((prev) => [...prev, blankScenario(prev.length + 1)]);
              setExpanded((prev) => new Set(prev).add(scenarios.length));
            }}
          >
            <PlusIcon data-icon="inline-start" />
            Add scenario
          </Button>
        </div>
      ) : (
        <div className="space-y-8">
          {error && <Callout tone="danger">{error}</Callout>}

          <div className="rounded-lg bg-bg-soft px-4 py-2.5">
            <PropertyList>
              <Property label="Agent" empty="None chosen. Go back to pick one before running.">
                {agentName}
              </Property>
              <Property label="Scenarios" align="start">
                <span className="flex flex-wrap gap-1.5 py-0.5">
                  {scenarios.map((s, i) => (
                    <Chip key={i} tone="outline" mono>
                      {s.id.trim() || `scenario ${i + 1}`}
                    </Chip>
                  ))}
                </span>
              </Property>
            </PropertyList>
          </div>

          <DialogSection title="Save to" description="Saved scenarios can be run again after every change to the agent.">
            <SuiteFields
              suites={suites}
              choice={suiteChoice}
              onChoiceChange={setSuiteChoice}
              name={newSuiteName}
              onNameChange={(v) => {
                setNewSuiteName(v);
                if (v.trim()) setSuiteNameMissing(false);
              }}
              nameError={suiteNameMissing ? "Give the suite a name." : undefined}
            />
          </DialogSection>

          <DialogSection title="Judge" description="Grades each conversation against its rubric and files findings.">
            <JudgeFields cardId={judgeCardId} onCardChange={setJudgeCardId} level={judgeLevel} onLevelChange={setJudgeLevel} enabled={open} />
          </DialogSection>

          <DialogSection title="Run" description="Only needed to run now. Saving to a suite does not use it.">
            <EnvironmentField
              value={environmentId}
              onChange={(id) => {
                setEnvTouched(true);
                setEnvironmentId(id);
              }}
              hint="The sandbox each conversation runs in. The agent's default is filled in for you."
            />
          </DialogSection>
        </div>
      )}
    </Modal>
  );
}

/** One scenario: a row that says what it is, and opens to edit all of it. */
function ScenarioCard({
  index,
  scenario: s,
  open,
  problem,
  onToggle,
  onRemove,
  patchScenario,
  patchSimulation,
  patchPersona,
}: {
  index: number;
  scenario: SimTaskDraft;
  open: boolean;
  problem: string | null;
  onToggle: () => void;
  onRemove: () => void;
  patchScenario: (patch: Partial<SimTaskDraft>) => void;
  patchSimulation: (patch: Partial<SimTaskDraft["simulation"]>) => void;
  patchPersona: (patch: Partial<SimulationPersona>) => void;
}) {
  const p = s.simulation.persona;
  const name = s.id.trim() || `Scenario ${index + 1}`;
  const panelId = `sim-scenario-${index}`;
  return (
    <li className={cn("rounded-lg border bg-bg-surface dark:bg-bg-soft", problem ? "border-warning/50" : "border-border-strong")}>
      <div className="relative flex min-h-[52px] items-center gap-3 px-3 py-2">
        <EntityAvatar icon={DramaIcon} size="md" />
        <div className="min-w-0 flex-1">
          {/* The stretched button makes the whole header the click target. */}
          <button
            type="button"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={onToggle}
            className="block max-w-full truncate rounded-sm text-left font-mono text-small-size font-medium text-fg after:absolute after:inset-0 after:rounded-lg focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-offset-1 focus-visible:after:outline-plum"
          >
            {name}
          </button>
          <p className={cn("truncate text-xs", problem ? "text-warning" : "text-fg-subtle")}>
            {problem ?? (s.simulation.scenario.trim() || "Not described yet")}
          </p>
        </div>
        <Tip label="Remove this scenario">
          <Button variant="ghost" size="icon-sm" onClick={onRemove} aria-label={`Remove ${name}`} className="relative z-10 text-fg-subtle">
            <Trash2Icon />
          </Button>
        </Tip>
        <ChevronRightIcon
          aria-hidden="true"
          className={cn("size-4 shrink-0 text-fg-subtle transition-transform duration-[var(--dur-base)] ease-[var(--ease-rise)]", open && "rotate-90")}
        />
      </div>

      {open && (
        <div id={panelId} className="animate-fade-in space-y-7 border-t border-border px-4 pt-5 pb-5">
          <div className="space-y-5">
            <div className="grid gap-x-4 gap-y-5 sm:grid-cols-[minmax(0,1fr)_132px]">
              <Field label="Name" hint="Lowercase with dashes. It names the scenario in results.">
                <Input value={s.id} onChange={(e) => patchScenario({ id: e.target.value })} spellCheck={false} autoComplete="off" className="font-mono" />
              </Field>
              <Field label="Turn limit" hint="A hard stop.">
                <Input
                  type="number"
                  min={1}
                  step={1}
                  value={s.simulation.max_turns ?? ""}
                  onChange={(e) => patchSimulation({ max_turns: e.target.value === "" ? undefined : Number(e.target.value) })}
                />
              </Field>
            </div>
            <Field label="The situation">
              <Textarea
                value={s.simulation.scenario}
                onChange={(e) => patchSimulation({ scenario: e.target.value })}
                placeholder="What is going on when this user writes in?"
                className="min-h-16"
              />
            </Field>
          </div>

          <DialogSection title="The simulated user" description="A model plays this person. The agent only ever sees their messages.">
            <div className="space-y-5">
              <div className="grid gap-x-4 gap-y-5 sm:grid-cols-2">
                <Field label="Name" hint="Optional.">
                  <Input value={p.name ?? ""} onChange={(e) => patchPersona({ name: e.target.value })} placeholder="Dana Whitfield" autoComplete="off" />
                </Field>
                <Field label="How they write" hint="Optional.">
                  <Input
                    value={p.communication_style ?? ""}
                    onChange={(e) => patchPersona({ communication_style: e.target.value })}
                    placeholder="Terse, not technical, easily frustrated"
                    autoComplete="off"
                  />
                </Field>
              </div>
              <Field label="Who they are">
                <Textarea
                  value={p.identity}
                  onChange={(e) => patchPersona({ identity: e.target.value })}
                  placeholder="Their role, what they know, what they are under pressure about."
                  className="min-h-14"
                />
              </Field>
              <div>
                <span className="mb-1.5 block text-small leading-5 font-medium text-fg">What they want</span>
                <div className="space-y-2">
                  {p.goals.map((g, gi) => (
                    <div key={gi} className="flex items-center gap-2">
                      <Input
                        value={g}
                        onChange={(e) => patchPersona({ goals: p.goals.map((pg, gj) => (gj === gi ? e.target.value : pg)) })}
                        placeholder={gi === 0 ? "Get the team back in today" : "Another goal"}
                        aria-label={`Goal ${gi + 1}`}
                        autoComplete="off"
                      />
                      <Tip label="Remove this goal">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Remove goal ${gi + 1}`}
                          disabled={p.goals.length <= 1}
                          onClick={() => patchPersona({ goals: p.goals.filter((_, gj) => gj !== gi) })}
                        >
                          <XIcon />
                        </Button>
                      </Tip>
                    </div>
                  ))}
                </div>
                <Button variant="ghost" size="sm" className="mt-1.5 -ml-2" onClick={() => patchPersona({ goals: [...p.goals, ""] })}>
                  <PlusIcon data-icon="inline-start" />
                  Add goal
                </Button>
              </div>
              <Field label="What they only say if asked" hint="Optional. Something the agent can only learn by asking the right question.">
                <Textarea
                  value={p.hidden_knowledge ?? ""}
                  onChange={(e) => patchPersona({ hidden_knowledge: e.target.value })}
                  placeholder="The lockout began right after their admin re-uploaded metadata on Friday."
                  className="min-h-14"
                />
              </Field>
              <Field label="The conversation ends when">
                <Textarea
                  value={p.termination}
                  onChange={(e) => patchPersona({ termination: e.target.value })}
                  placeholder="The problem is solved, or the agent hands over to a person."
                  className="min-h-14"
                />
              </Field>
            </div>
          </DialogSection>

          <DialogSection title="Grading" description="The rubric the judge reads the whole conversation against. Ask for evidence on every point.">
            <Textarea
              aria-label="Rubric"
              value={String(s.reward.rubric ?? "")}
              onChange={(e) => patchScenario({ reward: { ...s.reward, rubric: e.target.value } })}
              spellCheck={false}
              placeholder={"- [resolved] The user's problem is fixed, or handed to a person with full context.\n- [policy] No commitment beyond what the policy allows."}
              className="min-h-36 font-mono text-xs leading-relaxed md:text-xs"
            />
          </DialogSection>
        </div>
      )}
    </li>
  );
}
