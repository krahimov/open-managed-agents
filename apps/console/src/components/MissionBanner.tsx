import { Link } from "react-router";
import { toast } from "sonner";
import { useApi } from "../lib/api";
import { useApiQuery } from "../lib/useApiQuery";
import { Button } from "@/components/ui/button";

/**
 * Compact run header shown at the top of any session that belongs to a
 * mission (session.metadata.mission_id). The session IS the run surface —
 * this banner carries the goal contract, budget meters, status, iteration
 * hops, and the kill switch. Verdicts render inline in the timeline as
 * MissionVerdictCard.
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

const STATUS_STYLE: Record<string, string> = {
  running: "text-warning bg-warning-subtle",
  succeeded: "text-success bg-success-subtle",
  stopped: "text-fg-subtle bg-bg-surface",
  budget_exhausted: "text-danger bg-danger-subtle",
  stuck: "text-danger bg-danger-subtle",
};

export function MissionBanner({
  missionId,
  currentSessionId,
}: {
  missionId: string;
  currentSessionId: string;
}) {
  const { api } = useApi();
  const missionQuery = useApiQuery<MissionResponse>(`/v1/missions/${missionId}`, undefined, {
    refetchInterval: 5000,
  });
  const m = missionQuery.data;
  if (!m) return null;

  // Terminal runs freeze the clock at their last transition — a mission that
  // finished in 31s must not read "903m / 30m" the next morning.
  const elapsedEnd =
    m.status === "running" ? Date.now() : (m.stopped_at ?? m.updated_at ?? Date.now());
  const elapsedMin = Math.max(0, Math.round((elapsedEnd - m.created_at) / 60000));
  const iterations = m.iterations.filter((i) => i.iteration !== null);
  const current = iterations.find((i) => i.session_id === currentSessionId);

  const stop = async () => {
    try {
      await api(`/v1/missions/${m.id}/stop`, { method: "POST" });
      toast.success("Run stopped — the in-flight iteration finishes its turn, nothing respawns.");
      void missionQuery.refetch?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Stop failed");
    }
  };

  return (
    <div className="border border-border rounded-lg bg-bg-surface px-4 py-2.5 mb-3">
      <div className="flex items-center gap-3 flex-wrap">
        <span
          className={`text-[10px] uppercase tracking-wider font-bold px-2 py-0.5 rounded ${STATUS_STYLE[m.status] ?? STATUS_STYLE.stopped}`}
        >
          {m.status.replace("_", " ")}
        </span>
        <span className="text-sm font-medium min-w-0 flex-1 truncate" title={m.goal}>
          {m.goal}
        </span>
        {m.status === "running" && (
          <Button variant="destructive" size="sm" onClick={stop}>
            Stop run
          </Button>
        )}
      </div>
      <div className="mt-1.5 flex items-center gap-4 text-[11px] text-fg-subtle font-mono flex-wrap">
        <span>
          iteration {m.iteration}/{m.budget.max_iterations}
        </span>
        <span>
          {elapsedMin}m / {m.budget.wall_clock_minutes}m
        </span>
        {iterations.length > 1 && (
          <span className="flex items-center gap-1.5">
            {iterations.map((it) =>
              it.session_id === currentSessionId ? (
                <span key={it.session_id} className="text-fg font-semibold">
                  #{it.iteration}
                </span>
              ) : (
                <Link
                  key={it.session_id}
                  to={`/sessions/${it.session_id}`}
                  className="hover:text-fg underline decoration-dotted"
                >
                  #{it.iteration}
                </Link>
              ),
            )}
          </span>
        )}
        {current && <span>this session = iteration #{current.iteration}</span>}
      </div>
    </div>
  );
}
