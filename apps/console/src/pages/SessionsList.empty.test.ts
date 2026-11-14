import { describe, expect, it } from "vitest";

import { emptyFilteredSubtitle } from "./SessionsList";

describe("why a filtered Sessions list is empty", () => {
  it("mentions a title only when one was typed", () => {
    expect(emptyFilteredSubtitle({ search: "release", status: "rescheduling", narrowed: false })).toBe("Try a different title, or widen the filters.");
    expect(emptyFilteredSubtitle({ search: "", status: "rescheduling", narrowed: false })).toBe("No session is retrying after a failure right now.");
    expect(emptyFilteredSubtitle({ search: "  ", status: "running", narrowed: false })).not.toMatch(/title/);
  });

  it("says the filters, not the state, when other filters narrow it", () => {
    expect(emptyFilteredSubtitle({ search: "", status: "rescheduling", narrowed: true })).toBe(
      "No session is retrying after a failure with these filters. Widen them to see the rest.",
    );
    expect(emptyFilteredSubtitle({ search: "", status: "terminated", narrowed: false })).toBe("No session has ended yet.");
    expect(emptyFilteredSubtitle({ search: "", status: "any", narrowed: true })).toBe("None with these filters. Widen them to see the rest.");
  });
});
