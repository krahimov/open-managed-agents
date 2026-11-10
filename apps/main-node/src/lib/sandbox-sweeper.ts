// Orphan-sandbox sweeper — the I/O half. Provider boxes are never cleaned up
// by the request path alone: an agent can be deleted while the provider is
// down, a process can die between "create box" and "remember box", and a
// session's box can sit in `error`/`archived` for weeks. Left alone they fill
// the provider account's disk quota and every new session fails (prod,
// 2026-11-10). This job reconciles the provider account with the database.
//
// One sweep: list every box → read the database facts those boxes point at →
// `planSandboxSweep` (sandbox-sweep-plan.ts, where the safety rules live) →
// re-check each decision against the database → delete, or only log when
// SANDBOX_SWEEP_DRY_RUN is set. Registered as a scheduler job
// (node-scheduler-jobs.ts); idempotent, so a second replica running the same
// sweep only finds the boxes already gone.
//
// A sweep that cannot read the provider or the database deletes nothing.

import { getLogger } from "@open-managed-agents/observability";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type { ProviderBox } from "@open-managed-agents/sandbox/adapters/daytona-inventory";
import { OMA_BOX_LABELS } from "@open-managed-agents/sandbox/adapters/daytona-types";
import {
  agentKey,
  planSandboxSweep,
  sessionBoxReason,
  type SweepAction,
  type SweepMachineRow,
  type SweepSession,
  type SweepSkipReason,
} from "./sandbox-sweep-plan.js";

// Resolved per call: this module is imported before main-node installs its
// root logger, and a logger captured at import time would be the no-op one.
const log = () => getLogger("sandbox-sweeper");

const DAY_MS = 24 * 60 * 60_000;

export interface SandboxSweepConfig {
  /** Log what would be deleted without deleting anything. */
  dryRun: boolean;
  /** A session idle or terminated this long no longer needs its box. */
  sessionMaxAgeMs: number;
  /** Boxes younger than this are never judged (creation in progress). */
  minBoxAgeMs: number;
  /** See `SweepPlanInput.adoptUnlabelled`. */
  adoptUnlabelled: boolean;
  /** Upper bound on deletions per sweep; the rest wait for the next one. */
  maxDeletions: number;
}

export const SANDBOX_SWEEP_DEFAULT_CRON = "17 * * * *";

/** Parse SANDBOX_SWEEP_* env vars. Unparseable values fall back to the
 *  conservative default rather than to a more aggressive setting. */
export function sandboxSweepConfigFromEnv(env: Readonly<Record<string, string | undefined>>): SandboxSweepConfig {
  const positive = (value: string | undefined, fallback: number): number => {
    const parsed = Number(value);
    return value !== undefined && value.trim() !== "" && Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  const flag = (value: string | undefined): boolean =>
    ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
  return {
    dryRun: flag(env.SANDBOX_SWEEP_DRY_RUN),
    sessionMaxAgeMs: positive(env.SANDBOX_SWEEP_SESSION_MAX_AGE_DAYS, 7) * DAY_MS,
    minBoxAgeMs: 60 * 60_000,
    adoptUnlabelled: flag(env.SANDBOX_SWEEP_ADOPT_UNLABELLED),
    maxDeletions: Math.floor(positive(env.SANDBOX_SWEEP_MAX_DELETIONS, 50)),
  };
}

/** `null` when the operator turned the sweep off (SANDBOX_SWEEP_CRON=off). */
export function sandboxSweepCronFromEnv(env: Readonly<Record<string, string | undefined>>): string | null {
  const value = env.SANDBOX_SWEEP_CRON?.trim();
  if (!value) return SANDBOX_SWEEP_DEFAULT_CRON;
  return ["off", "false", "0", "disabled", "none"].includes(value.toLowerCase()) ? null : value;
}

export interface SandboxSweeperDeps {
  /** Provider account inventory (DaytonaBoxInventory). */
  inventory: {
    list(): Promise<ProviderBox[]>;
    delete(id: string, expectLabels: Record<string, string | null>): Promise<"deleted" | "gone">;
  };
  /** Every agent-machine row, all tenants. */
  listMachines(): Promise<SweepMachineRow[]>;
  /** Delete a machine's box(es) and row (AgentMachineManager.destroy). */
  destroyMachine(tenantId: string, agentId: string): Promise<unknown>;
  /** Archived agents exist; only a hard-deleted agent returns false. */
  agentExists(tenantId: string, agentId: string): Promise<boolean>;
  getSession(sessionId: string): Promise<SweepSession | null>;
  deploymentId: string;
  config: SandboxSweepConfig;
  now?: () => number;
}

export type SweepOutcome = "deleted" | "gone" | "would_delete" | "kept" | "failed" | "deferred";

export interface SandboxSweepReport {
  dryRun: boolean;
  boxes: number;
  machines: number;
  results: Array<{ action: SweepAction; outcome: SweepOutcome }>;
  skipped: Partial<Record<SweepSkipReason, number>>;
}

export class SandboxSweeper {
  private running: Promise<SandboxSweepReport> | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: SandboxSweeperDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Run one sweep; a call made while one is in flight joins it. */
  run(): Promise<SandboxSweepReport> {
    if (!this.running) {
      this.running = this.sweep()
        .catch((err) => {
          log().warn({ err, op: "sandbox_sweep.failed", deployment_id: this.deps.deploymentId }, "sandbox sweep aborted; nothing further was deleted");
          throw err;
        })
        .finally(() => { this.running = null; });
    }
    return this.running;
  }

  private async sweep(): Promise<SandboxSweepReport> {
    const { deps } = this;
    const { config } = deps;
    // Provider first, database second: anything created after the listing
    // is not in it, and anything in it is looked up in a newer database.
    const boxes = await deps.inventory.list();
    const machines = await deps.listMachines();

    const agentRefs = new Map<string, { tenantId: string; agentId: string }>();
    for (const m of machines) agentRefs.set(agentKey(m.tenantId, m.agentId), m);
    const sessionIds = new Set<string>();
    for (const box of boxes) {
      const tenantId = box.labels[OMA_BOX_LABELS.tenant];
      const agentId = box.labels[OMA_BOX_LABELS.agent];
      if (box.labels[OMA_BOX_LABELS.machine]) {
        if (tenantId && agentId) agentRefs.set(agentKey(tenantId, agentId), { tenantId, agentId });
      } else if (box.labels[OMA_BOX_LABELS.session]) {
        sessionIds.add(box.labels[OMA_BOX_LABELS.session]);
      }
    }
    const existingAgents = new Set<string>();
    for (const [key, ref] of agentRefs) {
      if (await deps.agentExists(ref.tenantId, ref.agentId)) existingAgents.add(key);
    }
    const sessions = new Map<string, SweepSession>();
    for (const id of sessionIds) {
      const session = await deps.getSession(id);
      if (session) sessions.set(id, session);
    }

    const plan = planSandboxSweep({
      now: this.now(), deploymentId: deps.deploymentId, boxes, machines, existingAgents, sessions,
      sessionMaxAgeMs: config.sessionMaxAgeMs, minBoxAgeMs: config.minBoxAgeMs, adoptUnlabelled: config.adoptUnlabelled,
    });

    const report: SandboxSweepReport = { dryRun: config.dryRun, boxes: boxes.length, machines: machines.length, results: [], skipped: {} };
    for (const skip of plan.skipped) report.skipped[skip.reason] = (report.skipped[skip.reason] ?? 0) + 1;

    let budget = config.maxDeletions;
    for (const action of plan.actions) {
      if (budget <= 0) {
        report.results.push({ action, outcome: "deferred" });
        continue;
      }
      let outcome: SweepOutcome;
      try {
        outcome = await this.carryOut(action);
      } catch (err) {
        outcome = "failed";
        log().warn({ err, op: "sandbox_sweep.delete_failed", ...actionFields(action) }, "sandbox sweep could not delete an orphan; it will be retried");
      }
      if (outcome !== "kept") budget--;
      if (outcome === "deleted" || outcome === "gone" || outcome === "would_delete") {
        log().info(
          { op: outcome === "would_delete" ? "sandbox_sweep.would_delete" : "sandbox_sweep.deleted", outcome, ...actionFields(action) },
          outcome === "would_delete" ? "sandbox sweep (dry run) would delete an orphan" : "sandbox sweep deleted an orphan",
        );
      }
      report.results.push({ action, outcome });
    }

    const count = (outcome: SweepOutcome) => report.results.filter((r) => r.outcome === outcome).length;
    log().info(
      {
        op: "sandbox_sweep.finished", dry_run: config.dryRun, deployment_id: deps.deploymentId,
        boxes: report.boxes, machines: report.machines,
        deleted: count("deleted") + count("gone"), would_delete: count("would_delete"),
        kept: count("kept"), failed: count("failed"), deferred: count("deferred"), skipped: report.skipped,
      },
      "sandbox sweep finished",
    );
    return report;
  }

  /** Re-check the decision against the database as it is NOW, then delete. */
  private async carryOut(action: SweepAction): Promise<SweepOutcome> {
    const { deps } = this;
    if (action.kind === "session_box") {
      const session = await deps.getSession(action.sessionId);
      if (!sessionBoxReason(session, this.now(), deps.config.sessionMaxAgeMs)) return "kept";
    } else if (await deps.agentExists(action.tenantId, action.agentId)) {
      return "kept";
    }
    if (deps.config.dryRun) return "would_delete";
    if (action.kind === "machine") {
      await deps.destroyMachine(action.tenantId, action.agentId);
      return "deleted";
    }
    return deps.inventory.delete(action.boxId, action.expectLabels);
  }
}

function actionFields(action: SweepAction): Record<string, unknown> {
  return {
    kind: action.kind,
    reason: action.reason,
    tenant_id: action.tenantId,
    ...(action.kind === "session_box"
      ? { session_id: action.sessionId, box_id: action.boxId }
      : { agent_id: action.agentId, machine_id: action.machineId, box_id: action.kind === "machine" ? action.providerRef : action.boxId }),
  };
}

/** Database lookups for the sweeper over the Node SqlClient. Epoch columns
 *  arrive as strings from postgres BIGINT, hence the Number() coercion. */
export function sandboxSweepSqlLookups(sql: SqlClient): Pick<SandboxSweeperDeps, "agentExists" | "getSession"> {
  return {
    agentExists: async (tenantId, agentId) =>
      (await sql
        .prepare(`SELECT 1 AS one FROM agents WHERE tenant_id = ? AND id = ?`)
        .bind(tenantId, agentId)
        .first<{ one: number }>()) !== null,
    getSession: async (sessionId) => {
      const row = await sql
        .prepare(
          `SELECT id, tenant_id, status, created_at, updated_at, archived_at, terminated_at
             FROM sessions WHERE id = ?`,
        )
        .bind(sessionId)
        .first<{
          id: string; tenant_id: string; status: string;
          created_at: number | string; updated_at: number | string | null;
          archived_at: number | string | null; terminated_at: number | string | null;
        }>();
      if (!row) return null;
      const stamps = [row.created_at, row.updated_at, row.archived_at, row.terminated_at]
        .map((v) => (v === null || v === undefined ? NaN : Number(v)))
        .filter((v) => Number.isFinite(v));
      return {
        id: row.id,
        tenantId: row.tenant_id,
        status: row.status,
        // No readable timestamp ⇒ treat as active now: never a deletion reason.
        lastActiveAtMs: stamps.length > 0 ? Math.max(...stamps) : Date.now(),
      };
    },
  };
}
