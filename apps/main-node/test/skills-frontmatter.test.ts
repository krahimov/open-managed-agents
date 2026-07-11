import { describe, expect, it } from "vitest";
import { parseFrontmatter } from "../src/lib/skills";

describe("parseFrontmatter", () => {
  it("plain single-line values", () => {
    const fm = parseFrontmatter("---\nname: pdf\ndescription: Use for PDFs\n---\nbody");
    expect(fm).toEqual({ name: "pdf", description: "Use for PDFs" });
  });

  it("quoted values lose their quotes", () => {
    const fm = parseFrontmatter('---\nname: "x"\ndescription: \'y\'\n---\n');
    expect(fm).toEqual({ name: "x", description: "y" });
  });

  it("folded block scalar (description: >)", () => {
    const fm = parseFrontmatter(
      "---\nname: openma\ndescription: >\n  Use the openma platform to build agents.\n  Trigger when users mention oma.\n---\nbody",
    );
    expect(fm.name).toBe("openma");
    expect(fm.description).toBe(
      "Use the openma platform to build agents. Trigger when users mention oma.",
    );
  });

  it("literal block scalar with chomping (description: |-)", () => {
    const fm = parseFrontmatter(
      "---\nname: claude-api\ndescription: |-\n  Reference for the Claude API.\n  Model ids and pricing.\n---\n",
    );
    expect(fm.description).toBe("Reference for the Claude API. Model ids and pricing.");
  });

  it("block scalar does not swallow the next key", () => {
    const fm = parseFrontmatter(
      "---\ndescription: >\n  Line one.\nname: after-block\n---\n",
    );
    expect(fm.description).toBe("Line one.");
    expect(fm.name).toBe("after-block");
  });

  it("empty block yields undefined", () => {
    const fm = parseFrontmatter("---\nname: x\ndescription: >\n---\n");
    expect(fm.description).toBeUndefined();
  });
});
