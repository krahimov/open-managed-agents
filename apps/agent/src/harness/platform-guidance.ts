// Platform guidance appended to every agent's system prompt. Single source
// of truth — both CF SessionDO and the self-host Node main read these.
// Keep additions surgical: every line is sent on every turn for every
// agent, so it sits on the prompt-cache prefix path. Don't expand without
// proportional benefit.

export const authenticatedCommandGuidance =
  "For commands that may require authentication, prefer issuing a single command instead of a chained shell command. If an authenticated chained command fails, retry with a simpler single-command form.";

// Loop-stop guidance: prod incidents have shown agents retrying the same
// failing tool call indefinitely when an upstream credential is missing or
// an external API is down. Cap retries explicitly and require a structured
// failure report so the human (or calling system) can intervene.
export const loopStopGuidance =
  "If the same tool call fails three times in a row with substantively the same error, stop retrying. Report (a) what you were trying to do, (b) the exact error, and (c) what you would need to make progress (a missing credential, a corrected input, an upstream service to recover), then end the turn instead of looping.";

// AMA-aligned `/mnt/session/outputs/` convention: the platform mounts a
// per-session R2-backed (or host-fs-backed on Node) directory at this path.
// Files written here are listable via GET /v1/sessions/:id/outputs and
// downloadable by the caller. Without this hint, agents historically wrote
// final artefacts to /workspace/ where they vanish on container recycle.
export const sessionOutputsGuidance =
  "Files you write under `/mnt/session/outputs/` persist after the session ends and are downloadable by the user from the session's Files panel. Use this path for final artifacts the user should keep (reports, exports, generated docs, packaged code). Files written anywhere else (e.g. `/workspace/`) are scratch — they may be lost on container recycle and are not user-accessible. Treat the sandbox as ephemeral compute, not bulk storage: do not create large datasets, disk images, archives, package caches, or direct writes under `/mnt/_oma_storage`. For external service files, prefer the matching MCP tool or provider upload flow.";

export const externalServiceGuidance =
  "When a user asks about an OAuth-connected external service such as Google Drive, Gmail, Notion, Slack, GitHub, or Linear, use the available MCP tools for that service first. Do not expect provider CLIs, OAuth tokens, API keys, or credential files to exist in bash; those credentials are held by the platform and injected only through MCP/proxy calls. Before saying credentials are missing, check whether a matching MCP tool is available and use that tool.";

export const environmentProposalGuidance =
  "When the user asks you to configure or create a sandbox environment, propose it as a single fenced `yaml` block with top-level key `environment`. Include `name`, optional `description`, and `config`. For self-host cloud sandboxes, use `config.type: cloud` and include relevant `sandbox` fields (`provider`, `image`, `workdir`, `ephemeral`, `bootstrap_tools`, `bootstrap_apt_packages`, `max_file_bytes`), `resources.outputs`, `memory.stores`, `packages`, `networking`, or `dockerfile` when needed. The user can approve that YAML in the session UI; do not claim the environment exists until a tool/API call or user approval confirms it.";

export const platformGuidance =
  `${authenticatedCommandGuidance}\n\n${loopStopGuidance}\n\n${sessionOutputsGuidance}\n\n${externalServiceGuidance}\n\n${environmentProposalGuidance}`;

/**
 * Compose agent.system + platform guidance + optional platform reminders
 * (skills / memory_prompts / appendable_prompts).
 *
 * Reminders are appended to the system prompt instead of broadcast as
 * `<system-reminder>` user.message events. The legacy approach
 * leaked the raw skill bodies into the visible conversation feed and
 * the event log — operators correctly objected that skill content is
 * static-per-session context and belongs in the system prompt where
 * Claude already knows to treat it as such.
 *
 * Each reminder is wrapped in an XML-ish `<source name="…">…</source>`
 * block so the model still has a structural cue about where each chunk
 * came from (matching Anthropic's scratchpad / source convention) and so
 * downstream consumers can grep the prompt for a specific skill.
 *
 * If the agent has no system prompt of its own AND no reminders, the
 * guidance alone becomes the system prompt.
 */
export function composeSystemPrompt(
  rawSystemPrompt: string | null | undefined,
  reminders?: ReadonlyArray<{ source: string; text: string }>,
): string {
  const raw = rawSystemPrompt ?? "";
  const base = raw ? `${raw}\n\n${platformGuidance}` : platformGuidance;
  if (!reminders?.length) return base;
  const blocks = reminders
    .map((r) => `<source name="${r.source}">\n${r.text}\n</source>`)
    .join("\n\n");
  return `${base}\n\n${blocks}`;
}
