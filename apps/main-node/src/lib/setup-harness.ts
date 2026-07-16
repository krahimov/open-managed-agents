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
//
// Extracted 2026-07-16: previously all of this lived inside the SDK harness,
// which made the console setup panel cosmetic on deployments where that
// harness is disabled (hosted/prod) — the setup agent could chat but had no
// tool to apply changes.

import { tool } from "ai";
import { z } from "zod";
import {
  OMA_SETUP_HARNESS,
  OMA_SETUP_KIND_HARNESS_UPDATED,
} from "@open-managed-agents/api-types";
import type { AgentConfig } from "@open-managed-agents/shared";
import { generateEventId } from "@open-managed-agents/shared";
import type { SessionEvent } from "@open-managed-agents/shared";

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
  return view;
}

/** Setup-mode preamble. Replaces the agent's own system prompt entirely so it
 *  acts as a config designer refining ITS OWN harness, not a working agent.
 *  The current harness is embedded so the agent can "scan its own harness"
 *  and clarify what the user wants. */
export function buildSetupPrompt(agent: AgentConfig): string {
  return [
    "You are an OMA agent that was just created and is now in SETUP MODE — a planning conversation to dial in your own configuration (your \"harness\") before you start doing real work.",
    "",
    "Below is your CURRENT harness. Read it, then interview the user to clarify what they actually want you to do, and refine your own harness to match.",
    "",
    "```json",
    JSON.stringify(harnessView(agent), null, 2),
    "```",
    "",
    "You have exactly two tools and no file, shell, or web access:",
    "- update_harness: change fields on your own harness. Call it after EACH meaningful answer so the live config on the user's screen stays in sync. Pass only the fields that changed.",
    "- request_access: pop a one-click connect card in the user's setup panel for a service that needs credentials. Pass the service slug (for an MCP server you added, use its exact `name`) and a one-line reason. The user authenticates in the popup and you get a message when the account is connected.",
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
    "5. When the user is satisfied, confirm your harness is set and that you're ready to run.",
    "",
    "Never invent credentials or secrets, and never ask the user to paste keys or tokens in chat. For an MCP server that needs auth, add the server with update_harness, then call request_access for it (one call per server) so the user can authenticate right here — don't defer it to \"afterward\".",
  ].join("\n");
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
}

/**
 * The DefaultHarness tool dict for a setup session: update_harness +
 * request_access, nothing else — setup has no file/shell/web access by
 * design. Handlers mirror the SDK harness's in-process MCP versions: the
 * harness update is applied to the real agent row and broadcast as an
 * `agent.message` tagged with the oma_setup metadata the console's diff
 * card renderer already understands.
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
        return `Updated: ${changed.join(", ")}.`;
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
  };
}
