import { useMemo, useState } from "react";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { PuzzleIcon } from "lucide-react";
import type { ModelCard } from "@open-managed-agents/api-types";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FACE_METADATA_KEY, formatFace, parseFace } from "@/lib/agent-face";
import { useApi } from "@/lib/api";
import { harnessLabel } from "@/lib/agents";
import { describeModel } from "@/lib/models";
import { useApiQuery } from "@/lib/useApiQuery";
import { inlineLink } from "@/lib/links";

import { AvatarPicker } from "../../components/agents/AvatarPicker";
import { CheckRow, PickSelect, RowBox } from "../../components/agents/controls";
import { Callout, EntityAvatar, Field, LocalCombobox, Modal, Skeleton } from "../../components/kit";
import { MemoryModeControl, parseMemoryMode, type MemoryMode } from "../../components/MemoryModeControl";
import type { AgentRecord as Agent } from "../../types/agent";

const ENGINE_HINT: Record<string, string> = {
  default: "The platform's own loop. Billed to your model key.",
  "claude-agent-sdk": "Headless Claude Code on the server. Billed to its Claude subscription.",
  "codex-sdk": "Headless Codex on the server. Billed to its ChatGPT subscription.",
  "acp-proxy": "Hands the loop to a machine you registered as a local runtime.",
};

/**
 * Edit an agent. Saving posts to `/v1/agents/:id`, which creates a new
 * version; sessions that are already running keep the version they
 * started with. The full config is sent with unedited fields passed
 * through, so a versioned update never drops tools, MCP servers or
 * metadata.
 */
export function EditAgentDialog({ agent, open, onClose }: { agent: Agent; open: boolean; onClose: () => void }) {
  return (
    // Remount on open so the form always starts from the agent as it is now.
    open ? <EditAgentForm key={`${agent.id}:${agent.version}`} agent={agent} onClose={onClose} /> : null
  );
}

function EditAgentForm({ agent, onClose }: { agent: Agent; onClose: () => void }) {
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
  const [harness, setHarness] = useState(agent._oma?.harness ?? "default");
  const [memoryMode, setMemoryMode] = useState<MemoryMode>(() => parseMemoryMode(agent._oma?.memory));
  const [skillIds, setSkillIds] = useState<Set<string>>(
    () =>
      new Set(
        ((agent.skills ?? []) as Array<{ skill_id?: string }>).map((s) => s?.skill_id).filter((x): x is string => !!x),
      ),
  );
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const toggleSkill = (sid: string) =>
    setSkillIds((prev) => {
      const next = new Set(prev);
      if (next.has(sid)) next.delete(sid);
      else next.add(sid);
      return next;
    });

  const engineOptions = useMemo(() => {
    const values = ["default", "claude-agent-sdk", "codex-sdk", "acp-proxy"];
    if (!values.includes(harness)) values.push(harness);
    return values.map((value) => ({ value, label: harnessLabel(value), hint: ENGINE_HINT[value] }));
  }, [harness]);

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = {
        name,
        model,
        system,
        tools: agent.tools,
        mcp_servers: agent.mcp_servers,
        // Metadata is merged per key on the server; an empty avatar clears a
        // chosen one, so the agent goes back to the face read from its name.
        metadata: avatar !== initialAvatar ? { ...(agent.metadata ?? {}), [FACE_METADATA_KEY]: avatar } : agent.metadata,
        skills: [...skillIds].map((skill_id) => ({ type: "custom", skill_id })),
        _oma: {
          ...(agent._oma ?? {}),
          harness,
          // "off" clears via null (server drops the field, like
          // reasoning_level); same mode keeps store_id/extract/push;
          // a mode change resets to just { mode }.
          memory:
            memoryMode === "off"
              ? null
              : agent._oma?.memory?.mode === memoryMode
                ? agent._oma.memory
                : { mode: memoryMode },
        },
      };
      for (const k of Object.keys(body)) {
        if (body[k] === undefined || body[k] === null) delete body[k];
      }
      // Sent only when edited; an emptied description is cleared with null.
      const nextDescription = description.trim();
      if (nextDescription !== (agent.description ?? "").trim()) body.description = nextDescription || null;
      await api(`/v1/agents/${agent.id}`, { method: "POST", body: JSON.stringify(body) });
      await qc.invalidateQueries({ queryKey: [`/v1/agents/${agent.id}`] });
      await qc.invalidateQueries({ queryKey: [`/v1/agents/${agent.id}/versions`] });
      void qc.invalidateQueries({ queryKey: ["/v1/agents"] });
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const modelInfo = describeModel(model);

  return (
    <Modal
      open
      onClose={() => !saving && onClose()}
      title={`Edit ${agent.name}`}
      subtitle={`Saving creates version ${agent.version + 1}. Sessions that are running keep version ${agent.version}.`}
      maxWidth="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={!name.trim() || !model.trim()} loading={saving}>
            Save changes
          </Button>
        </>
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
          <Field label="Runs on">
            <PickSelect value={harness} onValueChange={setHarness} options={engineOptions} />
          </Field>
        </div>

        <Field label="Memory">
          <MemoryModeControl value={memoryMode} onChange={setMemoryMode} />
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
