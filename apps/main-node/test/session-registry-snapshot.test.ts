import { describe, expect, it, vi } from "vitest";
import { generateEventId } from "@open-managed-agents/shared";
import type { AgentConfig, SessionEvent, UserMessageEvent } from "@open-managed-agents/shared";
import { SqlEventLog, ensureSchema as ensureEventLogSchema } from "@open-managed-agents/event-log/sql";
import type { SandboxExecutor } from "@open-managed-agents/sandbox";
import type { SandboxOrchestrator, SandboxCapabilities } from "@open-managed-agents/sandbox/orchestrator";
import { createSqliteAgentService } from "@open-managed-agents/agents-store";
import { createSqliteSessionService } from "@open-managed-agents/sessions-store";
import { createSqliteMemoryStoreService } from "@open-managed-agents/memory-store";
import { SessionRegistry } from "../src/registry";
import { bootstrapTestDb } from "./_helpers/bootstrap-test-db";

const TENANT = "tn_registry_snapshot";

describe("SessionRegistry", () => {
  it.each([false, true])("runs snapshot turns with setup=%s and reserves computers only for work", async (isSetup) => {
    const { sql, db, cleanup } = await bootstrapTestDb();
    try {
      await sql
        .prepare(`INSERT INTO "tenant" (id, name, "createdAt", "updatedAt") VALUES (?, ?, ?, ?)`)
        .bind(TENANT, "Registry Snapshot", Date.now(), Date.now())
        .run();

      const agents = createSqliteAgentService({ db });
      const sessions = createSqliteSessionService({ db });
      const memory = createSqliteMemoryStoreService({ db });
      await ensureEventLogSchema(sql);
      const agent = await agents.create({
        tenantId: TENANT,
        input: {
          name: "Mutable Agent",
          model: "claude-haiku-4-5-20251001",
          tools: [{ type: "agent_toolset_20260401" }],
        },
      });
      const snapshot: AgentConfig = {
        ...agent,
        mcp_servers: [
          {
            name: "composio_gmail",
            type: "url",
            url: "https://backend.composio.dev/tool_router/trs_snapshot/mcp",
          },
        ],
      };
      const { session } = await sessions.create({
        tenantId: TENANT,
        agentId: agent.id,
        environmentId: "env-local-runtime",
        title: "snapshot test",
        metadata: { oma_setup: isSetup },
        vaultIds: [],
        agentSnapshot: snapshot,
        environmentSnapshot: {
          id: "env-local-runtime",
          runtime: "local",
          sandbox_template: null,
        } as never,
      });

      let toolsAgent: AgentConfig | null = null;
      const buildSandbox = vi.fn(async () => noopSandbox);
      if (!isSetup) buildSandbox.mockRejectedValueOnce(new Error("Total disk limit exceeded"));
      const provision = vi.fn(async () => {});
      const registry = new SessionRegistry({
        sql,
        hub: { attach: () => () => {}, publish: () => {}, closeSession: () => {} },
        agentsService: agents,
        memoryService: memory,
        sandboxOrchestrator: { ...noopOrchestrator, provision },
        newEventLog: (sessionId) =>
          new SqlEventLog(sql, sessionId, (event: SessionEvent) => {
            (event as { id?: string }).id ??= generateEventId();
            (event as { processed_at?: string }).processed_at ??= new Date().toISOString();
          }),
        buildSandbox,
        sandboxWorkdirRoot: "/tmp/oma-registry-test",
        buildModel: async () => ({}) as never,
        buildTools: async (turnAgent) => {
          toolsAgent = turnAgent;
          return {};
        },
        buildHarness: () => ({ run: async () => {} }),
        buildHarnessContext: async (input) => input,
      });

      if (!isSetup) {
        await expect(registry.getOrCreate(session.id, TENANT)).rejects.toThrow("Total disk limit exceeded");
      }
      await registry.getOrCreate(session.id, TENANT).then((entry) =>
        entry.machine.runHarnessTurn(agent.id, {
          type: "user.message",
          content: [{ type: "text", text: "go" }],
        } as UserMessageEvent),
      );

      expect(toolsAgent?.mcp_servers).toEqual(snapshot.mcp_servers);
      if (isSetup) {
        expect(buildSandbox).not.toHaveBeenCalled();
        expect(provision).not.toHaveBeenCalled();
        const entry = await registry.getOrCreate(session.id, TENANT);
        await expect(entry.sandbox.exec("hostname")).rejects.toThrow("unavailable during setup");
        await expect(entry.sandbox.readFile("/private")).rejects.toThrow("unavailable during setup");
        await registry.refreshResources(session.id, TENANT);
        expect(provision).not.toHaveBeenCalled();
      } else {
        expect(buildSandbox).toHaveBeenCalledTimes(2);
        expect(provision).toHaveBeenCalledOnce();
      }
    } finally {
      cleanup();
    }
  });
});

const noopCapabilities: SandboxCapabilities = {
  enforceReadOnlyMemory: false,
  hasSessionOutputs: false,
  hasVaultOutbound: false,
  hasWorkspaceBackup: false,
};

const noopOrchestrator: SandboxOrchestrator = {
  capabilities: () => noopCapabilities,
  provision: async () => {},
  snapshotWorkspaceNow: async () => null,
  renewActivityTimeout: async () => {},
};

const noopSandbox: SandboxExecutor = {
  exec: async () => "",
  readFile: async () => "",
  writeFile: async () => "",
};
