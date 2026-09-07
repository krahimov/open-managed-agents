import { describe, expect, it, vi } from "vitest";
import { generateEventId } from "@open-managed-agents/shared";
import type { EnvironmentConfig, SessionEvent, UserMessageEvent } from "@open-managed-agents/shared";
import { SqlEventLog, ensureSchema as ensureEventLogSchema } from "@open-managed-agents/event-log/sql";
import { createSqliteAgentService } from "@open-managed-agents/agents-store";
import { createSqliteSessionService } from "@open-managed-agents/sessions-store";
import { createSqliteMemoryStoreService } from "@open-managed-agents/memory-store";
import type { SandboxExecutor } from "@open-managed-agents/sandbox";
import { DefaultSandboxOrchestrator } from "@open-managed-agents/sandbox/orchestrator";
import { SessionRegistry, type SessionRegistryDeps } from "../src/registry";
import { InProcessEventStreamHub } from "../src/lib/event-stream-hub";
import { NodeSessionRouter } from "../src/lib/node-session-router";
import { NodeSessionWorkQueue, type NodeSessionWorkItem } from "../src/lib/node-session-work-queue";
import { bootstrapTestDb } from "./_helpers/bootstrap-test-db";

const TENANT = "tenant-computer-integration";
type HarnessContext = Parameters<SessionRegistryDeps["buildHarnessContext"]>[0];

async function setup(
  scope: "agent" | "session",
  runHarness: (ctx: HarnessContext) => Promise<void> = async () => {},
) {
  const { sql, db, cleanup } = await bootstrapTestDb();
  await sql.prepare('INSERT INTO "tenant" (id, name, "createdAt", "updatedAt") VALUES (?, ?, ?, ?)')
    .bind(TENANT, "Computer integration", Date.now(), Date.now()).run();
  await ensureEventLogSchema(sql);
  const agents = createSqliteAgentService({ db });
  const sessions = createSqliteSessionService({ db });
  const agent = await agents.create({
    tenantId: TENANT,
    input: { name: "Cloud computer", model: "test-model", tools: [] },
  });
  const environment = {
    id: "environment-computer",
    config: { sandbox: { provider: "daytona", scope, browser: true }, resources: { outputs: false } },
  } as unknown as EnvironmentConfig;
  const createSession = async () => (await sessions.create({
    tenantId: TENANT,
    agentId: agent.id,
    environmentId: environment.id,
    environmentSnapshot: environment,
    agentSnapshot: agent,
    vaultIds: [],
    title: "Computer integration",
  })).session;

  const files = new Map([["/workspace/progress.txt", "current agent work"]]);
  const sandbox: SandboxExecutor = {
    exec: async () => "",
    readFile: async (path) => files.get(path) ?? "",
    writeFile: async (path, content) => { files.set(path, content); return ""; },
    sandboxCapabilities: () => ({ scope, browser: true }),
    destroy: vi.fn(async () => {}),
  };
  const backups = {
    latest: vi.fn(async () => ({ id: "old-session-backup", dir: "/workspace" })),
    restore: vi.fn(async () => {
      files.set("/workspace/progress.txt", "old session contents");
      return { ok: true };
    }),
    snapshot: vi.fn(async () => null),
  };
  const hub = new InProcessEventStreamHub();
  const newEventLog = (sessionId: string) => new SqlEventLog(sql, sessionId, (event: SessionEvent) => {
    (event as { id?: string }).id ??= generateEventId();
    (event as { processed_at?: string }).processed_at ??= new Date().toISOString();
  });
  const buildSandbox = vi.fn<SessionRegistryDeps["buildSandbox"]>(async () => sandbox);
  const buildModel = vi.fn<SessionRegistryDeps["buildModel"]>(async () => ({}) as never);
  const registry = new SessionRegistry({
    sql, hub,
    agentsService: agents,
    sessionsService: sessions,
    memoryService: createSqliteMemoryStoreService({ db }),
    sandboxOrchestrator: new DefaultSandboxOrchestrator({ backups }),
    newEventLog,
    buildSandbox,
    sandboxWorkdirRoot: "/tmp/computer-integration-sandboxes",
    buildModel,
    buildTools: async () => ({}),
    buildHarness: () => ({ run: async (ctx) => runHarness(ctx as HarnessContext) }),
    buildHarnessContext: async (input) => input,
  });
  const runWork = vi.fn(async (item: NodeSessionWorkItem) => {
    const entry = await registry.getOrCreate(item.sessionId, item.tenantId);
    await entry.machine.runHarnessTurn(item.agentId, item.event as UserMessageEvent);
  });
  const queue = new NodeSessionWorkQueue({ sql, dialect: "sqlite", run: runWork });
  await queue.ensureSchema();
  const router = new NodeSessionRouter({ sql, hub, registry, newEventLog, workQueue: queue });
  return { sql, cleanup, registry, router, queue, createSession, agent, environment, sandbox, files, backups, buildSandbox, buildModel, runWork };
}

describe("agent computer session integration", () => {
  it("finishes queued work after the client closes its event stream, then replays the result on reconnect", async () => {
    let finishModel!: () => void;
    const modelResult = new Promise<void>((resolve) => { finishModel = resolve; });
    const harnessStarted = vi.fn();
    const fixture = await setup("agent", async (ctx) => {
      harnessStarted();
      await modelResult;
      await ctx.sandbox.writeFile("/workspace/result.txt", "finished after disconnect");
      await ctx.eventLog.appendAsync({
        type: "agent.message",
        content: [{ type: "text", text: "Cloud work finished." }],
      } as SessionEvent);
    });
    try {
      const session = await fixture.createSession();
      const stream = await fixture.router.streamEvents(session.id, { include: ["chunks"] });
      const frames = stream[Symbol.asyncIterator]();
      const accepted = await fixture.router.appendEvent(session.id, {
        type: "user.message",
        content: [{ type: "text", text: "Finish the task after I close my laptop." }],
      } as UserMessageEvent);
      expect(accepted.status).toBe(202);
      expect(JSON.parse((await frames.next()).value.data).type).toBe("user.message");
      await vi.waitFor(() => expect(harnessStarted).toHaveBeenCalledOnce());
      expect(await fixture.sql.prepare("SELECT status FROM sessions WHERE id = ?").bind(session.id).first())
        .toMatchObject({ status: "running" });

      // This is the same close method the HTTP SSE route invokes when the
      // browser disconnects. It must only detach the event subscriber.
      stream.close();
      expect(fixture.sandbox.destroy).not.toHaveBeenCalled();
      expect(fixture.files.has("/workspace/result.txt")).toBe(false);
      finishModel();
      await fixture.queue.wake(session.id);

      expect(fixture.files.get("/workspace/result.txt")).toBe("finished after disconnect");
      expect(await fixture.sql.prepare("SELECT status FROM sessions WHERE id = ?").bind(session.id).first())
        .toMatchObject({ status: "idle" });
      expect(await fixture.sql.prepare("SELECT status, attempts FROM session_work_items WHERE session_id = ?").bind(session.id).first())
        .toMatchObject({ status: "done", attempts: 1 });
      expect(fixture.runWork).toHaveBeenCalledWith(expect.objectContaining({
        tenantId: TENANT, agentId: fixture.agent.id, sessionId: session.id,
      }));
      expect(fixture.buildModel).toHaveBeenCalledWith(expect.objectContaining({ id: fixture.agent.id }), TENANT);

      const stored = await fixture.router.getEvents(session.id);
      expect(stored.data.map((event) => event.type)).toEqual([
        "user.message", "session.status_running", "agent.message", "session.status_idle",
      ]);
      const reconnected = await fixture.router.streamEvents(session.id, { replay: true, include: ["chunks"] });
      const replay = reconnected[Symbol.asyncIterator]();
      const replayed = [];
      for (let index = 0; index < stored.data.length; index++) {
        replayed.push(JSON.parse((await replay.next()).value.data));
      }
      reconnected.close();
      expect(replayed.find((event) => event.type === "agent.message").content)
        .toEqual([{ type: "text", text: "Cloud work finished." }]);
    } finally {
      finishModel();
      await fixture.registry.shutdown();
      fixture.cleanup();
    }
  });

  it("passes session ownership and the frozen environment to the computer without restoring stale session files", async () => {
    const fixture = await setup("agent");
    try {
      const first = await fixture.createSession();
      const second = await fixture.createSession();
      for (const session of [first, second]) {
        const entry = await fixture.registry.getOrCreate(session.id, TENANT);
        expect(fixture.buildSandbox).toHaveBeenCalledWith(
          session.id,
          expect.stringContaining(session.id),
          fixture.environment,
          { tenantId: TENANT, agentId: fixture.agent.id },
        );
        expect(await entry.sandbox.readFile("/workspace/progress.txt"))
          .toBe("current agent work");
      }
      expect(fixture.backups.latest).not.toHaveBeenCalled();
      expect(fixture.backups.restore).not.toHaveBeenCalled();
    } finally {
      await fixture.registry.shutdown();
      fixture.cleanup();
    }
  });

  it("still restores a workspace backup for a computer scoped to one session", async () => {
    const fixture = await setup("session");
    try {
      const session = await fixture.createSession();
      const entry = await fixture.registry.getOrCreate(session.id, TENANT);
      expect(fixture.backups.latest).toHaveBeenCalledWith({ tenantId: TENANT, sessionId: session.id });
      expect(fixture.backups.restore).toHaveBeenCalledOnce();
      expect(await entry.sandbox.readFile("/workspace/progress.txt")).toBe("old session contents");
    } finally {
      await fixture.registry.shutdown();
      fixture.cleanup();
    }
  });
});
