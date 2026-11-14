import type { Event } from "@/lib/events";
import type { OpenRequest } from "@/lib/session-state";

import { humanSkillName } from "../resources/skills";
import { eventTime } from "./model";
import { serverInfo } from "./tools";

/**
 * Requests an agent makes of a person, read from the event log.
 *
 * An agent can stop and ask for two things besides approval of a tool
 * call: access to an app (`system.access_request`) and a skill
 * (`system.skill_request`). The server records the asking as an event and
 * the answering as a message it writes itself:
 *
 *   access granted   a `user.message` that opens "[access granted] hubspot …"
 *                    (written by the connect card when the sign-in or the
 *                    key lands)
 *   skill attached   a `user.message` with `metadata.kind = "skill_attached"`
 *                    that opens `[skill attached] "docx" …` and carries the
 *                    playbook (written by POST /v1/skills/acquire)
 *
 * So whether a request is still open is a fact of the log, the same after a
 * reload and the same on every screen. A request is open until:
 *
 *   - its own answer arrives (that app was connected, that skill attached), or
 *   - a person replies in words. Someone who writes "skip HubSpot, do the
 *     rest" has answered; the card stays in the conversation and can still
 *     be used, but the session is no longer waiting on it, or
 *   - the session ends.
 *
 * Pure functions: the session page runs them over its whole log, the lists
 * over each session's events back to the point that settles every older
 * request (`useSessionReadings`, `log-reading.ts`).
 */

/** A message the server wrote to tell the agent a request was answered. */
export type Grant = { kind: "access"; service: string } | { kind: "skill"; skill: string };

function firstText(e: Event): string {
  if (typeof e.content === "string") return e.content;
  if (!Array.isArray(e.content)) return "";
  return e.content.find((b) => (!b.type || b.type === "text") && typeof b.text === "string")?.text ?? "";
}

const lower = (v: unknown): string => (typeof v === "string" ? v.trim().toLowerCase() : "");

/** Read a `user.message` as the answer to a request, or null when it is anything else. */
export function readGrant(e: Event): Grant | null {
  if (e.type !== "user.message") return null;
  const text = firstText(e).trimStart();
  const md = e.metadata as { kind?: string } | undefined;
  if (md?.kind === "skill_attached" || /^\[skill attached\]/i.test(text)) {
    return { kind: "skill", skill: lower(/^\[skill attached\]\s+["“]([^"”]+)["”]/i.exec(text)?.[1]) };
  }
  // "[access granted] hubspot is now connected …" / "[access granted] The retell API key is saved …"
  const access = /^\[access granted\]\s+(?:the\s+)?([\w.-]+)/i.exec(text);
  if (access) return { kind: "access", service: lower(access[1]) };
  return null;
}

/** A message a person wrote: not a wake-up, not a run's brief, not the server's note of an answer. */
export function isPersonMessage(e: Event): boolean {
  if (e.type !== "user.message") return false;
  const md = e.metadata as { harness?: string; kind?: string } | undefined;
  if (md?.kind === "wakeup" || md?.kind === "mission_iteration" || md?.kind === "skill_attached") return false;
  return readGrant(e) === null;
}

export interface RequestState {
  /** `open`: nobody has answered. `answered`: connected or attached. `passed`: the person replied without answering it. */
  state: "open" | "answered" | "passed";
}

/** The key a request event is known by: its `request_id`, else its event id. */
export function requestKey(e: Event): string {
  const id = (e as { request_id?: unknown }).request_id;
  return (typeof id === "string" && id) || (typeof e.id === "string" && e.id) || `${e.type}-${e.seq ?? ""}`;
}

/** An open request with what its answer is matched by (the service or skill, lower case). */
export type PendingRequest = OpenRequest & { match: string };

/**
 * Whether an event settles every request asked before it: a person's own
 * reply passes them over, and an ended session takes no answers. Reading a
 * log backward, nothing older than such an event can still be open.
 */
export function settlesEarlierRequests(e: Event): boolean {
  return e.type === "session.status_terminated" || isPersonMessage(e);
}

/**
 * Walk a log (oldest first) and say, for every request in it, whether it is
 * still open. `open` lists the unanswered ones in the order they were asked.
 *
 * `from` resumes a walk: the `pending` of an earlier call over the events
 * before these. The lists use it to fold in only what is new.
 */
export function readRequests(
  events: Event[],
  from: readonly PendingRequest[] = [],
): { open: OpenRequest[]; states: Map<string, RequestState["state"]>; pending: PendingRequest[] } {
  const states = new Map<string, RequestState["state"]>();
  let open: PendingRequest[] = from.map((r) => ({ ...r }));
  for (const r of open) states.set(r.key, "open");
  const settle = (keep: (r: PendingRequest) => boolean, as: RequestState["state"]) => {
    open = open.filter((r) => {
      if (keep(r)) return true;
      states.set(r.key, as);
      return false;
    });
  };
  for (const e of events) {
    if (e.type === "system.access_request") {
      const service = lower((e as { service?: unknown }).service) || "service";
      const key = requestKey(e);
      states.set(key, "open");
      open.push({ kind: "access", key, name: serverInfo(service).label, at: eventTime(e), match: service });
    } else if (e.type === "system.skill_request") {
      const skill = lower((e as { skill_name?: unknown }).skill_name) || "skill";
      const key = requestKey(e);
      states.set(key, "open");
      open.push({ kind: "skill", key, name: humanSkillName(skill), at: eventTime(e), match: skill });
    } else if (e.type === "user.message") {
      const grant = readGrant(e);
      if (grant?.kind === "access") settle((r) => !(r.kind === "access" && r.match === grant.service), "answered");
      else if (grant?.kind === "skill") {
        // The server names the skill it attached; an unnamed note answers the oldest skill request.
        const named = grant.skill && open.some((r) => r.kind === "skill" && r.match === grant.skill);
        const first = open.find((r) => r.kind === "skill");
        settle((r) => !(r.kind === "skill" && (named ? r.match === grant.skill : r === first)), "answered");
      } else if (isPersonMessage(e)) settle(() => false, "passed");
    } else if (e.type === "system.access_granted") {
      // The server's durable record of a grant, by request id. It settles the
      // card even when no "[access granted]" note follows.
      const rid = (e as { request_id?: unknown }).request_id;
      if (typeof rid === "string" && rid) settle((r) => !(r.kind === "access" && r.key === rid), "answered");
    } else if (e.type === "session.status_terminated") {
      settle(() => false, "passed");
    }
  }
  return { open: open.map(({ match: _match, ...r }) => r), states, pending: open };
}

/** The unanswered requests in a log (oldest first). */
export function openRequests(events: Event[]): OpenRequest[] {
  return readRequests(events).open;
}

/**
 * The same, from the newest events of a session as `?order=desc` returns
 * them. A request that is in the tail has all its answers in the tail too
 * (every answer comes after its request), but a cut-off tail can miss an
 * older request that is still open: the lists read back until an event
 * settles everything before it (`settlesEarlierRequests`), see
 * `components/sessions/log-reading.ts`.
 */
export function openRequestsFromTail(newestFirst: Event[]): OpenRequest[] {
  return openRequests([...newestFirst].reverse());
}

/**
 * Whether the open requests are still loading, for a band that is drawn
 * once. Loading until the first whole answer: an answer kept from a
 * narrower set of sessions (read while the lists were still arriving) is
 * not one, or the band would gain a row and change its count a moment
 * later. Once an answer has settled, a later re-read shows the last answer
 * rather than loading again.
 */
export function requestsPending(q: { candidates: number; isLoading: boolean; isPlaceholderData: boolean; settled: boolean }): boolean {
  if (q.candidates === 0) return false;
  return q.isLoading || (q.isPlaceholderData && !q.settled);
}
