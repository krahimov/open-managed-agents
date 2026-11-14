import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { PuzzleIcon, SlidersHorizontalIcon } from "lucide-react";
import { DEFAULT_REASONING_LEVEL, isReasoningLevel, type ModelCard } from "@open-managed-agents/api-types";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FACE_METADATA_KEY, formatFace, parseFace } from "@/lib/agent-face";
import { useApi } from "@/lib/api";
import { describeModel } from "@/lib/models";
import { useApiQuery } from "@/lib/useApiQuery";
import { inlineLink } from "@/lib/links";

import { AvatarPicker } from "../../components/agents/AvatarPicker";
import { CheckRow, PickSelect, RowBox } from "../../components/agents/controls";
import { Callout, EntityAvatar, Field, LocalCombobox, Modal, Skeleton } from "../../components/kit";
import { MemoryModeControl, memoryForWire, parseMemoryMode, type MemoryMode } from "../../components/MemoryModeControl";
import { Tip } from "../../components/Tip";
import type { AgentRecord as Agent } from "../../types/agent";
import { AgentFormDialog } from "./AgentFormDialog";
import { cardSupportsReasoningLevel, engineLabel, reasoningLevelForWire, reasoningLevelOptions, type ReasoningLevelValue } from "./form/model";
import { useAgentFormAux } from "./useAgentFormAux";

const ENGINE_HINT: Record<string, string> = {
  default: "The platform's own loop. Billed to your model key.",
  pi: "The Pi agent runtime with the platform's tools. Billed to your model key.",
  "claude-agent-sdk": "Headless Claude Code on the server. Billed to its Claude subscription.",
  "codex-sdk": "Headless Codex on the server. Billed to its ChatGPT subscription.",
  "acp-proxy": "Hands the loop to a machine you registered as a local runtime.",
};

/**
 * Edit an agent. Saving posts to `/v1/agents/:id`, which creates a new
 * version; sessions that are already running keep the version they
 * started with. Only what changed is sent (the server keeps the rest), and
 * the save is guarded by the agent's version, so a version saved meanwhile
 * (by the setup chat, say) is refused instead of overwritten.
 *
 * The dialog edits what people change most: name, description, avatar,
 * instructions, model and reasoning, engine, memory and skills. "All
 * settings" opens the full form (tools, apps, MCP servers, delegation,
 * sandbox, vaults, triggers, and the config as YAML or JSON) for the same
 * agent. Leaving with unsaved changes asks first.
 */
export function EditAgentDialog({
  agent,
  open,
  onClose,
  onOpenSetup,
}: {
  agent: Agent;
  open: boolean;
  onClose: () => void;
  /** Offered in the full form: leave it for the agent's setup chat. */
  onOpenSetup?: () => void;
}) {
  const [full, setFull] = useState(false);
  useEffect(() => {
    if (!open) setFull(false);
  }, [open]);
  if (!open) return null;
  if (full) return <FullEdit agent={agent} onClose={onClose} onOpenSetup={onOpenSetup} />;
  // Remount on open so the form always starts from the agent as it is now.
  return (
    <EditAgentForm key={`${agent.id}:${agent.version}`} agent={agent} onClose={onClose} onAllSettings={() => setFull(true)} />
  );
}

/** The full new-agent form, in edit mode, for this agent. */
function FullEdit({ agent, onClose, onOpenSetup }: { agent: Agent; onClose: () => void; onOpenSetup?: () => void }) {
  const qc = useQueryClient();
  const aux = useAgentFormAux(true);
  return (
    <AgentFormDialog
      open
      onClose={onClose}
      editAgent={agent}
      onSaved={() => {
        void qc.invalidateQueries({ queryKey: [`/v1/agents/${agent.id}`] });
        void qc.invalidateQueries({ queryKey: [`/v1/agents/${agent.id}/versions`] });
        void qc.invalidateQueries({ queryKey: [`/v1/agents/${agent.id}/memory`] });
        void qc.invalidateQueries({ queryKey: [`/v1/agents/${agent.id}/ambient-rules`] });
        void qc.invalidateQueries({ queryKey: ["/v1/agents"] });
      }}
      onOpenSetup={onOpenSetup}
      allAgents={aux.allAgents}
      customSkills={aux.customSkills}
      modelCards={aux.modelCards}
      runtimes={aux.runtimes}
    />
  );
}

function EditAgentForm({ agent, onClose, onAllSettings }: { agent: Agent; onClose: () => void; onAllSettings: () => void }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const { data: skillsRes, isLoading: skillsLoading } = useApiQuery<{
    data: Array<{ id: string; name: string; description: string }>;
  }>("/v1/skills");
  const allSkills = skillsRes?.data ?? [];
  const { data: cardsRes } = useApiQuery<{ data: ModelCard[] }>("/v1/model_cards", MODEL_CARD_PARAMS);
  const modelOptions = useMemo(
    () => [...new Set((cardsRes?.data ?? []).map((mc) => mc.model_id))].sort(),
    [cardsRes],
  );

  const initialModel = typeof agent.model === "string" ? agent.model : ((agent.model as { id?: string })?.id ?? "");
  const [name, setName] = useState(agent.name);
  const [description, setDescription] = useState(agent.description ?? "");
  const initialAvatar = formatFace(parseFace(agent.metadata?.[FACE_METADATA_KEY]));
  const [avatar, setAvatar] = useState(initialAvatar);
  const [model, setModel] = useState(initialModel);
  const [system, setSystem] = useState(agent.system ?? "");
  const initialHarness = agent._oma?.harness ?? "default";
  const [harness, setHarness] = useState(initialHarness);
  const initialLevel: ReasoningLevelValue = isReasoningLevel(agent._oma?.reasoning_level)
    ? agent._oma.reasoning_level
    : DEFAULT_REASONING_LEVEL;
  const [reasoningLevel, setReasoningLevel] = useState<ReasoningLevelValue>(initialLevel);
  const initialMemory = parseMemoryMode(agent._oma?.memory);
  const [memoryMode, setMemoryMode] = useState<MemoryMode>(initialMemory);
  /** Set once someone picks a mode: a chosen Off is written, so the first
   *  trigger does not switch memory on by itself. */
  const [memoryChosen, setMemoryChosen] = useState(false);
  // Only custom skills are listed here; anything else attached (the
  // document skills) is kept as it is.
  const skills = (agent.skills ?? []) as Array<{ type?: string; skill_id?: string }>;
  const initialSkillIds = useMemo(
    () => skills.filter((s) => s?.type !== "anthropic").map((s) => s?.skill_id).filter((x): x is string => !!x),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [skillIds, setSkillIds] = useState<Set<string>>(() => new Set(initialSkillIds));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /** The footer is asking whether to throw the changes away. */
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const skillsChanged =
    skillIds.size !== initialSkillIds.length || initialSkillIds.some((id) => !skillIds.has(id));
  const dirty =
    name !== agent.name ||
    description.trim() !== (agent.description ?? "").trim() ||
    avatar !== initialAvatar ||
    model.trim() !== initialModel ||
    system !== (agent.system ?? "") ||
    harness !== initialHarness ||
    reasoningLevel !== initialLevel ||
    memoryMode !== initialMemory ||
    memoryChosen ||
    skillsChanged;
  /** Escape, the close button, the scrim and Cancel: ask first when there
   *  is something to lose. */
  const leave = () => {
    if (saving) return;
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };

  const toggleSkill = (sid: string) =>
    setSkillIds((prev) => {
      const next = new Set(prev);
      if (next.has(sid)) next.delete(sid);
      else next.add(sid);
      return next;
    });

  const engineOptions = useMemo(() => {
    const values = ["default", "pi", "claude-agent-sdk", "codex-sdk", "acp-proxy"];
    if (!values.includes(harness)) values.push(harness);
    return values.map((value) => ({ value, label: engineLabel(value), hint: ENGINE_HINT[value] }));
  }, [harness]);

  const save = async () => {
    setSaving(true);
    setErr(null);
    setConfirmDiscard(false);
    try {
      const nextModel = model.trim();
      const body: Record<string, unknown> = {
        // A version saved since this opened is refused, not overwritten.
        version: agent.version,
        name,
        // An unchanged model keeps its {id, speed}.
        model: nextModel === initialModel ? agent.model : nextModel,
        system,
      };
      // Metadata is merged per key on the server: only the avatar is sent,
      // and an empty one (null) goes back to the face read from the name.
      if (avatar !== initialAvatar) body.metadata = { [FACE_METADATA_KEY]: avatar || null };
      if (skillsChanged) {
        body.skills = [
          ...skills.filter((sk) => sk?.type === "anthropic"),
          ...[...skillIds].map((skill_id) => ({ type: "custom", skill_id })),
        ];
      }
      // Sent only when edited; an emptied description is cleared with null.
      const nextDescription = description.trim();
      if (nextDescription !== (agent.description ?? "").trim()) body.description = nextDescription || null;
      const oma: Record<string, unknown> = {};
      if (harness !== initialHarness) oma.harness = harness;
      if (reasoningLevel !== initialLevel) oma.reasoning_level = reasoningLevelForWire(reasoningLevel);
      if (memoryChosen && (memoryMode !== initialMemory || !agent._oma?.memory)) {
        oma.memory = memoryForWire(memoryMode, agent._oma?.memory);
      }
      if (Object.keys(oma).length > 0) body._oma = oma;
      await api(`/v1/agents/${agent.id}`, { method: "POST", body: JSON.stringify(body) });
      await qc.invalidateQueries({ queryKey: [`/v1/agents/${agent.id}`] });
      await qc.invalidateQueries({ queryKey: [`/v1/agents/${agent.id}/versions`] });
      void qc.invalidateQueries({ queryKey: [`/v1/agents/${agent.id}/memory`] });
      void qc.invalidateQueries({ queryKey: ["/v1/agents"] });
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const modelInfo = describeModel(model);
  const card = (cardsRes?.data ?? []).find((mc) => mc.model_id === model.trim());
  // A model key that takes no reasoning level (a gateway, a model that does
  // not reason) hides the field; a typed id the workspace has no key for
  // keeps it, since the engine may still map it.
  const showReasoning = harness !== "acp-proxy" && (card ? cardSupportsReasoningLevel(card) : true);

  return (
    <Modal
      open
      onClose={leave}
      title={`Edit ${agent.name}`}
      subtitle={`Saving creates version ${agent.version + 1}. Sessions that are running keep version ${agent.version}.`}
      maxWidth="max-w-2xl"
      footer={
        confirmDiscard ? (
          <>
            <p role="alert" className="mr-auto min-w-0 truncate text-small font-medium text-fg">
              Discard your changes to this agent?
            </p>
            <Button variant="ghost" onClick={() => setConfirmDiscard(false)} autoFocus>
              Keep editing
            </Button>
            <Button variant="destructive" onClick={onClose}>
              Discard changes
            </Button>
          </>
        ) : (
          <>
            <Tip label={dirty ? "Save or undo your changes here first" : "Tools, apps, MCP servers, sandbox, vaults, triggers and the config as YAML or JSON"}>
              {/* A disabled button gets no pointer events; the span keeps the tip. */}
              <span className="mr-auto">
                <Button variant="ghost" onClick={onAllSettings} disabled={saving || dirty}>
                  <SlidersHorizontalIcon data-icon="inline-start" />
                  All settings
                </Button>
              </span>
            </Tip>
            <Button variant="ghost" onClick={leave} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={() => void save()} disabled={!name.trim() || !model.trim()} loading={saving}>
              Save changes
            </Button>
          </>
        )
      }
    >
      <div className="space-y-5">
        {err && (
          <Callout tone="danger" title="The agent was not saved">
            {err}
          </Callout>
        )}

        <div className="flex items-end gap-3">
          <AvatarPicker
            value={avatar}
            onChange={setAvatar}
            name={name}
            description={description}
            agentId={agent.id}
            createdAt={agent.created_at}
          />
          {/* The dialog opens on the name: focus on the avatar button would
              open its "Change avatar" tooltip over this label. */}
          <Field label="Name" className="min-w-0 flex-1">
            <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" autoFocus />
          </Field>
        </div>
        <Field label="Description" hint="Optional. Shown on the agent's card and wherever someone picks an agent.">
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="A sentence about what it does"
            autoComplete="off"
            rows={2}
            // As tall as the text, from two lines up to six; then it scrolls.
            className="max-h-36 min-h-[3.75rem] resize-none text-small leading-relaxed md:text-small"
          />
        </Field>

        <Field label="Instructions" hint="The system prompt: who the agent is and how it should work.">
          <Textarea
            value={system}
            onChange={(e) => setSystem(e.target.value)}
            rows={8}
            className="max-h-[42vh] min-h-40 resize-y text-small leading-relaxed md:text-small"
            placeholder="You are a helpful assistant…"
          />
        </Field>

        <div className="grid gap-x-3 gap-y-5 sm:grid-cols-2">
          <Field
            label="Model"
            hint={
              model.trim() && modelInfo.label !== model.trim() ? (
                // The name leads, as on every other screen; the id it stands for is here.
                <>
                  {modelInfo.providerLabel} · <span className="font-mono">{model.trim()}</span>
                </>
              ) : (
                "A model id from your model keys, or any id the engine accepts."
              )
            }
          >
            <LocalCombobox<string>
              value={model}
              displayValue={model.trim() && modelInfo.label !== model.trim() ? modelInfo.label : undefined}
              onChange={setModel}
              onPick={setModel}
              options={modelOptions}
              filter={(option, q) => option.toLowerCase().includes(q)}
              getKey={(option) => option}
              renderItem={(option) => (
                <span className="flex items-center justify-between gap-3 px-2 py-1.5">
                  <span className="text-small-size text-fg">{describeModel(option).label}</span>
                  <span className="truncate font-mono text-micro-size text-fg-subtle">{option}</span>
                </span>
              )}
              placeholder="claude-sonnet-4-6"
              emptyHint="No model key matches. You can still type a model id."
              maxHeight="14rem"
            />
          </Field>
          {showReasoning ? (
            <Field label="Reasoning" hint="How hard the model thinks before it answers.">
              <PickSelect<ReasoningLevelValue>
                value={reasoningLevel}
                onValueChange={setReasoningLevel}
                options={reasoningLevelOptions(reasoningLevel)}
              />
            </Field>
          ) : (
            <Field label="Runs on">
              <PickSelect value={harness} onValueChange={setHarness} options={engineOptions} />
            </Field>
          )}
          {showReasoning && (
            <Field label="Runs on">
              <PickSelect value={harness} onValueChange={setHarness} options={engineOptions} />
            </Field>
          )}
        </div>

        <Field label="Memory">
          <MemoryModeControl
            value={memoryMode}
            onChange={(mode) => {
              setMemoryMode(mode);
              setMemoryChosen(true);
            }}
          />
        </Field>

        <div>
          <div className="mb-1.5 flex items-baseline justify-between gap-3">
            <span className="text-small leading-5 font-medium text-fg">Skills</span>
            <span className="text-xs text-fg-subtle">{skillIds.size} attached</span>
          </div>
          {skillsLoading ? (
            <RowBox>
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="flex h-[52px] items-center gap-3 border-t border-border px-3.5 first:border-t-0">
                  <Skeleton className="size-[18px]" rounded="sm" />
                  <Skeleton className="h-3.5 w-48" rounded="sm" />
                </div>
              ))}
            </RowBox>
          ) : allSkills.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border-strong px-4 py-3.5 text-small text-fg-muted">
              No skills in this workspace yet.{" "}
              <Link to="/skills" className={inlineLink}>
                Import one on the Skills page
              </Link>
              .
            </p>
          ) : (
            <RowBox className="max-h-56 overflow-y-auto">
              {allSkills.map((sk) => (
                <CheckRow
                  key={sk.id}
                  checked={skillIds.has(sk.id)}
                  onCheckedChange={() => toggleSkill(sk.id)}
                  leading={<EntityAvatar icon={PuzzleIcon} size="sm" />}
                  title={sk.name}
                  description={sk.description || "No description"}
                />
              ))}
            </RowBox>
          )}
        </div>
      </div>
    </Modal>
  );
}

const MODEL_CARD_PARAMS = { limit: "200" } as const;
