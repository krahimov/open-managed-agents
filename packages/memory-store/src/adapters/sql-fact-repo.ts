// Drizzle implementation of MemoryFactRepo (memory-facts-design §3).
//
// The one place in this package that branches on dialect: full-text search
// is FTS5 (external-content table `memory_facts_fts`, trigger-synced) on
// SQLite and a generated `tsv` tsvector column on Postgres. Everything else
// is dialect-neutral Drizzle. Ranking is deterministic — no LLM — so the
// push path stays cheap and testable.

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  asBuilder,
  getAll,
  getOne,
  runOnce,
  type OmaDb,
  type OmaDbBuilder,
  type OmaDialect,
} from "@open-managed-agents/db-schema";
import { memory_facts } from "@open-managed-agents/db-schema/cf-auth";
import type { MemoryFactRepo, MemoryFactSearchOptions, NewMemoryFactInput } from "../ports";
import type { MemoryFactRow, MemoryFactKind, MemoryFactStatus } from "../types";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

/** Explicit column map so search selects can append a computed `_score`. */
const memoryFactColumns = {
  id: memory_facts.id,
  tenant_id: memory_facts.tenant_id,
  store_id: memory_facts.store_id,
  agent_id: memory_facts.agent_id,
  kind: memory_facts.kind,
  subject: memory_facts.subject,
  statement: memory_facts.statement,
  applies_when: memory_facts.applies_when,
  confidence: memory_facts.confidence,
  status: memory_facts.status,
  supersedes_id: memory_facts.supersedes_id,
  source_path: memory_facts.source_path,
  source_session_id: memory_facts.source_session_id,
  source_event_id: memory_facts.source_event_id,
  observed_at: memory_facts.observed_at,
  created_at: memory_facts.created_at,
  updated_at: memory_facts.updated_at,
};

export class SqlMemoryFactRepo implements MemoryFactRepo {
  private readonly db: OmaDbBuilder;
  constructor(
    db: OmaDb,
    private readonly dialect: OmaDialect = "sqlite",
  ) {
    this.db = asBuilder(db);
  }

  async insert(input: NewMemoryFactInput): Promise<MemoryFactRow> {
    await runOnce(
      this.db.insert(memory_facts).values({
        id: input.id,
        tenant_id: input.tenantId,
        store_id: input.storeId,
        agent_id: input.agentId ?? null,
        kind: input.kind,
        subject: input.subject,
        statement: input.statement,
        applies_when: input.appliesWhen ?? null,
        confidence: input.confidence ?? 1,
        status: "active",
        supersedes_id: input.supersedesId ?? null,
        source_path: input.sourcePath ?? null,
        source_session_id: input.sourceSessionId ?? null,
        source_event_id: input.sourceEventId ?? null,
        observed_at: input.observedAt,
        created_at: input.createdAt,
        updated_at: input.createdAt,
      }),
    );
    const row = await this.findById(input.id);
    if (!row) throw new Error(`memory fact ${input.id} vanished after insert`);
    return row;
  }

  async findById(id: string): Promise<MemoryFactRow | null> {
    const row = await getOne(
      this.db.select().from(memory_facts).where(eq(memory_facts.id, id)),
    );
    return row ? toRow(row) : null;
  }

  async search(storeId: string, opts: MemoryFactSearchOptions): Promise<MemoryFactRow[]> {
    return this.searchMany([storeId], opts);
  }

  async searchMany(storeIds: string[], opts: MemoryFactSearchOptions): Promise<MemoryFactRow[]> {
    if (storeIds.length === 0) return [];
    const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
    const statuses = opts.statuses && opts.statuses.length > 0 ? opts.statuses : ["active"];
    const query = (opts.query ?? "").trim();

    const filters = [
      inArray(memory_facts.store_id, storeIds),
      inArray(memory_facts.status, statuses),
    ];
    if (opts.kinds && opts.kinds.length > 0) filters.push(inArray(memory_facts.kind, opts.kinds));
    if (opts.subject) filters.push(eq(memory_facts.subject, opts.subject));

    if (!query) {
      const rows = await getAll(
        this.db
          .select()
          .from(memory_facts)
          .where(and(...filters))
          .orderBy(desc(memory_facts.observed_at))
          .limit(limit),
      );
      return rows.map(toRow);
    }

    // FTS-ranked branch. Both dialects: match → rank ascending (better first)
    // → tie-break newest first. Over-fetch a little then trim, so kind
    // boosts (rules/preferences first when the query is a task description)
    // can reorder within the candidate set without a second query.
    const fetch = Math.min(limit * 3, MAX_LIMIT);
    let rows: Record<string, unknown>[];
    if (this.dialect === "pg") {
      const tsq = toTsQuery(query);
      rows = await getAll(
        this.db
          .select({
            ...memoryFactColumns,
            _score: sql<number>`-ts_rank(${memory_facts}.tsv, to_tsquery('english', ${tsq}))`,
          })
          .from(memory_facts)
          .where(and(...filters, sql`${memory_facts}.tsv @@ to_tsquery('english', ${tsq})`))
          .orderBy(
            sql`ts_rank(${memory_facts}.tsv, to_tsquery('english', ${tsq})) desc`,
            desc(memory_facts.observed_at),
          )
          .limit(fetch),
      );
    } else {
      const match = toFts5Match(query);
      if (!match) return [];
      // FTS5 external-content: join on rowid; bm25() lower = better.
      rows = await getAll(
        this.db
          .select({
            ...memoryFactColumns,
            _score: sql<number>`(SELECT bm25(memory_facts_fts) FROM memory_facts_fts WHERE memory_facts_fts.rowid = ${memory_facts}.rowid AND memory_facts_fts MATCH ${match})`,
          })
          .from(memory_facts)
          .where(
            and(
              ...filters,
              sql`${memory_facts}.rowid IN (SELECT rowid FROM memory_facts_fts WHERE memory_facts_fts MATCH ${match})`,
            ),
          )
          .orderBy(
            sql`(SELECT bm25(memory_facts_fts) FROM memory_facts_fts WHERE memory_facts_fts.rowid = ${memory_facts}.rowid AND memory_facts_fts MATCH ${match}) asc`,
            desc(memory_facts.observed_at),
          )
          .limit(fetch),
      );
    }
    const scores = rows.map((r) => Number((r as { _score?: unknown })._score ?? 0));
    return rankWithKindBoost(rows.map(toRow), scores).slice(0, limit);
  }

  async setStatus(id: string, status: MemoryFactStatus, updatedAt: number): Promise<void> {
    await runOnce(
      this.db.update(memory_facts).set({ status, updated_at: updatedAt }).where(eq(memory_facts.id, id)),
    );
  }

  async listActiveBySubject(storeId: string, subject: string): Promise<MemoryFactRow[]> {
    const rows = await getAll(
      this.db
        .select()
        .from(memory_facts)
        .where(
          and(
            eq(memory_facts.store_id, storeId),
            eq(memory_facts.subject, subject),
            eq(memory_facts.status, "active"),
          ),
        )
        .orderBy(desc(memory_facts.observed_at)),
    );
    return rows.map(toRow);
  }

  async listBySourcePath(storeId: string, sourcePath: string): Promise<MemoryFactRow[]> {
    const rows = await getAll(
      this.db
        .select()
        .from(memory_facts)
        .where(
          and(
            eq(memory_facts.store_id, storeId),
            eq(memory_facts.source_path, sourcePath),
            eq(memory_facts.status, "active"),
          ),
        ),
    );
    return rows.map(toRow);
  }

  async stats(storeId: string): Promise<{ total: number; byKind: Record<string, number>; lastUpdatedAt: number | null }> {
    const rows = await getAll(
      this.db
        .select({ kind: memory_facts.kind, updated_at: memory_facts.updated_at })
        .from(memory_facts)
        .where(and(eq(memory_facts.store_id, storeId), eq(memory_facts.status, "active"))),
    );
    const byKind: Record<string, number> = {};
    let last: number | null = null;
    for (const r of rows) {
      byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
      if (last === null || r.updated_at > last) last = r.updated_at;
    }
    return { total: rows.length, byKind, lastUpdatedAt: last };
  }

  async deleteByStore(storeId: string): Promise<void> {
    await runOnce(this.db.delete(memory_facts).where(eq(memory_facts.store_id, storeId)));
  }
}

// ---------- helpers ----------

function toRow(r: Record<string, unknown>): MemoryFactRow {
  return {
    id: r.id as string,
    tenant_id: r.tenant_id as string,
    store_id: r.store_id as string,
    agent_id: (r.agent_id as string | null) ?? null,
    kind: r.kind as MemoryFactKind,
    subject: r.subject as string,
    statement: r.statement as string,
    applies_when: (r.applies_when as string | null) ?? null,
    confidence: Number(r.confidence ?? 1),
    status: r.status as MemoryFactStatus,
    supersedes_id: (r.supersedes_id as string | null) ?? null,
    source_path: (r.source_path as string | null) ?? null,
    source_session_id: (r.source_session_id as string | null) ?? null,
    source_event_id: (r.source_event_id as string | null) ?? null,
    observed_at: Number(r.observed_at),
    created_at: Number(r.created_at),
    updated_at: Number(r.updated_at),
  };
}

const STOP = new Set([
  "a","an","the","and","or","of","to","in","on","for","with","about","is","are","was","were","be",
  "it","this","that","these","those","i","you","we","they","he","she","my","our","your","their",
  "please","can","could","would","should","do","does","did","me","us","them","at","by","from","as",
]);

/** Tokenize a free-text query into search terms (lowercase, alnum, no stopwords). */
export function queryTerms(query: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of query.toLowerCase().split(/[^a-z0-9@._-]+/)) {
    const t = raw.replace(/^[._-]+|[._-]+$/g, "");
    if (t.length < 2 || STOP.has(t) || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 24) break;
  }
  return out;
}

/** FTS5 MATCH expression: OR of quoted terms (prefix-matched), so a task
 *  description like "draft a note about their contract" hits a rule whose
 *  subject is "vendor contracts". Quoting neutralizes FTS5 syntax chars. */
export function toFts5Match(query: string): string {
  const terms = queryTerms(query);
  if (terms.length === 0) return "";
  return terms.map((t) => `"${t.replace(/"/g, '""')}"*`).join(" OR ");
}

/** Postgres to_tsquery input: OR of prefix-matched lexemes. */
export function toTsQuery(query: string): string {
  const terms = queryTerms(query);
  if (terms.length === 0) return "";
  return terms.map((t) => `${t.replace(/[^a-z0-9@._-]/g, "")}:*`).join(" | ");
}

const KIND_BOOST: Record<MemoryFactKind, number> = {
  rule: 0,
  preference: 1,
  decision: 2,
  entity: 3,
  note: 4,
};

/**
 * Kind-aware re-rank. FTS relevance dominates: rows arrive in FTS order with
 * an optional per-row `score` (bm25 → lower is better; ts_rank → higher is
 * better; both normalized by the caller to "smaller = better"). Rules and
 * preferences are floated ahead ONLY of rows whose score ties theirs
 * (within `epsilon`), so a clearly-more-relevant decision still beats a
 * marginally-matched rule. Without scores, kind boost applies only among
 * adjacent rows — never across the list.
 */
export function rankWithKindBoost(
  rows: MemoryFactRow[],
  scores?: number[],
  epsilon = 1e-6,
): MemoryFactRow[] {
  const idx = rows.map((r, i) => ({ r, i, s: scores?.[i] }));
  idx.sort((a, b) => {
    if (a.s !== undefined && b.s !== undefined) {
      if (Math.abs(a.s - b.s) > epsilon) return a.s - b.s;
    } else if (Math.abs(a.i - b.i) > 1) {
      return a.i - b.i;
    }
    const ka = KIND_BOOST[a.r.kind] ?? 9;
    const kb = KIND_BOOST[b.r.kind] ?? 9;
    if (ka !== kb) return ka - kb;
    return a.i - b.i;
  });
  return idx.map((x) => x.r);
}
