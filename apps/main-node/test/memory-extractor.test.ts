// Pure helpers for memory fact extraction (memory-facts-design §4):
// prompt composition, tolerant parse + confidence gate, transcript slice
// rendering with event-id provenance, related-subject picking.

import { describe, it, expect } from "vitest";
import {
  buildExtractionPrompt,
  parseExtractedFacts,
  renderTranscriptSlice,
  pickRelatedSubjects,
  EXTRACT_MAX_FACTS,
} from "../src/lib/memory-extractor";

describe("buildExtractionPrompt", () => {
  it("carries the contract, existing facts, and the slice (transcript mode)", () => {
    const { system, user } = buildExtractionPrompt({
      mode: "transcript",
      text: "[sevt_1] User: always CC legal@ on vendor contracts",
      activeFacts: [{ id: "mfact-1", kind: "decision", subject: "payroll vendor", statement: "Northwind chosen." }],
      nowIso: "2026-08-17T10:00:00Z",
    });
    expect(system).toContain("DURABLE facts");
    expect(system).toContain('"supersedes"');
    expect(user).toContain("Today: 2026-08-17");
    expect(user).toContain("mfact-1 [decision] payroll vendor: Northwind chosen.");
    expect(user).toContain("## Conversation slice");
    expect(user).toContain("[sevt_1] User: always CC legal@");
  });
  it("file mode labels the source path and says (none) with no facts", () => {
    const { user } = buildExtractionPrompt({ mode: "file", text: "# prefs\n- no meetings before 10", sourcePath: "prefs.md", activeFacts: [], nowIso: "2026-08-17T00:00:00Z" });
    expect(user).toContain("## Memory file: prefs.md");
    expect(user).toContain("(none)");
  });
});

describe("parseExtractedFacts", () => {
  const good = [
    { kind: "rule", subject: "Vendor Contracts", statement: "Always CC legal@ on any vendor contract.", applies_when: "drafting vendor emails", confidence: 0.95, source_event_id: "sevt_1" },
    { kind: "decision", subject: "payroll vendor", statement: "Northwind approved July 22.", confidence: 0.9, supersedes: "mfact-old" },
  ];
  it("parses bare, fenced, and prose-wrapped arrays; normalizes subject", () => {
    for (const text of [JSON.stringify(good), "```json\n" + JSON.stringify(good) + "\n```", "Here:\n" + JSON.stringify(good) + "\nDone."]) {
      const out = parseExtractedFacts(text);
      expect(out).toHaveLength(2);
      expect(out[0].subject).toBe("vendor contracts");
      expect(out[0].source_event_id).toBe("sevt_1");
      expect(out[1].supersedes).toBe("mfact-old");
    }
  });
  it("drops low-confidence, unknown-kind, and malformed entries; defaults missing confidence to 0.7", () => {
    const out = parseExtractedFacts(JSON.stringify([
      { kind: "rule", subject: "x", statement: "low", confidence: 0.3 },
      { kind: "vibe", subject: "x", statement: "bad kind", confidence: 0.9 },
      { kind: "note", subject: "", statement: "no subject", confidence: 0.9 },
      "garbage",
      { kind: "preference", subject: "meetings", statement: "No meetings before 10am." },
    ]));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "preference", subject: "meetings", confidence: 0.7 });
  });
  it("caps at EXTRACT_MAX_FACTS and returns [] for non-arrays/garbage", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ kind: "note", subject: `s${i}`, statement: `st ${i}`, confidence: 1 }));
    expect(parseExtractedFacts(JSON.stringify(many))).toHaveLength(EXTRACT_MAX_FACTS);
    expect(parseExtractedFacts("{}")).toEqual([]);
    expect(parseExtractedFacts("nope")).toEqual([]);
    expect(parseExtractedFacts("")).toEqual([]);
  });
});

describe("renderTranscriptSlice", () => {
  it("renders user/agent text with event-id markers, both event shapes, skipping tool events", () => {
    const out = renderTranscriptSlice([
      { id: "sevt_a", seq: 1, type: "user.message", data: JSON.stringify({ content: [{ type: "text", text: "hi\nthere" }] }) },
      { seq: 2, type: "agent.tool_use", data: { name: "bash" } },
      { seq: 3, type: "agent.message", data: { content: [{ type: "text", text: "hello" }] } },
    ]);
    expect(out).toBe("[sevt_a] User: hi there\n[seq:3] Agent: hello");
  });
});

describe("pickRelatedSubjects", () => {
  it("keeps subjects sharing a ≥3-char word with the text", () => {
    const subs = ["payroll vendor", "meeting hours", "vendor contracts", "office wifi"];
    expect(pickRelatedSubjects("draft a note about the acme contract for the vendor", subs)).toEqual(["payroll vendor", "vendor contracts"]);
    expect(pickRelatedSubjects("nothing relevant here", subs)).toEqual([]);
  });
});
