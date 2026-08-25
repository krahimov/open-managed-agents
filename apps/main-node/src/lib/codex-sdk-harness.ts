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
 * Platform tools (request_access, create_ambient_rule, find_skill,
 * request_skill, schedule/cancel_schedule/list_schedules) and the setup
 * session's update_harness are served over a per-turn loopback streamable-
 * HTTP MCP bridge (mcp-http-bridge.ts) — the Codex SDK has no in-process
 * MCP transport, so the child calls back over 127.0.0.1 with a per-turn
 * bearer token and the handlers run in this process.
 *
 * Remaining gap vs the claude-agent-sdk harness (fail-closed, not silent):
 * no per-tool permission callback, so pinned access policies can't be
 * enforced → sessions with a policy are rejected rather than run open.
 * System prompt rides in <cwd>/AGENTS.md (the Codex project-doc channel);
 * attached skills are materialized under <cwd>/skills/ and referenced there.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Codex } from "@openai/codex-sdk";
import type {
  CodexOptions,
  ModelReasoningEffort,
  ThreadEvent,
  ThreadItem,
  ThreadOptions,
} from "@openai/codex-sdk";
import { z } from "zod";
import type { HarnessContext } from "@open-managed-agents/agent/harness/interface";
import {
  OMA_SETUP_HARNESS,
  OMA_SETUP_KIND_HARNESS_UPDATED,
  type ReasoningLevel,
  type SessionEvent,
} from "@open-managed-agents/api-types";
import type { AgentConfig } from "@open-managed-agents/shared";
import { generateId } from "@open-managed-agents/shared";
import type { HarnessPatch, McpTarget } from "./claude-agent-sdk-harness.js";
import { startMcpHttpBridge, type BridgeTool, type McpHttpBridge } from "./mcp-http-bridge.js";
import { buildSetupPrompt, harnessView } from "./setup-harness.js";
import {
  materializeMemory,
  writeBackMemory,
  type MaterializedMemory,
  type SdkMemoryPort,
} from "./sdk-harness-memory.js";

/** OMA session id → Codex thread id, for resume continuity across turns. */
const codexThreads = new Map<string, string>();

/** OMA session id → last harness view broadcast from THAT session's
 *  update_harness calls (setup sessions). Same rationale as the
 *  claude-agent-sdk harness's map: ctx.agent is the frozen session snapshot,
 *  so after the first edit this keeps the true "before" for diff rendering. */
const lastHarnessViews = new Map<string, Record<string, unknown>>();

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
  /** Used to detect setup sessions (metadata.oma_setup). */
  readSessionMetadata?: (
    tenantId: string,
    sessionId: string,
  ) => Promise<Record<string, unknown> | null>;
  /** Apply a setup session's refined harness to its agent (enables setup
   *  sessions on this harness via the oma_setup bridge tool). */
  updateAgent?: (
    tenantId: string,
    agentId: string,
    patch: HarnessPatch,
  ) => Promise<AgentConfig>;
  /** Agent-initiated credential request (`request_access` bridge tool) —
   *  same event pipeline as the DefaultHarness / claude-agent-sdk hooks. */
  requestServiceAccess?: (
    tenantId: string,
    sessionId: string,
    args: { service: string; reason: string; mcp_server_url?: string },
  ) => Promise<{ request_id: string; status: string; note?: string }>;
  /** Standing ambient rule on the session's agent (`create_ambient_rule`). */
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
  ) => Promise<{ id: string; next_wake_at?: string }>;
  /** Skill discovery (`find_skill`). */
  findSkills?: (
    tenantId: string,
    query: string,
  ) => Promise<Array<{ name: string; description: string; installed: boolean; source?: string }>>;
  /** Skill acquisition request (`request_skill`). */
  requestSkill?: (
    tenantId: string,
    agentId: string,
    sessionId: string,
    args: { skill_name: string; reason: string },
  ) => Promise<{ request_id: string; status: string; note?: string }>;
  /** Self-scheduling (`schedule` / `cancel_schedule` / `list_schedules`) —
   *  backed by NodeSessionWakeups; the fired wakeup enqueues a synthetic
   *  user message that runs a normal turn on this harness. */
  scheduleWakeup?: (
    tenantId: string,
    sessionId: string,
    agentId: string,
    args: { delay_seconds?: number; at?: string; cron?: string; prompt: string },
  ) => Promise<{ id: string; fire_at?: string; cron?: string; kind: "one_shot" | "cron" }>;
  cancelWakeup?: (sessionId: string, id: string) => Promise<{ cancelled: boolean }>;
  listWakeups?: (
    sessionId: string,
  ) => Promise<Array<{ id: string; fire_at?: string; cron?: string; prompt: string; kind: "one_shot" | "cron" }>>;
  /** Usage analytics tap — called once per turn.completed with the turn's
   *  token buckets (input_tokens = uncached portion). Best-effort. */
  recordUsage?: (
    tenantId: string,
    sessionId: string,
    agentId: string,
    u: {
      model: string;
      costUsd?: number;
      usage: {
        input_tokens: number;
        cached_input_tokens?: number;
        cache_write_input_tokens?: number;
        output_tokens: number;
        reasoning_tokens?: number;
      };
    },
  ) => Promise<void> | void;
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

/** reasoning_level → codex effort, mirroring the DefaultHarness OpenAI
 *  mapping (provider.ts: max → xhigh). Unset = codex default. */
const CODEX_REASONING_EFFORT: Record<ReasoningLevel, ModelReasoningEffort> = {
  instant: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  max: "xhigh",
};

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

  /** Platform + setup tools served to the codex child over the loopback MCP
   *  bridge. Mirrors the claude-agent-sdk harness's in-process oma_setup /
   *  oma_platform servers tool-for-tool, plus the schedule trio. */
  #bridgeToolsFor(
    ctx: HarnessContext,
    runtime: HarnessContext["runtime"],
    sessionId: string,
    isSetup: boolean,
  ): BridgeTool[] {
    const tenantId = ctx.tenant_id ?? "default";
    const agentId = ctx.agent.id;
    const deps = this.#deps;
    const tools: BridgeTool[] = [];

    if (isSetup && deps.updateAgent) {
      tools.push({
        name: "update_harness",
        description:
          "Change fields on your own harness (your agent configuration). Call after each meaningful answer so the live config on the user's screen stays in sync. Pass only the fields you want to change.",
        inputSchema: {
          name: z.string().optional(),
          description: z.string().optional(),
          model: z.string().optional(),
          system: z.string().optional(),
          mcp_servers: z.array(z.any()).optional(),
          skills: z.array(z.any()).optional(),
        },
        handler: async (args) => {
          const patch: HarnessPatch = {};
          const changed: string[] = [];
          for (const key of ["name", "description", "model", "system", "mcp_servers", "skills"] as const) {
            const value = args[key];
            if (value !== undefined) {
              (patch as Record<string, unknown>)[key] = value;
              changed.push(key);
            }
          }
          if (changed.length === 0) return { text: "No changes applied." };
          const before = lastHarnessViews.get(sessionId) ?? harnessView(ctx.agent);
          const updated = await deps.updateAgent!(tenantId, agentId, patch);
          const after = harnessView(updated);
          lastHarnessViews.set(sessionId, after);
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
          return { text: `Updated: ${changed.join(", ")}.` };
        },
      });
    }

    if (deps.requestServiceAccess) {
      tools.push({
        name: "request_access",
        description:
          "Ask the user to connect an external service you need but don't have access to (no connected " +
          "account / credential) — e.g. Gmail, GitHub, Notion, HubSpot. Posts a connect card to the user's " +
          "session view; they authenticate with one click and you receive a message when access is granted. " +
          "Call this the moment a task needs a service you can't reach instead of giving up or asking the " +
          "user to paste secrets in chat. Never ask for API keys or passwords in the conversation.",
        inputSchema: {
          service: z
            .string()
            .describe('Service/toolkit slug, lowercase (e.g. "gmail", "github", "notion", "hubspot")'),
          reason: z
            .string()
            .describe('One line shown to the user: what you need it for (e.g. "to read this week\'s invoices")'),
        },
        handler: async (args) => {
          const a = args as { service?: string; reason?: string };
          if (!a.service?.trim()) return { text: "service is required", isError: true };
          // Requested service that names one of the agent's own URL MCP
          // servers → the card runs vault MCP OAuth against that URL rather
          // than the Composio connected-account flow.
          const slug = a.service.trim().toLowerCase();
          const matched = (ctx.agent.mcp_servers ?? []).find(
            (s) => s?.name?.trim().toLowerCase() === slug && s.type !== "stdio" && !!s.url,
          );
          const result = await deps.requestServiceAccess!(tenantId, sessionId, {
            service: a.service,
            reason: a.reason?.trim() || "The agent needs this service for the current task.",
            ...(matched?.url ? { mcp_server_url: matched.url } : {}),
          });
          return { text: JSON.stringify(result) };
        },
      });
    }

    if (deps.createAmbientRule) {
      tools.push({
        name: "create_ambient_rule",
        description:
          "Create a standing ambient rule on THIS agent: on the given cron, the platform starts a FRESH " +
          "session of this agent and injects `prompt` as the opening user message. Ambient rules outlive " +
          "this conversation — use them when the user asks for a recurring job. Confirm the cadence and " +
          "the task with the user before creating one.",
        inputSchema: {
          name: z.string().describe('Short human-readable rule name, e.g. "Daily PR triage"'),
          description: z.string().optional().describe("One-line summary shown in the console"),
          cron: z.string().describe('5-field cron cadence (e.g. "0 9 * * *" = 9:00 daily)'),
          timezone: z.string().optional().describe('IANA timezone for the cron (e.g. "America/Los_Angeles"). Defaults to UTC.'),
          prompt: z.string().describe("Opening user message for each spawned session — the standing task, written to future-you"),
          wake_mode: z
            .enum(["observe", "decide", "act", "escalate"])
            .optional()
            .describe("act = do the task; decide (default) = assess then act if warranted; observe = log only; escalate = flag a human"),
        },
        handler: async (args) => {
          const a = args as {
            name?: string; description?: string; cron?: string;
            timezone?: string; prompt?: string;
            wake_mode?: "observe" | "decide" | "act" | "escalate";
          };
          if (!a.name?.trim() || !a.cron?.trim() || !a.prompt?.trim()) {
            return { text: "name, cron, and prompt are required", isError: true };
          }
          const result = await deps.createAmbientRule!(tenantId, sessionId, agentId, {
            name: a.name,
            description: a.description,
            cron: a.cron,
            timezone: a.timezone,
            prompt: a.prompt,
            wake_mode: a.wake_mode,
          });
          return { text: JSON.stringify(result) };
        },
      });
    }

    if (deps.findSkills) {
      tools.push({
        name: "find_skill",
        description:
          "Search available skills (installed + curated catalog) by keyword. A skill is a SKILL.md " +
          "playbook that teaches you how to do a class of task well. Use when a task would benefit from " +
          "domain expertise you don't currently have loaded — then call request_skill.",
        inputSchema: {
          query: z.string().describe('Keywords, e.g. "spreadsheet excel" or "pdf"'),
        },
        handler: async (args) => {
          const a = args as { query?: string };
          if (!a.query?.trim()) return { text: "query is required", isError: true };
          const skills = await deps.findSkills!(tenantId, a.query);
          return { text: JSON.stringify({ skills }) };
        },
      });
    }

    if (deps.requestSkill) {
      tools.push({
        name: "request_skill",
        description:
          "Ask the user to attach a skill to you (use find_skill first to discover the right name). " +
          "Posts an attach card to the user's session view; on approval the skill is attached to your " +
          "config. Continue other work or end your turn while you wait.",
        inputSchema: {
          skill_name: z.string().describe('Skill name from find_skill (e.g. "xlsx")'),
          reason: z.string().describe("One line shown to the user: why you need it"),
        },
        handler: async (args) => {
          const a = args as { skill_name?: string; reason?: string };
          if (!a.skill_name?.trim()) return { text: "skill_name is required", isError: true };
          const result = await deps.requestSkill!(tenantId, agentId, sessionId, {
            skill_name: a.skill_name,
            reason: a.reason?.trim() || "The agent needs this skill for the current task.",
          });
          return { text: JSON.stringify(result) };
        },
      });
    }

    if (deps.scheduleWakeup) {
      tools.push({
        name: "schedule",
        description:
          "Schedule a future wake-up of THIS session: at the given time (or on the given cron), the " +
          "platform injects `prompt` as a new user message and you run a normal turn on it. Use for " +
          "self-scheduled follow-ups (\"check the deploy in 10 minutes\", \"poll until the PR is merged\"). " +
          "Pass exactly one of delay_seconds, at, or cron.",
        inputSchema: {
          delay_seconds: z.number().int().min(5).max(604800).optional()
            .describe("Fire once, N seconds from now (5s – 7 days)"),
          at: z.string().optional().describe("Fire once at this ISO-8601 datetime"),
          cron: z.string().optional().describe('Fire repeatedly on this 5-field cron (e.g. "*/15 * * * *")'),
          prompt: z.string().min(1).max(4000)
            .describe("The message future-you receives when the wake-up fires — the task, written to future-you"),
        },
        handler: async (args) => {
          const a = args as { delay_seconds?: number; at?: string; cron?: string; prompt?: string };
          if (!a.prompt?.trim()) return { text: "prompt is required", isError: true };
          const result = await deps.scheduleWakeup!(tenantId, sessionId, agentId, {
            delay_seconds: a.delay_seconds,
            at: a.at,
            cron: a.cron,
            prompt: a.prompt,
          });
          return { text: JSON.stringify(result) };
        },
      });
      if (deps.cancelWakeup) {
        tools.push({
          name: "cancel_schedule",
          description: "Cancel a pending wake-up created with the schedule tool.",
          inputSchema: { id: z.string().describe("Schedule id returned by the schedule tool") },
          handler: async (args) => {
            const a = args as { id?: string };
            if (!a.id?.trim()) return { text: "id is required", isError: true };
            return { text: JSON.stringify(await deps.cancelWakeup!(sessionId, a.id)) };
          },
        });
      }
      if (deps.listWakeups) {
        tools.push({
          name: "list_schedules",
          description: "List this session's pending wake-ups.",
          inputSchema: {},
          handler: async () => ({ text: JSON.stringify({ schedules: await deps.listWakeups!(sessionId) }) }),
        });
      }
    }

    return tools;
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

    // Setup sessions (the agent's first session, refining its own harness)
    // run the focused config-designer conversation. The oma_setup toolset is
    // served over the loopback MCP bridge since the Codex SDK has no
    // in-process transport.
    const sessionMeta = await this.#deps.readSessionMetadata?.(tenantId, sessionId);
    const isSetup = sessionMeta?.["oma_setup"] === true && !!this.#deps.updateAgent;

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
    if (!isSetup && this.#deps.resolveSkills && ctx.tenant_id) {
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
    if (!isSetup && this.#deps.memory && ctx.tenant_id) {
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
    // Observed live: the codex child sees the HOST OPERATOR's personal
    // ~/.codex skills/AGENTS.md and follows them — e.g. an `openma` skill
    // taught an agent to hunt for the `oma` CLI (absent in the workdir)
    // instead of calling its oma_platform MCP tools. Draw the boundary
    // explicitly; skills.enabled=false below trims the catalog too.
    const platformNotes = [
      "Platform notes:",
      "- Anything under ~/.codex (skills, instructions, memories) is the host operator's",
      "  personal setup, NOT part of this platform — ignore it.",
      "- There is no `oma` CLI here. Platform actions (schedules/wake-ups, ambient rules,",
      "  service access, skills) go through your oma_platform MCP tools.",
    ].join("\n");
    const agentsMd = isSetup
      ? buildSetupPrompt(ctx.agent)
      : [ctx.systemPrompt, materializedMemory.guidance, skillsGuidance, platformNotes]
          .filter(Boolean)
          .join("\n\n");
    if (agentsMd) await writeFile(path.join(cwd, "AGENTS.md"), agentsMd, "utf8");

    // Platform tools ride the loopback MCP bridge — handlers run in THIS
    // process (the codex child calls back over HTTP with a per-turn bearer
    // token), so they can append session events, update the agent row, and
    // schedule wakeups exactly like the claude-agent-sdk in-process servers.
    const bridgeTools = this.#bridgeToolsFor(ctx, runtime, sessionId, isSetup);
    const bridge: McpHttpBridge | null =
      bridgeTools.length > 0 ? await startMcpHttpBridge("oma_platform", bridgeTools) : null;

    // Setup: the bridge is the ONLY MCP surface (mirrors strictMcpConfig on
    // the claude harness); working sessions get the agent's servers too.
    // default_tools_approval_mode "approve" (verified against codex 0.149 —
    // "auto" is not accepted): with approvalPolicy "never" any tool codex
    // classifies as approval-needing would otherwise auto-FAIL with
    // "MCP tool call requires approval, but approval policy is never".
    const agentMcpServers = isSetup ? undefined : await this.#mcpConfigFor(ctx, sessionId);
    const mcpServers: Record<
      string,
      { url: string; http_headers: Record<string, string>; default_tools_approval_mode: string }
    > = Object.fromEntries(
      Object.entries({
        ...(agentMcpServers ?? {}),
        ...(bridge ? { oma_platform: { url: bridge.url, http_headers: bridge.headers } } : {}),
      }).map(([name, server]) => [name, { ...server, default_tools_approval_mode: "approve" }]),
    );
    const codexOptions: CodexOptions = {
      env: curatedCodexEnv(),
      // Escape hatch when the vendored @openai/codex platform binary is
      // unavailable (e.g. its optional dependency failed to download).
      ...(process.env.OMA_CODEX_PATH ? { codexPathOverride: process.env.OMA_CODEX_PATH } : {}),
      config: {
        // Keep the host operator's personal ~/.codex skill catalog out of
        // agent sessions (see the platformNotes rationale above). OMA skills
        // are unaffected — they ride <cwd>/skills + AGENTS.md.
        skills: { enabled: false },
        ...(Object.keys(mcpServers).length > 0 ? { mcp_servers: mcpServers } : {}),
      },
    };
    const codex: CodexLike = this.#deps.createCodex
      ? this.#deps.createCodex(codexOptions)
      : new Codex(codexOptions);

    const threadOptions: ThreadOptions = {
      model: codexModelFor(ctx.agent.model),
      ...(ctx.agent.reasoning_level
        ? { modelReasoningEffort: CODEX_REASONING_EFFORT[ctx.agent.reasoning_level] }
        : {}),
      workingDirectory: cwd,
      skipGitRepoCheck: true,
      // Headless: no confirmation round-trip on this path; the child is
      // scoped to a per-session workdir by the CLI's own sandbox. Setup is a
      // pure config conversation — no file/shell writes by design.
      approvalPolicy: "never",
      sandboxMode: isSetup ? "read-only" : sandboxModeFromEnv(),
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
          case "turn.completed": {
            const dep = this.#deps.recordUsage;
            if (dep && event.usage) {
              const us = event.usage;
              void Promise.resolve(
                dep(tenantId, sessionId, ctx.agent.id, {
                  model: threadOptions.model ?? "codex-default",
                  usage: {
                    input_tokens: Math.max(0, us.input_tokens - us.cached_input_tokens),
                    cached_input_tokens: us.cached_input_tokens,
                    cache_write_input_tokens: us.cache_write_input_tokens,
                    output_tokens: us.output_tokens,
                    reasoning_tokens: us.reasoning_output_tokens,
                  },
                }),
              ).catch(() => {});
            }
            break;
          }
          case "turn.started":
            break;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      runtime.broadcast({ type: "session.error", error: message } as SessionEvent);
      throw err;
    } finally {
      if (bridge) await bridge.close();
    }

    // Turn finished cleanly (the catch above re-throws) — sync any memory
    // edits back to their stores. Best-effort: a write-back failure must not
    // fail the turn the agent already completed.
    if (!isSetup && this.#deps.memory && ctx.tenant_id) {
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
