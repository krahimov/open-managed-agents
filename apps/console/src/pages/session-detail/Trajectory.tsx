import type { ReactNode } from "react";
import { DownloadIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

import { StatusBadge } from "../../components/Badge";
import { CodeWell } from "../../components/EventCard";
import { CopyButton } from "../../components/IdChip";
import { Modal } from "../../components/Modal";
import { QueryProblem } from "../../components/QueryProblem";
import { Skeleton, SkeletonText } from "../../components/Skeleton";
import { formatElapsed } from "../../components/sessions/model";
import { formatCompact, formatCost } from "../../lib/format";
import { outcomeToStatusTone, rewardHeadline, type Trajectory } from "../../lib/trajectory";

/**
 * The trajectory viewer: the portable record of a session (Trajectory v1),
 * the envelope evals and exports are built from. Opens from the session
 * menu. It leads with what the record says in plain numbers, then shows the
 * raw JSON, which can be copied or downloaded.
 */

const OUTCOME_LABEL: Record<string, string> = {
  success: "Succeeded",
  failure: "Failed",
  timeout: "Timed out",
  interrupted: "Interrupted",
  running: "Running",
};

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-xs text-fg-subtle">{label}</dt>
      <dd className="mt-0.5 truncate text-h3 text-fg tabular-nums">{children}</dd>
    </div>
  );
}

export function TrajectoryViewerModal({
  open,
  onClose,
  sessionId,
  sessionTitle,
  trajectory,
  onRetry,
}: {
  open: boolean;
  onClose: () => void;
  sessionId: string;
  sessionTitle?: string;
  trajectory: Trajectory | "loading" | "error" | undefined;
  onRetry?: () => void;
}) {
  const ready = trajectory && trajectory !== "loading" && trajectory !== "error" ? trajectory : null;
  const json = ready ? JSON.stringify(ready, null, 2) : "";

  function download() {
    if (!ready) return;
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `trajectory-${sessionId}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  const s = ready?.summary;
  const tokens = s?.token_usage;
  const totalTokens = tokens
    ? tokens.input_tokens + tokens.output_tokens + tokens.cache_read_input_tokens + (tokens.cache_creation_input_tokens ?? 0)
    : 0;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Trajectory"
      subtitle={
        sessionTitle
          ? `The portable record of “${sessionTitle}”: every event, the agent and environment it ran with, and the outcome.`
          : "The portable record of this session: every event, the agent and environment it ran with, and the outcome."
      }
      maxWidth="max-w-4xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          {/* Start on the action, not on the first copy button in the body. */}
          <Button onClick={download} disabled={!ready} autoFocus>
            <DownloadIcon data-icon="inline-start" />
            Download JSON
          </Button>
        </>
      }
    >
      {trajectory === "error" ? (
        <QueryProblem
          compact
          title="The trajectory could not be built"
          error={new Error("The session may have no events yet, or the sandbox worker is unreachable.")}
          retry={onRetry}
        />
      ) : !ready ? (
        <div aria-hidden="true">
          <div className="grid grid-cols-3 gap-x-6 gap-y-4 rounded-lg bg-bg-soft px-5 py-4 sm:grid-cols-6">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="space-y-2">
                <Skeleton className="h-2.5 w-14" rounded="sm" />
                <Skeleton className="h-4 w-10" rounded="sm" />
              </div>
            ))}
          </div>
          <SkeletonText lines={9} className="mt-6" />
        </div>
      ) : (
        <div className="space-y-4">
          <dl className="grid grid-cols-3 gap-x-6 gap-y-4 rounded-lg bg-bg-soft px-5 py-4 sm:grid-cols-6">
            <div className="min-w-0">
              <dt className="text-xs text-fg-subtle">Outcome</dt>
              <dd className="mt-1 flex items-center gap-1.5">
                <StatusBadge
                  status={outcomeToStatusTone(ready.outcome)}
                  label={OUTCOME_LABEL[ready.outcome] ?? ready.outcome}
                  variant="soft"
                />
              </dd>
            </div>
            <Stat label="Duration">{formatElapsed(s?.duration_ms) || "0s"}</Stat>
            <Stat label="Turns">{(s?.num_turns ?? 0).toLocaleString()}</Stat>
            <Stat label="Tool calls">
              {(s?.num_tool_calls ?? 0).toLocaleString()}
              {(s?.num_tool_errors ?? 0) > 0 && <span className="text-small font-normal text-danger"> · {s?.num_tool_errors} failed</span>}
            </Stat>
            <Stat label="Tokens">{formatCompact(totalTokens)}</Stat>
            {ready.reward ? (
              <Stat label="Reward">{rewardHeadline(ready.reward) === "PASS" ? "Pass" : rewardHeadline(ready.reward) === "FAIL" ? "Fail" : rewardHeadline(ready.reward)}</Stat>
            ) : ready.trace_facts?.est_cost_usd != null ? (
              <Stat label="Est. cost">{formatCost(ready.trace_facts.est_cost_usd)}</Stat>
            ) : (
              <Stat label="Events">{(s?.num_events ?? ready.events?.length ?? 0).toLocaleString()}</Stat>
            )}
          </dl>
          <div>
            <div className="mb-1.5 flex h-7 items-center justify-between">
              <p className="text-xs font-medium text-fg-subtle">
                Raw record <span className="font-mono font-normal text-fg-faint">· {ready.schema_version} · {ready.trajectory_id}</span>
              </p>
              <CopyButton value={json} label="Copy JSON" />
            </div>
            <CodeWell className="max-h-[46vh] whitespace-pre">{json}</CodeWell>
          </div>
        </div>
      )}
    </Modal>
  );
}
