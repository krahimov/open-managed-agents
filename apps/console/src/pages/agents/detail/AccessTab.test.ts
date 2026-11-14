import { describe, expect, it } from "vitest";
import { capabilityNotes } from "./AccessTab";

describe("capabilityNotes", () => {
  it("drops the no-policy note the card already says, and words the MCP note plainly", () => {
    const notes = capabilityNotes([
      "MCP tool lists are discovered at session runtime; mcp__<server>__* rows show the policy effect for the server namespace as a whole. Rules targeting individual MCP tools still apply at runtime but are not expanded here.",
      "No enabled baseline grant — every tool defaults to allow (legacy behavior).",
      "Something new from the server.",
    ]);
    expect(notes).toHaveLength(2);
    expect(notes[0]).not.toMatch(/mcp__|namespace|runtime/);
    expect(notes[1]).toBe("Something new from the server.");
  });
});
