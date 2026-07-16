// detectChanges null-normalization: clearing an already-clear field must be
// a no-op (no version bump, no history snapshot). Regression test for the
// bug where JSON.stringify(null) !== JSON.stringify(undefined) made every
// repeated `{ field: null }` update write version+1 (verified live against
// main-node 2026-07-15: two identical null-clear PUTs bumped v3→v4→v5).
import { describe, it, expect } from "vitest";
import { createInMemoryAgentService } from "@open-managed-agents/agents-store/test-fakes";

const TENANT = "tnt_test";

async function createAgent() {
  const { service } = createInMemoryAgentService();
  const row = await service.create({
    tenantId: TENANT,
    input: { name: "noop-test", model: "claude-sonnet-4-6" },
  });
  return { service, row };
}

describe("AgentService.update — null-clear no-ops", () => {
  it("clearing a field that was never set does not bump the version", async () => {
    const { service, row } = await createAgent();
    const after = await service.update({
      tenantId: TENANT,
      agentId: row.id,
      input: { aux_model: null },
    });
    expect(after.version).toBe(row.version);
  });

  it("repeated null-clears stay at the post-clear version", async () => {
    const { service, row } = await createAgent();
    await service.update({
      tenantId: TENANT,
      agentId: row.id,
      input: { aux_model: "claude-haiku-4-5" },
    });
    const cleared = await service.update({
      tenantId: TENANT,
      agentId: row.id,
      input: { aux_model: null },
    });
    expect(cleared.version).toBe(row.version + 2); // set + clear = two real changes
    const again = await service.update({
      tenantId: TENANT,
      agentId: row.id,
      input: { aux_model: null },
    });
    expect(again.version).toBe(cleared.version);
  });

  it("system/description clear to empty string and no-op when already empty", async () => {
    const { service, row } = await createAgent();
    // create() defaults system to "" — clearing it is a no-op.
    const cleared = await service.update({
      tenantId: TENANT,
      agentId: row.id,
      input: { system: null },
    });
    expect(cleared.version).toBe(row.version);
    // A real clear (set then null) still bumps once, then no-ops.
    await service.update({ tenantId: TENANT, agentId: row.id, input: { system: "be terse" } });
    const c2 = await service.update({ tenantId: TENANT, agentId: row.id, input: { system: null } });
    const c3 = await service.update({ tenantId: TENANT, agentId: row.id, input: { system: null } });
    expect(c3.version).toBe(c2.version);
  });

  it("real changes still bump the version", async () => {
    const { service, row } = await createAgent();
    const after = await service.update({
      tenantId: TENANT,
      agentId: row.id,
      input: { reasoning_level: "high" },
    });
    expect(after.version).toBe(row.version + 1);
    expect(after.reasoning_level).toBe("high");
  });
});
