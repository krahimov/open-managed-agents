import { describe, expect, it } from "vitest";
import { outputsByTurn, resolveOutputLink, type SessionOutputFile } from "./session-outputs";
import type { Event } from "./events";

const out = (filename: string, uploaded_at = "2026-11-10T10:00:00.000Z"): SessionOutputFile => ({
  filename, size_bytes: 10, uploaded_at, media_type: "text/markdown",
});

describe("resolveOutputLink", () => {
  const listed = [out("competitors.md"), out("Q3 report.pdf")];

  it.each([
    ["sandbox:/mnt/session/outputs/report.md", "report.md"],
    ["sandbox:///mnt/session/outputs/report.md", "report.md"],
    ["/mnt/session/outputs/report.md", "report.md"],
    ["file:///mnt/session/outputs/report.md", "report.md"],
    // agent-computer layout: one box per agent, a dir per session
    ["/mnt/sessions/sess_abc/outputs/report.md", "report.md"],
    ["sandbox:/mnt/session/outputs/Q3%20report.pdf", "Q3 report.pdf"],
    ["/mnt/session/outputs/report.md#section", "report.md"],
  ])("%s → session output %s", (href, filename) => {
    // Explicit outputs paths resolve even before the listing has loaded.
    expect(resolveOutputLink(href, null)).toEqual({ kind: "output", filename });
  });

  it.each([
    ["competitors.md", "competitors.md"],
    ["./competitors.md", "competitors.md"],
    ["outputs/competitors.md", "competitors.md"],
    ["Q3%20report.pdf", "Q3 report.pdf"],
  ])("bare relative %s matches a listed output", (href, filename) => {
    expect(resolveOutputLink(href, listed)).toEqual({ kind: "output", filename });
  });

  it("holds an unlisted relative link for a re-check instead of letting it navigate", () => {
    expect(resolveOutputLink("draft.md", listed)).toEqual({ kind: "relative", path: "draft.md" });
    expect(resolveOutputLink("draft.md", null)).toEqual({ kind: "relative", path: "draft.md" });
  });

  it.each([
    "sandbox:/workspace/app.py",
    "/workspace/app.py",
    "/mnt/session/uploads/sales.csv",
    "/mnt/session/outputs/charts/q3.png", // subfolders aren't served
    "/tmp/scratch.txt",
    "../secrets.txt",
  ])("%s is a sandbox path we can't serve", (href) => {
    expect(resolveOutputLink(href, listed)?.kind).toBe("unavailable");
  });

  it.each([
    "https://example.com/report.md",
    "http://example.com",
    "mailto:a@b.c",
    "#heading",
    "//cdn.example.com/x.js",
    "/agents/agent_123", // a real app path stays a normal link
    "",
  ])("leaves ordinary link %j alone", (href) => {
    expect(resolveOutputLink(href, listed)).toBeNull();
  });
});

describe("outputsByTurn", () => {
  const u = (id: string, ts: string): Event => ({ type: "user.message", id, ts, content: [{ type: "text", text: "go" }] });
  const a = (id: string, ts: string): Event => ({ type: "agent.message", id, ts, content: [{ type: "text", text: "done" }] });

  it("puts each output under the last agent message of the turn that wrote it", () => {
    const a1a = a("a1a", "2026-11-10T10:00:05.000Z");
    const a1b = a("a1b", "2026-11-10T10:00:20.000Z");
    const a2 = a("a2", "2026-11-10T10:05:10.000Z");
    const events = [
      u("u1", "2026-11-10T10:00:00.000Z"), a1a, a1b,
      u("u2", "2026-11-10T10:05:00.000Z"), a2,
    ];
    const first = out("first.md", "2026-11-10T10:00:10.000Z");
    const second = out("second.md", "2026-11-10T10:05:05.000Z");

    const map = outputsByTurn(events, [first, second]);

    expect(map.get(a1b)).toEqual([first]);
    expect(map.get(a2)).toEqual([second]);
    expect(map.has(a1a)).toBe(false);
  });

  it("returns nothing without outputs or turns", () => {
    expect(outputsByTurn([], [out("x.md")]).size).toBe(0);
    expect(outputsByTurn([u("u1", "2026-11-10T10:00:00.000Z")], null).size).toBe(0);
  });
});
