import { describe, expect, it, vi } from "vitest";
import {
  claudeReasoning,
  isOpenAiReasoningModel,
  openAiReasoningEffort,
  modelSupportsReasoning,
  uiReasoningLevel,
  REASONING_LEVELS,
} from "@open-managed-agents/api-types";
import { generateEventId } from "@open-managed-agents/shared";
import type { AgentConfig, SessionEvent, UserMessageEvent } from "@open-managed-agents/shared";
import { SqlEventLog, ensureSchema as ensureEventLogSchema } from "@open-managed-agents/event-log/sql";
import type { SandboxExecutor } from "@open-managed-agents/sandbox";
import type { SandboxOrchestrator } from "@open-managed-agents/sandbox/orchestrator";
import { createSqliteAgentService } from "@open-managed-agents/agents-store";
import { createSqliteSessionService } from "@open-managed-agents/sessions-store";
import { createSqliteMemoryStoreService } from "@open-managed-agents/memory-store";
import { SessionRegistry } from "../src/registry";
import { applySessionModelOverride, readSessionModelOverride } from "../src/lib/session-model-override";
import { codexReasoningEffort } from "../src/lib/codex-sdk-harness";
import { claudeSdkReasoningOptions } from "../src/lib/claude-agent-sdk-harness";
import { invalidSessionModelOverride } from "../../../packages/http-routes/src/sessions/index";
import { bootstrapTestDb } from "./_helpers/bootstrap-test-db";

describe("isOpenAiReasoningModel — one rule for every GPT-5-era model", () => {
  it.each([
    "gpt-5",
    "gpt-5.5",
    "gpt-5.6-sol",
    "gpt-6-astra",
    "gpt-6.1-sol",
    "gpt-6.1-terra",
    "gpt-6-luna",
    "gpt-7",
    "gpt-12-mini",
    "o1",
    "o3",
    "o4-mini",
    "openai/gpt-6.1-sol",
    "GPT-6.1-SOL",
  ])("%s → reasoning", (id) => {
    expect(isOpenAiReasoningModel(id)).toBe(true);
  });

  it.each(["gpt-4o", "gpt-4.1", "gpt-4o-mini", "gpt-3.5-turbo", "gpt-5-chat-latest", "deepseek-chat", "llama-3.3-70b", "claude-opus-5-5", "omni-moderation"])(
    "%s → not reasoning",
    (id) => {
      expect(isOpenAiReasoningModel(id)).toBe(false);
    },
  );

  it("gateway cards never count as reasoning-capable (they ride chat/completions)", () => {
    expect(modelSupportsReasoning("oai-compatible", "gpt-6.1-sol")).toBe(false);
    expect(modelSupportsReasoning("ant-compatible", "claude-opus-5-5")).toBe(false);
    expect(modelSupportsReasoning("oai", "gpt-6.1-sol")).toBe(true);
    expect(modelSupportsReasoning("ant", "claude-opus-5-5")).toBe(true);
    expect(modelSupportsReasoning("oai", "gpt-4o")).toBe(false);
  });
});

describe("level mappings", () => {
  it("accepts the five UI levels plus legacy instant", () => {
    expect(REASONING_LEVELS).toEqual(["instant", "low", "medium", "high", "xhigh", "max"]);
    expect(uiReasoningLevel(undefined)).toBe("medium");
    expect(uiReasoningLevel("instant")).toBe("low");
  });

  it.each([
    ["gpt-6.1-sol", undefined, "medium"],
    ["gpt-6.1-sol", "low", "low"],
    ["gpt-6.1-sol", "high", "high"],
    ["gpt-6.1-sol", "xhigh", "xhigh"],
    ["gpt-6.1-sol", "max", "xhigh"],
    ["gpt-5.2", "max", "xhigh"],
    ["gpt-5.1", "max", "high"],
    ["gpt-5", "xhigh", "high"],
    ["gpt-5.1-codex-max", "max", "xhigh"],
    ["o3", "max", "high"],
    ["gpt-5-pro", "low", "high"],
    ["gpt-6-astra", "instant", "low"],
  ] as const)("OpenAI %s @ %s → %s", (model, level, effort) => {
    expect(openAiReasoningEffort(model, level)).toBe(effort);
  });

  it.each([
    ["claude-opus-5-5", "max", { mode: "adaptive", effort: "max" }],
    ["claude-opus-5-5", "xhigh", { mode: "adaptive", effort: "xhigh" }],
    ["claude-opus-5-5", "instant", { mode: "adaptive", effort: "low" }],
    ["claude-sonnet-5-5", undefined, { mode: "adaptive", effort: "medium" }],
    ["claude-haiku-5-5", "high", { mode: "adaptive", effort: "high" }],
    ["claude-fable-5-1", "low", { mode: "adaptive", effort: "low" }],
    ["claude-opus-4-8", "instant", { mode: "off" }],
    ["claude-opus-4-7", "xhigh", { mode: "adaptive", effort: "xhigh" }],
    ["claude-sonnet-4-6", "xhigh", { mode: "adaptive", effort: "high" }],
    ["claude-sonnet-4.6", "max", { mode: "adaptive", effort: "max" }],
    ["claude-haiku-4-5-20251001", "medium", { mode: "budget", budgetTokens: 16384 }],
    ["claude-3-5-sonnet-20241022", "max", { mode: "budget", budgetTokens: 1024 }],
  ] as const)("Claude %s @ %s", (model, level, expected) => {
    expect(claudeReasoning(model, level)).toEqual(expected);
  });

  it("non-Claude ids get no Claude mapping", () => {
    expect(claudeReasoning("MiniMax-M2", "high")).toBeNull();
  });
});

describe("SDK harness level pass-through", () => {
  it("codex-sdk: shared OpenAI mapping, unset = medium", () => {
    expect(codexReasoningEffort("gpt-5.2", undefined)).toBe("medium");
    expect(codexReasoningEffort("gpt-5.2", "max")).toBe("xhigh");
    expect(codexReasoningEffort(undefined, "xhigh")).toBe("xhigh");
    expect(codexReasoningEffort("o3", "max")).toBe("high");
  });

  it("claude-agent-sdk: adaptive + effort / budget / disabled per model", () => {
    expect(claudeSdkReasoningOptions("claude-opus-5-5", "xhigh")).toEqual({ thinking: { type: "adaptive" }, effort: "xhigh" });
    expect(claudeSdkReasoningOptions("claude-sonnet-4-6", undefined)).toEqual({ thinking: { type: "adaptive" }, effort: "medium" });
    expect(claudeSdkReasoningOptions("claude-opus-4-8", "instant")).toEqual({ thinking: { type: "disabled" } });
    expect(claudeSdkReasoningOptions("claude-haiku-4-5", "low")).toEqual({ thinking: { type: "enabled", budgetTokens: 4096 } });
    // Subscription default model (no card id): effort only, SDK downgrades.
    expect(claudeSdkReasoningOptions(undefined, "high")).toEqual({ effort: "high" });
  });
});

describe("per-session model / reasoning override", () => {
  const agent = { id: "a1", name: "A", model: "claude-sonnet-4-6", system: "", tools: [] } as AgentConfig;

  it("reads only valid override keys", () => {
    expect(readSessionModelOverride({ model: " gpt-6.1-sol ", reasoning_level: "xhigh" })).toEqual({
      model: "gpt-6.1-sol",
      reasoning_level: "xhigh",
    });
    expect(readSessionModelOverride({ model: 42, reasoning_level: "ultra" })).toEqual({});
    expect(readSessionModelOverride(null)).toEqual({});
  });

  it("overlays model + level, guarded by the model-card check", async () => {
    const known = vi.fn(async (m: string) => m === "gpt-6.1-sol");
    expect(await applySessionModelOverride(agent, { model: "gpt-6.1-sol", reasoning_level: "high" }, known)).toMatchObject({
      model: "gpt-6.1-sol",
      reasoning_level: "high",
    });
    const unknown = await applySessionModelOverride(agent, { model: "deleted-card", reasoning_level: "low" }, known);
    expect(unknown.model).toBe("claude-sonnet-4-6");
    expect(unknown.reasoning_level).toBe("low");
    expect(await applySessionModelOverride(agent, {}, known)).toBe(agent);
  });

  it("route validation rejects bad override values and accepts null (clear)", () => {
    expect(invalidSessionModelOverride({ reasoning_level: "ultra" })).toMatch(/reasoning_level must be one of/);
    expect(invalidSessionModelOverride({ model: 7 })).toMatch(/metadata.model/);
    expect(invalidSessionModelOverride({ model: "" })).toMatch(/metadata.model/);
    expect(invalidSessionModelOverride({ model: null, reasoning_level: null })).toBeNull();
    expect(invalidSessionModelOverride({ model: "gpt-6.1-sol", reasoning_level: "xhigh", team: "x" })).toBeNull();
    expect(invalidSessionModelOverride(undefined)).toBeNull();
  });

  it("SessionRegistry: buildModel + harness see the override, re-read every turn, agent row untouched", async () => {
    const TENANT = "tn_session_override";
    const { sql, db, cleanup } = await bootstrapTestDb();
    try {
      await sql
        .prepare(`INSERT INTO "tenant" (id, name, "createdAt", "updatedAt") VALUES (?, ?, ?, ?)`)
        .bind(TENANT, "Session override", Date.now(), Date.now())
        .run();
      const agents = createSqliteAgentService({ db });
      const sessions = createSqliteSessionService({ db });
      const memory = createSqliteMemoryStoreService({ db });
      await ensureEventLogSchema(sql);
      const created = await agents.create({
        tenantId: TENANT,
        input: { name: "Override Agent", model: "claude-sonnet-4-6", tools: [] },
      });
      const { session } = await sessions.create({
        tenantId: TENANT,
        agentId: created.id,
        environmentId: "env-local",
        title: "override",
        metadata: { model: "gpt-6.1-sol", reasoning_level: "xhigh" },
        vaultIds: [],
        agentSnapshot: created,
        environmentSnapshot: { id: "env-local", runtime: "local", sandbox_template: null } as never,
      });

      const modelAgents: AgentConfig[] = [];
      const harnessAgents: AgentConfig[] = [];
      const registry = new SessionRegistry({
        sql,
        hub: { attach: () => () => {}, publish: () => {}, closeSession: () => {} },
        agentsService: agents,
        sessionsService: sessions,
        memoryService: memory,
        sandboxOrchestrator: noopOrchestrator,
        newEventLog: (sessionId) =>
          new SqlEventLog(sql, sessionId, (event: SessionEvent) => {
            (event as { id?: string }).id ??= generateEventId();
            (event as { processed_at?: string }).processed_at ??= new Date().toISOString();
          }),
        buildSandbox: async () => noopSandbox,
        sandboxWorkdirRoot: "/tmp/oma-override-test",
        isKnownModel: async (_t, m) => m === "gpt-6.1-sol" || m === "claude-opus-5-5",
        buildModel: async (a) => {
          modelAgents.push(a);
          return {} as never;
        },
        buildTools: async () => ({}),
        buildHarness: () => ({ run: async () => {} }),
        buildHarnessContext: async (input) => {
          harnessAgents.push(input.agent);
          return input;
        },
      } as never);

      const turn = async () => {
        const entry = await registry.getOrCreate(session.id, TENANT);
        await entry.machine.runHarnessTurn(created.id, {
          type: "user.message",
          content: [{ type: "text", text: "go" }],
        } as UserMessageEvent);
      };

      await turn();
      expect(modelAgents.at(-1)).toMatchObject({ model: "gpt-6.1-sol", reasoning_level: "xhigh" });
      expect(harnessAgents.at(-1)).toMatchObject({ model: "gpt-6.1-sol", reasoning_level: "xhigh" });

      // Mid-session switch (what the composer picker POSTs) applies on the
      // next turn; clearing a key (null) falls back to the agent's value.
      await sessions.update({
        tenantId: TENANT,
        sessionId: session.id,
        metadata: { model: "claude-opus-5-5", reasoning_level: null },
      });
      await turn();
      expect(modelAgents.at(-1)?.model).toBe("claude-opus-5-5");
      expect(modelAgents.at(-1)?.reasoning_level).toBeUndefined();

      const row = await agents.get({ tenantId: TENANT, agentId: created.id });
      expect(row?.model).toBe("claude-sonnet-4-6");
      expect(row?.version).toBe(created.version);
    } finally {
      cleanup();
    }
  });
});

const noopOrchestrator: SandboxOrchestrator = {
  capabilities: () => ({
    enforceReadOnlyMemory: false,
    hasSessionOutputs: false,
    hasVaultOutbound: false,
    hasWorkspaceBackup: false,
  }),
  provision: async () => {},
  snapshotWorkspaceNow: async () => null,
  renewActivityTimeout: async () => {},
};

const noopSandbox: SandboxExecutor = {
  exec: async () => "",
  readFile: async () => "",
  writeFile: async () => "",
};
