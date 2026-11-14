import { Link } from "react-router";
import { BotIcon, CircuitBoardIcon, LaptopIcon, SquareTerminalIcon, WorkflowIcon } from "lucide-react";
import type { ModelCard } from "@open-managed-agents/api-types";
import { KNOWN_ACP_AGENTS, resolveKnownAgent } from "@open-managed-agents/acp-runtime/known-agents";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { BRAND_NAME } from "@/lib/brand";
import { describeModel } from "@/lib/models";
import { inlineLink } from "@/lib/links";

import { AvatarPicker } from "../../../components/agents/AvatarPicker";
import { CheckRow, FormSection, OptionCard, PickSelect, RowBox } from "../../../components/agents/controls";
import {
  Callout,
  Chip,
  Combobox,
  Field,
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectOption,
} from "../../../components/kit";
import { MemoryModeControl } from "../../../components/MemoryModeControl";
import {
  cardSupportsReasoningLevel,
  isSubscriptionHarness,
  reasoningLevelOptions,
  type FormSetter,
  type FormState,
  type HarnessValue,
  type RuntimeLite,
} from "./model";

/** Identity: what the agent is called and what it is told. */
export function BasicsSection({ form, setForm }: { form: FormState; setForm: FormSetter }) {
  return (
    <FormSection title="Basics" description="Who this agent is. The name and description are how people find it; the instructions are what it reads before every session.">
      {/* The avatar is the face the name will wear: it follows the name as it is typed until a person picks one. */}
      <div className="flex items-end gap-3">
        <AvatarPicker
          value={form.avatar}
          onChange={(avatar) => setForm((prev) => ({ ...prev, avatar }))}
          name={form.name}
          description={form.description}
        />
        <Field label="Name" className="min-w-0 flex-1">
          <Input
            id="agent-name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="Coding assistant"
            autoComplete="off"
            autoFocus
          />
        </Field>
      </div>
      <Field label="Description" hint="Optional. Shown on the agent's card and wherever someone picks an agent.">
        {/* Two lines to start, growing with the text (to six), so all of it is in view. */}
        <Textarea
          id="agent-description"
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          placeholder="Writes and reviews code in your repositories"
          autoComplete="off"
          rows={2}
          className="max-h-36 min-h-[3.75rem] resize-none text-small leading-relaxed md:text-small"
        />
      </Field>
      <Field label="Instructions" hint="The system prompt. Say what the agent is for, how it should work, and when it should stop and ask.">
        <Textarea
          id="agent-system"
          value={form.system}
          onChange={(e) => setForm({ ...form, system: e.target.value })}
          rows={9}
          className="max-h-[40vh] min-h-44 resize-y text-small leading-relaxed md:text-small"
          placeholder="You are a helpful assistant…"
        />
      </Field>
    </FormSection>
  );
}

type Engine = HarnessValue | "local";

/**
 * Model and engine: one decision about where the agent's loop runs, then
 * the settings that choice needs. The four engines are mutually exclusive:
 * a local runtime brings its own model, the subscription engines take a
 * model id, and the managed loop uses one of the workspace's model keys.
 */
export function ModelSection({
  form,
  setForm,
  modelCards,
  runtimes,
  selectedCardId,
}: {
  form: FormState;
  setForm: FormSetter;
  modelCards: ModelCard[];
  runtimes: RuntimeLite[];
  selectedCardId: string;
}) {
  const runtimeRows = Array.isArray(runtimes) ? runtimes : [];
  const selectedCard = modelCards.find((mc) => mc.id === selectedCardId);
  const engine: Engine = form.runtimeId ? "local" : form.harness;
  const subscription = isSubscriptionHarness(engine);
  // The managed loop and Pi both run on one of the workspace's model keys.
  const modelKey = engine === "default" || engine === "pi";
  const showReasoningLevel = modelKey && cardSupportsReasoningLevel(selectedCard);
  const reasoningOptions = reasoningLevelOptions(form.reasoningLevel);
  // Nobody chose a memory mode and the agent will have a trigger: the
  // server turns memory on with it, so say so instead of showing "Off".
  const memoryFollowsTrigger = !form.memoryChosen && form.ambientEnabled;
  const memoryShown = memoryFollowsTrigger ? "shared" : form.memoryMode;

  // A machine that is offline cannot run a loop, so the option needs one
  // that is online (unless the form is already bound to a machine).
  const anyOnline = runtimeRows.some((r) => r.status === "online");
  const localAvailable = anyOnline || !!form.runtimeId;

  const pickEngine = (next: Engine) => {
    if (next === "local") {
      // Bind to the first online machine and its first detected agent, so
      // the person does not need to know what strings the daemon reports.
      const runtime = runtimeRows.find((r) => r.status === "online");
      if (!runtime) return;
      setForm({ ...form, runtimeId: runtime.id, acpAgentId: runtime.agents?.[0]?.id ?? form.acpAgentId });
      return;
    }
    setForm({ ...form, runtimeId: "", harness: next });
  };

  return (
    <FormSection title="Model and engine" description="Where the agent's loop runs, and which model does the thinking.">
      <div role="radiogroup" aria-label="Engine" className="grid gap-2.5 sm:grid-cols-2">
        <OptionCard
          selected={engine === "default"}
          onSelect={() => pickEngine("default")}
          icon={WorkflowIcon}
          title="Managed loop"
          description={`${BRAND_NAME} runs the loop. Billed to one of your model keys.`}
        />
        <OptionCard
          selected={engine === "pi"}
          onSelect={() => pickEngine("pi")}
          icon={CircuitBoardIcon}
          title="Pi agent"
          description="The Pi agent runtime with the platform's tools. Billed to one of your model keys."
        />
        <OptionCard
          selected={engine === "claude-agent-sdk"}
          onSelect={() => pickEngine("claude-agent-sdk")}
          icon={BotIcon}
          title="Claude Agent SDK"
          description="Headless Claude Code on the server. Billed to its Claude subscription."
        />
        <OptionCard
          selected={engine === "codex-sdk"}
          onSelect={() => pickEngine("codex-sdk")}
          icon={SquareTerminalIcon}
          title="Codex SDK"
          description="Headless Codex on the server. Billed to its ChatGPT subscription."
        />
        <OptionCard
          selected={engine === "local"}
          onSelect={() => pickEngine("local")}
          icon={LaptopIcon}
          title="Local runtime"
          description="A machine you connected runs the loop with its own model."
          disabled={!localAvailable}
          trailing={!localAvailable ? <Chip>{runtimeRows.length === 0 ? "None connected" : "All offline"}</Chip> : undefined}
        />
      </div>
      {!localAvailable && (
        <p className="-mt-2.5 text-xs text-fg-subtle">
          {runtimeRows.length === 0 ? (
            <>
              To use a local runtime,{" "}
              <Link to="/runtimes" className={inlineLink}>
                connect a machine
              </Link>{" "}
              first.
            </>
          ) : (
            <>
              Your connected machines are offline. Start the bridge daemon on one, or check{" "}
              <Link to="/runtimes" className={inlineLink}>
                Local runtimes
              </Link>
              .
            </>
          )}
        </p>
      )}

      {modelKey &&
        (modelCards.length === 0 ? (
          <Callout
            title="No model keys yet"
            action={
              <Button variant="outline" size="sm" asChild>
                <Link to="/model-cards">Add a model</Link>
              </Button>
            }
          >
            The managed loop needs a provider key to call a model.
          </Callout>
        ) : (
          <>
            <div className="grid gap-x-3 gap-y-5 sm:grid-cols-2">
              <Field label="Model" className={showReasoningLevel ? undefined : "sm:col-span-2"}>
                <Combobox<ModelCard>
                  value={selectedCardId}
                  onValueChange={(v, item) => {
                    setForm({ ...form, modelCardId: v, model: item?.model_id ?? v });
                  }}
                  endpoint="/v1/model_cards"
                  getValue={(mc) => mc.id}
                  getLabel={(mc) => (
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate">{describeModel(mc.model_id).label}</span>
                      <span className="truncate font-mono text-micro-size text-fg-subtle">{mc.model_id}</span>
                      {mc.is_default && <Chip className="ml-auto">Default</Chip>}
                    </span>
                  )}
                  getTextLabel={(mc) => describeModel(mc.model_id).label}
                  placeholder={
                    !selectedCardId && form.model ? `${form.model} has no model key. Choose one` : "Choose a model"
                  }
                />
              </Field>
              {showReasoningLevel && (
                <Field
                  label="Reasoning"
                  hint={
                    selectedCard?.provider === "ant"
                      ? "Sets how hard Claude thinks before it answers."
                      : "Sets OpenAI reasoning effort."
                  }
                >
                  <PickSelect
                    id="agent-reasoning-level"
                    value={form.reasoningLevel}
                    onValueChange={(reasoningLevel) => setForm({ ...form, reasoningLevel })}
                    options={reasoningOptions}
                  />
                </Field>
              )}
            </div>
            <Field label="Memory">
              <MemoryModeControl
                value={memoryShown}
                onChange={(memoryMode) => setForm({ ...form, memoryMode, memoryChosen: true })}
                note={
                  memoryFollowsTrigger
                    ? "On because this agent has a trigger: each run is a fresh session, so memory is how it remembers the last one. Choose Off to start every run blank."
                    : undefined
                }
              />
            </Field>
          </>
        ))}

      {subscription && (
        <>
          <div className="grid gap-x-3 gap-y-5 sm:grid-cols-2">
            <Field label="Model" hint="Leave empty to use the subscription's default model.">
              <Input
                id="agent-sub-model"
                value={form.model}
                onChange={(e) => setForm({ ...form, model: e.target.value })}
                placeholder={engine === "codex-sdk" ? "gpt-5.6-sol" : "claude-sonnet-5"}
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
              />
            </Field>
            <Field label="Reasoning">
              <PickSelect
                id="agent-sub-reasoning"
                value={form.reasoningLevel}
                onValueChange={(reasoningLevel) => setForm({ ...form, reasoningLevel })}
                options={reasoningOptions}
              />
            </Field>
          </div>
          <Callout title="Self-hosted only">
            Runs headless {engine === "codex-sdk" ? "Codex" : "Claude Code"} on the server host and bills its{" "}
            {engine === "codex-sdk" ? "ChatGPT" : "Claude"} subscription, so no model key is needed. The deployment
            must set{" "}
            <code className="font-mono text-xs text-fg">
              {engine === "codex-sdk" ? "OMA_ENABLE_CODEX_SDK=1" : "OMA_ENABLE_CLAUDE_AGENT_SDK=1"}
            </code>
            .
          </Callout>
        </>
      )}

      {engine === "local" && (
        <>
          <div className="grid gap-x-3 gap-y-5 sm:grid-cols-2">
            <Field label="Machine">
              <PickSelect
                value={form.runtimeId}
                onValueChange={(rid) => {
                  const first = runtimeRows.find((r) => r.id === rid)?.agents?.[0]?.id;
                  setForm({ ...form, runtimeId: rid, acpAgentId: first ?? form.acpAgentId });
                }}
                options={runtimeRows.map((r) => ({
                  value: r.id,
                  label: r.hostname,
                  hint:
                    r.status === "online"
                      ? r.agents?.length
                        ? `Online · ${r.agents.length} ${r.agents.length === 1 ? "agent" : "agents"} detected`
                        : "Online"
                      : "Offline",
                  disabled: r.status !== "online",
                }))}
              />
            </Field>
            <AcpAgentField form={form} setForm={setForm} runtimes={runtimeRows} />
          </div>
          <LocalSkills form={form} setForm={setForm} runtimes={runtimeRows} />
          <p className="text-xs text-fg-subtle">
            The model is chosen by the ACP agent on that machine ({form.acpAgentId || "none selected"}), with its own
            credentials. Each turn starts it there.
          </p>
        </>
      )}
    </FormSection>
  );
}

function AcpAgentField({
  form,
  setForm,
  runtimes,
}: {
  form: FormState;
  setForm: FormSetter;
  runtimes: RuntimeLite[];
}) {
  const runtime = runtimes.find((r) => r.id === form.runtimeId);
  const detectedAgents = runtime?.agents ?? [];
  // Featured agents first, so the common case is one click. Anything the
  // daemon has not detected is left out: it must be installed first.
  const featuredIds = new Set(KNOWN_ACP_AGENTS.filter((e) => e.featured).map((e) => e.id));
  const featuredDetected = detectedAgents.filter((a) => featuredIds.has(a.id));
  const otherDetected = detectedAgents.filter((a) => !featuredIds.has(a.id));

  return (
    <Field
      label="ACP agent"
      hint={detectedAgents.length === 0 ? "No agents detected on this machine yet." : undefined}
    >
      <Select
        value={form.acpAgentId}
        onValueChange={(v) => setForm({ ...form, acpAgentId: v, localSkillBlocklist: [] })}
        placeholder="Choose an agent"
      >
        {featuredDetected.length > 0 && (
          <SelectGroup>
            <SelectGroupLabel>Featured</SelectGroupLabel>
            {featuredDetected.map((a) => (
              <SelectOption key={a.id} value={a.id}>
                {a.id}
              </SelectOption>
            ))}
          </SelectGroup>
        )}
        {otherDetected.length > 0 && (
          <SelectGroup>
            <SelectGroupLabel>Also detected</SelectGroupLabel>
            {otherDetected.map((a) => (
              <SelectOption key={a.id} value={a.id}>
                {a.id}
              </SelectOption>
            ))}
          </SelectGroup>
        )}
      </Select>
    </Field>
  );
}

/** Which of the machine's local skills the ACP agent may see. */
function LocalSkills({
  form,
  setForm,
  runtimes,
}: {
  form: FormState;
  setForm: FormSetter;
  runtimes: RuntimeLite[];
}) {
  // Canonicalize first: form.acpAgentId may be a legacy alias on stale
  // rows ("claude-code-acp"), but the daemon reports local_skills under the
  // canonical key ("claude-agent-acp").
  const canonicalId = resolveKnownAgent(form.acpAgentId)?.id ?? form.acpAgentId;
  const localSkills = runtimes.find((r) => r.id === form.runtimeId)?.local_skills?.[canonicalId] ?? [];
  if (localSkills.length === 0) return null;
  const visible = localSkills.filter((s) => !form.localSkillBlocklist.includes(s.id)).length;
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <span className="text-small leading-5 font-medium text-fg">Local skills</span>
        <span className="flex items-center gap-2 text-xs text-fg-subtle">
          {visible} of {localSkills.length} visible
          {form.localSkillBlocklist.length > 0 && (
            <Button variant="ghost" size="xs" onClick={() => setForm({ ...form, localSkillBlocklist: [] })}>
              Show all
            </Button>
          )}
        </span>
      </div>
      <RowBox className="max-h-48 overflow-y-auto">
        {localSkills.map((s) => (
          <CheckRow
            key={s.id}
            mono
            checked={!form.localSkillBlocklist.includes(s.id)}
            onCheckedChange={(checked) => {
              const next = new Set(form.localSkillBlocklist);
              if (checked) next.delete(s.id);
              else next.add(s.id);
              setForm({ ...form, localSkillBlocklist: [...next] });
            }}
            title={s.id}
            description={[s.name && s.name !== s.id ? s.name : null, `${s.source ?? "global"}${s.source_label ? `: ${s.source_label}` : ""}`]
              .filter(Boolean)
              .join(" · ")}
          />
        ))}
      </RowBox>
      <p className="mt-1.5 text-xs text-fg-subtle">Unchecked skills are hidden from the agent on that machine.</p>
    </div>
  );
}
