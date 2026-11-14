// The Orrery Agent Builder skill handed to Claude Code / Codex users from the
// Dashboard. The markdown lives in the repo's skills/ tree so the same file is
// what a user would drop into ~/.claude/skills or ~/.codex/skills; Vite inlines
// it at build time via the `?raw` import, so there is one source of truth.
import skill from "../../../../skills/orrery-agent-builder/SKILL.md?raw";

export const HARNESS_AGENT_BUILDER_SKILL: string = skill;

export const HARNESS_AGENT_BUILDER_PROMPT =
  "Use the Orrery Agent Builder skill to create a Gmail manager agent. Connect Gmail through Composio browser OAuth, add safe email triage rules, create a smoke session, and verify the agent can list available email tools without modifying anything.";
