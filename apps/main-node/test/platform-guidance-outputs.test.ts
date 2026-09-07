// Platform guidance: session-outputs path override (agent-machine work, T2).
//
// Agent-scoped sandboxes share one Daytona box across every session of an
// agent, so each session gets its own outputs dir (/mnt/sessions/<sid>/
// outputs) instead of the legacy /mnt/session/outputs. The system prompt
// must name the right dir — but the default text must stay byte-identical,
// because the CF SessionDO call site (two-argument form) sits on the
// prompt-cache prefix path and must not churn.

import { describe, it, expect } from "vitest";
import {
  DEFAULT_SESSION_OUTPUTS_PATH,
  composeSystemPrompt,
  platformGuidance,
  platformGuidanceFor,
  sessionOutputsGuidance,
  sessionOutputsGuidanceFor,
} from "@open-managed-agents/agent/harness/platform-guidance";

const RAW = "You are a helpful research agent.";
const REMINDERS = [
  { source: "skill:report-writer", text: "Write reports in Markdown." },
  { source: "memory:standing-rules", text: "Always cite sources." },
] as const;

const DEFAULT_PATH = "/mnt/session/outputs/";
const AGENT_SCOPE_PATH = "/mnt/sessions/s1/outputs/";

describe("sessionOutputsGuidanceFor", () => {
  it("with no argument is exactly the legacy sessionOutputsGuidance constant", () => {
    expect(sessionOutputsGuidanceFor()).toBe(sessionOutputsGuidance);
    expect(sessionOutputsGuidanceFor(DEFAULT_SESSION_OUTPUTS_PATH)).toBe(sessionOutputsGuidance);
    expect(DEFAULT_SESSION_OUTPUTS_PATH).toBe(DEFAULT_PATH);
  });

  it("keeps the legacy default text (anchor: the exact opening sentence)", () => {
    expect(sessionOutputsGuidance.startsWith("Files you write under `/mnt/session/outputs/` persist")).toBe(
      true,
    );
  });

  it("interpolates only the path — surrounding text is unchanged", () => {
    const custom = sessionOutputsGuidanceFor(AGENT_SCOPE_PATH);
    expect(custom).toContain(`\`${AGENT_SCOPE_PATH}\``);
    expect(custom).not.toContain(DEFAULT_PATH);
    // Everything except the path token is identical.
    expect(custom.replace(AGENT_SCOPE_PATH, DEFAULT_PATH)).toBe(sessionOutputsGuidance);
  });
});

describe("platformGuidanceFor", () => {
  it("with no options (or empty options) equals the platformGuidance constant", () => {
    expect(platformGuidanceFor()).toBe(platformGuidance);
    expect(platformGuidanceFor({})).toBe(platformGuidance);
    expect(platformGuidanceFor({ outputsPath: undefined })).toBe(platformGuidance);
    expect(platformGuidance).toContain(DEFAULT_PATH);
  });

  it("swaps the outputs path and keeps every other guidance block", () => {
    const custom = platformGuidanceFor({ outputsPath: AGENT_SCOPE_PATH });
    expect(custom).toContain(AGENT_SCOPE_PATH);
    expect(custom).not.toContain(DEFAULT_PATH);
    expect(custom.replace(AGENT_SCOPE_PATH, DEFAULT_PATH)).toBe(platformGuidance);
  });
});

describe("composeSystemPrompt outputs path", () => {
  it("two-argument form equals the three-argument form with empty opts (byte-identical default)", () => {
    const legacy = composeSystemPrompt(RAW, REMINDERS);
    expect(composeSystemPrompt(RAW, REMINDERS, {})).toBe(legacy);
    expect(composeSystemPrompt(RAW, REMINDERS, undefined)).toBe(legacy);
    expect(legacy).toContain(DEFAULT_PATH);
    expect(legacy).not.toContain(AGENT_SCOPE_PATH);
  });

  it("default form is raw + platformGuidance + reminder blocks, in that order", () => {
    const out = composeSystemPrompt(RAW, REMINDERS);
    expect(out.startsWith(`${RAW}\n\n${platformGuidance}\n\n`)).toBe(true);
    expect(out).toContain('<source name="skill:report-writer">\nWrite reports in Markdown.\n</source>');
    expect(out).toContain('<source name="memory:standing-rules">\nAlways cite sources.\n</source>');
    expect(out.indexOf(platformGuidance)).toBeLessThan(out.indexOf("<source name="));
  });

  it("no raw prompt and no reminders ⇒ exactly the platform guidance", () => {
    expect(composeSystemPrompt(null)).toBe(platformGuidance);
    expect(composeSystemPrompt(undefined, [])).toBe(platformGuidance);
    expect(composeSystemPrompt("", undefined, {})).toBe(platformGuidance);
  });

  it("with { outputsPath } the guidance names that path and not the default", () => {
    const out = composeSystemPrompt(RAW, REMINDERS, { outputsPath: AGENT_SCOPE_PATH });
    expect(out).toContain(`\`${AGENT_SCOPE_PATH}\``);
    expect(out).not.toContain(DEFAULT_PATH);
    // Same shape as the default form, only the path differs.
    expect(out.replace(AGENT_SCOPE_PATH, DEFAULT_PATH)).toBe(composeSystemPrompt(RAW, REMINDERS));
    // Raw prompt and reminders survive the override.
    expect(out.startsWith(`${RAW}\n\n`)).toBe(true);
    expect(out).toContain('<source name="skill:report-writer">');
  });

  it("override applies when there is no raw prompt too", () => {
    const out = composeSystemPrompt(null, undefined, { outputsPath: AGENT_SCOPE_PATH });
    expect(out).toBe(platformGuidanceFor({ outputsPath: AGENT_SCOPE_PATH }));
    expect(out).not.toContain(DEFAULT_PATH);
  });
});
