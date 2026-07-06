// Ambient dispatcher — unit tests over the in-memory ambient rule repo.
// The dispatcher's session/agent/append deps are tiny fakes: what matters
// here is the sweep semantics (due selection, next-wake advancement, wake
// modes, one-shot clearing, error handling).

import { describe, it, expect, beforeEach } from "vitest";
import { createInMemoryAmbientRuleService } from "@open-managed-agents/agents-store/test-fakes";
import type { AgentService } from "@open-managed-agents/agents-store";
import type { SessionService } from "@open-managed-agents/sessions-store";
import {
  NodeAmbientDispatcher,
  buildWakePrompt,
  computeNextWake,
} from "../src/lib/node-ambient-dispatch";

const T0 = Date.parse("2026-07-02T09:00:00.000Z");

function build(opts?: { agentMissing?: boolean; agentMetadata?: Record<string, unknown> }) {
  const { service: ambientRules } = createInMemoryAmbientRuleService({
    clock: { nowMs: () => T0 },
  });
  const created: Array<{ agentId: string; title?: string; metadata?: unknown; vaultIds?: string[] }> = [];
  const appended: Array<{ sessionId: string; text: string }> = [];
  let now = T0;

  const agents = {
    get: async ({ agentId }: { tenantId: string; agentId: string }) =>
      opts?.agentMissing
        ? null
        : { id: agentId, name: "a", archived_at: null, metadata: opts?.agentMetadata },
  } as unknown as AgentService;
  const sessions = {
    create: async (input: { agentId: string; title?: string; metadata?: unknown }) => {
      created.push(input);
      return {
        session: { id: `sess_${created.length}` },
        resources: [],
      };
    },
  } as unknown as SessionService;

  const dispatcher = new NodeAmbientDispatcher({
    ambientRules,
    agents,
    sessions,
    appendUserEvent: async (sessionId, _t, _a, event) => {
      const content = (event as { content: Array<{ text: string }> }).content;
      appended.push({ sessionId, text: content[0]?.text ?? "" });
    },
    now: () => now,
  });

  return {
    ambientRules,
    dispatcher,
    created,
    appended,
    setNow: (ms: number) => {
      now = ms;
    },
  };
}

const TENANT = "tn_test";
const AGENT = "agent_1";

describe("NodeAmbientDispatcher", () => {
  let t: ReturnType<typeof build>;

  beforeEach(() => {
    t = build();
  });

  it("fires a due schedule rule: session + message + cron advance", async () => {
    await t.ambientRules.create({
      tenantId: TENANT,
      agentId: AGENT,
      input: {
        name: "Morning sweep",
        description: "Check the inbox",
        trigger: { source: "schedule", config: { cron: "0 9 * * *", timezone: "UTC" } },
        wake_mode: "decide",
        next_wake_at: new Date(T0).toISOString(),
      },
    });

    const fired = await t.dispatcher.dispatchDue();
    expect(fired).toBe(1);
    expect(t.created).toHaveLength(1);
    expect(t.created[0].title).toBe("Ambient: Morning sweep");
    expect(t.appended[0].text).toContain('Rule "Morning sweep" fired');
    expect(t.appended[0].text).toContain("Check the inbox");

    const [rule] = await t.ambientRules.listByAgent({ tenantId: TENANT, agentId: AGENT });
    expect(rule.last_decision?.outcome).toBe("create_session");
    expect(rule.last_decision?.session_id).toBe("sess_1");
    // Next 9am UTC is tomorrow.
    expect(rule.next_wake_at).toBe("2026-07-03T09:00:00.000Z");
    expect(rule.last_wake_at).toBe(new Date(T0).toISOString());

    // Immediately re-sweeping finds nothing due.
    expect(await t.dispatcher.dispatchDue()).toBe(0);
  });

  it("observe mode records the wake without a session", async () => {
    await t.ambientRules.create({
      tenantId: TENANT,
      agentId: AGENT,
      input: {
        name: "Heartbeat",
        trigger: { source: "schedule", config: { cron: "0 * * * *", timezone: "UTC" } },
        wake_mode: "observe",
        next_wake_at: new Date(T0).toISOString(),
      },
    });
    expect(await t.dispatcher.dispatchDue()).toBe(1);
    expect(t.created).toHaveLength(0);
    const [rule] = await t.ambientRules.listByAgent({ tenantId: TENANT, agentId: AGENT });
    expect(rule.last_decision?.outcome).toBe("observe");
    expect(rule.next_wake_at).toBe("2026-07-02T10:00:00.000Z");
  });

  it("non-schedule sources are one-shot: next_wake_at clears after firing", async () => {
    await t.ambientRules.create({
      tenantId: TENANT,
      agentId: AGENT,
      input: {
        name: "Manual kick",
        trigger: { source: "manual", config: {} },
        wake_mode: "act",
        next_wake_at: new Date(T0).toISOString(),
      },
    });
    expect(await t.dispatcher.dispatchDue()).toBe(1);
    expect(t.created).toHaveLength(1);
    const [rule] = await t.ambientRules.listByAgent({ tenantId: TENANT, agentId: AGENT });
    expect(rule.next_wake_at).toBeUndefined();
    t.setNow(T0 + 60_000);
    expect(await t.dispatcher.dispatchDue()).toBe(0);
  });

  it("missing agent → error decision, wake cleared, no hot loop", async () => {
    const tm = build({ agentMissing: true });
    await tm.ambientRules.create({
      tenantId: TENANT,
      agentId: AGENT,
      input: {
        name: "Orphan",
        trigger: { source: "schedule", config: { cron: "0 9 * * *", timezone: "UTC" } },
        wake_mode: "decide",
        next_wake_at: new Date(T0).toISOString(),
      },
    });
    expect(await tm.dispatcher.dispatchDue()).toBe(1);
    expect(tm.created).toHaveLength(0);
    const [rule] = await tm.ambientRules.listByAgent({ tenantId: TENANT, agentId: AGENT });
    expect(rule.last_decision?.outcome).toBe("error");
    // Orphan rules are DISABLED (not just disarmed) — the service's
    // arming invariant would otherwise re-arm an enabled schedule rule.
    expect(rule.enabled).toBe(false);
    expect(rule.next_wake_at).toBeUndefined();
    expect(await tm.dispatcher.dispatchDue()).toBe(0);
  });

  it("spawned sessions inherit the agent's default_vault_ids (integration creds)", async () => {
    const tv = build({ agentMetadata: { default_vault_ids: ["vlt-cnb", "", 42] } });
    await tv.ambientRules.create({
      tenantId: TENANT,
      agentId: AGENT,
      input: {
        name: "Review with creds",
        trigger: { source: "schedule", config: { cron: "0 9 * * *", timezone: "UTC" } },
        wake_mode: "act",
        next_wake_at: new Date(T0).toISOString(),
      },
    });
    expect(await tv.dispatcher.dispatchDue()).toBe(1);
    expect(tv.created).toHaveLength(1);
    // Non-string/empty entries filtered; valid vault ids passed through.
    expect(tv.created[0].vaultIds).toEqual(["vlt-cnb"]);
  });

  it("omits vaultIds entirely when the agent has no defaults", async () => {
    await t.ambientRules.create({
      tenantId: TENANT,
      agentId: AGENT,
      input: {
        name: "No creds",
        trigger: { source: "schedule", config: { cron: "0 9 * * *", timezone: "UTC" } },
        wake_mode: "act",
        next_wake_at: new Date(T0).toISOString(),
      },
    });
    expect(await t.dispatcher.dispatchDue()).toBe(1);
    expect("vaultIds" in t.created[0]).toBe(false);
  });

  it("disabled rules never fire", async () => {
    await t.ambientRules.create({
      tenantId: TENANT,
      agentId: AGENT,
      input: {
        name: "Off",
        enabled: false,
        trigger: { source: "schedule", config: { cron: "0 9 * * *" } },
        next_wake_at: new Date(T0).toISOString(),
      },
    });
    expect(await t.dispatcher.dispatchDue()).toBe(0);
  });
});

describe("helpers", () => {
  it("computeNextWake honors timezone and bad crons", () => {
    const rule = (cron: string) =>
      ({
        id: "r",
        trigger: { source: "schedule", config: { cron, timezone: "UTC" } },
      }) as never;
    expect(computeNextWake(rule("0 9 * * *"), T0)).toBe(Date.parse("2026-07-03T09:00:00.000Z"));
    expect(computeNextWake(rule("not a cron"), T0)).toBeNull();
  });

  it("buildWakePrompt prefers config.prompt", () => {
    const custom = buildWakePrompt({
      name: "X",
      trigger: { source: "schedule", config: { prompt: "Check my email inbox" } },
      wake_mode: "act",
    } as never);
    expect(custom).toBe("Check my email inbox");
  });
});

describe("service-level arming (dormant-rule fix)", () => {
  it("arms schedule rules created without next_wake_at from the cron", async () => {
    const t = build();
    const rule = await t.ambientRules.create({
      tenantId: TENANT,
      agentId: AGENT,
      input: {
        name: "UI-created rule",
        trigger: { source: "schedule", config: { cron: "0 9 * * *", timezone: "UTC" } },
        wake_mode: "act",
        // note: NO next_wake_at — the console leaves it blank
      },
    });
    expect(rule.next_wake_at).toBe("2026-07-03T09:00:00.000Z");
  });

  it("does not arm disabled or non-schedule or cronless rules", async () => {
    const t = build();
    const disabled = await t.ambientRules.create({
      tenantId: TENANT, agentId: AGENT,
      input: { name: "off", enabled: false, trigger: { source: "schedule", config: { cron: "0 9 * * *" } } },
    });
    expect(disabled.next_wake_at).toBeUndefined();
    const webhook = await t.ambientRules.create({
      tenantId: TENANT, agentId: AGENT,
      input: { name: "wh", trigger: { source: "webhook", config: {} } },
    });
    expect(webhook.next_wake_at).toBeUndefined();
    const noCron = await t.ambientRules.create({
      tenantId: TENANT, agentId: AGENT,
      input: { name: "nc", trigger: { source: "schedule", config: {} } },
    });
    expect(noCron.next_wake_at).toBeUndefined();
  });

  it("re-arms on update when a schedule rule is enabled with no wake", async () => {
    const t = build();
    const rule = await t.ambientRules.create({
      tenantId: TENANT, agentId: AGENT,
      input: { name: "flip", enabled: false, trigger: { source: "schedule", config: { cron: "0 9 * * *", timezone: "UTC" } } },
    });
    expect(rule.next_wake_at).toBeUndefined();
    const enabled = await t.ambientRules.update({
      tenantId: TENANT, agentId: AGENT, ruleId: rule.id,
      input: { enabled: true },
    });
    expect(enabled.next_wake_at).toBe("2026-07-03T09:00:00.000Z");
  });
});

describe("vault MCP injection", () => {
  it("merges vault-derived servers into the spawned snapshot", async () => {
    const { service: ambientRules } = createInMemoryAmbientRuleService({ clock: { nowMs: () => T0 } });
    const created: Array<{ agentSnapshot?: { mcp_servers?: unknown } }> = [];
    const dispatcher = new NodeAmbientDispatcher({
      ambientRules,
      agents: {
        get: async () => ({
          id: AGENT, name: "a", archived_at: null,
          metadata: { default_vault_ids: ["vlt-cnb"] },
          mcp_servers: [{ name: "custom", type: "url", url: "https://example.com/mcp" }],
        }),
      } as never,
      sessions: {
        create: async (input: never) => { created.push(input); return { session: { id: "s1" }, resources: [] }; },
      } as never,
      appendUserEvent: async () => {},
      resolveVaultMcpServers: async (_t, vaultIds) => {
        expect(vaultIds).toEqual(["vlt-cnb"]);
        return [
          { name: "composio_gmail_notion", type: "url", url: "https://backend.composio.dev/tool_router/trs_x/mcp" },
          { name: "dupe", type: "url", url: "https://example.com/mcp" }, // deduped by url
        ];
      },
      now: () => T0,
    });
    await ambientRules.create({
      tenantId: TENANT, agentId: AGENT,
      input: { name: "with creds", trigger: { source: "schedule", config: { cron: "0 9 * * *", timezone: "UTC" } }, wake_mode: "act", next_wake_at: new Date(T0).toISOString() },
    });
    expect(await dispatcher.dispatchDue()).toBe(1);
    const snap = created[0].agentSnapshot as { mcp_servers: Array<{ name: string; url: string }> };
    expect(snap.mcp_servers.map((s) => s.name)).toEqual(["custom", "composio_gmail_notion"]);
  });
});
