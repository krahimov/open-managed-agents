import { useId } from "react";

import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  AMBIENT_BUDGET_PRESETS,
  AMBIENT_DECISION_PRESETS,
  AMBIENT_WAKE_MODES,
  buildAmbientTrigger,
  buildBudget,
  buildDecisionPolicy,
  createDefaultAmbientTriggerDraft,
  type AmbientBudgetPreset,
  type AmbientDecisionPreset,
  type AmbientTriggerDraft,
  type AmbientWakeMode,
} from "@/lib/ambient-controls";

import { AmbientTriggerControls } from "../AmbientTriggerControls";
import { DateField } from "../DateField";
import { Field } from "../Field";
import { TimeField } from "../TimeField";
import { PickSelect } from "./controls";
import { BUDGET_PRESET_LABEL, DECISION_PRESET_LABEL, WAKE_MODE } from "./triggers";

/**
 * Everything a person decides about one trigger (an ambient rule): its
 * name, what wakes the agent, how the agent responds, and how often it may
 * run. The same fields are used when adding a trigger to an existing
 * agent and when creating an agent with its first trigger.
 */
export interface TriggerRuleDraft {
  name: string;
  description: string;
  enabled: boolean;
  trigger: AmbientTriggerDraft;
  wakeMode: AmbientWakeMode;
  decisionPreset: AmbientDecisionPreset;
  budgetPreset: AmbientBudgetPreset;
  /** `datetime-local` value, or "" to let the schedule decide. */
  nextWakeAt: string;
}

export function createTriggerRuleDraft(): TriggerRuleDraft {
  return {
    name: "",
    description: "",
    enabled: true,
    trigger: createDefaultAmbientTriggerDraft("schedule"),
    wakeMode: "decide",
    decisionPreset: "new_signal",
    budgetPreset: "standard",
    nextWakeAt: "",
  };
}

/**
 * The request body for `POST /v1/agents/:id/ambient-rules`. Throws with a
 * readable message when the draft cannot be sent (bad JSON override, bad
 * date), so callers show it next to the form.
 */
export function buildTriggerRuleBody(draft: TriggerRuleDraft, fallbackName = "Trigger"): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: draft.name.trim() || fallbackName,
    enabled: draft.enabled,
    trigger: buildAmbientTrigger(draft.trigger),
    wake_mode: draft.wakeMode,
  };
  const description = draft.description.trim();
  if (description) body.description = description;
  const policy = buildDecisionPolicy(draft.decisionPreset);
  if (policy) body.decision_policy = policy;
  const budget = buildBudget(draft.budgetPreset);
  if (budget) body.budget = budget;
  if (draft.nextWakeAt) {
    const nextWakeAt = new Date(draft.nextWakeAt);
    if (Number.isNaN(nextWakeAt.getTime())) throw new Error("First run must be a valid date and time");
    body.next_wake_at = nextWakeAt.toISOString();
  }
  return body;
}

const WAKE_OPTIONS = AMBIENT_WAKE_MODES.map((mode) => ({ value: mode, label: WAKE_MODE[mode].label, hint: WAKE_MODE[mode].hint }));
const DECISION_OPTIONS = AMBIENT_DECISION_PRESETS.map((p) => ({ value: p, ...DECISION_PRESET_LABEL[p] }));
// Offered in order of how often the agent may run.
const BUDGET_ORDER: AmbientBudgetPreset[] = ["conservative", "standard", "intensive"];
const BUDGET_OPTIONS = BUDGET_ORDER.filter((p) => AMBIENT_BUDGET_PRESETS.includes(p)).map((p) => ({ value: p, ...BUDGET_PRESET_LABEL[p] }));

/**
 * The first run: a day (<DateField>) and a time of day, local. The value
 * is the string a `datetime-local` input holds ("2027-02-09T09:00"), or ""
 * to follow the schedule, so what reads it did not change. The time can
 * only be set once there is a day, and starts at 09:00.
 */
function FirstRunField({
  value,
  onChange,
  id,
  "aria-labelledby": labelledBy,
  "aria-describedby": describedBy,
  "aria-invalid": invalid,
}: {
  value: string;
  onChange: (value: string) => void;
  id?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}) {
  const [day = "", time = ""] = value ? value.split("T") : [];
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return (
    <div className="flex items-start gap-2">
      <div className="min-w-0 flex-1">
        <DateField
          id={id}
          aria-labelledby={labelledBy}
          aria-describedby={describedBy}
          aria-invalid={invalid}
          value={day}
          min={today}
          placeholder="Follows the schedule"
          onChange={(d) => onChange(d ? `${d}T${time.slice(0, 5) || "09:00"}` : "")}
        />
      </div>
      <div className="w-[5.5rem] shrink-0">
        <TimeField
          value={time.slice(0, 5)}
          // Clearing the time keeps the day: it goes back to 09:00.
          onChange={(t) => day && onChange(`${day}T${t || "09:00"}`)}
          disabled={!day}
          aria-label="First run, time of day"
          className="text-center"
        />
      </div>
    </div>
  );
}

export function TriggerFields({
  value,
  onChange,
  namePlaceholder = "Hourly PR review",
  autoFocusName,
}: {
  value: TriggerRuleDraft;
  onChange: (value: TriggerRuleDraft) => void;
  namePlaceholder?: string;
  autoFocusName?: boolean;
}) {
  const set = <K extends keyof TriggerRuleDraft>(key: K, v: TriggerRuleDraft[K]) => onChange({ ...value, [key]: v });
  const switchId = useId();
  return (
    <div className="space-y-5">
      <div className="grid gap-x-3 gap-y-5 sm:grid-cols-2">
        <Field label="Name">
          <Input
            value={value.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder={namePlaceholder}
            autoFocus={autoFocusName}
          />
        </Field>
        <Field label="What it is for" hint="Optional. Shown on the trigger's card.">
          <Input
            value={value.description}
            onChange={(e) => set("description", e.target.value)}
            placeholder="Check for new pull requests every hour"
          />
        </Field>
      </div>

      <AmbientTriggerControls value={value.trigger} onChange={(trigger) => set("trigger", trigger)} />

      <div className="grid gap-x-3 gap-y-5 sm:grid-cols-2">
        <Field label="Then the agent">
          <PickSelect value={value.wakeMode} onValueChange={(v) => set("wakeMode", v)} options={WAKE_OPTIONS} />
        </Field>
        <Field label="Wakes">
          <PickSelect value={value.decisionPreset} onValueChange={(v) => set("decisionPreset", v)} options={DECISION_OPTIONS} />
        </Field>
        <Field label="Run limit">
          <PickSelect value={value.budgetPreset} onValueChange={(v) => set("budgetPreset", v)} options={BUDGET_OPTIONS} />
        </Field>
        <Field label="First run" hint="Optional. Leave empty to follow the schedule.">
          <FirstRunField value={value.nextWakeAt} onChange={(v) => set("nextWakeAt", v)} />
        </Field>
      </div>

      <div className="flex items-center justify-between gap-6 rounded-lg bg-bg-soft px-4 py-3">
        <div className="min-w-0">
          <label htmlFor={switchId} className="block text-small-size font-medium text-fg">
            Switch it on
          </label>
          <p className="mt-0.5 text-xs text-fg-muted">
            {value.enabled ? "It starts waking the agent as soon as it is created." : "It is created paused. Switch it on later from the agent's Triggers tab."}
          </p>
        </div>
        <Switch id={switchId} checked={value.enabled} onCheckedChange={(checked) => set("enabled", checked)} />
      </div>
    </div>
  );
}
