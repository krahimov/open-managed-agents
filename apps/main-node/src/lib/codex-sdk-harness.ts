/**
 * CodexSdkHarness — HarnessInterface implementation that delegates the agent
 * loop to the OpenAI Codex SDK (headless Codex CLI) running on this host.
 * Node-only: the SDK spawns the codex binary, so this harness lives in
 * main-node rather than the CF-deployable apps/agent package.
 *
 * Why: the Codex SDK is the sanctioned surface for ChatGPT/Codex subscription
 * billing — after `codex login` (browser OAuth, tokens in ~/.codex/auth.json)
 * requests hit the chatgpt.com Responses endpoint and bill to the user's
 * Plus/Pro plan instead of a model-card API key, so no OpenAI API credits are
 * consumed. The OpenAI-side sibling of ClaudeAgentSdkHarness.
 *
 * Like that harness, the child owns its own context, tools, and loop — OMA
 * does not drive generateText here. Each turn:
 *   1. Extract the text of the latest user.message.
 *   2. resumeThread() with the thread id from the previous turn (in-memory
 *      map; a main-node restart starts a fresh Codex thread while OMA's own
 *      event history remains the durable transcript).
 *   3. Translate streamed ThreadEvents → SessionEvents via runtime.broadcast.
 *
 * Credential hygiene: the spawned env strips OPENAI_API_KEY / CODEX_API_KEY /
 * OPENAI_BASE_URL so the child cannot silently bill API credits —
 * subscription auth (the host's `codex login` state) is the only path left.
 *
 * Known gaps vs the claude-agent-sdk harness (fail-closed, not silent):
 *   - No in-process MCP transport in the Codex SDK, so the oma_setup /
 *     oma_platform toolsets can't be exposed → setup sessions are rejected
 *     with guidance (configure the agent via the console form instead).
 *   - No per-tool permission callback, so pinned access policies can't be
 *     enforced → sessions with a policy are rejected rather than run open.
 * System prompt rides in <cwd>/AGENTS.md (the Codex project-doc channel);
 * attached skills are materialized under <cwd>/skills/ and referenced there.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Codex } from "@openai/codex-sdk";
import type { CodexOptions, ThreadEvent, ThreadItem, ThreadOptions } from "@openai/codex-sdk";
import type { HarnessContext } from "@open-managed-agents/agent/harness/interface";
import type { SessionEvent } from "@open-managed-agents/api-types";
import { generateId } from "@open-managed-agents/shared";
import type { McpTarget } from "./claude-agent-sdk-harness.js";
import {
  materializeMemory,
  writeBackMemory,
  type MaterializedMemory,
  type SdkMemoryPort,
} from "./sdk-harness-memory.js";

/** OMA session id → Codex thread id, for resume continuity across turns. */
const codexThreads = new Map<string, string>();

/** Structural slice of the Codex class the harness uses — injectable so
 *  tests can script the event stream without spawning the codex binary. */
export interface CodexLike {
  startThread(options?: ThreadOptions): CodexThreadLike;
  resumeThread(id: string, options?: ThreadOptions): CodexThreadLike;
}
export interface CodexThreadLike {
  runStreamed(
    input: string,
    turnOptions?: { signal?: AbortSignal },
  ): Promise<{ events: AsyncGenerator<ThreadEvent> | AsyncIterable<ThreadEvent> }>;
}

export interface CodexSdkHarnessDeps {
  /** Same resolution the OMA MCP proxy uses (vault credentials, composio api
   *  keys, inline tokens); resolved servers are passed to the codex child as
   *  streamable-HTTP MCP servers via `-c mcp_servers.<name>...`. */
  resolveMcpTarget?: (
    tenantId: string,
    sessionId: string,
    serverName: string,
  ) => Promise<McpTarget | null>;
  /** Resolve the agent's skill refs to SKILL.md documents. Codex has no
   *  native skills channel, so they are materialized under <cwd>/skills/ and
   *  indexed from AGENTS.md. */
  resolveSkills?: (
    tenantId: string,
    refs: Array<{ skill_id: string; type: string }> | undefined,
  ) => Promise<Array<{ name: string; content: string }>>;
  memory?: SdkMemoryPort;
  /** Used to detect setup sessions (metadata.oma_setup), which this harness
   *  cannot run — see the header comment. */
  readSessionMetadata?: (
    tenantId: string,
    sessionId: string,
  ) => Promise<Record<string, unknown> | null>;
  /** Test seam: build the Codex client. Defaults to `new Codex(options)`. */
  createCodex?: (options: CodexOptions) => CodexLike;
}

function workdirFor(sessionId: string): string {
  const root = process.env.SANDBOX_WORKDIR ?? "./data/sandboxes";
  return path.resolve(root, "codex-sdk", sessionId);
}

/** process.env minus every var that could route billing to API credits. */
export function curatedCodexEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (k === "OPENAI_API_KEY" || k === "CODEX_API_KEY" || k === "OPENAI_BASE_URL") continue;
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

/** Bare OpenAI model ids pass through; custom model-card ids mean nothing to
 *  the Codex CLI, so fall back to its subscription default. */
export function codexModelFor(model: unknown): string | undefined {
  return typeof model === "string" && /^(gpt-|o[0-9]|codex)/i.test(model) ? model : undefined;
}

function sandboxModeFromEnv(): "read-only" | "workspace-write" | "danger-full-access" {
  const v = process.env.OMA_CODEX_SANDBOX_MODE;
  return v === "read-only" || v === "danger-full-access" ? v : "workspace-write";
}

function textOfMcpResult(item: Extract<ThreadItem, { type: "mcp_tool_call" }>): string {
  if (item.error) return `error: ${item.error.message}`;
  const blocks = item.result?.content ?? [];
  const text = blocks
    .map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text?: unknown }).text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
  if (text) return text;
  if (item.result?.structured_content !== undefined && item.result.structured_content !== null) {
    return JSON.stringify(item.result.structured_content);
  }
  return "(no output)";
}

export class CodexSdkHarness {
  #deps: CodexSdkHarnessDeps;

  constructor(deps: CodexSdkHarnessDeps = {}) {
    this.#deps = deps;
  }

  /** agent.mcp_servers → codex `mcp_servers` config with vault-resolved auth. */
  async #mcpConfigFor(
    ctx: HarnessContext,
    sessionId: string,
  ): Promise<Record<string, { url: string; http_headers: Record<string, string> }> | undefined> {
    const resolve = this.#deps.resolveMcpTarget;
    const servers = ctx.agent.mcp_servers ?? [];
    const tenantId = ctx.tenant_id;
    if (!resolve || !tenantId || servers.length === 0) return undefined;

    const out: Record<string, { url: string; http_headers: Record<string, string> }> = {};
    for (const server of servers) {
      if (!server?.name) continue;
      try {
        const target = await resolve(tenantId, sessionId, server.name);
        if (!target) continue;
        const auth = target.upstreamAuthHeader ?? {
          name: "Authorization",
          value: `Bearer ${target.upstreamToken}`,
        };
        out[server.name] = {
          url: target.upstreamUrl,
          http_headers: { [auth.name]: auth.value },
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
    const sessionId = ctx.session_id ?? "unknown-session";
    const tenantId = ctx.tenant_id ?? "default";
    const cwd = workdirFor(sessionId);
    await mkdir(cwd, { recursive: true });

    const fail = (message: string): never => {
      runtime.broadcast({ type: "session.error", error: message } as SessionEvent);
      throw new Error(message);
    };

    // Setup sessions need the in-process oma_setup toolset, which the Codex
    // SDK has no transport for — reject with guidance rather than running a
    // conversation that can't apply its own edits.
    const sessionMeta = await this.#deps.readSessionMetadata?.(tenantId, sessionId);
    if (sessionMeta?.["oma_setup"] === true) {
      fail(
        "Setup sessions are not supported on the codex-sdk harness — configure this agent's " +
          "fields directly in the console, or create it with the default or claude-agent-sdk harness.",
      );
    }

    // No per-tool permission callback in the Codex SDK, so a pinned access
    // policy cannot be enforced on this path. Fail closed instead of running
    // the session more open than the operator ratified.
    const policy = ctx.agent.effective_policy;
    if (policy?.rules?.length) {
      fail(
        "This agent has a pinned access policy, which the codex-sdk harness cannot enforce yet. " +
          "Use the default or claude-agent-sdk harness, or remove the policy.",
      );
    }

    // Materialize attached skills under <cwd>/skills/<name>/SKILL.md and
    // index them from AGENTS.md. Idempotent per turn (overwrite) so skill
    // edits apply on the next turn.
    const skillNames: string[] = [];
    if (this.#deps.resolveSkills && ctx.tenant_id) {
      try {
        const skills = await this.#deps.resolveSkills(ctx.tenant_id, ctx.agent.skills);
        for (const s of skills) {
          const dir = path.join(cwd, "skills", s.name);
          await mkdir(dir, { recursive: true });
          await writeFile(path.join(dir, "SKILL.md"), s.content, "utf8");
          skillNames.push(s.name);
        }
      } catch {
        // missing/broken skills must not block the turn
      }
    }

    // Materialize attached memory stores — shared bridge with the
    // claude-agent-sdk harness (see sdk-harness-memory.ts).
    let materializedMemory: MaterializedMemory = {
      manifest: new Map(),
      storeByName: new Map(),
      guidance: "",
    };
    if (this.#deps.memory && ctx.tenant_id) {
      try {
        materializedMemory = await materializeMemory(this.#deps.memory, ctx.tenant_id, sessionId, cwd);
      } catch (err) {
        runtime.broadcast?.({
          type: "session.warning",
          source: "memory",
          message: `memory materialization failed: ${err instanceof Error ? err.message : String(err)}`,
        } as SessionEvent);
      }
    }

    // The OMA system prompt rides in <cwd>/AGENTS.md — the Codex CLI's
    // project-doc channel (ThreadOptions has no systemPrompt equivalent).
    // Rewritten every turn so agent edits apply on the next turn.
    const skillsGuidance =
      skillNames.length > 0
        ? [
            "Skills (task playbooks) attached to you — read the SKILL.md before doing work in its domain:",
            ...skillNames.map((n) => `  - ./skills/${n}/SKILL.md`),
          ].join("\n")
        : "";
    const agentsMd = [ctx.systemPrompt, materializedMemory.guidance, skillsGuidance]
      .filter(Boolean)
      .join("\n\n");
    if (agentsMd) await writeFile(path.join(cwd, "AGENTS.md"), agentsMd, "utf8");

    const mcpServers = await this.#mcpConfigFor(ctx, sessionId);
    const codexOptions: CodexOptions = {
      env: curatedCodexEnv(),
      // Escape hatch when the vendored @openai/codex platform binary is
      // unavailable (e.g. its optional dependency failed to download).
      ...(process.env.OMA_CODEX_PATH ? { codexPathOverride: process.env.OMA_CODEX_PATH } : {}),
      ...(mcpServers ? { config: { mcp_servers: mcpServers } } : {}),
    };
    const codex: CodexLike = this.#deps.createCodex
      ? this.#deps.createCodex(codexOptions)
      : new Codex(codexOptions);

    const threadOptions: ThreadOptions = {
      model: codexModelFor(ctx.agent.model),
      workingDirectory: cwd,
      skipGitRepoCheck: true,
      // Headless: no confirmation round-trip on this path; the child is
      // scoped to a per-session workdir by the CLI's own sandbox.
      approvalPolicy: "never",
      sandboxMode: sandboxModeFromEnv(),
      networkAccessEnabled: true,
    };
    const priorThreadId = codexThreads.get(sessionId);
    const thread = priorThreadId
      ? codex.resumeThread(priorThreadId, threadOptions)
      : codex.startThread(threadOptions);

    // codex item ids ("item_0", "item_1", …) restart every turn, so they'd
    // collide in the durable event log — mint OMA ids and pair tool_use /
    // tool_result through this per-turn map instead.
    const omaIdByItem = new Map<string, string>();
    const omaIdFor = (item: ThreadItem): string => {
      let id = omaIdByItem.get(item.id);
      if (!id) {
        id = generateId();
        omaIdByItem.set(item.id, id);
      }
      return id;
    };
    const toolUseStarted = new Set<string>();
    const broadcastToolUse = (item: ThreadItem, name: string, input: Record<string, unknown>) => {
      if (toolUseStarted.has(item.id)) return;
      toolUseStarted.add(item.id);
      runtime.broadcast({
        type: "agent.tool_use",
        id: omaIdFor(item),
        name,
        input,
      } as SessionEvent);
    };
    const broadcastToolResult = (item: ThreadItem, content: string) => {
      runtime.broadcast({
        type: "agent.tool_result",
        tool_use_id: omaIdFor(item),
        content,
      } as SessionEvent);
    };

    const handleItem = (event: "started" | "updated" | "completed", item: ThreadItem) => {
      switch (item.type) {
        case "agent_message":
          // No token-level deltas from codex exec — the full text arrives on
          // item.completed, so the message lands as one block.
          if (event === "completed" && item.text.trim()) {
            runtime.broadcast({
              type: "agent.message",
              id: omaIdFor(item),
              content: [{ type: "text", text: item.text }],
            } as SessionEvent);
          }
          break;
        case "reasoning":
          if (event === "completed" && item.text.trim()) {
            runtime.broadcast({
              type: "agent.thinking",
              id: omaIdFor(item),
              text: item.text,
            } as SessionEvent);
          }
          break;
        case "command_execution":
          broadcastToolUse(item, "shell", { command: item.command });
          if (event === "completed") {
            const exit = item.exit_code !== undefined ? item.exit_code : "unknown";
            broadcastToolResult(
              item,
              (item.aggregated_output || "(no output)") +
                (item.status === "failed" || (typeof exit === "number" && exit !== 0)
                  ? `\n[exit code ${exit}]`
                  : ""),
            );
          }
          break;
        case "mcp_tool_call":
          broadcastToolUse(item, `mcp__${item.server}__${item.tool}`, {
            arguments: item.arguments ?? {},
          });
          if (event === "completed") broadcastToolResult(item, textOfMcpResult(item));
          break;
        case "file_change":
          if (event === "completed") {
            broadcastToolUse(item, "apply_patch", { changes: item.changes });
            broadcastToolResult(
              item,
              `${item.status}: ${item.changes.map((c) => `${c.kind} ${c.path}`).join(", ")}`,
            );
          }
          break;
        case "web_search":
          if (event === "completed") {
            broadcastToolUse(item, "web_search", { query: item.query });
            broadcastToolResult(item, "search completed");
          }
          break;
        case "error":
          runtime.broadcast({
            type: "session.warning",
            source: "codex",
            message: item.message,
          } as SessionEvent);
          break;
        case "todo_list":
          break; // internal plan bookkeeping — not part of the OMA transcript
      }
    };

    try {
      const { events } = await thread.runStreamed(textOfUserMessage(ctx), {
        signal: runtime.abortSignal,
      });
      for await (const event of events) {
        switch (event.type) {
          case "thread.started":
            codexThreads.set(sessionId, event.thread_id);
            break;
          case "item.started":
            handleItem("started", event.item);
            break;
          case "item.updated":
            handleItem("updated", event.item);
            break;
          case "item.completed":
            handleItem("completed", event.item);
            break;
          case "turn.failed":
            throw new Error(`codex-sdk turn failed: ${event.error.message}`);
          case "error":
            throw new Error(`codex-sdk stream error: ${event.message}`);
          case "turn.started":
          case "turn.completed":
            break;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      runtime.broadcast({ type: "session.error", error: message } as SessionEvent);
      throw err;
    }

    // Turn finished cleanly (the catch above re-throws) — sync any memory
    // edits back to their stores. Best-effort: a write-back failure must not
    // fail the turn the agent already completed.
    if (this.#deps.memory && ctx.tenant_id) {
      await writeBackMemory(this.#deps.memory, ctx.tenant_id, sessionId, cwd, materializedMemory)
        .then(({ saved, conflicts }) => {
          if (saved > 0 || conflicts.length > 0) {
            runtime.broadcast?.({
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
