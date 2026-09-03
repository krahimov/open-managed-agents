// MemoryExtractionRunner control flow (memory-facts-design §4) with a fake
// model + fake ports: cursor idempotency, failure semantics (no cursor
// advance / no supersede on model failure), file trigger supersede-on-
// success only, and skip rules.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryExtractionRunner } from "../src/lib/memory-extraction-runner";

// generateText is what the runner calls; stub it per test.
vi.mock("ai", () => ({ generateText: vi.fn() }));
import { generateText } from "ai";
const gen = generateText as unknown as ReturnType<typeof vi.fn>;
beforeEach(() => gen.mockReset());

function harness(opts: { events?: any[]; stores?: string[]; readFile?: string | null } = {}) {
  const kv = new Map<string, string>();
  const remembered: any[] = [];
  const superseded: any[] = [];
  const active: any[] = [{ id: "mfact-1", kind: "rule", subject: "vendor contracts", statement: "CC legal@ on vendor contracts", store_id: "st1", tenant_id: "t" }];
  const runner = new MemoryExtractionRunner({
    memoryService: {
      factsEnabled: () => true,
      rememberFact: async (o: any) => { remembered.push(o); return { id: `mfact-${remembered.length + 1}`, ...o }; },
      searchFacts: async () => active,
      supersedeFactsFromPath: async (o: any) => { superseded.push(o); return 1; },
      getStore: async () => ({ id: "st1", name: "agent-a-memory" }),
      readByPath: async () => (opts.readFile === null ? null : { content: opts.readFile ?? "# prefs\n- always CC legal@ on vendor contracts" }),
    } as never,
    kv: { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => { kv.set(k, v); }, delete: async () => {}, list: async () => ({ keys: [] }) } as never,
    listWritableStores: async () => opts.stores ?? ["st1"],
    fetchEvents: async (_sid, afterSeq) => (opts.events ?? [
      { id: "e1", seq: 1, type: "user.message", data: { content: [{ type: "text", text: "we chose Northwind for payroll on July 22" }] } },
      { id: "e2", seq: 2, type: "agent.message", data: { content: [{ type: "text", text: "noted" }] } },
    ]).filter((e) => e.seq > afterSeq),
    sessionAgent: async () => ({ agentId: "agent-a" }),
    resolveModel: async () => ({ model: {} as never, modelId: "fake-model" }),
    debounceMs: 1,
  });
  return { runner, kv, remembered, superseded };
}

describe("MemoryExtractionRunner.runSession", () => {
  it("persists facts and advances the cursor on a successful model call", async () => {
    gen.mockResolvedValueOnce({ text: JSON.stringify([{ kind: "decision", subject: "payroll vendor", statement: "Northwind chosen July 22.", confidence: 0.95, source_event_id: "e1" }]), usage: { inputTokens: 10, outputTokens: 5 } });
    const h = harness();
    const r = await h.runner.runSession("t", "s1");
    expect(r).toEqual({ extracted: 1, skipped: null });
    expect(h.remembered[0]).toMatchObject({ storeId: "st1", kind: "decision", subject: "payroll vendor", sourceSessionId: "s1", sourceEventId: "e1" });
    expect(h.kv.get("t:t:memfacts:cursor:s1")).toBe("2");
    // second run: nothing new → no-new-events, no model call
    const r2 = await h.runner.runSession("t", "s1");
    expect(r2.skipped).toBe("no-new-events");
    expect(gen).toHaveBeenCalledTimes(1);
  });

  it("does NOT advance the cursor when the model call fails (transient outage safe)", async () => {
    gen.mockRejectedValueOnce(new Error("503"));
    const h = harness();
    const r = await h.runner.runSession("t", "s1");
    expect(r.skipped).toBe("model-failed");
    expect(h.kv.has("t:t:memfacts:cursor:s1")).toBe(false);
    expect(h.remembered).toHaveLength(0);
    // retry succeeds and re-reads the same turns
    gen.mockResolvedValueOnce({ text: "[]" });
    const r2 = await h.runner.runSession("t", "s1");
    expect(r2).toEqual({ extracted: 0, skipped: null });
    expect(h.kv.get("t:t:memfacts:cursor:s1")).toBe("2");
  });

  it("skips sessions with no writable store and with no user turns (but advances cursor for the latter)", async () => {
    const h1 = harness({ stores: [] });
    expect((await h1.runner.runSession("t", "s1")).skipped).toBe("no-writable-store");
    const h2 = harness({ events: [{ seq: 5, type: "agent.message", data: { content: [{ type: "text", text: "hi" }] } }] });
    expect((await h2.runner.runSession("t", "s2")).skipped).toBe("no-user-turns");
    expect(h2.kv.get("t:t:memfacts:cursor:s2")).toBe("5");
  });
});

describe("MemoryExtractionRunner.noteMemoryFileWrite (trigger B)", () => {
  it("supersedes the path's facts ONLY after a successful extraction, then persists with source_path", async () => {
    gen.mockResolvedValueOnce({ text: JSON.stringify([{ kind: "rule", subject: "vendor contracts", statement: "Always CC legal@ on vendor contracts.", confidence: 0.9 }]) });
    const h = harness();
    await h.runner.noteMemoryFileWrite("t", "st1", "prefs.md", "agent-a");
    expect(h.superseded).toEqual([{ tenantId: "t", storeId: "st1", sourcePath: "prefs.md" }]);
    expect(h.remembered[0]).toMatchObject({ sourcePath: "prefs.md", kind: "rule" });
  });

  it("on model failure: no supersede, no persist (index preserved)", async () => {
    gen.mockRejectedValueOnce(new Error("timeout"));
    const h = harness();
    await h.runner.noteMemoryFileWrite("t", "st1", "prefs.md", "agent-a");
    expect(h.superseded).toHaveLength(0);
    expect(h.remembered).toHaveLength(0);
  });

  it("ignores facts.md, non-text paths, and empty files", async () => {
    const h = harness({ readFile: "" });
    await h.runner.noteMemoryFileWrite("t", "st1", "facts.md", "agent-a");
    await h.runner.noteMemoryFileWrite("t", "st1", "image.png", "agent-a");
    await h.runner.noteMemoryFileWrite("t", "st1", "empty.md", "agent-a");
    expect(gen).not.toHaveBeenCalled();
    expect(h.superseded).toHaveLength(0);
  });
});
