import type { ComponentType } from "react";
import {
  BinocularsIcon,
  BlocksIcon,
  ChartLineIcon,
  CodeXmlIcon,
  DatabaseIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FileTypeIcon,
  GitPullRequestIcon,
  ImageIcon,
  LifeBuoyIcon,
  MailIcon,
  MessagesSquareIcon,
  NotebookPenIcon,
  PaletteIcon,
  PenToolIcon,
  PresentationIcon,
  PuzzleIcon,
  ScrollTextIcon,
  SirenIcon,
  SwatchBookIcon,
  TestTubeDiagonalIcon,
  WandSparklesIcon,
} from "lucide-react";

import type { StatusTone } from "../Badge";

/**
 * Skill model + display helpers, shared by the Skills list, the skill
 * panel and the catalog.
 *
 * Two runtimes serve /v1/skills with different shapes, and the console
 * has to read both without guessing:
 *   - the hosted (Workers) runtime: `display_title`, `source` is
 *     "anthropic" | "custom", `latest_version`, and a versions API;
 *   - the Node runtime: `source` is where the skill came from (a catalog
 *     path, `owner/repo/path`, a URL), the SKILL.md is on the record as
 *     `content`, and each skill carries its security scan.
 * Everything below is feature-detected from the record, never assumed.
 */
export interface Skill {
  id: string;
  name: string;
  display_title?: string | null;
  description?: string | null;
  source?: string | null;
  latest_version?: number | null;
  created_at: string | number;
  content?: string | null;
  content_hash?: string | null;
  security_status?: string | null;
  /** JSON string of a ScanReport. */
  security_report?: string | null;
}

export interface SkillFile {
  filename: string;
  content: string;
  encoding?: "utf8" | "base64";
}
export interface VersionSummary {
  version: number;
  created_at: string;
}
export interface VersionDetail extends VersionSummary {
  files: SkillFile[];
}

export interface ScanFinding {
  severity: "block" | "flag";
  kind: string;
  detail: string;
}
export interface ScanReport {
  verdict: "pass" | "flagged" | "blocked";
  findings: ScanFinding[];
  content_sha256: string;
  bytes: number;
}
export interface ScanCandidate {
  source: string;
  name: string;
  description: string;
  content: string;
  report: ScanReport;
}

export interface CatalogEntry {
  name: string;
  category: string;
  source: string;
  description: string;
  curated: boolean;
  installed: boolean;
}

/** A skill's name as a person would say it: its own display title when it
 *  has one, otherwise its slug read aloud ("docx" → "Word documents"). */
export function skillTitle(skill: Pick<Skill, "display_title" | "name">): string {
  return skill.display_title?.trim() || humanSkillName(skill.name);
}

// ── A skill in a person's words ─────────────────────────────────────
//
// A skill's `name` is a slug ("docx", "mcp-builder") and its `description`
// is written for the model that decides when to load it ("Use this skill
// whenever the user wants to…"). Both are right for an agent and wrong for
// a gallery card. The two helpers below read them into a title and one
// line that says what you get. They only ever rephrase what the skill
// says about itself; the original text is shown in full in the skill's
// panel.

/** Skills that are named after a file format say what the files are. */
const FORMAT_TITLES: Record<string, string> = {
  docx: "Word documents",
  xlsx: "Excel spreadsheets",
  pptx: "PowerPoint slides",
  pdf: "PDF files",
  csv: "CSV files",
};

/** How a word in a slug is written. Anything not listed is left as it is. */
const WORDS: Record<string, string> = {
  api: "API", sdk: "SDK", cli: "CLI", mcp: "MCP", sql: "SQL", pdf: "PDF", csv: "CSV", json: "JSON", yaml: "YAML",
  html: "HTML", css: "CSS", gif: "GIF", svg: "SVG", png: "PNG", url: "URL", ui: "UI", ux: "UX", qa: "QA", ai: "AI",
  llm: "LLM", pr: "PR", ci: "CI", cd: "CD", id: "ID", seo: "SEO", crm: "CRM", kpi: "KPI", okr: "OKR", faq: "FAQ",
  aws: "AWS", gcp: "GCP", k8s: "Kubernetes", js: "JavaScript", ts: "TypeScript",
  docx: "Word", xlsx: "Excel", pptx: "PowerPoint",
  slack: "Slack", github: "GitHub", gitlab: "GitLab", claude: "Claude", anthropic: "Anthropic", openai: "OpenAI",
  notion: "Notion", linear: "Linear", jira: "Jira", figma: "Figma", stripe: "Stripe", sentry: "Sentry",
  playwright: "Playwright", react: "React", python: "Python",
  webapp: "web app", coauthoring: "co-authoring", comms: "comms", postmortem: "postmortem",
};

/** "mcp-builder" → "MCP builder", "docx" → "Word documents", "sql-style-guide" → "SQL style guide". */
export function humanSkillName(name: string | null | undefined): string {
  const slug = (name ?? "").trim();
  if (!slug) return "Unnamed skill";
  const lower = slug.toLowerCase();
  if (FORMAT_TITLES[lower]) return FORMAT_TITLES[lower];
  // A name that is already written for people ("Release notes", "Q4 Planning") is kept.
  if (/\s/.test(slug) || /[A-Z]/.test(slug)) return slug;
  const words = lower
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((word) => WORDS[word] ?? word);
  const title = words.join(" ");
  return title ? title[0].toUpperCase() + title.slice(1) : slug;
}

const SENTENCE_END = /(?<=[.!?])\s+(?=[A-Z0-9"'“(])/;
const ABBREVIATION = /\b(e\.g|i\.e|vs|etc|approx|incl)\.$/i;

function sentences(text: string): string[] {
  const out: string[] = [];
  for (const piece of text.split(SENTENCE_END)) {
    // "e.g. Something" is not the end of a sentence.
    if (out.length > 0 && ABBREVIATION.test(out[out.length - 1])) out[out.length - 1] += ` ${piece}`;
    else out.push(piece);
  }
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Sentences that tell the model when to load the skill, not a person what it does. */
const TRIGGER =
  /^(use (this|it|the skill|when|whenever|for|if)\b|this skill (should|must|is to|can) be used|you should use|claude should use|(this|it) (includes|means|covers)\b|triggers?\b|do not\b|don't\b|never\b|always\b|when (the|a) user\b|invoke\b|activate\b|important\b|note\b)/i;

/** "Use this skill whenever the user wants to create…" → "create…". */
const WANTS = /^use (?:this skill|it|this)?\s*(?:whenever|when|any ?time|if) (?:the |a )?users? (?:wants?|asks?|needs?|requests?|would like)(?: you)? to (.+)$/i;
/** "This includes: creating slide decks…" → "creating slide decks…". */
const INCLUDES = /^(?:this|it) (?:includes|means|covers)(?: any task where (?:the |a )?users? wants? to)?:?\s+(.+)$/i;
/** "A set of resources to help me write…" → "write…". */
const HELPS = /^(?:a |an )?(?:set|collection|suite) of (?:resources|tools|utilities|templates) to help (?:me|you|us|users?|the user) (.+)$/i;
/** Says nothing by itself ("do anything with PDF files"). */
const VAGUE = /^(do|handle) (anything|everything|something)\b/i;

/** A card speaks to the reader: "the formats my company likes" → "your company". */
const secondPerson = (text: string) => text.replace(/\bmy\b/g, "your").replace(/\bme\b/g, "you");

const capitalise = (text: string) => (text ? text[0].toUpperCase() + text.slice(1) : text);

// ── One voice ───────────────────────────────────────────────────────────
// Skill authors open their descriptions every which way: "Creating
// algorithmic art…", "Applies Anthropic's brand colors…", "Toolkit for
// styling artifacts…", "Create beautiful visual art…". Side by side in a
// catalogue that reads as four hands. A summary says what the skill lets
// an agent DO, as an instruction: "Create…", "Apply…", "Style…".
//
// Only verbs on this list are touched, so a noun that happens to end in
// "-ing" or "-s" is never mangled, and a sentence that opens some other
// way ("Reference for the Claude API", "House style for release notes") is
// left exactly as its author wrote it.

const VERBS = new Set(
  (
    "access add analyze annotate answer apply assemble assess assist audit automate benchmark brainstorm browse build calculate " +
    "capture check classify clean collect combine compare compile compose configure connect control convert coordinate craft create " +
    "debug decrypt define deliver deploy design detect document download draft edit encrypt evaluate explain explore export extract " +
    "fetch fill find fix format generate guide handle help host identify implement import improve inspect install integrate interact " +
    "launch list load make manage manipulate map measure merge migrate modify monitor navigate open operate optimize organize parse " +
    "plan prepare present process produce provide publish query read record refactor render research review rotate run schedule scrape " +
    "search send set split style summarize support test track transcribe transform translate update upload use validate verify view " +
    "visualize work write"
  ).split(" "),
);

/** "-ing" words that join clauses rather than name an action. */
const NOT_ACTIONS = new Set(["including", "using", "following", "according", "regarding", "during", "concerning"]);

/** "creating" → "create", "running" → "run", "applies" → "apply". Null when it is not a verb we know. */
function baseVerb(word: string): string | null {
  const w = word.toLowerCase();
  if (NOT_ACTIONS.has(w)) return null;
  const tries: string[] = [];
  if (w.endsWith("ing") && w.length > 5) {
    const stem = w.slice(0, -3);
    tries.push(stem, `${stem}e`);
    if (/([a-z])\1$/.test(stem)) tries.push(stem.slice(0, -1));
  } else if (w.endsWith("ies")) tries.push(`${w.slice(0, -3)}y`);
  else if (w.endsWith("es")) tries.push(w.slice(0, -2), w.slice(0, -1));
  else if (w.endsWith("s")) tries.push(w.slice(0, -1));
  return tries.find((t) => VERBS.has(t)) ?? null;
}

/** "Toolkit for styling artifacts…", "Suite of tools for creating…" → "styling artifacts…". */
const A_THING_FOR = /^(?:a |an |the )?(?:[\w-]+)(?: and [\w-]+)?(?: of [\w-]+)? for (\w+ing\b.*)$/i;

/** Put a summary in the catalogue's one voice: an instruction, verb first. */
export function inOneVoice(line: string): string {
  let text = line;
  const thing = text.match(A_THING_FOR);
  if (thing && baseVerb(thing[1].split(/\s/)[0])) text = thing[1];

  const first = text.match(/^[A-Za-z]+/)?.[0] ?? "";
  const base = first && !VERBS.has(first.toLowerCase()) ? baseVerb(first) : null;
  if (!base) return text === line ? line : capitalise(text);
  const wasGerund = /ing$/i.test(first);
  let out = base + text.slice(first.length);
  if (wasGerund) {
    // The rest of a list follows its head: "reading or extracting…, combining or merging…".
    out = out.replace(/((?:,| or| and| with and)\s+)(\w+ing)\b/gi, (whole, lead: string, word: string) => {
      const b = baseVerb(word);
      return b ? lead + b : whole;
    });
  }
  return capitalise(out);
}

/** Places a long sentence can stop and still be a sentence. */
const BREAKS: Array<{ at: RegExp; kind: "clause" | "aside" | "list" }> = [
  { at: /;\s/g, kind: "clause" },
  { at: /\s[—–]\s/g, kind: "clause" },
  { at: /:\s/g, kind: "clause" },
  { at: /\s(?=(?:that|which|when|whether|using|rather than)\b)/g, kind: "clause" },
  { at: /\s\(/g, kind: "aside" },
  { at: /,\s(?=(?:\w+ing|and|or|including|such|so|with|plus|then|as well)\b)/g, kind: "list" },
];

const count = (text: string, char: string) => text.split(char).length - 1;

/**
 * Shorten to `max` characters at the last place the sentence can stop:
 * never mid-word, never inside brackets, never with an ellipsis.
 */
function clip(sentence: string, max: number, cutOff: boolean): string {
  const text = sentence.replace(/[\s.…]+$/, "");
  if (text.length <= max && !cutOff) return text;
  const limit = Math.min(text.length - 1, max);
  let best = -1;
  for (const { at: pattern, kind } of BREAKS) {
    for (const match of text.matchAll(pattern)) {
      const at = match.index ?? -1;
      if (at < 32 || at > limit || at <= best) continue;
      const head = text.slice(0, at);
      // Not inside brackets: "(Model Context" is not a clause.
      if (count(head, "(") !== count(head, ")")) continue;
      if (kind === "aside") {
        // A gloss in the middle of the sentence ("MCP (Model Context Protocol) servers") stays;
        // only a trailing aside is dropped.
        const close = text.indexOf(")", at);
        if (close !== -1 && close < limit && close < text.length - 1) continue;
      }
      if (kind === "list") {
        // "reading, parsing, or extracting" is one phrase; stop only after a whole item.
        const item = head.slice(Math.max(...[",", ";", ":", "—", "–", "("].map((mark) => head.lastIndexOf(mark))) + 1).trim();
        if (item.split(/\s+/).length < 3) continue;
      }
      best = at;
    }
  }
  if (best !== -1) return text.slice(0, best).replace(/[\s,;:—–-]+$/, "");
  // Nowhere to stop cleanly. A sentence that is only a little long is better whole than cut.
  if (!cutOff && text.length <= max * 1.5) return text;
  const words = text.slice(0, cutOff ? Math.min(text.length, max) : max).replace(/\s+\S*$/, "");
  // Do not end on a word that needs another after it ("…for the").
  return words.replace(/(\s+(?:a|an|the|and|or|of|for|to|in|on|with|by|from|as|at|its|their|your))+$/i, "").replace(/[\s,;:—–-]+$/, "");
}

/**
 * One line that says what a skill gives you, read from its description.
 * The first sentence that describes the skill wins; a sentence addressed
 * to the model is rephrased when it carries the answer ("Use this skill
 * whenever the user wants to create… Word documents" → "Create… Word
 * documents.") and skipped when it does not. Returns "" when there is
 * nothing to say, so the caller can show its own "No description".
 */
export function skillSummary(description: string | null | undefined, max = 100): string {
  const text = cleanDescription(description).replace(/\s+/g, " ");
  if (!text) return "";
  const all = sentences(text);
  // A catalog lists the first few hundred characters: the last sentence may stop mid-word.
  const shortened = descriptionIsCutOff(text);
  const cutOff = (i: number) => shortened && i === all.length - 1;

  let fallback = "";
  for (let i = 0; i < all.length; i++) {
    const sentence = all[i];
    let said: string | undefined;
    if (!TRIGGER.test(sentence)) said = sentence.match(HELPS)?.[1] ?? sentence;
    else said = sentence.match(WANTS)?.[1] ?? sentence.match(INCLUDES)?.[1];
    if (!said) continue;
    if (VAGUE.test(said)) {
      fallback ||= said;
      continue;
    }
    const line = clip(inOneVoice(capitalise(secondPerson(said))), max, cutOff(i));
    if (line.length >= 12) return `${line}.`;
  }
  if (fallback) return `${clip(capitalise(fallback), max, false)}.`;
  // Nothing but instructions to the model: say the first one plainly rather than nothing.
  return `${clip(capitalise(all[0]), max, cutOff(0))}.`;
}

/** True when the description was shortened by the server (it stops mid-sentence). */
export function descriptionIsCutOff(description: string | null | undefined): boolean {
  const text = cleanDescription(description);
  return text.length >= 200 && !/[.!?…)"']$/.test(text);
}

export type SkillOriginKind = "anthropic" | "custom";

export interface SkillOrigin {
  kind: SkillOriginKind;
  /** Short label for a chip: "Anthropic", "lumen-hq/agent-skills", "Uploaded". */
  label: string;
  /** The full source string, when there is more to show than the label. */
  detail?: string;
}

/** Where a skill came from, in words. */
export function skillOrigin(skill: Pick<Skill, "source">): SkillOrigin {
  const source = skill.source?.trim() ?? "";
  if (source === "anthropic" || source.startsWith("anthropics/skills")) {
    return { kind: "anthropic", label: "Anthropic", detail: source === "anthropic" ? undefined : source };
  }
  if (!source || source === "custom") return { kind: "custom", label: "Uploaded" };
  if (/^https?:\/\//i.test(source)) {
    try {
      return { kind: "custom", label: new URL(source).host, detail: source };
    } catch {
      return { kind: "custom", label: "Imported", detail: source };
    }
  }
  const parts = source.split("/").filter(Boolean);
  return { kind: "custom", label: parts.length >= 2 ? `${parts[0]}/${parts[1]}` : source, detail: source };
}

/**
 * How a skill's security scan reads. Returns null when the runtime does
 * not report one: the UI then shows nothing rather than inventing a state.
 */
export function skillSecurity(
  status: string | null | undefined,
): { label: string; tone: StatusTone; about: string } | null {
  switch ((status ?? "").toLowerCase()) {
    case "curated":
      return { label: "Curated", tone: "success", about: "From the curated catalog. Scanned and hash-pinned." };
    case "approved":
    case "pass":
      return { label: "Approved", tone: "success", about: "Scanned with no blocking findings, then approved by a person." };
    case "flagged":
      return { label: "Flagged", tone: "warning", about: "The scan raised findings that a person accepted." };
    case "pending":
    case "quarantined":
      return { label: "Awaiting review", tone: "warning", about: "Scanned, and waiting for a person to approve it." };
    case "blocked":
    case "rejected":
      return { label: "Blocked", tone: "danger", about: "The scan found something that cannot be approved." };
    default:
      return null;
  }
}

export function scanVerdict(verdict: ScanReport["verdict"]): { label: string; tone: StatusTone } {
  if (verdict === "pass") return { label: "Passed", tone: "success" };
  if (verdict === "flagged") return { label: "Flagged", tone: "warning" };
  return { label: "Blocked", tone: "danger" };
}

export function parseScanReport(raw: string | null | undefined): ScanReport | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ScanReport>;
    if (!parsed || typeof parsed !== "object") return null;
    return {
      verdict: (parsed.verdict as ScanReport["verdict"]) ?? "pass",
      findings: Array.isArray(parsed.findings) ? parsed.findings : [],
      content_sha256: parsed.content_sha256 ?? "",
      bytes: typeof parsed.bytes === "number" ? parsed.bytes : 0,
    };
  } catch {
    return null;
  }
}

/** SKILL.md descriptions sometimes keep a YAML block-scalar marker ("|- …"). */
export function cleanDescription(text: string | null | undefined): string {
  return (text ?? "").replace(/^\s*[|>][+-]?\s+/, "").trim();
}

// ── Catalog categories ──────────────────────────────────────────────

export const CATEGORY_ORDER = ["documents", "design", "engineering", "communication", "meta", "general"];

const CATEGORY_META: Record<string, { label: string; blurb: string; icon: ComponentType<{ className?: string }> }> = {
  documents: { label: "Documents", blurb: "Read, write and convert office files.", icon: FileTextIcon },
  design: { label: "Design", blurb: "Visual work: interfaces, artwork and themes.", icon: PaletteIcon },
  engineering: { label: "Engineering", blurb: "Build, test and integrate software.", icon: CodeXmlIcon },
  communication: { label: "Communication", blurb: "Write for colleagues and channels.", icon: MessagesSquareIcon },
  meta: { label: "Meta", blurb: "Skills for making skills.", icon: WandSparklesIcon },
  general: { label: "General", blurb: "Everything else.", icon: PuzzleIcon },
};

export function categoryMeta(category: string) {
  return (
    CATEGORY_META[category] ?? {
      label: category ? category[0].toUpperCase() + category.slice(1) : "General",
      blurb: "",
      icon: PuzzleIcon,
    }
  );
}

// ── A skill's own mark ──────────────────────────────────────────────

type SkillIcon = ComponentType<{ className?: string }>;

/**
 * What a skill is about, read from its name: a gallery where every card
 * wears the same puzzle piece tells you nothing. First match wins; a name
 * that says nothing falls back to its catalog category, then to the puzzle
 * piece. These are subject icons, in the neutral tile every resource uses,
 * not a colour code.
 */
const SKILL_SUBJECTS: Array<[RegExp, SkillIcon]> = [
  [/xlsx|spreadsheet|excel|csv/, FileSpreadsheetIcon],
  [/pptx|slide|deck|presentation/, PresentationIcon],
  [/\bpdf\b/, FileTypeIcon],
  [/docx|word doc/, FileTextIcon],
  [/sql|database|warehouse|query/, DatabaseIcon],
  [/incident|postmortem|on-?call|outage/, SirenIcon],
  [/release|changelog/, ScrollTextIcon],
  [/competit|research|market|brief/, BinocularsIcon],
  [/support|macro|helpdesk|customer/, LifeBuoyIcon],
  [/brand|theme|style-?guide/, SwatchBookIcon],
  [/canvas|artwork|algorithmic|\bart\b|gif|image/, ImageIcon],
  [/frontend|interface|design/, PenToolIcon],
  [/test|\bqa\b|webapp/, TestTubeDiagonalIcon],
  [/\bmcp\b|\bapi\b|\bsdk\b|integration/, BlocksIcon],
  [/skill-?creator|making skills/, WandSparklesIcon],
  [/email|newsletter/, MailIcon],
  [/slack|comms|announce/, MessagesSquareIcon],
  [/coauthor|writing|notes|doc/, NotebookPenIcon],
  [/review|pull request|\bpr\b/, GitPullRequestIcon],
  [/analy|chart|metric|dashboard/, ChartLineIcon],
];

export function skillIcon(name: string | null | undefined, category?: string): SkillIcon {
  const t = (name ?? "").toLowerCase();
  if (t) for (const [pattern, icon] of SKILL_SUBJECTS) if (pattern.test(t)) return icon;
  return category ? categoryMeta(category).icon : PuzzleIcon;
}

// ── Upload ──────────────────────────────────────────────────────────

/** Mirrors the default UPLOAD_MAX_BYTES on the server. A self-hoster who
 *  raised it loses this early rejection; the server still enforces. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export function isZipFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return name.endsWith(".zip") || file.type === "application/zip" || file.type === "application/x-zip-compressed";
}

// ── Quiet reads ─────────────────────────────────────────────────────

