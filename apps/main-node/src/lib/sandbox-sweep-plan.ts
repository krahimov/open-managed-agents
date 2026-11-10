// Orphan-sandbox sweep — the decision half. Pure: given what the provider
// account contains and what the database says, decide which boxes and
// machine rows are orphans. No I/O, so every safety rule below is unit
// tested (test/sandbox-sweep-plan.test.ts); sandbox-sweeper.ts gathers the
// inputs and carries the decisions out.
//
// Safety rules, in the order they are applied to a box:
//   1. No OMA identity label (oma-session-id / oma-machine-id) → never touched.
//   2. An `oma-deployment-id` label naming ANOTHER deployment → never touched.
//   3. Ownership must be proven: the deployment label names this deployment,
//      or (boxes created before that label existed) this database holds the
//      machine row / session the box is labelled with. A box with neither is
//      left alone unless the operator opted in to `adoptUnlabelled`.
//   4. Labels that disagree with the database row they point at (another
//      tenant or agent) → never touched.
//   5. Boxes younger than `minBoxAgeMs`, or of unknown age → left for a
//      later sweep, so a box is never judged while it is being created.
//   6. Only then: delete when the owning agent / session no longer exists,
//      or the session has been idle or terminated longer than
//      `sessionMaxAgeMs`. A running or rescheduling session is never an orphan.

import { OMA_BOX_LABELS } from "@open-managed-agents/sandbox/adapters/daytona-types";
import type { ProviderBox } from "@open-managed-agents/sandbox/adapters/daytona-inventory";

export interface SweepMachineRow {
  id: string;
  tenantId: string;
  agentId: string;
  providerRef: string | null;
}

export interface SweepSession {
  id: string;
  tenantId: string;
  status: string;
  /** Latest of created / updated / terminated / archived, epoch ms. */
  lastActiveAtMs: number;
}

export interface SweepPlanInput {
  now: number;
  deploymentId: string;
  boxes: readonly ProviderBox[];
  machines: readonly SweepMachineRow[];
  /** `agentKey()` of every agent referenced by a box or machine row that
   *  still exists (archived agents exist). */
  existingAgents: ReadonlySet<string>;
  /** Sessions referenced by a box label that still exist, by id. */
  sessions: ReadonlyMap<string, SweepSession>;
  sessionMaxAgeMs: number;
  minBoxAgeMs: number;
  /** Treat boxes with OMA labels but no deployment label and no database
   *  record as this deployment's. Only safe when no other OMA install
   *  shares the provider account. */
  adoptUnlabelled: boolean;
}

export type SessionBoxReason = "session_missing" | "session_terminated" | "session_idle";

export type SweepAction =
  /** A machine row whose agent is gone: delete its box(es), then the row. */
  | { kind: "machine"; reason: "agent_missing"; machineId: string; tenantId: string; agentId: string; providerRef: string | null }
  /** A machine box with no row left, whose agent is gone. */
  | { kind: "machine_box"; reason: "agent_missing"; boxId: string; machineId: string; tenantId: string; agentId: string; expectLabels: Record<string, string | null> }
  | { kind: "session_box"; reason: SessionBoxReason; boxId: string; sessionId: string; tenantId: string | null; expectLabels: Record<string, string | null> };

export type SweepSkipReason =
  | "not_oma"
  | "other_deployment"
  | "unproven_owner"
  | "label_mismatch"
  | "too_new"
  | "live";

export interface SweepPlan {
  actions: SweepAction[];
  skipped: Array<{ boxId: string; reason: SweepSkipReason }>;
}

export function agentKey(tenantId: string, agentId: string): string {
  return `${tenantId}\u0000${agentId}`;
}

/** Why a session's box may be deleted, or null while the session still
 *  needs it. Shared with the sweeper's re-check right before a delete. */
export function sessionBoxReason(
  session: SweepSession | null | undefined,
  now: number,
  sessionMaxAgeMs: number,
): SessionBoxReason | null {
  if (!session) return "session_missing";
  if (session.status === "running" || session.status === "rescheduling") return null;
  if (now - session.lastActiveAtMs < sessionMaxAgeMs) return null;
  return session.status === "terminated" ? "session_terminated" : "session_idle";
}

export function planSandboxSweep(input: SweepPlanInput): SweepPlan {
  const plan: SweepPlan = { actions: [], skipped: [] };
  const machineById = new Map(input.machines.map((m) => [m.id, m]));

  for (const row of input.machines) {
    if (input.existingAgents.has(agentKey(row.tenantId, row.agentId))) continue;
    plan.actions.push({
      kind: "machine", reason: "agent_missing",
      machineId: row.id, tenantId: row.tenantId, agentId: row.agentId, providerRef: row.providerRef,
    });
  }

  for (const box of input.boxes) {
    const verdict = box.labels[OMA_BOX_LABELS.machine]
      ? judgeMachineBox(box, input, machineById)
      : box.labels[OMA_BOX_LABELS.session]
        ? judgeSessionBox(box, input)
        : "not_oma";
    if (verdict === null) continue;
    if (typeof verdict === "string") plan.skipped.push({ boxId: box.id, reason: verdict });
    else plan.actions.push(verdict);
  }
  return plan;
}

/** `null` = nothing to do here (the machine-row action covers this box). */
function judgeMachineBox(
  box: ProviderBox,
  input: SweepPlanInput,
  machineById: ReadonlyMap<string, SweepMachineRow>,
): SweepAction | SweepSkipReason | null {
  const machineId = box.labels[OMA_BOX_LABELS.machine];
  const tenantId = box.labels[OMA_BOX_LABELS.tenant];
  const agentId = box.labels[OMA_BOX_LABELS.agent];
  const deployment = box.labels[OMA_BOX_LABELS.deployment];
  if (!tenantId || !agentId) return "label_mismatch";
  if (deployment && deployment !== input.deploymentId) return "other_deployment";

  const row = machineById.get(machineId);
  if (row) {
    if (row.tenantId !== tenantId || row.agentId !== agentId) return "label_mismatch";
    // `destroy` removes every box labelled with the machine along with the row.
    return input.existingAgents.has(agentKey(tenantId, agentId)) ? "live" : null;
  }

  const owned = deployment === input.deploymentId || (!deployment && input.adoptUnlabelled);
  if (!owned) return "unproven_owner";
  if (input.existingAgents.has(agentKey(tenantId, agentId))) return "live";
  if (tooNew(box, input)) return "too_new";
  return {
    kind: "machine_box", reason: "agent_missing", boxId: box.id, machineId, tenantId, agentId,
    expectLabels: identityLabels(box, [OMA_BOX_LABELS.machine, OMA_BOX_LABELS.tenant, OMA_BOX_LABELS.agent]),
  };
}

function judgeSessionBox(box: ProviderBox, input: SweepPlanInput): SweepAction | SweepSkipReason {
  const sessionId = box.labels[OMA_BOX_LABELS.session];
  const tenantId = box.labels[OMA_BOX_LABELS.tenant] ?? null;
  const deployment = box.labels[OMA_BOX_LABELS.deployment];
  if (deployment && deployment !== input.deploymentId) return "other_deployment";

  const session = input.sessions.get(sessionId) ?? null;
  if (session && tenantId && session.tenantId !== tenantId) return "label_mismatch";
  const owned = deployment === input.deploymentId || (!deployment && (session !== null || input.adoptUnlabelled));
  if (!owned) return "unproven_owner";

  const reason = sessionBoxReason(session, input.now, input.sessionMaxAgeMs);
  if (!reason) return "live";
  if (tooNew(box, input)) return "too_new";
  return {
    kind: "session_box", reason, boxId: box.id, sessionId, tenantId: session?.tenantId ?? tenantId,
    expectLabels: identityLabels(box, [OMA_BOX_LABELS.session, OMA_BOX_LABELS.tenant]),
  };
}

function tooNew(box: ProviderBox, input: SweepPlanInput): boolean {
  return box.createdAtMs === null || input.now - box.createdAtMs < input.minBoxAgeMs;
}

/** The labels the decision relied on; the delete re-checks them on the box.
 *  The deployment label is always pinned — `null` when absent — so a box
 *  another deployment claims in the meantime is not deleted. */
function identityLabels(box: ProviderBox, keys: readonly string[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const key of keys) {
    const value = box.labels[key];
    if (value) out[key] = value;
  }
  out[OMA_BOX_LABELS.deployment] = box.labels[OMA_BOX_LABELS.deployment] ?? null;
  return out;
}
