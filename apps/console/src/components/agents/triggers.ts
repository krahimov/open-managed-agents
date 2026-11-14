import type { ComponentType } from "react";
import {
  BrainIcon,
  CalendarClockIcon,
  FileIcon,
  HandIcon,
  MailIcon,
  MessagesSquareIcon,
  WebhookIcon,
} from "lucide-react";

import type { AmbientTriggerSource, AmbientWakeMode } from "@/lib/ambient-controls";

import { GitHubIcon, LinearIcon, SlackIcon } from "../icons";

/**
 * The vocabulary for triggers (the API calls them ambient rules): how a
 * source, a wake mode and a schedule are named and described to people.
 * Every screen that shows or edits a trigger reads from here, so "Acts on
 * its own" means the same thing on the agent page, in the create dialog
 * and in a session.
 */

/** An ambient rule as the agent endpoints return it. */
export interface AmbientRule {
  type: "ambient_rule";
  id: string;
  agent_id: string;
  name: string;
  description?: string;
  enabled: boolean;
  trigger: { source: AmbientTriggerSource; config?: Record<string, unknown> };
  wake_mode: AmbientWakeMode;
  decision_policy?: Record<string, unknown>;
  budget?: Record<string, unknown>;
  created_at: string;
  updated_at?: string;
  next_wake_at?: string;
  last_wake_at?: string;
  last_decision?: { outcome: string; reason?: string; decided_at: string; session_id?: string };
}

type IconType = ComponentType<{ className?: string }>;

export const TRIGGER_SOURCE: Record<AmbientTriggerSource, { label: string; hint: string; icon: IconType }> = {
  schedule: { label: "Schedule", hint: "At set times", icon: CalendarClockIcon },
  webhook: { label: "Webhook", hint: "When another system calls in", icon: WebhookIcon },
  slack: { label: "Slack", hint: "Mentions, messages and uploads", icon: SlackIcon },
  teams: { label: "Microsoft Teams", hint: "Mentions and channel activity", icon: MessagesSquareIcon },
  github: { label: "GitHub", hint: "Pull requests, issues and pushes", icon: GitHubIcon },
  linear: { label: "Linear", hint: "Issues assigned, created or updated", icon: LinearIcon },
  email: { label: "Email", hint: "New mail that matches a search", icon: MailIcon },
  memory: { label: "Memory change", hint: "When a memory store is edited", icon: BrainIcon },
  file: { label: "File change", hint: "When a workspace file is edited", icon: FileIcon },
  manual: { label: "Manual", hint: "Only when someone starts it", icon: HandIcon },
};

export function triggerSourceMeta(source: string | undefined) {
  return (
    TRIGGER_SOURCE[source as AmbientTriggerSource] ?? {
      label: source ? humanize(source) : "Trigger",
      hint: "",
      icon: WebhookIcon,
    }
  );
}

/** What the agent does when a trigger fires. */
export const WAKE_MODE: Record<AmbientWakeMode, { label: string; short: string; hint: string }> = {
  observe: { label: "Observe", short: "Observes only", hint: "Reads the event and logs what it saw. Takes no action." },
  decide: { label: "Decide", short: "Decides, then acts", hint: "Assesses the event first and acts only if it is warranted." },
  act: { label: "Act", short: "Acts on its own", hint: "Does the work every time the trigger fires." },
  escalate: { label: "Escalate", short: "Escalates to a person", hint: "Flags a person instead of acting." },
};

export function wakeModeMeta(mode: string | undefined) {
  return WAKE_MODE[mode as AmbientWakeMode] ?? { label: mode ? humanize(mode) : "Act", short: mode ? humanize(mode) : "Acts", hint: "" };
}

export const DECISION_PRESET_LABEL = {
  always: { label: "Every time", hint: "Wake on every event." },
  new_signal: { label: "Only when something is new", hint: "Skip events that repeat what it has already seen." },
  approval_required: { label: "Ask before acting", hint: "A person approves before the agent acts." },
} as const;

export const BUDGET_PRESET_LABEL = {
  conservative: { label: "Conservative", hint: "Up to 4 runs a day" },
  standard: { label: "Standard", hint: "Up to 24 runs a day" },
  intensive: { label: "High frequency", hint: "Up to 96 runs a day" },
} as const;

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "pull_request.labeled" → "Pull request labeled". */
export function humanize(value: string): string {
  const s = value.replace(/[._-]+/g, " ").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function clock(hour: string, minute: string): string {
  return `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
}

/**
 * A cron expression in words, for the shapes people actually use.
 * Anything else returns null and the caller shows the raw expression.
 *
 *   "0 9 * * 1-5" → "Every weekday at 09:00"
 */
export function cronInWords(cron: string | undefined | null): string | null {
  if (!cron) return null;
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, mon, dow] = parts;
  if (mon !== "*" || !/^\d{1,2}$/.test(min)) return null;
  if (hour === "*" && dom === "*" && dow === "*") {
    return min === "0" ? "Every hour, on the hour" : `Every hour at :${min.padStart(2, "0")}`;
  }
  if (!/^\d{1,2}$/.test(hour)) return null;
  const at = clock(hour, min);
  if (dom === "*") {
    if (dow === "*") return `Every day at ${at}`;
    if (dow === "1-5") return `Every weekday at ${at}`;
    if (dow === "0,6" || dow === "6,0") return `Weekends at ${at}`;
    if (/^[0-6]$/.test(dow)) return `Every ${DAY_NAMES[Number(dow)]} at ${at}`;
    return null;
  }
  if (dow === "*" && /^\d{1,2}$/.test(dom)) return `Monthly on day ${dom} at ${at}`;
  return null;
}

/** Config keys that are shown elsewhere (the summary, the prompt line) or are plumbing. */
const HIDDEN_FACTS = new Set(["cron", "timezone", "preset", "prompt", "event", "mode", "method"]);

function factValue(value: unknown): string {
  if (Array.isArray(value)) return value.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(", ");
  if (value && typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export interface TriggerDescription {
  /** One sentence: when the agent wakes. */
  summary: string;
  /** Short qualifiers for chips: "repo: lumen-hq/platform". */
  facts: Array<{ key: string; label: string; value: string }>;
  /** The standing instruction sent on each run, when the rule carries one. */
  prompt: string | null;
  /** Raw cron, when it could not be put in words. */
  cron: string | null;
  timezone: string | null;
}

/** Describe a trigger in words. Never shows a raw source id or config blob. */
export function describeTrigger(trigger: { source?: string; config?: Record<string, unknown> } | undefined): TriggerDescription {
  const source = trigger?.source ?? "manual";
  const config = trigger?.config ?? {};
  const meta = triggerSourceMeta(source);
  const cron = typeof config.cron === "string" ? config.cron : null;
  const timezone = typeof config.timezone === "string" ? config.timezone : null;
  const prompt = typeof config.prompt === "string" && config.prompt.trim() ? config.prompt.trim() : null;
  const event = typeof config.event === "string" ? config.event : typeof config.mode === "string" ? config.mode : null;

  let summary: string;
  let rawCron: string | null = null;
  if (source === "schedule") {
    const words = cronInWords(cron);
    summary = words ?? "On a custom schedule";
    if (!words) rawCron = cron;
  } else if (source === "manual") {
    summary = "Only when someone starts it";
  } else if (source === "webhook") {
    summary = "When a webhook call arrives";
  } else if (event) {
    summary = `${meta.label}: ${humanize(event).toLowerCase()}`;
  } else {
    summary = `On ${meta.label} activity`;
  }

  const facts = Object.entries(config)
    .filter(([key, value]) => !HIDDEN_FACTS.has(key) && value !== null && value !== undefined && value !== "")
    .filter(([, value]) => !(Array.isArray(value) && value.length === 0))
    .map(([key, value]) => ({ key, label: humanize(key).toLowerCase(), value: factValue(value) }));

  return { summary, facts, prompt, cron: rawCron, timezone: source === "schedule" ? timezone : null };
}
