import { useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { useApi } from "../lib/api";
import { Modal } from "./Modal";
import { Button } from "@/components/ui/button";

/**
 * "Run until done" — the goal-contract entry point for long-running agents.
 * Missions have no page of their own (capabilities are flags, the session is
 * the surface): this dialog creates the mission, the backend spawns iteration
 * 1 synchronously, and we navigate straight into that session, where the
 * mission banner + verdict cards tell the rest of the story.
 */
export function RunUntilDoneDialog({
  agentId,
  open,
  onClose,
}: {
  agentId: string;
  open: boolean;
  onClose: () => void;
}) {
  const { api } = useApi();
  const nav = useNavigate();
  const [goal, setGoal] = useState("");
  const [verifier, setVerifier] = useState("");
  const [maxIterations, setMaxIterations] = useState(10);
  const [wallClock, setWallClock] = useState(120);
  const [starting, setStarting] = useState(false);

  const start = async () => {
    setStarting(true);
    try {
      const mission = await api<{ id: string; active_session_id: string | null }>(
        "/v1/missions",
        {
          method: "POST",
          body: JSON.stringify({
            agent_id: agentId,
            goal: goal.trim(),
            verifiers: [{ kind: "command", command: verifier.trim() }],
            budget: { max_iterations: maxIterations, wall_clock_minutes: wallClock },
          }),
        },
      );
      onClose();
      if (mission.active_session_id) {
        nav(`/sessions/${mission.active_session_id}`);
      } else {
        toast.success("Run started — the first iteration will appear in Sessions shortly.");
        nav("/sessions");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to start run");
    } finally {
      setStarting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => !starting && onClose()}
      title="Run until done"
      subtitle="The agent iterates in fresh contexts until every check passes, budget runs out, or it gets stuck. Done is verified, never self-declared."
      maxWidth="max-w-xl"
      footer={
        <>
          <Button variant="ghost" disabled={starting} onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={start}
            disabled={!goal.trim() || !verifier.trim() || starting}
            loading={starting}
            loadingLabel="Starting…"
          >
            Start run
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="text-sm font-medium text-fg block mb-1">Goal</label>
          <textarea
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            rows={3}
            placeholder="Migrate every route file under src/routes to the new error handler…"
            className="w-full bg-bg border border-border rounded-md px-3 py-2 text-sm placeholder:text-fg-subtle focus:outline-none focus:border-border-strong"
          />
        </div>
        <div>
          <label className="text-sm font-medium text-fg block mb-1">
            Verifier <span className="text-fg-subtle font-normal">(exit 0 = done)</span>
          </label>
          <input
            value={verifier}
            onChange={(e) => setVerifier(e.target.value)}
            placeholder="npm test -- routes"
            className="w-full bg-bg border border-border rounded-md px-3 py-1.5 text-[13px] font-mono placeholder:text-fg-subtle focus:outline-none focus:border-border-strong"
          />
          <p className="text-[11px] text-fg-subtle mt-1">
            Runs in the run's workspace after each iteration. The agent never signs off on
            its own work — this command does.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-sm font-medium text-fg block mb-1">Max iterations</label>
            <input
              type="number"
              min={1}
              max={200}
              value={maxIterations}
              onChange={(e) => setMaxIterations(Number(e.target.value) || 1)}
              className="w-full bg-bg border border-border rounded-md px-3 py-1.5 text-sm focus:outline-none focus:border-border-strong"
            />
          </div>
          <div>
            <label className="text-sm font-medium text-fg block mb-1">Wall clock (minutes)</label>
            <input
              type="number"
              min={1}
              max={1440}
              value={wallClock}
              onChange={(e) => setWallClock(Number(e.target.value) || 1)}
              className="w-full bg-bg border border-border rounded-md px-3 py-1.5 text-sm focus:outline-none focus:border-border-strong"
            />
          </div>
        </div>
      </div>
    </Modal>
  );
}
