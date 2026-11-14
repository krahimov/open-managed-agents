import { useSyncExternalStore } from "react";

import type { SessionRecord } from "../types/session";
import type { OperationsReport } from "./operations";
import { readSession } from "./session-state";

/**
 * Session display helpers. A session with no title is never shown as
 * "Untitled" or as its id: it falls back to the agent it is talking to.
 */

/**
 * The supervisor of a "run until done" mission names each iteration's
 * session after the mission's id: "Mission mis-V1StGXR8… · iteration 3".
 * An id is never a title here. Such a session is named by what the run is
 * trying to do, the goal in a few words, plus which iteration it is:
 * "Migrate every route file to withErrors · iteration 3". Two runs then
 * read as two different things in the list, the sidebar, the tab and the
 * breadcrumb. Until the goal is known it reads "Run until done · iteration 3".
 */
const MISSION_TITLE = /^Mission (mis[-_][\w-]+) · iteration (\d+)$/;

/** The mission and iteration a session belongs to, read from the title the supervisor gives it. */
export function missionRef(title: string | null | undefined): { missionId: string; iteration: number } | null {
  const m = MISSION_TITLE.exec(title?.trim() ?? "");
  return m ? { missionId: m[1], iteration: Number(m[2]) } : null;
}

/** Which iteration of a mission a session is, read from the title the supervisor gives it. */
export function missionIteration(title: string | null | undefined): number | null {
  return missionRef(title)?.iteration ?? null;
}

/**
 * What the console has learned about missions' goals, by mission id. A goal
 * never changes once a run exists, so this is a write-once note, filled from
 * wherever a mission passes through: the operations report (which the shell
 * reads on every page and which lists every mission) and a run's own record
 * on its session page. `sessionTitle` reads it, so every place that shows a
 * title names the run the same way without asking for anything itself.
 */
const missionGoals = new Map<string, string>();
const goalListeners = new Set<() => void>();
let goalsVersion = 0;

export function rememberMissions(missions: Iterable<{ id?: string | null; goal?: string | null }> | null | undefined): void {
  if (!missions) return;
  let changed = false;
  for (const m of missions) {
    const goal = m.goal?.trim();
    if (!m.id || !goal || missionGoals.get(m.id) === goal) continue;
    missionGoals.set(m.id, goal);
    changed = true;
  }
  if (!changed) return;
  goalsVersion += 1;
  // After the current render, not during it: a note may be taken while a list is being read.
  queueMicrotask(() => goalListeners.forEach((notify) => notify()));
}

/** The goal of a mission, when the console has seen it. */
export function missionGoal(missionId: string | null | undefined): string | undefined {
  return missionId ? missionGoals.get(missionId) : undefined;
}

/**
 * Re-render when a mission's goal becomes known. A component that shows
 * session titles and is not already re-rendered by the operations report
 * calls this once; the value is only a counter.
 */
export function useMissionGoals(): number {
  return useSyncExternalStore(
    (notify) => {
      goalListeners.add(notify);
      return () => goalListeners.delete(notify);
    },
    () => goalsVersion,
    () => goalsVersion,
  );
}

/** Only for tests: forget every goal. */
export function forgetMissions(): void {
  missionGoals.clear();
  goalsVersion += 1;
}

/**
 * A goal in a few words, for a title. The first clause when the goal has
 * one of a sensible length ("Migrate every route file to the withErrors
 * handler, with the tests green" keeps what is before the comma), otherwise
 * cut at a word with an ellipsis. Never mid-word.
 */
export function shortGoal(goal: string, max = 64): string {
  const flat = goal.replace(/\s+/g, " ").trim().replace(/[.。]+$/, "");
  if (flat.length <= max) return flat;
  // A whole clause may run a little past the limit: it reads better than a cut one.
  const clause = /^(.{24,}?)(?:[,;:]\s| [—–-] |\. )/.exec(flat)?.[1];
  if (clause && clause.length <= max + 16) return clause;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:—–-]+$/, "")}…`;
}

/** "Migrate every route file to withErrors · iteration 3", or the fallback while the goal is unknown. */
export function missionTitle(missionId: string | null | undefined, iteration: number | null | undefined, goal?: string | null): string {
  const known = goal?.trim() || missionGoal(missionId);
  const what = known ? shortGoal(known) : "Run until done";
  return iteration != null ? `${what} · iteration ${iteration}` : what;
}

export function sessionTitle(
  s: Pick<SessionRecord, "title" | "agent"> | null | undefined,
  agentName?: string,
): string {
  const title = s?.title?.trim();
  const mission = missionRef(title);
  if (mission) return missionTitle(mission.missionId, mission.iteration);
  if (title) return title;
  const name = agentName ?? s?.agent?.name;
  return name ? `Conversation with ${name}` : "New conversation";
}

/** Where a session was started from, read off its metadata. */
export type SessionSource = "console" | "linear" | "slack" | "github" | "eval" | "api" | "setup";

export function sessionSource(s: Pick<SessionRecord, "metadata">): SessionSource {
  const m = s.metadata ?? {};
  if (m.oma_setup) return "setup";
  if (m.linear) return "linear";
  if (m.slack) return "slack";
  if (m.github) return "github";
  if (m.eval) return "eval";
  const src = typeof m.source === "string" ? m.source : "";
  if (src === "linear" || src === "slack" || src === "github" || src === "eval") return src;
  if (src === "console" || src === "") return "console";
  return "api";
}

export const SESSION_SOURCE_LABEL: Record<SessionSource, string> = {
  console: "Console",
  linear: "Linear",
  slack: "Slack",
  github: "GitHub",
  eval: "Eval run",
  api: "API",
  setup: "Agent setup",
};

/**
 * What a session needs from a person right now, derived from the
 * operations report. `approval` beats `error`.
 */
export type SessionAttention = "approval" | "error" | null;

export function attentionBySession(report: OperationsReport | undefined): Map<string, SessionAttention> {
  // The report lists every mission with its goal: note them, so a run's
  // sessions are titled by what the run is for (see `sessionTitle`).
  rememberMissions(report?.missions);
  const map = new Map<string, SessionAttention>();
  for (const s of report?.sessions ?? []) {
    if (s.pending_approvals.length > 0) map.set(s.id, "approval");
    else if (s.error) map.set(s.id, "error");
  }
  return map;
}

/**
 * The status key to show for a session when all that is known is its
 * lifecycle status and what the operations report says. It is the one
 * reading (`readSession` in session-state.ts) with less evidence: a caller
 * that also knows about open requests and the newest event should use
 * `useSessionReadings().read(session)` instead, which can say "Needs access"
 * and "Stalled" as well.
 */
export function sessionDisplayStatus(status: string | undefined, attention?: SessionAttention): string {
  return readSession({ status, approvals: attention === "approval" ? 1 : 0, error: attention === "error" }).status;
}
