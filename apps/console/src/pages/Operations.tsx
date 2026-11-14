/**
 * Operations: where a person unblocks agents.
 *
 *   headline tiles    waiting on you · failed work · running now · cost today
 *   tabs              Needs attention · Approvals (n) · Failed work (n) · Running (n) · Budgets
 *   the queue         what an agent is waiting on a person for first (approvals, then
 *                     requests for access or a skill), then failed work (a session is
 *                     blocked on a retry), then the quieter lists
 *   the rail          what is running right now and today's budgets, beside the queue
 *
 * Every session here is drawn from its one reading (lib/session-state.ts), so it
 * says what Home, the Sessions list and the session's own page say. "Running now"
 * counts each thing once (a run until done and its iteration's session are one
 * thing) and only live work: a session that reports as running and has gone
 * silent is listed under "Stalled", apart.
 *
 * One read, GET /v1/operations, refreshed every 15 seconds and shared with the
 * sidebar count and Home's attention strip. Sessions and agents are shown by
 * name; the page never prints an id.
 *
 * Only some servers keep this report (`useServerFeature("operations")`). On
 * one that does not, the page is never asked for it: it says the view is not
 * on this server and points to where the same things are (each session, and
 * the Sessions list's "Waiting on you").
 */

import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { CircleCheckBigIcon, RefreshCwIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Callout,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Page,
  PageHeader,
  RelativeTime,
  Section,
  SectionCard,
  Skeleton,
  StatTile,
  StatusDot,
  TabBar,
  Tip,
  useTabParam,
  type StatusTone,
  type TabItem,
} from "@/components/kit";
import { useOperationActions, type OperationActions } from "@/components/operations/actions";
import { buildOperationsView, groupBySession, type OperationsView } from "@/components/operations/model";
import {
  ApprovalCard,
  CountPill,
  EndedList,
  FailureCard,
  RequestList,
  SessionHeading,
  SetAsideList,
  UnknownList,
  WaitingList,
} from "@/components/operations/queue";
import { BudgetScopeCard, BudgetSummary, MissionList, NothingRunning, RunningList, StalledNote } from "@/components/operations/status";
import { useSessionReadings } from "@/components/sessions/readings";
import { sectionLinkClass } from "@/components/SectionCard";
import { ApiError, useApi } from "@/lib/api";
import { useAgents, useRecentSessions } from "@/lib/directory";
import { formatCompact, formatCost, plural } from "@/lib/format";
import type { OperationsReport, WorkspaceAccess } from "@/lib/operations";
import { useServerFeatures } from "@/lib/server-features";
import { useApiQuery } from "@/lib/useApiQuery";
import { cn } from "@/lib/utils";
import { inlineLink } from "@/lib/links";

type TabKey = "attention" | "approvals" | "failed" | "running" | "budgets";
const TAB_KEYS: ReadonlyArray<TabKey> = ["attention", "approvals", "failed", "running", "budgets"];

const SUBTITLE = "Approvals, failures and budgets that need a person.";
const FAILED_NOTE = "Later messages in the same session wait until a failed turn is retried or discarded.";

export function Operations() {
  const { api } = useApi();
  const [tab, setTab] = useTabParam<TabKey>("attention", TAB_KEYS);
  const features = useServerFeatures();
  const available = features.data?.features.has("operations") ?? false;
  const accessOn = features.data?.features.has("workspace_access") ?? false;
  const access = useApiQuery<WorkspaceAccess>(accessOn ? "/v1/workspace/access" : null);
  const query = useQuery({
    queryKey: ["/v1/operations"],
    queryFn: ({ signal }) => api<OperationsReport>("/v1/operations", { signal, silentErrors: true }),
    enabled: available,
    refetchInterval: 15_000,
    retry: false,
  });
  const { byId: agents } = useAgents();
  const { sessions: recent } = useRecentSessions();

  const report = query.data;
  const unsupported =
    (!features.isLoading && !available) || (query.error instanceof ApiError && query.error.status === 501);
  // A server without roles lets everyone who is signed in act (as its own
  // session page does); one with them says who may.
  const canOperate = features.data && !accessOn ? true : !!access.data?.authorization && access.data.authorization.role !== "viewer";

  const { refetch } = query;
  const refresh = useCallback(() => refetch(), [refetch]);
  const actions = useOperationActions({
    canOperate,
    accessKnown: (!!features.data && !accessOn) || !!access.data || !!access.error,
    stale: !!query.error,
    refresh,
  });

  // Requests for access or a skill, and why a turn failed in the session
  // page's words, are read from each session's log (no report carries them).
  const readings = useSessionReadings();
  const { requests: openRequests, failures: causes } = readings;
  const view = useMemo(
    () => (report ? buildOperationsView(report, agents, recent, openRequests, Date.now(), causes, readings.unknown) : null),
    [report, agents, recent, openRequests, causes, readings.unknown],
  );

  // The header's refresh spins for a refresh the person asked for, not for the 15s poll.
  const [refreshing, setRefreshing] = useState(false);
  const manualRefresh = () => {
    setRefreshing(true);
    void refetch().finally(() => setRefreshing(false));
  };

  const header = (
    <PageHeader
      width="wide"
      title="Operations"
      subtitle={SUBTITLE}
      actions={
        <>
          {report && !query.error && (
            <span className="hidden items-center gap-1.5 text-xs text-fg-subtle sm:flex">
              <StatusDot tone="success" live />
              <RelativeTime value={query.dataUpdatedAt} prefix="Updated" />
            </span>
          )}
          <Tip label="Refresh">
            <Button variant="ghost" size="icon" aria-label="Refresh operations" onClick={manualRefresh} disabled={refreshing}>
              <RefreshCwIcon className={cn(refreshing && "animate-spin")} />
            </Button>
          </Tip>
        </>
      }
    />
  );

  if (unsupported) {
    return (
      <Page header={header} width="wide">
        <EmptyState
          size="lg"
          title="Operations is not available on this server"
          body="Approvals and requests for access still appear in each session, and the Sessions list shows the ones waiting on you."
          action={
            <Button asChild>
              <Link to="/sessions?status=approval">Show sessions waiting on you</Link>
            </Button>
          }
        />
      </Page>
    );
  }

  if (query.error && !report) {
    return (
      <Page header={header} width="wide">
        <ErrorState title="Activity could not be loaded" error={query.error} retry={query.refetch} />
      </Page>
    );
  }

  if (!report || !view) {
    return (
      <Page header={header} width="wide">
        <p role="status" className="sr-only">
          Loading workspace activity
        </p>
        <OperationsSkeleton />
      </Page>
    );
  }

  const agentName = (id: string | undefined) => (id ? agents.get(id)?.name : undefined);
  const blocking = view.failures.filter((f) => f.status === "failed");
  const setAside = view.failures.filter((f) => f.status === "dead_letter");
  // Each thing once: a run and the session of its iteration are one piece of work.
  const runningCount = view.runningNow;
  const inRuns = view.running.filter((r) => r.mission).length + view.idleMissions.filter((m) => m.status === "running").length;
  const oldestRequest = view.requests.reduce<number | null>((oldest, r) => {
    const at = r.at == null ? null : new Date(r.at).getTime();
    return at != null && (oldest === null || at < oldest) ? at : oldest;
  }, null);
  const oldestApproval = view.approvals.reduce<string | number | null>((oldest, a) => {
    if (!a.requestedAt) return oldest;
    return oldest === null || new Date(a.requestedAt) < new Date(oldest) ? a.requestedAt : oldest;
  }, null);
  const latestFailure = view.failures.reduce<number>((latest, f) => Math.max(latest, Number(new Date(f.at ?? 0)) || 0), 0);

  const tabs: TabItem<TabKey>[] = [
    {
      value: "attention",
      label: <TabLabel text="Needs attention" count={view.attention} tone={view.waitingOnYou ? "warning" : "danger"} />,
    },
    { value: "approvals", label: <TabLabel text="Approvals" count={view.approvals.length} tone="warning" /> },
    { value: "failed", label: <TabLabel text="Failed work" count={view.failures.length} tone="danger" /> },
    { value: "running", label: <TabLabel text="Running" count={runningCount} tone="info" extra={view.stalled.length} /> },
    { value: "budgets", label: "Budgets" },
  ];

  const queueTab = tab === "attention" || tab === "approvals" || tab === "failed";

  return (
    <Page header={header} width="wide">
      <div className="space-y-6">
        {access.error && (
          <ErrorState compact title="Your action permissions could not be loaded" error={access.error} retry={access.refetch} />
        )}
        {query.error && (
          <Callout
            tone="warning"
            title="Showing the last successful response"
            action={
              <Button size="sm" variant="outline" onClick={manualRefresh} loading={refreshing}>
                Refresh
              </Button>
            }
          >
            The latest refresh failed, so actions are paused until it loads again. This is the workspace as of{" "}
            <RelativeTime value={query.dataUpdatedAt} fallback="the last load" />.
          </Callout>
        )}
        {access.data && !canOperate && (
          <Callout tone="neutral" title="You can review, but not act">
            Operator access is required to approve tools, retry work, or stop sessions.
          </Callout>
        )}

        {/* Headline numbers. Each opens the tab that explains it. */}
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatTile
            label="Waiting on you"
            value={view.waitingOnYou}
            hint={
              view.waitingOnYou > 0 ? (
                <TileHint tone="warning">
                  {view.requests.length === 0 ? (
                    oldestApproval ? <RelativeTime value={oldestApproval} prefix="Oldest asked" /> : "An agent is blocked"
                  ) : (
                    [
                      view.approvals.length > 0 ? plural(view.approvals.length, "approval") : "",
                      plural(view.waitingOnYou - view.approvals.length, "request"),
                    ]
                      .filter(Boolean)
                      .join(", ")
                  )}
                </TileHint>
              ) : view.unknown.length > 0 ? (
                // Not "No agent is blocked": nothing says these are not.
                `${plural(view.unknown.length, "session")} could not be checked`
              ) : (
                "No agent is blocked"
              )
            }
            to={view.approvals.length > 0 || view.requests.length === 0 ? "?tab=approvals" : "?tab=attention"}
          />
          <StatTile
            label="Failed work"
            value={view.failures.length}
            hint={
              view.failures.length > 0 ? (
                <TileHint tone="danger">
                  {latestFailure > 0 ? <RelativeTime value={latestFailure} prefix="Latest" /> : "Needs a retry"}
                </TileHint>
              ) : view.ended.length > 0 ? (
                `${plural(view.ended.length, "session")} ended on an error`
              ) : (
                "Nothing to retry"
              )
            }
            to="?tab=failed"
          />
          <StatTile
            label="Running now"
            value={runningCount}
            hint={
              runningCount > 0 ? (
                <TileHint tone="info" live>
                  {runningHint(view, inRuns)}
                </TileHint>
              ) : view.stalled.length > 0 ? (
                <TileHint tone="warning">{plural(view.stalled.length, "session")} stalled</TileHint>
              ) : (
                "No agent is working"
              )
            }
            to="?tab=running"
          />
          <StatTile
            label="Estimated cost today"
            value={formatCost(report.usage.totals.cost_usd)}
            hint={`${formatCompact(report.usage.totals.processed_tokens)} tokens, at API prices`}
            to="/usage"
          />
        </div>

        <TabBar
          label="Operations views"
          tabs={tabs}
          value={tab}
          onChange={setTab}
          trailing={
            tab === "budgets" ? (
              <Button variant="outline" size="sm" asChild>
                <Link to="/workspace">{view.budgets.some((b) => b.limited) ? "Edit limits" : "Set limits"}</Link>
              </Button>
            ) : undefined
          }
        />

        {report.truncated && tab !== "budgets" && (
          <Callout tone="neutral">
            This view covers the 100 most recent sessions and work items. Open{" "}
            <Link className={inlineLink} to="/sessions">
              Sessions
            </Link>{" "}
            or{" "}
            <Link className={inlineLink} to="/usage">
              Usage
            </Link>{" "}
            for more history.
          </Callout>
        )}

        {queueTab && (
          <div className="grid items-start gap-x-4 gap-y-8 xl:grid-cols-[minmax(0,1fr)_340px]">
            <div className="min-w-0 space-y-8">
              {tab === "attention" && (
                <AttentionQueue
                  view={view}
                  blocking={blocking}
                  setAside={setAside}
                  actions={actions}
                  retryUnknown={readings.retryRequests}
                  retryingUnknown={readings.requestsFetching}
                />
              )}
              {tab === "approvals" &&
                (view.approvals.length > 0 ? (
                  <ApprovalGroups view={view} actions={actions} />
                ) : (
                  <EmptyState
                    icon={<CircleCheckBigIcon />}
                    title="Nothing is waiting for approval"
                    body="No pending approvals in the loaded sessions."
                    action={
                      view.requests.length > 0 ? (
                        <Button variant="outline" onClick={() => setTab("attention")}>
                          {plural(view.waitingOnYou, "request")} for access or a skill {view.waitingOnYou === 1 ? "is" : "are"} waiting
                        </Button>
                      ) : undefined
                    }
                  />
                ))}
              {tab === "failed" &&
                (view.failures.length + view.ended.length > 0 ? (
                  <div className="space-y-8">
                    {blocking.length > 0 && (
                      <div>
                        <p className="mb-4 text-small text-fg-muted">{FAILED_NOTE}</p>
                        <FailureGroups entries={blocking} actions={actions} />
                      </div>
                    )}
                    <SetAsideList entries={setAside} actions={actions} />
                    <EndedList entries={view.ended} />
                  </div>
                ) : (
                  <EmptyState
                    icon={<CircleCheckBigIcon />}
                    title="No failed work"
                    body="When a turn fails, it is listed here with what went wrong and a way to retry it."
                  />
                ))}
            </div>

            <aside aria-label="Running now and budgets" className="grid items-start gap-4 sm:grid-cols-2 xl:grid-cols-1">
              <SectionCard
                flush
                title={
                  <span className="flex items-center gap-2">
                    Running now
                    {runningCount > 0 && <CountPill count={runningCount} tone="info" />}
                  </span>
                }
                actions={
                  runningCount > 0 || view.stalled.length > 0 || view.activeMissions.length > 0 || view.pastMissions.length > 0 ? (
                    <Link to="?tab=running" className={cn(sectionLinkClass, "-mr-2")}>
                      View all
                    </Link>
                  ) : undefined
                }
              >
                {runningCount === 0 && view.idleMissions.length === 0 && view.stalled.length === 0 ? (
                  <NothingRunning compact />
                ) : (
                  <div className="divide-y divide-border">
                    {runningCount === 0 && view.idleMissions.length === 0 && <NothingRunning compact />}
                    {view.running.length > 0 && <RunningList entries={view.running} actions={actions} compact />}
                    {/* A run whose iteration is at work is the session above; only runs between iterations are listed here. */}
                    {view.idleMissions.length > 0 && (
                      <MissionList missions={view.idleMissions} actions={actions} agentName={agentName} compact />
                    )}
                    {view.stalled.length > 0 && (
                      <div>
                        <StalledNote count={view.stalled.length} compact />
                        <RunningList entries={view.stalled} actions={actions} compact />
                      </div>
                    )}
                  </div>
                )}
              </SectionCard>
              <BudgetSummary budgets={view.budgets} />
            </aside>
          </div>
        )}

        {tab === "running" && (
          <div className="space-y-10">
            <Section title="Sessions at work" description="An agent is working in these right now. Stopping one interrupts it where it is.">
              {view.running.length > 0 ? (
                <SectionCard flush>
                  <RunningList entries={view.running} actions={actions} />
                </SectionCard>
              ) : (
                <NothingRunning />
              )}
            </Section>
            {view.stalled.length > 0 && (
              <Section
                title={
                  <span className="flex items-center gap-2.5">
                    Stalled
                    <CountPill count={view.stalled.length} tone="warning" className="h-[22px] min-w-[22px] text-xs font-semibold" />
                  </span>
                }
                description="These report as running or retrying and have recorded nothing for half an hour or more. One may be on a long job, or stuck: open it to check, or stop it to free the session."
              >
                <SectionCard flush>
                  <RunningList entries={view.stalled} actions={actions} />
                </SectionCard>
              </Section>
            )}
            <WaitingList entries={view.waiting} />
            {(view.activeMissions.length > 0 || view.pastMissions.length > 0) && (
              <Section
                title="Runs until done"
                description="Goals an agent keeps working toward, one iteration at a time, until every check passes or a budget runs out."
              >
                <div className="space-y-4">
                  {view.activeMissions.length > 0 && (
                    <SectionCard flush>
                      <MissionList missions={view.activeMissions} actions={actions} agentName={agentName} />
                    </SectionCard>
                  )}
                  {view.pastMissions.length > 0 && (
                    <SectionCard flush title="Finished" description="Runs that reached their goal, ran out of budget or were ended.">
                      <MissionList missions={view.pastMissions} actions={actions} agentName={agentName} />
                    </SectionCard>
                  )}
                </div>
              </Section>
            )}
          </div>
        )}

        {tab === "budgets" && (
          <div className="space-y-4">
            {view.budgets.map((entry) => (
              <BudgetScopeCard key={entry.scope.scope_id} entry={entry} />
            ))}
            {view.budgets.length === 0 && (
              <EmptyState title="No budgets yet" body="Set a daily cost, token or concurrency limit and it is tracked here." />
            )}
            <Callout tone="neutral" title="How limits are counted">
              Usage is counted per day from 00:00 UTC. Cost is an API-price estimate that includes subscription usage, and a model
              request already in flight can pass a limit before its usage is reported.
            </Callout>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={!!actions.pending}
        onClose={actions.closeConfirm}
        title={actions.pending?.title ?? ""}
        body={actions.pending?.body}
        confirmLabel={actions.pending?.confirmLabel}
        onConfirm={async () => {
          await actions.pending?.run();
        }}
      />
    </Page>
  );
}

/**
 * Tab text with its count: read as "Approvals (1)", drawn as a pill.
 * `extra` is a second, amber count beside it: sessions listed on the tab
 * that are not part of the first number (stalled ones on Running).
 */
function TabLabel({ text, count, tone, extra = 0 }: { text: string; count: number; tone: "warning" | "danger" | "info"; extra?: number }) {
  return (
    <>
      {`${text} `}
      <span className="sr-only">
        ({count}
        {extra > 0 ? `, and ${extra} stalled` : ""})
      </span>
      <CountPill count={count} tone={count > 0 ? tone : "neutral"} />
      {extra > 0 && (
        <Tip label={`${plural(extra, "session")} stalled`}>
          <span className="ml-1 inline-flex">
            <CountPill count={extra} tone="warning" />
          </span>
        </Tip>
      )}
    </>
  );
}

/** "3 sessions at work" · "3 sessions, 1 of them in a run until done" · "2 sessions, 1 retrying", then what is stalled (not in the number above it). */
function runningHint(view: OperationsView, inRuns: number): string {
  const sessions = view.running.length;
  const waitingRuns = view.idleMissions.filter((m) => m.status === "running").length;
  const retrying = view.running.filter((r) => r.retrying).length;
  const main =
    sessions === 0
      ? `${plural(waitingRuns, "run")} between iterations`
      : inRuns > 0
        ? sessions === inRuns
          ? `${plural(inRuns, "run")} until done at work`
          : `${plural(sessions, "session")}, ${inRuns} of them in a run until done`
        : retrying > 0
          ? `${plural(sessions, "session")}, ${retrying} retrying`
          : `${plural(sessions, "session")} at work`;
  return view.stalled.length > 0 ? `${main} · ${view.stalled.length} stalled` : main;
}

/** A tile's second line when it carries a state: a status dot and a few words. */
function TileHint({ tone, live, children }: { tone: StatusTone; live?: boolean; children: ReactNode }) {
  return (
    <span className="flex items-center gap-1.5">
      <StatusDot tone={tone} live={live} />
      {children}
    </span>
  );
}

/** A queue section: a heading with its count, then the cards. */
function QueueSection({
  title,
  count,
  tone,
  description,
  children,
}: {
  title: string;
  count: number;
  tone: "warning" | "danger";
  description?: string;
  children: ReactNode;
}) {
  return (
    <Section
      title={
        <span className="flex items-center gap-2.5">
          {title}
          <CountPill count={count} tone={tone} className="h-[22px] min-w-[22px] text-xs font-semibold" />
        </span>
      }
      description={description}
    >
      {children}
    </Section>
  );
}

function ApprovalGroups({ view, actions }: { view: OperationsView; actions: OperationActions }) {
  return (
    <div className="space-y-6">
      {groupBySession(view.approvals).map((group, i) => (
        <div key={group.session.id} className="stagger animate-rise-in" style={{ "--i": Math.min(i, 12) } as React.CSSProperties}>
          <SessionHeading session={group.session} className="mb-2" />
          <div className="space-y-2">
            {group.entries.map((entry) => (
              <ApprovalCard key={entry.key} entry={entry} actions={actions} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function FailureGroups({ entries, actions }: { entries: OperationsView["failures"]; actions: OperationActions }) {
  return (
    <div className="space-y-6">
      {groupBySession(entries).map((group, i) => (
        <div key={group.session.id} className="stagger animate-rise-in" style={{ "--i": Math.min(i, 12) } as React.CSSProperties}>
          <SessionHeading session={group.session} className="mb-2" />
          <div className="space-y-2">
            {group.entries.map((entry) => (
              <FailureCard key={entry.key} entry={entry} actions={actions} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Everything that is waiting on a person, most urgent first. */
function AttentionQueue({
  view,
  blocking,
  setAside,
  actions,
  retryUnknown,
  retryingUnknown,
}: {
  view: OperationsView;
  blocking: OperationsView["failures"];
  setAside: OperationsView["failures"];
  actions: OperationActions;
  retryUnknown: () => void;
  retryingUnknown?: boolean;
}) {
  const notices = view.budgets.filter((b) => b.warnings.length > 0 || b.blocked);
  // "Nothing needs you" is said only when nothing might: a session that could not be checked might.
  if (view.queueSize === 0 && view.unknown.length === 0) {
    return (
      <EmptyState
        icon={<CircleCheckBigIcon />}
        title="Nothing needs you right now"
        body="Approvals, requests for access or a skill, and failed work show up here, and in the sidebar count, the moment an agent is blocked."
      />
    );
  }
  return (
    <>
      {notices.length > 0 && (
        <div className="space-y-3">
          {notices.map((b) => (
            <Callout
              key={b.scope.scope_id}
              tone={b.blocked ? "danger" : "warning"}
              title={b.blocked ? `${b.label} budget reached: new work is waiting` : `${b.label} budget is close to its limit`}
              action={
                <Button size="sm" variant="outline" asChild>
                  <Link to="/workspace">Review limits</Link>
                </Button>
              }
            >
              <ul className="space-y-0.5">
                {b.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </Callout>
          ))}
        </div>
      )}
      {view.approvals.length > 0 && (
        <QueueSection
          title="Waiting for your approval"
          count={view.approvals.length}
          tone="warning"
        >
          <ApprovalGroups view={view} actions={actions} />
        </QueueSection>
      )}
      {view.requests.length > 0 && (
        <QueueSection
          title="Waiting for access or a skill"
          count={view.waitingOnYou - view.approvals.length}
          tone="warning"
          description="An agent asked for an app to be connected or a skill to be attached. Each is answered from its card in the session."
        >
          <RequestList entries={view.requests} />
        </QueueSection>
      )}
      <UnknownList entries={view.unknown} retry={retryUnknown} retrying={retryingUnknown} />
      {blocking.length > 0 && (
        <QueueSection
          title="Failed work"
          count={blocking.length}
          tone="danger"
          description={FAILED_NOTE}
        >
          <FailureGroups entries={blocking} actions={actions} />
        </QueueSection>
      )}
      <SetAsideList entries={setAside} actions={actions} />
      <EndedList entries={view.ended} />
      <WaitingList entries={view.waiting} />
    </>
  );
}

function OperationsSkeleton() {
  return (
    <div className="space-y-6" aria-hidden="true">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {["Waiting on you", "Failed work", "Running now", "Estimated cost today"].map((label) => (
          // The tile's own anatomy (label, value, one line), so nothing moves when the numbers land.
          <div key={label} className="surface rounded-xl p-5">
            <div className="text-small text-fg-muted">{label}</div>
            <Skeleton className="mt-2 h-7 w-14" rounded="md" />
            <Skeleton className="mt-2.5 h-3 w-28" rounded="sm" />
          </div>
        ))}
      </div>
      <div className="flex h-10 items-center gap-6 border-b border-border">
        {[112, 88, 96, 72, 60].map((w) => (
          <Skeleton key={w} className="h-3.5" rounded="sm" style={{ width: w }} />
        ))}
      </div>
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-6">
          {[0, 1].map((i) => (
            <div key={i}>
              <div className="mb-2 flex items-center gap-2.5">
                <Skeleton className="size-6" rounded="md" />
                <Skeleton className="h-3.5 w-64" rounded="sm" />
              </div>
              <div className="rounded-lg bg-bg-soft p-4">
                <div className="flex items-center gap-3">
                  <Skeleton className="size-7" rounded="md" />
                  <Skeleton className="h-3.5 w-72" rounded="sm" />
                </div>
                <Skeleton className="mt-4 h-10 w-full" rounded="md" />
                <div className="mt-4 flex gap-2">
                  <Skeleton className="h-8 w-28" rounded="full" />
                  <Skeleton className="h-8 w-16" rounded="full" />
                </div>
              </div>
            </div>
          ))}
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-1">
          {[0, 1].map((i) => (
            <div key={i} className="surface rounded-xl p-5">
              <Skeleton className="h-4 w-28" rounded="sm" />
              <div className="mt-5 space-y-3">
                <Skeleton className="h-3.5 w-full" rounded="sm" />
                <Skeleton className="h-3.5 w-3/5" rounded="sm" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
