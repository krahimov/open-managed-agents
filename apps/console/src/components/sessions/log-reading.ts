import type { Event } from "@/lib/events";
import type { OpenRequest } from "@/lib/session-state";

import { readRequests, settlesEarlierRequests, type PendingRequest } from "./requests";

/**
 * What the lists need to know from a session's own log, and how they read
 * just enough of it to know it for certain.
 *
 * The operations report says a session's status, its approvals and that its
 * last turn failed. It does not say two things every overview shows:
 *
 *   open requests   access to an app or a skill an agent asked for and
 *                   nobody has answered (`requests.ts`)
 *   the failure     why the last turn failed, in the words the session's own
 *                   error card uses: the model's error (`span.model_request_end`)
 *                   when there is one, else the runtime's message. The report
 *                   only carries the runtime's message, which is often just
 *                   "No output generated. Check the stream for errors."
 *
 * Both are facts of the log, so the lists fold the log the way the session
 * page does. They do not need all of it:
 *
 *   - a request asked before a person's reply (or before the session ended)
 *     is settled by it, whatever came after, so reading back to the newest
 *     such event settles every request;
 *   - the report names only a failure after the last `session.status_running`,
 *     so reading back to that event settles the failure.
 *
 * `readSessionLog` reads backward from the newest events until both are
 * settled (or the log begins), then remembers where it stopped (`seq`), so
 * the next read asks only for what is newer. See `readings.ts` for the
 * budget and why.
 */

export interface LogFailure {
  /** The runtime's code (`model_error`, `harness_turn_failed`). */
  code: string;
  /** The runtime's message. */
  message?: string;
  /** The model's own error, when one came just before: what the session page leads with. */
  cause?: string;
}

export interface LogState {
  /** The newest event folded in (0: none). */
  seq: number;
  /** Requests nobody has answered, oldest first. */
  pending: PendingRequest[];
  /** The failure of the turn since the last `session.status_running`, if it failed. */
  failure: LogFailure | null;
  /** A model error waiting for the `session.error` it explains. */
  modelError: string | null;
  /** The fold reaches back far enough for `failure` to be the report's. */
  failureKnown: boolean;
}

export const EMPTY_LOG: LogState = { seq: 0, pending: [], failure: null, modelError: null, failureKnown: true };

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

/** Fold events (oldest first) onto what was known. Pure. */
export function foldLog(state: LogState, events: Event[]): LogState {
  const pending = readRequests(events, state.pending).pending;
  let { failure, modelError, seq } = state;
  for (const e of events) {
    if (typeof e.seq === "number" && e.seq > seq) seq = e.seq;
    switch (e.type) {
      case "session.status_running":
        // The report reads a failure from after the last start only.
        failure = null;
        break;
      case "span.model_request_end": {
        const d = e as { data?: { finish_reason?: string; error_message?: string }; finish_reason?: string; error_message?: string };
        const finish = d.data?.finish_reason ?? d.finish_reason;
        const msg = str(d.data?.error_message ?? d.error_message);
        if (finish === "error" && msg) modelError = msg;
        else if (finish && finish !== "error") modelError = null;
        break;
      }
      case "session.error": {
        const code = str(e.error) ?? "error";
        const message = str((e as { message?: unknown }).message);
        // The runtime reports one failure twice (the turn, then its work item): keep the first, with its cause.
        if (failure && failure.code === code && failure.message === message) break;
        failure = { code, message, cause: modelError ?? undefined };
        modelError = null;
        break;
      }
    }
  }
  return { seq, pending, failure, modelError, failureKnown: state.failureKnown };
}

/** The open requests of a fold, as every screen shows them. */
export function openOf(state: LogState): OpenRequest[] {
  return state.pending.map(({ match: _match, ...r }) => r);
}

/**
 * The failure as the session page reads it (`readFailure(cause ?? message)`),
 * or null when the fold does not know it.
 */
export function failureText(state: LogState): string | null {
  if (!state.failureKnown || !state.failure) return null;
  return state.failure.cause ?? state.failure.message ?? state.failure.code;
}

/**
 * Where a fold of the newest events can start (an index into `newestFirst`)
 * so that it settles every request and, when `needFailure`, the failure; or
 * null when the events given do not reach back that far.
 */
export function settledFrom(newestFirst: Event[], needFailure: boolean): number | null {
  const requests = newestFirst.findIndex(settlesEarlierRequests);
  if (requests < 0) return null;
  if (!needFailure) return requests;
  const started = newestFirst.findIndex((e) => e.type === "session.status_running");
  if (started < 0) return null;
  return Math.max(requests, started);
}

/** One page of `GET /v1/sessions/:id/events`. */
export interface EventsPage {
  data: Event[];
  has_more?: boolean;
}

export interface ReadBudget {
  /** The newest events asked for first. */
  tail: number;
  /** Events per page after that, backward or forward. */
  page: number;
  /** Stop reading backward after this many events. */
  most: number;
}

export type LogRead = {
  /** `too-long`: the log goes back further than the budget without settling its requests. What the reach holds is still true. */
  kind: "known" | "too-long";
  state: LogState;
  /** The read stopped at the budget: reading again will not reach further. */
  exhausted?: boolean;
};

/** Events as either runtime returns them: flat (Node) or `{ seq, type, data, ts }` (Workers). */
export function normalize(raw: Event): Event {
  const inner = raw.data as Event | undefined;
  const e = inner && typeof inner === "object" && typeof inner.type === "string" ? inner : raw;
  if (e === raw || typeof e.seq === "number" || typeof raw.seq !== "number") return e;
  return { ...e, seq: raw.seq };
}

const seqOf = (e: Event): number | null => (typeof e.seq === "number" && Number.isFinite(e.seq) ? e.seq : null);

/**
 * Read a session's log until what the lists show is settled.
 *
 *   prev        what an earlier read knew; when it reaches back far enough,
 *               only newer events are asked for (`after_seq`, oldest first)
 *   needFailure the report says the last turn failed: also settle why
 *   get         asks for one page (a path under /v1/sessions/:id/events)
 *
 * Backward reading uses only what the events endpoint offers: the newest
 * events (`order=desc&limit=`), then the page just before the oldest one
 * read (`after_seq=<oldest - 1 - page>&limit=<page>`, oldest first). The
 * sequence numbers of a session's events count up from 1, so that page
 * ends just before what was already read; anything else that comes back is
 * dropped. Throws when a page cannot be read.
 */
export async function readSessionLog(
  get: (query: string) => Promise<EventsPage>,
  prev: LogState | null,
  needFailure: boolean,
  budget: ReadBudget,
): Promise<LogRead> {
  // ── forward, from where the last read stopped ──
  if (prev && prev.seq > 0 && (prev.failureKnown || !needFailure)) {
    let state = prev;
    for (let read = 0; read < budget.most; ) {
      const res = await get(`?after_seq=${state.seq}&limit=${budget.page}&order=asc`);
      const events = (Array.isArray(res?.data) ? res.data : []).map(normalize).filter((e) => (seqOf(e) ?? 0) > state.seq);
      if (events.some((e) => seqOf(e) === null)) break;
      state = foldLog(state, events);
      read += events.length;
      if (!res.has_more || events.length === 0) return { kind: "known", state };
    }
    // Far behind: start again from the newest events.
  }

  // ── backward, from the newest events ──
  const first = await get(`?limit=${budget.tail}&order=desc`);
  let have = (Array.isArray(first?.data) ? first.data : []).map(normalize);
  let older = !!first?.has_more;
  for (;;) {
    const from = settledFrom(have, needFailure);
    if (from !== null || !older) {
      const span = from === null ? have : have.slice(0, from + 1);
      // A fold that starts at the log's first event, or at the newest start of a turn, knows the failure.
      const failureKnown = !older || (from !== null && span.some((e) => e.type === "session.status_running"));
      return { kind: "known", state: foldLog({ ...EMPTY_LOG, failureKnown }, [...span].reverse()) };
    }
    const seqs = have.map(seqOf);
    const oldest = seqs.length && seqs.every((s) => s !== null) ? Math.min(...(seqs as number[])) : null;
    if (oldest === null || have.length >= budget.most) {
      // No way to page back, or past the budget. What the reach holds is
      // true (a request in it has all its answers in it); whether an older
      // request is still open is known only if the reach settles them.
      const state = foldLog({ ...EMPTY_LOG, failureKnown: false }, [...have].reverse());
      return { kind: have.some(settlesEarlierRequests) ? "known" : "too-long", state, exhausted: true };
    }
    if (oldest <= 1) {
      older = false;
      continue;
    }
    const after = Math.max(0, oldest - 1 - budget.page);
    const res = await get(`?after_seq=${after}&limit=${oldest - 1 - after}&order=asc`);
    const page = (Array.isArray(res?.data) ? res.data : []).map(normalize).filter((e) => (seqOf(e) ?? Infinity) < oldest);
    have = have.concat(page.reverse());
    older = after > 0 && page.length > 0;
  }
}
