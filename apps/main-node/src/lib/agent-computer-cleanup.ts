// What happens to an agent's computer when the agent goes away.
//
//   DELETE /v1/agents/:id   → the computer is deleted with it: the provider
//                             box and the agent_machines row (attachments go
//                             with the row; lifecycle events stay until
//                             their retention purge).
//   POST …/:id/archive      → the computer is STOPPED and kept. Archiving is
//                             reversible bookkeeping, so the disk — and the
//                             work on it — survives; a stopped box still
//                             counts against the provider's disk quota, and
//                             deleting the agent is what frees it.
//
// Neither hook may fail or stall the request that triggered it: the agent
// row is already gone/archived when they run. Failures are logged, and a
// failed delete is retried by the orphan sweeper (sandbox-sweeper.ts), which
// treats a machine row whose agent no longer exists as an orphan.

import { getLogger } from "@open-managed-agents/observability";

// Resolved per call: a logger captured at import time, before main-node
// installs its root logger, would be the no-op one.
const log = () => getLogger("agent-computer-cleanup");

export interface AgentComputerCleanupDeps {
  machines: {
    destroy(tenantId: string, agentId: string, opts?: { reason?: string }): Promise<{ machineId: string | null; providerRefs: string[] }>;
    stop(tenantId: string, agentId: string): Promise<unknown>;
  };
  /** How long the HTTP request waits for the provider before returning;
   *  the work itself keeps going in the background. */
  waitMs?: number;
}

export function createAgentComputerCleanup(deps: AgentComputerCleanupDeps) {
  const waitMs = deps.waitMs ?? 10_000;

  /** Resolve when `work` settles or after `waitMs`, whichever is first. */
  const bounded = async (work: Promise<void>): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      work,
      new Promise<void>((resolve) => { timer = setTimeout(resolve, waitMs); timer.unref?.(); }),
    ]);
    if (timer) clearTimeout(timer);
  };

  return {
    /** Never rejects. */
    onAgentDeleted(tenantId: string, agentId: string): Promise<void> {
      return bounded(
        deps.machines.destroy(tenantId, agentId, { reason: "agent_deleted" }).then(
          (result) => {
            if (!result.machineId) return;
            log().info(
              { op: "agent_computer.deleted", tenant_id: tenantId, agent_id: agentId, machine_id: result.machineId, box_ids: result.providerRefs },
              "deleted the computer of a deleted agent",
            );
          },
          (err) => {
            log().warn(
              { err, op: "agent_computer.delete_failed", tenant_id: tenantId, agent_id: agentId },
              "could not delete the computer of a deleted agent; the sandbox sweeper will retry",
            );
          },
        ),
      );
    },

    /** Never rejects. A computer with active work is left to its idle stop. */
    onAgentArchived(tenantId: string, agentId: string): Promise<void> {
      return bounded(
        deps.machines.stop(tenantId, agentId).then(
          (row) => {
            if (row) log().info({ op: "agent_computer.stopped_on_archive", tenant_id: tenantId, agent_id: agentId }, "stopped the computer of an archived agent");
          },
          (err) => {
            log().warn(
              { err, op: "agent_computer.stop_on_archive_failed", tenant_id: tenantId, agent_id: agentId },
              "could not stop the computer of an archived agent; it stops when idle",
            );
          },
        ),
      );
    },
  };
}
