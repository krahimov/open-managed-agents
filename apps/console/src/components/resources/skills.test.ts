import { describe, expect, it } from "vitest";

import { descriptionIsCutOff, humanSkillName, inOneVoice, skillSummary, skillTitle } from "./skills";

/** The curated catalog as the server lists it (descriptions stop at 300 characters). */
const CATALOG: Array<[name: string, description: string, title: string, summary: string]> = [
  [
    "algorithmic-art",
    "Creating algorithmic art using p5.js with seeded randomness and interactive parameter exploration. Use this when users request creating art using code, generative art, algorithmic art, flow fields, or particle systems. Create original algorithmic art rather than copying existing artists' work to avo",
    "Algorithmic art",
    "Create algorithmic art using p5.js with seeded randomness and interactive parameter exploration.",
  ],
  [
    "brand-guidelines",
    "Applies Anthropic's official brand colors and typography to any sort of artifact that may benefit from having Anthropic's look-and-feel. Use it when brand colors or style guidelines, visual formatting, or company design standards apply.",
    "Brand guidelines",
    "Apply Anthropic's official brand colors and typography to any sort of artifact.",
  ],
  [
    "canvas-design",
    "Create beautiful visual art in .png and .pdf documents using design philosophy. You should use this skill when the user asks to create a poster, piece of art, design, or other static piece. Create original visual designs, never copying existing artists' work to avoid copyright violations.",
    "Canvas design",
    "Create beautiful visual art in .png and .pdf documents using design philosophy.",
  ],
  [
    "claude-api",
    "|- Reference for the Claude API / Anthropic SDK — model ids, pricing, params, streaming, tool use, MCP, agents, caching, token counting, model migration. TRIGGER — read BEFORE opening the target file; don't skip because it \"looks like a one-liner\" — whenever: the prompt names Claude/Anthropic in any",
    "Claude API",
    "Reference for the Claude API / Anthropic SDK.",
  ],
  [
    "doc-coauthoring",
    "Guide users through a structured workflow for co-authoring documentation. Use when user wants to write documentation, proposals, technical specs, decision docs, or similar structured content. This workflow helps users efficiently transfer context, refine content through iteration, and verify the doc",
    "Doc co-authoring",
    "Guide users through a structured workflow for co-authoring documentation.",
  ],
  [
    "docx",
    "Use this skill whenever the user wants to create, read, edit, or manipulate Word documents (.docx files). Triggers include: any mention of 'Word doc', 'word document', '.docx', or requests to produce professional documents with formatting like tables of contents, headings, page numbers, or letterhea",
    "Word documents",
    "Create, read, edit, or manipulate Word documents (.docx files).",
  ],
  [
    "frontend-design",
    "Guidance for distinctive, intentional visual design when building new UI or reshaping an existing one. Helps with aesthetic direction, typography, and making choices that don't read as templated defaults.",
    "Frontend design",
    "Guidance for distinctive, intentional visual design.",
  ],
  [
    "internal-comms",
    "A set of resources to help me write all kinds of internal communications, using the formats that my company likes to use. Claude should use this skill whenever asked to write some sort of internal communications (status reports, leadership updates, 3P updates, company newsletters, FAQs, incident rep",
    "Internal comms",
    "Write all kinds of internal communications, using the formats that your company likes to use.",
  ],
  [
    "mcp-builder",
    "Guide for creating high-quality MCP (Model Context Protocol) servers that enable LLMs to interact with external services through well-designed tools. Use when building MCP servers to integrate external APIs or services, whether in Python (FastMCP) or Node/TypeScript (MCP SDK).",
    "MCP builder",
    "Create high-quality MCP (Model Context Protocol) servers.",
  ],
  [
    "pdf",
    "Use this skill whenever the user wants to do anything with PDF files. This includes reading or extracting text/tables from PDFs, combining or merging multiple PDFs into one, splitting PDFs apart, rotating pages, adding watermarks, creating new PDFs, filling PDF forms, encrypting/decrypting PDFs, ext",
    "PDF files",
    "Read or extract text/tables from PDFs, combine or merge multiple PDFs into one, split PDFs apart.",
  ],
  [
    "pptx",
    "Use this skill any time a .pptx file is involved in any way — as input, output, or both. This includes: creating slide decks, pitch decks, or presentations; reading, parsing, or extracting text from any .pptx file (even if the extracted content will be used elsewhere, like in an email or summary); e",
    "PowerPoint slides",
    "Create slide decks, pitch decks, or presentations.",
  ],
  [
    "skill-creator",
    "Create new skills, modify and improve existing skills, and measure skill performance. Use when users want to create a skill from scratch, edit, or optimize an existing skill, run evals to test a skill, benchmark skill performance with variance analysis, or optimize a skill's description for better t",
    "Skill creator",
    "Create new skills, modify and improve existing skills, and measure skill performance.",
  ],
  [
    "slack-gif-creator",
    "Knowledge and utilities for creating animated GIFs optimized for Slack. Provides constraints, validation tools, and animation concepts. Use when users request animated GIFs for Slack like \"make me a GIF of X doing Y for Slack.",
    "Slack GIF creator",
    "Create animated GIFs optimized for Slack.",
  ],
  [
    "theme-factory",
    "Toolkit for styling artifacts with a theme. These artifacts can be slides, docs, reportings, HTML landing pages, etc. There are 10 pre-set themes with colors/fonts that you can apply to any artifact that has been creating, or can generate a new theme on-the-fly.",
    "Theme factory",
    "Style artifacts with a theme.",
  ],
  [
    "web-artifacts-builder",
    "Suite of tools for creating elaborate, multi-component claude.ai HTML artifacts using modern frontend web technologies (React, Tailwind CSS, shadcn/ui). Use for complex artifacts requiring state management, routing, or shadcn/ui components - not for simple single-file HTML/JSX artifacts.",
    "Web artifacts builder",
    "Create elaborate, multi-component claude.ai HTML artifacts using modern frontend web technologies.",
  ],
  [
    "webapp-testing",
    "Toolkit for interacting with and testing local web applications using Playwright. Supports verifying frontend functionality, debugging UI behavior, capturing browser screenshots, and viewing browser logs.",
    "Web app testing",
    "Interact with and test local web applications using Playwright.",
  ],
  [
    "xlsx",
    "Use this skill any time a spreadsheet file is the primary input or output. This means any task where the user wants to: open, read, edit, or fix an existing .xlsx, .xlsm, .csv, or .tsv file (e.g., adding columns, computing formulas, formatting, charting, cleaning messy data); create a new spreadshee",
    "Excel spreadsheets",
    "Open, read, edit, or fix an existing .xlsx, .xlsm, .csv, or .tsv file.",
  ],
];

describe("skills, in a person's words", () => {
  it("reads every catalog skill into a title and one whole line", () => {
    for (const [name, description, title, summary] of CATALOG) {
      expect([name, humanSkillName(name)]).toEqual([name, title]);
      expect([name, skillSummary(description)]).toEqual([name, summary]);
    }
  });

  it("never shows an instruction to the model, a cut-off word or an ellipsis", () => {
    for (const [name, description] of CATALOG) {
      const line = skillSummary(description);
      expect([name, /^(use|trigger|you should|claude should|do not)/i.test(line)]).toEqual([name, false]);
      expect([name, /…|\.\.\./.test(line)]).toEqual([name, false]);
      expect([name, line.endsWith(".")]).toEqual([name, true]);
      expect([name, line.length <= 101]).toEqual([name, true]);
    }
  });

  it("speaks in one voice: an instruction, verb first", () => {
    // However the author opened it, a catalog summary of something a skill does starts with the verb.
    const openers = CATALOG.map(([, description]) => skillSummary(description).split(" ")[0]);
    expect(openers.filter((w) => /ing$/.test(w))).toEqual([]);
    expect(inOneVoice("Creating slide decks, pitch decks, or presentations")).toBe("Create slide decks, pitch decks, or presentations");
    expect(inOneVoice("Supports verifying frontend functionality")).toBe("Support verifying frontend functionality");
    expect(inOneVoice("Running tests and summarizing failures")).toBe("Run tests and summarize failures");
    // "including" and "using" join clauses; they are not actions.
    expect(inOneVoice("Building reports, including charts, using pandas")).toBe("Build reports, including charts, using pandas");
  });

  it("does not touch a sentence that opens with a noun, or a word it does not know as a verb", () => {
    expect(inOneVoice("Reference for the Claude API / Anthropic SDK")).toBe("Reference for the Claude API / Anthropic SDK");
    expect(inOneVoice("Guidance for distinctive, intentional visual design")).toBe("Guidance for distinctive, intentional visual design");
    expect(inOneVoice("Pricing rules for enterprise quotes")).toBe("Pricing rules for enterprise quotes");
    expect(inOneVoice("Settings and macros for Lumen Support")).toBe("Settings and macros for Lumen Support");
    expect(inOneVoice("Canned replies, tone rules and escalation macros")).toBe("Canned replies, tone rules and escalation macros");
  });

  it("leaves a plain description alone", () => {
    expect(skillSummary("One-page competitor brief format with sourced facts vs. inference.")).toBe(
      "One-page competitor brief format with sourced facts vs. inference.",
    );
    expect(skillSummary("House style for customer-facing release notes and in-app 'What's new'.")).toBe(
      "House style for customer-facing release notes and in-app 'What's new'.",
    );
    expect(skillSummary("Canned replies, tone rules and escalation macros for Lumen Support")).toBe(
      "Canned replies, tone rules and escalation macros for Lumen Support.",
    );
    expect(skillSummary("")).toBe("");
    expect(skillSummary(null)).toBe("");
  });

  it("has something to say about a skill it has never seen", () => {
    expect(humanSkillName("sql-style-guide")).toBe("SQL style guide");
    expect(humanSkillName("github_pr_review")).toBe("GitHub PR review");
    expect(humanSkillName("Quarterly Planning")).toBe("Quarterly Planning");
    expect(humanSkillName("")).toBe("Unnamed skill");
    expect(skillTitle({ name: "docx", display_title: "Word, our way" })).toBe("Word, our way");
    expect(skillTitle({ name: "docx" })).toBe("Word documents");
    // Only instructions: the first one is said plainly rather than nothing.
    expect(skillSummary("Use when the quarterly numbers are being prepared.")).toBe("Use when the quarterly numbers are being prepared.");
    expect(skillSummary("Use this skill when the user asks to draft a customer apology email. Do not use for refunds.")).toBe(
      "Draft a customer apology email.",
    );
  });

  it("knows when the server shortened a description", () => {
    expect(descriptionIsCutOff(CATALOG[0][1])).toBe(true);
    expect(descriptionIsCutOff(CATALOG[1][1])).toBe(false);
    expect(descriptionIsCutOff("Short and whole")).toBe(false);
  });
});
