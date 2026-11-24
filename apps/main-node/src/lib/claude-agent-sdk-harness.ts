/**
 * ClaudeAgentSdkHarness — HarnessInterface implementation that delegates the
 * agent loop to the Claude Agent SDK (headless Claude Code) running on this
 * host. Node-only: the SDK spawns a child process, so this harness lives in
 * main-node rather than the CF-deployable apps/agent package.
 *
 * Why: the Agent SDK is a sanctioned surface for Claude subscription billing
 * (the per-plan monthly Agent SDK credit). Sessions routed through this
 * harness authenticate via CLAUDE_CODE_OAUTH_TOKEN (or the host's interactive
 * Claude Code login) instead of a model-card API key, so no Anthropic API
 * credits are consumed.
 *
 * Like AcpProxyHarness, the child owns its own context, tools, and loop —
 * OMA does not drive generateText here. Each turn:
 *   1. Extract the text of the latest user.message.
 *   2. query() with `resume` pointing at the SDK session from the previous
 *      turn (in-memory map; a main-node restart starts a fresh SDK context
 *      while OMA's own event history remains the durable transcript).
 *   3. Translate streamed SDKMessages → SessionEvents via runtime.broadcast.
 *
 * Credential hygiene: the spawned env strips ANTHROPIC_API_KEY /
 * ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL so the child cannot silently
 * bill API credits — subscription auth (CLAUDE_CODE_OAUTH_TOKEN or keychain
 * login) is the only path left.
 *
 * Where the tools run (claudeSdkToolsOn):
 *   - "host": Claude Code's own tools (Bash, Read, Edit…) on this machine,
 *     with this process's environment. Single-operator self-hosting only.
 *   - "sandbox": Claude Code is the model loop and nothing else. Its
 *     built-in tools are off, it reads no settings, skills or MCP config
 *     from disk, its environment is cut down to what it needs to start and
 *     sign in, and its only tools are the session's prepared ones
 *     (ctx.tools: shell, files, browser, MCP, platform), which execute on
 *     the session's cloud sandbox and reach it over a loopback MCP bridge.
 *     Used for agent computers, and for every session once the operator
 *     restricts the engine with OMA_CLAUDE_ALLOWED_AGENTS (a hosted,
 *     multi-tenant deployment), where host tools would hand any tenant's
 *     agent this server's secrets.
 *
 * A setup session under either of those conditions is isolated the same
 * way, except that its only tools are the in-process oma_setup and
 * oma_platform ones (it needs no sandbox). "Isolated" below means both.
 */

import { matchMcpServerUrl } from "./access-request-route.js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { HarnessContext } from "@open-managed-agents/agent/harness/interface";
import {
  OMA_SETUP_HARNESS,
  OMA_SETUP_KIND_HARNESS_UPDATED,
  type ContentBlock,
  type SessionEvent,
  claudeReasoning,
  type ReasoningLevel,
} from "@open-managed-agents/api-types";
import type { AgentConfig } from "@open-managed-agents/shared";
import {
  OMA_BUILTINS_WITH_CC_EQUIVALENT,
  anyToolsetAsks,
  ccNameForOmaBuiltin,
  ccToolNameToOma,
  compileSdkDisallowedTools,
  evaluatePolicy,
  generateId,
  resolveOwningToolsetPermission,
} from "@open-managed-agents/shared";
import {
  buildSetupPrompt,
  harnessView,
  autoRequestAccessForNewServers,
  describeAutoAccess,
  runEnableMemory,
  ENABLE_MEMORY_TOOL_DESCRIPTION,
} from "./setup-harness.js";
import type { EnableMemoryResult } from "./agent-memory-mode.js";
import {
  materializeMemory,
  writeBackMemory,
  type MaterializedMemory,
  type SdkMemoryPort,
} from "./sdk-harness-memory.js";
import { startMcpHttpBridge, type McpHttpBridge } from "./mcp-http-bridge.js";
import { codexComputerTools } from "./codex-computer-tools.js";
import { claudeSdkAllowed } from "./engine-allowlist.js";

export { claudeSdkAllowed };

/** Fields a setup session may change on its own harness. */
export interface HarnessPatch {
  name?: string;
  description?: string;
  model?: string;
  system?: string;
  mcp_servers?: AgentConfig["mcp_servers"];
  skills?: AgentConfig["skills"];
}

/** OMA session id → SDK session id, for `resume` continuity across turns. */
const sdkSessions = new Map<string, string>();

/** OMA session id → last harness view broadcast from THAT session's
 *  update_harness calls. ctx.agent is the frozen session snapshot, so after
 *  the first edit it no longer reflects reality — this map keeps the true
 *  "before" for diff rendering across a multi-edit setup conversation.
 *  In-memory like sdkSessions: a restart just resets the diff baseline. */
const lastHarnessViews = new Map<string, Record<string, unknown>>();

/** Footgun guidance appended to every SDK-harness system prompt — distilled
 *  from real failed sessions (see git history for the gh api 404 incident). */
const CLI_NOTES = [
  "CLI usage notes:",
  "- `gh api`: quote any path containing `?`, and pass `-X GET` whenever you",
  "  use `-f`/`-F` for query params — otherwise gh switches the request to",
  "  POST and valid GET routes return 404.",
  "- You have built-in WebSearch and WebFetch tools even when they are not in",
  "  your immediate tool list — they may be DEFERRED: load them with ToolSearch",
  "  (query \"select:WebSearch,WebFetch\") before concluding web access is",
  "  unavailable. Do not assume connected MCP apps are the only search path.",
].join("\n");

/** Subset of NodeMcpProxyTarget the harness needs (defined in index.ts). */
export interface McpTarget {
  upstreamUrl: string;
  upstreamToken: string;
  upstreamAuthHeader?: { name: string; value: string };
}

export interface ClaudeAgentSdkHarnessDeps {
  /** Test seam: stands in for the SDK's `query` (no Claude Code spawned). */
  query?: typeof query;
  /**
   * Resolve an agent MCP server (by session + name) to its upstream URL and
   * auth — same resolution the OMA MCP proxy uses (vault credentials,
   * composio api keys, inline tokens). When provided, the agent's
   * `mcp_servers` are passed to the SDK child as direct HTTP MCP servers so
   * integrations work identically on this harness.
   */
  resolveMcpTarget?: (
    tenantId: string,
    sessionId: string,
    serverName: string,
  ) => Promise<McpTarget | null>;
  /**
   * Resolve the agent's skill refs ({type:"custom", skill_id}) to SKILL.md
   * documents. When provided, attached skills are materialized into the
   * session cwd at .claude/skills/<name>/SKILL.md and project-scope
   * discovery is enabled for that cwd (settingSources: ["project"] — the
   * `skills:` option alone cannot enable discovery).
   */
  resolveSkills?: (
    tenantId: string,
    refs: Array<{ skill_id: string; type: string }> | undefined,
  ) => Promise<Array<{ name: string; content: string }>>;
  /**
   * Read a session's metadata blob. Used by the builder toolset to load the
   * persisted draft (`metadata.harness_draft`) and the finalize guard
   * (`metadata.harness_finalized_agent_id`). Wired in main-node's buildHarness().
   */
  readSessionMetadata?: (
    tenantId: string,
    sessionId: string,
  ) => Promise<Record<string, unknown> | null>;
  /** Per-key merge into a session's metadata (drop a key by passing null). */
  patchSessionMetadata?: (
    tenantId: string,
    sessionId: string,
    patch: Record<string, unknown>,
  ) => Promise<void>;
  /**
   * Apply a setup session's refined harness to the agent it belongs to and
   * return the updated config (so the new harness can be broadcast). Provided
   * by main-node (wraps AgentService.update).
   */
  updateAgent?: (
    tenantId: string,
    agentId: string,
    patch: HarnessPatch,
  ) => Promise<AgentConfig>;
  /**
   * Agent-initiated credential request (the `request_access` tool). Appends
   * a system.access_request event to the session so the console renders a
   * one-click Composio connect card. Wired in main-node to the same
   * postAccessRequest helper the DefaultHarness buildTools hook uses.
   */
  requestServiceAccess?: (
    tenantId: string,
    sessionId: string,
    args: { service: string; reason: string; mcp_server_url?: string },
  ) => Promise<{ request_id: string; status: string; note?: string }>;
  /** Vault holding an active credential for an MCP server URL (setup:
   *  lets update_harness attach the vault instead of posting a card). */
  findCredentialVault?: (tenantId: string, mcpServerUrl: string, agentId?: string) => Promise<string | null>;
  /** Attach a vault to an agent's default vaults (idempotent) and make it the
   *  one the agent uses for `mcpServerUrl`. */
  attachVaultToAgent?: (tenantId: string, agentId: string, vaultId: string, mcpServerUrl?: string) => Promise<void>;
  /** Post the "using the saved login from <vault>" line for an attached vault. */
  reportSavedLogin?: (
    tenantId: string,
    sessionId: string,
    agentId: string,
    login: { service: string; mcpServerUrl: string; vaultId: string },
  ) => Promise<void>;
  /** Setup sessions: reconcile the servers already on the harness (cards /
   *  vault attach) once and return the status block for the preamble. */
  setupAccessStatus?: (
    tenantId: string,
    sessionId: string,
    agent: AgentConfig,
  ) => Promise<string | undefined>;
  /**
   * Create a standing ambient rule on the session's agent (the
   * `create_ambient_rule` tool). Main-node wires this to the same
   * createAmbientRuleFromSession helper the DefaultHarness buildTools hook
   * uses — it arms the first wake and appends the ambient-rule card event.
   */
  createAmbientRule?: (
    tenantId: string,
    sessionId: string,
    agentId: string,
    args: {
      name: string;
      description?: string;
      cron: string;
      timezone?: string;
      prompt: string;
      wake_mode?: "observe" | "decide" | "act" | "escalate";
    },
  ) => Promise<{ id: string; next_wake_at?: string; memory_note?: string }>;
  /** Turn on the agent's memory (the setup session's `enable_memory` tool):
   *  provisions the agent's store, sets the memory mode, and posts the
   *  setup-panel card. Same helper as the DefaultHarness setup tool. */
  enableMemory?: (
    tenantId: string,
    sessionId: string,
    agentId: string,
  ) => Promise<EnableMemoryResult>;
  /** Memory bridge for working sessions: attached stores are materialized
   *  into <cwd>/memory/<name>/ before the turn and changed files written
   *  back after (see sdk-harness-memory.ts). Without it an agent on this
   *  harness has no memory even when its memory mode is on. */
  memory?: SdkMemoryPort;
  /** Skill discovery (the `find_skill` tool) — tenant store + curated
   *  catalog keyword search, same helper as the DefaultHarness hook. */
  findSkills?: (
    tenantId: string,
    query: string,
  ) => Promise<Array<{ name: string; description: string; installed: boolean; source?: string }>>;
  /** Skill acquisition request (the `request_skill` tool) — appends a
   *  system.skill_request event the console renders as an attach card. */
  requestSkill?: (
    tenantId: string,
    agentId: string,
    sessionId: string,
    args: { skill_name: string; reason: string },
  ) => Promise<{ request_id: string; status: string; note?: string }>;
  /** Usage analytics tap: called per model on each SDK result message
   *  (its modelUsage map, or the aggregate usage when the map is empty).
   *  Best-effort; a failure never fails the turn. */
  recordUsage?: (
    tenantId: string,
    sessionId: string,
    agentId: string,
    u: SdkUsageRecord,
  ) => Promise<void> | void;
}

/** One model's share of an SDK turn, in usage-tracker terms
 *  (input_tokens = the uncached portion, as Anthropic reports it). */
export interface SdkUsageRecord {
  model: string;
  costUsd?: number;
  usage: {
    input_tokens: number;
    cached_input_tokens?: number;
    cache_write_input_tokens?: number;
    output_tokens: number;
    reasoning_tokens?: number;
  };
}

/**
 * The usage an SDK `result` message reports. It carries a per-model map
 * (with the SDK's own cost accounting) and an aggregate fallback. Field
 * names are read defensively: they are additive SDK surface. Error results
 * (max turns, execution error) still cost tokens, so they count too.
 */
export function usageFromSdkResult(msg: unknown, fallbackModel: string | undefined): SdkUsageRecord[] {
  const r = msg as {
    modelUsage?: Record<
      string,
      {
        inputTokens?: number;
        outputTokens?: number;
        cacheReadInputTokens?: number;
        cacheCreationInputTokens?: number;
        costUSD?: number;
      }
    >;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
    total_cost_usd?: number;
  } | null;
  if (!r) return [];
  if (r.modelUsage && Object.keys(r.modelUsage).length > 0) {
    return Object.entries(r.modelUsage).map(([usedModel, u]) => ({
      model: usedModel,
      costUsd: u.costUSD,
      usage: {
        input_tokens: u.inputTokens ?? 0,
        cached_input_tokens: u.cacheReadInputTokens ?? 0,
        cache_write_input_tokens: u.cacheCreationInputTokens ?? 0,
        output_tokens: u.outputTokens ?? 0,
      },
    }));
  }
  if (r.usage) {
    return [{
      model: fallbackModel ?? "claude-default",
      costUsd: r.total_cost_usd,
      usage: {
        input_tokens: r.usage.input_tokens ?? 0,
        cached_input_tokens: r.usage.cache_read_input_tokens ?? 0,
        cache_write_input_tokens: r.usage.cache_creation_input_tokens ?? 0,
        output_tokens: r.usage.output_tokens ?? 0,
      },
    }];
  }
  return [];
}

/**
 * Toolset permission policies (always_ask on a toolset or one tool) for the
 * claude-agent-sdk harness. It has no confirmation round-trip, so an
 * always_ask tool is refused rather than run unasked — the operator asked
 * to approve it. Resolved by the OWNING toolset (resolveOwningToolsetPermission,
 * not the DefaultHarness's restrict-only ratchet: this path never asked, so
 * a console agent's auto-written always_allow MCP servers keep working),
 * and only for tools a toolset can govern: the agent's declared MCP servers
 * and the OMA built-ins mapped onto Claude Code names (NotebookEdit counts
 * as edit). Claude Code internals (ToolSearch, TodoWrite, …) and the
 * platform's in-process servers (oma_setup / oma_platform) are never gated.
 *
 * Claude Code names MCP tools mcp__<server>__<tool> with the server name
 * normalized to [A-Za-z0-9_-]; declared servers are matched the same way.
 *
 * `disallowedTools` removes always_ask built-ins statically, because
 * permissionMode "default" auto-approves read-only built-ins (Read, Glob,
 * Grep) without consulting canUseTool; `asks` is the per-call check for
 * everything else (MCP tools are discovered at runtime).
 */
export function sdkToolsetGate(agent: Pick<AgentConfig, "tools" | "mcp_servers">): {
  active: boolean;
  disallowedTools: string[];
  asks: (ccToolName: string) => boolean;
} {
  const normalize = (name: string) => name.replace(/[^A-Za-z0-9_-]/g, "_");
  // CC server segment → declared OMA server name.
  const declared = new Map<string, string>();
  for (const s of agent.mcp_servers ?? []) {
    declared.set(s.name, s.name);
    if (!declared.has(normalize(s.name))) declared.set(normalize(s.name), s.name);
  }
  const ccAliases: Record<string, string> = { NotebookEdit: "edit", MultiEdit: "edit" };
  const omaNameOf = (ccName: string): string | null => {
    if (ccName.startsWith("mcp__")) {
      // Longest declared server whose CC form prefixes the name.
      const rest = ccName.slice("mcp__".length);
      const match = [...declared.keys()]
        .filter((k) => rest.startsWith(`${k}__`))
        .sort((a, b) => b.length - a.length)[0];
      return match ? `mcp__${declared.get(match)}__${rest.slice(match.length + 2)}` : null;
    }
    const oma = ccAliases[ccName] ?? ccToolNameToOma(ccName);
    return oma !== ccName ? oma : null;
  };
  const asks = (ccName: string): boolean => {
    const oma = omaNameOf(ccName);
    return !!oma && resolveOwningToolsetPermission(agent.tools, oma) === "always_ask";
  };
  const disallowedTools = [
    ...OMA_BUILTINS_WITH_CC_EQUIVALENT.filter(
      (oma) => resolveOwningToolsetPermission(agent.tools, oma) === "always_ask",
    ).map((oma) => ccNameForOmaBuiltin(oma)!),
    ...Object.entries(ccAliases)
      .filter(([, oma]) => resolveOwningToolsetPermission(agent.tools, oma) === "always_ask")
      .map(([cc]) => cc),
  ];
  return { active: anyToolsetAsks(agent.tools), disallowedTools, asks };
}

/** reasoning_level → claude-agent-sdk `thinking` / `effort` options via
 *  the shared Claude table (adaptive + effort on 4.6+, budget on ≤4.5,
 *  thinking off for legacy `instant` where the model allows it). With no
 *  card model (subscription default) only `effort` is sent — the SDK
 *  downgrades levels the model lacks (xhigh → high) itself. */
export function claudeSdkReasoningOptions(
  model: string | undefined,
  level: ReasoningLevel | undefined,
): {
  thinking?: { type: "adaptive" } | { type: "enabled"; budgetTokens: number } | { type: "disabled" };
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
} {
  const r = claudeReasoning(model ?? "claude-opus-5-5", level);
  if (!r) return {};
  if (r.mode === "off") return { thinking: { type: "disabled" } };
  if (r.mode === "budget") return { thinking: { type: "enabled", budgetTokens: r.budgetTokens } };
  return model ? { thinking: { type: "adaptive" }, effort: r.effort } : { effort: r.effort };
}

function workdirFor(sessionId: string): string {
  const root = process.env.SANDBOX_WORKDIR ?? "./data/sandboxes";
  return path.resolve(root, "agent-sdk", sessionId);
}

/** The MCP server the session's sandbox tools ride under in sandbox mode. */
export const SANDBOX_TOOLS_SERVER = "oma";
const SANDBOX_TOOL_PREFIX = `mcp__${SANDBOX_TOOLS_SERVER}__`;
/**
 * What an isolated turn allows of the in-process (oma_setup / oma_platform)
 * tools. Their handlers run in THIS process and change real things (the
 * agent's config, access requests), so the handlers themselves check the
 * turn, not only Claude Code's permission callback: `open` is false before
 * the turn's init is validated, after it ends, and for a tool the pinned
 * policy does not allow. `names` collects the exact tool names served.
 */
interface InProcessGate {
  open: (ccToolName: string) => boolean;
  names: Set<string>;
}

type SdkTool = ReturnType<typeof tool>;

/** createSdkMcpServer, with every handler behind `gate` when there is one. */
function inProcessServer(name: string, tools: SdkTool[], gate?: InProcessGate) {
  const served = !gate
    ? tools
    : tools.map((t) => {
        const ccName = `mcp__${name}__${t.name}`;
        gate.names.add(ccName);
        return {
          ...t,
          handler: (async (args: unknown, extra: unknown) =>
            gate.open(ccName)
              ? (t.handler as (a: unknown, e: unknown) => Promise<unknown>)(args, extra)
              : {
                  content: [{ type: "text" as const, text: "This tool is not available in this session right now." }],
                  isError: true,
                }) as SdkTool["handler"],
        };
      });
  return createSdkMcpServer({ name, version: "1", tools: served });
}
/** Claude Code replaces characters outside this set in MCP tool names. */
const ccMcpName = (name: string) => name.replace(/[^A-Za-z0-9_-]/g, "_");
/** How long a failed turn waits for tool calls it already accepted to stop. */
const TOOL_DRAIN_MS = 10_000;

type SandboxLike = { sandboxCapabilities?: () => { scope?: string } | undefined } | null | undefined;
type EnvLike = Record<string, string | undefined>;

/**
 * Where a claude-agent-sdk session's tools run (see the file header).
 * "sandbox" for an agent computer, and for any remote sandbox once the
 * operator has restricted the engine (OMA_CLAUDE_ALLOWED_AGENTS is set).
 * Otherwise "host", as before.
 */
export function claudeSdkToolsOn(sandbox: SandboxLike, env: EnvLike = process.env): "host" | "sandbox" {
  if (typeof sandbox?.sandboxCapabilities !== "function") return "host";
  if (sandbox.sandboxCapabilities()?.scope === "agent") return "sandbox";
  return env.OMA_CLAUDE_ALLOWED_AGENTS !== undefined ? "sandbox" : "host";
}

/**
 * The whole environment of a Claude Code process that must not see this
 * server's secrets: enough to start, verify TLS and sign in to the
 * subscription. No database URL, platform secret, provider key or
 * API-credit variable is inherited.
 */
export function isolatedClaudeEnv(base: EnvLike): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of [
    "PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
    "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR",
  ]) {
    if (base[key]) out[key] = base[key]!;
  }
  return out;
}

/**
 * Claude Code's built-in tools, removed by name in sandbox mode on top of
 * `tools: []`. That option alone is not enough: signed in with a
 * subscription token, Claude Code 0.3.170 still offered RemoteTrigger (which
 * drives scheduled cloud agents on the signed-in account). The init check
 * in run() stops the turn if any tool outside the bridge is still offered,
 * so a built-in this list does not know fails the session instead of
 * reaching the model.
 */
export const CLAUDE_CODE_BUILTIN_TOOLS = [
  "Agent", "Task", "TaskOutput", "TaskStop", "TaskCreate", "TaskGet", "TaskUpdate", "TaskList",
  "Bash", "BashOutput", "KillShell", "KillBash", "REPL", "Monitor",
  "Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Glob", "Grep", "LS", "LSP",
  "WebFetch", "WebSearch", "ToolSearch", "Skill", "SlashCommand", "Workflow",
  "TodoWrite", "AskUserQuestion", "EnterPlanMode", "ExitPlanMode", "EnterWorktree", "ExitWorktree",
  "CronCreate", "CronDelete", "CronList", "ScheduleWakeup", "RemoteTrigger", "PushNotification",
  "ListMcpResourcesTool", "ReadMcpResourceTool", "ListMcpResources", "ReadMcpResource", "Mcp",
] as const;

/** Appended to the agent's prompt in sandbox mode: this model was trained on
 *  Claude Code's own tool names, which are not here. */
const SANDBOX_TOOLS_NOTE =
  `All of your tools are the ${SANDBOX_TOOL_PREFIX}* tools. Shell commands, files, the browser and the desktop ` +
  "run on your cloud sandbox, not on the machine running this conversation; paths are the sandbox's. " +
  "You have no other tools.";

/** process.env minus every var that could route billing to API credits. */
function curatedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k === "ANTHROPIC_API_KEY" || k === "ANTHROPIC_AUTH_TOKEN" || k === "ANTHROPIC_BASE_URL") continue;
    env[k] = v;
  }
  return env;
}

function textOfUserMessage(ctx: HarnessContext): string {
  const blocks = ctx.userMessage?.content ?? [];
  const text = blocks
    .map((b) => (b.type === "text" ? b.text : ""))
    .filter(Boolean)
    .join("\n\n");
  return text || "(empty message)";
}

function textOfToolResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? (b as { text?: string }).text ?? "" : ""))
      .filter(Boolean)
      .join("\n");
  }
  return JSON.stringify(content ?? "");
}

/**
 * A tool result as stored: its text, and — when the tool returned pictures
 * (a screenshot, an image file it read) — the pictures too, as wire image
 * blocks, the same shape DefaultHarness stores, so the console can show what
 * the agent saw. Both the Messages API form (`source: { type: "base64" }`)
 * and the MCP form (`data` + `mimeType`) are kept. Text-only results stay
 * the plain string they always were.
 */
export function contentOfToolResult(content: unknown): string | ContentBlock[] {
  const text = textOfToolResult(content);
  if (!Array.isArray(content)) return text;
  const images: ContentBlock[] = [];
  for (const b of content) {
    const part = b as { type?: unknown; data?: unknown; mimeType?: unknown; source?: { type?: unknown; media_type?: unknown; data?: unknown } };
    if (part?.type !== "image") continue;
    const src = part.source;
    if (src?.type === "base64" && typeof src.media_type === "string" && typeof src.data === "string" && src.data) {
      images.push({ type: "image", source: { type: "base64", media_type: src.media_type, data: src.data } } as ContentBlock);
    } else if (typeof part.data === "string" && part.data && typeof part.mimeType === "string") {
      images.push({ type: "image", source: { type: "base64", media_type: part.mimeType, data: part.data } } as ContentBlock);
    }
  }
  if (images.length === 0) return text;
  return [...(text ? [{ type: "text", text } as ContentBlock] : []), ...images];
}

/**
 * tool()'s inputSchema type comes from the zod the SDK bundles (4.4.x). The
 * workspace pins zod 4.3.x, so a schema built with the workspace zod is
 * structurally identical but nominally distinct and won't satisfy the param
 * without a cast. Runtime is unaffected — both are zod v4. Localized here
 * instead of bumping the workspace-wide zod.
 */
type SdkToolSchema = Parameters<typeof tool>[2];

// harnessView + buildSetupPrompt live in ./setup-harness.ts — shared with the
// DefaultHarness setup path so both harnesses run the identical setup contract.

export class ClaudeAgentSdkHarness {
  #deps: ClaudeAgentSdkHarnessDeps;

  constructor(deps: ClaudeAgentSdkHarnessDeps = {}) {
    this.#deps = deps;
  }

  /** agent.mcp_servers → SDK http MCP configs with vault-resolved auth. */
  async #mcpServersFor(
    ctx: HarnessContext,
    sessionId: string,
  ): Promise<Record<string, { type: "http"; url: string; headers: Record<string, string> }> | undefined> {
    const resolve = this.#deps.resolveMcpTarget;
    const servers = ctx.agent.mcp_servers ?? [];
    const tenantId = ctx.tenant_id;
    if (!resolve || !tenantId || servers.length === 0) return undefined;

    const out: Record<string, { type: "http"; url: string; headers: Record<string, string> }> = {};
    for (const server of servers) {
      if (!server?.name) continue;
      try {
        const target = await resolve(tenantId, sessionId, server.name);
        if (!target) continue;
        const auth = target.upstreamAuthHeader ?? {
          name: "authorization",
          value: `Bearer ${target.upstreamToken}`,
        };
        out[server.name] = {
          type: "http",
          url: target.upstreamUrl,
          headers: { [auth.name]: auth.value },
        };
      } catch {
        // Unresolvable server (no vault credential, archived, …) — skip; the
        // child simply won't see this server's tools.
      }
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  /** In-process MCP server exposing the single harness-editing tool. The
   *  handler runs in THIS process (the SDK child calls back over the in-process
   *  MCP transport), so it can apply the change to the real agent and broadcast
   *  the new harness to the session's SSE stream. */
  #setupServer(ctx: HarnessContext, runtime: HarnessContext["runtime"], gate?: InProcessGate) {
    const tenantId = ctx.tenant_id ?? "default";
    const agentId = ctx.agent.id;

    const updateHarness = tool(
      "update_harness",
      "Change fields on your own harness (your agent configuration). Call after each meaningful answer so the live config on the user's screen stays in sync. Pass only the fields you want to change.",
      {
        name: z.string().optional(),
        description: z.string().optional(),
        model: z.string().optional(),
        system: z.string().optional(),
        mcp_servers: z.array(z.any()).optional(),
        skills: z.array(z.any()).optional(),
      } as unknown as SdkToolSchema,
      async (args) => {
        const patch: HarnessPatch = {};
        const changed: string[] = [];
        for (const key of [
          "name",
          "description",
          "model",
          "system",
          "mcp_servers",
          "skills",
        ] as const) {
          const value = (args as Record<string, unknown>)[key];
          if (value !== undefined) {
            (patch as Record<string, unknown>)[key] = value;
            changed.push(key);
          }
        }
        if (!this.#deps.updateAgent || changed.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: this.#deps.updateAgent
                  ? "No changes applied."
                  : "Harness editing is unavailable here.",
              },
            ],
            isError: !this.#deps.updateAgent,
          };
        }
        const sessionKey = ctx.session_id ?? "";
        const before = lastHarnessViews.get(sessionKey) ?? harnessView(ctx.agent);
        const updated = await this.#deps.updateAgent(tenantId, agentId, patch);
        const after = harnessView(updated);
        lastHarnessViews.set(sessionKey, after);
        runtime.broadcast({
          type: "agent.message",
          id: generateId(),
          content: [],
          metadata: {
            harness: OMA_SETUP_HARNESS,
            kind: OMA_SETUP_KIND_HARNESS_UPDATED,
            harness_config: after,
            // Previous values for the changed fields — the console renders
            // the update as a red/green diff card from these two views.
            harness_previous: before,
            changed,
          },
        } as SessionEvent);
        let summary = `Updated: ${changed.join(", ")}.`;
        // Newly added MCP servers get their connect cards posted right here —
        // deterministic, not left to the model (see setup-harness.ts).
        if (patch.mcp_servers !== undefined && this.#deps.requestServiceAccess) {
          const sessionId = ctx.session_id ?? "";
          const auto = await autoRequestAccessForNewServers(before.mcp_servers, after.mcp_servers, {
            requestAccess: (a) => this.#deps.requestServiceAccess!(tenantId, sessionId, a),
            findCredentialVault: this.#deps.findCredentialVault
              ? (url) => this.#deps.findCredentialVault!(tenantId, url, agentId)
              : undefined,
            attachVault: this.#deps.attachVaultToAgent
              ? (vaultId, url) => this.#deps.attachVaultToAgent!(tenantId, agentId, vaultId, url)
              : undefined,
            reportSavedLogin: this.#deps.reportSavedLogin
              ? (login) => this.#deps.reportSavedLogin!(tenantId, sessionId, agentId, login)
              : undefined,
          });
          const line = describeAutoAccess(auto);
          if (line) summary += ` ${line}`;
        }
        return { content: [{ type: "text", text: summary }] };
      },
    );

    const tools = [updateHarness];
    if (this.#deps.enableMemory) {
      tools.push(
        tool(
          "enable_memory",
          ENABLE_MEMORY_TOOL_DESCRIPTION,
          {} as unknown as SdkToolSchema,
          async () => ({
            content: [
              {
                type: "text" as const,
                text: await runEnableMemory(() =>
                  this.#deps.enableMemory!(tenantId, ctx.session_id ?? "", agentId),
                ),
              },
            ],
          }),
        ),
      );
    }

    return inProcessServer("oma_setup", tools, gate);
  }

  /** In-process MCP server exposing platform tools (request_access,
   *  create_ambient_rule) to the SDK child in both setup and working
   *  sessions. The child calls back over the in-process transport, so the
   *  handlers run HERE and can append session events directly. */
  #platformServer(ctx: HarnessContext, sessionId: string, gate?: InProcessGate) {
    const tenantId = ctx.tenant_id ?? "default";
    const requestAccess = tool(
      "request_access",
      "Ask the user to connect an external service you need but don't have access to (no connected " +
        "account / credential) — e.g. Gmail, GitHub, Notion, HubSpot. Posts a connect card to the user's " +
        "session view; they authenticate with one click and you receive a message when access is granted. " +
        "Call this the moment a task needs a service you can't reach (a tool is missing, or its calls fail " +
        "with an auth/not-connected error) instead of giving up or asking the user to paste secrets in chat. " +
        "Never ask for API keys or passwords in the conversation. After calling, continue whatever work " +
        "doesn't need the service, or end your turn and wait.",
      {
        service: z
          .string()
          .describe('Service/toolkit slug, lowercase (e.g. "gmail", "github", "notion", "hubspot")'),
        reason: z
          .string()
          .describe('One line shown to the user: what you need it for (e.g. "to read this week\'s invoices")'),
      } as unknown as SdkToolSchema,
      async (args) => {
        const a = args as { service?: string; reason?: string };
        if (!a.service?.trim()) {
          return { content: [{ type: "text" as const, text: "service is required" }], isError: true };
        }
        // Requested service that names one of the agent's own URL MCP
        // servers (e.g. the github/notion/linear servers it added during
        // setup) → the card runs vault MCP OAuth against that URL rather
        // than the Composio connected-account flow.
        const matchedUrl = matchMcpServerUrl(ctx.agent.mcp_servers, a.service);
        const result = await this.#deps.requestServiceAccess!(tenantId, sessionId, {
          service: a.service,
          reason: a.reason?.trim() || "The agent needs this service for the current task.",
          ...(matchedUrl ? { mcp_server_url: matchedUrl } : {}),
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      },
    );
    const tools = [requestAccess];

    if (this.#deps.createAmbientRule) {
      tools.push(
        tool(
          "create_ambient_rule",
          "Create a standing ambient rule on THIS agent: on the given cron, the platform starts a FRESH " +
            "session of this agent and injects `prompt` as the opening user message. Ambient rules outlive " +
            "this conversation — use them when the user asks for a recurring job (\"do deep research on X " +
            "every day\", \"check my email every morning\", \"review PRs as they come in on a schedule\"). " +
            "Confirm the cadence and the task with the user before creating one; the rule appears as a card " +
            "in their session view and can be managed later in the console's Ambient panel.",
          {
            name: z.string().describe('Short human-readable rule name, e.g. "Daily PR triage"'),
            description: z.string().optional().describe("One-line summary shown in the console"),
            cron: z.string().describe('5-field cron cadence (e.g. "0 9 * * *" = 9:00 daily)'),
            timezone: z.string().optional().describe('IANA timezone for the cron (e.g. "America/Los_Angeles"). Defaults to UTC.'),
            prompt: z.string().describe("Opening user message for each spawned session — the standing task, written to future-you"),
            wake_mode: z.enum(["observe", "decide", "act", "escalate"]).optional()
              .describe("act = do the task; decide (default) = assess then act if warranted; observe = log only; escalate = flag a human"),
          } as unknown as SdkToolSchema,
          async (args) => {
            const a = args as {
              name?: string; description?: string; cron?: string;
              timezone?: string; prompt?: string;
              wake_mode?: "observe" | "decide" | "act" | "escalate";
            };
            if (!a.name?.trim() || !a.cron?.trim() || !a.prompt?.trim()) {
              return {
                content: [{ type: "text" as const, text: "name, cron, and prompt are required" }],
                isError: true,
              };
            }
            try {
              const result = await this.#deps.createAmbientRule!(tenantId, sessionId, ctx.agent.id, {
                name: a.name,
                description: a.description,
                cron: a.cron,
                timezone: a.timezone,
                prompt: a.prompt,
                wake_mode: a.wake_mode,
              });
              return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
            } catch (err) {
              return {
                content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
                isError: true,
              };
            }
          },
        ),
      );
    }

    if (this.#deps.findSkills) {
      tools.push(
        tool(
          "find_skill",
          "Search available skills (installed + curated catalog) by keyword. A skill is a SKILL.md " +
            "playbook that teaches you how to do a class of task well (e.g. xlsx spreadsheets, pdf " +
            "manipulation, frontend design). Use when a task would benefit from domain expertise you " +
            "don't currently have loaded — then call request_skill to ask the user to attach one.",
          {
            query: z.string().describe('Keywords, e.g. "spreadsheet excel" or "pdf"'),
          } as unknown as SdkToolSchema,
          async (args) => {
            const a = args as { query?: string };
            if (!a.query?.trim()) {
              return { content: [{ type: "text" as const, text: "query is required" }], isError: true };
            }
            const skills = await this.#deps.findSkills!(tenantId, a.query);
            return { content: [{ type: "text" as const, text: JSON.stringify({ skills }) }] };
          },
        ),
      );
    }

    if (this.#deps.requestSkill) {
      tools.push(
        tool(
          "request_skill",
          "Ask the user to attach a skill to you (use find_skill first to discover the right name). " +
            "Posts an attach card to the user's session view; on approval the skill is security-scanned, " +
            "attached to your config, and its content is injected into THIS session so you can use it " +
            "immediately. Continue other work or end your turn while you wait.",
          {
            skill_name: z.string().describe('Skill name from find_skill (e.g. "xlsx")'),
            reason: z.string().describe("One line shown to the user: why you need it"),
          } as unknown as SdkToolSchema,
          async (args) => {
            const a = args as { skill_name?: string; reason?: string };
            if (!a.skill_name?.trim()) {
              return { content: [{ type: "text" as const, text: "skill_name is required" }], isError: true };
            }
            const result = await this.#deps.requestSkill!(tenantId, ctx.agent.id, sessionId, {
              skill_name: a.skill_name,
              reason: a.reason?.trim() || "The agent needs this skill for the current task.",
            });
            return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
          },
        ),
      );
    }

    return inProcessServer("oma_platform", tools, gate);
  }

  async run(ctx: HarnessContext): Promise<void> {
    const runtime = ctx.runtime;
    // Typed optional on HarnessContext but always set by buildHarnessContext.
    const sessionId = ctx.session_id ?? "unknown-session";
    const cwd = workdirFor(sessionId);
    await mkdir(cwd, { recursive: true });

    const abort = new AbortController();
    if (runtime.abortSignal) {
      if (runtime.abortSignal.aborted) abort.abort();
      else runtime.abortSignal.addEventListener("abort", () => abort.abort(), { once: true });
    }

    // Bare claude-* ids pass through; custom model-card ids mean nothing to
    // Claude Code, so fall back to its subscription default.
    const model =
      typeof ctx.agent.model === "string" && ctx.agent.model.startsWith("claude")
        ? ctx.agent.model
        : undefined;

    // Setup sessions (the agent's first session, refining its own harness) run
    // a focused planning conversation with an in-process toolset and NO
    // built-in/coding tools. Flagged via session metadata at creation.
    const sessionMeta = await this.#deps.readSessionMetadata?.(
      ctx.tenant_id ?? "default",
      sessionId,
    );
    const isSetup = sessionMeta?.["oma_setup"] === true && !!this.#deps.updateAgent;

    const fail = (message: string): never => {
      runtime.broadcast({ type: "session.error", error: message } as SessionEvent);
      throw new Error(message);
    };

    // Operator restriction (a hosted deployment): only approved agents bill
    // the server's subscription, and none of them gets tools on this host.
    // A setup session has no tools but the in-process oma_setup ones, so it
    // needs no sandbox.
    const toolsOn = claudeSdkToolsOn(runtime.sandbox);
    const restricted = process.env.OMA_CLAUDE_ALLOWED_AGENTS !== undefined;
    if (restricted) {
      if (!claudeSdkAllowed(process.env, ctx.tenant_id, ctx.agent.id ?? "")) {
        fail("Claude subscription access on this server is restricted to operator-approved agents.");
      }
      if (!isSetup && toolsOn !== "sandbox") {
        fail(
          "Claude subscription access on this server needs a cloud sandbox for the agent's tools. " +
            "Give the agent a cloud environment.",
        );
      }
    }
    /** Nothing of this host for Claude Code: setup and working sessions alike. */
    const isolated = restricted || toolsOn === "sandbox";
    /** Isolated working session: its only tools are the sandbox's. */
    const sandboxed = isolated && !isSetup;
    const childEnv = isolated ? isolatedClaudeEnv(process.env) : curatedEnv();

    // Isolated: Claude Code is given no upstream MCP server (and so none of
    // the agent's credentials). A working session reaches them through
    // ctx.tools; a setup session designs the config and does not call them.
    const mcpServers = isolated ? undefined : await this.#mcpServersFor(ctx, sessionId);

    // Materialize attached skills into <cwd>/.claude/skills/<name>/SKILL.md.
    // Idempotent per turn (overwrite) so skill edits apply on the next turn.
    // Never when isolated: a skill is the tenant's own text, Claude Code can
    // run shell lines embedded in one, and loading them needs project
    // settings read from disk.
    const skillNames: string[] = [];
    if (!isolated && this.#deps.resolveSkills && ctx.tenant_id) {
      try {
        const skills = await this.#deps.resolveSkills(ctx.tenant_id, ctx.agent.skills);
        for (const s of skills) {
          const dir = path.join(cwd, ".claude", "skills", s.name);
          await mkdir(dir, { recursive: true });
          await writeFile(path.join(dir, "SKILL.md"), s.content, "utf8");
          skillNames.push(s.name);
        }
      } catch {
        // missing/broken skills must not block the turn
      }
    }

    // request_access rides along in BOTH modes: in setup it's how the agent
    // hands the user the OAuth popups for the servers it just added to its
    // own harness; in working sessions it covers services hit mid-task.
    type SdkMcpEntry =
      | ReturnType<typeof createSdkMcpServer>
      | { type: "http"; url: string; headers: Record<string, string>; alwaysLoad?: boolean };
    let mcpServersForTurn: Record<string, SdkMcpEntry> | undefined = mcpServers;
    // Sandbox mode: one MCP server, the loopback bridge to ctx.tools (which
    // already carries request_access, scheduling and the agent's MCP tools).
    // alwaysLoad: with the built-ins off there is no ToolSearch to load a
    // deferred tool, so every tool must be in the prompt from the first turn.
    // The pinned access policy (snapshot enrichment set at session create).
    const policy = ctx.agent.effective_policy;
    const hasPolicy = !!policy?.rules?.length;
    /** Isolated: anything the policy does not plainly allow is refused, since
     *  this path cannot ask. */
    const policyRefuses = (omaToolName: string): string | null => {
      if (!hasPolicy) return null;
      const decision = evaluatePolicy(policy, omaToolName);
      return decision.effect === "allow" ? null : (decision.selector ?? "default");
    };

    let bridge: McpHttpBridge | null = null;
    // A tool call (bridged or in-process) runs only between a validated init
    // (see the stream loop) and the end of the turn, and is cancelled with
    // the turn.
    let acceptingCalls = false;
    const outstandingCalls = new Set<Promise<unknown>>();
    /** Exactly the tool names Claude Code may report in sandbox mode, each
     *  with the platform's own name for it ("mcp__oma__bash" → "bash"). */
    const bridgedNames = new Map<string, string>();
    /** Exactly the in-process tool names an isolated setup session serves. */
    const setupGate: InProcessGate | undefined = isolated
      ? { names: new Set(), open: (ccName) => acceptingCalls && policyRefuses(ccToolNameToOma(ccName)) === null }
      : undefined;
    if (sandboxed) {
      const tools = await codexComputerTools(ctx, {
        label: "The claude-agent-sdk harness",
        signal: abort.signal,
      }).catch((err) => fail(err instanceof Error ? err.message : String(err)));
      for (const t of tools) {
        // Claude Code would fold two such names into one, and a call could
        // then be recorded (and judged) as the other tool.
        const ccName = ccMcpName(`${SANDBOX_TOOL_PREFIX}${t.name}`);
        const twin = bridgedNames.get(ccName);
        if (twin !== undefined) {
          fail(`Two of this agent's tools, "${twin}" and "${t.name}", have the same name in Claude Code. Rename or remove one.`);
        }
        bridgedNames.set(ccName, t.name);
      }
      const gated = tools.map((t) => ({
        ...t,
        handler: async (args: Record<string, unknown>) => {
          if (!acceptingCalls) {
            return { text: "This tool is not available: the turn has not started or has ended.", isError: true };
          }
          if (policyRefuses(t.name) !== null) {
            return { text: "Denied by access policy. This tool is not available in this session.", isError: true };
          }
          const call = t.handler(args);
          outstandingCalls.add(call);
          try {
            return await call;
          } finally {
            outstandingCalls.delete(call);
          }
        },
      }));
      bridge = gated.length > 0 ? await startMcpHttpBridge(SANDBOX_TOOLS_SERVER, gated) : null;
      mcpServersForTurn = bridge
        ? { [SANDBOX_TOOLS_SERVER]: { type: "http", url: bridge.url, headers: bridge.headers, alwaysLoad: true } }
        : {};
    } else if (isSetup || this.#deps.requestServiceAccess) {
      const withInProcess: Record<string, SdkMcpEntry> = { ...(mcpServers ?? {}) };
      if (isSetup) withInProcess.oma_setup = this.#setupServer(ctx, runtime, setupGate);
      if (this.#deps.requestServiceAccess) {
        withInProcess.oma_platform = this.#platformServer(ctx, sessionId, setupGate);
      }
      mcpServersForTurn = withInProcess;
    }

    // Materialize attached memory stores into <cwd>/memory/<name>/ — the
    // same bridge the codex-sdk harness uses. Best-effort: a memory failure
    // must not block the turn.
    let materializedMemory: MaterializedMemory = {
      manifest: new Map(),
      storeByName: new Map(),
      guidance: "",
    };
    // (Sandbox mode mounts the stores in the sandbox at /mnt/memory instead.)
    if (!isSetup && !sandboxed && this.#deps.memory && ctx.tenant_id) {
      try {
        materializedMemory = await materializeMemory(this.#deps.memory, ctx.tenant_id, sessionId, cwd);
      } catch (err) {
        runtime.broadcast({
          type: "session.warning",
          source: "memory",
          message: `memory materialization failed: ${err instanceof Error ? err.message : String(err)}`,
        } as SessionEvent);
      }
    }

    // The pinned access policy (snapshot enrichment set at session create).
    // This harness never runs buildTools(), so the same policy is compiled
    // into SDK-native controls: a static disallowedTools list for exact-name
    // deny rules, plus a canUseTool backstop that re-evaluates every call in
    // the OMA namespace (covers glob selectors and dynamically-discovered
    // MCP tools). Phase 1 enforces deny only on this path — "ask" passes
    // through until the SDK confirmation round-trip lands (plan Phase 4).
    // Toolset always_ask (see sdkToolsetGate): refused per call, since this
    // path has no confirmation round-trip.
    // Sandbox mode has none of the tools this gate names: ctx.tools arrives
    // with ask-gated tools already stripped (see codexComputerTools), and the
    // policy is re-checked per call below.
    const toolsetGate = isolated
      ? { active: false, disallowedTools: [] as string[], asks: () => false }
      : sdkToolsetGate(ctx.agent);
    const gated = hasPolicy || toolsetGate.active;
    const disallowedTools = isolated
      ? [...new Set([...CLAUDE_CODE_BUILTIN_TOOLS, ...compileSdkDisallowedTools(policy)])]
      : [...new Set([...compileSdkDisallowedTools(policy), ...toolsetGate.disallowedTools])];
    if (toolsetGate.disallowedTools.length > 0) {
      // canUseTool never runs for removed tools, so say it once per turn.
      runtime.broadcast({
        type: "session.warning",
        source: "tool_permission",
        message:
          `Not offering ${toolsetGate.disallowedTools.join(", ")}: set to always_ask, which the claude-agent-sdk ` +
          `harness can't ask for yet. Use the default harness to approve calls, or set them to always_allow.`,
      } as SessionEvent);
    }

    /** The tools an isolated session may be offered and may call: the bridged
     *  ones by exact name (sandbox), the in-process setup ones (setup). */
    const isolatedToolAllowed = (toolName: unknown): toolName is string =>
      typeof toolName === "string" && (isSetup ? !!setupGate?.names.has(toolName) : bridgedNames.has(toolName));

    // Isolated: every call is checked. Only a tool this session serves may
    // run, and the pinned policy is evaluated on its OMA name (the handlers
    // check it again: see setupGate and the bridge).
    const isolatedCanUseTool = async (toolName: string, input: Record<string, unknown>) => {
      if (!isolatedToolAllowed(toolName)) {
        return { behavior: "deny" as const, message: "This tool is not available in this session." };
      }
      const omaName = bridgedNames.get(toolName) ?? ccToolNameToOma(toolName);
      const refusedBy = policyRefuses(omaName);
      if (refusedBy !== null) {
        runtime.broadcast({
          type: "system.policy_decision",
          tool_name: omaName,
          effect: "deny",
          selector: refusedBy,
          reason: "tool call denied by pinned access policy",
        } as SessionEvent);
        return {
          behavior: "deny" as const,
          message: `Denied by access policy (rule: ${refusedBy}). This tool is not available in this session.`,
        };
      }
      return { behavior: "allow" as const, updatedInput: input };
    };

    try {
      const stream = (this.#deps.query ?? query)({
        prompt: textOfUserMessage(ctx),
        options: {
          cwd,
          env: childEnv,
          abortController: abort,
          resume: sdkSessions.get(sessionId),
          model,
          ...claudeSdkReasoningOptions(model, ctx.agent.reasoning_level),
          mcpServers: mcpServersForTurn,
          systemPrompt: isSetup
            ? buildSetupPrompt(ctx.agent, {
                accessStatus: this.#deps.setupAccessStatus
                  ? await this.#deps.setupAccessStatus(
                      ctx.tenant_id ?? "default",
                      ctx.session_id ?? "",
                      ctx.agent,
                    )
                  : undefined,
              })
            : sandboxed
              ? // Not the claude_code preset: it describes tools and a working
                // directory this session does not have.
                [ctx.systemPrompt, SANDBOX_TOOLS_NOTE].filter(Boolean).join("\n\n")
              : {
                type: "preset",
                preset: "claude_code",
                // CLI_NOTES: observed footguns in headless sessions (e.g. `gh
                // api` with -f/-F silently switches GET→POST → bogus 404s).
                append: [ctx.systemPrompt, materializedMemory.guidance, CLI_NOTES]
                  .filter(Boolean)
                  .join("\n\n"),
              },
          // Headless: OMA has no tool-confirmation round-trip on this path
          // yet, and the child is already scoped to a per-session workdir.
          // With a pinned policy or an always_ask toolset, bypassPermissions
          // would skip canUseTool entirely — so those sessions run
          // permissionMode "default" and the callback below answers every
          // check (deny per policy / always_ask, allow otherwise), keeping
          // the turn headless while enforcing the gate.
          permissionMode: gated || isolated ? "default" : "bypassPermissions",
          ...(disallowedTools.length > 0 ? { disallowedTools } : {}),
          ...(isolated
            ? { canUseTool: isolatedCanUseTool }
            : gated
            ? {
                canUseTool: async (
                  toolName: string,
                  input: Record<string, unknown>,
                ) => {
                  if (toolsetGate.asks(toolName)) {
                    runtime.broadcast({
                      type: "session.warning",
                      source: "tool_permission",
                      message:
                        `Refused ${ccToolNameToOma(toolName)}: its toolset is always_ask and the claude-agent-sdk ` +
                        `harness can't ask for approval yet. Use the default harness to approve calls, or set the ` +
                        `toolset to always_allow.`,
                    } as SessionEvent);
                    return {
                      behavior: "deny" as const,
                      message:
                        `This tool requires user approval (always_ask), which this session can't request. ` +
                        `It was not run; tell the user it needs approval.`,
                    };
                  }
                  if (!hasPolicy) return { behavior: "allow" as const, updatedInput: input };
                  const decision = evaluatePolicy(
                    policy,
                    ccToolNameToOma(toolName),
                  );
                  if (decision.effect === "deny") {
                    runtime.broadcast({
                      type: "system.policy_decision",
                      tool_name: ccToolNameToOma(toolName),
                      effect: "deny",
                      selector: decision.selector,
                      reason: "tool call denied by pinned access policy",
                    } as SessionEvent);
                    return {
                      behavior: "deny" as const,
                      message: `Denied by access policy (rule: ${decision.selector ?? "default"}). This tool is not available in this session.`,
                    };
                  }
                  return { behavior: "allow" as const, updatedInput: input };
                },
              }
            : {}),
          // Project scope only when skills are attached (discovery is
          // governed by settingSources; the cwd is platform-owned so
          // "project" exposes exactly what we materialized). Never "user" —
          // this machine's personal CLAUDE.md/settings stay invisible.
          settingSources: skillNames.length > 0 ? ["project"] : [],
          skills: skillNames.length > 0 ? skillNames : undefined,
          // Setup: disable every built-in tool so the only callable tool is the
          // oma_setup MCP closure, and lock out any on-disk MCP config.
          // Isolated: the same, so the only tools are the ones we serve.
          ...(isSetup || isolated ? { tools: [], strictMcpConfig: true } : {}),
          maxTurns: isSetup ? 30 : 50,
          // Token-level partial events so text streams into the console
          // instead of landing as one block per assistant message.
          includePartialMessages: true,
        },
      });

      // Live text streaming. Each streamed text block gets a minted message
      // id; the ids queue up in order and the canonical assistant message
      // (which arrives after the block completes) consumes them FIFO so the
      // committed agent.message carries the SAME id as its chunks — clients
      // fold the stream bubble into the final message by that id.
      const streamedTextIds: string[] = [];
      let liveTextId: string | null = null;
      let liveTextChars = 0;
      const endLiveText = async (status: "completed" | "aborted") => {
        if (!liveTextId) return;
        const id = liveTextId;
        liveTextId = null;
        liveTextChars = 0;
        await runtime.broadcastStreamEnd(id, status).catch(() => {});
      };

      // Isolated: nothing Claude Code sends is acted on, and no bridged tool
      // runs, until its init message has shown that it offers only the
      // tools we serve.
      let initValidated = !isolated;
      for await (const msg of stream) {
        const isInit = msg.type === "system" && "subtype" in msg && msg.subtype === "init";
        if (!initValidated && !isInit) {
          // Other system notices may come first; anything else may not.
          if (msg.type === "system") continue;
          abort.abort();
          throw new Error(
            "claude-agent-sdk isolation: Claude Code produced output before reporting its tools. The turn was stopped.",
          );
        }
        if (msg.type === "stream_event") {
          const ev = (msg as { event?: { type?: string; content_block?: { type?: string }; delta?: { type?: string; text?: string } } }).event;
          if (!ev) continue;
          if (ev.type === "content_block_start" && ev.content_block?.type === "text") {
            liveTextId = generateId();
            liveTextChars = 0;
            streamedTextIds.push(liveTextId);
            await runtime.broadcastStreamStart(liveTextId).catch(() => {});
          } else if (
            ev.type === "content_block_delta" &&
            ev.delta?.type === "text_delta" &&
            liveTextId &&
            ev.delta.text
          ) {
            liveTextChars += ev.delta.text.length;
            await runtime.broadcastChunk(liveTextId, ev.delta.text).catch(() => {});
          } else if (ev.type === "content_block_stop") {
            // A zero-delta text block never produces a canonical agent.message
            // (empty text is skipped below) — drop its queued id so later
            // blocks don't fold onto the wrong message.
            if (liveTextId && liveTextChars === 0) streamedTextIds.pop();
            await endLiveText("completed");
          }
          continue;
        }
        if (isInit) {
          if (isolated) {
            // Fail closed. The list must be there, and every tool on it must
            // be one we serve: anything else means the built-ins did not
            // switch off (an SDK change, a setting we do not know), and this
            // turn must not go on. The session id is kept only after this,
            // so a rejected session is never resumed.
            const offered = (msg as { tools?: unknown }).tools;
            const outside = Array.isArray(offered) ? offered.filter((name) => !isolatedToolAllowed(name)) : null;
            if (outside === null || outside.length > 0) {
              abort.abort();
              throw new Error(
                outside === null
                  ? "claude-agent-sdk isolation: Claude Code did not report its tools. The turn was stopped."
                  : `claude-agent-sdk isolation: Claude Code offered tools outside this session's own ` +
                    `(${outside.slice(0, 5).map(String).join(", ")}). The turn was stopped before any ran.`,
              );
            }
            initValidated = true;
            acceptingCalls = true;
          }
          sdkSessions.set(sessionId, (msg as { session_id: string }).session_id);
          continue;
        }
        if (msg.type === "assistant") {
          sdkSessions.set(sessionId, msg.session_id);
          for (const block of msg.message.content) {
            if (block.type === "text" && block.text.trim()) {
              const streamedId = streamedTextIds.shift();
              runtime.broadcast({
                type: "agent.message",
                id: streamedId ?? generateId(),
                ...(streamedId ? { message_id: streamedId } : {}),
                content: [{ type: "text", text: block.text }],
              } as SessionEvent);
            } else if (block.type === "tool_use") {
              runtime.broadcast({
                type: "agent.tool_use",
                id: block.id,
                // Sandbox mode: the platform's own tool name ("bash"), as
                // the DefaultHarness records it.
                name: bridgedNames.get(block.name) ?? block.name,
                input: (block.input ?? {}) as Record<string, unknown>,
              } as SessionEvent);
            } else if (block.type === "thinking" && block.thinking) {
              runtime.broadcast({
                type: "agent.thinking",
                id: generateId(),
                text: block.thinking,
              } as SessionEvent);
            }
          }
          continue;
        }
        if (msg.type === "user") {
          const content = (msg as { message?: { content?: unknown } }).message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block && typeof block === "object" && (block as { type?: string }).type === "tool_result") {
                const tr = block as { tool_use_id: string; content?: unknown };
                runtime.broadcast({
                  type: "agent.tool_result",
                  tool_use_id: tr.tool_use_id,
                  content: contentOfToolResult(tr.content),
                } as SessionEvent);
              }
            }
          }
          continue;
        }
        if (msg.type === "result") {
          const record = this.#deps.recordUsage;
          if (record) {
            const tenantForUsage = ctx.tenant_id ?? "default";
            for (const u of usageFromSdkResult(msg, model)) {
              void Promise.resolve()
                .then(() => record(tenantForUsage, sessionId, ctx.agent.id, u))
                .catch(() => {});
            }
          }
          if (msg.subtype !== "success") {
            throw new Error(`claude-agent-sdk turn failed: ${msg.subtype}`);
          }
        }
      }
      if (!initValidated) {
        throw new Error("claude-agent-sdk isolation: Claude Code ended without reporting its tools.");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      runtime.broadcast({ type: "session.error", error: message } as SessionEvent);
      throw err;
    } finally {
      // No new bridged call from here on. One still running (the turn failed
      // or was stopped under it) is cancelled and given a moment to stop
      // before the bridge goes, so it cannot outlive the turn into a retry.
      acceptingCalls = false;
      if (outstandingCalls.size > 0) {
        abort.abort();
        await Promise.race([
          Promise.allSettled([...outstandingCalls]),
          new Promise((resolve) => setTimeout(resolve, TOOL_DRAIN_MS)),
        ]);
      }
      if (bridge) await bridge.close().catch(() => {});
    }

    // The endLiveText closure lives inside the try; any stream that died
    // mid-block was already ended as "aborted" by the recovery scan or the
    // catch above — nothing to clean up here.

    // Turn finished cleanly (the catch above re-throws) — sync memory edits
    // back to their stores. Best-effort: a write-back failure must not fail
    // the turn the agent already completed.
    if (!isSetup && !sandboxed && this.#deps.memory && ctx.tenant_id) {
      await writeBackMemory(this.#deps.memory, ctx.tenant_id, sessionId, cwd, materializedMemory)
        .then(({ saved, conflicts }) => {
          if (saved > 0 || conflicts.length > 0) {
            runtime.broadcast({
              type: "session.warning",
              source: "memory",
              message:
                `memory sync: ${saved} file(s) saved` +
                (conflicts.length > 0
                  ? `; ${conflicts.length} kept remote copy on conflict (${conflicts.slice(0, 3).join(", ")}${conflicts.length > 3 ? "…" : ""})`
                  : ""),
            } as SessionEvent);
          }
        })
        .catch(() => {});
    }
  }
}
