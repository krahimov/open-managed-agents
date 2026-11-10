// Write in session 1, recall in session 2 — the recurring "what's new since
// last time" workflow, end to end at the service level.
//
// Everything below the model is the production path: sessions are created
// through the real sessions route (lifecycle hook) and the real ambient
// dispatcher; the SessionRegistry provisions a real LocalSubprocessSandbox
// whose /mnt/memory mount is the agent's store; the note is written with
// the same sandbox.writeFile the agent's write tool calls; the fs watcher
// indexes it; and session 2's system prompt is composed from the same
// memory context main-node builds per turn.
//
// Prod 2026-11-10: session 2 of a "Competitor watch" agent, asked "What
// did you report last time?", searched /workspace and found nothing.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { composeSystemPrompt } from "@open-managed-agents/agent/harness/platform-guidance";
import { buildSessionRoutes } from "@open-managed-agents/http-routes";
import { ensureSchema as ensureEventLogSchema, SqlEventLog } from "@open-managed-agents/event-log/sql";
import { LocalSubprocessSandbox } from "@open-managed-agents/sandbox/adapters/local-subprocess";
import { DefaultSandboxOrchestrator } from "@open-managed-agents/sandbox/orchestrator";
import { generateEventId } from "@open-managed-agents/shared";
import type { SessionEvent } from "@open-managed-agents/shared";
import { enableAgentMemory } from "../src/lib/agent-memory-mode";
import { InProcessEventStreamHub } from "../src/lib/event-stream-hub";
import { startMemoryBlobWatcher } from "../src/lib/memory-blob-watcher";
import { NodeAmbientDispatcher } from "../src/lib/node-ambient-dispatch";
import { createSdkMemoryPort, materializeMemory, writeBackMemory } from "../src/lib/sdk-harness-memory";
import { buildSetupTools } from "../src/lib/setup-harness";
import { SessionRegistry } from "../src/registry";
import { buildMemoryRig, TENANT, type MemoryRig } from "./_helpers/memory-rig";

const FACT = "Competitor A launched X (their first enterprise tier) on 2026-11-09.";
const quiet = { log: () => {}, warn: () => {} };

let rig: MemoryRig;
let scratch: string;
let registry: SessionRegistry;
let watcher: { stop: () => Promise<void> };
let app: Hono<{ Variables: { tenant_id: string } }>;

beforeEach(async () => {
  rig = await buildMemoryRig();
  scratch = mkdtempSync(join(tmpdir(), "oma-memory-e2e-"));
  await ensureEventLogSchema(rig.sql);
  watcher = startMemoryBlobWatcher({ memoryRoot: rig.memoryRoot, memoryRepo: rig.memoryRepo, logger: quiet });
  // chokidar needs a beat to arm before the first write.
  await new Promise((r) => setTimeout(r, 300));

  const hub = new InProcessEventStreamHub();
  registry = new SessionRegistry({
    sql: rig.sql,
    hub,
    agentsService: rig.agents,
    sessionsService: rig.sessions,
    memoryService: rig.memoryService,
    sandboxOrchestrator: new DefaultSandboxOrchestrator({}),
    newEventLog: (sessionId: string) =>
      new SqlEventLog(rig.sql, sessionId, (event: SessionEvent) => {
        (event as { id?: string }).id ??= generateEventId();
      }),
    buildSandbox: async (_sessionId, workdir) =>
      new LocalSubprocessSandbox({ workdir, memoryRoot: rig.memoryRoot, logger: quiet }),
    sandboxWorkdirRoot: join(scratch, "sandboxes"),
    buildModel: async () => ({}) as never,
    buildTools: async () => ({}),
    buildHarness: () => ({ run: async () => {} }),
    buildHarnessContext: async (input) => input as never,
  });

  app = new Hono<{ Variables: { tenant_id: string } }>();
  app.use("*", async (c, next) => {
    c.set("tenant_id", TENANT);
    await next();
  });
  app.route(
    "/v1/sessions",
    buildSessionRoutes({
      services: { agents: rig.agents, sessions: rig.sessions, credentials: { listByVaults: async () => [] } } as never,
      router: { init: async () => {}, getFullStatus: async () => null } as never,
      localRuntimeEnvId: "env-local-runtime",
      loadEnvironment: async ({ environmentId }) =>
        ({ id: environmentId, runtime: "local", sandbox_template: null }) as never,
      lifecycle: { attachAgentMemory: rig.attachAgentMemory },
    }),
  );
});

afterEach(async () => {
  await watcher.stop();
  rig.cleanup();
  rmSync(scratch, { recursive: true, force: true });
});

type CreatedSession = { id: string; resources?: Array<{ type: string; memory_store_id?: string; access?: string }> };

/** POST /v1/sessions — the console / API path. */
async function createSession(agentId: string, metadata?: Record<string, unknown>): Promise<CreatedSession> {
  const res = await app.request("/v1/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent: agentId, environment_id: "env-local-runtime", ...(metadata ? { metadata } : {}) }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as CreatedSession;
}
const startSession = async (agentId: string, metadata?: Record<string, unknown>) =>
  (await createSession(agentId, metadata)).id;

/** The system prompt a DefaultHarness turn of this session would get. */
async function systemPromptOf(sessionId: string, agentSystem = "You are Competitor watch."): Promise<string> {
  const ctx = await rig.sessionMemory.promptContext(TENANT, sessionId);
  return composeSystemPrompt(agentSystem, ctx.reminders);
}

async function waitForIndexed(storeId: string, count = 1): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if ((await rig.memoryRepo.list(storeId, {})).length >= count) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`memory watcher did not index ${count} file(s) in store ${storeId}`);
}

describe("recall across sessions", () => {
  it("session 1 records what it reported; a new session and a scheduled run both recall it", async () => {
    const agent = await rig.createAgent("Competitor watch");

    // Setup: the user asks the agent to remember → enable_memory.
    const setupSessionId = await startSession(agent.id, { oma_setup: true });
    const setupTools = buildSetupTools(agent, setupSessionId, {
      updateAgent: async () => agent,
      appendEvent: async () => undefined,
      requestAccess: async () => ({ request_id: "x", status: "pending" }),
      enableMemory: () => enableAgentMemory(rig.deps, { tenantId: TENANT, agentId: agent.id }),
    });
    const enabled = String(await setupTools.enable_memory.execute({}, { toolCallId: "t", messages: [] }));
    expect(enabled).toContain("Memory is now ON for this agent.");
    expect(await rig.memoryStoreIdsOf(setupSessionId)).toEqual([]);
    const storeId = (await rig.agents.get({ tenantId: TENANT, agentId: agent.id }))!.memory!.store_id!;
    const storeName = (await rig.memoryService.getStore({ tenantId: TENANT, storeId }))!.name;
    const dir = `/mnt/memory/${storeName}`;

    // ── Session 1 ────────────────────────────────────────────────────
    const created1 = await createSession(agent.id);
    const s1 = created1.id;
    // The create response names the store the session got.
    expect(created1.resources).toMatchObject([{ type: "memory_store", memory_store_id: storeId, access: "read_write" }]);
    expect(await rig.memoryStoreIdsOf(s1)).toEqual([storeId]);
    const prompt1 = await systemPromptOf(s1);
    expect(prompt1).toContain("You have persistent memory that survives across sessions");
    expect(prompt1).toContain(`Mounted at ${dir}/ (read-write)`);
    expect(prompt1).toContain("Nothing was saved here when this session started.");
    expect(prompt1).not.toContain(FACT);

    // The agent's write tool: sandbox.writeFile on the mount.
    const sandbox1 = (await registry.getOrCreate(s1, TENANT)).sandbox;
    await sandbox1.writeFile(`${dir}/reports/2026-11-10.md`, `# Brief 2026-11-10\n\nReported: ${FACT}\n`);
    await waitForIndexed(storeId);

    // ── Session 2: a brand-new session of the same agent ─────────────
    const s2 = await startSession(agent.id);
    expect(s2).not.toBe(s1);
    const prompt2 = await systemPromptOf(s2);
    expect(prompt2).toContain("Saved notes as of the start of this session (1 file, newest first):");
    expect(prompt2).toContain("- reports/2026-11-10.md");
    expect(prompt2).toContain(`Reported: ${FACT}`);
    // …and the file is really there for its tools, in a different sandbox.
    const sandbox2 = (await registry.getOrCreate(s2, TENANT)).sandbox;
    expect(sandbox2).not.toBe(sandbox1);
    expect(await sandbox2.readFile(`${dir}/reports/2026-11-10.md`)).toContain(FACT);

    // ── Scheduled run: the ambient dispatcher's fresh session ────────
    const rule = await rig.ambientRules.create({
      tenantId: TENANT,
      agentId: agent.id,
      input: {
        name: "Monday brief",
        trigger: { source: "schedule", config: { cron: "0 9 * * 1", prompt: "Produce this week's brief." } },
        wake_mode: "act",
        next_wake_at: new Date(Date.now() - 1000).toISOString(),
      } as never,
    });
    const woken: Array<{ sessionId: string; boundStores: string[] }> = [];
    const dispatcher = new NodeAmbientDispatcher({
      ambientRules: rig.ambientRules,
      agents: rig.agents,
      sessions: rig.sessions,
      attachAgentMemory: rig.attachAgentMemory,
      // The store must already be bound when the wake message is appended:
      // that is when the runtime provisions the sandbox for turn 1.
      appendUserEvent: async (sessionId) => {
        woken.push({ sessionId, boundStores: await rig.memoryStoreIdsOf(sessionId) });
      },
    });
    expect(await dispatcher.dispatchDue()).toBe(1);
    expect(woken).toHaveLength(1);
    expect(woken[0].boundStores).toEqual([storeId]);
    expect(await systemPromptOf(woken[0].sessionId)).toContain(`Reported: ${FACT}`);
    expect((await rig.ambientRules.get({ tenantId: TENANT, agentId: agent.id, ruleId: rule.id }))?.last_decision?.outcome)
      .toBe("create_session");
  });

  it("an agent without memory gets no store, no reminder, and nothing to recall", async () => {
    const agent = await rig.createAgent("No memory");
    const s1 = await startSession(agent.id);
    expect(await rig.memoryStoreIdsOf(s1)).toEqual([]);
    const ctx = await rig.sessionMemory.promptContext(TENANT, s1);
    expect(ctx).toEqual({ storeIds: [], reminders: [] });
    expect(await systemPromptOf(s1)).not.toContain("persistent memory");
  });

  it("host-workdir SDK harnesses: the store is materialized, edits are written back, and the next session sees them", async () => {
    const agent = await rig.createAgent("Competitor watch (SDK)");
    const { store } = await enableAgentMemory(rig.deps, { tenantId: TENANT, agentId: agent.id });
    const port = createSdkMemoryPort({
      attachments: async (tenantId, sessionId) => [...(await rig.sessionMemory.attachments(tenantId, sessionId)).values()],
      memoryService: rig.memoryService,
    });

    // Session 1: empty store materialized; the agent writes a note.
    const s1 = await startSession(agent.id);
    const cwd1 = join(scratch, "sdk", s1);
    const m1 = await materializeMemory(port, TENANT, s1, cwd1);
    expect(m1.guidance).toContain(`./memory/${store!.name}/`);
    const { mkdir, writeFile, readFile } = await import("node:fs/promises");
    await mkdir(join(cwd1, "memory", store!.name, "reports"), { recursive: true });
    await writeFile(join(cwd1, "memory", store!.name, "reports", "2026-11-10.md"), `Reported: ${FACT}\n`, "utf8");
    expect(await writeBackMemory(port, TENANT, s1, cwd1, m1)).toEqual({ saved: 1, conflicts: [] });

    // Session 2: a different workdir gets the note, and the prompt names
    // the ./memory path (not /mnt/memory) with the note inline.
    const s2 = await startSession(agent.id);
    const cwd2 = join(scratch, "sdk", s2);
    await materializeMemory(port, TENANT, s2, cwd2);
    expect(await readFile(join(cwd2, "memory", store!.name, "reports", "2026-11-10.md"), "utf8")).toContain(FACT);
    const ctx = await rig.sessionMemory.promptContext(TENANT, s2, { mountRoot: "./memory", includeGuidance: false });
    expect(ctx.reminders.map((r) => r.source)).toEqual([`memory:${store!.id}`]);
    expect(ctx.reminders[0].text).toContain(`Mounted at ./memory/${store!.name}/ (read-write)`);
    expect(ctx.reminders[0].text).toContain(`Reported: ${FACT}`);
  });
});
