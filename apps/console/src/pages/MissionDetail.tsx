import { useState } from "react";
import { Link, useParams } from "react-router";
import { useApi } from "../lib/api";
import { useApiQuery, useQueryClient } from "../lib/useApiQuery";
import { Button } from "@/components/ui/button";
import type { MissionDetailRecord } from "../types/mission";
import { missionStatusCls } from "../types/mission";

function sessionStatusCls(s: string): string {
  switch (s) {
    case "idle": return "bg-success-subtle text-success";
    case "running": return "bg-info-subtle text-info";
    default: return "bg-bg-surface text-fg-muted";
  }
}

function elapsedStr(fromMs: number, toMs: number): string {
  const sec = Math.max(0, Math.round((toMs - fromMs) / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

/** Thin budget meter — used for both the iteration and wall-clock gauges. */
function BudgetMeter({ label, used, max, detail }: {
  label: string;
  used: number;
  max: number;
  detail: string;
}) {
  const pct = Math.min(100, Math.round((used / Math.max(1, max)) * 100));
  return (
    <div className="min-w-44">
      <div className="flex items-center justify-between text-xs mb-1">
        <span className="text-fg-muted">{label}</span>
        <span className="text-fg font-mono">{detail}</span>
      </div>
      <div className="h-1.5 rounded-full bg-bg-surface overflow-hidden">
        <div
          className={`h-full rounded-full ${pct >= 100 ? "bg-warning" : "bg-brand"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export function MissionDetail() {
  const { id } = useParams<{ id: string }>();
  const { api } = useApi();
  const queryClient = useQueryClient();
  const [stopping, setStopping] = useState(false);

  // Poll while the mission is running — the supervisor advances it
  // server-side every ~15s; 5s keeps the verdict panel and iterations
  // list live without hand-rolled timers.
  const { data: mission, isLoading, error: queryError } = useApiQuery<MissionDetailRecord>(
    id ? `/v1/missions/${id}` : null,
    undefined,
    {
      refetchInterval: (query) => {
        const m = query.state.data as MissionDetailRecord | undefined;
        return m?.status === "running" ? 5_000 : false;
      },
    },
  );

  const stop = async () => {
    if (!id || !confirm("Stop this mission? The current iteration finishes its turn but nothing new spawns.")) return;
    setStopping(true);
    try {
      await api(`/v1/missions/${id}/stop`, { method: "POST", body: "{}" });
      void queryClient.invalidateQueries({ queryKey: [`/v1/missions/${id}`] });
      void queryClient.invalidateQueries({ queryKey: ["/v1/missions"] });
    } catch {
      // api wrapper toasts the failure
    } finally {
      setStopping(false);
    }
  };

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
  if (queryError) {
    return (
      <div className="text-center py-16 text-danger">
        {queryError instanceof Error ? queryError.message : String(queryError)}
      </div>
    );
  }
  if (!mission) return <div className="text-center py-16 text-fg-subtle">Mission not found.</div>;

  const now = Date.now();
  const wallEnd = mission.stopped_at ?? (mission.status === "running" ? now : mission.updated_at);
  const wallUsedMin = (wallEnd - mission.created_at) / 60_000;
  const verdict = mission.last_verdict;

  return (
    <div className="pl-3 pr-4 pt-3 pb-4 space-y-6">
      {/* Header — status pill row, then the goal as the page's headline and
          one flat metadata strip (wireless, matches EvalRunDetail). */}
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${missionStatusCls(mission.status)}`}>
            {mission.status.replace("_", " ")}
          </span>
          {mission.status === "running" && (
            <Button variant="outline" size="sm" onClick={stop} loading={stopping}>
              Stop mission
            </Button>
          )}
        </div>
        <h1 className="text-lg font-semibold text-fg max-w-3xl">{mission.goal}</h1>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-fg-muted">
          <span>
            Agent <Link to={`/agents/${mission.agent_id}`} className="text-fg font-mono text-xs hover:underline">{mission.agent_id}</Link>
          </span>
          <span>
            Created <span className="text-fg">{new Date(mission.created_at).toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
          </span>
          <span>
            Workspace <span className="text-fg font-mono text-xs" title={mission.workspace}>{mission.workspace}</span>
          </span>
        </div>
        <div className="flex flex-wrap gap-6 pt-1">
          <BudgetMeter
            label="Iterations"
            used={mission.iteration}
            max={mission.budget.max_iterations}
            detail={`${mission.iteration}/${mission.budget.max_iterations}`}
          />
          <BudgetMeter
            label="Wall clock"
            used={wallUsedMin}
            max={mission.budget.wall_clock_minutes}
            detail={`${elapsedStr(mission.created_at, wallEnd)} / ${mission.budget.wall_clock_minutes}m`}
          />
        </div>
      </div>

      {/* Verdict panel — the latest verifier run, one row per command. */}
      <div>
        <h2 className="text-sm font-medium text-fg mb-2">
          Latest verdict
          {verdict && (
            <span className="text-fg-subtle font-normal"> · iteration {verdict.iteration} · judge: {verdict.judge}</span>
          )}
        </h2>
        {!verdict ? (
          <div className="text-xs text-fg-subtle border border-dashed border-border rounded-lg px-3 py-3">
            No verdict yet — verifiers run after the first iteration finishes its turn.
          </div>
        ) : (
          <div className="space-y-2">
            {verdict.results.map((r, i) => (
              <div key={i} className="border border-border rounded-lg bg-bg-surface p-3">
                <div className="flex items-center gap-2">
                  <span
                    className={`inline-flex items-center text-[11px] px-1.5 py-0.5 rounded ${r.pass ? "bg-success-subtle text-success" : "bg-danger-subtle text-danger"}`}
                  >
                    {r.pass ? "pass" : "fail"}
                  </span>
                  <code className="text-xs text-fg font-mono">{r.command}</code>
                </div>
                {!r.pass && r.output_snippet.trim() && (
                  <pre className="mt-2 text-[11px] text-fg-muted font-mono whitespace-pre-wrap max-h-40 overflow-y-auto">
                    {r.output_snippet}
                  </pre>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Iterations — every session the supervisor spawned for this mission. */}
      <div>
        <h2 className="text-sm font-medium text-fg mb-2">Iterations</h2>
        {mission.iterations.length === 0 ? (
          <div className="text-xs text-fg-subtle border border-dashed border-border rounded-lg px-3 py-3">
            No iterations yet — the supervisor spawns the first one within ~15s.
          </div>
        ) : (
          <div className="space-y-1">
            {mission.iterations.map((it) => (
              <Link
                key={it.session_id}
                to={`/sessions/${it.session_id}`}
                className="flex items-center gap-3 border border-border rounded-lg px-3 py-2 hover:bg-bg-surface transition-colors"
              >
                <span className="text-xs text-fg-muted font-mono w-10 shrink-0">
                  #{it.iteration ?? "?"}
                </span>
                <span
                  className={`inline-flex items-center text-[11px] px-1.5 py-0.5 rounded-full shrink-0 ${sessionStatusCls(it.status)}`}
                >
                  {it.status}
                </span>
                <span className="text-sm text-fg truncate">{it.title}</span>
                <span className="ml-auto text-xs text-fg-subtle shrink-0">
                  {new Date(it.created_at).toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" })}
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Verifier contract — what "done" means for this mission. */}
      <div>
        <h2 className="text-sm font-medium text-fg mb-2">Verifiers</h2>
        <div className="space-y-1">
          {mission.verifiers.map((v, i) => (
            <div key={i} className="text-xs font-mono text-fg-muted border border-border rounded-md px-3 py-1.5 bg-bg-surface">
              {v.command}
              {v.timeout_ms ? <span className="text-fg-subtle"> · {Math.round(v.timeout_ms / 1000)}s timeout</span> : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
