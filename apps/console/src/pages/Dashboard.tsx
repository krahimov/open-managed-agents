import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { ArrowRightIcon, CheckIcon, CopyIcon, TerminalIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

import { useAuth } from "../lib/auth";
import { BRAND_NAME } from "../lib/brand";
import { useCopy } from "../lib/clipboard";
import { useAgents, useOperations, useRecentSessions } from "../lib/directory";
import { formatCompact, formatCost } from "../lib/format";
import { HARNESS_AGENT_BUILDER_PROMPT, HARNESS_AGENT_BUILDER_SKILL } from "../lib/harness-agent-builder-skill";
import type { ComposeIntent } from "../lib/shell-events";
import { usageWindow, utcDayKey } from "../lib/usage-window";
import { useApiQuery } from "../lib/useApiQuery";

import { buildOperationsView } from "../components/operations/model";
import { useSessionReadings } from "../components/sessions/readings";
import { FirstRunGuide } from "../components/FirstRunGuide";
import { AllQuiet, NeedsAttention, RunningNow, runningSessions } from "../components/home/RightNow";
import { SessionStarter } from "../components/home/SessionStarter";
import { finishedSessions, SinceLastVisit } from "../components/home/SinceLastVisit";
import { useLastVisit } from "../components/home/useLastVisit";
import { Modal } from "../components/Modal";
import { PAGE_GUTTER } from "../components/Page";
import { QueryProblem } from "../components/QueryProblem";
import { Section, sectionLinkClass } from "../components/SectionCard";
import { Skeleton } from "../components/Skeleton";
import { StatTile } from "../components/StatTile";
import { Wash } from "../components/Wash";
import { periodChanges, ProportionBar, type UsageReport } from "./usage/parts";
import { cn } from "@/lib/utils";
import { quietLink } from "@/lib/links";

/**
 * Home — the conversational front door.
 *
 *   greeting + session starter   give an agent something to do: a message
 *                                box, the agent, attachments, Options, and
 *                                three or four things to ask that agent
 *   Running now                  what is being worked on this minute, live
 *   Needs attention              what is waiting on a person
 *   Since you were last here     what finished, and how it went, in the
 *                                agent's own words
 *   Last 30 days                 spend, sessions, tokens, cache savings:
 *                                the same window and numbers as Usage
 *   Workspace                    counts that link to each resource, and the
 *                                agent-builder skill for coding agents
 *
 * The sidebar already lists frequent agents and recent sessions by name, so
 * Home does not repeat them: everything below the starter says something
 * the sidebar cannot (state, progress, outcome, cost).
 *
 * Starting a session is <SessionStarter>; the same component opens in a
 * dialog everywhere else (<NewSessionDialog>).
 */

interface Stats {
  agents: number;
  sessions: number;
  environments: number;
  vaults: number;
  skills: number;
  model_cards: number;
  api_keys: number;
}

const CONTENT = "mx-auto w-full max-w-[1120px]";
const WINDOW_DAYS = 30;

function greeting(now = new Date()): string {
  const h = now.getHours();
  if (h < 5) return "Working late";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

/** First name for the greeting; nothing for the local dev identity. */
function firstName(user: { name?: string; email?: string } | null | undefined): string | null {
  if (!user?.name) return null;
  if (/@(localhost|local)$/i.test(user.email ?? "")) return null;
  const first = user.name.trim().split(/\s+/)[0];
  return first && first.length > 1 ? first : null;
}

export function Dashboard() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();

  const { agents, byId, isLoading: agentsLoading, error: agentsError } = useAgents();
  const { sessions, isLoading: sessionsLoading, error: sessionsError, refetch: refetchSessions } = useRecentSessions();
  const ops = useOperations();
  const statsQuery = useApiQuery<Stats>("/v1/stats");
  const stats = statsQuery.data ?? null;
  const { since } = useLastVisit();

  // "New session" (sidebar, palette, agent cards) lands here with an intent:
  // the starter takes focus, with that agent chosen.
  const intent = location.state as ComposeIntent | null;
  // An intent is a request made once. It is taken out of the history entry
  // as soon as the starter has it, so a reload or the back button does not
  // ask again (and put the starter back on an agent the person has since
  // moved on from).
  useEffect(() => {
    if (intent?.compose) navigate(".", { replace: true, state: null });
  }, [intent?.compose, navigate]);

  // ── the workspace's state ───────────────────────────────────────────
  const name = firstName(user);
  const workspaceActive = (stats?.agents ?? agents.length) > 0;
  // Agents failing to load is an outage, not an empty workspace.
  const agentsDown = !!agentsError && agents.length === 0;
  const firstRun = !!stats && !agentsDown && (!workspaceActive || stats.sessions === 0);
  const [showGuide, setShowGuide] = useState(false);
  const [showSkill, setShowSkill] = useState(false);

  // ── right now ───────────────────────────────────────────────────────
  // A row is named by its session's title and its agent's name, which come
  // from the directory. Until both lists have answered (or failed) the rows
  // would be drawn with stand-in names and then change, so they wait.
  const namesLoading = sessionsLoading || agentsLoading;
  // The view is built from the same readings every other screen draws: the
  // open requests and the failure causes read from each session's log, and
  // the sessions that could not be checked. Without them a failed session
  // under "Since you were last here" would say "The model returned nothing"
  // while its page says the provider rejected the key.
  const readings = useSessionReadings();
  const view = useMemo(
    () =>
      ops.report && !namesLoading
        ? buildOperationsView(ops.report, byId, sessions, readings.requests, Date.now(), readings.failures, readings.unknown)
        : null,
    [ops.report, byId, sessions, namesLoading, readings.requests, readings.failures, readings.unknown],
  );
  const attentionOps = { ...ops, isLoading: ops.isLoading || namesLoading } as typeof ops;
  const running = useMemo(() => runningSessions(sessions, view, byId, ops.attention), [sessions, view, byId, ops.attention]);
  // A session that could not be checked may be waiting on you, so it keeps
  // the bands up as a request does (Needs attention lists it).
  const waiting = view ? view.attention + view.unknown.length + view.budgets.filter((b) => b.warnings.length > 0).length : 0;
  const bandLoading = namesLoading || ops.isLoading;
  const allQuiet = !bandLoading && !ops.error && !ops.unsupported && running.length === 0 && waiting === 0;

  // While something is running, Home keeps up with it: the lists are read
  // again every quarter of a minute (each running row reads its own
  // activity every few seconds).
  const { refetch: refetchOps } = ops;
  const anyRunning = running.length > 0;
  useEffect(() => {
    if (!anyRunning) return;
    const id = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void refetchOps();
      void refetchSessions();
    }, 15_000);
    return () => window.clearInterval(id);
  }, [anyRunning, refetchOps, refetchSessions]);

  // ── what finished ───────────────────────────────────────────────────
  const finished = useMemo(
    () => finishedSessions({ sessions, view, report: ops.report?.sessions, agents: byId, since, causes: readings.failures }),
    [sessions, view, ops.report, byId, since, readings.failures],
  );

  // ── the last 30 days: the window and the numbers the Usage page shows ──
  const win = useMemo(() => usageWindow(WINDOW_DAYS), []);
  const usage = useApiQuery<UsageReport>("/v1/usage", win.params, { staleTime: 60_000 });
  const before = useApiQuery<UsageReport>("/v1/usage", win.previousParams, { staleTime: 5 * 60_000 });
  const totals = usage.data?.totals;
  const prev = before.data?.totals;
  const series = useMemo(() => {
    const cost = new Map<string, number>();
    const tokens = new Map<string, number>();
    for (const row of usage.data?.daily ?? []) {
      cost.set(row.day, (cost.get(row.day) ?? 0) + row.cost_usd);
      tokens.set(row.day, (tokens.get(row.day) ?? 0) + row.tokens);
    }
    // The report has no per-day session count; the directory's recent sessions do.
    const started = new Map<string, number>();
    for (const s of sessions) {
      const day = utcDayKey(s.created_at);
      started.set(day, (started.get(day) ?? 0) + 1);
    }
    // A trend needs something in it: a flat line under "$0.00" says nothing.
    const spark = (values: number[]) => (values.some((v) => v > 0) ? values : undefined);
    return {
      cost: spark(win.dayKeys.map((d) => cost.get(d) ?? 0)),
      tokens: spark(win.dayKeys.map((d) => tokens.get(d) ?? 0)),
      sessions: spark(win.dayKeys.map((d) => started.get(d) ?? 0)),
    };
  }, [usage.data, sessions, win]);
  const uncachedPrice = totals ? totals.cost_usd + totals.cache_savings_usd : 0;
  const savedShare = totals && uncachedPrice > 0 ? totals.cache_savings_usd / uncachedPrice : 0;
  const noUsage = !!totals && totals.calls === 0;
  // All three changes or none, as on Usage (one arrow beside two bare numbers reads as a mistake).
  const changes = totals ? periodChanges(totals, prev) : { comparable: false as const };

  return (
    <div className="relative">
      <Wash />

      {/* ── Hero: greeting + the session starter ──────────────────── */}
      <div className={`${PAGE_GUTTER} pt-[clamp(3rem,11vh,7rem)] pb-12`}>
        <div className="mx-auto w-full max-w-[760px]">
          <div className="animate-rise-in text-center">
            <h1 className="text-display text-balance text-fg">
              {greeting()}
              {name ? `, ${name}` : ""}
            </h1>
            <p className="mt-3 text-[1.0625rem] text-fg-muted">
              {firstRun && !workspaceActive
                ? `Welcome to ${BRAND_NAME}. Create your first agent, then give it something to do.`
                : "What should your agents work on?"}
            </p>
          </div>

          <div className="stagger mt-8 animate-rise-in" style={{ "--i": 1 } as React.CSSProperties}>
            <SessionStarter variant="home" initialAgentId={intent?.agentId} focusSignal={intent?.compose} />
          </div>
        </div>
      </div>

      {/* ── Below the fold ─────────────────────────────────────────── */}
      <div className={`${PAGE_GUTTER} pb-20`}>
        {/* A container: what sits side by side depends on the room the panel
            has, not on the window (the sidebar takes 272px of it). */}
        <div className={`${CONTENT} @container space-y-12`}>
          {(firstRun || showGuide) && <FirstRunGuide />}

          {!firstRun &&
            (allQuiet ? (
              <AllQuiet />
            ) : (
              <div className="grid gap-x-6 gap-y-12 @[880px]:grid-cols-2 @[880px]:items-start">
                <RunningNow running={running} loading={bandLoading} />
                <NeedsAttention ops={attentionOps} view={view} />
              </div>
            ))}

          {!firstRun && (
            <SinceLastVisit
              finished={finished}
              since={since}
              loading={sessionsLoading}
              error={sessionsError}
              retry={refetchSessions}
            />
          )}

          {/* The month's numbers */}
          {!noUsage && (
            <Section
              title={`Last ${WINDOW_DAYS} days`}
              description={
                changes.comparable ? `Estimated at API prices. Changes compare with the ${WINDOW_DAYS} days before.` : "Estimated at API prices."
              }
              action={
                <Link to="/usage" className={sectionLinkClass}>
                  Usage <ArrowRightIcon className="size-3.5" />
                </Link>
              }
            >
              {usage.error ? (
                <QueryProblem title="Usage could not be loaded" error={usage.error} retry={usage.refetch} />
              ) : (
                <div className="grid gap-4 @[480px]:grid-cols-2 @[860px]:grid-cols-4">
                  <StatTile
                    label="Estimated spend"
                    value={formatCost(totals?.cost_usd)}
                    delta={changes.cost}
                    hint={totals && totals.sessions > 0 ? `${formatCost(totals.cost_usd / totals.sessions)} per session on average` : "at API prices"}
                    spark={series.cost}
                    to="/usage"
                    loading={usage.isLoading}
                  />
                  <StatTile
                    label="Sessions"
                    value={(totals?.sessions ?? 0).toLocaleString()}
                    delta={changes.sessions}
                    hint="that used a model"
                    spark={series.sessions}
                    to="/sessions"
                    loading={usage.isLoading}
                  />
                  <StatTile
                    label="Tokens processed"
                    value={formatCompact(totals?.processed_tokens)}
                    delta={changes.tokens}
                    hint={`${formatCompact(totals?.calls)} model calls`}
                    spark={series.tokens}
                    to="/usage"
                    loading={usage.isLoading}
                  />
                  <StatTile
                    label="Saved by caching"
                    value={formatCost(totals?.cache_savings_usd)}
                    hint={uncachedPrice > 0 ? `${Math.round(savedShare * 100)}% off the uncached price` : "Nothing was read from the cache"}
                    footer={
                      uncachedPrice > 0 ? (
                        <ProportionBar
                          label="Share of the uncached price saved by caching"
                          parts={[
                            { label: "Saved", value: savedShare, color: "var(--chart-6)" },
                            { label: "Paid", value: 1 - savedShare, color: "var(--bg-pressed)" },
                          ]}
                        />
                      ) : undefined
                    }
                    to="/usage"
                    loading={usage.isLoading}
                  />
                </div>
              )}
            </Section>
          )}

          {/* Workspace counts + build from a coding agent */}
          <div className="space-y-4">
            <section className="surface rounded-xl px-5 py-4" aria-label="Workspace">
              {statsQuery.error ? (
                <QueryProblem
                  compact
                  title="Workspace summary could not be loaded"
                  error={statsQuery.error}
                  retry={statsQuery.refetch}
                />
              ) : (
                <div className="flex flex-col gap-4 @[860px]:flex-row @[860px]:items-center">
                  <div className="flex shrink-0 items-baseline justify-between gap-4 @[860px]:block @[860px]:w-44">
                    <h3 className="text-h3 text-fg">Workspace</h3>
                    {workspaceActive && !firstRun && (
                      <button
                        type="button"
                        onClick={() => setShowGuide((v) => !v)}
                        className={cn(quietLink, "mt-0.5 text-small font-normal")}
                      >
                        {showGuide ? "Hide setup guide" : "Show setup guide"}
                      </button>
                    )}
                  </div>
                  <dl className="-mx-3 grid flex-1 grid-cols-3 gap-x-2 gap-y-2 @[560px]:grid-cols-6 @[860px]:mx-0">
                    {(
                      [
                        ["Agents", stats?.agents, "/agents"],
                        ["Environments", stats?.environments, "/environments"],
                        ["Vaults", stats?.vaults, "/vaults"],
                        ["Skills", stats?.skills, "/skills"],
                        ["Models", stats?.model_cards, "/model-cards"],
                        ["API keys", stats?.api_keys, "/api-keys"],
                      ] as const
                    ).map(([label, value, to]) => (
                      <Link key={label} to={to} className="rounded-md px-3 py-2 transition-quick hover:bg-bg-hover">
                        <dd className="text-[1.25rem] leading-tight font-semibold tracking-tight text-fg">
                          {value === undefined ? <Skeleton className="my-0.5 h-6 w-7" rounded="sm" /> : value}
                        </dd>
                        <dt className="text-xs whitespace-nowrap text-fg-subtle">{label}</dt>
                      </Link>
                    ))}
                  </dl>
                </div>
              )}
            </section>

            <section className="surface flex flex-col gap-4 rounded-xl px-5 py-4 @[820px]:flex-row @[820px]:items-center">
              <div className="flex min-w-0 flex-1 items-center gap-4">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-[12px] bg-bg-soft text-fg-muted">
                  <TerminalIcon className="size-5 stroke-[1.75]" />
                </span>
                <div className="min-w-0 flex-1">
                  <h3 className="text-h3 text-fg">Build agents from your terminal</h3>
                  <p className="mt-0.5 text-small text-fg-muted">
                    Give Claude Code or Codex the agent-builder skill to create, configure and verify {BRAND_NAME} agents.
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => setShowSkill(true)}>
                  Preview
                </Button>
                <CopyAction label="Copy starter prompt" value={HARNESS_AGENT_BUILDER_PROMPT} variant="outline" />
                <CopyAction label="Copy skill" value={HARNESS_AGENT_BUILDER_SKILL} variant="outline" />
              </div>
            </section>
          </div>
        </div>
      </div>

      <Modal
        open={showSkill}
        onClose={() => setShowSkill(false)}
        title="Agent-builder skill"
        subtitle={`Paste it into your coding agent so it can create ${BRAND_NAME} agents, sign in through the CLI, route app OAuth, apply manifests and verify sessions.`}
        maxWidth="max-w-3xl"
        footer={
          <>
            <CopyAction label="Copy starter prompt" value={HARNESS_AGENT_BUILDER_PROMPT} variant="outline" />
            <CopyAction label="Copy full skill" value={HARNESS_AGENT_BUILDER_SKILL} />
          </>
        }
      >
        <pre className="max-h-[52vh] overflow-auto rounded-lg bg-bg-inset p-4 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-fg-muted">
          {HARNESS_AGENT_BUILDER_SKILL}
        </pre>
      </Modal>
    </div>
  );
}

function CopyAction({
  label,
  value,
  variant = "default",
}: {
  label: string;
  value: string;
  variant?: "default" | "outline";
}) {
  const { copied, copy } = useCopy();
  return (
    <Button variant={variant} size="sm" onClick={() => void copy(value)}>
      {copied ? <CheckIcon /> : <CopyIcon />}
      {copied ? "Copied" : label}
    </Button>
  );
}
