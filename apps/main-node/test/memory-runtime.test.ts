// memory-runtime.ts (extracted from index.ts): the per-turn PUSH reminder
// builder — turn-text matching, first-turn briefing, k/char caps, kind
// ordering, empty → null; and the tools port's per_user scoping.

import { describe, it, expect } from "vitest";
import { createMemoryRuntime } from "../src/lib/memory-runtime";

function fact(over: Record<string, unknown>) {
  return {
    id: "mfact-x", kind: "rule", subject: "s", statement: "st", applies_when: null,
    observed_at: Date.parse("2026-07-22T00:00:00Z"), source_session_id: "sess-1", store_id: "st1", status: "active",
    ...over,
  };
}

function rt(opts: { facts?: any[]; briefing?: any[]; sessionAgent?: any; storesByName?: Record<string, string> } = {}) {
  const calls: any[] = [];
  const stores = opts.storesByName ?? { st1: "agent-agent-1-memory", st2: "team-shared" };
  const runtime = createMemoryRuntime({
    memoryService: {
      factsEnabled: () => true,
      searchFacts: async (o: any) => { calls.push(o); return o.query ? (opts.facts ?? []) : (opts.briefing ?? []); },
      getStore: async ({ storeId }: any) => (stores[storeId] ? { id: storeId, name: stores[storeId] } : null),
      factStats: async () => ({ total: 0, byKind: {}, lastUpdatedAt: null }),
    } as never,
    sessionsService: { get: async () => opts.sessionAgent ?? null } as never,
    sql: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }), first: async () => null, run: async () => {} }) }) } as never,
    newEventLog: () => ({ getEventsAsync: async () => [] }),
    logger: { warn: () => {} },
  });
  return { runtime, calls };
}

describe("buildMemoryPushReminder", () => {
  it("returns null when nothing matches and it isn't the first turn", async () => {
    const { runtime } = rt();
    const r = await runtime.buildMemoryPushReminder({ tenantId: "t", storeIds: ["st1"], userMessage: { content: [{ type: "text", text: "hello" }] }, isFirstTurn: false });
    expect(r).toBeNull();
  });

  it("renders matched facts with kind, applies_when, date, session provenance, and id", async () => {
    const { runtime, calls } = rt({ facts: [fact({ id: "mfact-1", kind: "preference", statement: "No meetings before 10am.", applies_when: "scheduling" })] });
    const r = await runtime.buildMemoryPushReminder({ tenantId: "t", storeIds: ["st1"], userMessage: { content: [{ type: "text", text: "book a 9am call" }] }, isFirstTurn: false });
    expect(r!.factIds).toEqual(["mfact-1"]);
    expect(r!.text).toContain("Relevant from memory");
    expect(r!.text).toContain("- [preference] No meetings before 10am. (applies when: scheduling) (2026-07-22, session sess-1; id mfact-1)");
    expect(calls[0]).toMatchObject({ query: "book a 9am call", storeIds: ["st1"], limit: 5 });
  });

  it("first turn adds the rules/preferences briefing (deduped, capped at 5)", async () => {
    const briefing = Array.from({ length: 8 }, (_, i) => fact({ id: `mfact-b${i}`, statement: `rule ${i}` }));
    const { runtime, calls } = rt({ facts: [fact({ id: "mfact-b0", statement: "rule 0" })], briefing });
    const r = await runtime.buildMemoryPushReminder({ tenantId: "t", storeIds: ["st1"], userMessage: { content: [{ type: "text", text: "hi there" }] }, isFirstTurn: true });
    expect(r!.factIds).toHaveLength(5);
    expect(r!.factIds[0]).toBe("mfact-b0"); // matched first, briefing fills the rest without duplicating
    expect(new Set(r!.factIds).size).toBe(5);
    expect(calls[1]).toMatchObject({ kinds: ["rule", "preference"] });
  });

  it("respects the ~400-token char cap", async () => {
    const big = Array.from({ length: 5 }, (_, i) => fact({ id: `mfact-big${i}`, statement: "x".repeat(700) }));
    const { runtime } = rt({ facts: big });
    const r = await runtime.buildMemoryPushReminder({ tenantId: "t", storeIds: ["st1"], userMessage: { content: [{ type: "text", text: "anything" }] }, isFirstTurn: false });
    expect(r!.factIds.length).toBeLessThan(5);
    expect(r!.text.length).toBeLessThanOrEqual(1_700);
  });
});

describe("prompt context: primary store + per_user scoping", () => {
  function ctxRt(mode: string, attached: string[], storesByName: Record<string, string>, pinned?: string) {
    // sql fake: session_memory_stores rows for the attached ids
    const sql = {
      prepare: (q: string) => ({
        bind: () => ({
          all: async () => ({ results: /session_memory_stores/.test(q) ? attached.map((id) => ({ store_id: id, access: "read_write" })) : [] }),
          first: async () => null,
          run: async () => {},
        }),
      }),
    };
    const runtime = createMemoryRuntime({
      memoryService: {
        factsEnabled: () => true,
        searchFacts: async () => [],
        getStore: async ({ storeId }: any) => (storesByName[storeId] ? { id: storeId, name: storesByName[storeId] } : null),
        factStats: async () => ({ total: 0, byKind: {}, lastUpdatedAt: null }),
      } as never,
      sessionsService: {
        get: async () => ({ agent_id: "agent-1", agent_snapshot: { id: "agent-1", memory: { mode, ...(pinned ? { store_id: pinned } : {}) } }, environment_snapshot: null }),
        listResourcesBySession: async () => [],
      } as never,
      sql: sql as never,
      newEventLog: () => ({ getEventsAsync: async () => [] }),
      logger: { warn: () => {} },
    });
    return runtime;
  }

  it("shared: primary = pinned store id when attached; mode reported", async () => {
    const rt = ctxRt("shared", ["st1", "st2"], { st1: "agent-agent-1-memory", st2: "team-shared" }, "st1");
    const ctx = await rt.buildNodeMemoryPromptContext("t", "sess-1");
    expect(ctx.mode).toBe("shared");
    expect(ctx.primaryStoreId).toBe("st1");
    expect(ctx.storeIds.sort()).toEqual(["st1", "st2"]);
    // guidance reminder present because ≥1 store attached; catalog per store
    expect(ctx.reminders[0].source).toBe("memory:guidance");
  });

  it("per_user: primary found by name (principal-keyed or anonymous), env store excluded from tools port scope", async () => {
    const rt = ctxRt("per_user", ["st9", "st2"], { st9: "agent-agent-1-user-ab12cd34ef56", st2: "team-shared" });
    const ctx = await rt.buildNodeMemoryPromptContext("t", "sess-1");
    expect(ctx.mode).toBe("per_user");
    expect(ctx.primaryStoreId).toBe("st9");
    const port = await rt.buildNodeMemoryToolsPort("t", "sess-1", "agent-1");
    expect(port!.stores.map((s) => s.id)).toEqual(["st9"]); // team-shared NOT in scope
  });

  it("off: no primary; all attached stores in scope", async () => {
    const rt = ctxRt("off", ["st2"], { st2: "team-shared" });
    const ctx = await rt.buildNodeMemoryPromptContext("t", "sess-1");
    expect(ctx.mode).toBe("off");
    expect(ctx.primaryStoreId).toBeNull();
    const port = await rt.buildNodeMemoryToolsPort("t", "sess-1", "agent-1");
    expect(port!.stores.map((s) => s.id)).toEqual(["st2"]);
  });
});
