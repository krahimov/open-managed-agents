import type { ComponentType } from "react";
import { BrainIcon, CircleAlertIcon, MessageSquareTextIcon, MoonIcon, PlayIcon, RotateCwIcon, ScanTextIcon, ShieldAlertIcon } from "lucide-react";

import type { Event } from "@/lib/events";
import { readFailure } from "@/lib/failures";

import { eventText, eventTime } from "../sessions/model";
import { presentTool } from "../sessions/tools";

/**
 * Reading a session's pulse from its newest events.
 *
 * Home says what a running agent is doing right now ("Running a command:
 * duckdb …") and how a finished one ended, in the agent's own words. Both
 * come from the tail of the session's event log (the existing
 * `GET /v1/sessions/:id/events?order=desc`), read here by pure functions.
 */

type IconType = ComponentType<{ className?: string }>;

export interface Activity {
  icon: IconType;
  /** What is happening, as a phrase: "Running a command", "Thinking". */
  label: string;
  /** What it is happening to: a command, a path, a query, the agent's words. */
  detail?: string;
  /** The detail is code (a command, a path): set it in mono. */
  code?: boolean;
  /** `working`: the agent is busy. `waiting`: on a person, a schedule or a retry. */
  tone: "working" | "waiting";
}

export interface SessionPulse {
  /** What the agent is doing now; null when the log does not say. */
  activity: Activity | null;
  /** When the turn it is working on began. */
  turnStartedAt: number | null;
  /** When the newest event happened. */
  lastEventAt: number | null;
  /** The last thing the agent said, on one line. */
  lastSaid?: string;
  /** The last thing that went wrong, when the log ends on an error. */
  error?: string;
}

/** The words `readSession` uses for a retrying session (lib/session-state.ts). */
const RETRYING = "Retrying after a failure";

const TOOL_USE = new Set(["agent.tool_use", "agent.custom_tool_use", "agent.mcp_tool_use"]);
const TOOL_RESULT = new Set(["agent.tool_result", "agent.mcp_tool_result", "user.custom_tool_result"]);

const ING: Record<string, string> = {
  run: "Running",
  read: "Reading",
  write: "Writing",
  edit: "Editing",
  list: "Listing",
  search: "Searching",
  open: "Opening",
  use: "Using",
  schedule: "Scheduling",
  update: "Updating",
  delegate: "Delegating",
};

/** "run a command" → "Running a command". */
function progressive(phrase: string): string {
  const [verb, ...rest] = phrase.split(" ");
  const ing = ING[verb] ?? `${verb[0].toUpperCase()}${verb.slice(1).replace(/e$/, "")}ing`;
  return [ing, ...rest].join(" ");
}

/**
 * Prose on one line, without its markdown: what a message says, not how it
 * is typeset. Used for "the agent's last words" in a list row.
 */
export function plainLine(markdown: string, max = 180): string {
  const lines = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .split("\n")
    .map((l) =>
      l
        .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/^\s*#{1,6}\s+/, "")
        .replace(/^\s*>\s+/, "")
        .replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "")
        .replace(/(\*\*|__)(.*?)\1/g, "$2")
        .replace(/(^|[\s(])[*_]([^*_\s][^*_]*)[*_](?=[\s).,;:!?]|$)/g, "$1$2")
        .replace(/`([^`]+)`/g, "$1")
        // Emoji are decoration in a message and noise in a one-line summary.
        .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    // A table's rows and rules say nothing on one line.
    .filter((l) => l && !/^\|/.test(l) && !/^[-=|:\s]+$/.test(l));
  // Lines that were separate thoughts (a heading, then bullets) stay separate.
  let text = "";
  for (const line of lines) {
    if (!text) text = line;
    else text += (/[.!?:,;—–]$/.test(text) ? " " : " · ") + line;
    if (text.length > max + 40) break;
  }
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:·—–-]+$/, "")}…`;
}

const callId = (e: Event): string | undefined =>
  (typeof e.id === "string" && e.id) || undefined;
const resultFor = (e: Event): string | undefined => {
  const id = e.tool_use_id ?? e.mcp_tool_use_id ?? (e as { custom_tool_use_id?: unknown }).custom_tool_use_id;
  return typeof id === "string" && id ? id : undefined;
};

/** Read the newest events of a session (newest first, as `order=desc` returns them). */
export function readPulse(newestFirst: Event[], opts: { retrying?: boolean } = {}): SessionPulse {
  const lastEventAt = newestFirst.length ? eventTime(newestFirst[0]) : null;

  const lastSaid = (() => {
    for (const e of newestFirst) {
      if (e.type !== "agent.message") continue;
      const said = plainLine(eventText(e));
      if (said) return said;
    }
    return undefined;
  })();

  // The turn began with the message (or wake-up) that set the agent running.
  let turnStartedAt: number | null = null;
  const at = newestFirst.findIndex((e) => e.type === "user.message" || e.type === "session.status_running");
  if (at >= 0) {
    const found = newestFirst[at];
    const older = newestFirst[at + 1];
    turnStartedAt = eventTime(found.type === "session.status_running" && older?.type === "user.message" ? older : found);
  }

  const finished = new Set<string>();
  let activity: Activity | null = null;
  let error: string | undefined;
  for (const e of newestFirst) {
    if (TOOL_RESULT.has(e.type)) {
      const id = resultFor(e);
      if (id) finished.add(id);
      // The agent has the output and is deciding what to do with it.
      activity = { icon: ScanTextIcon, label: "Reading the result", tone: "working" };
      break;
    }
    if (TOOL_USE.has(e.type)) {
      const id = callId(e);
      if (id && finished.has(id)) continue;
      const shown = presentTool({
        name: e.name ?? "tool",
        server: typeof e.mcp_server_name === "string" ? e.mcp_server_name : undefined,
        flavor: e.type === "agent.mcp_tool_use" ? "mcp" : e.type === "agent.custom_tool_use" ? "custom" : "tool",
        input: (e.input ?? {}) as Record<string, unknown>,
      });
      const builtIn = shown.kind === "tool" && /^(bash|shell|read|write|edit|multiedit|glob|grep)$/i.test(shown.title);
      activity = { icon: shown.icon, label: progressive(shown.verb), detail: shown.preview, code: builtIn, tone: "working" };
      break;
    }
    if (e.type === "session.status_idle") {
      const stop = (e.stop_reason as { type?: string } | undefined)?.type;
      if (stop === "requires_action") {
        activity = { icon: ShieldAlertIcon, label: "Waiting for approval", tone: "waiting" };
        break;
      }
      continue;
    }
    if (e.type === "span.wakeup_scheduled") {
      const reason = typeof e.reason === "string" ? e.reason : undefined;
      activity = { icon: MoonIcon, label: "Waiting for a scheduled wake-up", detail: reason, tone: "waiting" };
      break;
    }
    if (e.type === "session.status_rescheduled") {
      activity = { icon: RotateCwIcon, label: RETRYING, tone: "waiting" };
      break;
    }
    if (e.type === "session.error") {
      // In the session page's words: the model's own error, when it came
      // just before, leads (lib/failures.ts), not the runtime's "No output generated".
      const message = (typeof e.message === "string" && e.message) || (typeof e.error === "string" && e.error) || undefined;
      error = modelErrorBefore(newestFirst, newestFirst.indexOf(e)) ?? message;
      const reading = readFailure(error);
      activity = { icon: CircleAlertIcon, label: "Stopped on an error", detail: error ? (reading.cause ?? reading.headline) : undefined, tone: "waiting" };
      break;
    }
    if (e.type === "agent.thinking" || e.type === "span.model_request_start" || e.type === "span.model_first_token") {
      activity = { icon: BrainIcon, label: "Thinking", tone: "working" };
      break;
    }
    if (e.type === "agent.message") {
      activity = { icon: MessageSquareTextIcon, label: "Writing", detail: lastSaid, tone: "working" };
      break;
    }
    if (e.type === "user.message") {
      const asked = plainLine(eventText(e), 140);
      activity = { icon: PlayIcon, label: "Starting on", detail: asked || undefined, tone: "working" };
      break;
    }
  }

  // The server's status is the authority: a session it is retrying says
  // so, whatever its last event was. What the log ends on only adds detail
  // (the wake-up it had scheduled, the command it was running).
  if (opts.retrying) {
    const was = activity?.icon === MoonIcon ? `a wake-up was scheduled${activity.detail ? `: ${activity.detail}` : ""}` : activity?.detail;
    activity = { icon: RotateCwIcon, label: RETRYING, detail: was, code: activity?.icon === MoonIcon ? false : activity?.code, tone: "waiting" };
  }

  return { activity, turnStartedAt, lastEventAt, lastSaid, error };
}

/**
 * The model's error that explains the failure at `index` (newest first): the
 * `span.model_request_end` that finished in error just before it, within the
 * same turn. What the session's error card leads with.
 */
export function modelErrorBefore(newestFirst: Event[], index: number): string | undefined {
  for (let i = index + 1; i < newestFirst.length; i++) {
    const e = newestFirst[i];
    if (e.type === "session.status_running" || e.type === "user.message") return undefined;
    if (e.type !== "span.model_request_end") continue;
    const d = e as { data?: { finish_reason?: string; error_message?: string }; finish_reason?: string; error_message?: string };
    const finish = d.data?.finish_reason ?? d.finish_reason;
    const msg = d.data?.error_message ?? d.error_message;
    return finish === "error" && typeof msg === "string" && msg.trim() ? msg : undefined;
  }
  return undefined;
}

/**
 * A running clock: "42s", "3m 07s", "2h 14m", "4d 9h". Seconds are shown
 * while they matter and dropped once the figure is hours long.
 */
export function formatClock(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}
