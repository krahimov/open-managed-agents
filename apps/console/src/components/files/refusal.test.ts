import { describe, expect, it } from "vitest";

import { isTextLike, refusalAdvice, segmentsText, UPLOAD_DOCS_URL } from "./refusal";

const csv = { name: "orders.csv", why: "type" as const, mediaType: "text/csv" };
const pdf = { name: "contract.pdf", why: "type" as const, mediaType: "application/pdf" };
const known = (names: string[], partial = false) => ({ names, partial });
const say = (a: ReturnType<typeof refusalAdvice>) => segmentsText(a.body);

describe("refusalAdvice", () => {
  it("never points at a control the console does not have, and never talks about a build", () => {
    const cases = [
      refusalAdvice({ refused: [csv], where: "start", files: undefined, maxFiles: 10 }),
      refusalAdvice({ refused: [csv], where: "start", files: known([]), maxFiles: 10 }),
      refusalAdvice({ refused: [csv], where: "start", files: known(["other.txt"]), maxFiles: 10 }),
      refusalAdvice({ refused: [csv], where: "start", files: known(["orders.csv"]), maxFiles: 10 }),
      refusalAdvice({ refused: [pdf], where: "session", files: undefined, maxFiles: 10 }),
      refusalAdvice({ refused: [pdf], where: "session", files: known([]), maxFiles: 10 }),
      refusalAdvice({ refused: [pdf], where: "session", files: known(["contract.pdf"]), maxFiles: 10 }),
    ];
    for (const a of cases) {
      const text = say(a);
      expect(text).toMatch(/^A message carries images only\./);
      expect(text).not.toMatch(/in this build|upload (it|one) in Files|Upload one in Files|cannot upload/i);
    }
  });

  it("offers the very file when it is already in Files", () => {
    const a = refusalAdvice({ refused: [csv], where: "start", files: known(["orders.csv", "x.png"]), maxFiles: 10 });
    expect(say(a)).toContain("This file is already in Files");
    expect(a.action).toEqual({ kind: "mount", names: ["orders.csv"] });
  });

  it("says Files is empty only when it was read and is empty, and then offers nothing to mount", () => {
    const a = refusalAdvice({ refused: [csv], where: "start", files: known([]), maxFiles: 10 });
    expect(say(a)).toContain("Files is empty");
    expect(say(a)).toContain("Upload it to Files (how to upload a file)");
    expect(a.action).toBeNull();
  });

  it("says how to upload in words, with a link to the docs, never an endpoint", () => {
    const cases = [
      refusalAdvice({ refused: [csv], where: "start", files: undefined, maxFiles: 10 }),
      refusalAdvice({ refused: [csv], where: "start", files: known([]), maxFiles: 10 }),
      refusalAdvice({ refused: [csv], where: "start", files: known(["other.txt"]), maxFiles: 10 }),
      refusalAdvice({ refused: [pdf], where: "session", files: undefined, maxFiles: 10 }),
      refusalAdvice({ refused: [pdf], where: "session", files: known([]), maxFiles: 10 }),
    ];
    for (const a of cases) {
      expect(say(a)).not.toMatch(/POST|\/v1\/|with the API/);
      expect(a.body.some((s) => typeof s === "object" && "code" in s)).toBe(false);
      const links = a.body.filter((s): s is { link: string; href: string } => typeof s === "object" && "link" in s);
      expect(links).toHaveLength(1);
      expect(links[0].href).toBe(UPLOAD_DOCS_URL);
    }
    expect(UPLOAD_DOCS_URL).toBe("https://docs.openma.dev/build/api/#upload-a-file-to-a-session");
  });

  it("offers another file when Files holds some but not this one", () => {
    const a = refusalAdvice({ refused: [csv], where: "start", files: known(["notes.md"]), maxFiles: 10 });
    expect(say(a)).toContain("not in Files yet");
    expect(a.action).toEqual({ kind: "mount", names: [] });
  });

  it("claims nothing about Files when it could not be read, or only part of it was", () => {
    for (const files of [undefined, known(["notes.md"], true)]) {
      const text = say(refusalAdvice({ refused: [csv], where: "start", files, maxFiles: 10 }));
      expect(text).not.toMatch(/not in Files yet|Files is empty|already in Files/);
      expect(text).toContain("A file gets into Files when an agent saves it");
    }
  });

  it("in a running session, sends the file to a new session, because this one cannot mount it", () => {
    const a = refusalAdvice({ refused: [pdf], where: "session", files: known([]), maxFiles: 10 });
    expect(say(a)).toContain("this session cannot take it");
    expect(say(a)).toContain("new session's Options");
    expect(a.action).toEqual({ kind: "new-session" });
  });

  it("suggests pasting only for files that read as text", () => {
    expect(say(refusalAdvice({ refused: [csv], where: "start", files: known([]), maxFiles: 10 }))).toContain("pasted into the message");
    expect(say(refusalAdvice({ refused: [pdf], where: "start", files: known([]), maxFiles: 10 }))).not.toContain("pasted");
    expect(say(refusalAdvice({ refused: [csv, pdf], where: "session", files: known([]), maxFiles: 10 }))).not.toContain("pasted");
  });

  it("speaks of one file or several", () => {
    const two = refusalAdvice({ refused: [csv, { ...csv, name: "b.csv" }], where: "start", files: known(["orders.csv", "b.csv"]), maxFiles: 10 });
    expect(say(two)).toContain("These files are already in Files, so they can be mounted");
    expect(two.action).toEqual({ kind: "mount", names: ["orders.csv", "b.csv"] });
  });

  it("states the size and count rules on their own", () => {
    expect(say(refusalAdvice({ refused: [{ name: "big.png", why: "size" }], where: "start", files: undefined, maxFiles: 10 }))).toBe(
      "An image can be up to 25 MB.",
    );
    expect(say(refusalAdvice({ refused: [{ name: "c.png", why: "count" }], where: "session", files: undefined, maxFiles: 10 }))).toBe(
      "A message carries up to 10 images.",
    );
  });
});

describe("isTextLike", () => {
  it("reads the media type, then the extension", () => {
    expect(isTextLike({ name: "a.bin", mediaType: "text/plain" })).toBe(true);
    expect(isTextLike({ name: "data.json", mediaType: "" })).toBe(true);
    expect(isTextLike({ name: "report.xlsx", mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })).toBe(false);
    expect(isTextLike({ name: "archive.zip" })).toBe(false);
  });
});
