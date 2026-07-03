// In-session ambient rule tools — verify the shared buildTools builder
// registers create/list/delete_ambient_rule when the runtime provides the
// env closures (as main-node does), executes through them, and that an
// agent-created rule is immediately live for the dispatcher.

import { describe, it, expect } from "vitest";
import { buildTools } from "@open-managed-agents/agent/harness/tools";
import { createInMemoryAmbientRuleService } from "@open-managed-agents/agents-store/test-fakes";
import { Cron } from "croner";

const AGENT_CFG = {
  id: "agent_tools_test",
  name: "ToolsTest",
  model: "claude-sonnet-4-6",
  system: "test",
  tools: [{ type: "agent_toolset_20260401" }],
  version: 1,
  created_at: new Date().toISOString(),
} as never;

// Minimal sandbox stand-in — the ambient tools never touch it.
const SANDBOX = {
  exec: async () => ({ stdout: "", stderr: "", exit_code: 0 }),
} as never;

const EXEC_OPTS = { toolCallId: "tc_test", messages: [] } as never;

function buildEnv() {
  const { service } = createInMemoryAmbientRuleService();
  const TENANT = "tn_t";
  const env = {
    createAmbientRule: async (a: {
      name: string;
      description?: string;
      cron: string;
      timezone?: string;
      prompt: string;
      wake_mode?: "observe" | "decide" | "act" | "escalate";
    }) => {
      const timezone = a.timezone?.trim() || "UTC";
      const next = new Cron(a.cron, { timezone }).nextRun();
      if (!next) throw new Error("no future occurrence");
      const row = await service.create({
        tenantId: TENANT,
        agentId: "agent_tools_test",
        input: {
          name: a.name,
          trigger: { source: "schedule", config: { cron: a.cron, timezone, prompt: a.prompt } },
          wake_mode: a.wake_mode ?? "decide",
          next_wake_at: next.toISOString(),
          created_by: "session:sess_t",
        },
      });
      return { id: row.id, next_wake_at: row.next_wake_at };
    },
    listAmbientRules: async () => {
      const rows = await service.listByAgent({ tenantId: TENANT, agentId: "agent_tools_test" });
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        enabled: r.enabled,
        cron: typeof r.trigger.config?.cron === "string" ? (r.trigger.config.cron as string) : undefined,
        next_wake_at: r.next_wake_at,
        wake_mode: r.wake_mode,
      }));
    },
    deleteAmbientRule: async (id: string) => {
      await service.delete({ tenantId: TENANT, agentId: "agent_tools_test", ruleId: id });
      return { deleted: true };
    },
  };
  return { env, service };
}

describe("ambient rule tools via buildTools", () => {
  it("registers the tools only when the env closures are provided", async () => {
    const bare = await buildTools(AGENT_CFG, SANDBOX, {});
    expect(bare.create_ambient_rule).toBeUndefined();
    expect(bare.list_ambient_rules).toBeUndefined();
    expect(bare.delete_ambient_rule).toBeUndefined();

    const { env } = buildEnv();
    const tools = await buildTools(AGENT_CFG, SANDBOX, env as never);
    expect(tools.create_ambient_rule).toBeDefined();
    expect(tools.list_ambient_rules).toBeDefined();
    expect(tools.delete_ambient_rule).toBeDefined();
  });

  it("create → list → delete round-trip, with next_wake_at armed from the cron", async () => {
    const { env, service } = buildEnv();
    const tools = await buildTools(AGENT_CFG, SANDBOX, env as never);

    const created = await tools.create_ambient_rule.execute(
      {
        name: "Daily deep research: fusion startups",
        cron: "0 9 * * *",
        timezone: "UTC",
        prompt: "Run deep research on fusion startups and write the notes to Notion.",
        wake_mode: "act",
      },
      EXEC_OPTS,
    );
    expect(created.id).toMatch(/^ambrule-/);
    expect(created.next_wake_at).toBeTruthy();
    // Armed for the dispatcher: next occurrence is in the future.
    expect(Date.parse(created.next_wake_at)).toBeGreaterThan(Date.now());

    const listed = await tools.list_ambient_rules.execute({}, EXEC_OPTS);
    expect(listed.rules).toHaveLength(1);
    expect(listed.rules[0]).toMatchObject({
      name: "Daily deep research: fusion startups",
      enabled: true,
      cron: "0 9 * * *",
      wake_mode: "act",
    });

    // The stored rule carries the prompt for the dispatcher's wake message.
    const rows = await service.listByAgent({ tenantId: "tn_t", agentId: "agent_tools_test" });
    expect(rows[0].trigger.config?.prompt).toContain("fusion startups");

    const del = await tools.delete_ambient_rule.execute({ id: created.id }, EXEC_OPTS);
    expect(del.deleted).toBe(true);
    const after = await tools.list_ambient_rules.execute({}, EXEC_OPTS);
    expect(after.rules).toHaveLength(0);
  });

  it("surfaces bad cron as a tool error, not a crash", async () => {
    const { env } = buildEnv();
    const tools = await buildTools(AGENT_CFG, SANDBOX, env as never);
    const out = await tools.create_ambient_rule.execute(
      { name: "x", cron: "not-a-cron", prompt: "y" },
      EXEC_OPTS,
    );
    // tools.ts wraps execute in safe() — errors come back as {error} strings.
    expect(JSON.stringify(out)).toMatch(/error/i);
  });
});
