// MemoryExtractionRunner — Node driver for memory-facts-design §4.
//
// Trigger A (turn end): `noteSessionIdle(tenantId, sessionId)` from the
// session registry's onSessionEvent tap. Debounced per session (a burst of
// idles collapses to one job) and watermarked by the last extracted event
// seq (kept in KV under t:<tenant>:memfacts:cursor:<session>) so a job is
// idempotent and only new turns are re-read.
//
// Trigger B (file write): `noteMemoryFileWrite(tenantId, storeId, path)`
// from the write-observer. Supersedes that path's prior facts, then
// re-extracts the whole file.
//
// All IO goes through small ports so this stays unit-testable; the
// composition root wires memoryService / event log / KV / model.

import { generateText, type LanguageModel } from "ai";
import type { MemoryStoreService, MemoryFactKind } from "@open-managed-agents/memory-store";
import type { KvStore } from "@open-managed-agents/kv-store";
import {
  buildExtractionPrompt,
  parseExtractedFacts,
  renderTranscriptSlice,
  pickRelatedSubjects,
  type ExtractedFact,
} from "./memory-extractor.js";

export interface MemoryExtractionDeps {
  memoryService: Pick<
    MemoryStoreService,
    "factsEnabled" | "rememberFact" | "searchFacts" | "supersedeFactsFromPath" | "getStore" | "readByPath"
  >;
  kv: KvStore;
  /** Attached read-write stores for a session (same source as the prompt reminder). */
  listWritableStores: (tenantId: string, sessionId: string) => Promise<string[]>;
  /** Events after `afterSeq` for a session, ascending. */
  fetchEvents: (
    sessionId: string,
    afterSeq: number,
  ) => Promise<Array<{ id?: string; seq: number; type: string; data?: unknown }>>;
  /** Agent id + config for the session (aux model + reasoning). */
  sessionAgent: (tenantId: string, sessionId: string) => Promise<{ agentId: string; auxModel?: unknown } | null>;
  /** Resolve the extractor model. Implementations pick agent.aux_model
   *  when set, else the agent's model at low reasoning. */
  resolveModel: (tenantId: string, agentId: string) => Promise<{ model: LanguageModel; modelId: string } | null>;
  /** Broadcast an aux.model_call into the session's stream (best-effort). */
  emitAuxCall?: (sessionId: string, ev: Record<string, unknown>) => Promise<void> | void;
  log?: (msg: string, ctx?: Record<string, unknown>) => void;
  /** Debounce window for turn-end triggers. */
  debounceMs?: number;
  /** Optional: skip extraction for sessions matching (e.g. eval trials). */
  shouldSkipSession?: (tenantId: string, sessionId: string) => Promise<boolean>;
}

const CURSOR_PREFIX = "memfacts:cursor";
const MAX_OUTPUT_TOKENS = 4_096;

export class MemoryExtractionRunner {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private inflight = new Set<string>();
  private readonly debounceMs: number;
  constructor(private readonly deps: MemoryExtractionDeps) {
    this.debounceMs = deps.debounceMs ?? 4_000;
  }

  /** Trigger A. Safe to call on every event — no-ops for non-idle. */
  noteSessionEvent(tenantId: string, sessionId: string, eventType: string): void {
    if (eventType !== "session.status_idle") return;
    if (!this.deps.memoryService.factsEnabled()) return;
    const key = `${tenantId}:${sessionId}`;
    const prev = this.timers.get(key);
    if (prev) clearTimeout(prev);
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        void this.runSession(tenantId, sessionId).catch((err) =>
          this.deps.log?.("memory extract: session job failed", { session_id: sessionId, err: String(err) }),
        );
      }, this.debounceMs),
    );
  }

  /** Trigger B. */
  async noteMemoryFileWrite(tenantId: string, storeId: string, path: string, agentId?: string): Promise<void> {
    if (!this.deps.memoryService.factsEnabled()) return;
    if (!/\.(md|txt|markdown)$/i.test(path)) return;
    // facts.md is written BY memory_remember (already indexed) — skip.
    if (path === "facts.md") return;
    const key = `file:${storeId}:${path}`;
    if (this.inflight.has(key)) return;
    this.inflight.add(key);
    try {
      const row = await this.deps.memoryService.readByPath({ tenantId, storeId, path });
      if (!row?.content?.trim()) return;
      const resolvedAgent = agentId ?? null;
      const model = resolvedAgent ? await this.deps.resolveModel(tenantId, resolvedAgent) : null;
      if (!model) {
        this.deps.log?.("memory extract: no model for file trigger; skipped", { store_id: storeId, path });
        return;
      }
      const active = await this.relatedActive(tenantId, storeId, row.content);
      const res = await this.callExtractor(model, {
        mode: "file",
        text: row.content,
        sourcePath: path,
        activeFacts: active,
      }, null);
      // Only on a SUCCESSFUL model call do we retire the path's prior facts
      // and persist the new set — a transient provider failure must not
      // wipe a file's index (the next write re-triggers).
      if (!res.ok) return;
      await this.deps.memoryService.supersedeFactsFromPath({ tenantId, storeId, sourcePath: path });
      await this.persist(tenantId, storeId, res.facts, { agentId: resolvedAgent, sourcePath: path, sourceSessionId: null });
    } finally {
      this.inflight.delete(key);
    }
  }

  /** Extract from a session's new turns. Exposed for tests / manual runs. */
  async runSession(tenantId: string, sessionId: string): Promise<{ extracted: number; skipped: string | null }> {
    const key = `${tenantId}:${sessionId}`;
    if (this.inflight.has(key)) return { extracted: 0, skipped: "inflight" };
    this.inflight.add(key);
    try {
      if (this.deps.shouldSkipSession && (await this.deps.shouldSkipSession(tenantId, sessionId))) {
        return { extracted: 0, skipped: "excluded" };
      }
      const stores = await this.deps.listWritableStores(tenantId, sessionId);
      if (stores.length === 0) return { extracted: 0, skipped: "no-writable-store" };
      const agent = await this.deps.sessionAgent(tenantId, sessionId);
      if (!agent) return { extracted: 0, skipped: "no-agent" };

      const cursorKey = `t:${tenantId}:${CURSOR_PREFIX}:${sessionId}`;
      const afterSeq = Number((await this.deps.kv.get(cursorKey)) ?? 0) || 0;
      const events = await this.deps.fetchEvents(sessionId, afterSeq);
      if (events.length === 0) return { extracted: 0, skipped: "no-new-events" };
      const lastSeq = events[events.length - 1].seq;
      const slice = renderTranscriptSlice(events);
      if (!slice.trim() || !events.some((e) => e.type === "user.message")) {
        await this.deps.kv.put(cursorKey, String(lastSeq));
        return { extracted: 0, skipped: "no-user-turns" };
      }

      const model = await this.deps.resolveModel(tenantId, agent.agentId);
      if (!model) return { extracted: 0, skipped: "no-model" };

      // Facts go to the first writable store (agent's own / first attached).
      const storeId = stores[0];
      const active = await this.relatedActive(tenantId, storeId, slice);
      const res = await this.callExtractor(model, { mode: "transcript", text: slice, activeFacts: active }, sessionId);
      // A failed model call leaves the cursor untouched so the next idle
      // re-reads the same turns; a successful call (even with zero facts)
      // advances it.
      if (!res.ok) return { extracted: 0, skipped: "model-failed" };
      const n = await this.persist(tenantId, storeId, res.facts, { agentId: agent.agentId, sourcePath: null, sourceSessionId: sessionId });
      await this.deps.kv.put(cursorKey, String(lastSeq));
      this.deps.log?.("memory extract: session done", { session_id: sessionId, store_id: storeId, extracted: n, upto_seq: lastSeq });
      return { extracted: n, skipped: null };
    } finally {
      this.inflight.delete(key);
    }
  }

  private async relatedActive(tenantId: string, storeId: string, text: string) {
    // Pull a bounded set of active facts and keep those whose subject the
    // text mentions — the extractor uses them for supersession.
    const all = await this.deps.memoryService.searchFacts({ tenantId, storeIds: [storeId], limit: 50 });
    const subjects = [...new Set(all.map((f) => f.subject))];
    const related = new Set(pickRelatedSubjects(text, subjects));
    return all.filter((f) => related.has(f.subject)).map((f) => ({ id: f.id, kind: f.kind, subject: f.subject, statement: f.statement }));
  }

  private async callExtractor(
    m: { model: LanguageModel; modelId: string },
    input: Parameters<typeof buildExtractionPrompt>[0] extends infer T ? Omit<T, "nowIso"> : never,
    sessionId: string | null,
  ): Promise<{ ok: true; facts: ExtractedFact[] } | { ok: false }> {
    const prompt = buildExtractionPrompt({ ...input, nowIso: new Date().toISOString() } as Parameters<typeof buildExtractionPrompt>[0]);
    const t0 = Date.now();
    let text = "";
    let usage = { input: 0, output: 0 };
    let status: "ok" | "failed" = "ok";
    try {
      const res = await generateText({
        model: m.model,
        system: prompt.system,
        messages: [{ role: "user", content: prompt.user }],
        maxOutputTokens: MAX_OUTPUT_TOKENS,
      });
      text = res.text ?? "";
      usage = { input: res.usage?.inputTokens ?? 0, output: res.usage?.outputTokens ?? 0 };
    } catch (err) {
      status = "failed";
      this.deps.log?.("memory extract: model call failed", { err: String(err) });
    }
    if (sessionId && this.deps.emitAuxCall) {
      await Promise.resolve(
        this.deps.emitAuxCall(sessionId, {
          type: "aux.model_call",
          model_id: m.modelId,
          task: "memory_extract",
          duration_ms: Date.now() - t0,
          tokens: usage,
          status,
        }),
      ).catch(() => {});
    }
    return status === "ok" ? { ok: true, facts: parseExtractedFacts(text) } : { ok: false };
  }

  private async persist(
    tenantId: string,
    storeId: string,
    facts: ExtractedFact[],
    prov: { agentId: string | null; sourcePath: string | null; sourceSessionId: string | null },
  ): Promise<number> {
    let n = 0;
    for (const f of facts) {
      try {
        await this.deps.memoryService.rememberFact({
          tenantId,
          storeId,
          agentId: prov.agentId,
          kind: f.kind as MemoryFactKind,
          subject: f.subject,
          statement: f.statement,
          appliesWhen: f.applies_when ?? null,
          confidence: f.confidence,
          supersedesId: f.supersedes ?? null,
          sourcePath: prov.sourcePath,
          sourceSessionId: prov.sourceSessionId,
          sourceEventId: f.source_event_id ?? null,
        });
        n++;
      } catch (err) {
        this.deps.log?.("memory extract: persist failed", { subject: f.subject, err: String(err) });
      }
    }
    return n;
  }
}
