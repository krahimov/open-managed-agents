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

function build(opts?: { agentMissing?: boolean }) {
  const { service: ambientRules } = createInMemoryAmbientRuleService({
    clock: { nowMs: () => T0 },
  });
  const created: Array<{ agentId: string; title?: string; metadata?: unknown }> = [];
  const appended: Array<{ sessionId: string; text: string }> = [];
  let now = T0;

  const agents = {
    get: async ({ agentId }: { tenantId: string; agentId: string }) =>
      opts?.agentMissing ? null : { id: agentId, name: "a", archived_at: null },
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
    expect(rule.next_wake_at).toBeUndefined();
    expect(await tm.dispatcher.dispatchDue()).toBe(0);
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
