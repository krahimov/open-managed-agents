import { describe, expect, it } from "vitest";
import { HARNESS_AGENT_BUILDER_SKILL } from "./harness-agent-builder-skill";

// Guards the `?raw` import of skills/orrery-agent-builder/SKILL.md: the
// Dashboard copies this string verbatim into the user's coding agent, so it
// must be the real skill file with valid frontmatter, not an empty module.
describe("orrery agent builder skill", () => {
  it("is the SKILL.md with frontmatter naming the skill", () => {
    expect(HARNESS_AGENT_BUILDER_SKILL.startsWith("---\nname: orrery-agent-builder\n")).toBe(true);
    expect(HARNESS_AGENT_BUILDER_SKILL).toContain("oma auth ensure");
    expect(HARNESS_AGENT_BUILDER_SKILL).toContain("oma agents apply -f harness.agent.json");
    expect(HARNESS_AGENT_BUILDER_SKILL).not.toMatch(/Harness Studio/);
  });
});
