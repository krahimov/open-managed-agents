import { useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

import { useApi } from "../lib/api";
import { useServerFeature } from "../lib/server-features";
import { Field } from "./Field";
import { Modal } from "./Modal";
import { withReason } from "@/lib/failure-text";

/**
 * "Run until done": the goal contract for long-running agents. Missions
 * have no page of their own (the session is the surface): this dialog
 * creates the mission, the backend starts iteration 1, and we go straight
 * into that session, where the run band and the verdict cards tell the
 * rest of the story.
 *
 * Only where the server runs missions (`useServerFeature("missions")`);
 * elsewhere the dialog renders nothing, and its entry point is hidden.
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
  const missions = useServerFeature("missions");

  const start = async () => {
    setStarting(true);
    try {
      const mission = await api<{ id: string; active_session_id: string | null }>("/v1/missions", {
        method: "POST",
        body: JSON.stringify({
          agent_id: agentId,
          goal: goal.trim(),
          verifiers: [{ kind: "command", command: verifier.trim() }],
          budget: { max_iterations: maxIterations, wall_clock_minutes: wallClock },
        }),
      });
      onClose();
      if (mission.active_session_id) {
        nav(`/sessions/${mission.active_session_id}`);
      } else {
        toast.success("Run started. The first iteration will appear in Sessions shortly.");
        nav("/sessions");
      }
    } catch (err) {
      toast.error(withReason("The run could not be started", err));
    } finally {
      setStarting(false);
    }
  };

  if (!missions) return null;

  return (
    <Modal
      open={open}
      onClose={() => !starting && onClose()}
      title="Run until done"
      subtitle="The agent works in fresh iterations until a check you choose passes, the budget runs out, or it gets stuck."
      maxWidth="max-w-xl"
      footer={
        <>
          <Button variant="ghost" disabled={starting} onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={start} disabled={!goal.trim() || !verifier.trim()} loading={starting} loadingLabel="Starting…">
            Start run
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <Field label="Goal" hint="What should be true when the run is finished. Every iteration starts from this.">
          <Textarea
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            rows={3}
            placeholder="Migrate every route file under src/routes to the new error handler"
          />
        </Field>
        <Field
          label="Check that proves it"
          hint="A command run in the workspace after each iteration. Exit code 0 means done. The agent never signs off on its own work; this command does."
        >
          <Input value={verifier} onChange={(e) => setVerifier(e.target.value)} placeholder="npm test -- routes" autoComplete="off" className="font-mono" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Most iterations" hint="1 to 200">
            <Input type="number" min={1} max={200} value={maxIterations} onChange={(e) => setMaxIterations(Number(e.target.value) || 1)} />
          </Field>
          <Field label="Time limit, in minutes" hint="Up to 1,440 (one day)">
            <Input type="number" min={1} max={1440} value={wallClock} onChange={(e) => setWallClock(Number(e.target.value) || 1)} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}
