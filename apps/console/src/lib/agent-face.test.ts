import { describe, expect, it } from "vitest";

import { AGENT_TEMPLATES } from "./agent-templates";
import {
  FACE_GLYPHS,
  FACE_GROUPS,
  FACE_RULES,
  deriveGlyph,
  describeFace,
  faceBook,
  faceGlyph,
  formatFace,
  naturalFace,
  parseFace,
  previewFace,
} from "./agent-face";

const glyphOf = (name: string, description?: string) => deriveGlyph(name, description)?.id ?? null;

describe("agent faces", () => {
  it("reads a glyph from what an agent is called", () => {
    const expected: Record<string, string> = {
      "Support Triage": "headset",
      "PR Reviewer": "pull-request",
      "Release Notes Writer": "scroll",
      "Incident Commander": "siren",
      "Data Quality Monitor": "shield",
      "Competitive Research Analyst": "binoculars",
      "Sales Call Summarizer": "phone",
      "Customer Onboarding Concierge": "concierge",
      "Finance Ops Reconciler": "scale",
      "SQL Analyst": "database",
      "Engineering Coordinator": "network",
      "Docs Q&A Bot (legacy)": "question",
      "Churn Risk Scorer (experiment)": "trend",
      "Coding assistant": "code",
      "Test agent": "flask",
      "Bug triage": "bug",
      "Order tracker": "cart",
      "Meeting scheduler": "calendar",
      "Contract reviewer": "scale",
      "Weekly digest": "notebook",
      Translator: "languages",
    };
    for (const [name, glyph] of Object.entries(expected)) expect([name, glyphOf(name)]).toEqual([name, glyph]);
  });

  it("falls back to the description, then to initials", () => {
    expect(glyphOf("Atlas", "Reviews pull requests for correctness")).toBe("pull-request");
    // Words any agent could carry say nothing: initials tell those apart better.
    for (const name of ["Atlas", "My agent", "Helpful bot", "General assistant", ""]) expect([name, glyphOf(name)]).toEqual([name, null]);
    expect(naturalFace({ id: "agent-1", name: "Atlas" }).source).toBe("initials");
  });

  it("only points rules and templates at glyphs that exist", () => {
    for (const [, id] of FACE_RULES) expect([id, !!faceGlyph(id)]).toEqual([id, true]);
    for (const tmpl of AGENT_TEMPLATES) {
      if (!tmpl.face) continue;
      const choice = parseFace(tmpl.face);
      // A template carries a glyph and leaves the tint free, so the copy made from it can still move.
      expect([tmpl.id, choice?.glyph && !!faceGlyph(choice.glyph), choice?.tint]).toEqual([tmpl.id, true, null]);
      // An agent made from the template before faces were stored still reads as the same glyph.
      expect([tmpl.id, glyphOf(tmpl.name)]).toEqual([tmpl.id, choice?.glyph]);
    }
  });

  it("keeps the picker's rows whole", () => {
    for (const group of FACE_GROUPS) {
      expect([group, FACE_GLYPHS.filter((glyph) => glyph.group === group).length % 8]).toEqual([group, 0]);
    }
    expect(new Set(FACE_GLYPHS.map((glyph) => glyph.id)).size).toBe(FACE_GLYPHS.length);
  });

  it("tells two agents with the same name apart", () => {
    const agents = [
      { id: "a", name: "Incident Commander", created_at: "2026-10-08T05:10:33.582Z" },
      { id: "b", name: "Incident commander 2", created_at: "2026-11-07T20:25:43.106Z" },
      { id: "c", name: "Incident commander 3", created_at: "2026-11-08T20:25:43.106Z" },
      { id: "d", name: "Atlas Bridge", created_at: "2026-11-08T20:25:43.106Z" },
      { id: "e", name: "Alpha Beta", created_at: "2026-11-09T20:25:43.106Z" },
    ];
    const book = faceBook(agents);
    const faces = agents.map((a) => describeFace(book.get(a.id)!));
    // The first keeps the family tint; the copies move, furthest hue first.
    expect(faces.slice(0, 3)).toEqual(["Incidents, peach", "Incidents, lilac", "Incidents, orchid"]);
    // Same initials ("AB"), different tints.
    expect(book.get("d")!.glyph).toBeNull();
    expect(book.get("d")!.tint).not.toBe(book.get("e")!.tint);
    expect(faceBook(agents)).toBe(book);
  });

  it("gives a second agent from the same template a colour of its own", () => {
    const agents = [
      { id: "a", name: "On-call lead", created_at: "2026-10-08T05:10:33.582Z", metadata: { avatar: "siren" } },
      { id: "b", name: "Night shift", created_at: "2026-11-07T20:25:43.106Z", metadata: { avatar: "siren" } },
    ];
    const book = faceBook(agents);
    expect([describeFace(book.get("a")!), describeFace(book.get("b")!)]).toEqual(["Incidents, peach", "Incidents, lilac"]);
    // Gallery neighbours never share a tint (three columns).
    const tints = AGENT_TEMPLATES.map((tmpl) => (tmpl.face ? naturalFace({ name: tmpl.name, metadata: { avatar: tmpl.face } }).tint : null));
    tints.forEach((tint, i) => {
      if (!tint) return;
      if (i % 3 !== 2) expect([i, tints[i + 1]]).not.toEqual([i, tint]);
      expect([i, tints[i + 3]]).not.toEqual([i, tint]);
    });
  });

  it("never moves a face a person chose, and steps around it", () => {
    const agents = [
      { id: "a", name: "Incident Commander", created_at: "2026-10-08T05:10:33.582Z" },
      { id: "b", name: "Pager", created_at: "2026-11-07T20:25:43.106Z", metadata: { avatar: "siren:peach" } },
    ];
    const book = faceBook(agents);
    expect(describeFace(book.get("b")!)).toBe("Incidents, peach");
    expect(book.get("b")!.source).toBe("chosen");
    expect(describeFace(book.get("a")!)).toBe("Incidents, lilac");
  });

  it("previews the face a draft will get in the workspace", () => {
    const agents = [{ id: "a", name: "Incident Commander", created_at: "2026-10-08T05:10:33.582Z" }];
    expect(describeFace(previewFace(agents, { name: "Incident commander" }))).toBe("Incidents, lilac");
    expect(describeFace(previewFace(agents, { id: "a", name: "Support desk", created_at: "2026-10-08T05:10:33.582Z" }))).toBe("Support, rose");
    expect(describeFace(previewFace(agents, { name: "Anything", metadata: { avatar: "initials:rose" } }))).toBe("Initials, rose");
  });

  it("reads and writes the stored choice, and ignores what it does not know", () => {
    expect(parseFace("siren:peach")).toEqual({ glyph: "siren", tint: "peach" });
    expect(parseFace("siren")).toEqual({ glyph: "siren", tint: null });
    expect(parseFace(":lilac")).toEqual({ glyph: null, tint: "lilac" });
    expect(parseFace("initials:rose")).toEqual({ glyph: "initials", tint: "rose" });
    for (const junk of ["", "unicorn", "unicorn:teal", "https://example.test/a.png", 4, null, undefined, { glyph: "siren" }]) {
      expect(parseFace(junk)).toBeNull();
    }
    for (const spec of ["siren:peach", "siren", ":lilac", "initials:rose"]) expect(formatFace(parseFace(spec))).toBe(spec);
    expect(formatFace(null)).toBe("");
  });
});
