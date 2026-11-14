import { useMemo } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

import {
  AMBIENT_SCHEDULE_PRESETS,
  AMBIENT_TRIGGER_SOURCES,
  WEEKDAYS,
  buildAmbientTrigger,
  eventOptionsForSource,
  withAmbientTriggerSource,
  type AmbientSchedulePreset,
  type AmbientTriggerDraft,
} from "../lib/ambient-controls";
import { ChoicePills, PickSelect } from "./agents/controls";
import { TRIGGER_SOURCE, describeTrigger } from "./agents/triggers";
import { Disclosure } from "./Disclosure";
import { Field } from "./Field";
import { LocalCombobox } from "./LocalCombobox";
import { TimeField } from "./TimeField";

interface AmbientTriggerControlsProps {
  value: AmbientTriggerDraft;
  onChange: (value: AmbientTriggerDraft) => void;
}

const PRESET_LABEL: Record<AmbientSchedulePreset, string> = {
  hourly: "Every hour",
  daily: "Every day",
  weekdays: "Every weekday",
  weekly: "Every week",
  monthly: "Every month",
  custom: "Custom (cron)",
};

const SOURCE_OPTIONS = AMBIENT_TRIGGER_SOURCES.map((source) => ({
  value: source,
  label: TRIGGER_SOURCE[source].label,
  icon: TRIGGER_SOURCE[source].icon,
}));

const PRESET_OPTIONS = AMBIENT_SCHEDULE_PRESETS.map((preset) => ({ value: preset, label: PRESET_LABEL[preset] }));
const MINUTE_OPTIONS = ["00", "15", "30", "45"].map((m) => ({ value: m, label: `:${m} past the hour` }));
const MONTH_DAY_OPTIONS = Array.from({ length: 31 }, (_, i) => ({ value: String(i + 1), label: `Day ${i + 1}` }));

function timezones(): string[] {
  try {
    const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone");
    if (supported?.length) return ["UTC", ...supported.filter((z) => z !== "UTC")];
  } catch {
    // older engines: fall through to the short list
  }
  return ["UTC", "America/New_York", "America/Chicago", "America/Los_Angeles", "Europe/London", "Europe/Berlin", "Asia/Tokyo"];
}

/**
 * What wakes the agent: a source (schedule, webhook, an app), then the
 * details for that source. Used by the trigger dialog on the agent page
 * and by the Triggers section of the new-agent dialog.
 *
 * The component only edits the draft. `buildAmbientTrigger(draft)` in
 * `lib/ambient-controls` turns it into the API's trigger object.
 */
export function AmbientTriggerControls({ value, onChange }: AmbientTriggerControlsProps) {
  const eventOptions = eventOptionsForSource(value.source);
  const zones = useMemo(timezones, []);

  // A sentence that restates the choice, so the result is never a guess.
  const preview = useMemo(() => {
    try {
      return describeTrigger(buildAmbientTrigger(value));
    } catch {
      return null; // the advanced override is not valid JSON yet
    }
  }, [value]);

  return (
    <div className="space-y-5">
      <div>
        <div className="mb-1.5 text-small leading-5 font-medium text-fg">Wakes on</div>
        <ChoicePills
          label="Trigger source"
          value={value.source}
          onChange={(source) => onChange(withAmbientTriggerSource(value, source))}
          options={SOURCE_OPTIONS}
        />
        <p className="mt-1.5 text-xs text-fg-subtle">{TRIGGER_SOURCE[value.source].hint}.</p>
      </div>

      {value.source === "schedule" ? (
        <div className="grid gap-x-3 gap-y-5 sm:grid-cols-2">
          <Field label="Repeats">
            <PickSelect
              value={value.schedulePreset}
              onValueChange={(schedulePreset) => onChange({ ...value, schedulePreset })}
              options={PRESET_OPTIONS}
            />
          </Field>

          {value.schedulePreset === "hourly" && (
            <Field label="At">
              <PickSelect
                value={value.scheduleTime.split(":")[1] ?? "00"}
                onValueChange={(minute) => onChange({ ...value, scheduleTime: `09:${minute}` })}
                options={MINUTE_OPTIONS}
              />
            </Field>
          )}

          {value.schedulePreset === "weekly" && (
            <Field label="On">
              <PickSelect
                value={value.scheduleWeekday}
                onValueChange={(scheduleWeekday) => onChange({ ...value, scheduleWeekday })}
                options={WEEKDAYS}
              />
            </Field>
          )}

          {value.schedulePreset === "monthly" && (
            <Field label="On">
              <PickSelect
                value={value.scheduleMonthDay}
                onValueChange={(scheduleMonthDay) => onChange({ ...value, scheduleMonthDay })}
                options={MONTH_DAY_OPTIONS}
              />
            </Field>
          )}

          {value.schedulePreset === "custom" && (
            <Field label="Cron expression" hint="Five fields: minute, hour, day of month, month, day of week.">
              <Input
                value={value.scheduleCustomCron}
                onChange={(e) => onChange({ ...value, scheduleCustomCron: e.target.value })}
                placeholder="0 9 * * *"
                spellCheck={false}
                className="font-mono"
              />
            </Field>
          )}

          {value.schedulePreset !== "hourly" && value.schedulePreset !== "custom" && (
            <Field label="Time">
              <TimeField value={value.scheduleTime} onChange={(scheduleTime) => onChange({ ...value, scheduleTime })} />
            </Field>
          )}

          <Field label="Time zone">
            <LocalCombobox<string>
              value={value.timezone}
              onChange={(timezone) => onChange({ ...value, timezone })}
              onPick={(timezone) => onChange({ ...value, timezone })}
              options={zones}
              filter={(zone, q) => zone.toLowerCase().includes(q)}
              getKey={(zone) => zone}
              renderItem={(zone) => <span className="block px-2 py-1.5 text-small-size text-fg">{zone.replace(/_/g, " ")}</span>}
              placeholder="UTC"
              maxHeight="14rem"
            />
          </Field>
        </div>
      ) : eventOptions.length > 1 ? (
        <Field label="Event">
          <PickSelect
            value={value.eventPreset}
            onValueChange={(eventPreset) => onChange({ ...value, eventPreset })}
            options={eventOptions}
          />
        </Field>
      ) : null}

      {preview && !value.useAdvancedConfig && (
        <p className="rounded-lg bg-bg-soft px-3.5 py-2.5 text-small text-fg-muted">
          <span className="font-medium text-fg">{preview.summary}</span>
          {preview.cron && <span className="ml-1.5 font-mono text-xs">{preview.cron}</span>}
          {preview.timezone && <span> · {preview.timezone.replace(/_/g, " ")}</span>}
        </p>
      )}

      <Disclosure
        title="Advanced: edit the trigger config"
        meta={value.useAdvancedConfig ? "In use" : undefined}
        defaultOpen={value.useAdvancedConfig}
      >
        <div className="space-y-3">
          <Field label="Config (JSON)" hint="Sent as the trigger's config exactly as written.">
            <Textarea
              value={value.advancedConfig}
              onChange={(e) => onChange({ ...value, advancedConfig: e.target.value, useAdvancedConfig: true })}
              rows={6}
              spellCheck={false}
              className="font-mono text-xs leading-relaxed md:text-xs"
            />
          </Field>
          <label className="flex cursor-pointer items-center gap-2.5 text-small text-fg">
            <Checkbox
              checked={value.useAdvancedConfig}
              onCheckedChange={(checked) => onChange({ ...value, useAdvancedConfig: checked === true })}
            />
            Use this config instead of the options above
          </label>
        </div>
      </Disclosure>
    </div>
  );
}
