import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { ApiError, useApi } from "@/lib/api";
import { runSummary, type EvalRun, type EvalSuite, type EvalSuiteSummary, type EvalTrial, type RunSummary } from "@/lib/evals";
import { toDate } from "@/lib/format";
import type { Trajectory } from "@/lib/trajectory";
import { useApiQuery } from "@/lib/useApiQuery";

/**
 * Reads for the eval screens. All of them go through the normal API
 * client and TanStack Query, so the runs list, a run page and a suite
 * card that ask for the same thing share one request.
 *
 *   useEvalRuns(filters)   the runs list; polls every 5s while a run is active
 *   useEvalRun(id)         one run; polls every 5s until it finishes
 *   useEvalSuites()        saved suites; `unsupported` on a runtime without them
 *   useEvalSuite(id)       one suite with its tasks
 *   suiteHistory(runs)     runs grouped by the suite they came from, newest first
 *   useTrialTrajectory(t)  one trial's stored record: verdict, reasons, trace facts
 */

const isActive = (r: Pick<EvalRun, "status"> | undefined) => r?.status === "pending" || r?.status === "running";

export const RUNS_KEY = "/v1/evals/runs";
export const SUITES_KEY = "/v1/evals/suites";

export function useEvalRuns(filters?: { status?: string; agent_id?: string }, enabled = true) {
  const params = useMemo(
    () => ({
      limit: "100",
      ...(filters?.status ? { status: filters.status } : {}),
      ...(filters?.agent_id ? { agent_id: filters.agent_id } : {}),
    }),
    [filters?.status, filters?.agent_id],
  );
  const query = useApiQuery<{ data: EvalRun[] }>(RUNS_KEY, params, {
    enabled,
    refetchInterval: (q) => ((q.state.data as { data: EvalRun[] } | undefined)?.data.some(isActive) ? 5_000 : false),
  });
  const runs = query.data?.data ?? EMPTY_RUNS;
  return { ...query, runs };
}
const EMPTY_RUNS: EvalRun[] = [];

export function useEvalRun(id: string | undefined) {
  return useApiQuery<EvalRun>(id ? `${RUNS_KEY}/${id}` : null, undefined, {
    refetchInterval: (q) => (isActive(q.state.data as EvalRun | undefined) ? 5_000 : false),
  });
}

/**
 * Saved suites. A runtime with no store for them answers 501 (older ones
 * 404): that is a missing feature, not a failure, so the read is silent
 * and `unsupported` says so.
 */
export function useEvalSuites(enabled = true) {
  const { api } = useApi();
  const query = useQuery({
    // Same key shape as useApiQuery, so `invalidateQueries([SUITES_KEY])` reaches it.
    queryKey: [SUITES_KEY, {}],
    queryFn: ({ signal }) => api<{ data: EvalSuiteSummary[] }>(SUITES_KEY, { signal, silentErrors: true }),
    enabled,
    retry: false,
  });
  const suites = query.data?.data ?? EMPTY_SUITES;
  const unsupported = query.error instanceof ApiError && (query.error.status === 501 || query.error.status === 404);
  return { ...query, suites, unsupported };
}
const EMPTY_SUITES: EvalSuiteSummary[] = [];

export function useEvalSuite(id: string | null | undefined) {
  const { api } = useApi();
  return useQuery({
    queryKey: [`${SUITES_KEY}/${id}`, {}],
    queryFn: ({ signal }) => api<EvalSuite>(`${SUITES_KEY}/${id}`, { signal, silentErrors: true }),
    enabled: !!id,
    retry: false,
  });
}

export interface RunWithSummary {
  run: EvalRun;
  summary: RunSummary;
}

const startOf = (r: EvalRun) => toDate(r.started_at ?? r.created_at)?.getTime() ?? 0;

/** Runs that came from a suite, grouped by suite id, newest first. */
export function suiteHistory(runs: EvalRun[]): Map<string, RunWithSummary[]> {
  const map = new Map<string, RunWithSummary[]>();
  for (const run of [...runs].sort((a, b) => startOf(b) - startOf(a))) {
    if (!run.suite_id) continue;
    const list = map.get(run.suite_id) ?? [];
    list.push({ run, summary: runSummary(run) });
    map.set(run.suite_id, list);
  }
  return map;
}

/**
 * The change in pass rate between a run and the finished run of the same
 * suite before it, in percentage points. Null when there is nothing to
 * compare with.
 */
export function passRateChange(current: RunWithSummary, history: RunWithSummary[] | undefined) {
  // A run that is still going has a partial rate; comparing it would mislead.
  if (!history || current.summary.passRate === null || current.summary.active) return null;
  const at = startOf(current.run);
  const previous = history.find(
    (h) => h.run.id !== current.run.id && startOf(h.run) < at && !h.summary.active && h.summary.passRate !== null,
  );
  if (!previous || previous.summary.passRate === null) return null;
  const points = Math.round(current.summary.passRate * 100) - Math.round(previous.summary.passRate * 100);
  return { points, previous };
}

// ── Trajectories ────────────────────────────────────────────────────────

/**
 * The stored record of one trial: the judge's verdict with its reasons,
 * and the facts the platform extracted from the session. The eval's own
 * copy carries both; the session's rebuilt trajectory carries neither, so
 * it is only the fallback (older trials, or a runtime that keeps no copy).
 * Both reads are silent: a missing trajectory is a state the page draws.
 */
export function useTrialTrajectory(trial: Pick<EvalTrial, "trajectory_id" | "session_id"> | undefined, enabled = true) {
  const { api } = useApi();
  const trajectoryId = trial?.trajectory_id;
  const sessionId = trial?.session_id;
  return useQuery({
    queryKey: ["eval-trajectory", trajectoryId ?? null, sessionId ?? null],
    queryFn: async ({ signal }) => {
      if (trajectoryId) {
        try {
          return await api<Trajectory>(`/v1/evals/trajectories/${trajectoryId}`, { signal, silentErrors: true });
        } catch (e) {
          if (signal.aborted || !sessionId) throw e;
        }
      }
      return api<Trajectory>(`/v1/sessions/${sessionId}/trajectory`, { signal, silentErrors: true });
    },
    enabled: enabled && (!!trajectoryId || !!sessionId),
    retry: false,
    staleTime: 5 * 60_000,
  });
}
