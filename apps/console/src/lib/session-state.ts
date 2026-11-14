import { plural } from "./format";

/**
 * One reading of a session.
 *
 * A session's state is shown in many places: its own header, the composer,
 * the Sessions list, the sidebar, Home, Operations. Each used to work it
 * out for itself, from different evidence, and they disagreed: one session
 * was "Waiting for a scheduled wake-up" on Home and "Retrying after an
 * error" on Operations; a session with three unanswered requests was
 * "Idle". `readSession` is the one place that decides. Everything that
 * shows a session's state takes what the console knows about it, calls
 * this, and draws the answer.
 *
 * The rules, in order:
 *
 *   1. The server's status is the authority on what the agent is doing
 *      (running, retrying, idle, ended). The last event only adds detail.
 *   2. A person being waited on outranks a session at rest. A tool call
 *      that needs approval, a request for access to an app, and a request
 *      for a skill are the same kind of thing: the agent asked, and nobody
 *      has answered. All three are amber, counted, and named.
 *   3. A turn that failed, with nothing running, is "Failed".
 *   4. "Running" and "Retrying" are claims about now. A session that makes
 *      one and has recorded nothing for half an hour is "Stalled": it may
 *      be on a long job or it may be stuck, and either way it should not
 *      sit among live work without saying so.
 *   5. A session at rest whose requests could not be read is "State
 *      unknown", never "Idle": nothing says it is waiting on nobody.
 *
 * Pure: no requests, no clock of its own (pass `now` in tests).
 */

/** A session that claims to be working and has recorded nothing for this long is stalled. */
export const STALLED_AFTER_MS = 30 * 60_000;

export type ReadingTone = "neutral" | "info" | "warning" | "danger";

/** What an agent asked a person for. */
export type WaitingFor = "approval" | "access" | "skill";

/** A request an agent made and nobody has answered: access to an app, or a skill. */
export interface OpenRequest {
  kind: "access" | "skill";
  /** Stable per request: its `request_id`, else its event id. */
  key: string;
  /** What it asks for, as people say it: "HubSpot", "Word documents". */
  name: string;
  at: number | null;
}

/** Everything a session is waiting on a person for. */
export interface Waiting {
  approvals: number;
  access: number;
  skills: number;
  /** Approvals plus requests. */
  count: number;
  kinds: WaitingFor[];
  /** "2 access requests and 1 skill request": the count, in words. */
  summary: string;
}

export interface SessionReading {
  /**
   * A key of the status vocabulary (`Badge.tsx`) for the dot and its halo:
   * `approval`, `errored`, `running`, `rescheduling`, `idle`, `terminated`,
   * `stalled` or `unknown` (not in the vocabulary: draw them with `tone` and `label`).
   */
  status: "approval" | "errored" | "running" | "rescheduling" | "stalled" | "unknown" | "idle" | "terminated";
  tone: ReadingTone;
  /** Two or three words: "Needs access", "Running", "Stalled". */
  label: string;
  /** One line that says more: "Waiting for access to HubSpot", "No activity for 4d 9h". */
  detail: string;
  /** Set when a person is being waited on, whatever the label says. */
  waiting: Waiting | null;
  /** It reports as working and has been silent past `STALLED_AFTER_MS`. */
  stalled: boolean;
  /** An agent is at work right now: running or retrying, and not stalled. */
  working: boolean;
  /** How long since anything was recorded, when that is known. */
  quietForMs: number | null;
}

export interface SessionFacts {
  /** The server's lifecycle status: idle | running | rescheduling | terminated. */
  status?: string | null;
  /** Tool calls waiting for approval. */
  approvals?: number;
  /** Unanswered access and skill requests. */
  requests?: ReadonlyArray<Pick<OpenRequest, "kind" | "name">>;
  /** The last turn failed and nothing has happened since. A string is the cause, in plain words. */
  error?: string | boolean | null;
  /** When the newest event was recorded (ms). */
  lastEventAt?: number | null;
  /** What the newest events say the agent is doing ("Running a command"). Detail only. */
  activity?: string | null;
  /**
   * Its open requests are not known: its events could not be read
   * (`unreadable`), or its log runs back further than the lists read
   * (`too-long`). `requests` then holds only what is known to be open.
   */
  requestsUnknown?: false | "unreadable" | "too-long" | null;
  now?: number;
}

/** Why a session's requests are not known, in the words every screen uses. */
export const UNKNOWN_DETAIL = {
  unreadable: "Its events could not be read, so whether it is waiting on you is not known",
  "too-long": "Its history is too long to check here for requests. Open it to see",
} as const;

/** "4d 9h", "3h 12m", "42m": how long, at the precision that matters. */
export function quietSpan(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

/** The one wording for a session that has gone quiet. */
export function quietWords(ms: number): string {
  return `No activity for ${quietSpan(ms)}`;
}

const list = (names: string[]): string =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

/** What a session is waiting on a person for, or null when it is waiting on nobody. */
export function waitingOn(approvals: number, requests: ReadonlyArray<Pick<OpenRequest, "kind">> = []): Waiting | null {
  const access = requests.filter((r) => r.kind === "access").length;
  const skills = requests.filter((r) => r.kind === "skill").length;
  const count = approvals + access + skills;
  if (count === 0) return null;
  const kinds: WaitingFor[] = [];
  const parts: string[] = [];
  if (approvals > 0) {
    kinds.push("approval");
    parts.push(plural(approvals, "approval"));
  }
  if (access > 0) {
    kinds.push("access");
    parts.push(plural(access, "access request"));
  }
  if (skills > 0) {
    kinds.push("skill");
    parts.push(plural(skills, "skill request"));
  }
  return { approvals, access, skills, count, kinds, summary: list(parts) };
}

function waitingLabel(w: Waiting): string {
  if (w.kinds.length > 1) return "Waiting on you";
  return w.kinds[0] === "approval" ? "Needs approval" : w.kinds[0] === "access" ? "Needs access" : "Needs a skill";
}

function waitingDetail(w: Waiting, requests: ReadonlyArray<Pick<OpenRequest, "kind" | "name">>): string {
  if (w.kinds.length > 1) return `Waiting on you: ${w.summary}`;
  if (w.kinds[0] === "approval") return w.approvals === 1 ? "Waiting for your approval" : `Waiting for ${w.approvals} approvals`;
  const names = [...new Set(requests.map((r) => r.name).filter(Boolean))];
  if (w.kinds[0] === "access") {
    return names.length > 0 && names.length <= 2 ? `Waiting for access to ${list(names)}` : `Waiting for access to ${plural(w.access, "app")}`;
  }
  return names.length === 1 ? `Waiting for the ${names[0]} skill` : `Waiting for ${plural(w.skills, "skill")}`;
}

export function readSession(facts: SessionFacts): SessionReading {
  const status = facts.status || "idle";
  const requests = facts.requests ?? [];
  const now = facts.now ?? Date.now();
  const quietForMs = facts.lastEventAt != null && Number.isFinite(facts.lastEventAt) ? Math.max(0, now - facts.lastEventAt) : null;
  const active = status === "running" || status === "rescheduling";
  // An ended session takes no answers: nothing in it is waiting on anyone.
  const waiting = status === "terminated" ? null : waitingOn(facts.approvals ?? 0, requests);
  const stalled = active && quietForMs !== null && quietForMs > STALLED_AFTER_MS;
  const base = { waiting, stalled, working: active && !stalled, quietForMs };

  // A person is needed, and the agent is not in the middle of something.
  if (waiting && !active) {
    return { ...base, status: "approval", tone: "warning", label: waitingLabel(waiting), detail: waitingDetail(waiting, requests) };
  }
  if (stalled) {
    return { ...base, status: "stalled", tone: "warning", label: "Stalled", detail: quietWords(quietForMs ?? 0) };
  }
  if (status === "running") {
    return { ...base, status: "running", tone: "info", label: "Running", detail: facts.activity?.trim() || "Working" };
  }
  if (status === "rescheduling") {
    return { ...base, status: "rescheduling", tone: "warning", label: "Retrying", detail: "Retrying after a failure" };
  }
  if (facts.error) {
    return {
      ...base,
      status: "errored",
      tone: "danger",
      label: "Failed",
      detail: typeof facts.error === "string" && facts.error.trim() ? facts.error.trim() : "The last turn failed",
    };
  }
  if (status === "terminated") {
    return { ...base, status: "terminated", tone: "neutral", label: "Ended", detail: "Ended. It takes no more messages" };
  }
  if (facts.requestsUnknown) {
    return { ...base, status: "unknown", tone: "neutral", label: "State unknown", detail: UNKNOWN_DETAIL[facts.requestsUnknown] };
  }
  return { ...base, status: "idle", tone: "neutral", label: "Idle", detail: "Waiting for a message" };
}
