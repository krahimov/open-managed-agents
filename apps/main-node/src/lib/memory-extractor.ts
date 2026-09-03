// Memory fact extraction (docs/memory-facts-design.md §4).
//
// Two triggers, one extractor:
//   A. turn end — session.status_idle for a session with ≥1 read-write
//      store attached → extract from the transcript slice since the last
//      extraction (idempotent per (session_id, last_seq)).
//   B. memory file write — the write-observer reflects /mnt/memory edits
//      into `memories`; a text-file change → extract from the file, after
//      superseding that path's prior facts.
//
// The extractor is an aux-tier LLM call with a strict JSON contract; every
// call is attributed via aux.model_call {task: "memory_extract"}. Facts
// under `confidence < 0.6` are dropped. Supersession is detected by showing
// the model the store's active facts on subjects the slice mentions.
//
// Pure prompt/parse helpers are exported for unit tests; the runner
// (`MemoryExtractionRunner`) owns debouncing + IO.

import type { MemoryFactKind } from "@open-managed-agents/memory-store";

export interface ExtractedFact {
  kind: MemoryFactKind;
  subject: string;
  statement: string;
  applies_when?: string;
  confidence: number;
  supersedes?: string;
  source_event_id?: string;
}

export const EXTRACT_MIN_CONFIDENCE = 0.6;
export const EXTRACT_MAX_FACTS = 12;
const SLICE_CHAR_BUDGET = 16_000;
const FILE_CHAR_BUDGET = 12_000;

const KINDS = new Set<MemoryFactKind>(["preference", "decision", "rule", "entity", "note"]);

export function buildExtractionPrompt(input: {
  mode: "transcript" | "file";
  /** Transcript slice (User:/Agent: lines with [event id] markers) or file text. */
  text: string;
  sourcePath?: string;
  /** Active facts on subjects that MAY be affected — for supersession detection. */
  activeFacts: Array<{ id: string; kind: string; subject: string; statement: string }>;
  nowIso: string;
}): { system: string; user: string } {
  const system = [
    "You extract DURABLE facts from an AI assistant's conversation or memory notes into a structured index. The index is queried in future sessions to recall the user's standing rules, preferences, decisions, and known entities.",
    "",
    "Extract ONLY facts that would still be true and useful a month from now:",
    "- rule: a standing instruction (\"always CC legal@ on vendor contracts\").",
    "- preference: how the user likes things (\"no meetings before 10am\", \"terse replies\").",
    "- decision: a choice that was made, with when if stated (\"Northwind chosen as payroll vendor on July 22\").",
    "- entity: a durable attribute of a person/org/thing (\"Acme Cleaning contact: contracts@acmecleaning.com\").",
    "- note: other durable context that fits none of the above (use sparingly).",
    "SKIP: one-off task requests, greetings, the assistant's own narration, transient status (\"waiting on approval\"), anything already implied by an existing fact with the same meaning.",
    "",
    "Rules for each fact:",
    "- `subject`: short lowercase noun phrase (2–4 words) naming what the fact is about; reuse an existing subject when it matches.",
    "- `statement`: ONE self-contained sentence — no \"this\", \"that\", \"the vendor\"; include dates when stated.",
    "- `applies_when` (rules/preferences): when it should be applied, as a task description (\"drafting or sending vendor contract emails\").",
    "- `confidence` 0..1: 1.0 = the user stated it plainly; ≤0.5 = inferred. Prefer fewer, higher-confidence facts.",
    "- `supersedes`: if the text CONTRADICTS or REPLACES one of the existing facts listed, set it to that fact's id.",
    "- `source_event_id`: the [event id] of the line the fact comes from (transcript mode only).",
    "",
    `Reply with EXACTLY one JSON array of fact objects (may be empty []), no prose: [{"kind":"rule|preference|decision|entity|note","subject":"…","statement":"…","applies_when":"…","confidence":0.9,"supersedes":"<id or omit>","source_event_id":"<id or omit>"}]`,
  ].join("\n");

  const existing = input.activeFacts.length
    ? input.activeFacts.map((f) => `- ${f.id} [${f.kind}] ${f.subject}: ${f.statement}`).join("\n")
    : "(none)";
  const body = input.text.length > (input.mode === "file" ? FILE_CHAR_BUDGET : SLICE_CHAR_BUDGET)
    ? input.text.slice(0, input.mode === "file" ? FILE_CHAR_BUDGET : SLICE_CHAR_BUDGET) + "\n…(truncated)"
    : input.text;
  const user = [
    `Today: ${input.nowIso.slice(0, 10)}`,
    "",
    "## Existing active facts on possibly-related subjects",
    existing,
    "",
    input.mode === "file"
      ? `## Memory file: ${input.sourcePath ?? "(unknown)"}\n${body}`
      : `## Conversation slice (newest last)\n${body}`,
    "",
    "Extract the durable facts now.",
  ].join("\n");
  return { system, user };
}

/** Tolerant parse: whole text → fenced block → outermost [..]. Drops
 *  malformed entries, clamps confidence, filters below the threshold. */
export function parseExtractedFacts(text: string): ExtractedFact[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const candidates = [trimmed];
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) candidates.push(fence[1].trim());
  const a = trimmed.indexOf("[");
  const b = trimmed.lastIndexOf("]");
  if (a !== -1 && b > a) candidates.push(trimmed.slice(a, b + 1));
  for (const c of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(c);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    const out: ExtractedFact[] = [];
    for (const raw of parsed) {
      const f = raw as Partial<Record<keyof ExtractedFact, unknown>>;
      if (!f || typeof f !== "object") continue;
      if (typeof f.kind !== "string" || !KINDS.has(f.kind as MemoryFactKind)) continue;
      if (typeof f.subject !== "string" || !f.subject.trim()) continue;
      if (typeof f.statement !== "string" || !f.statement.trim()) continue;
      const conf = typeof f.confidence === "number" && Number.isFinite(f.confidence)
        ? Math.max(0, Math.min(1, f.confidence))
        : 0.7;
      if (conf < EXTRACT_MIN_CONFIDENCE) continue;
      out.push({
        kind: f.kind as MemoryFactKind,
        subject: f.subject.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 120),
        statement: f.statement.trim().slice(0, 1_000),
        applies_when: typeof f.applies_when === "string" && f.applies_when.trim() ? f.applies_when.trim().slice(0, 300) : undefined,
        confidence: conf,
        supersedes: typeof f.supersedes === "string" && f.supersedes.trim() ? f.supersedes.trim() : undefined,
        source_event_id: typeof f.source_event_id === "string" && f.source_event_id.trim() ? f.source_event_id.trim() : undefined,
      });
      if (out.length >= EXTRACT_MAX_FACTS) break;
    }
    return out;
  }
  return [];
}

/** Render a transcript slice for the extractor: user + agent text turns
 *  with event-id markers so facts can cite provenance. */
export function renderTranscriptSlice(
  events: Array<{ id?: string; seq?: number; type: string; data?: unknown; content?: unknown }>,
): string {
  const lines: string[] = [];
  for (const e of events) {
    if (e.type !== "user.message" && e.type !== "agent.message") continue;
    const d = typeof e.data === "string" ? safeJson(e.data) : (e.data as Record<string, unknown> | undefined) ?? (e as Record<string, unknown>);
    const content = (d as { content?: unknown })?.content ?? e.content;
    const text = extractText(content);
    if (!text.trim()) continue;
    const id = e.id ?? (e.seq !== undefined ? `seq:${e.seq}` : "?");
    lines.push(`[${id}] ${e.type === "user.message" ? "User" : "Agent"}: ${text.replace(/\s+/g, " ").trim()}`);
  }
  return lines.join("\n");
}

function safeJson(s: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? String((b as { text?: unknown }).text ?? "") : ""))
      .join(" ");
  }
  return "";
}

/** Subjects a slice plausibly touches — cheap keyword overlap against the
 *  store's known subjects, so the extractor is shown only relevant active
 *  facts (bounded prompt) rather than the whole index. */
export function pickRelatedSubjects(text: string, subjects: string[], max = 20): string[] {
  const lower = text.toLowerCase();
  const hits = subjects.filter((s) => s.split(/\s+/).some((w) => w.length >= 3 && lower.includes(w)));
  return hits.slice(0, max);
}
