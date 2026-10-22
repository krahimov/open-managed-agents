// Composio connect-card completion ("graft"): after the user authorizes a
// toolkit in the Composio popup, attach the connection to the session's
// AGENT — a tool-router credential in the vault that binds the toolkit's
// ACTIVE connected account, the composio mcp_server on the agent, and the
// vault in its default vaults. Without it the account sits in Composio and
// the agent never sees its tools (observed live: LinkedIn OAuth succeeded,
// every session had zero LinkedIn actions).
//
// Extracted from index.ts 2026-10-22 with three fixes for "No active
// <toolkit> account" after a successful authorization:
//   - the toolkit slug is normalized exactly like the link route does
//     ("google-drive" → "googledrive"), or the new account never matched;
//   - the account is looked up with the same Composio key and user id the
//     link route used to create it (see composioKeyFor / composioUserIdFor);
//   - a just-authorized account can still be INITIATED for a moment, so the
//     lookup waits briefly instead of failing on the first read.

import {
  createComposioToolRouterSession,
  listComposioConnectedAccounts,
  normalizeComposioToolkitSlug,
} from "@open-managed-agents/http-routes";

export const COMPOSIO_TOOL_ROUTER_URL = "https://app.composio.dev/tool_router/v3/session/mcp";

type Cred = {
  id: string;
  display_name: string;
  archived_at?: string | null;
  auth?: Record<string, unknown>;
};

export interface ComposioKey {
  apiKey: string;
  source: "tenant" | "platform" | "vault";
}

export interface ComposioGraftDeps {
  /** Same order as the vault link route: tenant key → platform key → a key
   *  stored in this vault. */
  resolveKey: (tenantId: string, vaultId: string) => Promise<ComposioKey | null>;
  credentials: {
    list: (o: { tenantId: string; vaultId: string }) => Promise<Cred[]>;
    create: (o: { tenantId: string; vaultId: string; displayName: string; auth: never }) => Promise<unknown>;
    archive: (o: { tenantId: string; vaultId: string; credentialId: string }) => Promise<unknown>;
  };
  sessions: { get: (o: { tenantId: string; sessionId: string }) => Promise<{ agent_id?: string | null } | null> };
  agents: {
    get: (o: { tenantId: string; agentId: string }) => Promise<{
      id: string;
      name: string;
      metadata?: unknown;
      mcp_servers?: Array<{ name?: string; type?: string; url?: string }>;
    } | null>;
    update: (o: { tenantId: string; agentId: string; input: Record<string, unknown> }) => Promise<unknown>;
  };
  /** Injectable Composio API calls (tests). */
  composio?: {
    listConnectedAccounts: typeof listComposioConnectedAccounts;
    createToolRouterSession: typeof createComposioToolRouterSession;
  };
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for a just-authorized account to turn ACTIVE. */
  activeWaitMs?: number;
}

export type GraftResult =
  | { ok: true; attached_server: boolean; credential_created: true; toolkits: string[]; connected_accounts: Record<string, string> }
  | { ok: false; status: 400 | 404 | 409 | 503; error: string };

/** The active composio_mcp credential in a vault, if any. */
export function activeComposioCredential(creds: Cred[]): Cred | undefined {
  return creds.find((cr) => !cr.archived_at && cr.auth?.type === "composio_mcp");
}

/** The Composio user id a vault's connections live under: the one its
 *  tool-router credential already uses, else the vault default. The link
 *  route and the graft MUST agree, or the account is created under one user
 *  and looked for under another. */
export function composioUserIdFor(tenantId: string, vaultId: string, creds: Cred[]): string {
  const existing = activeComposioCredential(creds)?.auth?.composio_user_id;
  return typeof existing === "string" && existing ? existing : `oma:${tenantId}:${vaultId}`;
}

export async function graftComposioToolkit(
  deps: ComposioGraftDeps,
  input: { tenantId: string; sessionId: string; toolkit: string; vaultId: string; connectedAccountId?: string },
): Promise<GraftResult> {
  const { tenantId, sessionId, vaultId } = input;
  const toolkit = normalizeComposioToolkitSlug(input.toolkit ?? "");
  if (!toolkit || !vaultId) return { ok: false, status: 400, error: "toolkit and vault_id are required" };
  const session = await deps.sessions.get({ tenantId, sessionId });
  if (!session?.agent_id) return { ok: false, status: 404, error: "Session has no agent" };
  const agent = await deps.agents.get({ tenantId, agentId: session.agent_id });
  if (!agent) return { ok: false, status: 404, error: "Agent not found" };

  const key = await deps.resolveKey(tenantId, vaultId).catch(() => null);
  if (!key) return { ok: false, status: 503, error: "No Composio API key configured for this workspace" };
  const api = deps.composio ?? {
    listConnectedAccounts: listComposioConnectedAccounts,
    createToolRouterSession: createComposioToolRouterSession,
  };
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  const metadata = { ...((agent.metadata as Record<string, unknown> | null) ?? {}) };
  const priorToolkits = Array.isArray(metadata.composio_toolkits)
    ? metadata.composio_toolkits.filter((t): t is string => typeof t === "string")
    : [];
  const creds = await deps.credentials.list({ tenantId, vaultId });
  const active = activeComposioCredential(creds);
  const activeToolkits = Array.isArray(active?.auth?.composio_toolkits)
    ? (active!.auth!.composio_toolkits as unknown[]).filter((t): t is string => typeof t === "string")
    : [];
  const composioUserId = composioUserIdFor(tenantId, vaultId, creds);
  const allToolkits = [
    ...new Set([...activeToolkits, ...priorToolkits, toolkit].map(normalizeComposioToolkitSlug).filter(Boolean)),
  ];

  // Re-provision after every grant: a router session created before the
  // OAuth completed treats the toolkit as unconnected forever.
  const findAccounts = async () => {
    const list = await api
      .listConnectedAccounts({ apiKey: key.apiKey }, { userId: composioUserId })
      .catch(() => ({ items: [] as unknown[] }));
    const out: Record<string, string> = {};
    const items = list.items as Array<{ id: string; status?: string; toolkit?: { slug?: string } }>;
    // The account this popup just created wins for its toolkit; otherwise
    // newest-first, the first ACTIVE account per toolkit.
    const ordered = input.connectedAccountId
      ? [...items.filter((a) => a.id === input.connectedAccountId), ...items.filter((a) => a.id !== input.connectedAccountId)]
      : items;
    for (const acct of ordered) {
      const slug = normalizeComposioToolkitSlug(acct.toolkit?.slug ?? "");
      if (slug && acct.status === "ACTIVE" && allToolkits.includes(slug) && !out[slug]) out[slug] = acct.id;
    }
    return out;
  };
  let connectedAccounts = await findAccounts();
  const deadline = Date.now() + (deps.activeWaitMs ?? 12_000);
  while (!connectedAccounts[toolkit] && Date.now() < deadline) {
    await sleep(1_500);
    connectedAccounts = await findAccounts();
  }
  if (!connectedAccounts[toolkit]) {
    return {
      ok: false,
      status: 409,
      error: `Composio doesn't show an active ${input.toolkit} connection yet. Finish signing in in the popup, then press Retry.`,
    };
  }

  const routerSession = await api.createToolRouterSession(
    { apiKey: key.apiKey },
    { user_id: composioUserId, toolkits: { enable: allToolkits }, connected_accounts: connectedAccounts },
  );
  await deps.credentials.create({
    tenantId,
    vaultId,
    displayName: active?.display_name ?? `Composio Tool Router (${agent.name})`,
    auth: {
      type: "composio_mcp",
      mcp_server_url: routerSession.mcp.url,
      // Env pointer for the platform key; the raw key otherwise.
      ...(key.source === "platform" ? { api_key_env: "COMPOSIO_API_KEY" } : { api_key: key.apiKey }),
      composio_user_id: composioUserId,
      composio_session_id: routerSession.session_id,
      composio_toolkits: allToolkits,
      composio_connected_account_ids: Object.values(connectedAccounts),
    } as never,
  });
  if (active) await deps.credentials.archive({ tenantId, vaultId, credentialId: active.id }).catch(() => {});

  const servers = [...(agent.mcp_servers ?? [])];
  const hasComposio = servers.some((s) => typeof s?.url === "string" && s.url.includes("composio.dev/tool_router"));
  if (!hasComposio) servers.push({ name: "composio", type: "url", url: COMPOSIO_TOOL_ROUTER_URL });
  const vaultIds = Array.isArray(metadata.default_vault_ids)
    ? metadata.default_vault_ids.filter((v): v is string => typeof v === "string")
    : [];
  metadata.default_vault_ids = [...new Set([...vaultIds, vaultId])];
  metadata.composio_toolkits = allToolkits;
  await deps.agents.update({ tenantId, agentId: agent.id, input: { mcp_servers: servers, metadata } });
  return {
    ok: true,
    attached_server: !hasComposio,
    credential_created: true,
    toolkits: allToolkits,
    connected_accounts: connectedAccounts,
  };
}
