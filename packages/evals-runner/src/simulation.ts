// Simulation support for the eval runner — persona prompt composition,
// tolerant persona-turn parsing, transcript reconstruction from stored
// session events, and the run-level findings rollup.
//
// The persona LLM is resolved through the SAME resolver as the judge
// (EvalRunnerContext.resolveJudge) — a persona call is exactly a JudgeFn
// ({system, user} → {text, usage}). tick.ts owns the resolution + the
// turn loop; everything here is pure and unit-testable.

import {
  extractTextFromContent,
  parseEventData,
  type JudgeFinding,
  type StoredEvent,
} from "@open-managed-agents/shared";
import type { EvalRunRecord, SimulationSpec, FindingsReport } from "./types";

/** Total conversations in a trial: episode 0 (the top-level spec) plus
 *  any `episodes` follow-ups. */
export function episodeCount(sim: SimulationSpec): number {
  return 1 + (sim.episodes?.length ?? 0);
}

/**
 * Resolve the SimulationSpec that governs episode `index`. Episode 0 is
 * the top-level spec verbatim; later episodes overlay their overrides on
 * it (persona fields merge shallowly). `gap_description` is surfaced to
 * the persona through the scenario text so it can role-play "two weeks
 * later" — the agent never sees it. Episodes share memory, chaos, and
 * persona_model with the parent.
 */
export function effectiveSim(sim: SimulationSpec, index: number): SimulationSpec {
  if (index <= 0 || !sim.episodes || index - 1 >= sim.episodes.length) return sim;
  const ep = sim.episodes[index - 1];
  const scenario = [
    ep.gap_description?.trim()
      ? `(Time has passed since your last conversation with this assistant: ${ep.gap_description.trim()}. You are starting a NEW conversation — the assistant does not automatically remember the previous one unless it saved notes.)`
      : "",
    ep.scenario?.trim() ?? sim.scenario,
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    ...sim,
    scenario,
    persona: { ...sim.persona, ...(ep.persona ?? {}) },
    opening_message: ep.opening_message ?? undefined,
    max_turns: ep.max_turns ?? sim.max_turns,
    // Follow-up episodes never inherit the parent's episodes list —
    // effectiveSim is always called with the parent spec.
    episodes: undefined,
  };
}

export interface PersonaTurn {
  action: "message" | "end";
  /** Required when action === "message". */
  text?: string;
  /** Why the persona ended the conversation. */
  reason?: string;
}

export interface TranscriptEntry {
  role: "persona" | "agent";
  text: string;
}

/** Total transcript budget in the persona prompt. Oldest turns are dropped
 *  first, but turn 0 (the opener) is always kept so the persona never loses
 *  the thread it started. */
const TRANSCRIPT_CHAR_BUDGET = 24_000;
/** Sanity cap when salvaging a non-JSON persona reply as a raw message. */
const RAW_MESSAGE_SALVAGE_CAP = 2_000;

export const DEFAULT_MAX_TURNS = 10;
export const HARD_MAX_TURNS = 40;
/** Simulations default to 15 min (vs 60 for scripted tasks) — a runaway
 *  conversation burns persona + agent tokens every turn. */
export const SIM_DEFAULT_TIMEOUT_MS = 900_000;

export function maxTurnsOf(sim: SimulationSpec): number {
  const raw = sim.max_turns ?? DEFAULT_MAX_TURNS;
  return Math.max(1, Math.min(raw, HARD_MAX_TURNS));
}

// ---------- persona prompt ----------

export function buildPersonaPrompt(
  sim: SimulationSpec,
  transcript: TranscriptEntry[],
): { system: string; user: string } {
  const p = sim.persona;
  const sections: string[] = [
    "You are role-playing a real human user interacting with an AI agent. Stay in character at all times; never reveal you are an AI or mention this simulation.",
    `# Who you are\n${p.name ? `${p.name}. ` : ""}${p.identity}`,
    `# Your goals\n${p.goals.map((g) => `- ${g}`).join("\n")}`,
  ];
  if (p.hidden_knowledge?.trim()) {
    sections.push(
      `# Things you know but only share when the agent asks\n${p.hidden_knowledge.trim()}`,
    );
  }
  if (p.communication_style?.trim()) {
    sections.push(`# How you communicate\n${p.communication_style.trim()}`);
  }
  sections.push(
    `# When the conversation is over\n${p.termination.trim()}\nAlso end if the agent has clearly and irrecoverably failed, or you have nothing left to say.`,
    [
      "Reply with EXACTLY one JSON object, no prose around it:",
      '{"action":"message","text":"<your next message, in character>"}',
      'or {"action":"end","reason":"<one sentence: why you are done>"}',
    ].join("\n"),
  );

  const user = transcript.length === 0
    ? `## Scenario\n${sim.scenario.trim()}\n\n## Conversation so far\n(empty — write your opening message)`
    : `## Scenario\n${sim.scenario.trim()}\n\n## Conversation so far\n${renderTranscript(transcript)}\n\nWrite your next turn (or end the conversation).`;

  return { system: sections.join("\n\n"), user };
}

function renderTranscript(transcript: TranscriptEntry[]): string {
  const lines = transcript.map(
    (t) => `${t.role === "persona" ? "You" : "Agent"}: ${t.text}`,
  );
  let total = lines.reduce((n, l) => n + l.length + 1, 0);
  if (total <= TRANSCRIPT_CHAR_BUDGET || lines.length <= 1) return lines.join("\n");
  // Drop oldest first, always keeping the opener (index 0).
  const kept = [...lines];
  let dropFrom = 1;
  while (total > TRANSCRIPT_CHAR_BUDGET && dropFrom < kept.length - 1) {
    total -= kept[dropFrom].length + 1;
    kept[dropFrom] = "";
    dropFrom++;
  }
  const result = [kept[0], "…(earlier turns truncated)", ...kept.slice(dropFrom).filter(Boolean)];
  return result.join("\n");
}

// ---------- persona output parsing ----------

/** Tolerant parse of the persona LLM's reply — same candidate strategy as
 *  parseJudgeVerdict (whole text → fenced block → outermost braces).
 *  Returns null when nothing yields a usable turn; the caller retries once
 *  and then may salvage the raw text via salvageRawMessage(). */
export function parsePersonaTurn(text: string): PersonaTurn | null {
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
    if (!parsed || typeof parsed !== "object") continue;
    const obj = parsed as { action?: unknown; text?: unknown; reason?: unknown };
    if (obj.action === "message" && typeof obj.text === "string" && obj.text.trim()) {
      return { action: "message", text: obj.text };
    }
    if (obj.action === "end") {
      return {
        action: "end",
        reason: typeof obj.reason === "string" ? obj.reason : undefined,
      };
    }
  }
  return null;
}

/** Last-resort recovery for a persona reply that never produced valid JSON:
 *  treat the raw text as the message when it reads like plausible prose.
 *  Returns null (→ fail the trial) for empty, JSON-ish, or oversized text. */
export function salvageRawMessage(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > RAW_MESSAGE_SALVAGE_CAP) return null;
  if (trimmed.startsWith("{") || trimmed.startsWith("```")) return null;
  return trimmed;
}

// ---------- transcript reconstruction ----------

/** Rebuild the conversation from stored session events. user.message events
 *  are the persona's turns (the runner posts them), agent.message events are
 *  the agent's replies. Works on both CF-shaped (data as JSON string) and
 *  Node-shaped (data as object) events via parseEventData. */
export function transcriptFromEvents(events: StoredEvent[]): TranscriptEntry[] {
  const transcript: TranscriptEntry[] = [];
  for (const e of events) {
    if (e.type !== "user.message" && e.type !== "agent.message") continue;
    const parsed = parseEventData(e) as { content?: unknown } | null;
    const text = extractTextFromContent(parsed?.content);
    if (!text) continue;
    transcript.push({
      role: e.type === "user.message" ? "persona" : "agent",
      text,
    });
  }
  return transcript;
}

// ---------- findings rollup ----------

const SEVERITY_ORDER: Record<string, number> = {
  critical: 3,
  major: 2,
  minor: 1,
  info: 0,
};
const FINDINGS_TOP_CAP = 20;
const FINDING_CLIP = 300;

export function clipFinding(f: JudgeFinding): JudgeFinding {
  return {
    ...f,
    summary: f.summary.slice(0, FINDING_CLIP),
    recommendation: f.recommendation.slice(0, FINDING_CLIP),
    evidence: f.evidence.slice(0, 8),
  };
}

/** Pure-code rollup of trial findings into run.findings_report — grouped
 *  category × severity counts plus a severity-sorted top list with
 *  provenance. No-op when no trial produced findings. */
export function aggregateFindings(run: EvalRunRecord): void {
  const all: Array<JudgeFinding & { task_id: string; trial_index: number }> = [];
  for (const task of run.tasks) {
    for (const trial of task.trials) {
      for (const f of trial.findings ?? []) {
        all.push({ ...f, task_id: task.id, trial_index: trial.trial_index });
      }
    }
  }
  if (all.length === 0) return;

  const byCategory: FindingsReport["by_category"] = {};
  for (const f of all) {
    const bucket = (byCategory[f.category] ??= {});
    bucket[f.severity] = (bucket[f.severity] ?? 0) + 1;
  }
  all.sort(
    (a, b) => (SEVERITY_ORDER[b.severity] ?? 0) - (SEVERITY_ORDER[a.severity] ?? 0),
  );
  run.findings_report = {
    generated_at: new Date().toISOString(),
    by_category: byCategory,
    top: all.slice(0, FINDINGS_TOP_CAP),
  };
}
