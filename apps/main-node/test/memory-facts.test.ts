// Memory facts (docs/memory-facts-design.md §3) — real SQLite, real
// migrations (incl. the FTS5 external-content table + triggers), real
// SqlMemoryFactRepo + MemoryStoreService. What's under test: schema applies,
// FTS-ranked search finds facts from task-shaped queries, kind boost, the
// supersession chain, idempotent remember, stats, retract, and the query
// helpers.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createSqliteMemoryStoreService,
  queryTerms,
  toFts5Match,
  toTsQuery,
  rankWithKindBoost,
} from "@open-managed-agents/memory-store";
import type { MemoryStoreService } from "@open-managed-agents/memory-store";
import { appendFactsMdLine } from "../src/lib/memory-runtime";

const here = path.dirname(fileURLToPath(import.meta.url));
const TENANT = "t_facts";

// Minimal in-memory BlobStore honoring the CAS preconditions the service
// relies on (ifMatch etag / ifNoneMatch *) — put returns null on conflict.
class MemBlobs {
  private m = new Map<string, { text: string; etag: string }>();
  private n = 0;
  async head(key: string) { const v = this.m.get(key); return v ? { etag: v.etag, size: v.text.length } : null; }
  async getText(key: string) { const v = this.m.get(key); return v ? { text: v.text, etag: v.etag } : null; }
  async put(key: string, text: string, opts?: { precondition?: { type: string; etag?: string } }) {
    const cur = this.m.get(key);
    const pc = opts?.precondition;
    if (pc?.type === "ifNoneMatch" && cur) return null;
    if (pc?.type === "ifMatch" && (!cur || cur.etag !== pc.etag)) return null;
    const etag = `e${++this.n}`;
    this.m.set(key, { text, etag });
    return { etag, size: text.length };
  }
  async delete(key: string) { this.m.delete(key); }
  async list() { return []; }
}

let sqlite: Database.Database;
let svc: MemoryStoreService;
let storeId: string;

beforeAll(async () => {
  sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: path.resolve(here, "../migrations-sqlite") });
  svc = createSqliteMemoryStoreService({ db, blobs: new MemBlobs() as never, dialect: "sqlite" });
  const store = await svc.createStore({ tenantId: TENANT, name: "ea-memory" });
  storeId = store.id;
});
afterAll(() => sqlite.close());

describe("schema", () => {
  it("applies memory_facts + FTS5 shadow table + triggers", () => {
    const tables = sqlite.prepare("select name from sqlite_master where type in ('table','trigger') order by name").all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("memory_facts");
    expect(names).toContain("memory_facts_fts");
    expect(names).toContain("memory_facts_ai");
    expect(names).toContain("memory_facts_au");
    expect(names).toContain("memory_facts_ad");
  });
});

describe("rememberFact / searchFacts", () => {
  it("records facts and finds them from a task-shaped query via FTS", async () => {
    await svc.rememberFact({
      tenantId: TENANT, storeId, kind: "rule", subject: "vendor contracts",
      statement: "Always CC legal@ on any vendor contract correspondence.",
      appliesWhen: "drafting or sending vendor contract emails or notes",
      sourceSessionId: "sess-1", observedAt: 1000,
    });
    await svc.rememberFact({
      tenantId: TENANT, storeId, kind: "preference", subject: "meeting hours",
      statement: "No meetings before 10:00 AM, ever.", appliesWhen: "scheduling",
      sourceSessionId: "sess-1", observedAt: 1001,
    });
    await svc.rememberFact({
      tenantId: TENANT, storeId, kind: "decision", subject: "payroll vendor",
      statement: "Northwind was approved as the payroll vendor on July 22; the decision is closed.",
      sourceSessionId: "sess-1", observedAt: 1002,
    });

    const hits = await svc.searchFacts({
      tenantId: TENANT, storeIds: [storeId],
      query: "draft a short note to Acme Cleaning about their contract",
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].subject).toBe("vendor contracts");
    expect(hits[0].kind).toBe("rule");

    const vendor = await svc.searchFacts({ tenantId: TENANT, storeIds: [storeId], query: "which payroll vendor did we pick" });
    expect(vendor[0].subject).toBe("payroll vendor");

    const sched = await svc.searchFacts({ tenantId: TENANT, storeIds: [storeId], query: "book a 9am meeting tomorrow", kinds: ["preference", "rule"] });
    expect(sched.map((f) => f.subject)).toContain("meeting hours");
  });

  it("filter-only listing (no query) orders newest first and honors kinds", async () => {
    const all = await svc.searchFacts({ tenantId: TENANT, storeIds: [storeId] });
    expect(all.map((f) => f.subject)).toEqual(["payroll vendor", "meeting hours", "vendor contracts"]);
    const rules = await svc.searchFacts({ tenantId: TENANT, storeIds: [storeId], kinds: ["rule"] });
    expect(rules).toHaveLength(1);
  });

  it("is idempotent for an identical statement", async () => {
    const before = (await svc.factStats({ tenantId: TENANT, storeId })).total;
    const again = await svc.rememberFact({
      tenantId: TENANT, storeId, kind: "preference", subject: "Meeting Hours",
      statement: "No meetings before 10:00 AM, ever.",
    });
    expect(again.subject).toBe("meeting hours");
    expect((await svc.factStats({ tenantId: TENANT, storeId })).total).toBe(before);
  });
});

describe("supersession", () => {
  it("a new decision on the same subject supersedes the old one and links the chain", async () => {
    const gusto = await svc.rememberFact({
      tenantId: TENANT, storeId, kind: "decision", subject: "payroll vendor",
      statement: "Switched payroll vendor to Gusto on Sept 3.", observedAt: 2000,
    });
    expect(gusto.supersedes_id).toBeTruthy();

    // Only the new one is active
    const active = await svc.searchFacts({ tenantId: TENANT, storeIds: [storeId], subject: "payroll vendor" });
    expect(active).toHaveLength(1);
    expect(active[0].statement).toContain("Gusto");

    // History available on request; FTS on old wording finds the superseded row only with history
    const noHist = await svc.searchFacts({ tenantId: TENANT, storeIds: [storeId], query: "Northwind" });
    expect(noHist).toHaveLength(0);
    const hist = await svc.searchFacts({ tenantId: TENANT, storeIds: [storeId], query: "Northwind", includeHistory: true });
    expect(hist).toHaveLength(1);
    expect(hist[0].status).toBe("superseded");

    // getFact walks the chain
    const got = await svc.getFact({ tenantId: TENANT, factId: gusto.id });
    expect(got?.chain).toHaveLength(1);
    expect(got?.chain[0].statement).toContain("Northwind");
  });

  it("entity/note kinds do not collapse by subject", async () => {
    await svc.rememberFact({ tenantId: TENANT, storeId, kind: "entity", subject: "acme cleaning", statement: "Contact: contracts@acmecleaning.com" });
    await svc.rememberFact({ tenantId: TENANT, storeId, kind: "entity", subject: "acme cleaning", statement: "Contract received Aug 12; review due in 5 business days" });
    const acme = await svc.searchFacts({ tenantId: TENANT, storeIds: [storeId], subject: "acme cleaning" });
    expect(acme).toHaveLength(2);
  });

  it("supersedeFactsFromPath retires facts extracted from an edited file", async () => {
    await svc.rememberFact({ tenantId: TENANT, storeId, kind: "note", subject: "office", statement: "Office wifi is on the 3rd floor.", sourcePath: "notes.md" });
    const n = await svc.supersedeFactsFromPath({ tenantId: TENANT, storeId, sourcePath: "notes.md" });
    expect(n).toBe(1);
    const active = await svc.searchFacts({ tenantId: TENANT, storeIds: [storeId], subject: "office" });
    expect(active).toHaveLength(0);
  });
});

describe("retract + stats + tenant scoping", () => {
  it("retract hides a fact from default search; stats count active only, by kind", async () => {
    const f = await svc.rememberFact({ tenantId: TENANT, storeId, kind: "note", subject: "temp", statement: "Throwaway." });
    expect(await svc.retractFact({ tenantId: TENANT, factId: f.id })).toBe(true);
    expect(await svc.retractFact({ tenantId: "other", factId: f.id })).toBe(false);
    const stats = await svc.factStats({ tenantId: TENANT, storeId });
    expect(stats.byKind.rule).toBe(1);
    expect(stats.byKind.preference).toBe(1);
    expect(stats.byKind.decision).toBe(1); // Gusto (Northwind superseded)
    expect(stats.byKind.entity).toBe(2);
    expect(stats.byKind.note ?? 0).toBe(0);
    expect(stats.total).toBe(5);
    expect(stats.lastUpdatedAt).toBeGreaterThan(0);
  });

  it("getFact refuses cross-tenant reads", async () => {
    const [any] = await svc.searchFacts({ tenantId: TENANT, storeIds: [storeId], limit: 1 });
    expect(await svc.getFact({ tenantId: "other", factId: any.id })).toBeNull();
  });
});

describe("query helpers", () => {
  it("queryTerms strips stopwords/short tokens, keeps emails/ids", () => {
    expect(queryTerms("Please draft a note to Acme about their contract, CC legal@")).toEqual(["draft","note","acme","contract","cc","legal@"]);
  });
  it("toFts5Match quotes + prefix-matches, ORs terms; empty for stopword-only", () => {
    expect(toFts5Match("the contract")).toBe('"contract"*');
    expect(toFts5Match("payroll vendor")).toBe('"payroll"* OR "vendor"*');
    expect(toFts5Match("the a an")).toBe("");
  });
  it("toTsQuery emits prefix lexemes joined by |", () => {
    expect(toTsQuery("payroll vendor")).toBe("payroll:* | vendor:*");
  });
  it("rankWithKindBoost: relevance dominates; kind only breaks score ties", () => {
    const mk = (kind: string, i: number) => ({ kind, id: `${kind}${i}` }) as never;
    // Scores (smaller = better): decision clearly best; rule and note tie; preference worst.
    const rows = [mk("note",0), mk("rule",1), mk("decision",2), mk("preference",3)];
    const out = rankWithKindBoost(rows, [-2.0, -2.0, -5.0, -0.5]);
    expect(out.map((r: { id: string }) => r.id)).toEqual(["decision2","rule1","note0","preference3"]);
    // Without scores: only adjacent rows may swap by kind.
    const out2 = rankWithKindBoost([mk("note",0), mk("rule",1), mk("note",2), mk("rule",3)]);
    expect(out2.map((r: { id: string }) => r.id)).toEqual(["rule1","note0","rule3","note2"]);
  });
});

describe("facts.md atomic append (memory_remember lost-update regression)", () => {
  it("3 concurrent appends all land (CAS + retry), in some order, no lines lost", async () => {
    const store = await svc.createStore({ tenantId: TENANT, name: "cas-store" });
    const lines = ["- 2026-08-18 [preference] a: one", "- 2026-08-18 [rule] b: two", "- 2026-08-18 [decision] c: three"];
    await Promise.all(lines.map((line) => appendFactsMdLine(svc, { tenantId: TENANT, storeId: store.id, actor: { type: "system", id: "test" }, line })));
    const row = await svc.readByPath({ tenantId: TENANT, storeId: store.id, path: "facts.md" });
    expect(row).not.toBeNull();
    const body = row!.content;
    for (const l of lines) expect(body).toContain(l);
    expect(body.startsWith("# Facts\n")).toBe(true);
    // exactly three fact lines
    expect(body.split("\n").filter((x) => x.startsWith("- ")).length).toBe(3);
  });

  it("sequential appends preserve order and the header once", async () => {
    const store = await svc.createStore({ tenantId: TENANT, name: "cas-store-2" });
    await appendFactsMdLine(svc, { tenantId: TENANT, storeId: store.id, actor: { type: "system", id: "t" }, line: "- x" });
    await appendFactsMdLine(svc, { tenantId: TENANT, storeId: store.id, actor: { type: "system", id: "t" }, line: "- y" });
    const row = await svc.readByPath({ tenantId: TENANT, storeId: store.id, path: "facts.md" });
    expect(row!.content).toBe("# Facts\n\n- x\n- y\n");
  });
});

