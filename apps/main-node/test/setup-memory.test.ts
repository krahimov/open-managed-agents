// Setup mode and memory. Prod 2026-11-10: a user told a new agent to
// "remember what you reported before"; the setup toolset had no way to
// switch memory on, so the agent offered GitHub/Drive, then admitted memory
// was "not enabled". One setup agent also wrote "the current tools cannot
// save files" — a setup-mode limit — into its own working system prompt.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentConfig } from "@open-managed-agents/shared";
import { enableAgentMemory, sharedStoreName } from "../src/lib/agent-memory-mode";
import {
  buildSetupPrompt,
  buildSetupTools,
  describeSetupMemoryStatus,
  harnessView,
  runEnableMemory,
} from "../src/lib/setup-harness";
import { buildMemoryRig, TENANT, type MemoryRig } from "./_helpers/memory-rig";

const callOpts = { toolCallId: "t1", messages: [] };
const bare = { id: "agent-1", name: "Competitor watch", mcp_servers: [] } as unknown as AgentConfig;
const baseDeps = {
  updateAgent: async () => bare,
  appendEvent: async () => undefined,
  requestAccess: async () => ({ request_id: "x", status: "pending" }),
};

describe("setup toolset: enable_memory", () => {
  let rig: MemoryRig;
  beforeEach(async () => {
    rig = await buildMemoryRig();
  });
  afterEach(() => rig.cleanup());

  it("is offered only when the dep is wired", () => {
    expect(buildSetupTools(bare, "sess-1", baseDeps)).not.toHaveProperty("enable_memory");
    expect(
      buildSetupTools(bare, "sess-1", { ...baseDeps, enableMemory: async () => ({}) as never }),
    ).toHaveProperty("enable_memory");
  });

  it("creates the store and sets the mode in the handler, and the result says what is on", async () => {
    const agent = await rig.createAgent();
    const tools = buildSetupTools(agent, "sess-setup", {
      ...baseDeps,
      enableMemory: () => enableAgentMemory(rig.deps, { tenantId: TENANT, agentId: agent.id }),
    });

    const out = String(await tools.enable_memory.execute({}, callOpts));

    const saved = await rig.agents.get({ tenantId: TENANT, agentId: agent.id });
    const stores = await rig.memoryService.listStores({ tenantId: TENANT, status: "active" });
    expect(stores.map((s) => s.name)).toEqual([sharedStoreName(agent.id)]);
    expect(saved?.memory).toEqual({ mode: "shared", store_id: stores[0].id });
    expect(out).toContain("Memory is now ON for this agent.");
    expect(out).toContain(`Store "${stores[0].name}" is attached read-write to every new working session`);

    // Idempotent: calling again changes nothing and says so.
    const again = String(await tools.enable_memory.execute({}, callOpts));
    expect(again).toContain("Memory was already ON for this agent — nothing changed.");
    expect(await rig.memoryService.listStores({ tenantId: TENANT, status: "active" })).toHaveLength(1);

    // A session created after setup gets the store.
    const working = await rig.createSession(agent.id);
    expect(await rig.memoryStoreIdsOf(working.id)).toEqual([stores[0].id]);
  });

  it("a failure is reported as NOT enabled, never as success", async () => {
    const out = await runEnableMemory(async () => {
      throw new Error("blob store unreachable");
    });
    expect(out).toContain("Memory was NOT enabled: blob store unreachable");
    expect(out).toContain("Do not tell the user memory is on");
    expect(out).not.toContain("Memory is now ON");
  });

  it("create_ambient_rule passes the memory outcome back in its result", async () => {
    const tools = buildSetupTools(bare, "sess-1", {
      ...baseDeps,
      createAmbientRule: async () => ({
        id: "amb_1",
        memory_note: "Memory was switched ON automatically for this agent.",
      }),
    });
    const out = String(
      await tools.create_ambient_rule.execute(
        { name: "Monday brief", cron: "0 9 * * 1", prompt: "Produce the weekly brief." },
        callOpts,
      ),
    );
    expect(out).toContain('Ambient rule "Monday brief" created');
    expect(out).toContain("Memory was switched ON automatically for this agent.");
  });
});

describe("setup prompt: memory", () => {
  const prompt = buildSetupPrompt(bare);

  it("tells the agent to enable memory when asked to remember, track changes, or run on a schedule", () => {
    expect(prompt).toContain("- enable_memory: turn on your persistent memory");
    expect(prompt).toContain(
      "When the user asks you to remember something, to track what changed over time, to compare against \"last time\", to avoid repeating yourself, or to run on a schedule: call enable_memory",
    );
    expect(prompt).toContain("then tell the user memory is on");
    expect(prompt).toContain("Creating a rule also switches your memory on (unless the user turned it off)");
  });

  it("forbids external storage as a substitute and claims that aren't backed by state", () => {
    expect(prompt).toContain(
      "Never suggest external storage (GitHub, Google Drive, Notion, a database, a spreadsheet…) as a substitute for remembering.",
    );
    expect(prompt).toContain("Never say or imply that you will remember anything unless memory is ON");
  });

  it("states the live memory status: not enabled, on, and explicitly off", () => {
    expect(prompt).toContain("MEMORY STATUS: OFF — not enabled yet.");
    expect(buildSetupPrompt({ ...bare, memory: { mode: "shared", store_id: "memstore-1" } })).toContain(
      "MEMORY STATUS: ON — your memory store is attached to every new working session, including scheduled runs.",
    );
    expect(describeSetupMemoryStatus({ ...bare, memory: { mode: "off" } })).toContain(
      "OFF — the user turned memory off.",
    );
    expect(describeSetupMemoryStatus({ ...bare, memory: { mode: "per_user" } })).toContain("ON (per-user");
  });

  it("shows memory in the harness view only when it is on", () => {
    expect(harnessView(bare)).not.toHaveProperty("memory");
    expect(harnessView({ ...bare, memory: { mode: "off" } })).not.toHaveProperty("memory");
    expect(harnessView({ ...bare, memory: { mode: "shared", store_id: "memstore-1" } }).memory).toEqual({
      mode: "shared",
      store_id: "memstore-1",
    });
  });
});

describe("setup prompt: setup's own limits are not the working agent's", () => {
  const prompt = buildSetupPrompt(bare);

  it("scopes the no-file/no-shell limit to the setup conversation", () => {
    expect(prompt).toContain("In THIS setup conversation you have only the setup tools below, and no file or shell access:");
    expect(prompt).not.toContain("You have exactly five tools and no file or shell access");
  });

  it("describes the working toolset and bans writing setup limits into the system prompt", () => {
    expect(prompt).toContain("SETUP MODE IS NOT HOW YOU WORK.");
    expect(prompt).toContain(
      "a sandbox with file tools (read, write, edit, search) and a shell, web search and fetch, every MCP server on your harness, and — when memory is on — your memory store mounted as a directory",
    );
    expect(prompt).toContain("Never write this conversation's limits into your system prompt.");
    expect(prompt).toContain("Your system prompt describes the working you.");
  });

  it("explains that a new session does not see an earlier session's workspace", () => {
    expect(prompt).toContain("a NEW session does not see an earlier session's workspace");
  });
});
