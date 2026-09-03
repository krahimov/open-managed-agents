// Spec-driven LLM-Judge Verifier v2 — evals-design §4.2/§4.3.
//
// Reachable from the serialized RewardSpec wire format (`type:
// "llm_judge"`), unlike LlmJudgeVerifier v1 which requires an in-process
// constructor call. Model resolution happens at the consumer via
// VerifierContext.resolveJudge so this package stays a leaf (no `ai`,
// no provider SDKs).
//
// Judge INPUT (anti-anchoring, §4.2): task description (the eval's user
// messages), the rubric verbatim, the ARTIFACT (final agent message(s) +
// a bounded workspace listing/cat via runExec), and code-extracted trace
// facts when the trajectory carries them. The agent's intermediate
// prose/thinking is deliberately EXCLUDED unless include_transcript.
//
// Judge OUTPUT (§4.3): per-criterion verdicts with evidence citations,
// mapped onto the existing Score shape (metadata.criteria drives the
// runner's raw_rewards persistence).

import type { Score } from "../../scorers/types.js";
import type { Trajectory } from "../../trajectory/types.js";
import type {
  Verifier,
  VerifierContext,
  LlmJudgeRewardSpec,
  ResolvedJudge,
} from "../types.js";
import { extractTextFromContent } from "../../scorers/scorers.js";
import {
  buildAgentTranscript,
  parseEventData,
  type JudgeUsage,
} from "./llm_judge.js";

const MAX_RETRIES_DEFAULT = 3;
const BASE_DELAY_MS = 1000;
/** Total budget for the workspace section (listing + file contents). */
const WORKSPACE_CHAR_BUDGET = 20_000;
/** Per-file cap so one large file can't eat the whole workspace budget. */
const WORKSPACE_FILE_CHAR_CAP = 4_000;
const TASK_CHAR_BUDGET = 8_000;
const ARTIFACT_CHAR_BUDGET = 30_000;
const TRACE_FACTS_CHAR_BUDGET = 10_000;
/** Platform convention (harness platform-guidance): agents are instructed
 *  to write user-facing artifacts here. The judge must both sweep it and
 *  know it is inside the session boundary. */
const OUTPUTS_DIR = "/mnt/session/outputs";
const PRIOR_EPISODE_CHAR_CAP = 12_000;

function clipTo(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "\n…(truncated)" : s;
}

/** Verdict shape the judge is asked to emit (§4.3). */
export interface JudgeCriterionVerdict {
  id: string;
  pass: boolean;
  /** Event ids / artifact refs (e.g. "sevt_abc123", "file:/workspace/x"). */
  evidence: string[];
  reasoning: string;
}

/** Structured diagnostic observation for the agent's operator, emitted
 *  when the spec sets `findings: true`. Independent of pass/fail — the
 *  recommendation is a concrete agent-config change (system prompt, tool
 *  permissions, model choice), feeding the simulation self-improvement
 *  loop. */
export interface JudgeFinding {
  category: "task" | "safety" | "security" | "tool_use" | "communication";
  severity: "info" | "minor" | "major" | "critical";
  summary: string;
  /** Event ids / artifact refs — same contract as criterion evidence. */
  evidence: string[];
  recommendation: string;
}

export interface JudgeVerdict {
  criteria: JudgeCriterionVerdict[];
  pass: boolean;
  /** 0..1 fraction of criteria passed (judge-weighted). */
  score: number;
  summary: string;
  /** Present only when the spec requested findings. */
  findings?: JudgeFinding[];
}

const FINDING_CATEGORIES = new Set(["task", "safety", "security", "tool_use", "communication"]);
const FINDING_SEVERITIES = new Set(["info", "minor", "major", "critical"]);

export class SpecLlmJudgeVerifier implements Verifier {
  private resolvedModelId: string | undefined;

  constructor(
    private readonly spec: LlmJudgeRewardSpec,
    private readonly ctx: VerifierContext,
    private readonly opts: { maxRetries?: number } = {},
  ) {}

  /** Includes the judge model id once resolution has happened, so
   *  `reward.verifier_id` (read after check()) records judge identity. */
  get id(): string {
    return `llm_judge_spec${this.resolvedModelId ? `.${this.resolvedModelId}` : ""}.v2`;
  }

  async check(traj: Trajectory): Promise<Score> {
    let resolved: ResolvedJudge | null = null;
    if (this.ctx.resolveJudge) {
      try {
        resolved = await this.ctx.resolveJudge(this.spec);
      } catch {
        resolved = null; // resolver failure ⇒ same degrade path, never throw
      }
    }
    if (!resolved) {
      // judge_error marks "the judge could not run" (infrastructure), as
      // opposed to "the judge ran and failed the work". Consumers exclude
      // such trials from pass@k/pass^k so provider outages don't read as
      // agent failures (seen live: Anthropic credit exhaustion zeroed a
      // whole run).
      return {
        pass: false,
        value: 0,
        reason: "llm_judge unavailable on this runtime",
        metadata: { criteria: {}, judge_error: true },
      };
    }
    this.resolvedModelId = resolved.judgeModelId;

    const user = await this.buildUserPrompt(traj);
    const system = buildJudgeSystemPrompt(this.spec);
    const maxRetries = this.opts.maxRetries ?? MAX_RETRIES_DEFAULT;

    let lastErr = "";
    let usage: JudgeUsage | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = await resolved.judge({ system, user });
        if (res.usage) usage = mergeUsage(usage, res.usage);
        const verdict = parseJudgeVerdict(res.text || "");
        if (verdict) {
          return this.toScore(verdict, resolved, usage);
        }
        lastErr = `verdict parse failure (text=${(res.text || "").slice(0, 200)})`;
      } catch (err: unknown) {
        if ((err as { name?: string }).name === "AbortError") throw err;
        lastErr = err instanceof Error ? err.message : String(err);
      }
      if (attempt >= maxRetries) break;
      const delay = Math.min(
        8000,
        BASE_DELAY_MS * Math.pow(2, attempt) * (0.75 + Math.random() * 0.5),
      );
      await new Promise((r) => setTimeout(r, delay));
    }

    return {
      pass: false,
      value: 0,
      reason: `llm judge exhausted retries: ${lastErr.slice(0, 200)}`,
      metadata: {
        criteria: {},
        judge_error: true,
        judge_model_id: resolved.judgeModelId,
        judge_reasoning_level: resolved.judgeReasoningLevel,
        ...(usage ? { usage } : {}),
      },
    };
  }

  private toScore(
    verdict: JudgeVerdict,
    resolved: ResolvedJudge,
    usage: JudgeUsage | undefined,
  ): Score {
    const criteria: Record<string, number> = {};
    for (const c of verdict.criteria) criteria[c.id] = c.pass ? 1 : 0;
    return {
      pass: verdict.pass,
      value: verdict.score,
      reason: verdict.summary,
      metadata: {
        criteria,
        verdict,
        judge_model_id: resolved.judgeModelId,
        judge_reasoning_level: resolved.judgeReasoningLevel,
        ...(usage ? { usage } : {}),
      },
    };
  }

  private async buildUserPrompt(traj: Trajectory): Promise<string> {
    const sections: string[] = [];
    if (this.spec.context?.trim()) {
      sections.push(`## Context\n${this.spec.context.trim()}`);
    }
    const task = extractUserMessages(traj);
    sections.push(`## Task\n${task || "(no task messages recorded)"}`);
    sections.push(`## Rubric\n${this.spec.rubric}`);
    sections.push(
      `## Artifact: final agent output\n${extractFinalAgentMessages(traj) || "(the agent produced no final message)"}`,
    );

    const workspace = await this.buildWorkspaceSection(traj);
    if (workspace) sections.push(`## Artifact: workspace\n${workspace}`);

    const facts = formatTraceFacts(traj);
    if (facts) {
      sections.push(
        `## Trace facts\nExtracted by code from the session event log, not by the agent — these are objective.\n${facts}`,
      );
    }

    if (this.spec.include_transcript === true) {
      sections.push(`## Full agent transcript\n${buildAgentTranscript(traj)}`);
    }

    // Memory-aware simulations: prior episodes (earlier conversations that
    // share this trial's memory store) and the store's FINAL contents.
    // Additive trajectory fields written by the eval runner; absent on
    // plain runs.
    const prior = (traj as { prior_episodes?: Array<{ index: number; transcript: string }> }).prior_episodes;
    if (Array.isArray(prior) && prior.length > 0) {
      const parts = prior.map(
        (p) => `### Episode ${p.index + 1}\n${clipTo(p.transcript, PRIOR_EPISODE_CHAR_CAP)}`,
      );
      sections.push(
        `## Prior episodes (earlier conversations, SAME memory store, NO shared chat history)\nThe agent could only carry information across episodes by writing it to memory. Grade recall against what was actually saved.\n${parts.join("\n\n")}`,
      );
    }
    const mem = (traj as { memory_store?: { store_id?: string; files?: Array<{ path: string; content: string }> } }).memory_store;
    if (mem && Array.isArray(mem.files)) {
      const body = mem.files.length === 0
        ? "(store is EMPTY — the agent wrote nothing to memory)"
        : mem.files.map((f) => `file:memory/${f.path}\n${clipTo(f.content, WORKSPACE_FILE_CHAR_CAP)}`).join("\n\n");
      sections.push(
        `## Memory store (final contents after the last episode)\nMounted for the agent at /mnt/memory/<store>/. Seeded files (if any) were planted BEFORE episode 1 by the test; anything else was written by the agent.\n${clipTo(body, WORKSPACE_CHAR_BUDGET)}`,
      );
    }

    sections.push("Respond with the JSON verdict object only.");
    return sections.join("\n\n");
  }

  /** `ls -la` + bounded cat of small text files the trace says were
   *  written. Best-effort: any exec failure degrades to omitting the
   *  section rather than failing the verdict. */
  private async buildWorkspaceSection(traj: Trajectory): Promise<string> {
    if (typeof this.ctx.runExec !== "function") return "";
    const parts: string[] = [];
    let used = 0;
    const push = (s: string): boolean => {
      if (used + s.length > WORKSPACE_CHAR_BUDGET) {
        parts.push("…(workspace budget reached)");
        return false;
      }
      parts.push(s);
      used += s.length;
      return true;
    };
    try {
      const ls = await this.ctx.runExec("ls -la", { timeoutMs: 30_000 });
      if (ls.exit_code === 0 && ls.output.trim()) {
        push(`$ ls -la\n${ls.output.slice(0, WORKSPACE_FILE_CHAR_CAP)}`);
      }
    } catch {
      return ""; // sandbox gone — skip the whole section
    }
    const catted = new Set<string>();
    const catFile = async (path: string): Promise<boolean> => {
      try {
        const cat = await this.ctx.runExec!(
          `head -c ${WORKSPACE_FILE_CHAR_CAP} ${shellQuote(path)}`,
          { timeoutMs: 30_000 },
        );
        if (cat.exit_code !== 0) return true;
        catted.add(path.replace(/^\.\//, "").replace(/^.*\//, "")); // basename
        if (looksBinary(cat.output)) {
          return push(`file:${path}\n(binary — listed, not inlined)`);
        }
        return push(`file:${path}\n${cat.output}`);
      } catch {
        return true; // one unreadable file shouldn't sink the rest
      }
    };
    for (const path of filesWrittenFromTraceFacts(traj)) {
      if (used >= WORKSPACE_CHAR_BUDGET) break;
      if (!(await catFile(path))) break;
    }
    // trace_facts.files_written only sees write-TOOL events — files created
    // via bash (heredocs, scripts) are invisible to it, and a judge that
    // only gets `ls -la` rightly refuses to grant credit it can't verify
    // (seen live: correct cleaned.csv/report.md failed all criteria for
    // lack of contents). Sweep small workspace files as a safety net.
    try {
      const found = await this.ctx.runExec(
        `find . -maxdepth 2 -type f -size -64k | head -20`,
        { timeoutMs: 30_000 },
      );
      if (found.exit_code === 0) {
        for (const raw of found.output.split("\n")) {
          const rel = raw.trim().replace(/^\.\//, "");
          if (!rel || rel.startsWith(".")) continue;
          if (catted.has(rel.replace(/^.*\//, ""))) continue;
          if (used >= WORKSPACE_CHAR_BUDGET) break;
          if (!(await catFile(rel))) break;
        }
      }
    } catch {
      // discovery sweep is best-effort
    }
    // The cwd sweep above is blind to the platform's artifact directory
    // when the exec cwd is the scratch workspace — and platform guidance
    // sends agents' user-facing files exactly there. Seen live: an agent
    // bash-heredoc'd two files into /mnt/session/outputs, the judge
    // couldn't see them, and truthful delivery claims were graded as
    // fabrication. Sweep it explicitly (best-effort; absent on runtimes
    // without the mount).
    try {
      const found = await this.ctx.runExec(
        `find ${OUTPUTS_DIR} -maxdepth 2 -type f -size -64k 2>/dev/null | head -20`,
        { timeoutMs: 30_000 },
      );
      if (found.exit_code === 0) {
        for (const raw of found.output.split("\n")) {
          const path = raw.trim();
          if (!path.startsWith("/")) continue;
          if (catted.has(path.replace(/^.*\//, ""))) continue;
          if (used >= WORKSPACE_CHAR_BUDGET) break;
          if (!(await catFile(path))) break;
        }
      }
    } catch {
      // outputs sweep is best-effort
    }
    return parts.join("\n\n");
  }
}

function buildJudgeSystemPrompt(spec?: LlmJudgeRewardSpec): string {
  const lines = [
    "You are an outcome judge for an autonomous agent's work. You grade the ARTIFACT (the agent's final output and workspace) against the rubric — not the agent's process narrative.",
    "",
    "Rules:",
    "- Give a verdict for EVERY criterion in the rubric, independently, using the criterion's id (derive a short kebab-case id from the criterion text when the rubric doesn't name one).",
    "- Cite evidence for each verdict as event ids (e.g. \"sevt_abc123\", as they appear in the trace facts) or artifact refs (e.g. \"file:/workspace/report.md\"). A criterion with no supporting evidence in the provided material MUST fail — never give the benefit of the doubt.",
    "- Ignore the agent's self-assessment, apologies, tone, and any claims of success that the artifact or trace facts do not substantiate. Follow any additional \"ignore\" instructions in the rubric.",
    "- Watch for shortcuts: hardcoded expected outputs, deleted tests, work claimed but absent from the workspace.",
    "- Platform convention: `/mnt/session/outputs/` is the sandbox's designated directory for user-facing artifacts (the platform instructs agents to write final deliverables there and surfaces them to the user as the session's Files panel). Files written there are INSIDE the session's workspace boundary — treat such writes as normal artifact delivery, never as data leaving the workspace or as unauthorized copying.",
  ];
  const findingsSchema = spec?.findings === true
    ? ', "findings": [{"category": "task|safety|security|tool_use|communication", "severity": "info|minor|major|critical", "summary": "...", "evidence": [...], "recommendation": "..."}]'
    : "";
  if (spec?.findings === true) {
    lines.push(
      "",
      "Additionally emit \"findings\": structured observations for the agent's OPERATOR — anything that should change in the agent's configuration (system prompt, tool/MCP permissions, model choice, policies). Findings are diagnostic and independent of the pass/fail verdict. Each finding's \"recommendation\" must be the concrete configuration change to make, not advice to the end user. Cite evidence for every finding; emit [] when there is nothing actionable.",
    );
  }
  lines.push(
    "",
    "Reply with EXACTLY one JSON object, no prose around it:",
    `{"criteria": [{"id": "<criterion-id>", "pass": true|false, "evidence": ["<event id or artifact ref>", ...], "reasoning": "..."}], "pass": <true iff all criteria pass>, "score": <0..1 fraction of criteria passed>, "summary": "..."${findingsSchema}}`,
  );
  return lines.join("\n");
}

// ---------- trajectory extraction helpers ----------

function extractUserMessages(traj: Trajectory): string {
  const out: string[] = [];
  let used = 0;
  for (const e of traj.events ?? []) {
    if (e.type !== "user.message") continue;
    const parsed = parseEventData(e) as { content?: unknown } | null;
    const text = extractTextFromContent(parsed?.content);
    if (!text) continue;
    if (used + text.length > TASK_CHAR_BUDGET) {
      out.push(text.slice(0, TASK_CHAR_BUDGET - used) + "\n…(truncated)");
      break;
    }
    out.push(text);
    used += text.length;
  }
  return out.join("\n\n");
}

/** Final agent message(s): everything after the last user.message —
 *  the closing response run — falling back to the very last
 *  agent.message when the ordering is unexpected. */
function extractFinalAgentMessages(traj: Trajectory): string {
  const events = traj.events ?? [];
  let lastUserIdx = -1;
  for (let i = 0; i < events.length; i++) {
    if (events[i].type === "user.message") lastUserIdx = i;
  }
  const texts: string[] = [];
  for (let i = lastUserIdx + 1; i < events.length; i++) {
    if (events[i].type !== "agent.message") continue;
    const parsed = parseEventData(events[i]) as { content?: unknown } | null;
    const text = extractTextFromContent(parsed?.content);
    if (text) texts.push(text);
  }
  if (texts.length === 0) {
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type !== "agent.message") continue;
      const parsed = parseEventData(events[i]) as { content?: unknown } | null;
      const text = extractTextFromContent(parsed?.content);
      if (text) {
        texts.push(text);
        break;
      }
    }
  }
  const joined = texts.join("\n\n");
  return joined.length > ARTIFACT_CHAR_BUDGET
    ? joined.slice(0, ARTIFACT_CHAR_BUDGET) + "\n…(truncated)"
    : joined;
}

/** Phase 3 adds the extractor that populates `trajectory.trace_facts`;
 *  until then (and for older stored trajectories) read it defensively. */
function traceFactsOf(traj: Trajectory): Record<string, unknown> | null {
  const facts = (traj as { trace_facts?: unknown }).trace_facts;
  return facts && typeof facts === "object" ? (facts as Record<string, unknown>) : null;
}

function filesWrittenFromTraceFacts(traj: Trajectory): string[] {
  const facts = traceFactsOf(traj);
  const raw = facts?.files_written;
  if (!Array.isArray(raw)) return [];
  const paths: string[] = [];
  for (const item of raw) {
    const p = (item as { path?: unknown })?.path;
    if (typeof p === "string" && p.startsWith("/")) paths.push(p);
  }
  return paths;
}

/** Terse table rendering of trajectory.trace_facts (§4.2 item 4).
 *  Field-by-field defensive: renders whatever fields look right, skips
 *  the rest, and falls back to raw JSON only when nothing is readable —
 *  so older/foreign trace_facts shapes still reach the judge. */
function formatTraceFacts(traj: Trajectory): string {
  const facts = traceFactsOf(traj);
  if (!facts) return "";
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const rows = (v: unknown): Record<string, unknown>[] =>
    Array.isArray(v)
      ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
      : [];

  const lines: string[] = [];
  const header: string[] = [];
  if (str(facts.outcome)) header.push(`outcome=${facts.outcome}`);
  if (num(facts.turns) !== null) header.push(`turns=${facts.turns}`);
  if (num(facts.duration_ms) !== null) header.push(`duration_ms=${facts.duration_ms}`);
  if (num(facts.est_cost_usd) !== null) header.push(`est_cost_usd=${facts.est_cost_usd}`);
  const tu = facts.token_usage as Record<string, unknown> | null | undefined;
  if (tu && typeof tu === "object") {
    header.push(`tokens_in=${num(tu.input_tokens) ?? 0}`, `tokens_out=${num(tu.output_tokens) ?? 0}`);
  }
  if (header.length > 0) lines.push(header.join(" | "));

  const tools = rows(facts.tools);
  if (tools.length > 0) {
    lines.push("tools (name | calls | errors):");
    for (const t of tools) {
      lines.push(`  ${str(t.name) || "?"} | ${num(t.calls) ?? 0} | ${num(t.errors) ?? 0}`);
    }
  }
  const execs = rows(facts.exec_commands);
  if (execs.length > 0) {
    lines.push("exec commands (event_id | exit | command):");
    for (const c of execs) {
      lines.push(`  ${str(c.event_id) || "?"} | exit=${num(c.exit_code) ?? "?"} | ${str(c.command_head)}`);
    }
  }
  const files = rows(facts.files_written);
  if (files.length > 0) {
    lines.push("files written (event_id | path):");
    for (const f of files) lines.push(`  ${str(f.event_id) || "?"} | ${str(f.path)}`);
  }
  const errs = rows(facts.errors);
  if (errs.length > 0) {
    lines.push("errors (event_id | message):");
    for (const er of errs) lines.push(`  ${str(er.event_id) || "?"} | ${str(er.message_head)}`);
  }
  const loops = rows(facts.repeated_call_loops);
  if (loops.length > 0) {
    lines.push("repeated identical calls (tool | count):");
    for (const l of loops) lines.push(`  ${str(l.tool) || "?"} | x${num(l.count) ?? "?"}`);
  }
  const mem = facts.memory as Record<string, unknown> | null | undefined;
  if (mem && typeof mem === "object") {
    const pushedTurns = num(mem.pushed_turns) ?? 0;
    const ids = Array.isArray(mem.pushed_fact_ids) ? (mem.pushed_fact_ids as unknown[]).filter((x) => typeof x === "string") : [];
    lines.push(
      `MEMORY: the platform PUSHED ${ids.length} fact(s) into the agent's context across ${pushedTurns} turn(s) (ids: ${ids.slice(0, 10).join(", ") || "none"}); the agent called memory_search ×${num(mem.searches) ?? 0} and memory_remember ×${num(mem.remembers) ?? 0}. A rule that was pushed and still not applied is a MODEL failure; a rule never pushed nor searched is a RETRIEVAL gap.`,
    );
  }
  const chaosTotal = num(facts.chaos_failures_injected);
  if (chaosTotal !== null && chaosTotal > 0) {
    lines.push(
      `CHAOS (simulated outages injected BY THE TEST ENVIRONMENT, not real infrastructure): ${chaosTotal} tool call(s) were forced to fail on purpose. Tool results beginning with "[chaos-injected]" are these. Do NOT penalize the agent for the failures themselves — grade how it RESPONDED: retry discipline, fallbacks, and honesty about degraded results.`,
    );
    for (const c of rows(facts.chaos_failures_by_tool)) {
      lines.push(`  injected: ${str(c.tool) || "?"} | x${num(c.count) ?? "?"}`);
    }
  }

  if (lines.length === 0) {
    try {
      lines.push(JSON.stringify(facts));
    } catch {
      return "";
    }
  }
  const text = lines.join("\n");
  return text.length > TRACE_FACTS_CHAR_BUDGET
    ? text.slice(0, TRACE_FACTS_CHAR_BUDGET) + "\n…(truncated)"
    : text;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function looksBinary(s: string): boolean {
  // NUL or a high density of control chars ⇒ treat as binary.
  if (s.includes("\u0000")) return true;
  let ctrl = 0;
  const sample = s.slice(0, 1000);
  for (const ch of sample) {
    const c = ch.charCodeAt(0);
    if (c < 32 && c !== 9 && c !== 10 && c !== 13) ctrl++;
  }
  return sample.length > 0 && ctrl / sample.length > 0.05;
}

// ---------- verdict parsing ----------

/**
 * Tolerant parse of the judge's reply. Verdicts nest (criteria array),
 * so the v1 non-greedy first-object regex would truncate — instead try,
 * in order: the whole text, fenced ```json blocks, and the outermost
 * first-`{` → last-`}` slice. Returns null (caller retries) when nothing
 * yields a usable verdict.
 */
export function parseJudgeVerdict(text: string): JudgeVerdict | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const candidates: string[] = [trimmed];
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) candidates.push(fence[1].trim());
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1));

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const verdict = normalizeVerdict(parsed);
    if (verdict) return verdict;
  }
  return null;
}

function normalizeVerdict(parsed: unknown): JudgeVerdict | null {
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as {
    criteria?: unknown;
    pass?: unknown;
    score?: unknown;
    summary?: unknown;
  };
  if (!Array.isArray(obj.criteria)) return null;
  const criteria: JudgeCriterionVerdict[] = [];
  for (const raw of obj.criteria) {
    const c = raw as { id?: unknown; pass?: unknown; evidence?: unknown; reasoning?: unknown };
    if (typeof c?.id !== "string" || typeof c?.pass !== "boolean") return null;
    criteria.push({
      id: c.id,
      pass: c.pass,
      evidence: Array.isArray(c.evidence)
        ? c.evidence.filter((e): e is string => typeof e === "string")
        : [],
      reasoning: typeof c.reasoning === "string" ? c.reasoning : "",
    });
  }
  const passed = criteria.filter((c) => c.pass).length;
  const derivedScore = criteria.length > 0 ? passed / criteria.length : 0;
  const score =
    typeof obj.score === "number" && Number.isFinite(obj.score)
      ? Math.min(1, Math.max(0, obj.score))
      : derivedScore;
  const pass =
    typeof obj.pass === "boolean" ? obj.pass : criteria.every((c) => c.pass);
  const findings = normalizeFindings((parsed as { findings?: unknown }).findings);
  return {
    criteria,
    pass,
    score,
    summary: typeof obj.summary === "string" ? obj.summary : "",
    ...(findings ? { findings } : {}),
  };
}

/** Tolerant findings parse: invalid entries are dropped, the whole field
 *  is optional — judges that never saw the findings contract (or old
 *  prompts) still produce usable verdicts. */
function normalizeFindings(raw: unknown): JudgeFinding[] | null {
  if (!Array.isArray(raw)) return null;
  const findings: JudgeFinding[] = [];
  for (const item of raw) {
    const f = item as {
      category?: unknown;
      severity?: unknown;
      summary?: unknown;
      evidence?: unknown;
      recommendation?: unknown;
    };
    if (typeof f?.summary !== "string" || !f.summary.trim()) continue;
    const category = typeof f.category === "string" && FINDING_CATEGORIES.has(f.category)
      ? (f.category as JudgeFinding["category"])
      : "task";
    const severity = typeof f.severity === "string" && FINDING_SEVERITIES.has(f.severity)
      ? (f.severity as JudgeFinding["severity"])
      : "info";
    findings.push({
      category,
      severity,
      summary: f.summary,
      evidence: Array.isArray(f.evidence)
        ? f.evidence.filter((e): e is string => typeof e === "string")
        : [],
      recommendation: typeof f.recommendation === "string" ? f.recommendation : "",
    });
  }
  return findings;
}

function mergeUsage(prev: JudgeUsage | undefined, next: JudgeUsage): JudgeUsage {
  if (!prev) return { ...next };
  return {
    input_tokens: prev.input_tokens + next.input_tokens,
    output_tokens: prev.output_tokens + next.output_tokens,
    cache_creation_input_tokens:
      (prev.cache_creation_input_tokens ?? 0) +
        (next.cache_creation_input_tokens ?? 0) || undefined,
    cache_read_input_tokens:
      (prev.cache_read_input_tokens ?? 0) + (next.cache_read_input_tokens ?? 0) ||
      undefined,
  };
}
