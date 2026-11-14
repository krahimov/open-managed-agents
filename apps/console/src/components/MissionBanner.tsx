import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { GoalIcon, SquareIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { quietLink } from "@/lib/links";

import { useApi } from "../lib/api";
import { rememberMissions } from "../lib/sessions";
import { StatusBadge } from "./Badge";
import { ConfirmDialog } from "./ConfirmDialog";
import { QueryProblem } from "./QueryProblem";
import { Skeleton } from "./Skeleton";
import { Tip } from "./Tip";
import { withReason } from "@/lib/failure-text";

/**
 * The run header of a session that belongs to a "run until done" mission
 * (session.metadata.mission_id). The session IS the run surface, so this
 * band carries the goal, how the run is going, what is left of its budget,
 * the other iterations, and the two ways to stop. Verdicts appear inline in
 * the conversation as MissionVerdictCard.
 *
 *   [goal] ● Running · Iterating until every check passes   Iteration 3 / 10   Time 42m / 2h   1 2 [3]   [Stop this turn] [End the run]
 *          Migrate every route file under src/routes to the new error handler,
 *          with the route tests and the type check green
 *
 * The goal is read in full, on up to two lines: it is what the run is for.
 *
 * Stopping has two scopes, and each button is named for its own. Both live
 * here, side by side, so they can be told apart (the session bar's own
 * "Stop" is not drawn for a run's session):
 *
 *   Stop this turn   interrupts the agent now. The run then checks the work
 *                    and, if a check fails, starts the next iteration.
 *   End the run      interrupts the iteration in flight and starts no more.
 */

interface MissionResponse {
  id: string;
  goal: string;
  status: "running" | "succeeded" | "stopped" | "budget_exhausted" | "stuck";
  iteration: number;
  budget: { max_iterations: number; wall_clock_minutes: number };
  created_at: number;
  updated_at: number | null;
  stopped_at: number | null;
  iterations: Array<{ session_id: string; iteration: number | null }>;
}

const STATUS: Record<MissionResponse["status"], { status: string; label: string; hint: string }> = {
  running: { status: "running", label: "Running", hint: "Iterating until every check passes" },
  succeeded: { status: "passed", label: "Goal verified", hint: "Every check passed" },
  stopped: { status: "terminated", label: "Stopped", hint: "Stopped by a person before the goal was verified" },
  budget_exhausted: { status: "failed", label: "Out of budget", hint: "The run used its iterations or its time before the checks passed" },
  stuck: { status: "failed", label: "Stuck", hint: "The run stopped making progress" },
};

function minutes(n: number): string {
  if (n < 60) return `${n}m`;
  const h = Math.floor(n / 60);
  return n % 60 ? `${h}h ${n % 60}m` : `${h}h`;
}

/** One budget: a label, "3 / 10", and a thin bar that warns as it runs out. */
function Budget({ label, value, max, format = String }: { label: string; value: number; max: number; format?: (n: number) => string }) {
  const ratio = max > 0 ? value / max : 0;
  return (
    <div className="w-[7.5rem] shrink-0">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-fg-subtle">{label}</span>
        <span className="text-fg tabular-nums">
          <span className="font-medium">{format(value)}</span>
          <span className="text-fg-subtle"> / {format(max)}</span>
        </span>
      </div>
      <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} className="mt-1.5 h-1 overflow-hidden rounded-full bg-bg-pressed">
        <div
          className={cn("h-full rounded-full", ratio >= 1 ? "bg-danger-solid" : ratio >= 0.8 ? "bg-warning-solid" : "bg-ink")}
          style={{ width: `${Math.min(Math.max(ratio, 0), 1) * 100}%` }}
        />
      </div>
    </div>
  );
}

export function MissionBanner({
  missionId,
  currentSessionId,
  turn,
}: {
  missionId: string;
  currentSessionId: string;
  /** The turn running in this session, when one is: the narrower of the two things that can be stopped. */
  turn?: { running: boolean; stopping: boolean; onStop: () => void };
}) {
  const { api } = useApi();
  const [confirm, setConfirm] = useState(false);
  // Read quietly: a failure is drawn here, in the band's own place, not as
  // a toast every five seconds.
  const missionQuery = useQuery<MissionResponse>({
    queryKey: ["mission", missionId],
    queryFn: ({ signal }) => api<MissionResponse>(`/v1/missions/${missionId}`, { signal, silentErrors: true }),
    refetchInterval: 5000,
    retry: 1,
  });
  const m = missionQuery.data;
  // The run's goal names its sessions everywhere a title is shown (lib/sessions.ts).
  useEffect(() => {
    if (m) rememberMissions([m]);
  }, [m]);
  // The first read's failure, held across the polls that follow it: a
  // query with no data goes back to "loading" each time it refetches, and
  // the band must not flicker between a skeleton and an error.
  const [fault, setFault] = useState<unknown>(null);
  useEffect(() => {
    if (missionQuery.isSuccess) setFault(null);
    else if (missionQuery.isError) setFault(missionQuery.error ?? new Error("The run could not be read"));
  }, [missionQuery.isSuccess, missionQuery.isError, missionQuery.error]);

  if (!m) {
    // The band keeps its place whatever happens: its shape while the run
    // loads, and a plain "could not be loaded" with a retry if the read
    // fails. A session that belongs to a run never looks like one that
    // does not.
    if (fault) {
      return (
        <QueryProblem
          compact
          className="min-h-[58px] px-3.5"
          title="This run could not be loaded"
          error={fault}
          retry={() => missionQuery.refetch()}
        />
      );
    }
    return <Skeleton className="h-[58px] w-full" rounded="lg" />;
  }

  // Terminal runs freeze the clock at their last transition: a mission that
  // finished in 31s must not read "903m / 30m" the next morning.
  const elapsedEnd = m.status === "running" ? Date.now() : (m.stopped_at ?? m.updated_at ?? Date.now());
  const elapsedMin = Math.max(0, Math.round((elapsedEnd - m.created_at) / 60000));
  const iterations = m.iterations.filter((i) => i.iteration !== null);
  const st = STATUS[m.status] ?? STATUS.stopped;

  return (
    <div className="flex min-h-[58px] flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-bg-soft py-2.5 pr-3 pl-3.5">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-bg-surface text-fg-muted shadow-[var(--shadow-xs)] dark:bg-bg-pressed">
        <GoalIcon className="size-4" />
      </span>
      <div className="min-w-0 flex-1 basis-72">
        <div className="flex min-w-0 items-center gap-2">
          {/* The session's title is the goal in a few words: the band says how the run stands, then the goal in full. */}
          <span className="shrink-0" aria-label={`The run: ${st.label}`}>
            <StatusBadge status={st.status} label={st.label} />
          </span>
          <span className="min-w-0 truncate text-xs text-fg-subtle" title={st.hint}>
            {st.hint}
          </span>
          {/* The last refresh failed: what is shown is the last reading, and says so. */}
          {missionQuery.isError && (
            <Tip label={withReason("The last refresh failed", missionQuery.error)}>
              <button
                type="button"
                onClick={() => void missionQuery.refetch()}
                className={cn(quietLink, "text-xs")}
              >
                Not updating · retry
              </button>
            </Tip>
          )}
        </div>
        {/* What the run is for, in full: two lines before it is cut, and then the whole of it on hover. */}
        <p className="mt-0.5 line-clamp-2 text-small font-medium text-pretty text-fg" title={m.goal}>
          {m.goal}
        </p>
      </div>

      <div className="hidden shrink-0 items-center gap-5 lg:flex">
        <Budget label="Iteration" value={m.iteration} max={m.budget.max_iterations} />
        <Budget label="Time" value={elapsedMin} max={m.budget.wall_clock_minutes} format={minutes} />
      </div>

      {iterations.length > 1 && (
        <nav aria-label="Iterations of this run" className="hidden shrink-0 items-center gap-0.5 rounded-full bg-bg-pressed/60 p-0.5 md:flex">
          {iterations.map((it) =>
            it.session_id === currentSessionId ? (
              <span
                key={it.session_id}
                aria-current="page"
                className="flex h-6 min-w-6 items-center justify-center rounded-full bg-bg-surface px-1.5 text-xs font-medium text-fg tabular-nums shadow-[var(--shadow-xs)] dark:bg-bg-pressed"
              >
                {it.iteration}
              </span>
            ) : (
              <Tip key={it.session_id} label={`Open iteration ${it.iteration}`}>
                <Link
                  to={`/sessions/${it.session_id}`}
                  className="flex h-6 min-w-6 items-center justify-center rounded-full px-1.5 text-xs text-fg-muted tabular-nums transition-quick hover:bg-bg-hover hover:text-fg"
                >
                  {it.iteration}
                </Link>
              </Tip>
            ),
          )}
        </nav>
      )}

      {m.status === "running" && (
        <div className="flex shrink-0 items-center gap-1.5">
          {turn?.running && (
            <Tip label="Interrupts the agent now. The run then checks the work and may start another iteration.">
              <Button variant="ghost" size="sm" onClick={turn.onStop} loading={turn.stopping} loadingLabel="Stopping…">
                <SquareIcon data-icon="inline-start" className="size-3! fill-current" />
                Stop this turn
              </Button>
            </Tip>
          )}
          <Tip label="Interrupts the iteration in flight and starts no more. Work already done is kept.">
            <Button variant="outline" size="sm" onClick={() => setConfirm(true)}>
              End the run
            </Button>
          </Tip>
        </div>
      )}

      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="End this run?"
        body="The iteration in flight is interrupted and no new iteration starts. The work done so far is kept. To interrupt only what the agent is doing now and let the run carry on, use Stop this turn instead."
        confirmLabel="End the run"
        onConfirm={async () => {
          await api(`/v1/missions/${m.id}/stop`, { method: "POST" });
          toast.success("Run ended");
          void missionQuery.refetch?.();
        }}
      />
    </div>
  );
}
