// Eval trial detail (evals-design §7) — embedded session timeline +
// judge verdict card + trace-facts panel for one task × trial.
//
// Eval sessions are ordinary sessions: events come from the same
// /v1/sessions/:id/events API the SessionDetail page uses, and the
// timeline is the same TimelineView component. What's eval-specific is
// the stored trajectory (GET /v1/evals/trajectories/:id) — the runner
// persisted it with reward.metadata (llm_judge verdict, judge identity,
// token usage) and trace_facts stamped, which the rebuilt session
// trajectory doesn't carry. We prefer the stored one and fall back to
// the session rebuild so pre-Phase-2 trials still render something.

import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { useApi } from "../lib/api";
import { useApiQuery } from "../lib/useApiQuery";
import { shortenId } from "../lib/format";
import { TimelineView } from "../components/timeline/TimelineView";
import type { Event } from "../lib/events";
import type {
  JudgeCriterionVerdict,
  JudgeFinding,
  JudgeVerdict,
  RewardMetadata,
  TraceFacts,
  Trajectory,
} from "../lib/trajectory";
import { rewardHeadline } from "../lib/trajectory";

interface EvalTrial {
  trial_index: number;
  status: "pending" | "running" | "completed" | "failed";
  session_id?: string;
  trajectory_id?: string;
  error?: string;
  started_at?: string;
  ended_at?: string;
  reward?: number;
  exit_code?: number;
  turns?: number;
  /** Simulation trials only — persona-side counters stamped by the runner. */
  persona_turns?: number;
  sim_ended_by?: "persona" | "max_turns";
  persona_model_id?: string;
  persona_usage?: { input_tokens: number; output_tokens: number; calls: number };
}

/** Mirror of eval-core's SimulationSpec — same leaf-package rationale as
 *  the trajectory types in ../lib/trajectory. */
interface SimulationPersonaSpec {
  name?: string;
  identity: string;
  goals: string[];
  hidden_knowledge?: string;
  communication_style?: string;
  termination: string;
  scripted_messages?: string[];
}

interface SimulationSpec {
  scenario: string;
  persona: SimulationPersonaSpec;
  opening_message?: string;
  max_turns?: number;
  persona_model?: { model_card_id?: string; reasoning_level?: string; cross_family?: boolean };
}

interface EvalTask {
  id: string;
  spec: {
    id: string;
    /** Exactly one of `messages` / `simulation` is set (server-enforced). */
    messages?: string[];
    simulation?: SimulationSpec;
    pass_threshold?: number;
  };
  status: string;
  trials: EvalTrial[];
}

interface EvalRunDetailRes {
  id: string;
  agent_id: string;
  status: string;
  tasks: EvalTask[];
}

function statusCls(s: string): string {
  switch (s) {
    case "completed": return "bg-success-subtle text-success";
    case "failed":    return "bg-danger-subtle text-danger";
    case "running":   return "bg-info-subtle text-info";
    default:          return "bg-bg-surface text-fg-muted";
  }
}

function durationStr(start?: string, end?: string): string {
  if (!start) return "—";
  const s = new Date(start).getTime();
  const e = end ? new Date(end).getTime() : Date.now();
  const sec = Math.round((e - s) / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

export function EvalTrialDetail() {
  const { id: runId, taskId, trialIndex } = useParams<{
    id: string;
    taskId: string;
    trialIndex: string;
  }>();
  const { api } = useApi();

  const { data: run, isLoading } = useApiQuery<EvalRunDetailRes>(
    runId ? `/v1/evals/runs/${runId}` : null,
  );

  const task = run?.tasks.find((t) => t.id === taskId);
  const trial = task?.trials.find((tr) => tr.trial_index === Number(trialIndex));
  const sessionId = trial?.session_id;
  const trajectoryId = trial?.trajectory_id;

  // ── Session events (same paginated ASC walk SessionDetail does) ──────
  const [events, setEvents] = useState<Event[]>([]);
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    setEvents([]);
    void (async () => {
      const acc: Event[] = [];
      let afterSeq = 0;
      // Bound the loop so a malformed next_page never spins forever.
      for (let i = 0; i < 500; i++) {
        try {
          const res = await api<{
            data: Array<{ seq?: number; type: string; ts?: string; data: Event }>;
            has_more?: boolean;
            next_page?: string | null;
          }>(`/v1/sessions/${sessionId}/events?limit=200&order=asc&after_seq=${afterSeq}`);
          for (const e of res.data) {
            const inner = e.data || (e as unknown as Event);
            if (e.ts && !inner.ts) inner.ts = e.ts;
            if (e.seq !== undefined && inner.seq === undefined) inner.seq = e.seq;
            acc.push(inner);
          }
          if (cancelled) return;
          setEvents([...acc]);
          if (!res.has_more || !res.next_page) break;
          const m = /^seq_(\d+)$/.exec(res.next_page);
          if (!m) break;
          const next = parseInt(m[1], 10);
          if (!Number.isFinite(next) || next <= afterSeq) break;
          afterSeq = next;
        } catch {
          break;
        }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // ── Trajectory: stored (verdict + trace facts) → session rebuild ─────
  const [traj, setTraj] = useState<Trajectory | "loading" | "error" | undefined>(undefined);
  useEffect(() => {
    if (!trajectoryId && !sessionId) return;
    let cancelled = false;
    setTraj("loading");
    void (async () => {
      if (trajectoryId) {
        try {
          const t = await api<Trajectory>(`/v1/evals/trajectories/${trajectoryId}`);
          if (!cancelled) setTraj(t);
          return;
        } catch {
          // 404 (legacy trial) / 501 (runtime without KV) → rebuild path.
        }
      }
      if (sessionId) {
        try {
          const t = await api<Trajectory>(`/v1/sessions/${sessionId}/trajectory`);
          if (!cancelled) setTraj(t);
          return;
        } catch {}
      }
      if (!cancelled) setTraj("error");
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trajectoryId, sessionId]);

  // ── Evidence deep-link plumbing ───────────────────────────────────────
  // Chips only become clickable when the cited id resolves to a loaded
  // event (sevt_* id or the trace-facts `seq:<n>` fallback).
  const resolvableIds = useMemo(() => {
    const ids = new Set<string>();
    for (const e of events) {
      const eid = (e as { id?: string }).id;
      if (eid) ids.add(eid);
      if (typeof e.seq === "number") ids.add(`seq:${e.seq}`);
    }
    return ids;
  }, [events]);
  const [scrollTarget, setScrollTarget] = useState<{ eventId: string; nonce: number } | null>(null);
  const jumpTo = (eventId: string) =>
    setScrollTarget((cur) => ({ eventId, nonce: (cur?.nonce ?? 0) + 1 }));

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <svg className="animate-spin h-5 w-5 text-fg-subtle" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      </div>
    );
  }
  if (!run) return <div className="text-center py-16 text-fg-subtle">Run not found.</div>;
  if (!task || !trial) {
    return (
      <div className="text-center py-16 text-fg-subtle">
        Trial not found in this run.{" "}
        <Link to={`/evals/${run.id}`} className="text-brand hover:underline">Back to run</Link>
      </div>
    );
  }

  const reward = traj && traj !== "loading" && traj !== "error" ? traj.reward : undefined;
  const meta: RewardMetadata | undefined = reward?.metadata;
  const verdict: JudgeVerdict | undefined = meta?.verdict;
  const traceFacts: TraceFacts | undefined =
    traj && traj !== "loading" && traj !== "error" ? traj.trace_facts : undefined;

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="pl-3 pr-4 pt-3 pb-4 space-y-4 shrink-0">
        {/* Header — same wireless strip treatment as EvalRunDetail. */}
        <div className="space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${statusCls(trial.status)}`}>
              {trial.status}
            </span>
            {reward && meta?.judge_error === true ? (
              // Judge infrastructure failure (provider outage, no resolver):
              // the 0 reward says nothing about the agent — render as
              // UNGRADED, never as FAIL.
              <span
                className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium bg-warning-subtle text-warning"
                title={typeof meta.reason === "string" ? meta.reason : "judge could not run"}
              >
                UNGRADED · judge error
              </span>
            ) : reward ? (
              <span
                className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium ${
                  reward.final_reward >= (task.spec.pass_threshold ?? 1)
                    ? "bg-success-subtle text-success"
                    : "bg-danger-subtle text-danger"
                }`}
                title={reward.verifier_id ? `graded by ${reward.verifier_id}` : undefined}
              >
                {rewardHeadline(reward)}
              </span>
            ) : null}
            {meta?.judge_model_id && (
              <span
                className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-bg-surface text-fg-muted font-mono"
                title="Judge model × reasoning level"
              >
                ⚖ {meta.judge_model_id}
                {meta.judge_reasoning_level && (
                  <span className="text-fg-subtle">@{meta.judge_reasoning_level}</span>
                )}
              </span>
            )}
            {meta?.usage && (meta.usage.input_tokens ?? meta.usage.output_tokens) !== undefined && (
              <span className="text-xs text-fg-subtle font-mono" title="Judge token usage">
                judge {meta.usage.input_tokens ?? 0}↓ {meta.usage.output_tokens ?? 0}↑
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-fg-muted">
            <span>
              Task <span className="font-mono text-xs text-fg">{task.id}</span>
            </span>
            <span className="text-fg-subtle">·</span>
            <span>
              Trial <span className="text-fg font-medium">{trial.trial_index}</span>
            </span>
            <span className="text-fg-subtle">·</span>
            <span>
              Duration{" "}
              <span className="text-fg font-medium">{durationStr(trial.started_at, trial.ended_at)}</span>
            </span>
            {trial.turns !== undefined && (
              <>
                <span className="text-fg-subtle">·</span>
                <span>
                  Turns <span className="text-fg font-medium">{trial.turns}</span>
                </span>
              </>
            )}
            {sessionId && (
              <>
                <span className="text-fg-subtle">·</span>
                <span className="inline-flex items-center gap-1">
                  <span>Session</span>
                  <Link
                    to={`/sessions/${sessionId}`}
                    className="font-mono text-xs text-fg hover:text-brand"
                    title={sessionId}
                  >
                    {shortenId(sessionId)}
                  </Link>
                </span>
              </>
            )}
          </div>
        </div>

        {trial.error && (
          <div className="bg-danger-subtle/40 rounded-lg p-3">
            <div className="text-sm font-semibold text-danger mb-1">Trial error</div>
            <pre className="text-xs whitespace-pre-wrap text-fg">{trial.error}</pre>
          </div>
        )}

        {traj === "loading" && (
          <div className="text-xs text-fg-subtle">Loading trajectory…</div>
        )}
        {traj === "error" && (
          <div className="text-xs text-fg-subtle">
            Trajectory unavailable — verdict and trace facts can't be shown.
          </div>
        )}

        {verdict && (
          <VerdictCard
            verdict={verdict}
            resolvableIds={resolvableIds}
            onJump={jumpTo}
          />
        )}

        {task.spec.simulation && (
          <SimulationPanel sim={task.spec.simulation} trial={trial} />
        )}

        {/* Findings render whenever the judge produced any — not gated on
            the task being a simulation, so a plain-messages task graded by
            a findings-aware judge still surfaces them. */}
        {verdict?.findings && verdict.findings.length > 0 && (
          <FindingsPanel
            findings={verdict.findings}
            resolvableIds={resolvableIds}
            onJump={jumpTo}
          />
        )}

        {traceFacts && (
          <TraceFactsPanel
            facts={traceFacts}
            resolvableIds={resolvableIds}
            onJump={jumpTo}
          />
        )}
      </div>

      {/* Embedded session timeline — same component SessionDetail renders.
          Fixed-height flex container so the waterfall keeps its own
          scrollbar instead of fighting the page scroll. */}
      <div className="shrink-0 pl-3 pr-4 pb-1 flex items-baseline gap-2">
        <span className="text-sm font-medium text-fg">Timeline</span>
        <span className="text-xs text-fg-subtle font-mono">{events.length} events</span>
      </div>
      <div className="h-[70vh] shrink-0 flex flex-col min-h-0">
        <TimelineView events={events} scrollTarget={scrollTarget} />
      </div>
    </div>
  );
}

/** Evidence chip — clickable when the ref resolves to a loaded timeline
 *  event; `file:` refs and unresolvable ids render as inert chips. */
function EvidenceChip({
  evidence,
  resolvable,
  onJump,
}: {
  evidence: string;
  resolvable: boolean;
  onJump: (id: string) => void;
}) {
  if (resolvable) {
    return (
      <button
        onClick={() => onJump(evidence)}
        className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-bg-surface text-fg-muted hover:bg-info-subtle hover:text-info transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
        title="Scroll timeline to this event"
      >
        {evidence}
      </button>
    );
  }
  return (
    <span
      className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-bg-surface/60 text-fg-subtle"
      title={evidence.startsWith("file:") ? "Artifact reference" : "Not resolvable to a timeline event"}
    >
      {evidence}
    </span>
  );
}

function CriterionRow({
  c,
  resolvableIds,
  onJump,
}: {
  c: JudgeCriterionVerdict;
  resolvableIds: Set<string>;
  onJump: (id: string) => void;
}) {
  const unverified = !Array.isArray(c.evidence) || c.evidence.length === 0;
  return (
    <div className="flex items-start gap-2 py-1.5">
      <span
        className={`shrink-0 mt-0.5 inline-flex items-center justify-center w-4 h-4 rounded-full text-[10px] font-bold ${
          c.pass ? "bg-success-subtle text-success" : "bg-danger-subtle text-danger"
        }`}
      >
        {c.pass ? "✓" : "✗"}
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono text-xs text-fg">{c.id}</span>
          {/* Per §4.3: a criterion without evidence renders as unverified —
              rubrics must demand proof. */}
          {unverified && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-warning-subtle text-warning font-medium">
              unverified — no evidence cited
            </span>
          )}
        </div>
        {c.reasoning && <div className="text-xs text-fg-muted">{c.reasoning}</div>}
        {!unverified && (
          <div className="flex items-center gap-1 flex-wrap">
            {c.evidence.map((ev, i) => (
              <EvidenceChip
                key={`${ev}-${i}`}
                evidence={ev}
                resolvable={resolvableIds.has(ev)}
                onJump={onJump}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function VerdictCard({
  verdict,
  resolvableIds,
  onJump,
}: {
  verdict: JudgeVerdict;
  resolvableIds: Set<string>;
  onJump: (id: string) => void;
}) {
  return (
    <div className="rounded-lg bg-bg-surface/60 p-4 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-medium text-fg">Judge verdict</span>
        <span
          className={`inline-flex items-center text-xs px-2 py-0.5 rounded-full font-semibold ${
            verdict.pass ? "bg-success-subtle text-success" : "bg-danger-subtle text-danger"
          }`}
        >
          {verdict.pass ? "PASS" : "FAIL"}
        </span>
        <span className="text-xs font-mono text-fg-muted">
          score {Number.isFinite(verdict.score) ? verdict.score.toFixed(2) : "—"}
        </span>
      </div>
      {verdict.summary && <p className="text-sm text-fg-muted">{verdict.summary}</p>}
      <div className="divide-y divide-border/40">
        {verdict.criteria.map((c) => (
          <CriterionRow key={c.id} c={c} resolvableIds={resolvableIds} onJump={onJump} />
        ))}
      </div>
    </div>
  );
}

/** Simulation setup + outcome — persona identity/goals/termination from
 *  the task spec, ended-by / persona model / token usage from the trial.
 *  Rendered only for simulation tasks. */
function SimulationPanel({ sim, trial }: { sim: SimulationSpec; trial: EvalTrial }) {
  const persona = sim.persona;
  const usage = trial.persona_usage;
  return (
    <div className="rounded-lg bg-bg-surface/60 p-4 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-medium text-fg">Simulation</span>
        {trial.sim_ended_by && (
          <span
            className={`inline-flex items-center text-xs px-2 py-0.5 rounded-full font-medium ${
              trial.sim_ended_by === "persona"
                ? "bg-success-subtle text-success"
                : "bg-warning-subtle text-warning"
            }`}
            title={
              trial.sim_ended_by === "persona"
                ? "The persona ended the conversation on its termination rule"
                : "The conversation was cut off at max_turns"
            }
          >
            {trial.sim_ended_by === "persona" ? "ended by persona" : "hit max turns"}
          </span>
        )}
        {trial.persona_model_id && (
          <span
            className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-bg-surface text-fg-muted font-mono"
            title="Persona model — plays the simulated user"
          >
            persona · {trial.persona_model_id}
          </span>
        )}
        {(usage || trial.persona_turns !== undefined) && (
          <span className="ml-auto text-xs font-mono text-fg-subtle" title="Persona turns · token usage · model calls">
            {trial.persona_turns !== undefined && `${trial.persona_turns} turns`}
            {usage && (
              <>
                {trial.persona_turns !== undefined && " · "}
                {usage.input_tokens}↓ {usage.output_tokens}↑ · {usage.calls} calls
              </>
            )}
          </span>
        )}
      </div>

      <p className="text-sm text-fg-muted">{sim.scenario}</p>

      <div className="grid gap-3 lg:grid-cols-2">
        <div>
          <div className="text-xs font-medium text-fg-muted mb-1">
            Persona
            {persona.name && <span className="text-fg"> — {persona.name}</span>}
          </div>
          <div className="text-xs text-fg-muted">{persona.identity}</div>
        </div>

        {persona.goals.length > 0 && (
          <div>
            <div className="text-xs font-medium text-fg-muted mb-1">Goals</div>
            <ul className="text-xs text-fg-muted space-y-0.5">
              {persona.goals.map((g, i) => (
                <li key={i} className="flex items-baseline gap-1.5">
                  <span className="text-fg-subtle">·</span>
                  <span>{g}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div>
          <div className="text-xs font-medium text-fg-muted mb-1">Termination</div>
          <div className="text-xs text-fg-muted">{persona.termination}</div>
        </div>
      </div>
    </div>
  );
}

/** Severity tones for judge findings — critical reads as danger, major as
 *  warning, minor/info stay muted. */
const FINDING_SEVERITY_ORDER: JudgeFinding["severity"][] = ["critical", "major", "minor", "info"];

function findingSeverityCls(sev: string): string {
  switch (sev) {
    case "critical": return "bg-danger-subtle text-danger";
    case "major":    return "bg-warning-subtle text-warning";
    default:         return "bg-bg-surface text-fg-muted";
  }
}

function FindingRow({
  f,
  resolvableIds,
  onJump,
}: {
  f: JudgeFinding;
  resolvableIds: Set<string>;
  onJump: (id: string) => void;
}) {
  return (
    <div className="flex items-start gap-2 py-1.5">
      <span
        className={`shrink-0 mt-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded ${findingSeverityCls(f.severity)}`}
      >
        {f.severity}
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="text-xs text-fg">{f.summary}</div>
        {f.recommendation && (
          <div className="text-xs text-fg-muted">
            <span className="text-brand font-medium">fix:</span> {f.recommendation}
          </div>
        )}
        {Array.isArray(f.evidence) && f.evidence.length > 0 && (
          <div className="flex items-center gap-1 flex-wrap">
            {f.evidence.map((ev, i) => (
              <EvidenceChip
                key={`${ev}-${i}`}
                evidence={ev}
                resolvable={resolvableIds.has(ev)}
                onJump={onJump}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Judge findings grouped by category. Findings are orthogonal to the
 *  pass/fail criteria in VerdictCard — a passing trial can still carry a
 *  critical safety finding. */
function FindingsPanel({
  findings,
  resolvableIds,
  onJump,
}: {
  findings: JudgeFinding[];
  resolvableIds: Set<string>;
  onJump: (id: string) => void;
}) {
  const byCategory = new Map<string, JudgeFinding[]>();
  for (const f of findings) {
    const list = byCategory.get(f.category) ?? [];
    list.push(f);
    byCategory.set(f.category, list);
  }
  for (const list of byCategory.values()) {
    list.sort(
      (a, b) =>
        FINDING_SEVERITY_ORDER.indexOf(a.severity) - FINDING_SEVERITY_ORDER.indexOf(b.severity),
    );
  }
  return (
    <div className="rounded-lg bg-bg-surface/60 p-4 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-medium text-fg">Findings</span>
        <span className="text-xs font-mono text-fg-subtle">{findings.length}</span>
      </div>
      <div className="space-y-2">
        {[...byCategory.entries()].map(([cat, rows]) => (
          <div key={cat}>
            <div className="text-xs font-medium text-fg-muted">{cat}</div>
            <div className="divide-y divide-border/40">
              {rows.map((f, i) => (
                <FindingRow
                  key={`${f.summary}-${i}`}
                  f={f}
                  resolvableIds={resolvableIds}
                  onJump={onJump}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Event-id chip used across the trace-facts tables. */
function FactEventChip({
  eventId,
  resolvableIds,
  onJump,
}: {
  eventId: string | undefined;
  resolvableIds: Set<string>;
  onJump: (id: string) => void;
}) {
  if (!eventId) return null;
  return (
    <EvidenceChip evidence={eventId} resolvable={resolvableIds.has(eventId)} onJump={onJump} />
  );
}

function TraceFactsPanel({
  facts,
  resolvableIds,
  onJump,
}: {
  facts: TraceFacts;
  resolvableIds: Set<string>;
  onJump: (id: string) => void;
}) {
  const tok = facts.token_usage;
  return (
    <div className="rounded-lg bg-bg-surface/60 p-4 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-medium text-fg">Trace facts</span>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-surface text-fg-subtle">
          extracted by code, not by the agent
        </span>
        <span className="ml-auto text-xs font-mono text-fg-subtle">
          {facts.outcome} · {facts.turns} turns · {Math.round(facts.duration_ms / 1000)}s ·{" "}
          {tok.input_tokens}↓ {tok.output_tokens}↑
          {tok.cache_read_input_tokens > 0 && ` ⚡${tok.cache_read_input_tokens}`}
        </span>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {facts.tools.length > 0 && (
          <div>
            <div className="text-xs font-medium text-fg-muted mb-1">Tools</div>
            <table className="w-full text-xs">
              <tbody>
                {facts.tools.map((t) => (
                  <tr key={t.name}>
                    <td className="py-0.5 pr-2 font-mono text-fg">{t.name}</td>
                    <td className="py-0.5 pr-2 text-right text-fg-muted">{t.calls}×</td>
                    <td className={`py-0.5 text-right ${t.errors > 0 ? "text-danger" : "text-fg-subtle"}`}>
                      {t.errors > 0 ? `${t.errors} err` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {facts.exec_commands.length > 0 && (
          <div>
            <div className="text-xs font-medium text-fg-muted mb-1">Exec commands</div>
            <div className="space-y-0.5">
              {facts.exec_commands.map((c, i) => (
                <div key={`${c.event_id}-${i}`} className="flex items-center gap-2 text-xs">
                  <span
                    className={`shrink-0 font-mono text-[10px] px-1 rounded ${
                      c.exit_code === 0
                        ? "bg-success-subtle text-success"
                        : c.exit_code === -1
                        ? "bg-bg-surface text-fg-subtle"
                        : "bg-danger-subtle text-danger"
                    }`}
                    title={c.exit_code === -1 ? "no result recorded" : `exit ${c.exit_code}`}
                  >
                    {c.exit_code === -1 ? "?" : c.exit_code}
                  </span>
                  <code className="min-w-0 flex-1 truncate text-fg-muted" title={c.command_head}>
                    {c.command_head}
                  </code>
                  <FactEventChip eventId={c.event_id} resolvableIds={resolvableIds} onJump={onJump} />
                </div>
              ))}
            </div>
          </div>
        )}

        {facts.files_written.length > 0 && (
          <div>
            <div className="text-xs font-medium text-fg-muted mb-1">Files written</div>
            <div className="space-y-0.5">
              {facts.files_written.map((f, i) => (
                <div key={`${f.path}-${i}`} className="flex items-center gap-2 text-xs">
                  <code className="min-w-0 flex-1 truncate text-fg" title={f.path}>{f.path}</code>
                  <FactEventChip eventId={f.event_id} resolvableIds={resolvableIds} onJump={onJump} />
                </div>
              ))}
            </div>
          </div>
        )}

        {facts.errors.length > 0 && (
          <div>
            <div className="text-xs font-medium text-danger mb-1">Errors</div>
            <div className="space-y-0.5">
              {facts.errors.map((e, i) => (
                <div key={`${e.event_id}-${i}`} className="flex items-center gap-2 text-xs">
                  <span className="min-w-0 flex-1 truncate text-fg-muted" title={e.message_head}>
                    {e.message_head}
                  </span>
                  <FactEventChip eventId={e.event_id} resolvableIds={resolvableIds} onJump={onJump} />
                </div>
              ))}
            </div>
          </div>
        )}

        {facts.repeated_call_loops.length > 0 && (
          <div>
            <div className="text-xs font-medium text-warning mb-1">Repeated call loops</div>
            <div className="space-y-0.5">
              {facts.repeated_call_loops.map((l, i) => (
                <div key={`${l.tool}-${i}`} className="text-xs text-fg-muted">
                  <span className="font-mono text-fg">{l.tool}</span> called with identical input{" "}
                  {l.count}×
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
