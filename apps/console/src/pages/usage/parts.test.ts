import { describe, expect, it } from "vitest";

import { periodChanges } from "./parts";

const t = (cost_usd: number, processed_tokens: number, sessions: number) => ({ cost_usd, processed_tokens, sessions });

describe("periodChanges", () => {
  it("shows all three changes when every number has history to compare with", () => {
    const c = periodChanges(t(120, 9_000_000, 30), t(100, 10_000_000, 24));
    expect(c.comparable).toBe(true);
    expect(c.cost?.direction).toBe("up");
    expect(c.tokens?.direction).toBe("down");
    expect(c.sessions?.value).toBe("25%");
  });

  it("shows none when any one of them has too little before it (no lone '↗ 250%')", () => {
    const c = periodChanges(t(120, 9_000_000, 28), t(100, 10_000_000, 2));
    expect(c).toEqual({ comparable: false });
  });

  it("shows none without a period before", () => {
    expect(periodChanges(t(1, 1, 1), undefined)).toEqual({ comparable: false });
  });
});
