import type { ReactNode } from "react";
import type { ModelCard } from "@open-managed-agents/api-types";

import { Input } from "@/components/ui/input";
import { AUTO_JUDGE, REASONING_LEVELS, type EvalSuiteSummary } from "@/lib/evals";
import { plural } from "@/lib/format";
import { describeModel } from "@/lib/models";
import { useApiQuery } from "@/lib/useApiQuery";
import type { AgentRecord } from "@/types/agent";

import { AgentAvatar } from "../AgentAvatar";
import { BrandLoader } from "../BrandLoader";
import { Combobox } from "../Combobox";
import { Field } from "../Field";
import { Select, SelectOption, SelectSeparator } from "../Select";

/**
 * The form fields the eval dialogs share (start a run, run a suite, new
 * simulation, save as eval), so "which agent", "which environment", "who
 * grades" and "which suite" look and behave the same in all of them.
 *
 *   <DialogSection title description>   a titled group of fields
 *   <AgentField>                        agent picker with avatar and model
 *   <EnvironmentField>                  environment picker (or an id field
 *                                       on a runtime with no environments)
 *   <JudgeFields>                       judge model + how hard it thinks
 *   <SuiteFields>                       a new suite (named) or an existing one
 *   <DraftingState>                     the wait while the judge model drafts
 */

export function DialogSection({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="mb-3 flex items-end justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-h3 text-fg">{title}</h3>
          {description && <p className="mt-0.5 text-small text-fg-muted">{description}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {children}
    </section>
  );
}

type AgentLite = Pick<AgentRecord, "id" | "name" | "model" | "archived_at" | "_oma" | "metadata">;

/** The environment an agent runs in unless told otherwise. */
export function defaultEnvironmentOf(agent: AgentLite | null | undefined): string | undefined {
  const fromMeta = agent?.metadata?.default_environment_id;
  return agent?._oma?.default_environment_id ?? (typeof fromMeta === "string" ? fromMeta : undefined);
}

export function AgentField({
  value,
  onChange,
  label = "Agent",
  hint,
  error,
  fallbackName,
  disabled,
}: {
  value: string;
  /** `agent` is the picked row (null when cleared), so callers can read its defaults. */
  onChange: (id: string, agent: AgentLite | null) => void;
  label?: string;
  hint?: ReactNode;
  error?: ReactNode;
  /** Name to show for a preset value while its record resolves. */
  fallbackName?: string;
  disabled?: boolean;
}) {
  return (
    <Field label={label} hint={hint} error={error}>
      <Combobox<AgentLite>
        value={value}
        onValueChange={onChange}
        endpoint="/v1/agents"
        getValue={(a) => a.id}
        getLabel={(a) => (
          <span className="flex min-w-0 items-center gap-2.5">
            <AgentAvatar name={a.name} id={a.id} size="sm" archived={!!a.archived_at} />
            <span className="min-w-0 truncate font-medium text-fg">{a.name}</span>
            {a.model && <span className="shrink-0 text-xs text-fg-subtle">{describeModel(a.model).label}</span>}
          </span>
        )}
        getTextLabel={(a) => a.name}
        fallbackLabel={fallbackName ?? "Loading agent…"}
        placeholder="Choose an agent"
        disabled={disabled}
      />
    </Field>
  );
}

interface EnvironmentLite {
  id: string;
  name: string;
  description?: string;
}

export function EnvironmentField({
  value,
  onChange,
  label = "Environment",
  hint = "The sandbox each trial runs in.",
  error,
}: {
  value: string;
  onChange: (id: string) => void;
  label?: string;
  hint?: ReactNode;
  error?: ReactNode;
}) {
  // A runtime with no environments of its own still takes an id on the run
  // routes, so the field turns into plain text there instead of an empty list.
  const { data, isLoading } = useApiQuery<{ data: EnvironmentLite[] }>("/v1/environments", ENV_PARAMS);
  const none = !isLoading && (data?.data.length ?? 0) === 0;
  if (none) {
    return (
      <Field label={label} hint="This server keeps no environments of its own. Enter the id of the one to run in." error={error}>
        <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder="Environment id" autoComplete="off" className="font-mono placeholder:font-sans" />
      </Field>
    );
  }
  return (
    <Field label={label} hint={hint} error={error}>
      <Combobox<EnvironmentLite>
        value={value}
        onValueChange={(v) => onChange(v)}
        endpoint="/v1/environments"
        getValue={(e) => e.id}
        getLabel={(e) => (
          <span className="block min-w-0">
            <span className="block truncate font-medium text-fg">{e.name}</span>
            {e.description && <span className="block truncate text-xs text-fg-subtle">{e.description}</span>}
          </span>
        )}
        getTextLabel={(e) => e.name}
        fallbackLabel={data?.data.find((e) => e.id === value)?.name ?? "Loading environment…"}
        placeholder="Choose an environment"
      />
    </Field>
  );
}
const ENV_PARAMS = { limit: "200" } as const;

/**
 * Who grades, and how hard it thinks. "Automatic" leaves the model unset:
 * the runner then picks the strongest model from a different provider
 * than the agent's, so an agent is never graded by its own family.
 */
export function JudgeFields({
  cardId,
  onCardChange,
  level,
  onLevelChange,
  enabled = true,
}: {
  cardId: string;
  onCardChange: (id: string) => void;
  level: string;
  onLevelChange: (level: string) => void;
  enabled?: boolean;
}) {
  const { data } = useApiQuery<{ data: ModelCard[] }>("/v1/model_cards", CARD_PARAMS, { enabled });
  const cards = data?.data ?? [];
  return (
    <div className="grid gap-x-4 gap-y-5 sm:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
      <Field
        label="Judge model"
        hint="Automatic picks your strongest model from a different provider than the agent's, so an agent is not graded by its own family."
      >
        <Select value={cardId} onValueChange={onCardChange}>
          <SelectOption value={AUTO_JUDGE}>Automatic</SelectOption>
          {cards.length > 0 && <SelectSeparator />}
          {cards.map((c) => (
            <SelectOption key={c.id} value={c.id}>
              {describeModel(c.model_id).label}
            </SelectOption>
          ))}
        </Select>
      </Field>
      <Field label="Reasoning" hint="More reasoning grades more carefully and takes longer.">
        <Select value={level} onValueChange={onLevelChange}>
          {REASONING_LEVELS.map((l) => (
            <SelectOption key={l.value} value={l.value}>
              {l.label}
            </SelectOption>
          ))}
        </Select>
      </Field>
    </div>
  );
}
const CARD_PARAMS = { limit: "100" } as const;

/** Radix Select items cannot carry an empty value. */
export const NEW_SUITE = "__new__";

/** Where a task is saved: a new suite (named here) or one that exists. */
export function SuiteFields({
  suites,
  choice,
  onChoiceChange,
  name,
  onNameChange,
  nameError,
}: {
  suites: EvalSuiteSummary[];
  choice: string;
  onChoiceChange: (choice: string) => void;
  name: string;
  onNameChange: (name: string) => void;
  nameError?: ReactNode;
}) {
  return (
    <div className="grid gap-x-4 gap-y-5 sm:grid-cols-2">
      <Field label="Suite" hint="A suite is a saved set of tasks you can run again after every change.">
        <Select value={choice} onValueChange={onChoiceChange}>
          <SelectOption value={NEW_SUITE}>New suite</SelectOption>
          {suites.length > 0 && <SelectSeparator />}
          {suites.map((s) => (
            <SelectOption key={s.id} value={s.id}>
              {s.name} · {plural(s.task_count, "task")}
            </SelectOption>
          ))}
        </Select>
      </Field>
      {choice === NEW_SUITE && (
        <Field label="Suite name" error={nameError}>
          <Input value={name} onChange={(e) => onNameChange(e.target.value)} placeholder="Support regression" autoComplete="off" />
        </Field>
      )}
    </div>
  );
}

/**
 * The wait while the judge model writes a draft. It can take a minute,
 * so it says what is happening, how long it may take, and what the way
 * out is (the dialog's footer carries the buttons).
 */
export function DraftingState({ title, body }: { title: string; body: ReactNode }) {
  return (
    <div role="status" aria-live="polite" className="flex flex-col items-center px-6 py-14 text-center">
      <span className="flex size-11 items-center justify-center rounded-[13px] bg-bg-soft">
        <BrandLoader label={title} />
      </span>
      <p className="mt-4 text-h3 text-fg">{title}</p>
      <p className="mt-1.5 max-w-[44ch] text-small text-fg-muted">{body}</p>
    </div>
  );
}
