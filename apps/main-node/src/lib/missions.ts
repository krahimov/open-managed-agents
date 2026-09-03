/**
 * Missions — long-running agent loops under an outer supervisor.
 *
 * A mission is a goal contract: the supervisor pump (node-mission-
 * supervisor.ts) repeatedly spawns fresh sessions toward `goal`, runs the
 * `verifiers` (shell commands, cwd = the mission workspace, exit 0 = pass)
 * after each iteration's turn goes idle, and stops when they all pass, the
 * budget exhausts, or the last 3 verdicts are identical failures (stuck).
 * "Repeated effort under supervision, not one long thought."
 *
 * Storage follows the self-contained DDL pattern (skills, webhooks) —
 * promote to packages/db-schema when the feature graduates. `verifiers`,
 * `budget`, `last_verdict`, and `recent_verdicts` are JSON text columns;
 * this store marshals them at the SQL boundary so callers only see parsed
 * shapes. `recent_verdicts` (capped ring of the newest verdicts) exists
 * because the stuck rule needs the last 3, not just the last 1.
 */

import { nanoid } from "nanoid";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type {
  MissionBudget,
  MissionStatus,
  MissionVerdict,
  MissionVerifier,
} from "./mission-decision";

export interface MissionRow {
  id: string;
  tenant_id: string;
  agent_id: string;
  goal: string;
  verifiers: MissionVerifier[];
  budget: MissionBudget;
  status: MissionStatus;
  iteration: number;
  active_session_id: string | null;
  workspace: string;
  last_verdict: MissionVerdict | null;
  recent_verdicts: MissionVerdict[];
  created_at: number;
  updated_at: number;
  stopped_at: number | null;
}

interface RawMissionRow {
  id: string;
  tenant_id: string;
  agent_id: string;
  goal: string;
  verifiers: string;
  budget: string;
  status: string;
  iteration: number;
  active_session_id: string | null;
  workspace: string;
  last_verdict: string | null;
  recent_verdicts: string | null;
  created_at: number;
  updated_at: number;
  stopped_at: number | null;
}

/** How many verdicts the recent_verdicts ring keeps (stuck rule needs 3). */
const RECENT_VERDICTS_CAP = 10;

export function newMissionId(): string {
  return `mis-${nanoid()}`;
}

function parseRow(raw: RawMissionRow): MissionRow {
  return {
    ...raw,
    status: raw.status as MissionStatus,
    iteration: Number(raw.iteration),
    verifiers: JSON.parse(raw.verifiers) as MissionVerifier[],
    budget: JSON.parse(raw.budget) as MissionBudget,
    last_verdict: raw.last_verdict ? (JSON.parse(raw.last_verdict) as MissionVerdict) : null,
    recent_verdicts: raw.recent_verdicts
      ? (JSON.parse(raw.recent_verdicts) as MissionVerdict[])
      : [],
    created_at: Number(raw.created_at),
    updated_at: Number(raw.updated_at),
    stopped_at: raw.stopped_at === null ? null : Number(raw.stopped_at),
  };
}

export class MissionStore {
  constructor(private readonly sql: SqlClient) {}

  async ensureSchema(): Promise<void> {
    await this.sql.exec(`CREATE TABLE IF NOT EXISTS missions (
      id text PRIMARY KEY,
      tenant_id text NOT NULL,
      agent_id text NOT NULL,
      goal text NOT NULL,
      verifiers text NOT NULL,
      budget text NOT NULL,
      status text NOT NULL DEFAULT 'running',
      iteration int NOT NULL DEFAULT 0,
      active_session_id text,
      workspace text NOT NULL,
      last_verdict text,
      recent_verdicts text,
      created_at bigint NOT NULL,
      updated_at bigint NOT NULL,
      stopped_at bigint
    )`);
    await this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_missions_tenant_status ON missions (tenant_id, status)`,
    );
  }

  async create(opts: {
    tenantId: string;
    agentId: string;
    goal: string;
    verifiers: MissionVerifier[];
    budget: MissionBudget;
    workspace: string;
    /** Caller-minted id — the route mkdirs the workspace (named after the
     *  id) BEFORE inserting so the supervisor never sees a dirless row. */
    id?: string;
  }): Promise<MissionRow> {
    const now = Date.now();
    const row: MissionRow = {
      id: opts.id ?? newMissionId(),
      tenant_id: opts.tenantId,
      agent_id: opts.agentId,
      goal: opts.goal,
      verifiers: opts.verifiers,
      budget: opts.budget,
      status: "running",
      iteration: 0,
      active_session_id: null,
      workspace: opts.workspace,
      last_verdict: null,
      recent_verdicts: [],
      created_at: now,
      updated_at: now,
      stopped_at: null,
    };
    await this.sql
      .prepare(
        `INSERT INTO missions (id, tenant_id, agent_id, goal, verifiers, budget, status,
           iteration, active_session_id, workspace, last_verdict, recent_verdicts,
           created_at, updated_at, stopped_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.id,
        row.tenant_id,
        row.agent_id,
        row.goal,
        JSON.stringify(row.verifiers),
        JSON.stringify(row.budget),
        row.status,
        row.iteration,
        null,
        row.workspace,
        null,
        JSON.stringify([]),
        row.created_at,
        row.updated_at,
        null,
      )
      .run();
    return row;
  }

  async list(tenantId: string): Promise<MissionRow[]> {
    const res = await this.sql
      .prepare(`SELECT * FROM missions WHERE tenant_id = ? ORDER BY created_at DESC`)
      .bind(tenantId)
      .all<RawMissionRow>();
    return (res.results ?? []).map(parseRow);
  }

  async get(tenantId: string, id: string): Promise<MissionRow | null> {
    const raw = await this.sql
      .prepare(`SELECT * FROM missions WHERE tenant_id = ? AND id = ?`)
      .bind(tenantId, id)
      .first<RawMissionRow>();
    return raw ? parseRow(raw) : null;
  }

  /** Cross-tenant sweep source for the supervisor pump. */
  async listRunning(limit = 50): Promise<MissionRow[]> {
    const res = await this.sql
      .prepare(
        `SELECT * FROM missions WHERE status = 'running' ORDER BY updated_at ASC LIMIT ?`,
      )
      .bind(limit)
      .all<RawMissionRow>();
    return (res.results ?? []).map(parseRow);
  }

  async update(
    tenantId: string,
    id: string,
    fields: {
      status?: MissionStatus;
      iteration?: number;
      /** Pass null to clear. */
      active_session_id?: string | null;
      last_verdict?: MissionVerdict;
      recent_verdicts?: MissionVerdict[];
      stopped_at?: number;
    },
  ): Promise<void> {
    const set: string[] = ["updated_at = ?"];
    const binds: unknown[] = [Date.now()];
    if (fields.status !== undefined) {
      set.push("status = ?");
      binds.push(fields.status);
    }
    if (fields.iteration !== undefined) {
      set.push("iteration = ?");
      binds.push(fields.iteration);
    }
    if (fields.active_session_id !== undefined) {
      set.push("active_session_id = ?");
      binds.push(fields.active_session_id);
    }
    if (fields.last_verdict !== undefined) {
      set.push("last_verdict = ?");
      binds.push(JSON.stringify(fields.last_verdict));
    }
    if (fields.recent_verdicts !== undefined) {
      set.push("recent_verdicts = ?");
      binds.push(JSON.stringify(fields.recent_verdicts.slice(-RECENT_VERDICTS_CAP)));
    }
    if (fields.stopped_at !== undefined) {
      set.push("stopped_at = ?");
      binds.push(fields.stopped_at);
    }
    binds.push(tenantId, id);
    await this.sql
      .prepare(`UPDATE missions SET ${set.join(", ")} WHERE tenant_id = ? AND id = ?`)
      .bind(...binds)
      .run();
  }
}
