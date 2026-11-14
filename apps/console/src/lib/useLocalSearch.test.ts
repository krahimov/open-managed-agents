import { describe, expect, it } from "vitest";

import { matchesWords, matchWords } from "./useLocalSearch";

describe("a list's own search", () => {
  it("matches every word, in any order, in any of the texts, whatever the case", () => {
    const texts = ["Engineering — GitHub, Sentry & AWS", null, "PR Reviewer"];
    expect(matchesWords(matchWords("sentry"), texts)).toBe(true);
    expect(matchesWords(matchWords("AWS engineering"), texts)).toBe(true);
    expect(matchesWords(matchWords("reviewer github"), texts)).toBe(true);
    expect(matchesWords(matchWords("sentry stripe"), texts)).toBe(false);
  });

  it("treats an empty query as no query", () => {
    expect(matchWords("   ")).toEqual([]);
    expect(matchesWords([], ["anything"])).toBe(true);
  });
});
