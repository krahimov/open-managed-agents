// Setup-mode harness pieces shared by BOTH harnesses.
//
// A setup session (created with `metadata.oma_setup: true` by the console's
// post-create flow) is a planning conversation where the agent refines its
// own configuration. The pieces here are harness-agnostic:
//   - harnessView / buildSetupPrompt: the config slice + system prompt
//   - buildSetupTools: the update_harness + request_access tool dict for the
//     DefaultHarness path (the claude-agent-sdk harness wraps the same
//     handlers in an in-process MCP server instead — see
//     claude-agent-sdk-harness.ts #setupServer)
//   - runEnableMemory: the enable_memory handler all three harnesses share
//
// Extracted 2026-07-16: previously all of this lived inside the SDK harness,
// which made the console setup panel cosmetic on deployments where that
// harness is disabled (hosted/prod) — the setup agent could chat but had no
// tool to apply changes.

import { tool } from "ai";
import { z } from "zod";
import { buildDefaultWebSearchTool } from "@open-managed-agents/agent/harness/tools";
import {
  OMA_SETUP_HARNESS,
  OMA_SETUP_KIND_HARNESS_UPDATED,
} from "@open-managed-agents/api-types";
import type { AgentConfig } from "@open-managed-agents/shared";
import { generateEventId } from "@open-managed-agents/shared";
import type { SessionEvent } from "@open-managed-agents/shared";
import {
  agentMemoryMode,
  describeMemoryEnabled,
  type EnableMemoryResult,
} from "./agent-memory-mode.js";

/** The user-meaningful slice of an AgentConfig (drops internal bookkeeping like
 *  id/version/created_at). Shared by the setup preamble and the broadcast. */
export function harnessView(agent: AgentConfig): Record<string, unknown> {
  const view: Record<string, unknown> = {};
  const model = typeof agent.model === "string" ? agent.model : agent.model?.id;
  if (agent.name) view.name = agent.name;
  if (agent.description) view.description = agent.description;
  if (model) view.model = model;
  if (agent.system) view.system = agent.system;
  if (agent.mcp_servers?.length) view.mcp_servers = agent.mcp_servers;
  if (agent.tools?.length) view.tools = agent.tools;
  if (agent.skills?.length) view.skills = agent.skills;
  // Shown only when on, so the harness pane stays as it was for agents
  // without memory.
  if (agentMemoryMode(agent) !== "off") view.memory = agent.memory;
  return view;
}

/** The MEMORY STATUS line of the setup preamble — the setup agent may only
 *  claim memory works when this (or a tool result) says it is on. */
export function describeSetupMemoryStatus(agent: AgentConfig): string {
  const mode = agentMemoryMode(agent);
  if (mode === "per_user") return "ON (per-user: each user gets their own memory store).";
  if (mode === "shared") return "ON — your memory store is attached to every new working session, including scheduled runs.";
  return agent.memory?.mode === "off"
    ? "OFF — the user turned memory off. Every session of you starts blank. Do not turn it back on unless the user asks you to remember."
    : "OFF — not enabled yet. Every session of you starts blank until you call enable_memory.";
}

export const ENABLE_MEMORY_TOOL_DESCRIPTION =
  "Turn on persistent memory for THIS agent: creates your own memory store (once) and attaches it to every new working session, including scheduled runs, where it is mounted as a directory you read and write with normal file tools. Call it when the user wants you to remember anything across sessions, track what changed since last time, or run on a schedule. Safe to call again — it reports the current state. The result states exactly what is enabled; only tell the user memory is on after this tool says so.";

/** Setup-mode preamble. Replaces the agent's own system prompt entirely so it
 *  acts as a config designer refining ITS OWN harness, not a working agent.
 *  The current harness is embedded so the agent can "scan its own harness"
 *  and clarify what the user wants. */
export function buildSetupPrompt(
  agent: AgentConfig,
  opts: { accessStatus?: string } = {},
): string {
  return [
    "You are an OMA agent in SETUP MODE — a planning conversation to dial in (or revise) your own configuration (your \"harness\") before you do real work.",
    "",
    "Below is your CURRENT harness. Read it, then interview the user to clarify what they actually want you to do, and refine your own harness to match.",
    "The user may have edited your harness outside this chat and come back to this setup conversation later. This JSON is always the live config: when it differs from what earlier messages in this chat say, trust the JSON and never re-apply older values over it.",
    "",
    "```json",
    JSON.stringify(harnessView(agent), null, 2),
    "```",
    "",
    "In THIS setup conversation you have only the setup tools below, and no file or shell access:",
    "- update_harness: change fields on your own harness. Call it after EACH meaningful answer so the live config on the user's screen stays in sync. Pass only the fields that changed.",
    "- request_access: pop a one-click connect card in the user's setup panel for a service that needs credentials. Pass the service slug and a one-line reason. The user authenticates in the popup and you get a message when the account is connected. NOTE: for MCP servers you add with update_harness this happens AUTOMATICALLY — the platform posts a connect card for every newly added server that isn't connected yet (the update_harness result tells you which). Use request_access only for services that aren't MCP servers (e.g. Composio apps) or to re-post a card the user asked for.",
    "- web_search: search the web. Use it to find a service's official MCP endpoint or docs instead of asking the user for URLs — e.g. search \"<service> MCP server\" and prefer the vendor's own domain.",
    "- web_fetch: fetch a URL as text. Use it to read MCP docs pages and extract the exact server URL before adding it with update_harness.",
    "- create_ambient_rule: make yourself run on a schedule (a fresh session of you starts on the cron with the prompt you give it). This is THE way to set up recurring/monitoring work — there is no toggle for it in the setup UI, so never tell the user to \"enable ambient execution in the UI\"; agree on the cadence and create the rule yourself. The rule shows up as a card in the setup panel and on the agent page. Creating a rule also switches your memory on (unless the user turned it off) — the result says which.",
    "- enable_memory: turn on your persistent memory (your own memory store, attached to every new working session). The result says exactly what is now enabled.",
    "",
    "SETUP MODE IS NOT HOW YOU WORK. The tools above exist only in this conversation. In a working session (a chat with the user, or a scheduled run) you get your full working toolset instead: a sandbox with file tools (read, write, edit, search) and a shell, web search and fetch, every MCP server on your harness, and — when memory is on — your memory store mounted as a directory (a `tools` list in the harness above can narrow this; nothing else does). So:",
    "- Never write this conversation's limits into your system prompt. \"I cannot save files\", \"I have no shell\", \"storage is not enabled\" are false for the working you. Your system prompt describes the working you.",
    "- Do not tell the user you can't create files, run code or keep notes. If you are unsure whether a capability exists in working sessions, say you'll verify it on the first run rather than denying it.",
    "- A working session's sandbox files are scratch: a NEW session does not see an earlier session's workspace. What must survive goes to memory (to be remembered) or to the session's outputs folder (for the user to download).",
    "",
    `MEMORY STATUS: ${describeSetupMemoryStatus(agent)}`,
    "Memory rules:",
    "- Every session of you starts fresh, and so does each scheduled run. Memory is the only thing that carries over.",
    "- When the user asks you to remember something, to track what changed over time, to compare against \"last time\", to avoid repeating yourself, or to run on a schedule: call enable_memory (create_ambient_rule does it for you), then tell the user memory is on.",
    "- Never suggest external storage (GitHub, Google Drive, Notion, a database, a spreadsheet…) as a substitute for remembering. Those are for work products the user asks to keep there, not for your own continuity.",
    "- Never say or imply that you will remember anything unless memory is ON — per MEMORY STATUS above or a tool result in this conversation. If it is off and stays off, say plainly that each session starts blank.",
    "- Once memory is on, put into your system prompt WHAT to read at the start of a run and WHAT to record at the end (e.g. \"Start by reading your saved notes on what you reported before; finish by saving a dated note listing what you reported\"). Leave out paths and mechanics — working sessions are told where their memory is and what is in it.",
    "",
    "Harness fields you can refine:",
    "- name / description: a short label + one-line summary of what you do.",
    "- model: your model id (keep the current one unless the task clearly needs a stronger model).",
    "- system: your system prompt — the heart of the harness. Write it in the second person, concrete and task-specific.",
    "- mcp_servers: external tool servers, e.g. [{ \"name\": \"notion\", \"type\": \"url\", \"url\": \"https://mcp.notion.com/mcp\" }].",
    "- skills: optional named skills.",
    "",
    "How to run setup:",
    "1. Open by briefly reflecting your current purpose, then ask what the user wants you to do (or do differently).",
    "2. Ask ONE focused question at a time. After each answer, immediately call update_harness with what you can refine now — usually a sharper system prompt first, then name/description, then any MCP servers or skills.",
    "3. Keep tightening your system prompt as you learn more.",
    "4. Be concise. In a sentence, say what you just changed (e.g. \"I rewrote my system prompt around daily triage and added the Notion server\").",
    "5. If your job is monitoring, polling, reporting or anything recurring, propose a cadence (e.g. every 15 minutes, every morning at 9:00 in the user's timezone), confirm it, then create the rule with create_ambient_rule before you declare yourself ready. Check its result for the memory line and tell the user whether runs will remember earlier runs.",
    "6. When the user is satisfied, confirm your harness is set and that you're ready to run — but ONLY once every MCP server you added is connected. You receive a \"[access granted] <name>\" message per server; until then, say which connections are still pending in the setup panel instead of claiming you're ready.",
    "",
    "Never invent credentials or secrets, and never ask the user to paste keys or tokens in chat. Adding an MCP server with update_harness automatically posts its connect card in the setup panel; never tell the user authentication will happen \"afterward\" — it happens right here, and you must wait for the grant messages.",
    ...(opts.accessStatus
      ? [
          "",
          "CONNECTION STATUS of the MCP servers already on your harness (checked by the platform when this setup started):",
          opts.accessStatus,
          "Servers marked \"connect card posted\" are waiting on the user in the setup panel — mention that in your first reply, and never claim you're ready to run until you've received an \"[access granted] <name>\" message for each of them.",
        ]
      : []),
  ].join("\n");
}

/** Prompt block for the setup preamble: one line per server. */
export function describeSetupAccessStatus(r: AutoAccessResult): string {
  const lines: string[] = [];
  for (const name of r.connected) lines.push(`- ${name}: connected (existing credential verified, vault attached)`);
  for (const x of r.requested) lines.push(`- ${x.name}: connect card posted — waiting for the user${x.note && /one-time/i.test(x.note) ? " (needs a one-time app setup; the card guides them)" : ""}`);
  for (const name of r.failed) lines.push(`- ${name}: could not post a connect card — call request_access for it`);
  return lines.join("\n");
}

/** Per-session previous harness view, so consecutive update_harness calls
 *  render red/green diffs against the last applied state rather than the
 *  session-start state. In-memory is fine: a lost entry only widens one
 *  diff card after a restart. */
const lastHarnessViews = new Map<string, Record<string, unknown>>();

export type HarnessPatch = Partial<
  Pick<AgentConfig, "name" | "description" | "system" | "mcp_servers" | "skills">
> & { model?: string };

export interface SetupToolsDeps {
  /** Apply a patch to the agent and return the updated row. */
  updateAgent: (patch: HarnessPatch) => Promise<AgentConfig>;
  /** Append + broadcast a session event (sessionRouter.appendEvent). */
  appendEvent: (event: SessionEvent) => Promise<unknown>;
  /** Post a connect card (postAccessRequest). */
  requestAccess: (args: {
    service: string;
    reason: string;
    mcp_server_url?: string;
  }) => Promise<{ request_id: string; status: string; note?: string }>;
  /** Vault id holding an active credential for this MCP server URL, or
   *  null. Lets update_harness skip the card and just attach the vault. */
  findCredentialVault?: (mcpServerUrl: string) => Promise<string | null>;
  /** Attach a vault to the agent's default vaults (idempotent) and make it
   *  the one this agent uses for `mcpServerUrl`. */
  attachVault?: (vaultId: string, mcpServerUrl: string) => Promise<void>;
  /** Tell the user which saved login a server was just given, so the attach
   *  is visible and they can switch account. Best effort. */
  reportSavedLogin?: (login: { service: string; mcpServerUrl: string; vaultId: string }) => Promise<void>;
  /** Create a standing ambient (scheduled) rule on this agent
   *  (createAmbientRuleFromSession). Absent → tool not offered. */
  createAmbientRule?: (args: {
    name: string;
    description?: string;
    cron: string;
    timezone?: string;
    prompt: string;
    wake_mode?: "observe" | "decide" | "act" | "escalate";
  }) => Promise<{ id: string; next_wake_at?: string; memory_note?: string }>;
  /** Turn on the agent's memory (enableAgentMemory + the setup-panel card).
   *  Absent → tool not offered. */
  enableMemory?: () => Promise<EnableMemoryResult>;
  /** Env for the read-only research tools (Tavily upgrade for web_search). */
  env?: { TAVILY_API_KEY?: string };
}

type McpServerLike = { name?: string; type?: string; url?: string };

function normalizeMcpUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return raw.trim().replace(/\/+$/, "").toLowerCase();
  }
}

/** The vault an agent uses for one MCP server when several attached vaults
 *  hold a login for it, from `metadata.mcp_vault_bindings`. Null → unbound. */
export function boundVaultId(metadata: unknown, mcpServerUrl: string): string | null {
  const bindings = (metadata as { mcp_vault_bindings?: unknown } | null | undefined)?.mcp_vault_bindings;
  if (!bindings || typeof bindings !== "object") return null;
  const value = (bindings as Record<string, unknown>)[normalizeMcpUrl(mcpServerUrl)];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** `metadata.mcp_vault_bindings` with `mcpServerUrl` now pointing at `vaultId`. */
export function withVaultBinding(
  metadata: unknown,
  mcpServerUrl: string,
  vaultId: string,
): Record<string, string> {
  const bindings = (metadata as { mcp_vault_bindings?: unknown } | null | undefined)?.mcp_vault_bindings;
  return {
    ...(bindings && typeof bindings === "object" ? (bindings as Record<string, string>) : {}),
    [normalizeMcpUrl(mcpServerUrl)]: vaultId,
  };
}

/** Reorder vault groups so `preferred` ids come first, in that order. Other
 *  groups keep their relative order. */
export function preferVaults<T extends { vault_id: string }>(groups: T[], preferred: string[]): T[] {
  const rank = (id: string) => {
    const i = preferred.indexOf(id);
    return i === -1 ? preferred.length : i;
  };
  return [...groups].sort((a, b) => rank(a.vault_id) - rank(b.vault_id));
}

/** URL-type MCP servers in `after` that were not in `before` (by URL). */
export function newlyAddedMcpServers(
  before: unknown,
  after: unknown,
): Array<{ name: string; url: string }> {
  const list = (v: unknown): McpServerLike[] => (Array.isArray(v) ? (v as McpServerLike[]) : []);
  const seen = new Set(
    list(before)
      .filter((s) => s?.url && s.type !== "stdio")
      .map((s) => normalizeMcpUrl(s.url!)),
  );
  const out: Array<{ name: string; url: string }> = [];
  const emitted = new Set<string>();
  for (const s of list(after)) {
    if (!s?.url || s.type === "stdio") continue;
    const key = normalizeMcpUrl(s.url);
    if (seen.has(key) || emitted.has(key)) continue;
    emitted.add(key);
    out.push({ name: (s.name ?? new URL(s.url).hostname).trim().toLowerCase(), url: s.url });
  }
  return out;
}

export interface AutoAccessResult {
  /** Servers a connect card was posted for. */
  requested: Array<{ name: string; note?: string }>;
  /** Servers already covered by a vault credential (vault attached). */
  connected: string[];
  /** Servers where posting the card itself failed. */
  failed: string[];
}

/**
 * Deterministic companion to update_harness: every NEW url-type MCP server
 * either already has a credential in one of the tenant's vaults (→ attach
 * that vault to the agent) or gets a connect card posted right now. This
 * used to be a prompt instruction the model could — and did — skip
 * (2026-09-02: four servers added, zero cards, agent said "ready to run").
 */
export async function autoRequestAccessForNewServers(
  before: unknown,
  after: unknown,
  deps: Pick<SetupToolsDeps, "requestAccess" | "findCredentialVault" | "attachVault" | "reportSavedLogin">,
): Promise<AutoAccessResult> {
  const result: AutoAccessResult = { requested: [], connected: [], failed: [] };
  for (const server of newlyAddedMcpServers(before, after)) {
    try {
      const vaultId = deps.findCredentialVault ? await deps.findCredentialVault(server.url) : null;
      if (vaultId) {
        await deps.attachVault?.(vaultId, server.url);
        result.connected.push(server.name);
        // The login is attached either way — a lost line must not turn a
        // working connection into a failed one.
        await deps
          .reportSavedLogin?.({ service: server.name, mcpServerUrl: server.url, vaultId })
          .catch(() => {});
        continue;
      }
      const res = await deps.requestAccess({
        service: server.name,
        reason: `Connect ${server.name} so the agent can use the ${server.name} MCP server you just added.`,
        mcp_server_url: server.url,
      });
      result.requested.push({ name: server.name, ...(res.note ? { note: res.note } : {}) });
    } catch {
      result.failed.push(server.name);
    }
  }
  return result;
}

/** One-line summary appended to the update_harness tool result. */
export function describeAutoAccess(r: AutoAccessResult): string {
  const parts: string[] = [];
  if (r.requested.length > 0) {
    parts.push(
      `Connect cards were posted automatically for: ${r.requested.map((x) => x.name).join(", ")} — the user authenticates in the setup panel; you'll receive an "[access granted] <name>" message per server. Do not tell the user you're ready until those arrive.`,
    );
    for (const x of r.requested) {
      if (x.note && /one-time/i.test(x.note)) parts.push(`${x.name}: ${x.note}`);
    }
  }
  if (r.connected.length > 0) {
    parts.push(`Already connected via an existing vault credential (vault attached): ${r.connected.join(", ")}.`);
  }
  if (r.failed.length > 0) {
    parts.push(`Could not post a connect card for: ${r.failed.join(", ")} — call request_access for these.`);
  }
  return parts.join(" ");
}

/** The enable_memory handler body, shared by all three harness bindings.
 *  Never throws: a failure is reported as NOT enabled so the agent can't
 *  go on to claim memory works. */
export async function runEnableMemory(enable: () => Promise<EnableMemoryResult>): Promise<string> {
  try {
    return describeMemoryEnabled(await enable());
  } catch (err) {
    return `Memory was NOT enabled: ${err instanceof Error ? err.message : String(err)}. Do not tell the user memory is on; say it could not be switched on and that they can turn it on from the agent page.`;
  }
}

/**
 * The DefaultHarness tool dict for a setup session: update_harness +
 * request_access + read-only web_search/web_fetch — no file or shell
 * access by design. Handlers mirror the SDK harness's in-process MCP
 * versions: the harness update is applied to the real agent row and
 * broadcast as an `agent.message` tagged with the oma_setup metadata the
 * console's diff card renderer already understands.
 */
export function buildSetupTools(
  agent: AgentConfig,
  sessionId: string,
  deps: SetupToolsDeps,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Record<string, any> {
  return {
    update_harness: tool({
      description:
        "Change fields on your own harness (your agent configuration). Call after each meaningful answer so the live config on the user's screen stays in sync. Pass only the fields you want to change.",
      inputSchema: z.object({
        name: z.string().optional(),
        description: z.string().optional(),
        model: z.string().optional(),
        system: z.string().optional(),
        mcp_servers: z.array(z.any()).optional(),
        skills: z.array(z.any()).optional(),
      }),
      execute: async (args: Record<string, unknown>) => {
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
          const value = args[key];
          if (value !== undefined) {
            (patch as Record<string, unknown>)[key] = value;
            changed.push(key);
          }
        }
        if (changed.length === 0) return "No changes applied.";

        const before = lastHarnessViews.get(sessionId) ?? harnessView(agent);
        const updated = await deps.updateAgent(patch);
        const after = harnessView(updated);
        lastHarnessViews.set(sessionId, after);
        await deps.appendEvent({
          type: "agent.message",
          id: generateEventId(),
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
        if (patch.mcp_servers !== undefined) {
          const auto = await autoRequestAccessForNewServers(before.mcp_servers, after.mcp_servers, deps);
          const line = describeAutoAccess(auto);
          if (line) summary += ` ${line}`;
        }
        return summary;
      },
    }),
    request_access: tool({
      description:
        "Ask the user to connect an external service you need but don't have access to — e.g. Gmail, GitHub, Notion. Posts a connect card to the user's session view; they authenticate with one click and you receive a message when access is granted.",
      inputSchema: z.object({
        service: z.string().describe("Service slug, e.g. \"gmail\", \"notion\" — for an MCP server you added, its exact name"),
        reason: z.string().describe("One-line reason shown on the connect card"),
        mcp_server_url: z
          .string()
          .optional()
          .describe("URL of the MCP server this request is for, when it's one you added via update_harness"),
      }),
      execute: async (args: { service: string; reason: string; mcp_server_url?: string }) => {
        const res = await deps.requestAccess(args);
        return res.note ?? `Request ${res.request_id} posted (${res.status}).`;
      },
    }),
    // Recurring work is configured HERE, by the agent — the setup UI has no
    // ambient toggle (seen live 2026-09-02: agent told the user to "enable
    // ambient execution every 15 minutes in the setup UI"; nothing to click).
    ...(deps.createAmbientRule
      ? {
          create_ambient_rule: tool({
            description:
              "Create a standing ambient rule on THIS agent: on the given cron, the platform starts a FRESH session of you and injects `prompt` as the opening user message. Use it for recurring jobs (monitoring, daily digests, polling). Confirm cadence + task with the user first, then create it and echo the rule back; it appears as a card here and can be managed later on the agent page.",
            inputSchema: z.object({
              name: z.string().min(1).max(120).describe("Short human-readable rule name, e.g. \"Incident sweep every 15 minutes\""),
              description: z.string().max(500).optional().describe("One-line summary shown in the console"),
              cron: z.string().min(9).max(120).describe("5-field cron cadence (e.g. \"*/15 * * * *\" = every 15 minutes)"),
              timezone: z.string().max(64).optional().describe("IANA timezone for the cron (e.g. \"America/Los_Angeles\"). Defaults to UTC."),
              prompt: z.string().min(1).max(4000).describe("Opening user message for each spawned session — the standing task, written to future-you"),
              wake_mode: z
                .enum(["observe", "decide", "act", "escalate"])
                .optional()
                .describe("act = do the task; decide (default) = assess then act if warranted; observe = log only; escalate = flag a human"),
            }),
            execute: async (args: {
              name: string;
              description?: string;
              cron: string;
              timezone?: string;
              prompt: string;
              wake_mode?: "observe" | "decide" | "act" | "escalate";
            }) => {
              try {
                const res = await deps.createAmbientRule!(args);
                return `Ambient rule "${args.name}" created (id ${res.id}, cron "${args.cron}"${args.timezone ? ` ${args.timezone}` : " UTC"}${res.next_wake_at ? `, first run ${res.next_wake_at}` : ""}). Tell the user it's active and where to manage it.${res.memory_note ? ` ${res.memory_note}` : ""}`;
              } catch (err) {
                return `Could not create the ambient rule: ${err instanceof Error ? err.message : String(err)}`;
              }
            },
          }),
        }
      : {}),
    // Memory is switched on HERE, in the handler — the store is created and
    // the mode set before the tool returns. Before this tool existed the
    // setup agent could only talk about remembering (prod 2026-11-10: it
    // suggested GitHub/Drive, then admitted memory was "not enabled").
    ...(deps.enableMemory
      ? {
          enable_memory: tool({
            description: ENABLE_MEMORY_TOOL_DESCRIPTION,
            inputSchema: z.object({}),
            execute: async () => runEnableMemory(deps.enableMemory!),
          }),
        }
      : {}),
    // Read-only research pair. Setup keeps NO file/shell access, but finding
    // a service's official MCP endpoint is core setup work — without search
    // the agent has to ask the user to go hunt for URLs (seen live: it
    // refused "can you use websearch to find the rettel mcp").
    web_search: buildDefaultWebSearchTool(deps.env),
    web_fetch: tool({
      description:
        "Fetch a URL and return its text content (HTML tags stripped, truncated). Use to read MCP/API docs pages and extract exact server URLs.",
      inputSchema: z.object({
        url: z.string().describe("Absolute http(s) URL"),
      }),
      execute: async ({ url }: { url: string }) => {
        try {
          if (!/^https?:\/\//i.test(url)) return "web_fetch: only http(s) URLs are supported";
          const res = await fetch(url, {
            redirect: "follow",
            headers: { "User-Agent": "oma-setup/1.0 (+https://github.com/krahimov/open-managed-agents)" },
            signal: AbortSignal.timeout(20_000),
          });
          if (!res.ok) return `web_fetch: HTTP ${res.status}`;
          const raw = await res.text();
          // Crude readable-text pass — setup only needs to spot URLs and
          // config snippets, not faithful markdown (the full web_fetch with
          // the markdown converter lives in the agent harness).
          const text = raw
            .replace(/<script[\s\S]*?<\/script>/gi, " ")
            .replace(/<style[\s\S]*?<\/style>/gi, " ")
            .replace(/<[^>]+>/g, " ")
            .replace(/&nbsp;/g, " ")
            .replace(/\s+/g, " ")
            .trim();
          return text.slice(0, 20_000) || "web_fetch: page had no readable text";
        } catch (err) {
          return `web_fetch failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),
  };
}
