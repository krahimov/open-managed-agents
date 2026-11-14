import { createContext, useContext, useMemo, type ReactNode } from "react";
import { ArrowUpRightIcon, FileTextIcon, RepeatIcon, TerminalIcon, TriangleAlertIcon, WrenchIcon } from "lucide-react";

import {
  SEVERITY_ORDER,
  categoryLabel,
  formatScore,
  humanizeId,
  passMarkPhrase,
  severityRank,
  type Verdict,
} from "@/lib/evals";
import type { Event } from "@/lib/events";
import { formatCompact, formatSpan, plural } from "@/lib/format";
import type { JudgeCriterionVerdict, JudgeFinding, RewardResult, TraceFacts } from "@/lib/trajectory";
import { cn } from "@/lib/utils";

import { Chip } from "../Badge";
import { SectionCard } from "../SectionCard";
import { Tip } from "../Tip";
import { Labeled, SeverityChip, VerdictMark } from "./parts";

/**
 * The parts of a trial's verdict.
 *
 *   <EvidenceProvider>   knows the session's events, so a cited event id
 *                        becomes a named link into the timeline
 *   <ScoreMeter>         the score on a 0–1 bar, with the pass mark drawn in
 *   <Checks>             the judge's criteria: passed or not, why, and the
 *                        evidence it pointed to
 *   <FindingsCard>       what the judge noticed beyond pass or fail
 *   <TraceFactsCard>     what the agent did, as the platform recorded it
 */

// ── Evidence ────────────────────────────────────────────────────────────

interface EvidenceContext {
  /** Event id (or `seq:<n>`) → the event, for the ones that are loaded. */
  events: Map<string, Event>;
  onJump: (eventId: string) => void;
}

const Evidence = createContext<EvidenceContext>({ events: new Map(), onJump: () => {} });

export function EvidenceProvider({
  events,
  onJump,
  children,
}: {
  events: Event[];
  onJump: (eventId: string) => void;
  children: ReactNode;
}) {
  const value = useMemo(() => {
    const map = new Map<string, Event>();
    for (const e of events) {
      if (e.id) map.set(e.id, e);
      if (typeof e.seq === "number") map.set(`seq:${e.seq}`, e);
    }
    return { events: map, onJump };
  }, [events, onJump]);
  return <Evidence.Provider value={value}>{children}</Evidence.Provider>;
}

/** An event, named for what happened rather than by its id. */
function describeEvent(e: Event): string {
  switch (e.type) {
    case "user.message":
      return "User message";
    case "agent.message":
      return "Agent reply";
    case "agent.thinking":
      return "Thinking";
    case "agent.tool_use":
    case "agent.custom_tool_use":
      return e.name ? `${e.name} call` : "Tool call";
    case "agent.mcp_tool_use":
      return [e.mcp_server_name && humanizeId(e.mcp_server_name), e.name].filter(Boolean).join(" · ") || "App call";
    case "agent.tool_result":
    case "agent.mcp_tool_result":
      return "Tool result";
    case "session.error":
      return "Error";
    default:
      return humanizeId(e.type.replace(/^[a-z]+\./, ""));
  }
}

/**
 * One piece of evidence the judge cited. An event that is in this session
 * is a button that opens it in the timeline; a file is named; anything
 * else is shown as written, marked as not found.
 */
export function EvidenceChip({ evidence }: { evidence: string }) {
  const { events, onJump } = useContext(Evidence);
  const event = events.get(evidence);
  if (event) {
    return (
      <Tip label="Show this step in the timeline">
        <button
          type="button"
          onClick={() => onJump(evidence)}
          className="inline-flex h-[22px] max-w-full items-center gap-1 rounded-full bg-bg-soft pr-1.5 pl-2 text-xs font-medium text-fg-muted transition-quick hover:bg-bg-pressed hover:text-fg"
        >
          <span className="truncate">{describeEvent(event)}</span>
          <ArrowUpRightIcon className="size-3 shrink-0 opacity-60" />
        </button>
      </Tip>
    );
  }
  if (evidence.startsWith("file:")) {
    return (
      <Chip icon={FileTextIcon} mono title="A file the agent produced">
        {evidence.slice(5)}
      </Chip>
    );
  }
  return (
    <Tip label="The judge cited this, but no step of this session matches it">
      <span className="inline-flex">
        <Chip tone="outline" mono>
          {evidence}
        </Chip>
      </span>
    </Tip>
  );
}

function EvidenceRow({ evidence }: { evidence: string[] }) {
  if (evidence.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-fg-subtle">Evidence</span>
      {evidence.map((ev, i) => (
        <EvidenceChip key={`${ev}-${i}`} evidence={ev} />
      ))}
    </div>
  );
}

// ── Score ───────────────────────────────────────────────────────────────

/**
 * The score on its scale. The fill is the score, the tick is the pass
 * mark: how far over or under the bar the trial landed.
 */
export function ScoreMeter({ score, mark, verdict, className }: { score: number; mark: number; verdict: Verdict; className?: string }) {
  const clamp = (n: number) => Math.min(Math.max(n, 0), 1);
  const fill = verdict === "passed" ? "bg-success-solid" : verdict === "failed" ? "bg-danger-solid" : "bg-fg-faint";
  return (
    <div
      role="img"
      aria-label={`Scored ${formatScore(score)} of 1. A trial ${passMarkPhrase(mark)} to pass.`}
      className={cn("relative h-1.5 rounded-full bg-bg-soft", className)}
    >
      <div
        className={cn("h-full rounded-full transition-[width] duration-[var(--dur-slow)] ease-[var(--ease-rise)]", fill)}
        style={{ width: `${Math.max(clamp(score) * 100, score > 0 ? 3 : 0)}%` }}
      />
      {mark < 1 && (
        <span
          aria-hidden="true"
          className="absolute -top-1 h-3.5 w-0.5 -translate-x-1/2 rounded-full bg-fg ring-2 ring-bg-surface"
          style={{ left: `${clamp(mark) * 100}%` }}
        />
      )}
    </div>
  );
}

// ── Checks ──────────────────────────────────────────────────────────────

/**
 * Whether a check's written reason says anything its own name does not.
 * Some judges fill the field with a sentence built from the check's id
 * ("Checked okta steps correct against the transcript."), which under a
 * row titled "Okta steps correct" is the same words twice. A reason made
 * only of the check's name and filler is not shown.
 */
const FILLER = new Set(
  "a an the this that it was is were been and or of for in on to with by against per as checked check checks verified verify evaluated assessed reviewed compared judged graded transcript conversation session trajectory criterion criteria rubric response reply output pass passed passes fail failed fails met unmet not satisfied ok yes no true false".split(
    " ",
  ),
);
function restatesItsName(reasoning: string, id: string): boolean {
  const words = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const name = new Set(words(id));
  return words(reasoning).every((w) => name.has(w) || FILLER.has(w));
}

/**
 * The judge's criteria, one row each: passed or not, the reason, and the
 * evidence. A check passed with no evidence is flagged: a rubric should
 * make the judge point at something. When no check has evidence the flag
 * is said once, above the list, instead of on every row. A reason that
 * only repeats the check's name is left out (see `restatesItsName`).
 */
export function Checks({ criteria }: { criteria: JudgeCriterionVerdict[] }) {
  const cited = (c: JudgeCriterionVerdict) => Array.isArray(c.evidence) && c.evidence.length > 0;
  const noneCited = criteria.length > 0 && criteria.every((c) => !cited(c));
  // What failed comes first: it is why the reader is here.
  const ordered = [...criteria].sort((a, b) => Number(a.pass) - Number(b.pass));
  return (
    <div>
      {noneCited && (
        <p className="mb-4 flex items-start gap-2 text-small text-fg-muted">
          <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-warning" />
          <span>
            <span className="font-medium text-fg">The judge cited no evidence.</span> None of these checks points to a
            step or a file, so read them as its opinion. A rubric that asks for proof makes each one checkable.
          </span>
        </p>
      )}
      <ul className="divide-y divide-border">
        {ordered.map((c) => (
          <li key={c.id} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
            <VerdictMark verdict={c.pass ? "passed" : "failed"} size="sm" className="mt-px" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <Tip label={<span className="font-mono">{c.id}</span>} delay={500}>
                  <span className="text-small font-medium text-fg">{humanizeId(c.id)}</span>
                </Tip>
                {!c.pass && <span className="text-xs font-medium text-danger">Did not pass</span>}
                {!cited(c) && !noneCited && (
                  <Tip label="The judge gave this verdict without pointing to a step or a file">
                    <span className="inline-flex">
                      <Chip tone="warning">No evidence cited</Chip>
                    </span>
                  </Tip>
                )}
              </div>
              {c.reasoning && !restatesItsName(c.reasoning, c.id) && (
                <p className="mt-0.5 max-w-[80ch] text-small text-fg-muted">{c.reasoning}</p>
              )}
              {cited(c) && <EvidenceRow evidence={c.evidence} />}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Scores from a check that is not a judge (a script, a composite): name and number. */
export function ScoreBreakdown({ reward }: { reward: RewardResult }) {
  const entries = Object.entries(reward.raw_rewards ?? {});
  if (entries.length === 0) return <p className="text-small text-fg-muted">The check recorded a single score and no breakdown.</p>;
  return (
    <dl className="divide-y divide-border">
      {entries.map(([k, v]) => (
        <div key={k} className="flex items-center justify-between gap-6 py-2 first:pt-0 last:pb-0">
          <dt className="min-w-0 truncate text-small text-fg" title={k}>
            {humanizeId(k)}
          </dt>
          <dd className="shrink-0 text-small font-medium text-fg tabular-nums">{Number.isFinite(v) ? v.toFixed(2) : String(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

// ── Findings ────────────────────────────────────────────────────────────

/**
 * What the judge noticed beyond pass or fail, grouped by area, worst
 * first. A trial can pass every check and still carry a serious finding.
 */
export function FindingsCard({ findings }: { findings: JudgeFinding[] }) {
  const groups = useMemo(() => {
    const map = new Map<string, JudgeFinding[]>();
    for (const f of findings) map.set(f.category, [...(map.get(f.category) ?? []), f]);
    return [...map.entries()]
      .map(([category, rows]) => ({ category, rows: rows.sort((a, b) => severityRank(a.severity) - severityRank(b.severity)) }))
      .sort((a, b) => severityRank(a.rows[0].severity) - severityRank(b.rows[0].severity));
  }, [findings]);
  const totals = SEVERITY_ORDER.map((s) => ({ severity: s, count: findings.filter((f) => f.severity === s).length })).filter((t) => t.count > 0);

  return (
    <SectionCard
      title={`Findings (${findings.length})`}
      description="What the judge noticed while grading. A finding does not change the verdict."
      actions={
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {totals.map((t) => (
            <SeverityChip key={t.severity} severity={t.severity} count={t.count} />
          ))}
        </div>
      }
    >
      <div className="space-y-5">
        {groups.map((g) => (
          <Labeled key={g.category} label={categoryLabel(g.category)}>
            <ul className="space-y-3">
              {g.rows.map((f, i) => (
                <li key={`${f.summary}-${i}`} className="flex items-start gap-3">
                  <SeverityChip severity={f.severity} className="mt-px w-[58px] justify-center" />
                  <div className="min-w-0 flex-1">
                    <p className="text-small text-fg">{f.summary}</p>
                    {f.recommendation && (
                      <p className="mt-1 text-small text-fg-muted">
                        <span className="font-medium text-fg">Suggested fix:</span> {f.recommendation}
                      </p>
                    )}
                    {Array.isArray(f.evidence) && <EvidenceRow evidence={f.evidence} />}
                  </div>
                </li>
              ))}
            </ul>
          </Labeled>
        ))}
      </div>
    </SectionCard>
  );
}

// ── Trace facts ─────────────────────────────────────────────────────────

function JumpButton({ eventId }: { eventId: string | undefined }) {
  const { events, onJump } = useContext(Evidence);
  if (!eventId || !events.has(eventId)) return null;
  return (
    <Tip label="Show this step in the timeline">
      <button
        type="button"
        onClick={() => onJump(eventId)}
        aria-label="Show this step in the timeline"
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-full text-fg-subtle transition-quick hover:bg-bg-hover hover:text-fg"
      >
        <ArrowUpRightIcon className="size-3.5" />
      </button>
    </Tip>
  );
}

const OUTCOME: Record<string, string> = {
  success: "Finished on its own",
  failure: "Ended in a failure",
  timeout: "Ran out of time",
  interrupted: "Was interrupted",
  running: "Was still running",
};

/**
 * What the agent did, extracted from the session by the platform. It is
 * the record the judge is checked against: an agent can say it ran the
 * tests, this shows whether a command ran and how it exited.
 */
export function TraceFactsCard({ facts }: { facts: TraceFacts }) {
  const tok = facts.token_usage;
  const tools = [...facts.tools].sort((a, b) => b.calls - a.calls);
  const maxCalls = Math.max(...tools.map((t) => t.calls), 1);
  const summary = [
    OUTCOME[facts.outcome] ?? humanizeId(facts.outcome),
    plural(facts.turns, "turn"),
    formatSpan(facts.duration_ms / 1000),
    `${formatCompact(tok.input_tokens + (tok.cache_read_input_tokens ?? 0))} tokens in, ${formatCompact(tok.output_tokens)} out`,
  ];
  const empty =
    tools.length === 0 &&
    facts.exec_commands.length === 0 &&
    facts.files_written.length === 0 &&
    facts.errors.length === 0 &&
    facts.repeated_call_loops.length === 0;

  return (
    <SectionCard title="What the agent did" description="Read from the session by the platform, not reported by the agent.">
      <p className="text-small text-fg-muted">{summary.join(" · ")}</p>
      {empty ? (
        <p className="mt-3 text-small text-fg-subtle">It used no tools, ran no commands and wrote no files.</p>
      ) : (
        <div className="mt-5 grid gap-x-10 gap-y-6 lg:grid-cols-2">
          {tools.length > 0 && (
            <Labeled label={<FactLabel icon={WrenchIcon}>Tools used</FactLabel>}>
              <ul className="space-y-2">
                {tools.map((t) => (
                  <li key={t.name}>
                    <div className="flex items-baseline justify-between gap-3 text-small">
                      <span className="min-w-0 truncate font-mono text-small-size text-fg" title={t.name}>
                        {t.name}
                      </span>
                      <span className="shrink-0 text-fg-muted tabular-nums">
                        {plural(t.calls, "call")}
                        {t.errors > 0 && <span className="text-danger"> · {t.errors} failed</span>}
                      </span>
                    </div>
                    <div className="mt-1 h-1 overflow-hidden rounded-full bg-bg-soft">
                      <div className="h-full rounded-full bg-kind-tool" style={{ width: `${(t.calls / maxCalls) * 100}%` }} />
                    </div>
                  </li>
                ))}
              </ul>
            </Labeled>
          )}

          {facts.exec_commands.length > 0 && (
            <Labeled label={<FactLabel icon={TerminalIcon}>Commands run</FactLabel>}>
              <ul className="space-y-1.5">
                {facts.exec_commands.map((c, i) => {
                  const ok = c.exit_code === 0;
                  const unknown = c.exit_code === -1;
                  return (
                    <li key={`${c.event_id}-${i}`} className="flex items-center gap-2">
                      <Tip label={unknown ? "No result was recorded" : ok ? "Exited with 0" : `Exited with ${c.exit_code}`}>
                        <span className="inline-flex shrink-0">
                          <VerdictMark verdict={unknown ? "ungraded" : ok ? "passed" : "failed"} size="xs" />
                        </span>
                      </Tip>
                      <code className="min-w-0 flex-1 truncate font-mono text-xs text-fg" title={c.command_head}>
                        {c.command_head}
                      </code>
                      {!ok && !unknown && <span className="shrink-0 text-xs text-danger tabular-nums">exit {c.exit_code}</span>}
                      <JumpButton eventId={c.event_id} />
                    </li>
                  );
                })}
              </ul>
            </Labeled>
          )}

          {facts.files_written.length > 0 && (
            <Labeled label={<FactLabel icon={FileTextIcon}>Files written</FactLabel>}>
              <ul className="space-y-1.5">
                {facts.files_written.map((f, i) => (
                  <li key={`${f.path}-${i}`} className="flex items-center gap-2">
                    <code className="min-w-0 flex-1 truncate font-mono text-xs text-fg" title={f.path}>
                      {f.path}
                    </code>
                    <JumpButton eventId={f.event_id} />
                  </li>
                ))}
              </ul>
            </Labeled>
          )}

          {facts.errors.length > 0 && (
            <Labeled label={<FactLabel icon={TriangleAlertIcon}>Errors it ran into</FactLabel>}>
              <ul className="space-y-1.5">
                {facts.errors.map((e, i) => (
                  <li key={`${e.event_id}-${i}`} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-small text-danger" title={e.message_head}>
                      {e.message_head}
                    </span>
                    <JumpButton eventId={e.event_id} />
                  </li>
                ))}
              </ul>
            </Labeled>
          )}

          {facts.repeated_call_loops.length > 0 && (
            <Labeled label={<FactLabel icon={RepeatIcon}>Repeated itself</FactLabel>}>
              <ul className="space-y-1.5 text-small text-fg-muted">
                {facts.repeated_call_loops.map((l, i) => (
                  <li key={`${l.tool}-${i}`}>
                    Called <span className="font-mono text-small-size text-fg">{l.tool}</span> with the same input {l.count} times
                  </li>
                ))}
              </ul>
            </Labeled>
          )}
        </div>
      )}
    </SectionCard>
  );
}

function FactLabel({ icon: Icon, children }: { icon: React.ComponentType<{ className?: string }>; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Icon className="size-3.5" />
      {children}
    </span>
  );
}
