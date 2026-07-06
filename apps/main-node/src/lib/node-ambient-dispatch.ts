// Ambient rule dispatcher — the piece that makes ambient rules FIRE.
//
// Rules (packages/agents-store ambient-*) describe when an agent may wake
// on its own: `next_wake_at` is the due column, `trigger.config.cron` (for
// schedule sources) describes recurrence. This sweep runs from the node
// scheduler: list due rules → start a session for the agent → inject a
// synthetic user.message through the same NodeSessionRouter path the
// public POST /events route uses (so the harness runs a real turn) →
// advance next_wake_at from the cron, or clear it for one-shots.
//
// Wake modes: `observe` records the wake without starting a session
// (cheap heartbeat bookkeeping); decide/act/escalate start a session and
// say so in the injected prompt. Event sources (slack/github/webhook/…)
// are dispatched by their own inbound handlers — this sweep only fires
// time-based wakes, which is why it filters on next_wake_at via listDue.
//
// Session creation mirrors InProcessSessionCreator (node-install-bridge):
// snapshot the agent, synthesize a local-runtime env snapshot, tag
// metadata.ambient with the rule id so the console can trace provenance.

import { Cron } from "croner";
import type {
  AgentService,
  AmbientRuleService,
  AmbientRuleRow,
} from "@open-managed-agents/agents-store";
import type { SessionService } from "@open-managed-agents/sessions-store";
import type { UserMessageEvent } from "@open-managed-agents/shared";
import { getLogger } from "@open-managed-agents/observability";

const log = getLogger("ambient-dispatch");

export interface AmbientDispatcherDeps {
  ambientRules: AmbientRuleService;
  agents: AgentService;
  sessions: SessionService;
  /** Same hook the integrations bridge uses — append a user.message via
   *  NodeSessionRouter so the harness runs a turn. */
  appendUserEvent(
    sessionId: string,
    tenantId: string,
    agentId: string,
    event: UserMessageEvent,
  ): Promise<void>;
  /** Derive MCP server entries from the vaults' credentials (Composio
   *  tool-router URLs). Console sessions get these injected into the
   *  snapshot at create time by the client; ambient sessions must do the
   *  equivalent server-side or the spawned agent has no integration
   *  tools (GitHub/Linear/Notion) even though the vault creds attach. */
  resolveVaultMcpServers?(
    tenantId: string,
    vaultIds: string[],
  ): Promise<Array<{ name: string; type: "url"; url: string }>>;
  now?(): number;
}

export class NodeAmbientDispatcher {
  constructor(private readonly deps: AmbientDispatcherDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** One sweep. Returns how many rules fired (observe wakes count). */
  async dispatchDue(limit = 25): Promise<number> {
    const nowMs = this.now();
    const due = await this.deps.ambientRules.listDue({ now: nowMs, limit });
    let fired = 0;
    for (const rule of due) {
      try {
        await this.fireRule(rule, nowMs);
        fired++;
      } catch (err) {
        log.warn(
          { err, op: "ambient.dispatch_failed", rule_id: rule.id, agent_id: rule.agent_id },
          "ambient rule dispatch failed",
        );
        // Advance/clear the wake anyway — a permanently broken rule must
        // not hot-loop the sweep every tick.
        await this.finishRule(rule, nowMs, {
          outcome: "error",
          decided_at: new Date(nowMs).toISOString(),
          reason: err instanceof Error ? err.message : "dispatch failed",
        }).catch(() => {});
      }
    }
    return fired;
  }

  private async fireRule(rule: AmbientRuleRow, nowMs: number): Promise<void> {
    const decidedAt = new Date(nowMs).toISOString();

    if (rule.wake_mode === "observe") {
      await this.finishRule(rule, nowMs, { outcome: "observe", decided_at: decidedAt });
      return;
    }

    const agent = await this.deps.agents.get({
      tenantId: rule.tenant_id,
      agentId: rule.agent_id,
    });
    if (!agent || agent.archived_at) {
      await this.finishRule(
        rule,
        nowMs,
        { outcome: "error", decided_at: decidedAt, reason: "agent missing or archived" },
        // Stop rescheduling a rule whose agent is gone.
        { forceClearNextWake: true },
      );
      return;
    }

    // Same snapshot recipe as InProcessSessionCreator: strip tenant_id,
    // synthesize a local-runtime env (main-node accepts any env id).
    const agentBase = { ...agent } as Record<string, unknown>;
    delete agentBase.tenant_id;
    const environmentId = "env_local_runtime";
    // Inherit the agent's default vaults — same fallback the sessions
    // route applies when vault_ids is omitted. Without this, ambient
    // sessions had no credentials and integration workflows (GitHub /
    // Linear / Notion via vault MCP creds) silently couldn't act.
    const metaVaults = (agent.metadata as { default_vault_ids?: unknown } | undefined)
      ?.default_vault_ids;
    const vaultIds = Array.isArray(metaVaults)
      ? metaVaults.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];
    // Materialize vault-derived MCP servers into the snapshot — parity
    // with console-created sessions, where the client injects the
    // Composio tool-router entry. Config-declared servers keep priority;
    // vault-derived ones are appended (deduped by url).
    if (vaultIds.length > 0 && this.deps.resolveVaultMcpServers) {
      try {
        const derived = await this.deps.resolveVaultMcpServers(rule.tenant_id, vaultIds);
        const existing = Array.isArray(agentBase.mcp_servers)
          ? (agentBase.mcp_servers as Array<{ url?: string }>)
          : [];
        const known = new Set(existing.map((s) => s.url));
        const merged = [...existing, ...derived.filter((s) => !known.has(s.url))];
        if (merged.length > 0) agentBase.mcp_servers = merged;
      } catch (err) {
        log.warn(
          { err, op: "ambient.vault_mcp_resolve_failed", rule_id: rule.id },
          "vault MCP resolution failed — session starts without integration tools",
        );
      }
    }
    const { session } = await this.deps.sessions.create({
      tenantId: rule.tenant_id,
      agentId: rule.agent_id,
      environmentId,
      title: `Ambient: ${rule.name}`,
      ...(vaultIds.length > 0 ? { vaultIds } : {}),
      agentSnapshot: agentBase as never,
      environmentSnapshot: {
        id: environmentId,
        runtime: "local",
        sandbox_template: null,
      } as never,
      metadata: { ambient: { rule_id: rule.id, wake_mode: rule.wake_mode } },
    });

    const event: UserMessageEvent = {
      type: "user.message",
      // Deterministic per (rule, occurrence): work-queue's unique
      // (session_id, event_id) index turns crash-retries into no-ops.
      id: `sevt_amb_${rule.id}_${nowMs}`,
      content: [{ type: "text", text: buildWakePrompt(rule) }],
      metadata: {
        kind: "ambient_wake",
        ambient_rule_id: rule.id,
        wake_mode: rule.wake_mode,
        fired_at: decidedAt,
      },
    } as UserMessageEvent;
    await this.deps.appendUserEvent(session.id, rule.tenant_id, rule.agent_id, event);

    await this.finishRule(rule, nowMs, {
      outcome: "create_session",
      decided_at: decidedAt,
      session_id: session.id,
    });
    log.info(
      {
        op: "ambient.rule_fired",
        rule_id: rule.id,
        agent_id: rule.agent_id,
        session_id: session.id,
        wake_mode: rule.wake_mode,
      },
      "ambient rule fired",
    );
  }

  /** Stamp last_wake/last_decision and advance next_wake_at (cron) or
   *  clear it (one-shot). forceClearNextWake DISABLES the rule as well —
   *  the service re-arms any enabled schedule rule with an empty wake
   *  (the dormant-rule fix), so "stop firing permanently" must flip
   *  enabled off, which is also the honest UI state for an orphan rule. */
  private async finishRule(
    rule: AmbientRuleRow,
    nowMs: number,
    decision: { outcome: "observe" | "create_session" | "error"; decided_at: string; reason?: string; session_id?: string },
    opts?: { forceClearNextWake?: boolean },
  ): Promise<void> {
    const next = opts?.forceClearNextWake ? null : computeNextWake(rule, nowMs);
    await this.deps.ambientRules.update({
      tenantId: rule.tenant_id,
      agentId: rule.agent_id,
      ruleId: rule.id,
      input: {
        last_wake_at: new Date(nowMs).toISOString(),
        next_wake_at: next ? new Date(next).toISOString() : null,
        last_decision: decision,
        ...(opts?.forceClearNextWake ? { enabled: false } : {}),
      },
    });
  }
}

/** Next occurrence for schedule rules ({cron, timezone} in trigger.config);
 *  null for everything else (event sources fire via their own inbound
 *  paths; a rule armed manually via next_wake_at is one-shot). */
export function computeNextWake(rule: AmbientRuleRow, nowMs: number): number | null {
  if (rule.trigger.source !== "schedule") return null;
  const config = rule.trigger.config ?? {};
  const cron = typeof config.cron === "string" ? config.cron.trim() : "";
  if (!cron) return null;
  const timezone = typeof config.timezone === "string" ? config.timezone : undefined;
  try {
    const next = new Cron(cron, { timezone }).nextRun(new Date(nowMs));
    return next ? next.getTime() : null;
  } catch (err) {
    log.warn(
      { err, op: "ambient.bad_cron", rule_id: rule.id, cron },
      "ambient rule has an unparseable cron — treating as one-shot",
    );
    return null;
  }
}

export function buildWakePrompt(rule: AmbientRuleRow): string {
  const config = rule.trigger.config ?? {};
  const custom = typeof config.prompt === "string" ? config.prompt.trim() : "";
  if (custom) return custom;
  const lines = [
    `[Ambient wake] Rule "${rule.name}" fired.`,
    ...(rule.description ? [rule.description] : []),
    rule.wake_mode === "act"
      ? "Take the appropriate action now, then summarize what you did."
      : rule.wake_mode === "escalate"
        ? "Assess the situation; if anything needs a human, say so explicitly and stop."
        : "Decide whether anything needs doing. If nothing does, reply briefly that all is quiet.",
  ];
  return lines.join("\n");
}
