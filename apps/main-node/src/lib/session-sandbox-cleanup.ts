// What happens to a session's own sandbox when the session is deleted.
//
// DELETE /v1/sessions/:id first tears down the sandbox this process holds in
// memory (SessionRegistry.destroy). That alone frees nothing after a restart:
// the new process holds no sandbox for the session, and a session that ran a
// turn after the restart got a NEW box while its pre-restart one lives on.
// Those boxes outlived the session until Daytona's auto-stop or the orphan
// sweeper, counting against the account's disk quota meanwhile (prod,
// 2026-11-15: five deleted sessions freed nothing and new computers hit the
// 30 GiB limit).
//
// So the delete also finds the session's boxes in the provider account by
// their OMA labels and deletes them directly. A box is deleted only when:
//   1. It is labelled with this session (`oma-session-id`).
//   2. It carries no `oma-machine-id` — that is an agent's computer, shared
//      by all of the agent's sessions, and goes only with the agent.
//   3. Its `oma-deployment-id`, when present, names this deployment. A box
//      without one (created before that label existed) is this deployment's
//      because the session it names is in this database — the sweeper's
//      ownership rule (sandbox-sweep-plan.ts).
//   4. Its `oma-tenant-id`, when present, names the session's tenant.
// There is no age rule: the session is going away, so nothing can be using
// the box. The delete re-checks the labels on the box itself.
//
// The hook never fails or stalls the request: the session row is deleted
// regardless. Failures are logged and the box is left to Daytona's auto-stop
// and the orphan sweeper (sandbox-sweeper.ts), which deletes a box labelled
// with this deployment once its session no longer exists.

import { getLogger } from "@open-managed-agents/observability";
import type { ProviderBox } from "@open-managed-agents/sandbox/adapters/daytona-inventory";
import { OMA_BOX_LABELS } from "@open-managed-agents/sandbox/adapters/daytona-types";

// Resolved per call: a logger captured at import time, before main-node
// installs its root logger, would be the no-op one.
const log = () => getLogger("session-sandbox-cleanup");

/** Daytona states of a box whose deletion is already under way. */
const DELETING_STATES = new Set(["destroying", "destroyed"]);

export type SessionBoxSkipReason = "agent_computer" | "other_deployment" | "label_mismatch" | "deleting";

export interface SessionBoxDeletionPlan {
  deletes: Array<{ boxId: string; expectLabels: Record<string, string | null> }>;
  skipped: Array<{ boxId: string; reason: SessionBoxSkipReason }>;
}

/** Which of `boxes` belong to the deleted session and may go. Pure. */
export function planSessionBoxDeletion(
  boxes: readonly ProviderBox[],
  target: { tenantId: string; sessionId: string; deploymentId: string },
): SessionBoxDeletionPlan {
  const plan: SessionBoxDeletionPlan = { deletes: [], skipped: [] };
  for (const box of boxes) {
    // The listing is filtered by this label; anything else is not ours to judge.
    if (box.labels[OMA_BOX_LABELS.session] !== target.sessionId) continue;
    const deployment = box.labels[OMA_BOX_LABELS.deployment];
    const tenant = box.labels[OMA_BOX_LABELS.tenant];
    const reason: SessionBoxSkipReason | null = box.labels[OMA_BOX_LABELS.machine]
      ? "agent_computer"
      : deployment && deployment !== target.deploymentId
        ? "other_deployment"
        : tenant && tenant !== target.tenantId
          ? "label_mismatch"
          : box.state && DELETING_STATES.has(box.state)
            ? "deleting"
            : null;
    if (reason) {
      plan.skipped.push({ boxId: box.id, reason });
      continue;
    }
    plan.deletes.push({
      boxId: box.id,
      expectLabels: {
        [OMA_BOX_LABELS.session]: target.sessionId,
        ...(tenant ? { [OMA_BOX_LABELS.tenant]: tenant } : {}),
        [OMA_BOX_LABELS.machine]: null,
        [OMA_BOX_LABELS.deployment]: deployment ?? null,
      },
    });
  }
  return plan;
}

export interface SessionSandboxCleanupDeps {
  /** Provider account inventory (DaytonaBoxInventory). */
  inventory: {
    list(query?: { labels?: Record<string, string> }): Promise<ProviderBox[]>;
    delete(id: string, expectLabels: Record<string, string | null>): Promise<"deleted" | "gone">;
  };
  deploymentId: string;
  /** How long the HTTP request waits for the provider before returning;
   *  the work itself keeps going in the background. */
  waitMs?: number;
}

export function createSessionSandboxCleanup(deps: SessionSandboxCleanupDeps) {
  const waitMs = deps.waitMs ?? 10_000;

  const run = async (tenantId: string, sessionId: string): Promise<void> => {
    const fields = { tenant_id: tenantId, session_id: sessionId };
    let boxes: ProviderBox[];
    try {
      boxes = await deps.inventory.list({ labels: { [OMA_BOX_LABELS.session]: sessionId } });
    } catch (err) {
      log().warn(
        { err, op: "session_sandbox.list_failed", ...fields },
        "could not look up the sandboxes of a deleted session; the sandbox sweeper will retry",
      );
      return;
    }
    const plan = planSessionBoxDeletion(boxes, { tenantId, sessionId, deploymentId: deps.deploymentId });
    for (const skip of plan.skipped) {
      if (skip.reason === "deleting") continue;
      log().info(
        { op: "session_sandbox.kept", reason: skip.reason, box_id: skip.boxId, ...fields },
        "kept a sandbox labelled with a deleted session",
      );
    }
    for (const { boxId, expectLabels } of plan.deletes) {
      try {
        const outcome = await deps.inventory.delete(boxId, expectLabels);
        log().info(
          { op: "session_sandbox.deleted", outcome, box_id: boxId, ...fields },
          "deleted the sandbox of a deleted session",
        );
      } catch (err) {
        log().warn(
          { err, op: "session_sandbox.delete_failed", box_id: boxId, ...fields },
          "could not delete the sandbox of a deleted session; the sandbox sweeper will retry",
        );
      }
    }
  };

  return {
    /** Never rejects. Resolves when the boxes are deleted or after `waitMs`. */
    async onSessionDeleted(tenantId: string, sessionId: string): Promise<void> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        run(tenantId, sessionId).catch(() => undefined),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, waitMs); timer.unref?.(); }),
      ]);
      if (timer) clearTimeout(timer);
    },
  };
}
