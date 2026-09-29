import type { useApi } from "../../lib/api";

/**
 * Setup-session plumbing shared by the create flow (AgentFormDialog) and the
 * agent page's "Setup chat" button. A setup session is a normal session
 * flagged `metadata.oma_setup: true`; the server swaps in the config-designer
 * preamble + update_harness toolset and always reads the LIVE agent, so a
 * resumed setup chat sees edits made in the form since it last ran.
 */
type Api = ReturnType<typeof useApi>["api"];

export const SETUP_KICKOFF_NEW =
  "I just created you from a template. Walk me through setting up your harness — ask me what you should do, and refine your config as we go.";

export const SETUP_KICKOFF_REVISIT =
  "I'd like to revise your setup. Look at your current harness, briefly summarize what you're set up to do, and ask me what I want to change.";

export function setupPath(agentId: string, sessionId: string): string {
  return `/agents/${agentId}/setup?session=${encodeURIComponent(sessionId)}`;
}

/** Create a setup session for the agent and send the opening message so the
 *  agent speaks first. Returns the new session id. */
export async function startSetupSession(
  api: Api,
  agentId: string,
  opts: { environmentId?: string; kickoff: string },
): Promise<string> {
  const environmentId =
    opts.environmentId ||
    (await api<{ data?: Array<{ id: string }> }>("/v1/environments?limit=1")).data?.[0]?.id;
  const session = await api<{ id: string }>("/v1/sessions", {
    method: "POST",
    body: JSON.stringify({
      agent: agentId,
      ...(environmentId ? { environment_id: environmentId } : {}),
      metadata: { oma_setup: true },
    }),
  });
  await api(`/v1/sessions/${session.id}/events`, {
    method: "POST",
    body: JSON.stringify({
      events: [{ type: "user.message", content: [{ type: "text", text: opts.kickoff }] }],
    }),
  });
  return session.id;
}

/** Reopen the agent's existing setup conversation, or start a new one (with a
 *  "revise" opener) when it has none — e.g. agents created via API/CLI or
 *  whose setup session was terminated. */
export async function openSetupSession(
  api: Api,
  agentId: string,
  opts: { environmentId?: string } = {},
): Promise<string> {
  const existing = await api<{ data: { id: string } | null }>(
    `/v1/agents/${agentId}/setup_session`,
  );
  if (existing.data?.id) return existing.data.id;
  return startSetupSession(api, agentId, {
    environmentId: opts.environmentId,
    kickoff: SETUP_KICKOFF_REVISIT,
  });
}
