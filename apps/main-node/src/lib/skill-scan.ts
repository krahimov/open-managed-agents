/**
 * Skill quarantine — deterministic static scan over SKILL.md content.
 *
 * First stage of the ingestion pipeline (scan → report → human ratify →
 * hash-pinned install). A skill is instructions a model will follow, i.e.
 * a prompt-injection vector; this scanner is the code-enforced tier:
 *
 *   - "block" findings hard-stop the install (unparseable, binary
 *     smuggling, name collision with an installed skill).
 *   - "flag" findings surface in the report card for the human to weigh
 *     (embedded URLs, shell-exec patterns, credential references,
 *     injection-family strings, typosquat proximity).
 *
 * The LLM judge tier layers on top later with the restrict-only ratchet:
 * it may lower pass→flagged→blocked, never raise. `judge: "skipped"`
 * marks reports produced before that tier exists.
 *
 * Verdicts are deliberately conservative-static: a scan pass is NOT an
 * endorsement — the human ratification step is the actual gate, and the
 * agent's permission ceiling bounds whatever text gets through.
 */

import { createHash } from "node:crypto";
import { parseFrontmatter, normalizeSkillName } from "./skills.js";

export interface SkillScanFinding {
  severity: "block" | "flag";
  kind: string;
  detail: string;
}

export interface SkillScanReport {
  verdict: "pass" | "flagged" | "blocked";
  findings: SkillScanFinding[];
  content_sha256: string;
  bytes: number;
  /** LLM judge tier — "skipped" until it ships; then a verdict object. */
  judge: "skipped";
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Pull the URL out of a pasted `curl …` command (marketplaces hand users
 *  one-liners like `curl -fsSL https://…/SKILL.md`). Returns null when the
 *  input isn't a curl command — callers then treat it as URL/shorthand. */
export function extractUrlFromCurl(input: string): string | null {
  const trimmed = input.trim();
  if (!/^curl\s/.test(trimmed)) return null;
  const m = /https?:\/\/[^\s"']+/.exec(trimmed);
  return m ? m[0] : null;
}

function levenshtein(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3; // cap early — we only care about ≤2
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[a.length][b.length];
}

const INJECTION_PATTERNS: Array<{ re: RegExp; kind: string }> = [
  { re: /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions/i, kind: "injection_override" },
  { re: /do\s+not\s+(?:tell|inform|alert|mention\s+(?:this\s+)?to)\s+the\s+user/i, kind: "injection_concealment" },
  { re: /without\s+(?:telling|informing|asking|notifying)\s+the\s+user/i, kind: "injection_concealment" },
  { re: /\bcurl[^\n]{0,200}\|\s*(?:ba|z)?sh\b/i, kind: "shell_pipe_exec" },
  { re: /\bbase64\s+(?:-d|--decode)\b/i, kind: "encoded_exec" },
  { re: /~\/\.ssh|\/etc\/passwd|\bid_rsa\b/, kind: "credential_path" },
  { re: /\bprocess\.env\.[A-Z_]*(?:KEY|TOKEN|SECRET)|\$\{?[A-Z_]*(?:API_KEY|TOKEN|SECRET)\b/, kind: "credential_env" },
];

export function scanSkillContent(
  content: string,
  opts: { installedNames: string[] },
): SkillScanReport {
  const findings: SkillScanFinding[] = [];

  const fm = parseFrontmatter(content);
  const name = normalizeSkillName(fm.name ?? "");
  if (!name) {
    findings.push({
      severity: "block",
      kind: "unparseable",
      detail: "No frontmatter `name:` — not a valid SKILL.md.",
    });
  }
  if (!fm.description) {
    findings.push({
      severity: "flag",
      kind: "no_description",
      detail: "Frontmatter has no `description:` — reviewers can't compare stated purpose to body.",
    });
  }

  // Binary smuggling: long unbroken base64-ish runs have no business in a
  // markdown skill; they're how payloads hide from human review.
  if (/[A-Za-z0-9+/=]{400,}/.test(content.replace(/\s/g, ""))) {
    findings.push({
      severity: "block",
      kind: "binary_blob",
      detail: "Contains a long base64-like blob (>400 chars) — binary content can't be reviewed as text.",
    });
  }

  // Name collision / typosquatting against what's already installed.
  if (name) {
    const installed = opts.installedNames.map(normalizeSkillName);
    if (installed.includes(name)) {
      findings.push({
        severity: "block",
        kind: "name_collision",
        detail: `A skill named "${name}" is already installed — delete it first or rename this one.`,
      });
    } else {
      const near = installed.find((n) => n && levenshtein(n, name) <= 2);
      if (near) {
        findings.push({
          severity: "flag",
          kind: "typosquat",
          detail: `Name "${name}" is within edit distance 2 of installed skill "${near}" — verify this isn't impersonation.`,
        });
      }
    }
  }

  // Every embedded URL, listed for the reviewer (agents following a skill
  // will fetch these). Cap the list; the count is what matters past that.
  const urls = [...new Set(content.match(/https?:\/\/[^\s)>"'\]]+/g) ?? [])];
  for (const url of urls.slice(0, 10)) {
    findings.push({ severity: "flag", kind: "embedded_url", detail: url });
  }
  if (urls.length > 10) {
    findings.push({
      severity: "flag",
      kind: "embedded_url",
      detail: `…and ${urls.length - 10} more URLs.`,
    });
  }

  for (const { re, kind } of INJECTION_PATTERNS) {
    const m = re.exec(content);
    if (m) {
      findings.push({ severity: "flag", kind, detail: `Matches ${kind}: "${m[0].slice(0, 120)}"` });
    }
  }

  const verdict = findings.some((f) => f.severity === "block")
    ? "blocked"
    : findings.length > 0
      ? "flagged"
      : "pass";

  return {
    verdict,
    findings,
    content_sha256: sha256Hex(content),
    bytes: Buffer.byteLength(content, "utf8"),
    judge: "skipped",
  };
}
