import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArchiveIcon, BoxIcon, CodeXmlIcon, CopyIcon, FlaskConicalIcon, LinkIcon, SparklesIcon, Trash2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { linkHitArea } from "@/lib/links";

import { useApi } from "../lib/api";
import { copyText } from "../lib/clipboard";
import { useAgents, useEntityName } from "../lib/directory";
import { formatSpan, plural, toDate } from "../lib/format";
import { sessionSource, sessionTitle } from "../lib/sessions";
import { startSession } from "../lib/shell-events";
import { useApiQuery, useInfiniteApiQuery } from "../lib/useApiQuery";
import { AgentAvatar } from "../components/AgentAvatar";
import { Chip } from "../components/Badge";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { DataTable, RowLink, type ColumnDef, type DataTableSort } from "../components/DataTable";
import { EntityRef } from "../components/EntityRef";
import { FacetedFilter } from "../components/FacetedFilter";
import { CreatedFilterChip, FilterChip } from "../components/FilterChip";
import { GitHubIcon, LinearIcon, SlackIcon } from "../components/icons";
import { RelativeTime } from "../components/RelativeTime";
import { RowActionsMenu, type RowAction } from "../components/RowActionsMenu";
import { OverflowTip } from "../components/OverflowTip";
import { useMinuteClock } from "../components/sessions/hooks";
import { REQUEST_WINDOW, useSessionReadings } from "../components/sessions/readings";
import { SessionStatus } from "../components/sessions/SessionStatus";
import { Tip } from "../components/Tip";
import type { SessionRecord as Session } from "../types/session";

/**
 * Sessions: every conversation the workspace's agents have had.
 *
 * A row is a session by NAME: the agent's avatar, the title (or
 * "Conversation with <agent>"), who it is with and where it came from.
 * Then its state, where it ran, how long it took and when it was last
 * active. The id is one click away in the row menu.
 *
 * The state is the one reading every screen shows (lib/session-state.ts):
 * the server's status, raised to "Needs approval", "Needs access" or
 * "Needs a skill" while a person is waited on, to "Failed" after a failed
 * turn, and to "Stalled" when a session that claims to be working has gone
 * silent.
 *
 * The Status filter offers the states the Status column shows:
 *
 *   Running, Retrying, Idle, Ended   the server filters by lifecycle
 *     (`?status=`), across the whole list. A row the column reads
 *     differently (an idle session waiting for approval) is left out, so
 *     the filter and the column never disagree.
 *   Waiting on you, Failed, Stalled  are not lifecycle states. They are
 *     read from the operations report and the newest events of each
 *     session, and those cover the 100 most recently active sessions that
 *     are not archived, no more. On a server without the report, the
 *     sessions' own logs stand in for it (`useSessionReadings().report`):
 *     the same 100 recent sessions, and a failure is read only for those
 *     that have not ended. The sessions they name are fetched by id.
 *     The result says what it covers, in the summary and when it is empty:
 *     "none among the 100 most recently active" is not "none".
 *
 * Search, Agent and Archived are server-side query params. The order is
 * the server's (newest started first) until a column is sorted, and a
 * sort is always over the whole list: see <DataTable>.
 */

type Lifecycle = "idle" | "running" | "rescheduling" | "terminated";
/** `approval` (waiting on a person), `errored` and `stalled` are read, not stored: see `readSession`. */
type Derived = "approval" | "errored" | "stalled";
type StatusValue = "any" | Derived | Lifecycle;

// What matters to a person first, then the lifecycle.
const STATUS_OPTIONS: { value: StatusValue; label: string }[] = [
  { value: "any", label: "All" },
  { value: "approval", label: "Waiting on you" },
  { value: "errored", label: "Failed" },
  { value: "stalled", label: "Stalled" },
  { value: "running", label: "Running" },
  { value: "rescheduling", label: "Retrying" },
  { value: "idle", label: "Idle" },
  { value: "terminated", label: "Ended" },
];
const isStatus = (v: string | null): v is StatusValue => !!v && STATUS_OPTIONS.some((o) => o.value === v);
const isDerived = (v: StatusValue): v is Derived => v === "approval" || v === "errored" || v === "stalled";

/** `?sort=-activity` (descending) or `?sort=activity`. */
const SORTABLE = ["session", "duration", "activity"];
function parseSort(raw: string | null): DataTableSort | null {
  if (!raw) return null;
  const desc = raw.startsWith("-");
  const id = desc ? raw.slice(1) : raw;
  return SORTABLE.includes(id) ? { id, desc } : null;
}

const ARCHIVED_OPTIONS = [
  { value: "hide", label: "Hidden" },
  { value: "show", label: "Included" },
];

/**
 * How long the session ran: start to end for a session that ended, start
 * to its last activity otherwise. Null when nothing was recorded after it
 * started (the API then only knows how long ago it was created, which is
 * not a duration anyone asked for).
 */
function sessionSeconds(s: Session): number | null {
  const start = toDate(s.created_at)?.getTime();
  if (start == null) return null;
  if (s.status === "terminated" && typeof s.stats?.duration_seconds === "number") return s.stats.duration_seconds;
  const end = toDate(s.terminated_at ?? s.updated_at)?.getTime();
  if (end == null || end < start) return null;
  return (end - start) / 1000;
}

/** Where the session came from, as a small mark after the agent's name. Console sessions say nothing. */
function SourceMark({ session }: { session: Session }) {
  const source = sessionSource(session);
  const m = session.metadata ?? {};
  const wrap = (icon: ReactNode, label: string, tip?: string) => {
    const mark = (
      <span className="inline-flex min-w-0 items-center gap-1">
        {icon}
        <span className="truncate">{label}</span>
      </span>
    );
    return tip ? <Tip label={tip}>{mark}</Tip> : mark;
  };
  const icon = "size-3 shrink-0";
  if (source === "linear") {
    const linear = m.linear as { issueIdentifier?: string; issueId?: string } | undefined;
    const ident = linear?.issueIdentifier ?? linear?.issueId;
    return wrap(<LinearIcon className={icon} />, ident ? `Linear ${ident}` : "Linear", ident ? `Started from Linear issue ${ident}` : "Started from a Linear issue");
  }
  if (source === "slack") {
    const slack = m.slack as { channelId?: string } | undefined;
    return wrap(
      <SlackIcon className={icon} />,
      slack?.channelId?.startsWith("D") ? "Slack DM" : "Slack thread",
      "Started from a Slack message",
    );
  }
  if (source === "github") return wrap(<GitHubIcon className={icon} />, "GitHub", "Started from GitHub");
  if (source === "eval") {
    const ev = m.eval as { run_id?: string; task_id?: string } | undefined;
    const mark = wrap(<FlaskConicalIcon className={icon} />, ev?.task_id ? `Eval · ${ev.task_id}` : "Eval run", ev?.task_id ? `Started by an eval run, for the task ${ev.task_id}` : "Started by an eval run");
    return ev?.run_id ? (
      <Link
        to={`/evals/${ev.run_id}`}
        onClick={(e) => e.stopPropagation()}
        className={cn("inline-flex min-w-0 rounded-sm decoration-border-strong underline-offset-3 hover:text-fg hover:underline", linkHitArea)}
      >
        {mark}
      </Link>
    ) : (
      mark
    );
  }
  if (source === "setup") return wrap(<SparklesIcon className={icon} />, "Agent setup", "The agent's own setup conversation");
  if (source === "api") return wrap(<CodeXmlIcon className={icon} />, "API", "Started over the API");
  return null;
}

export function SessionsList() {
  const { api } = useApi();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const { agents, byId: agentsById } = useAgents();
  // The one reading of every session: the operations report plus the
  // newest events of the sessions that can still be answered.
  const readings = useSessionReadings();
  const { ops, read } = readings;
  // The operations report, or where the server has none, the stand-in the logs make.
  const report = readings.report;
  const fromLogs = readings.source === "logs";
  const now = useMinuteClock();
  /** Which filter value a row belongs under: the status its reading draws. */
  // A session whose requests could not be read is at rest on the server: it
  // stays under Idle (its row says "State unknown"), rather than vanish from
  // every filter but All.
  const statusOf = (s: { id: string; status?: string | null; updated_at?: string | number | null }): StatusValue => {
    const st = read(s, { now }).status;
    return st === "unknown" ? "idle" : st;
  };

  // ── `?new=1`, `&agent_id=` and `&environment_id=` are links that open
  //    the session starter with that choice made (the shell owns the dialog) ──
  useEffect(() => {
    if (searchParams.get("new") !== "1") return;
    startSession({
      agentId: searchParams.get("agent_id") || undefined,
      environmentId: searchParams.get("environment_id") || undefined,
    });
    const next = new URLSearchParams(searchParams);
    next.delete("new");
    next.delete("agent_id");
    next.delete("environment_id");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  // ── filters. `?agent_id=`, `?status=`, `?sort=`, `?q=` and `?archived=` deep-link into a
  // filtered, sorted list (an agent's "All sessions"). ──
  const [search, setSearch] = useState(() => searchParams.get("q") ?? "");
  const [filterAgent, setFilterAgent] = useState(() => (searchParams.get("new") === "1" ? "" : (searchParams.get("agent_id") ?? "")));
  const [status, setStatus] = useState<StatusValue>(() => {
    const s = searchParams.get("status");
    return isStatus(s) ? s : "any";
  });
  const [created, setCreated] = useState<{ after?: number; before?: number }>({});
  const [archived, setArchived] = useState<"hide" | "show">(() => (searchParams.get("archived") === "show" ? "show" : "hide"));
  const [sort, setSort] = useState<DataTableSort | null>(() => parseSort(searchParams.get("sort")));

  // Keep the linkable choices in the address bar.
  useEffect(() => {
    if (searchParams.get("new") === "1") return;
    const next = new URLSearchParams(searchParams);
    if (filterAgent) next.set("agent_id", filterAgent);
    else next.delete("agent_id");
    if (status !== "any") next.set("status", status);
    else next.delete("status");
    if (sort) next.set("sort", `${sort.desc ? "-" : ""}${sort.id}`);
    else next.delete("sort");
    if (search.trim()) next.set("q", search);
    else next.delete("q");
    if (archived === "show") next.set("archived", "show");
    else next.delete("archived");
    if (next.toString() !== searchParams.toString()) setSearchParams(next, { replace: true });
  }, [filterAgent, status, sort, search, archived]); // eslint-disable-line react-hooks/exhaustive-deps

  const derived = isDerived(status);
  const inRange = (s: Session) => {
    if (created.after === undefined && created.before === undefined) return true;
    const t = toDate(s.created_at)?.getTime();
    if (t == null) return true;
    return (created.after === undefined || t >= created.after) && (created.before === undefined || t < created.before);
  };

  // ── the paged list: every lifecycle filter is the server's ──
  const sessionsParams = useMemo(
    () => ({
      ...(filterAgent ? { agent_id: filterAgent } : {}),
      ...(status !== "any" && !isDerived(status) ? { status } : {}),
      ...(search ? { q: search } : {}),
      ...(created.after !== undefined ? { created_after: new Date(created.after).toISOString() } : {}),
      ...(created.before !== undefined ? { created_before: new Date(created.before).toISOString() } : {}),
      ...(archived === "show" ? { include_archived: "true" } : {}),
    }),
    [filterAgent, status, search, created.after, created.before, archived],
  );
  const paged = useInfiniteApiQuery<Session>("/v1/sessions", {
    // A sort reads the whole list first, so it asks for bigger pages.
    limit: sort ? 100 : 20,
    params: sessionsParams,
    enabled: !derived,
  });

  // ── the derived list: the sessions the operations report says need a
  // person, each read by id. Complete by construction. ──
  const derivedIds = useMemo(() => {
    if (!derived) return [];
    const ids = new Set<string>();
    for (const row of report?.sessions ?? []) {
      if (statusOf(row) === status) ids.add(row.id);
    }
    // A session can be waiting on a request without being in the report.
    if (status === "approval") for (const id of readings.requests.keys()) ids.add(id);
    return [...ids];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [derived, status, report, read, readings.requests, now]);
  const byId = useQueries({
    queries: derivedIds.map((id) => ({
      // The session page reads the same entry.
      queryKey: [`/v1/sessions/${id}`, {}],
      queryFn: ({ signal }: { signal: AbortSignal }) => api<Session>(`/v1/sessions/${id}`, { signal, quietNotFound: true }),
      staleTime: 20_000,
      retry: false,
    })),
  });
  // From the logs every derived state is in the same reads as the requests.
  const derivedLoading =
    derived && (ops.isLoading || ((status === "approval" || fromLogs) && readings.requestsLoading) || byId.some((q) => q.isLoading));
  const derivedError = derived ? (ops.error ?? (byId.length > 0 && byId.every((q) => q.error) ? byId[0].error : null)) : null;
  const derivedKey = byId.map((q) => q.dataUpdatedAt).join(",");
  const derivedSessions = useMemo(() => {
    if (!derived) return [];
    const q = search.trim().toLowerCase();
    return byId
      .map((query) => query.data)
      .filter((s): s is Session => !!s)
      // The report can be a moment older than the session: trust the row.
      .filter((s) => statusOf(s) === status)
      .filter((s) => !filterAgent || s.agent?.id === filterAgent)
      .filter((s) => !q || (s.title ?? "").toLowerCase().includes(q))
      .filter((s) => archived === "show" || !s.archived_at)
      .filter(inRange)
      // The server's order: newest started first.
      .sort((a, b) => (toDate(b.created_at)?.getTime() ?? 0) - (toDate(a.created_at)?.getTime() ?? 0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [derived, derivedKey, status, read, now, filterAgent, search, archived, created.after, created.before]);

  // Some runtimes ignore the created_* params, and a lifecycle filter must
  // not show a row the column words differently. Both are decided row by
  // row, so they hold on every page.
  const pagedSessions = useMemo(
    () =>
      paged.items.filter((s) => inRange(s) && (status === "any" || statusOf(s) === status)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [paged.items, created.after, created.before, status, read, now],
  );

  const sessions = derived ? derivedSessions : pagedSessions;
  const loading = derived ? derivedLoading : paged.isLoading;
  const hasMore = derived ? false : paged.hasMore;
  const loadError = derived ? derivedError : paged.error;
  const refreshSessions = () => {
    if (derived) {
      if (fromLogs) readings.retryRequests();
      else void ops.refetch();
      for (const q of byId) void q.refetch();
    } else paged.refresh();
  };

  // ── row actions ──
  const [confirm, setConfirm] = useState<{ kind: "archive" | "delete"; session: Session } | null>(null);
  const afterChange = () => {
    refreshSessions();
    // The sidebar's Recents and Home read the same collection.
    void queryClient.invalidateQueries({ queryKey: ["/v1/sessions"] });
    void queryClient.invalidateQueries({ queryKey: ["/v1/operations"] });
  };

  const actionsFor = (s: Session): RowAction[] => [
    { label: "Copy link", icon: <LinkIcon />, onSelect: () => void copyText(`${window.location.origin}/sessions/${s.id}`) },
    { label: "Copy session id", icon: <CopyIcon />, onSelect: () => void copyText(s.id) },
    {
      label: s.archived_at ? "Archived" : "Archive",
      icon: <ArchiveIcon />,
      disabled: !!s.archived_at,
      onSelect: () => setConfirm({ kind: "archive", session: s }),
    },
    { label: "Delete", icon: <Trash2Icon />, destructive: true, onSelect: () => setConfirm({ kind: "delete", session: s }) },
  ];

  const columns = useMemo<ColumnDef<Session>[]>(
    () => [
      {
        id: "session",
        accessorFn: (s) => sessionTitle(s),
        header: "Session",
        // The title is what a person scans for: it takes the room, and it
        // is the last thing to give it up on a narrow panel.
        size: 520,
        minSize: 240,
        enableHiding: false,
        enableSorting: true,
        cell: ({ row, table }) => {
          const s = row.original;
          const agentName = s.agent?.name ?? agentsById.get(s.agent?.id)?.name;
          // On a table too narrow for the Environment column, the
          // environment rides here instead, where there is a whole line.
          // (On a panel so narrow that the line has no room either, it is
          // left to the session's own page.)
          const meta = table.options.meta;
          const environmentHere = !!meta && meta.hiddenByWidth.has("environment") && meta.width >= 760;
          // On a panel too narrow for a Status column beside a whole title
          // (1024 wide), the column's room goes to the title and the state
          // is said here, at the head of the second line.
          const statusHere = !!meta && meta.hiddenByWidth.has("status");
          return (
            <div className="flex min-w-0 items-center gap-3">
              <AgentAvatar name={agentName} id={s.agent?.id} size="md" archived={!!s.archived_at} />
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  {/* A title takes a second line before it is cut. */}
                  <RowLink className={cn("line-clamp-2 font-medium text-pretty whitespace-normal", s.archived_at ? "text-fg-muted" : "text-fg")}>
                    {sessionTitle(s)}
                  </RowLink>
                  {s.archived_at && <Chip className="shrink-0">Archived</Chip>}
                </div>
                <div className="flex min-w-0 items-center gap-1.5 text-xs text-fg-subtle">
                  {statusHere && (
                    <>
                      <SessionStatus reading={read(s, { now })} className="text-xs" />
                      {DOT}
                    </>
                  )}
                  <span className={cn(statusHere ? "min-w-0 truncate" : "shrink-0")}>{agentName ?? "Unknown agent"}</span>
                  <SourceSuffix session={s} />
                  {environmentHere && <EnvironmentSuffix id={s.environment_id} />}
                </div>
              </div>
            </div>
          );
        },
      },
      {
        id: "status",
        accessorFn: (s) => s.status ?? "idle",
        header: "Status",
        size: 150,
        // Below this the title needs the room more than a column does: the
        // state moves under the title (see the Session cell).
        meta: { hideBelow: 760 },
        cell: ({ row }) => <SessionStatus reading={read(row.original, { now })} />,
      },
      {
        id: "environment",
        accessorFn: (s) => s.environment_id,
        header: "Environment",
        size: 300,
        // A handful of names repeated down the list. It gets a column
        // only where one fits beside a whole title; below that it moves
        // under the title (see the Session cell).
        meta: { hideBelow: 1220 },
        cell: ({ row }) =>
          row.original.environment_id === "env_local_runtime" ? (
            <span className="text-fg-muted">Local runtime</span>
          ) : (
            <EntityRef kind="environment" id={row.original.environment_id} avatar={false} className="font-normal text-fg-muted" />
          ),
      },
      {
        id: "duration",
        accessorFn: (s) => sessionSeconds(s) ?? undefined,
        header: "Duration",
        size: 100,
        enableSorting: true,
        sortDescFirst: true,
        meta: { align: "right" },
        cell: ({ row }) => {
          const seconds = sessionSeconds(row.original);
          if (seconds == null) {
            return (
              <Tip label="Nothing was recorded after this session started">
                <span className="text-fg-faint">
                  <span aria-hidden="true">–</span>
                  <span className="sr-only">Not recorded</span>
                </span>
              </Tip>
            );
          }
          return <span className="text-fg-muted tabular-nums">{seconds < 1 ? "<1s" : formatSpan(seconds)}</span>;
        },
      },
      {
        id: "activity",
        accessorFn: (s) => toDate(s.updated_at || s.created_at)?.getTime(),
        header: "Last activity",
        size: 124,
        enableSorting: true,
        sortDescFirst: true,
        cell: ({ row }) => <RelativeTime value={row.original.updated_at || row.original.created_at} className="text-fg-muted" />,
      },
      {
        id: "actions",
        header: "",
        size: 56,
        enableHiding: false,
        cell: ({ row }) => <RowActionsMenu label={`Actions for ${sessionTitle(row.original)}`} actions={actionsFor(row.original)} />,
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agentsById, read, now],
  );

  // ── filter chips ──
  const agentOptions = useMemo(
    () =>
      agents.map((a) => ({
        value: a.id,
        label: a.archived_at ? `${a.name} (archived)` : a.name,
      })),
    [agents],
  );
  // The derived states are read on every server: from the operations
  // report, or from the sessions' own logs where there is none.
  const statusOptions = STATUS_OPTIONS;
  const agentDisplay = filterAgent ? (agentsById.get(filterAgent)?.name ?? "1 agent") : undefined;
  const statusDisplay = status === "any" ? undefined : STATUS_OPTIONS.find((o) => o.value === status)?.label;
  const filtered =
    !!search || !!filterAgent || status !== "any" || created.after !== undefined || created.before !== undefined;
  const clearFilters = () => {
    setSearch("");
    setFilterAgent("");
    setStatus("any");
    setCreated({});
  };

  const filters = (
    <>
      <FilterChip label="Agent" active={!!filterAgent} display={agentDisplay} onClear={() => setFilterAgent("")}>
        <PopoverContent align="start" sideOffset={6} collisionPadding={8} className="w-72 gap-0 p-0">
          <FacetedFilter options={agentOptions} value={filterAgent} onValueChange={setFilterAgent} searchPlaceholder="Agent" />
        </PopoverContent>
      </FilterChip>

      <FilterChip label="Status" active={status !== "any"} display={statusDisplay} onClear={() => setStatus("any")}>
        <PopoverContent align="start" sideOffset={6} collisionPadding={8} className="w-52 gap-0 p-0">
          <FacetedFilter options={statusOptions} value={status} onValueChange={(v) => setStatus(v as StatusValue)} searchPlaceholder="Status" />
        </PopoverContent>
      </FilterChip>

      <CreatedFilterChip label="Started" value={created} onChange={setCreated} />

      <FilterChip
        label="Archived"
        active={archived === "show"}
        display={archived === "show" ? "Included" : undefined}
        onClear={() => setArchived("hide")}
      >
        <PopoverContent align="start" sideOffset={6} collisionPadding={8} className="w-48 gap-0 p-0">
          <FacetedFilter
            options={ARCHIVED_OPTIONS}
            value={archived}
            onValueChange={(v) => setArchived(v === "show" ? "show" : "hide")}
            searchPlaceholder="Archived sessions"
          />
        </PopoverContent>
      </FilterChip>
    </>
  );

  const failed = !!loadError && sessions.length === 0;

  // How many sessions there are, exactly. The list loads a page at a time,
  // so while more remain the count comes from one wider read of the same
  // filters (the unfiltered one is the read the sidebar already made).
  const counting = useApiQuery<{ data: Session[]; next_cursor?: string | null; next_page?: string | null }>(
    !derived && paged.hasMore ? "/v1/sessions" : null,
    useMemo(() => ({ ...sessionsParams, limit: "100" }), [sessionsParams]),
    { staleTime: 20_000 },
  );
  const total = (() => {
    if (derived || !hasMore) return { n: sessions.length, more: false };
    const page = counting.data;
    if (!page) return null;
    // Counted row by row, as the list is, so the two can never disagree.
    const n = page.data.filter((s) => inRange(s) && (status === "any" || statusOf(s) === status)).length;
    return { n: Math.max(n, sessions.length), more: !!(page.next_cursor ?? page.next_page) };
  })();

  // What a derived filter can see: the report and the request reader cover
  // the most recently active sessions that are not archived, and no others.
  const partial = derived && (!!report?.truncated || archived === "show");
  const coverage = !derived
    ? null
    : report?.truncated
      ? `the ${REQUEST_WINDOW} most recently active sessions${archived === "show" ? ", archived ones excluded" : ""}`
      : archived === "show"
        ? "sessions that are not archived"
        : null;
  const derivedName = status === "approval" ? "Waiting on you" : status === "errored" ? "Failed" : "Stalled";

  // The count, and a nudge when someone is being waited on.
  const waiting = readings.counts.waiting;
  const summary = loading || failed || sessions.length === 0 ? undefined : (
    <span className="inline-flex items-center gap-2">
      {waiting > 0 && !filtered && (
        <Tip label={`${waitingWords(readings.counts.approvals, readings.counts.requests)}. Show the sessions.`}>
          <button
            type="button"
            onClick={() => setStatus("approval")}
            className="inline-flex items-center gap-1.5 rounded-full bg-warning-subtle px-2 py-0.5 text-xs font-medium text-warning transition-quick hover:brightness-95 dark:hover:brightness-110"
          >
            <span aria-hidden="true" className="size-1.5 rounded-full bg-warning-solid" />
            {waiting} waiting on you
          </button>
        </Tip>
      )}
      {readings.counts.unknown > 0 && !filtered && (
        // Not counted as waiting, and not left out in silence either.
        <Tip label={`${plural(readings.counts.unknown, "session")} could not be checked for access or skill requests, so ${readings.counts.unknown === 1 ? "it is" : "they are"} not counted as waiting. Try again.`}>
          <button
            type="button"
            onClick={readings.retryRequests}
            className="inline-flex items-center gap-1.5 rounded-full bg-bg-soft px-2 py-0.5 text-xs font-medium text-fg-muted transition-quick hover:bg-bg-hover hover:text-fg"
          >
            <span aria-hidden="true" className="size-1.5 rounded-full bg-fg-faint" />
            {readings.counts.unknown} not checked
          </button>
        </Tip>
      )}
      {coverage ? (
        // Said in the open, not in a tooltip: this is not a count of every session.
        <span>
          {plural(sessions.length, "session")} <span className="text-fg-subtle">among {coverage}</span>
        </span>
      ) : total ? (
        <span>{total.more ? `More than ${total.n} sessions` : plural(total.n, "session")}</span>
      ) : null}
    </span>
  );

  return (
    <DataTable<Session>
      title="Sessions"
      subtitle="Every conversation your agents have had."
      createLabel="+ New session"
      onCreate={() => startSession()}
      searchPlaceholder="Search sessions"
      searchValue={search}
      onSearchChange={setSearch}
      filters={filters}
      summary={summary}
      data={sessions}
      loading={loading}
      getRowId={(s) => s.id}
      rowHref={(s) => `/sessions/${s.id}`}
      sort={sort}
      onSortChange={setSort}
      hasMore={hasMore}
      loadingMore={paged.isLoadingMore}
      onLoadMore={paged.loadMore}
      // A failed read is said as a failure, never as "no sessions".
      error={loadError}
      onRetry={refreshSessions}
      emptyKind="session"
      emptyTitle={
        derived
          ? `${status === "approval" ? "Nothing is waiting on you" : status === "errored" ? "No failed sessions" : "No stalled sessions"}${
              partial && report?.truncated ? `, among the ${REQUEST_WINDOW} most recently active` : ""
            }`
          : filtered
            ? "No sessions match"
            : "No sessions yet"
      }
      emptySubtitle={
        derived
          ? `${
              search || filterAgent || created.after !== undefined || created.before !== undefined
                ? "None with these filters. Widen them to see the rest."
                : status === "approval"
                  ? "A session is listed here while an agent waits for you to approve a tool call, connect an app or attach a skill."
                  : status === "errored"
                    ? "Sessions whose last turn failed are listed here."
                    : "A session is listed here when it reports as running or retrying and has recorded nothing for half an hour."
            } ${
              // What was looked at, so "none" is never read as more than it is.
              report?.truncated
                ? `${derivedName} is read from the ${REQUEST_WINDOW} most recently active sessions${archived === "show" ? " that are not archived" : ""}: older ones are not checked. Search by title or filter by agent to find one of those.`
                : archived === "show"
                  ? `${derivedName} is not read for archived sessions: every other session was checked.`
                  : fromLogs && status === "errored"
                    ? "Every session that is not archived and has not ended was checked."
                    : "Every session that is not archived was checked."
            }`
          : filtered
            ? emptyFilteredSubtitle({ search, status, narrowed: !!filterAgent || created.after !== undefined || created.before !== undefined })
            : "A session is one conversation with an agent. Start one from Home, or let a trigger, Slack or the API start them for you."
      }
      filtered={filtered}
      emptyAction={
        filtered ? (
          <Button variant="outline" onClick={clearFilters}>
            Clear filters
          </Button>
        ) : (
          <Button onClick={() => startSession()} aria-label="Start a session">
            New session
          </Button>
        )
      }
      columns={columns}
    >
      <ConfirmDialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        destructive={confirm?.kind === "delete"}
        title={confirm?.kind === "delete" ? "Delete this session?" : "Archive this session?"}
        body={
          confirm
            ? confirm.kind === "delete"
              ? `“${sessionTitle(confirm.session)}” and its whole history are removed. This cannot be undone.`
              : `“${sessionTitle(confirm.session)}” moves out of this list. Its history is kept, and you can still open it from a link.`
            : undefined
        }
        confirmLabel={confirm?.kind === "delete" ? "Delete session" : "Archive session"}
        onConfirm={async () => {
          if (!confirm) return;
          if (confirm.kind === "delete") {
            await api(`/v1/sessions/${confirm.session.id}`, { method: "DELETE" });
            toast.success("Session deleted");
          } else {
            await api(`/v1/sessions/${confirm.session.id}/archive`, { method: "POST", body: "{}" });
            toast.success("Session archived");
          }
          afterChange();
        }}
      />
    </DataTable>
  );
}

/**
 * Why a filtered list is empty, in terms of what was actually chosen: a
 * title is mentioned only when one was typed. Pure, for tests.
 */
export function emptyFilteredSubtitle({ search, status, narrowed }: { search: string; status: string; narrowed: boolean }): string {
  if (search.trim()) return "Try a different title, or widen the filters.";
  const lifecycle: Record<string, [string, string]> = {
    running: ["No session is running", "right now"],
    rescheduling: ["No session is retrying after a failure", "right now"],
    idle: ["No session is idle", "right now"],
    terminated: ["No session has ended", "yet"],
  };
  const none = lifecycle[status];
  if (none) return narrowed ? `${none[0]} with these filters. Widen them to see the rest.` : `${none[0]} ${none[1]}.`;
  return "None with these filters. Widen them to see the rest.";
}

/** "1 approval and 2 requests are waiting" */
function waitingWords(approvals: number, requests: number): string {
  const parts = [approvals > 0 ? plural(approvals, "approval") : "", requests > 0 ? plural(requests, "request") : ""].filter(Boolean);
  const n = approvals + requests;
  return `${parts.join(" and ")} ${n === 1 ? "is" : "are"} waiting on you`;
}

const DOT = (
  <span aria-hidden="true" className="shrink-0 text-fg-faint">
    ·
  </span>
);

/** " · Linear SUP-482" after the agent's name; nothing for a console session. */
function SourceSuffix({ session }: { session: Session }) {
  if (sessionSource(session) === "console") return null;
  return (
    <>
      {DOT}
      {/* Gives way after the environment does, and ends in an ellipsis rather than a hard edge. */}
      <span className="inline-flex min-w-0">
        <SourceMark session={session} />
      </span>
    </>
  );
}

/**
 * " · ▫ Cloud sandbox" after the source, while the Environment column is
 * dropped. Plain text, not a second link in the row; it is the first
 * thing on the line to give way, and when it is cut the whole name can be
 * read on hover and on keyboard focus.
 */
function EnvironmentSuffix({ id }: { id: string }) {
  const local = id === "env_local_runtime";
  const { name, isLoading } = useEntityName("environment", local ? null : id);
  if (!local && isLoading) return null;
  const label = local ? "Local runtime" : (name ?? "Deleted environment");
  return (
    <>
      {DOT}
      <OverflowTip label={label} focusable>
        <span data-truncate="" className="min-w-0 shrink-[1000] truncate rounded-sm">
          <BoxIcon aria-hidden="true" className="mr-1 inline size-3 align-[-1.5px]" />
          <span className="sr-only">Runs in </span>
          {label}
        </span>
      </OverflowTip>
    </>
  );
}
