// Mission supervisor pump — the outer loop above the harness.
//
// Every sweep (node scheduler, ~15s) walks 'running' missions and drives
// each through the pure decision function (mission-decision.ts):
//
//   active session working  → wait
//   active session finished → run verifiers (sh -c, cwd = workspace,
//                             exit 0 = pass), record the verdict on the
//                             mission row AND as a system.mission_verdict
//                             event on that session, then succeed / exhaust
//                             / stuck / clear-for-respawn
//   no active session       → spawn iteration N+1: fresh session (same
//                             snapshot recipe as ambient dispatch), opening
//                             user.message carrying the goal, workspace
//                             path, budget status, and the previous
//                             verdict's failing output
//
// One active session per mission (Phase 1 — no parallel iterations). The
// pump is strictly sequential within a sweep, so no per-mission locking is
// needed on the single-instance Node deployment.
//
// TODO(missions-phase2): token-budget enforcement — Phase 1 only enforces
// iterations + wall-clock; per-mission token accounting needs usage rows
// aggregated across iteration sessions.

import { execFile } from "node:child_process";
import type { AgentService } from "@open-managed-agents/agents-store";
import type { SessionService } from "@open-managed-agents/sessions-store";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type { SessionEvent, UserMessageEvent } from "@open-managed-agents/shared";
import { getLogger } from "@open-managed-agents/observability";
import type { MissionStore, MissionRow } from "./missions.js";
import {
  decideMissionAction,
  VERIFIER_TIMEOUT_CEILING_MS,
  type MissionVerdict,
  type MissionVerdictResult,
  type MissionVerifier,
} from "./mission-decision.js";

const log = getLogger("mission-supervisor");

const DEFAULT_VERIFIER_TIMEOUT_MS = 120_000;
const OUTPUT_SNIPPET_BYTES = 2 * 1024;
/** A freshly spawned session sits 'idle' until its first turn begins. Treat
 *  it as still working for this long so we don't verify an untouched
 *  workspace; past the grace window assume the turn will never start (work
 *  queue wedged / harness missing) and verify anyway so the mission can't
 *  hang forever. */
const TURN_START_GRACE_MS = 10 * 60_000;

export interface CommandResult {
  exitCode: number;
  output: string;
}

export interface MissionSupervisorDeps {
  missions: MissionStore;
  agents: AgentService;
  sessions: SessionService;
  /** Raw sessions-row reads (status/turn timing) — same lever the session
   *  router uses; the store service doesn't expose turn columns. */
  sql: SqlClient;
  /** Append a user.message via NodeSessionRouter so the harness runs a turn
   *  (same hook ambient dispatch uses). */
  appendUserEvent(
    sessionId: string,
    tenantId: string,
    agentId: string,
    event: UserMessageEvent,
  ): Promise<void>;
  /** Append a non-turn system event (the verdict frame). */
  appendSessionEvent(sessionId: string, event: SessionEvent): Promise<void>;
  /** Same vault→MCP-server derivation ambient dispatch performs so mission
   *  sessions get the agent's integration tools. */
  resolveVaultMcpServers?(
    tenantId: string,
    vaultIds: string[],
  ): Promise<Array<{ name: string; type: "url"; url: string }>>;
  /** Verifier command runner — injectable for tests. Defaults to
   *  `sh -c <command>` on the host with cwd = the mission workspace. */
  runCommand?(command: string, cwd: string, timeoutMs: number): Promise<CommandResult>;
  now?(): number;
}

function hostRunCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(
      "sh",
      ["-c", command],
      { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        const output = `${stdout ?? ""}${stderr ?? ""}`;
        if (!err) {
          resolve({ exitCode: 0, output });
          return;
        }
        const e = err as { code?: number | string | null; killed?: boolean };
        const exitCode = typeof e.code === "number" ? e.code : 1;
        resolve({
          exitCode,
          output: e.killed ? `${output}\n[verifier timed out after ${timeoutMs}ms]` : output,
        });
      },
    );
  });
}

export class NodeMissionSupervisor {
  constructor(private readonly deps: MissionSupervisorDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** One sweep. Returns how many missions took an action (verify or spawn). */
  async tick(limit = 25): Promise<number> {
    const missions = await this.deps.missions.listRunning(limit);
    let acted = 0;
    for (const mission of missions) {
      try {
        if (await this.step(mission)) acted++;
      } catch (err) {
        log.warn(
          { err, op: "mission.step_failed", mission_id: mission.id },
          "mission supervisor step failed",
        );
      }
    }
    return acted;
  }

  private async step(stale: MissionRow): Promise<boolean> {
    // Re-read the row: the sweep list was fetched at tick start, and an
    // earlier mission's verifiers can block for minutes — a stop issued
    // mid-sweep must be honored before this mission acts on stale state.
    const mission = await this.deps.missions.get(stale.tenant_id, stale.id);
    if (!mission || mission.status !== "running") return false;
    const nowMs = this.now();
    const activeSession = mission.active_session_id
      ? await this.getSessionState(mission.active_session_id, nowMs)
      : null;

    const action = decideMissionAction({
      status: mission.status,
      iteration: mission.iteration,
      budget: mission.budget,
      createdAt: mission.created_at,
      now: nowMs,
      activeSession,
      verdictHistory: mission.recent_verdicts,
    });

    switch (action) {
      case "wait":
        return false;
      case "verify":
        await this.verify(mission, nowMs);
        return true;
      case "spawn":
        await this.spawnIteration(mission, nowMs);
        return true;
      case "exhaust":
        // Wall-clock ran out between iterations (no fresh verdict needed).
        await this.deps.missions.update(mission.tenant_id, mission.id, {
          status: "budget_exhausted",
          active_session_id: null,
        });
        return true;
      default:
        // succeed/stuck only arise post-verify (freshVerdict path).
        return false;
    }
  }

  /** Map a sessions row onto the decision function's coarse session state. */
  private async getSessionState(
    sessionId: string,
    nowMs: number,
  ): Promise<{ state: "working" | "finished" }> {
    const row = await this.deps.sql
      .prepare(`SELECT status, created_at, updated_at FROM sessions WHERE id = ?`)
      .bind(sessionId)
      .first<{ status: string; created_at: number; updated_at: number | null }>();
    // Row gone (session deleted out from under the mission) — treat as
    // finished so the loop verifies + moves on rather than stalling.
    if (!row) return { state: "finished" };
    if (row.status === "running") return { state: "working" };
    if (row.status === "idle") {
      // updated_at moves at beginTurn/endTurn; equal to created_at means no
      // turn has started yet — wait out the grace window before assuming
      // the session will never run.
      const turnRan = row.updated_at !== null && Number(row.updated_at) > Number(row.created_at);
      if (!turnRan && nowMs - Number(row.created_at) < TURN_START_GRACE_MS) {
        return { state: "working" };
      }
    }
    return { state: "finished" };
  }

  private async verify(mission: MissionRow, nowMs: number): Promise<void> {
    const run = this.deps.runCommand ?? hostRunCommand;
    const results: MissionVerdictResult[] = [];
    for (const verifier of mission.verifiers as MissionVerifier[]) {
      // Clamp regardless of what the row says — the sweep is sequential, so
      // a runaway timeout starves every other mission.
      const timeoutMs = Math.min(
        verifier.timeout_ms ?? DEFAULT_VERIFIER_TIMEOUT_MS,
        VERIFIER_TIMEOUT_CEILING_MS,
      );
      let res: CommandResult;
      try {
        res = await run(verifier.command, mission.workspace, timeoutMs);
      } catch (err) {
        res = { exitCode: 1, output: err instanceof Error ? err.message : "verifier failed" };
      }
      results.push({
        command: verifier.command,
        pass: res.exitCode === 0,
        output_snippet: res.output.slice(0, OUTPUT_SNIPPET_BYTES),
      });
    }
    const verdict: MissionVerdict = {
      iteration: mission.iteration,
      results,
      all_pass: results.every((r) => r.pass),
      judge: "skipped",
      at: new Date(nowMs).toISOString(),
    };
    const history = [...mission.recent_verdicts, verdict];

    if (mission.active_session_id) {
      await this.deps
        .appendSessionEvent(mission.active_session_id, {
          type: "system.mission_verdict",
          mission_id: mission.id,
          iteration: verdict.iteration,
          all_pass: verdict.all_pass,
          results: verdict.results,
          judge: "skipped",
        } as SessionEvent)
        .catch((err) => {
          log.warn(
            { err, op: "mission.verdict_event_failed", mission_id: mission.id },
            "verdict event append failed — verdict still persists on the mission row",
          );
        });
    }

    // Verifiers may have run for minutes — re-read status so a stop issued
    // meanwhile isn't clobbered by a terminal transition. The verdict itself
    // still persists below (harmless + informative on a stopped mission).
    const current = await this.deps.missions.get(mission.tenant_id, mission.id);
    const stillRunning = current?.status === "running";

    const outcome = decideMissionAction({
      status: mission.status,
      iteration: mission.iteration,
      budget: mission.budget,
      createdAt: mission.created_at,
      now: nowMs,
      activeSession: { state: "finished" },
      verdictHistory: history,
      freshVerdict: verdict,
    });
    const base = { last_verdict: verdict, recent_verdicts: history };
    if (!stillRunning) {
      await this.deps.missions.update(mission.tenant_id, mission.id, {
        ...base,
        active_session_id: null,
      });
      log.info(
        { op: "mission.verified_after_stop", mission_id: mission.id, iteration: verdict.iteration },
        "mission left running state mid-verify — verdict recorded, status untouched",
      );
      return;
    }
    if (outcome === "succeed") {
      await this.deps.missions.update(mission.tenant_id, mission.id, {
        ...base,
        status: "succeeded",
        active_session_id: null,
      });
    } else if (outcome === "exhaust") {
      await this.deps.missions.update(mission.tenant_id, mission.id, {
        ...base,
        status: "budget_exhausted",
        active_session_id: null,
      });
    } else if (outcome === "stuck") {
      await this.deps.missions.update(mission.tenant_id, mission.id, {
        ...base,
        status: "stuck",
        active_session_id: null,
      });
    } else {
      // spawn: clear the active session; the next sweep starts iteration N+1.
      await this.deps.missions.update(mission.tenant_id, mission.id, {
        ...base,
        active_session_id: null,
      });
    }
    log.info(
      {
        op: "mission.verified",
        mission_id: mission.id,
        iteration: verdict.iteration,
        all_pass: verdict.all_pass,
        outcome,
      },
      "mission verifiers ran",
    );
  }

  private async spawnIteration(mission: MissionRow, nowMs: number): Promise<void> {
    const agent = await this.deps.agents.get({
      tenantId: mission.tenant_id,
      agentId: mission.agent_id,
    });
    if (!agent || agent.archived_at) {
      await this.deps.missions.update(mission.tenant_id, mission.id, {
        status: "stopped",
        stopped_at: nowMs,
        active_session_id: null,
      });
      log.warn(
        { op: "mission.agent_missing", mission_id: mission.id, agent_id: mission.agent_id },
        "mission agent missing or archived — mission stopped",
      );
      return;
    }

    const iteration = mission.iteration + 1;

    // Same snapshot recipe as ambient dispatch / InProcessSessionCreator:
    // strip tenant_id, synthesize a local-runtime env, inherit the agent's
    // default vaults and materialize their MCP servers into the snapshot.
    const agentBase = { ...agent } as Record<string, unknown>;
    delete agentBase.tenant_id;
    const environmentId = "env_local_runtime";
    const metaVaults = (agent.metadata as { default_vault_ids?: unknown } | undefined)
      ?.default_vault_ids;
    const vaultIds = Array.isArray(metaVaults)
      ? metaVaults.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];
    if (vaultIds.length > 0 && this.deps.resolveVaultMcpServers) {
      try {
        const derived = await this.deps.resolveVaultMcpServers(mission.tenant_id, vaultIds);
        const existing = Array.isArray(agentBase.mcp_servers)
          ? (agentBase.mcp_servers as Array<{ url?: string }>)
          : [];
        const known = new Set(existing.map((s) => s.url));
        const merged = [...existing, ...derived.filter((s) => !known.has(s.url))];
        if (merged.length > 0) agentBase.mcp_servers = merged;
      } catch (err) {
        log.warn(
          { err, op: "mission.vault_mcp_resolve_failed", mission_id: mission.id },
          "vault MCP resolution failed — iteration starts without integration tools",
        );
      }
    }

    // Last look before committing to a spawn — a stop can land during the
    // agent fetch / vault resolution above.
    const current = await this.deps.missions.get(mission.tenant_id, mission.id);
    if (current?.status !== "running") return;

    const { session } = await this.deps.sessions.create({
      tenantId: mission.tenant_id,
      agentId: mission.agent_id,
      environmentId,
      title: `Mission ${mission.id} · iteration ${iteration}`,
      ...(vaultIds.length > 0 ? { vaultIds } : {}),
      agentSnapshot: agentBase as never,
      environmentSnapshot: {
        id: environmentId,
        runtime: "local",
        sandbox_template: null,
      } as never,
      metadata: { mission_id: mission.id, mission_iteration: iteration },
    });

    const event: UserMessageEvent = {
      type: "user.message",
      // Deterministic per (mission, iteration): the work queue's unique
      // (session_id, event_id) index turns crash-retries into no-ops.
      id: `sevt_mis_${mission.id}_${iteration}`,
      content: [{ type: "text", text: buildIterationPrompt(mission, iteration) }],
      metadata: {
        kind: "mission_iteration",
        mission_id: mission.id,
        mission_iteration: iteration,
      },
    } as UserMessageEvent;
    await this.deps.appendUserEvent(session.id, mission.tenant_id, mission.agent_id, event);

    await this.deps.missions.update(mission.tenant_id, mission.id, {
      iteration,
      active_session_id: session.id,
    });
    log.info(
      {
        op: "mission.iteration_spawned",
        mission_id: mission.id,
        iteration,
        session_id: session.id,
      },
      "mission iteration spawned",
    );
  }
}

export function buildIterationPrompt(mission: MissionRow, iteration: number): string {
  const lines = [
    `[Mission ${mission.id} — iteration ${iteration} of ${mission.budget.max_iterations}]`,
    "",
    `Goal: ${mission.goal}`,
    "",
    `Workspace: ${mission.workspace}`,
    "Do ALL work under this directory — it persists across iterations, and " +
      "the mission's verifier commands run there after your turn ends.",
    "",
    "When your turn ends, these checks must exit 0:",
    ...mission.verifiers.map((v) => `  - ${v.command}`),
  ];
  const failing = (mission.last_verdict?.results ?? []).filter((r) => !r.pass);
  if (failing.length > 0) {
    lines.push("", "Previous attempt failed these checks:");
    for (const r of failing) {
      lines.push(`  - ${r.command}`);
      const snippet = r.output_snippet.trim();
      if (snippet) {
        lines.push(
          ...snippet
            .split("\n")
            .slice(0, 20)
            .map((l) => `      ${l}`),
        );
      }
    }
  }
  return lines.join("\n");
}
