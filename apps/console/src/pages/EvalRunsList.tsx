import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { CircleXIcon, CopyIcon, DramaIcon, LinkIcon, RotateCwIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { PopoverContent } from "@/components/ui/popover";

import { ConfirmDialog } from "../components/ConfirmDialog";
import { DataTable, type ColumnDef } from "../components/DataTable";
import { EntityRef } from "../components/EntityRef";
import { FacetedFilter } from "../components/FacetedFilter";
import { FilterChip } from "../components/FilterChip";
import { Page } from "../components/Page";
import { PageHeader } from "../components/PageHeader";
import { ErrorState } from "../components/QueryProblem";
import { RelativeTime } from "../components/RelativeTime";
import { RowActionsMenu, type RowAction } from "../components/RowActionsMenu";
import { SegmentedControl } from "../components/SegmentedControl";
import { Tip } from "../components/Tip";
import { RUNS_KEY, SUITES_KEY, suiteHistory, useEvalRuns, useEvalSuites, type RunWithSummary } from "../components/evals/data";
import { RUN_KIND_ICON, TaskStrip, VerdictBadge } from "../components/evals/parts";
import { RunDialog, type RunTarget } from "../components/evals/RunDialog";
import { SuiteCard, SuiteSheet } from "../components/evals/Suites";
import { ResourceIdentity } from "../components/resources/ResourceBits";
import { useApi } from "../lib/api";
import { copyText } from "../lib/clipboard";
import { useAgents } from "../lib/directory";
import {
  percent,
  runName,
  runShape,
  runSummary,
  type EvalRun,
  type EvalSuiteSummary,
  type RunSummary,
} from "../lib/evals";
import { formatSpan, plural, toDate } from "../lib/format";
import { useQueryClient } from "../lib/useApiQuery";
import { NewEvalRunDialog } from "./evals/NewEvalRunDialog";
import { NewSimulationDialog } from "./evals/NewSimulationDialog";
import { useServerFeature } from "../lib/server-features";

/**
 * Evals: is each agent still doing its job?
 *
 * Two views of one page:
 *   Runs    every run, newest first, named for its suite (or for what it
 *           is: a simulation, a one-off). A row reads left to right as
 *           what ran, on which agent, how it went (pass rate, and one
 *           small bar per task), the verdict, how long it took, when.
 *   Suites  the saved sets of tasks, as cards: the last result of each,
 *           whether it moved, and a Run button.
 *
 * The two ways to start something new are in the header: "New eval run"
 * (the primary) and "New simulation".
 */

const SIMULATION_SUBTITLE = "Run your agents on saved tasks and simulated users. A judge model grades every attempt.";
const TASKS_SUBTITLE = "Run your agents on saved tasks. A judge model grades every attempt.";

type View = "runs" | "suites";
type StatusValue = "any" | "pending" | "running" | "completed" | "failed";

// The server filters on the state of a run, not on how it scored.
const STATUS_OPTIONS: { value: StatusValue; label: string }[] = [
  { value: "any", label: "All" },
  { value: "pending", label: "Queued" },
  { value: "running", label: "Running" },
  { value: "completed", label: "Finished" },
  { value: "failed", label: "Stopped by an error" },
];

/** The quiet line under a run's name: what it is made of, or why it stopped. */
function runCaption(run: EvalRun, summary: RunSummary): string {
  if (summary.verdict === "error" && run.error) return run.error;
  const shape = runShape(summary);
  if (summary.kind === "suite") return `Suite · ${shape}`;
  if (summary.kind === "comparison") {
    return `${run.comparison_role === "candidate" ? "Candidate" : "Baseline"} · ${shape}`;
  }
  const ids = run.tasks.map((t) => t.id);
  if (ids.length === 0) return shape;
  const listed = ids.slice(0, 2).join(", ") + (ids.length > 2 ? ` and ${ids.length - 2} more` : "");
  return `${shape} · ${listed}`;
}

function RunIdentity({ run, summary, agentName }: RunWithSummary & { agentName?: string }) {
  // On a narrow table the agent has no column of its own, so it leads the caption.
  const caption = [summary.verdict !== "error" && agentName, runCaption(run, summary)].filter(Boolean).join(" · ");
  // The mark says what kind of run it is: a suite, a simulation, a one-off.
  return <ResourceIdentity icon={RUN_KIND_ICON[summary.kind]} name={runName(run)} secondary={caption} />;
}

function RunResult({ run, summary }: RunWithSummary) {
  const { trials, taskCounts: c } = summary;
  if (summary.verdict === "queued") return <span className="text-fg-subtle">Waiting to start</span>;
  if (summary.verdict === "error") return <span className="text-fg-subtle">No result</span>;
  if (summary.verdict === "running") {
    return (
      <div className="min-w-0 leading-tight">
        <div className="flex items-center gap-3">
          <span className="font-medium text-fg tabular-nums">
            {c.total - c.active} of {c.total}
          </span>
          <TaskStrip summary={summary} size="sm" />
        </div>
        <div className="mt-1 truncate text-xs text-fg-subtle">{run.tasks.length === 1 ? "task" : "tasks"} finished</div>
      </div>
    );
  }
  if (summary.passRate === null) return <span className="text-fg-subtle">Not graded</span>;
  return (
    <div className="min-w-0 leading-tight">
      <div className="flex items-center gap-3">
        <span className="w-9 shrink-0 font-medium text-fg tabular-nums">{percent(summary.passRate)}</span>
        <TaskStrip summary={summary} size="sm" />
      </div>
      <div className="mt-1 truncate text-xs text-fg-subtle">
        {trials.passed} of {trials.graded} trials passed
      </div>
    </div>
  );
}

export function EvalRunsList() {
  const { api } = useApi();
  const queryClient = useQueryClient();
  const { agents, byId: agentsById } = useAgents();

  // The view and the open suite live in the URL, so both can be linked to.
  const [params, setParams] = useSearchParams();
  const view: View = params.get("view") === "suites" ? "suites" : "runs";
  const openSuiteId = params.get("suite");
  const patchParams = (patch: Record<string, string | null>) => {
    const sp = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) sp.delete(k);
      else sp.set(k, v);
    }
    setParams(sp, { replace: true });
  };

  // Filters map to the list endpoint's own query params, and live in the
  // address like the view, so a filtered list survives a reload and can be linked.
  const statusParam = params.get("status");
  const status: StatusValue = STATUS_OPTIONS.some((o) => o.value === statusParam && o.value !== "any") ? (statusParam as StatusValue) : "any";
  const agentId = params.get("agent_id") ?? "";
  const setStatus = (v: StatusValue) => patchParams({ status: v === "any" ? null : v });
  const setAgentId = (v: string) => patchParams({ agent_id: v || null });
  const filtered = status !== "any" || !!agentId;
  const clearFilters = () => patchParams({ status: null, agent_id: null });

  const { runs, isLoading, error, refetch } = useEvalRuns({ status: status === "any" ? undefined : status, agent_id: agentId || undefined });
  // Suite cards read their history from the unfiltered list (the same request when no filter is set).
  const all = useEvalRuns();
  const suitesQuery = useEvalSuites();
  const { suites } = suitesQuery;

  const rows = useMemo<RunWithSummary[]>(() => runs.map((run) => ({ run, summary: runSummary(run) })), [runs]);
  const history = useMemo(() => suiteHistory(all.runs), [all.runs]);
  const openSuite = openSuiteId ? (suites.find((s) => s.id === openSuiteId) ?? null) : null;

  const [showCreate, setShowCreate] = useState(false);
  const [showSimulation, setShowSimulation] = useState(false);
  // Simulations are offered only where the server can run them.
  const simulations = useServerFeature("simulations");
  const SUBTITLE = simulations ? SIMULATION_SUBTITLE : TASKS_SUBTITLE;
  const [runTarget, setRunTarget] = useState<RunTarget | null>(null);
  const [confirm, setConfirm] = useState<
    { kind: "cancel" | "delete"; run: EvalRun } | { kind: "suite"; suite: EvalSuiteSummary } | null
  >(null);

  const actionsFor = ({ run, summary }: RunWithSummary): RowAction[] => [
    {
      label: "Run again",
      icon: <RotateCwIcon />,
      disabled: run.tasks.length === 0 || summary.active,
      onSelect: () => setRunTarget({ kind: "rerun", run }),
    },
    { label: "Copy link", icon: <LinkIcon />, onSelect: () => void copyText(`${window.location.origin}/evals/${run.id}`) },
    { label: "Copy run id", icon: <CopyIcon />, onSelect: () => void copyText(run.id) },
    ...(summary.active
      ? [{ label: "Cancel run", icon: <CircleXIcon />, onSelect: () => setConfirm({ kind: "cancel", run }) }]
      : []),
    { label: "Delete", icon: <Trash2Icon />, destructive: true, onSelect: () => setConfirm({ kind: "delete", run }) },
  ];

  // On a table narrower than 1000px (a 1280 window with the sidebar open)
  // the list keeps what answers "how did it go": the agent moves into the
  // run's caption and the duration is left to the run page. It is the
  // table's own width that decides, so closing the sidebar brings both back.
  const columns = useMemo<ColumnDef<RunWithSummary>[]>(() => [
    {
      id: "run",
      accessorFn: (r) => runName(r.run),
      header: "Run",
      size: 290,
      minSize: 240,
      enableHiding: false,
      cell: ({ row, table }) => (
        <RunIdentity
          {...row.original}
          agentName={table.options.meta?.hiddenByWidth.has("agent") ? agentsById.get(row.original.run.agent_id)?.name : undefined}
        />
      ),
    },
    {
      id: "agent",
      header: "Agent",
      size: 230,
      meta: { hideBelow: 1000 },
      cell: ({ row }) => (
        <span className="flex min-w-0 items-center gap-2">
          <EntityRef kind="agent" id={row.original.run.agent_id} className="font-normal" />
          {row.original.run.agent_version !== undefined && (
            <Tip label={`Ran against version ${row.original.run.agent_version} of the agent`}>
              <span className="shrink-0 font-mono text-micro text-fg-subtle">v{row.original.run.agent_version}</span>
            </Tip>
          )}
        </span>
      ),
    },
    {
      id: "result",
      accessorFn: (r) => r.summary.passRate ?? undefined,
      header: "Result",
      size: 205,
      enableSorting: true,
      sortDescFirst: true,
      cell: ({ row }) => <RunResult {...row.original} />,
    },
    {
      id: "verdict",
      header: "Verdict",
      size: 135,
      enableHiding: false,
      cell: ({ row }) => <VerdictBadge verdict={row.original.summary.verdict} />,
    },
    {
      id: "duration",
      accessorFn: (r) => r.summary.durationSeconds ?? undefined,
      header: "Duration",
      size: 104,
      enableSorting: true,
      sortDescFirst: true,
      meta: { align: "right", hideBelow: 1000 },
      cell: ({ row }) =>
        row.original.summary.durationSeconds === null ? (
          <Tip label={row.original.summary.verdict === "queued" ? "It has not started yet" : "No end time was recorded"}>
            <span className="text-fg-faint">
              <span aria-hidden="true">—</span>
              <span className="sr-only">Not recorded</span>
            </span>
          </Tip>
        ) : (
          <span className="text-fg-muted tabular-nums">{formatSpan(row.original.summary.durationSeconds)}</span>
        ),
    },
    {
      id: "started",
      accessorFn: (r) => toDate(r.run.started_at ?? r.run.created_at)?.getTime(),
      header: "Started",
      size: 118,
      enableSorting: true,
      sortDescFirst: true,
      cell: ({ row }) => (
        <RelativeTime value={row.original.run.started_at ?? row.original.run.created_at} className="text-fg-muted" fallback="Not started" />
      ),
    },
    {
      id: "actions",
      header: "",
      size: 56,
      enableHiding: false,
      cell: ({ row }) => <RowActionsMenu label={`Actions for ${runName(row.original.run)}`} actions={actionsFor(row.original)} />,
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [agentsById]);

  const viewSwitch = (
    <SegmentedControl<View>
      label="Show"
      value={view}
      onChange={(v) => patchParams({ view: v === "runs" ? null : v, suite: null })}
      options={[
        { value: "runs", label: "Runs" },
        { value: "suites", label: "Suites" },
      ]}
    />
  );

  const agentOptions = useMemo(
    () => agents.map((a) => ({ value: a.id, label: a.archived_at ? `${a.name} (archived)` : a.name })),
    [agents],
  );

  const headerActions = simulations ? (
    <Button variant="outline" onClick={() => setShowSimulation(true)}>
      <DramaIcon data-icon="inline-start" />
      New simulation
    </Button>
  ) : undefined;

  const dialogs = (
    <>
      <NewEvalRunDialog open={showCreate} onClose={() => setShowCreate(false)} />
      {simulations && <NewSimulationDialog open={showSimulation} onClose={() => setShowSimulation(false)} />}
      <RunDialog target={runTarget} onClose={() => setRunTarget(null)} />
      <SuiteSheet
        suite={openSuite}
        history={openSuite ? history.get(openSuite.id) : undefined}
        onClose={() => patchParams({ suite: null })}
        onRun={(suite) => setRunTarget({ kind: "suite", suite })}
        onDelete={(suite) => setConfirm({ kind: "suite", suite })}
      />
      <ConfirmDialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        destructive={confirm?.kind !== "cancel"}
        title={
          confirm?.kind === "suite"
            ? `Delete ${confirm.suite.name}?`
            : confirm?.kind === "cancel"
              ? `Cancel this run of ${runName(confirm.run)}?`
              : confirm
                ? `Delete this run of ${runName(confirm.run)}?`
                : ""
        }
        body={
          confirm?.kind === "suite"
            ? `The suite and its ${plural(confirm.suite.task_count, "task")} are removed. Runs it already produced stay in the list. This cannot be undone.`
            : confirm?.kind === "cancel"
              ? "Trials that are still going are stopped, and the run is removed from the list. This cannot be undone."
              : "The run and its results are removed. The sessions its trials recorded are kept. This cannot be undone."
        }
        confirmLabel={confirm?.kind === "suite" ? "Delete suite" : confirm?.kind === "cancel" ? "Cancel run" : "Delete run"}
        cancelLabel={confirm?.kind === "cancel" ? "Keep running" : "Cancel"}
        onConfirm={async () => {
          if (!confirm) return;
          if (confirm.kind === "suite") {
            await api(`${SUITES_KEY}/${confirm.suite.id}`, { method: "DELETE" });
            toast.success(`Deleted ${confirm.suite.name}`);
            if (openSuiteId === confirm.suite.id) patchParams({ suite: null });
            void queryClient.invalidateQueries({ queryKey: [SUITES_KEY] });
            return;
          }
          // One endpoint does both: it stops a run that is still going, then removes it.
          await api(`${RUNS_KEY}/${confirm.run.id}`, { method: "DELETE" });
          void queryClient.invalidateQueries({ queryKey: [RUNS_KEY] });
        }}
      />
    </>
  );

  // ── Suites ─────────────────────────────────────────────────────────────
  if (view === "suites") {
    if (suitesQuery.error && !suitesQuery.unsupported && suites.length === 0) {
      return (
        <Page width="wide" header={<PageHeader title="Evals" subtitle={SUBTITLE} width="wide" actions={headerActions} toolbar={viewSwitch} />}>
          <ErrorState title="Suites could not be loaded" error={suitesQuery.error} retry={() => void suitesQuery.refetch()} />
          {dialogs}
        </Page>
      );
    }
    return (
      <DataTable<EvalSuiteSummary>
        title="Evals"
        subtitle={SUBTITLE}
        createLabel="+ New eval run"
        onCreate={() => setShowCreate(true)}
        headerActions={headerActions}
        filters={viewSwitch}
        summary={suitesQuery.isLoading || suites.length === 0 ? undefined : plural(suites.length, "suite")}
        layout="grid"
        gridClassName="grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
        columns={SUITE_COLUMNS}
        data={suites}
        loading={suitesQuery.isLoading}
        getRowId={(s) => s.id}
        renderCard={(suite, i) => (
          <SuiteCard
            key={suite.id}
            suite={suite}
            index={i}
            history={history.get(suite.id)}
            onOpen={() => patchParams({ suite: suite.id })}
            onRun={() => setRunTarget({ kind: "suite", suite })}
            onDelete={() => setConfirm({ kind: "suite", suite })}
          />
        )}
        emptyKind="eval"
        emptyTitle={suitesQuery.unsupported ? "Suites are not available on this server" : "No suites yet"}
        emptySubtitle={
          suitesQuery.unsupported
            ? "This server has nowhere to keep them. You can still start a run with its tasks written out."
            : simulations
              ? "A suite is a saved set of tasks you run again after every change, to see whether the agent got better or worse. Open a session that went well and choose Save as eval, or save the scenarios of a simulation."
              : "A suite is a saved set of tasks you run again after every change, to see whether the agent got better or worse. Open a session that went well and choose Save as eval."
        }
        emptyAction={
          suitesQuery.unsupported ? (
            <Button variant="outline" onClick={() => setShowCreate(true)}>
              New eval run
            </Button>
          ) : (
            <>
              <Button variant="outline" asChild>
                <Link to="/sessions">Choose a session</Link>
              </Button>
              {simulations && (
                <Button variant="ghost" onClick={() => setShowSimulation(true)}>
                  New simulation
                </Button>
              )}
            </>
          )
        }
      >
        {dialogs}
      </DataTable>
    );
  }

  // ── Runs ───────────────────────────────────────────────────────────────
  if (error && runs.length === 0) {
    return (
      <Page width="wide" header={<PageHeader title="Evals" subtitle={SUBTITLE} width="wide" actions={headerActions} toolbar={viewSwitch} />}>
        <ErrorState title="Eval runs could not be loaded" error={error} retry={() => void refetch()} />
        {dialogs}
      </Page>
    );
  }

  return (
    <DataTable<RunWithSummary>
      title="Evals"
      subtitle={SUBTITLE}
      createLabel="+ New eval run"
      onCreate={() => setShowCreate(true)}
      headerActions={headerActions}
      filters={
        <>
          {viewSwitch}
          <FilterChip
            label="Agent"
            active={!!agentId}
            display={agentId ? (agentsById.get(agentId)?.name ?? "1 agent") : undefined}
            onClear={() => setAgentId("")}
          >
            <PopoverContent align="start" sideOffset={6} collisionPadding={8} className="w-72 gap-0 p-0">
              <FacetedFilter options={agentOptions} value={agentId} onValueChange={setAgentId} searchPlaceholder="Agent" />
            </PopoverContent>
          </FilterChip>
          <FilterChip
            label="Status"
            active={status !== "any"}
            display={status === "any" ? undefined : STATUS_OPTIONS.find((o) => o.value === status)?.label}
            onClear={() => setStatus("any")}
          >
            <PopoverContent align="start" sideOffset={6} collisionPadding={8} className="w-56 gap-0 p-0">
              <FacetedFilter options={STATUS_OPTIONS} value={status} onValueChange={(v) => setStatus(v as StatusValue)} searchPlaceholder="Status" />
            </PopoverContent>
          </FilterChip>
        </>
      }
      summary={isLoading || rows.length === 0 ? undefined : plural(rows.length, "run")}
      columns={columns}
      data={rows}
      loading={isLoading}
      getRowId={(r) => r.run.id}
      rowHref={(r) => `/evals/${r.run.id}`}
      emptyKind="eval"
      emptyTitle={filtered ? "No runs match" : "No eval runs yet"}
      emptySubtitle={
        filtered ? (
          "Nothing matches the filters you chose."
        ) : (
          <>
            An eval gives your agent a set of tasks, runs each one a few times, and has a judge model grade every attempt, so
            you can tell whether a change made the agent better or worse. Runs can also be started over the API with{" "}
            <code className="rounded-sm bg-bg-soft px-1 py-0.5 font-mono text-xs text-fg">POST /v1/evals/runs</code>.
          </>
        )
      }
      filtered={filtered}
      emptyAction={
        filtered ? (
          <Button variant="outline" onClick={clearFilters}>
            Clear filters
          </Button>
        ) : (
          <>
            <Button onClick={() => setShowCreate(true)}>New eval run</Button>
            {simulations && (
              <Button variant="outline" onClick={() => setShowSimulation(true)}>
                New simulation
              </Button>
            )}
          </>
        )
      }
    >
      {dialogs}
    </DataTable>
  );
}

// The gallery draws cards; the table columns are never shown.
const SUITE_COLUMNS: ColumnDef<EvalSuiteSummary>[] = [{ id: "name", header: "Suite", accessorKey: "name" }];
