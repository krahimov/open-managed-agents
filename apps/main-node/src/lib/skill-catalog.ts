/**
 * Curated skill catalog — the "verified" source in the Skills page Catalog
 * tab. Every entry points at anthropics/skills (Anthropic's first-party
 * skill repo, permissive license); descriptions are the skills' own
 * frontmatter, snapshotted 2026-07-09 by scripts/refresh-skill-catalog.
 *
 * Deliberately a static in-repo manifest rather than a live GitHub query:
 * browse stays instant, entries can't 404 out from under the UI, and the
 * trust badge ("curated") is backed by a human having actually looked at
 * this list. Marketplace/community sources (e.g. MCP Market curl imports)
 * flow through the generic URL import + quarantine pipeline instead and
 * never get this badge.
 */

export interface CatalogSkillEntry {
  name: string;
  category: "documents" | "design" | "engineering" | "communication" | "meta" | "general";
  /** importFromSource() shorthand — owner/repo/path with a direct SKILL.md. */
  source: string;
  description: string;
}

export const CURATED_SKILL_CATALOG: CatalogSkillEntry[] = [
  { name: "algorithmic-art", category: "design", source: "anthropics/skills/skills/algorithmic-art",
    description: "Creating algorithmic art using p5.js with seeded randomness and interactive parameter exploration. Use this when users request creating art using code, generative art, algorithmic art, flow fields, or particle systems. Create original algorithmic art rather than copying existing artists' work to avo" },
  { name: "brand-guidelines", category: "design", source: "anthropics/skills/skills/brand-guidelines",
    description: "Applies Anthropic's official brand colors and typography to any sort of artifact that may benefit from having Anthropic's look-and-feel. Use it when brand colors or style guidelines, visual formatting, or company design standards apply." },
  { name: "canvas-design", category: "design", source: "anthropics/skills/skills/canvas-design",
    description: "Create beautiful visual art in .png and .pdf documents using design philosophy. You should use this skill when the user asks to create a poster, piece of art, design, or other static piece. Create original visual designs, never copying existing artists' work to avoid copyright violations." },
  { name: "claude-api", category: "engineering", source: "anthropics/skills/skills/claude-api",
    description: "|- Reference for the Claude API / Anthropic SDK — model ids, pricing, params, streaming, tool use, MCP, agents, caching, token counting, model migration. TRIGGER — read BEFORE opening the target file; don't skip because it \"looks like a one-liner\" — whenever: the prompt names Claude/Anthropic in any" },
  { name: "doc-coauthoring", category: "documents", source: "anthropics/skills/skills/doc-coauthoring",
    description: "Guide users through a structured workflow for co-authoring documentation. Use when user wants to write documentation, proposals, technical specs, decision docs, or similar structured content. This workflow helps users efficiently transfer context, refine content through iteration, and verify the doc" },
  { name: "docx", category: "documents", source: "anthropics/skills/skills/docx",
    description: "Use this skill whenever the user wants to create, read, edit, or manipulate Word documents (.docx files). Triggers include: any mention of 'Word doc', 'word document', '.docx', or requests to produce professional documents with formatting like tables of contents, headings, page numbers, or letterhea" },
  { name: "frontend-design", category: "design", source: "anthropics/skills/skills/frontend-design",
    description: "Guidance for distinctive, intentional visual design when building new UI or reshaping an existing one. Helps with aesthetic direction, typography, and making choices that don't read as templated defaults." },
  { name: "internal-comms", category: "communication", source: "anthropics/skills/skills/internal-comms",
    description: "A set of resources to help me write all kinds of internal communications, using the formats that my company likes to use. Claude should use this skill whenever asked to write some sort of internal communications (status reports, leadership updates, 3P updates, company newsletters, FAQs, incident rep" },
  { name: "mcp-builder", category: "engineering", source: "anthropics/skills/skills/mcp-builder",
    description: "Guide for creating high-quality MCP (Model Context Protocol) servers that enable LLMs to interact with external services through well-designed tools. Use when building MCP servers to integrate external APIs or services, whether in Python (FastMCP) or Node/TypeScript (MCP SDK)." },
  { name: "pdf", category: "documents", source: "anthropics/skills/skills/pdf",
    description: "Use this skill whenever the user wants to do anything with PDF files. This includes reading or extracting text/tables from PDFs, combining or merging multiple PDFs into one, splitting PDFs apart, rotating pages, adding watermarks, creating new PDFs, filling PDF forms, encrypting/decrypting PDFs, ext" },
  { name: "pptx", category: "documents", source: "anthropics/skills/skills/pptx",
    description: "Use this skill any time a .pptx file is involved in any way — as input, output, or both. This includes: creating slide decks, pitch decks, or presentations; reading, parsing, or extracting text from any .pptx file (even if the extracted content will be used elsewhere, like in an email or summary); e" },
  { name: "skill-creator", category: "meta", source: "anthropics/skills/skills/skill-creator",
    description: "Create new skills, modify and improve existing skills, and measure skill performance. Use when users want to create a skill from scratch, edit, or optimize an existing skill, run evals to test a skill, benchmark skill performance with variance analysis, or optimize a skill's description for better t" },
  { name: "slack-gif-creator", category: "communication", source: "anthropics/skills/skills/slack-gif-creator",
    description: "Knowledge and utilities for creating animated GIFs optimized for Slack. Provides constraints, validation tools, and animation concepts. Use when users request animated GIFs for Slack like \"make me a GIF of X doing Y for Slack." },
  { name: "theme-factory", category: "design", source: "anthropics/skills/skills/theme-factory",
    description: "Toolkit for styling artifacts with a theme. These artifacts can be slides, docs, reportings, HTML landing pages, etc. There are 10 pre-set themes with colors/fonts that you can apply to any artifact that has been creating, or can generate a new theme on-the-fly." },
  { name: "web-artifacts-builder", category: "design", source: "anthropics/skills/skills/web-artifacts-builder",
    description: "Suite of tools for creating elaborate, multi-component claude.ai HTML artifacts using modern frontend web technologies (React, Tailwind CSS, shadcn/ui). Use for complex artifacts requiring state management, routing, or shadcn/ui components - not for simple single-file HTML/JSX artifacts." },
  { name: "webapp-testing", category: "engineering", source: "anthropics/skills/skills/webapp-testing",
    description: "Toolkit for interacting with and testing local web applications using Playwright. Supports verifying frontend functionality, debugging UI behavior, capturing browser screenshots, and viewing browser logs." },
  { name: "xlsx", category: "documents", source: "anthropics/skills/skills/xlsx",
    description: "Use this skill any time a spreadsheet file is the primary input or output. This means any task where the user wants to: open, read, edit, or fix an existing .xlsx, .xlsm, .csv, or .tsv file (e.g., adding columns, computing formulas, formatting, charting, cleaning messy data); create a new spreadshee" },
];
