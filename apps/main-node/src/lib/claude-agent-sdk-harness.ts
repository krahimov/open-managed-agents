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
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { HarnessContext } from "@open-managed-agents/agent/harness/interface";
import type { SessionEvent } from "@open-managed-agents/api-types";
import { generateId } from "@open-managed-agents/shared";

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

    try {
      const stream = query({
        prompt: textOfUserMessage(ctx),
        options: {
          cwd,
          env: curatedEnv(),
          abortController: abort,
          resume: sdkSessions.get(sessionId),
          model,
          mcpServers,
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            // CLI_NOTES: observed footguns in headless sessions (e.g. `gh api`
            // with -f/-F silently switches GET→POST → bogus 404s).
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
          maxTurns: 50,
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
