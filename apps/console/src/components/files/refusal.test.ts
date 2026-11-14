import { describe, expect, it } from "vitest";

import { refusalText, refusalTitle, screenAttachments } from "./refusal";

const sized = (name: string, size: number, type = "") => {
  const f = new File([], name, { type });
  Object.defineProperty(f, "size", { value: size });
  return f;
};
const MB = 1024 * 1024;

describe("screenAttachments", () => {
  it("takes any kind of file: a table, a PDF and an image all attach", () => {
    const { accepted, refused } = screenAttachments(
      [sized("orders.csv", 10, "text/csv"), sized("contract.pdf", 2 * MB, "application/pdf"), sized("chart.png", 30_000, "image/png")],
      0,
    );
    expect(accepted.map((f) => f.name)).toEqual(["orders.csv", "contract.pdf", "chart.png"]);
    expect(refused).toEqual([]);
  });

  it("turns away a file over 25 MB, by name", () => {
    const { accepted, refused } = screenAttachments([sized("video.mov", 26 * MB, "video/quicktime"), sized("notes.md", 5)], 0);
    expect(accepted.map((f) => f.name)).toEqual(["notes.md"]);
    expect(refused).toEqual([{ name: "video.mov", why: "size" }]);
  });

  it("stops at ten files per message, counting the ones already attached", () => {
    const { accepted, refused } = screenAttachments([sized("a.txt", 1), sized("b.txt", 1), sized("c.txt", 1)], 8);
    expect(accepted.map((f) => f.name)).toEqual(["a.txt", "b.txt"]);
    expect(refused).toEqual([{ name: "c.txt", why: "count" }]);
  });
});

describe("refusal words", () => {
  it("says which limit was hit, and nothing about file types", () => {
    expect(refusalText([{ name: "big.zip", why: "size" }])).toBe("A file can be up to 25 MB.");
    expect(refusalText([{ name: "k.txt", why: "count" }])).toBe("A message carries up to 10 files. Send these in a second message.");
    const both = refusalText([
      { name: "big.zip", why: "size" },
      { name: "k.txt", why: "count" },
    ]);
    expect(both).toContain("25 MB");
    expect(both).toContain("10 files");
    expect(both).not.toMatch(/image|Files API|upload/i);
  });

  it("names the files in the title", () => {
    const list = (names: string[]) => names.map((n) => `“${n}”`).join(" and ");
    expect(refusalTitle([{ name: "big.zip", why: "size" }], list)).toBe("“big.zip” was not attached");
    expect(
      refusalTitle(
        [
          { name: "a.zip", why: "size" },
          { name: "b.zip", why: "size" },
        ],
        list,
      ),
    ).toBe("“a.zip” and “b.zip” were not attached");
  });
});
