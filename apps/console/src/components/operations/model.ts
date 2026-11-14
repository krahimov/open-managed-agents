import type { BudgetScope, OperationsReport } from "@/lib/operations";
import { budgetWarnings } from "@/lib/operations";
import { readSession, UNKNOWN_DETAIL, type OpenRequest, type SessionReading } from "@/lib/session-state";
import { sessionSource, sessionTitle, type SessionSource } from "@/lib/sessions";
import type { AgentRecord } from "@/types/agent";
import type { SessionRecord } from "@/types/session";

/**
 * The Operations page's view of the operations report.
 *
 * The report speaks in ids (`agent_id`, `sessionId`) and raw rows. This file
 * turns it into what a person acts on: who is asking, in which session, for
 * what, and since when. Pure functions, no requests: names come from the
 * agent directory and the recent-sessions window the shell already holds.
 */

type ReportSession = OperationsReport["sessions"][number];
type WorkItem = OperationsReport["work_items"][number];
export type Mission = OperationsReport["missions"][number];
export type TimeValue = string | number | null | undefined;

/** A session as the page shows it: by title and agent, never by id. */
export interface SessionRef {
  id: string;
  title: string;
  agentId?: string;
  agentName?: string;
  /** Where it was started, when the recent-sessions window knows. */
  source?: SessionSource;
  status?: string;
}

export interface ApprovalEntry {
  /** `${sessionId}:${toolUseId}` — also the scope of its actions. */
  key: string;
  session: SessionRef;
  toolUseId: string;
  name: string;
  input: Record<string, unknown>;
  requestedAt: TimeValue;
}

export interface FailureEntry {
  /** The work item id — also the scope of its actions. */
  key: string;
  session: SessionRef;
  /** `dead_letter`: the worker gave up; it can be retried but not discarded. */
  status: "failed" | "dead_letter";
  attempts: number;
  error: string | null;
  at: TimeValue;
  /** First line of the message the agent was handling when it failed. */
  trigger?: string;
}

/** A session that stopped on an error with nothing queued to retry. */
export interface EndedEntry {
  key: string;
  session: SessionRef;
  error: string;
  at: TimeValue;
}

/** Queued work the worker could not admit yet (capacity, a budget). It retries on its own. */
export interface WaitingEntry {
  key: string;
  session: SessionRef;
  reason: string;
  attempts: number;
  at: TimeValue;
}

export interface RunningEntry {
  key: string;
  session: SessionRef;
  lastEventAt: TimeValue;
  /** `rescheduling`: retrying after a transient failure. */
  retrying: boolean;
  /** The one reading of this session (lib/session-state.ts): "Running", "Retrying" or "Stalled", and why. */
  reading: SessionReading;
  /** The run until done this session is an iteration of, when it is one. */
  mission?: Mission;
}

/** A session with access or skill requests nobody has answered. They are answered on its page. */
export interface RequestEntry {
  /** The session id. */
  key: string;
  session: SessionRef;
  requests: OpenRequest[];
  /** When the oldest of them was asked. */
  at: TimeValue;
  reading: SessionReading;
}

/**
 * A session at rest whose requests could not be read: it may be waiting on
 * a person. Listed, never counted as waiting and never silently left out.
 */
export interface UnknownEntry {
  key: string;
  session: SessionRef;
  reason: "unreadable" | "too-long";
  /** The reason in the words every screen uses. */
  detail: string;
}

export interface BudgetEntry {
  scope: BudgetScope;
  /** "Workspace", or the agent's name for an agent-level limit. */
  label: string;
  agentId?: string;
  warnings: string[];
  /** A limit is reached: new work for this scope waits. */
  blocked: boolean;
  /** At least one limit is set. */
  limited: boolean;
}

export interface OperationsView {
  approvals: ApprovalEntry[];
  /** Sessions with unanswered access or skill requests (empty unless `requests` was passed in). */
  requests: RequestEntry[];
  /** Sessions whose requests could not be read (empty unless `unknown` was passed in). */
  unknown: UnknownEntry[];
  failures: FailureEntry[];
  ended: EndedEntry[];
  waiting: WaitingEntry[];
  /** Sessions with an agent at work right now. */
  running: RunningEntry[];
  /**
   * Sessions that report as running or retrying and have recorded nothing
   * for a long time. Kept apart from `running`: they are not live work.
   */
  stalled: RunningEntry[];
  activeMissions: Mission[];
  /** Active runs none of whose sessions is listed under `running` or `stalled` (between iterations, paused). */
  idleMissions: Mission[];
  pastMissions: Mission[];
  budgets: BudgetEntry[];
  /** Things waiting on a person: approvals plus open requests. */
  waitingOnYou: number;
  /**
   * How much is running now, each thing once: live sessions, plus active
   * runs that have no session among them. A run's own iteration session is
   * the run at work, so the two are one thing, not two.
   */
  runningNow: number;
  /** What the sidebar counts: approvals, open requests and failed work. */
  attention: number;
  /** Everything listed on the Needs attention tab, including notices. */
  queueSize: number;
}

const ACTIVE_MISSION = new Set(["running", "paused"]);

/** Before this the product did not exist: such a timestamp is a placeholder, not a time. */
const EARLIEST = Date.UTC(2015, 0, 1);

/** A timestamp worth showing, or null. Runtimes send 0, 1 or "" for "not recorded". */
export function cleanTime(value: TimeValue): string | number | null {
  if (value === null || value === undefined || value === "") return null;
  const ms = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) && ms >= EARLIEST ? value : null;
}

function asRecord(input: unknown): Record<string, unknown> {
  if (input && typeof input === "object" && !Array.isArray(input)) return input as Record<string, unknown>;
  return input === undefined || input === null ? {} : { input };
}

function triggerText(item: WorkItem): string | undefined {
  const content = item.event?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.find((block) => typeof block?.text === "string" && block.text.trim())?.text
        : undefined;
  const flat = text?.replace(/\s+/g, " ").trim();
  return flat || undefined;
}

export function buildOperationsView(
  report: OperationsReport,
  agents: Map<string, AgentRecord>,
  recent: SessionRecord[],
  /** Open access and skill requests by session (`useSessionReadings().requests`). */
  openRequests: ReadonlyMap<string, OpenRequest[]> = NO_REQUESTS,
  now: number = Date.now(),
  /**
   * Why each failed session failed, read from its log the way its own page
   * reads it (`useSessionReadings().failures`): the model's error when there
   * is one. The report carries only the runtime's message ("No output
   * generated…"), so without this a failure reads one way here and another
   * on the session's page.
   */
  causes: ReadonlyMap<string, string> = NO_CAUSES,
  /** Sessions whose requests could not be read, and why (`useSessionReadings().unknown`). */
  unknownRequests: ReadonlyMap<string, "unreadable" | "too-long"> = NO_UNKNOWN,
): OperationsView {
  const reported = new Map(report.sessions.map((s) => [s.id, s]));
  const recentById = new Map(recent.map((s) => [s.id, s]));

  const ref = (id: string, row?: ReportSession, fallbackAgentId?: string): SessionRef => {
    const known = recentById.get(id);
    const agentId = row?.agent_id || fallbackAgentId || known?.agent?.id || undefined;
    const agentName = (agentId ? agents.get(agentId)?.name : undefined) ?? known?.agent?.name;
    return {
      id,
      title: sessionTitle({ title: row?.title || known?.title, agent: { id: agentId ?? "", version: 0, name: agentName } }),
      agentId,
      agentName,
      source: known ? sessionSource(known) : undefined,
      status: row?.status ?? known?.status,
    };
  };

  const approvals: ApprovalEntry[] = report.sessions.flatMap((s) =>
    s.pending_approvals.map((p) => ({
      key: `${s.id}:${p.tool_use_id}`,
      session: ref(s.id, s),
      toolUseId: p.tool_use_id,
      name: p.name,
      input: asRecord(p.input),
      requestedAt: cleanTime(p.requested_at),
    })),
  );

  const failedItems = report.work_items.filter((w) => w.status === "failed" || w.status === "dead_letter");
  const failures: FailureEntry[] = failedItems.map((w) => {
    const row = reported.get(w.sessionId);
    return {
      key: w.id,
      session: ref(w.sessionId, row, w.agentId),
      status: w.status as FailureEntry["status"],
      attempts: w.attempts,
      error: causes.get(w.sessionId) || w.lastError || row?.error || null,
      at: cleanTime(w.updatedAt) ?? cleanTime(w.createdAt),
      trigger: triggerText(w),
    };
  });

  const failedSessions = new Set(failedItems.map((w) => w.sessionId));
  const ended: EndedEntry[] = report.sessions
    .filter((s) => s.error && s.status !== "running" && s.pending_approvals.length === 0 && !failedSessions.has(s.id))
    .map((s) => ({
      key: s.id,
      session: ref(s.id, s),
      error: causes.get(s.id) || (s.error as string),
      at: cleanTime(s.last_event_at) ?? cleanTime(s.updated_at),
    }));

  const waiting: WaitingEntry[] = report.work_items
    .filter((w) => w.status === "pending" && w.lastError)
    .map((w) => ({
      key: w.id,
      session: ref(w.sessionId, reported.get(w.sessionId), w.agentId),
      reason: readWaitReason(w.lastError as string, (id) => agents.get(id)?.name),
      attempts: w.attempts,
      at: cleanTime(w.updatedAt) ?? cleanTime(w.createdAt),
    }));

  const missions = report.missions.map((m) => ({ ...m, updated_at: Number(cleanTime(m.updated_at) ?? 0) }));
  const activeMissions = missions.filter((m) => ACTIVE_MISSION.has(m.status));
  const missionBySession = new Map(activeMissions.filter((m) => m.active_session_id).map((m) => [m.active_session_id as string, m]));

  const claiming: RunningEntry[] = report.sessions
    .filter((s) => s.status === "running" || s.status === "rescheduling")
    .map((s) => {
      const lastEventAt = cleanTime(s.last_event_at) ?? cleanTime(s.updated_at);
      return {
        key: s.id,
        session: ref(s.id, s),
        lastEventAt,
        retrying: s.status === "rescheduling",
        reading: readSession({
          status: s.status,
          approvals: s.pending_approvals.length,
          requests: openRequests.get(s.id),
          lastEventAt: lastEventAt == null ? null : new Date(lastEventAt).getTime(),
          now,
        }),
        mission: missionBySession.get(s.id),
      };
    });
  const running = claiming.filter((r) => !r.reading.stalled);
  const stalled = claiming.filter((r) => r.reading.stalled);
  const listed = new Set(claiming.map((r) => r.key));
  const idleMissions = activeMissions.filter((m) => !m.active_session_id || !listed.has(m.active_session_id));

  const requests: RequestEntry[] = [];
  for (const [id, list] of openRequests) {
    if (list.length === 0) continue;
    const row = reported.get(id);
    const session = ref(id, row);
    // An ended or archived session takes no answers.
    if ((row?.status ?? session.status) === "terminated" || recentById.get(id)?.archived_at) continue;
    const oldest = list.reduce<number | null>((min, r) => (r.at != null && (min == null || r.at < min) ? r.at : min), null);
    requests.push({
      key: id,
      session,
      requests: list,
      at: oldest,
      reading: readSession({ status: row?.status ?? session.status, approvals: row?.pending_approvals.length ?? 0, requests: list, now }),
    });
  }
  const openCount = requests.reduce((n, r) => n + r.requests.length, 0);

  // Not known to be waiting, and not known not to be: one at work or ended
  // is waiting on nobody, and one with an open request is listed above.
  const unknown: UnknownEntry[] = [];
  for (const [id, reason] of unknownRequests) {
    const row = reported.get(id);
    const session = ref(id, row);
    const status = row?.status ?? session.status;
    if (status === "running" || status === "rescheduling" || status === "terminated") continue;
    if (openRequests.get(id)?.length || recentById.get(id)?.archived_at) continue;
    unknown.push({ key: id, session, reason, detail: UNKNOWN_DETAIL[reason] });
  }

  const budgets: BudgetEntry[] = [...report.budgets]
    .sort((a, b) => Number(b.scope_id === "workspace") - Number(a.scope_id === "workspace"))
    .map((scope) => {
      const workspace = scope.scope_id === "workspace";
      const agent = workspace ? undefined : agents.get(scope.scope_id);
      return {
        scope,
        label: workspace ? "Workspace" : (agent?.name ?? "An agent that no longer exists"),
        agentId: workspace ? undefined : scope.scope_id,
        warnings: budgetWarnings(scope),
        blocked: scope.exceeded.length > 0,
        limited:
          scope.limits.daily_cost_usd !== null ||
          scope.limits.daily_tokens !== null ||
          scope.limits.max_concurrent_sessions !== null,
      };
    });

  const noticed = budgets.filter((b) => b.warnings.length > 0 || b.blocked).length;
  return {
    approvals,
    requests,
    unknown,
    failures,
    ended,
    waiting,
    running,
    stalled,
    activeMissions,
    idleMissions,
    pastMissions: missions.filter((m) => !ACTIVE_MISSION.has(m.status)),
    budgets,
    waitingOnYou: approvals.length + openCount,
    runningNow: running.length + idleMissions.filter((m) => m.status === "running").length,
    attention: approvals.length + openCount + failures.length,
    queueSize: approvals.length + openCount + failures.length + ended.length + waiting.length + noticed,
  };
}
const NO_REQUESTS: ReadonlyMap<string, OpenRequest[]> = new Map();
const NO_CAUSES: ReadonlyMap<string, string> = new Map();
const NO_UNKNOWN: ReadonlyMap<string, "unreadable" | "too-long"> = new Map();

const LIMIT_WORDS: Record<string, string> = {
  daily_tokens: "daily tokens",
  daily_cost_usd: "daily cost",
  max_concurrent_sessions: "concurrent sessions",
};

/**
 * Why queued work is being held. The worker reports a budget stop as
 * "Execution budget <scope>: <field>, <field>"; say it in the words the
 * Budgets tab uses. Anything else is shown as the worker wrote it.
 */
export function readWaitReason(reason: string, agentName: (id: string) => string | undefined): string {
  const match = /^Execution budget (\S+): (.+)$/.exec(reason.trim());
  if (!match) return reason;
  const who = match[1] === "workspace" ? "Workspace" : (agentName(match[1]) ?? "Agent");
  const fields = match[2].split(/,\s*/).map((field) => LIMIT_WORDS[field] ?? field.replace(/_/g, " "));
  return `${who} limit reached: ${fields.join(", ")}`;
}

/** Approvals of one session stay together under one heading. */
export function groupBySession<T extends { session: SessionRef }>(entries: T[]): Array<{ session: SessionRef; entries: T[] }> {
  const groups: Array<{ session: SessionRef; entries: T[] }> = [];
  for (const entry of entries) {
    const last = groups.find((g) => g.session.id === entry.session.id);
    if (last) last.entries.push(entry);
    else groups.push({ session: entry.session, entries: [entry] });
  }
  return groups;
}

/** Failures are read once, in lib/failures.ts, for this page and the session's error card. */
export { readFailure, type FailureReading } from "@/lib/failures";

/** Mission states in the words the session page uses for a run. */
export const MISSION_STATUS: Record<string, { status: string; label: string }> = {
  running: { status: "running", label: "Running" },
  paused: { status: "pending", label: "Paused" },
  succeeded: { status: "passed", label: "Goal verified" },
  stopped: { status: "terminated", label: "Stopped" },
  budget_exhausted: { status: "failed", label: "Out of budget" },
  stuck: { status: "failed", label: "Stuck" },
};

export function missionStatus(status: string): { status: string; label: string } {
  return MISSION_STATUS[status] ?? { status, label: status.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) };
}

/** The three limits of a budget scope, in the order Workspace settings lists them. */
export interface BudgetLine {
  key: "daily_cost_usd" | "daily_tokens" | "max_concurrent_sessions";
  label: string;
  used: number;
  limit: number | null;
  kind: "cost" | "count";
}

export function budgetLines(scope: BudgetScope): BudgetLine[] {
  return [
    { key: "daily_cost_usd", label: "Estimated cost", used: scope.usage.estimated_cost_usd, limit: scope.limits.daily_cost_usd, kind: "cost" },
    { key: "daily_tokens", label: "Tokens", used: scope.usage.tokens, limit: scope.limits.daily_tokens, kind: "count" },
    {
      key: "max_concurrent_sessions",
      label: "Concurrent sessions",
      used: scope.usage.active_sessions,
      limit: scope.limits.max_concurrent_sessions,
      kind: "count",
    },
  ];
}
