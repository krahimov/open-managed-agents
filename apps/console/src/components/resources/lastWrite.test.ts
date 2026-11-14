import { describe, expect, it } from "vitest";

import { lastWriteOf } from "./lastWrite";

describe("a memory store's last write", () => {
  it("is its newest entry's time", () => {
    expect(lastWriteOf({ count: 3, latest: "2026-11-03T14:10:33.582Z" })).toEqual({ kind: "at", at: "2026-11-03T14:10:33.582Z" });
  });

  it("is never, for a store with no entries, whatever the store record's own date says", () => {
    expect(lastWriteOf({ count: 0, latest: null })).toEqual({ kind: "never" });
  });

  it("is not known when the entries could not be read", () => {
    expect(lastWriteOf(undefined)).toEqual({ kind: "unknown" });
  });
});
