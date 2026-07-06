export const AMBIENT_TRIGGER_SOURCES = [
  "schedule",
  "webhook",
  "slack",
  "teams",
  "github",
  "linear",
  "email",
  "memory",
  "file",
  "manual",
] as const;

export type AmbientTriggerSource = (typeof AMBIENT_TRIGGER_SOURCES)[number];

export const AMBIENT_WAKE_MODES = ["observe", "decide", "act", "escalate"] as const;

export type AmbientWakeMode = (typeof AMBIENT_WAKE_MODES)[number];

export const AMBIENT_SCHEDULE_PRESETS = [
  "hourly",
  "daily",
  "weekdays",
  "weekly",
  "monthly",
  "custom",
] as const;

export type AmbientSchedulePreset = (typeof AMBIENT_SCHEDULE_PRESETS)[number];

export const AMBIENT_DECISION_PRESETS = [
  "always",
  "new_signal",
  "approval_required",
] as const;

export type AmbientDecisionPreset = (typeof AMBIENT_DECISION_PRESETS)[number];

export const AMBIENT_BUDGET_PRESETS = [
  "standard",
  "conservative",
  "intensive",
] as const;

export type AmbientBudgetPreset = (typeof AMBIENT_BUDGET_PRESETS)[number];

export const WEEKDAYS = [
  { value: "1", label: "Monday" },
  { value: "2", label: "Tuesday" },
  { value: "3", label: "Wednesday" },
  { value: "4", label: "Thursday" },
  { value: "5", label: "Friday" },
  { value: "6", label: "Saturday" },
  { value: "0", label: "Sunday" },
];

export interface AmbientTriggerDraft {
  source: AmbientTriggerSource;
  schedulePreset: AmbientSchedulePreset;
  scheduleTime: string;
  scheduleWeekday: string;
  scheduleMonthDay: string;
  scheduleCustomCron: string;
  timezone: string;
  eventPreset: string;
  useAdvancedConfig: boolean;
  advancedConfig: string;
}

export interface AmbientPolicyDraft {
  decisionPreset: AmbientDecisionPreset;
  budgetPreset: AmbientBudgetPreset;
}

export function createDefaultAmbientTriggerDraft(
  source: AmbientTriggerSource = "schedule",
): AmbientTriggerDraft {
  return {
    source,
    schedulePreset: "daily",
    scheduleTime: "09:00",
    scheduleWeekday: "1",
    scheduleMonthDay: "1",
    scheduleCustomCron: "0 9 * * *",
    timezone: localTimezone(),
    eventPreset: defaultEventPreset(source),
    useAdvancedConfig: false,
    advancedConfig: JSON.stringify(defaultAdvancedConfig(source), null, 2),
  };
}

export function withAmbientTriggerSource(
  draft: AmbientTriggerDraft,
  source: AmbientTriggerSource,
): AmbientTriggerDraft {
  return {
    ...draft,
    source,
    eventPreset: defaultEventPreset(source),
    useAdvancedConfig: false,
    advancedConfig: JSON.stringify(defaultAdvancedConfig(source), null, 2),
  };
}

export function buildAmbientTrigger(draft: AmbientTriggerDraft): {
  source: AmbientTriggerSource;
  config: Record<string, unknown>;
} {
  if (draft.useAdvancedConfig) {
    return {
      source: draft.source,
      config: parseJsonObject(draft.advancedConfig, "Advanced trigger config"),
    };
  }
  return {
    source: draft.source,
    config:
      draft.source === "schedule"
        ? buildScheduleConfig(draft)
        : buildEventConfig(draft.source, draft.eventPreset),
  };
}

export function buildDecisionPolicy(
  preset: AmbientDecisionPreset,
): Record<string, unknown> | undefined {
  switch (preset) {
    case "new_signal":
      return { only_when: "new_or_updated_signal" };
    case "approval_required":
      return { approval: "required_before_action" };
    default:
      return undefined;
  }
}

export function buildBudget(preset: AmbientBudgetPreset): Record<string, unknown> | undefined {
  switch (preset) {
    case "conservative":
      return { max_runs_per_day: 4, max_concurrent_sessions: 1 };
    case "intensive":
      return { max_runs_per_day: 96, max_concurrent_sessions: 1 };
    default:
      return { max_runs_per_day: 24, max_concurrent_sessions: 1 };
  }
}

export function scheduleSummary(config: unknown): string | null {
  if (!config || typeof config !== "object" || Array.isArray(config)) return null;
  const cron = (config as { cron?: unknown }).cron;
  const timezone = (config as { timezone?: unknown }).timezone;
  if (typeof cron !== "string") return null;
  const suffix = typeof timezone === "string" ? ` ${timezone}` : "";
  switch (cron) {
    case "0 * * * *":
      return `Hourly${suffix}`;
    case "0 9 * * *":
      return `Daily 09:00${suffix}`;
    case "0 9 * * 1-5":
      return `Weekdays 09:00${suffix}`;
    case "0 9 * * 1":
      return `Weekly Monday 09:00${suffix}`;
    case "0 9 1 * *":
      return `Monthly day 1 09:00${suffix}`;
    default:
      return cron;
  }
}

export function eventOptionsForSource(source: AmbientTriggerSource): Array<{
  value: string;
  label: string;
}> {
  switch (source) {
    case "github":
      return [
        { value: "pull_request_updates", label: "Pull request updates" },
        { value: "issues", label: "Issue activity" },
        { value: "pushes", label: "Pushes" },
      ];
    case "slack":
      return [
        { value: "mentions", label: "Mentions and DMs" },
        { value: "channel_scan", label: "Channel scan" },
      ];
    case "teams":
      return [
        { value: "mentions", label: "Mentions" },
        { value: "channel_scan", label: "Channel scan" },
      ];
    case "linear":
      return [
        { value: "assigned_or_mentioned", label: "Assigned or mentioned" },
        { value: "team_updates", label: "Team issue updates" },
      ];
    case "email":
      return [
        { value: "unread_inbox", label: "Unread inbox" },
        { value: "matching_query", label: "Matching search" },
      ];
    case "webhook":
      return [{ value: "post", label: "Incoming POST" }];
    case "memory":
      return [{ value: "changed", label: "Memory changed" }];
    case "file":
      return [{ value: "changed", label: "File changed" }];
    case "manual":
      return [{ value: "manual", label: "Manual trigger" }];
    default:
      return [];
  }
}

export function parseJsonObject(raw: string, label: string): Record<string, unknown> {
  const text = raw.trim();
  if (!text) return {};
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

export function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function buildScheduleConfig(draft: AmbientTriggerDraft): Record<string, unknown> {
  return {
    cron: cronFromDraft(draft),
    timezone: draft.timezone || "UTC",
    preset: draft.schedulePreset,
  };
}

function cronFromDraft(draft: AmbientTriggerDraft): string {
  const [hourRaw, minuteRaw] = draft.scheduleTime.split(":");
  const hour = clampInt(hourRaw, 0, 23, 9);
  const minute = clampInt(minuteRaw, 0, 59, 0);
  switch (draft.schedulePreset) {
    case "hourly":
      return `${minute} * * * *`;
    case "daily":
      return `${minute} ${hour} * * *`;
    case "weekdays":
      return `${minute} ${hour} * * 1-5`;
    case "weekly":
      return `${minute} ${hour} * * ${clampInt(draft.scheduleWeekday, 0, 6, 1)}`;
    case "monthly":
      return `${minute} ${hour} ${clampInt(draft.scheduleMonthDay, 1, 31, 1)} * *`;
    case "custom":
      return draft.scheduleCustomCron.trim() || "0 9 * * *";
  }
}

function buildEventConfig(
  source: AmbientTriggerSource,
  preset: string,
): Record<string, unknown> {
  switch (`${source}:${preset}`) {
    case "github:issues":
      return { event: "issues", actions: ["opened", "edited", "reopened"] };
    case "github:pushes":
      return { event: "push" };
    case "github:pull_request_updates":
      return { event: "pull_request", actions: ["opened", "synchronize", "reopened"] };
    case "slack:channel_scan":
      return { mode: "channel_scan" };
    case "slack:mentions":
      return { mode: "mentions" };
    case "teams:channel_scan":
      return { mode: "channel_scan" };
    case "teams:mentions":
      return { mode: "mentions" };
    case "linear:team_updates":
      return { event: "team_issue_updates" };
    case "linear:assigned_or_mentioned":
      return { event: "assigned_or_mentioned" };
    case "email:matching_query":
      return { mailbox: "inbox", query: "" };
    case "email:unread_inbox":
      return { mailbox: "inbox", query: "is:unread" };
    case "webhook:post":
      return { method: "POST" };
    case "memory:changed":
      return { event: "changed", path: "/mnt/memory" };
    case "file:changed":
      return { event: "changed", path: "/workspace" };
    case "manual:manual":
      return {};
    default:
      return defaultTriggerConfig(source);
  }
}

function defaultTriggerConfig(source: AmbientTriggerSource): Record<string, unknown> {
  if (source === "schedule") {
    return {
      cron: "0 9 * * *",
      timezone: localTimezone(),
      preset: "daily",
    };
  }
  return buildEventConfig(source, defaultEventPreset(source));
}

function defaultAdvancedConfig(source: AmbientTriggerSource): Record<string, unknown> {
  if (source === "schedule") {
    return {
      cron: "0 9 * * *",
      timezone: localTimezone(),
      preset: "daily",
    };
  }
  return buildEventConfig(source, defaultEventPreset(source));
}

function defaultEventPreset(source: AmbientTriggerSource): string {
  return eventOptionsForSource(source)[0]?.value ?? "manual";
}

function clampInt(
  value: string | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
