import {
  AMBIENT_SCHEDULE_PRESETS,
  AMBIENT_TRIGGER_SOURCES,
  WEEKDAYS,
  eventOptionsForSource,
  withAmbientTriggerSource,
  type AmbientTriggerDraft,
  type AmbientTriggerSource,
} from "../lib/ambient-controls";
import type { ReactNode } from "react";

interface AmbientTriggerControlsProps {
  value: AmbientTriggerDraft;
  onChange: (value: AmbientTriggerDraft) => void;
  inputClassName: string;
}

export function AmbientTriggerControls({
  value,
  onChange,
  inputClassName,
}: AmbientTriggerControlsProps) {
  const eventOptions = eventOptionsForSource(value.source);
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <AmbientControlField label="Trigger">
          <select
            value={value.source}
            onChange={(e) =>
              onChange(withAmbientTriggerSource(value, e.target.value as AmbientTriggerSource))
            }
            className={inputClassName}
          >
            {AMBIENT_TRIGGER_SOURCES.map((source) => (
              <option key={source} value={source}>
                {source}
              </option>
            ))}
          </select>
        </AmbientControlField>

        {value.source === "schedule" ? (
          <AmbientControlField label="Repeat">
            <select
              value={value.schedulePreset}
              onChange={(e) =>
                onChange({
                  ...value,
                  schedulePreset: e.target.value as AmbientTriggerDraft["schedulePreset"],
                })
              }
              className={inputClassName}
            >
              {AMBIENT_SCHEDULE_PRESETS.map((preset) => (
                <option key={preset} value={preset}>
                  {presetLabel(preset)}
                </option>
              ))}
            </select>
          </AmbientControlField>
        ) : (
          <AmbientControlField label="Event">
            <select
              value={value.eventPreset}
              onChange={(e) => onChange({ ...value, eventPreset: e.target.value })}
              className={inputClassName}
            >
              {eventOptions.map((event) => (
                <option key={event.value} value={event.value}>
                  {event.label}
                </option>
              ))}
            </select>
          </AmbientControlField>
        )}
      </div>

      {value.source === "schedule" && (
        <SchedulePresetFields
          value={value}
          onChange={onChange}
          inputClassName={inputClassName}
        />
      )}

      <details className="rounded-md border border-border bg-bg-surface px-3 py-2">
        <summary className="cursor-pointer text-xs font-medium text-fg-muted">
          Advanced config override
        </summary>
        <label className="block mt-3 text-xs text-fg-muted">
          <span className="block mb-1">Config object</span>
          <textarea
            value={value.advancedConfig}
            onChange={(e) =>
              onChange({ ...value, advancedConfig: e.target.value, useAdvancedConfig: true })
            }
            rows={6}
            className={`${inputClassName} font-mono text-xs leading-relaxed resize-y`}
            spellCheck={false}
          />
        </label>
        <label className="mt-2 inline-flex items-center gap-2 text-xs text-fg-muted">
          <input
            type="checkbox"
            checked={value.useAdvancedConfig}
            onChange={(e) => onChange({ ...value, useAdvancedConfig: e.target.checked })}
            className="accent-brand"
          />
          Use override
        </label>
      </details>
    </div>
  );
}

function SchedulePresetFields({
  value,
  onChange,
  inputClassName,
}: AmbientTriggerControlsProps) {
  const showTime = value.schedulePreset !== "custom";
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {showTime && (
        <AmbientControlField label={value.schedulePreset === "hourly" ? "Minute" : "Time"}>
          {value.schedulePreset === "hourly" ? (
            <select
              value={value.scheduleTime.split(":")[1] ?? "00"}
              onChange={(e) => onChange({ ...value, scheduleTime: `09:${e.target.value}` })}
              className={inputClassName}
            >
              {["00", "15", "30", "45"].map((minute) => (
                <option key={minute} value={minute}>
                  :{minute}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="time"
              value={value.scheduleTime}
              onChange={(e) => onChange({ ...value, scheduleTime: e.target.value })}
              className={inputClassName}
            />
          )}
        </AmbientControlField>
      )}

      {value.schedulePreset === "weekly" && (
        <AmbientControlField label="Day">
          <select
            value={value.scheduleWeekday}
            onChange={(e) => onChange({ ...value, scheduleWeekday: e.target.value })}
            className={inputClassName}
          >
            {WEEKDAYS.map((day) => (
              <option key={day.value} value={day.value}>
                {day.label}
              </option>
            ))}
          </select>
        </AmbientControlField>
      )}

      {value.schedulePreset === "monthly" && (
        <AmbientControlField label="Day of month">
          <select
            value={value.scheduleMonthDay}
            onChange={(e) => onChange({ ...value, scheduleMonthDay: e.target.value })}
            className={inputClassName}
          >
            {Array.from({ length: 31 }, (_, i) => String(i + 1)).map((day) => (
              <option key={day} value={day}>
                {day}
              </option>
            ))}
          </select>
        </AmbientControlField>
      )}

      {value.schedulePreset === "custom" && (
        <AmbientControlField label="Cron">
          <input
            value={value.scheduleCustomCron}
            onChange={(e) => onChange({ ...value, scheduleCustomCron: e.target.value })}
            className={inputClassName}
            placeholder="0 9 * * *"
          />
        </AmbientControlField>
      )}

      <AmbientControlField label="Timezone">
        <input
          value={value.timezone}
          onChange={(e) => onChange({ ...value, timezone: e.target.value })}
          className={inputClassName}
          placeholder="UTC"
        />
      </AmbientControlField>
    </div>
  );
}

function AmbientControlField({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="block text-sm text-fg-muted">
      <span className="block mb-1">{label}</span>
      {children}
    </label>
  );
}

function presetLabel(preset: AmbientTriggerDraft["schedulePreset"]): string {
  switch (preset) {
    case "hourly":
      return "Hourly";
    case "daily":
      return "Daily";
    case "weekdays":
      return "Every weekday";
    case "weekly":
      return "Weekly";
    case "monthly":
      return "Monthly";
    case "custom":
      return "Custom cron";
  }
}
