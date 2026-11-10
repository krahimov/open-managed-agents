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
//
// `sessionOutputsGuidanceFor(path)` exists for runtimes where the outputs
// dir is NOT the legacy path — an agent-scoped Daytona machine shares one
// box across sessions and mounts `/mnt/sessions/<sid>/outputs` instead
// (`SandboxExecutor.sessionOutputsPath()`). Only the path is interpolated;
// the surrounding text is identical so the default stays byte-for-byte
// what CF SessionDO has always sent (prompt-cache prefix).
export const DEFAULT_SESSION_OUTPUTS_PATH = "/mnt/session/outputs/";

export function sessionOutputsGuidanceFor(
  outputsPath: string = DEFAULT_SESSION_OUTPUTS_PATH,
): string {
  return `Files you write under \`${outputsPath}\` persist after the session ends and are downloadable by the user from the session's Files panel. Use this path for final artifacts the user should keep (reports, exports, generated docs, packaged code). Files written anywhere else (e.g. \`/workspace/\`) are scratch — they may be lost on container recycle and are not user-accessible. Treat the sandbox as ephemeral compute, not bulk storage: do not create large datasets, disk images, archives, bulk package caches, or direct writes under \`/mnt/_oma_storage\`. For external service files, prefer the matching MCP tool or provider upload flow.`;
}

export const sessionOutputsGuidance = sessionOutputsGuidanceFor();

// Prod QA: data-analysis agents hit `python: not found` and assumed pip was
// unusable, then burned calls rewriting the work in awk/node. The default
// sandbox images (CF venv, Daytona bootstrap) ship python3 + pip; custom
// images / bootstrap opt-outs may not, hence "normally". Hosts drop the line
// (`pythonTooling: false`) where commands run outside such a sandbox.
export const pythonToolingGuidance =
  "`python3` (usually also `python`) and `pip` are normally available in the sandbox. If a Python library you need (e.g. pandas, beautifulsoup4) is missing, `pip install` it on demand instead of rewriting the work in another language.";

export const externalServiceGuidance =
  "When a user asks about an OAuth-connected external service such as Google Drive, Gmail, Notion, Slack, GitHub, or Linear, use the available MCP tools for that service first. Do not expect provider CLIs, OAuth tokens, API keys, or credential files to exist in bash; those credentials are held by the platform and injected only through MCP/proxy calls. Before saying credentials are missing, check whether a matching MCP tool is available and use that tool.";

export const environmentProposalGuidance =
  "When the user asks you to configure or create a sandbox environment, propose it as a single fenced `yaml` block with top-level key `environment`. Include `name`, optional `description`, and `config`. For self-host cloud sandboxes, use `config.type: cloud` and include relevant `sandbox` fields (`provider`, `image`, `workdir`, `ephemeral`, `bootstrap_tools`, `bootstrap_apt_packages`, `max_file_bytes`), `resources.outputs`, `memory.stores`, `packages`, `networking`, or `dockerfile` when needed. The user can approve that YAML in the session UI; do not claim the environment exists until a tool/API call or user approval confirms it.";

/** Options accepted by `platformGuidanceFor` / `composeSystemPrompt`. */
export interface PlatformGuidanceOptions {
  /** Absolute outputs dir (with or without trailing slash) to name in the
   *  session-outputs guidance. Omit for the default `/mnt/session/outputs/`. */
  outputsPath?: string;
  /** Include `pythonToolingGuidance`. Default true (CF SessionDO, Daytona
   *  sandboxes). Pass false when agent commands run on the host instead of
   *  a bootstrapped sandbox (host-workdir SDK harnesses, subprocess). */
  pythonTooling?: boolean;
}

/**
 * Platform guidance with the session-outputs path resolved. With no
 * options (or `{}`) the result is exactly `platformGuidance`.
 */
export function platformGuidanceFor(opts?: PlatformGuidanceOptions): string {
  const outputs = opts?.outputsPath
    ? sessionOutputsGuidanceFor(opts.outputsPath)
    : sessionOutputsGuidance;
  const python = opts?.pythonTooling === false ? "" : `${pythonToolingGuidance}\n\n`;
  return `${authenticatedCommandGuidance}\n\n${loopStopGuidance}\n\n${outputs}\n\n${python}${externalServiceGuidance}\n\n${environmentProposalGuidance}`;
}

export const platformGuidance = platformGuidanceFor();

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
 *
 * `opts.outputsPath` swaps the outputs dir named in the guidance (agent-
 * scoped sandboxes mount a per-session dir). Omitted ⇒ byte-identical to
 * the two-argument form, so existing callers (CF SessionDO) are unaffected.
 */
export function composeSystemPrompt(
  rawSystemPrompt: string | null | undefined,
  reminders?: ReadonlyArray<{ source: string; text: string }>,
  opts?: PlatformGuidanceOptions,
): string {
  const raw = rawSystemPrompt ?? "";
  const guidance = platformGuidanceFor(opts);
  const base = raw ? `${raw}\n\n${guidance}` : guidance;
  if (!reminders?.length) return base;
  const blocks = reminders
    .map((r) => `<source name="${r.source}">\n${r.text}\n</source>`)
    .join("\n\n");
  return `${base}\n\n${blocks}`;
}

// Sent only to sessions with at least one memory store attached, so it is
// off the prompt-cache prefix of every other agent. Point (4) exists for
// recurring agents: each scheduled run is a fresh session, and a run that
// doesn't write down what it reported leaves the next one unable to say
// what's new (seen on prod 2026-11-10).
export const memoryGuidance =
  "You have persistent memory that survives across sessions (the memory store(s) listed below). Use it deliberately: (1) At the START of a task — and before asking the user to repeat anything they may have told you before — check memory for relevant preferences, standing rules, and past decisions. (2) Standing rules and preferences found in memory APPLY to every task they govern: before drafting, sending, scheduling, or deciding, enumerate the memory rules relevant to that action and follow them without being reminded. (3) When the user states a durable preference, rule, or decision (\"always…\", \"never…\", \"we decided…\", \"remember that…\"), save it to memory in the same turn — a short, self-contained note with the date — and confirm you saved it. (4) For recurring or follow-up work (scheduled reports, briefs, monitoring — anything where a later run must know what an earlier one did): before you finish, record in memory what you delivered — the date, the key items you reported, and their sources — so the next session can tell what is new. A new session starts blank except for what is in memory; anything written only to the workspace or said only in chat is gone. Do not save chatter or details nobody will need later.";
