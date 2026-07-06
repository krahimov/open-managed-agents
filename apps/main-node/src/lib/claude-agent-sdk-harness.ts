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
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { HarnessContext } from "@open-managed-agents/agent/harness/interface";
import {
  OMA_SETUP_HARNESS,
  OMA_SETUP_KIND_HARNESS_UPDATED,
  type SessionEvent,
} from "@open-managed-agents/api-types";
import type { AgentConfig } from "@open-managed-agents/shared";
import { generateId } from "@open-managed-agents/shared";

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

/** Footgun guidance appended to every SDK-harness system prompt — distilled
 *  from real failed sessions (see git history for the gh api 404 incident). */
const CLI_NOTES = [
  "CLI usage notes:",
  "- `gh api`: quote any path containing `?`, and pass `-X GET` whenever you",
  "  use `-f`/`-F` for query params — otherwise gh switches the request to",
  "  POST and valid GET routes return 404.",
].join("\n");

/** Subset of NodeMcpProxyTarget the harness needs (defined in index.ts). */
export interface McpTarget {
  upstreamUrl: string;
  upstreamToken: string;
  upstreamAuthHeader?: { name: string; value: string };
}

export interface ClaudeAgentSdkHarnessDeps {
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
}

function workdirFor(sessionId: string): string {
  const root = process.env.SANDBOX_WORKDIR ?? "./data/sandboxes";
  return path.resolve(root, "agent-sdk", sessionId);
}

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
 * tool()'s inputSchema type comes from the zod the SDK bundles (4.4.x). The
 * workspace pins zod 4.3.x, so a schema built with the workspace zod is
 * structurally identical but nominally distinct and won't satisfy the param
 * without a cast. Runtime is unaffected — both are zod v4. Localized here
 * instead of bumping the workspace-wide zod.
 */
type SdkToolSchema = Parameters<typeof tool>[2];

/** The user-meaningful slice of an AgentConfig (drops internal bookkeeping like
 *  id/version/created_at). Shared by the setup preamble and the broadcast. */
function harnessView(agent: AgentConfig): Record<string, unknown> {
  const view: Record<string, unknown> = {};
  const model = typeof agent.model === "string" ? agent.model : agent.model?.id;
  if (agent.name) view.name = agent.name;
  if (agent.description) view.description = agent.description;
  if (model) view.model = model;
  if (agent.system) view.system = agent.system;
  if (agent.mcp_servers?.length) view.mcp_servers = agent.mcp_servers;
  if (agent.tools?.length) view.tools = agent.tools;
  if (agent.skills?.length) view.skills = agent.skills;
  return view;
}

/** Setup-mode preamble. Replaces the claude_code preset entirely (string
 *  systemPrompt) so the agent acts as a config designer refining ITS OWN
 *  harness, not a coding agent. The current harness is embedded so the agent
 *  can "scan its own harness" and clarify what the user wants. */
function buildSetupPrompt(agent: AgentConfig): string {
  return [
    "You are an OMA agent that was just created and is now in SETUP MODE — a planning conversation to dial in your own configuration (your \"harness\") before you start doing real work.",
    "",
    "Below is your CURRENT harness. Read it, then interview the user to clarify what they actually want you to do, and refine your own harness to match.",
    "",
    "```json",
    JSON.stringify(harnessView(agent), null, 2),
    "```",
    "",
    "You have exactly one tool and no file, shell, or web access:",
    "- update_harness: change fields on your own harness. Call it after EACH meaningful answer so the live config on the user's screen stays in sync. Pass only the fields that changed.",
    "",
    "Harness fields you can refine:",
    "- name / description: a short label + one-line summary of what you do.",
    "- model: your Claude model id (keep the current one unless the task clearly needs a stronger model).",
    "- system: your system prompt — the heart of the harness. Write it in the second person, concrete and task-specific.",
    "- mcp_servers: external tool servers, e.g. [{ \"name\": \"notion\", \"type\": \"url\", \"url\": \"https://mcp.notion.com/mcp\" }].",
    "- skills: optional named skills.",
    "",
    "How to run setup:",
    "1. Open by briefly reflecting your current purpose, then ask what the user wants you to do (or do differently).",
    "2. Ask ONE focused question at a time. After each answer, immediately call update_harness with what you can refine now — usually a sharper system prompt first, then name/description, then any MCP servers or skills.",
    "3. Keep tightening your system prompt as you learn more.",
    "4. Be concise. In a sentence, say what you just changed (e.g. \"I rewrote my system prompt around daily triage and added the Notion server\").",
    "5. When the user is satisfied, confirm your harness is set and that you're ready to run.",
    "",
    "Never invent credentials or secrets. For an MCP server that needs auth, add the server and tell the user they'll connect credentials afterward.",
  ].join("\n");
}

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
  #setupServer(ctx: HarnessContext, runtime: HarnessContext["runtime"]) {
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
        const updated = await this.#deps.updateAgent(tenantId, agentId, patch);
        runtime.broadcast({
          type: "agent.message",
          id: generateId(),
          content: [],
          metadata: {
            harness: OMA_SETUP_HARNESS,
            kind: OMA_SETUP_KIND_HARNESS_UPDATED,
            harness_config: harnessView(updated),
            changed,
          },
        } as SessionEvent);
        return { content: [{ type: "text", text: `Updated: ${changed.join(", ")}.` }] };
      },
    );

    return createSdkMcpServer({
      name: "oma_setup",
      version: "1",
      tools: [updateHarness],
    });
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

    const mcpServers = await this.#mcpServersFor(ctx, sessionId);

    // Materialize attached skills into <cwd>/.claude/skills/<name>/SKILL.md.
    // Idempotent per turn (overwrite) so skill edits apply on the next turn.
    const skillNames: string[] = [];
    if (this.#deps.resolveSkills && ctx.tenant_id) {
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

    // Setup sessions (the agent's first session, refining its own harness) run
    // a focused planning conversation with an in-process toolset and NO
    // built-in/coding tools. Flagged via session metadata at creation.
    const sessionMeta = await this.#deps.readSessionMetadata?.(
      ctx.tenant_id ?? "default",
      sessionId,
    );
    const isSetup = sessionMeta?.["oma_setup"] === true && !!this.#deps.updateAgent;
    const mcpServersForTurn = isSetup
      ? { ...(mcpServers ?? {}), oma_setup: this.#setupServer(ctx, runtime) }
      : mcpServers;

    try {
      const stream = query({
        prompt: textOfUserMessage(ctx),
        options: {
          cwd,
          env: curatedEnv(),
          abortController: abort,
          resume: sdkSessions.get(sessionId),
          model,
          mcpServers: mcpServersForTurn,
          systemPrompt: isSetup
            ? buildSetupPrompt(ctx.agent)
            : {
                type: "preset",
                preset: "claude_code",
                // CLI_NOTES: observed footguns in headless sessions (e.g. `gh
                // api` with -f/-F silently switches GET→POST → bogus 404s).
                append: [ctx.systemPrompt, CLI_NOTES].filter(Boolean).join("\n\n"),
              },
          // Headless: OMA has no tool-confirmation round-trip on this path
          // yet, and the child is already scoped to a per-session workdir.
          permissionMode: "bypassPermissions",
          // Project scope only when skills are attached (discovery is
          // governed by settingSources; the cwd is platform-owned so
          // "project" exposes exactly what we materialized). Never "user" —
          // this machine's personal CLAUDE.md/settings stay invisible.
          settingSources: skillNames.length > 0 ? ["project"] : [],
          skills: skillNames.length > 0 ? skillNames : undefined,
          // Setup: disable every built-in tool so the only callable tool is the
          // oma_setup MCP closure, and lock out any on-disk MCP config.
          ...(isSetup ? { tools: [], strictMcpConfig: true } : {}),
          maxTurns: isSetup ? 30 : 50,
        },
      });

      for await (const msg of stream) {
        if (msg.type === "system" && "subtype" in msg && msg.subtype === "init") {
          sdkSessions.set(sessionId, (msg as { session_id: string }).session_id);
          continue;
        }
        if (msg.type === "assistant") {
          sdkSessions.set(sessionId, msg.session_id);
          for (const block of msg.message.content) {
            if (block.type === "text" && block.text.trim()) {
              runtime.broadcast({
                type: "agent.message",
                id: generateId(),
                content: [{ type: "text", text: block.text }],
              } as SessionEvent);
            } else if (block.type === "tool_use") {
              runtime.broadcast({
                type: "agent.tool_use",
                id: block.id,
                name: block.name,
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
                  content: textOfToolResult(tr.content),
                } as SessionEvent);
              }
            }
          }
          continue;
        }
        if (msg.type === "result") {
          if (msg.subtype !== "success") {
            throw new Error(`claude-agent-sdk turn failed: ${msg.subtype}`);
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      runtime.broadcast({ type: "session.error", error: message } as SessionEvent);
      throw err;
    }
  }
}
