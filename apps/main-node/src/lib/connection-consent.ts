import { createHash } from "node:crypto";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RouteServices } from "@open-managed-agents/http-routes";
import type { CredentialRow } from "@open-managed-agents/credentials-store";
import { serviceDisplayName } from "@open-managed-agents/api-types";
import { refreshNodeMcpOAuthToken } from "./node-mcp-proxy.js";

export function connectionUrl(raw: string): string {
  const url = new URL(raw);
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString();
}

export interface ConnectionBinding {
  vault_id: string;
  credential_id: string;
  mcp_server_url: string;
  account?: string;
  workspace?: string;
  workspace_id?: string;
  approved_at: number;
  /** Account generation of the credential when the user chose it (see
   *  credentialGeneration). A credential later reconnected to another
   *  account no longer matches, so it stops authorizing this agent. */
  generation?: string;
}

/** Stable per-account marker of a credential: changes when its secret is
 *  rewritten (new sign-in, pasted token), not when a token is refreshed. */
export function credentialGeneration(credential: CredentialRow): string {
  return credential.auth.connected_at ?? credential.created_at;
}

export function connectionBindingKey(tenantId: string, agentId: string, url: string): string {
  return `connection_consent:${encodeURIComponent(tenantId)}:${encodeURIComponent(agentId)}:${encodeURIComponent(connectionUrl(url))}`;
}

export interface ConnectionVerification {
  status: "verified" | "unverified";
  account?: string;
  workspace?: string;
  workspace_id?: string;
  message?: string;
}

/** Only protocol discovery and fixed, read-only provider identity queries. */
export async function verifyConnection(credential: CredentialRow): Promise<ConnectionVerification> {
  const auth = credential.auth as unknown as Record<string, string | undefined>;
  // Composio authenticates with x-api-key (inline or from the operator env),
  // the same header the MCP proxy sends; everything else is a bearer token.
  const composioKey = auth.type === "composio_mcp"
    ? auth.api_key || process.env[auth.api_key_env || "COMPOSIO_API_KEY"] || undefined
    : undefined;
  const token = auth.type === "composio_mcp" ? composioKey : auth.access_token || auth.token || auth.bearer_token;
  const url = auth.mcp_server_url;
  if (!token || !url) return { status: "unverified", message: "This credential has no usable token." };
  const authHeaders: Record<string, string> = composioKey ? { "x-api-key": composioKey } : { authorization: `Bearer ${token}` };
  const client = new Client({ name: "orrery-connection-verification", version: "1" });
  const boundedFetch: typeof fetch = (input, init) => fetch(input, {
    ...init, redirect: "error",
    signal: AbortSignal.any([AbortSignal.timeout(8_000), ...(init?.signal ? [init.signal] : [])]),
  });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: authHeaders }, fetch: boundedFetch,
    }), { timeout: 10_000 });
    const toolList = await client.listTools({}, { timeout: 10_000 });
    const host = new URL(url).hostname;
    if (host === "mcp.slack.com") {
      const response = await boundedFetch("https://slack.com/api/auth.test", {
        method: "POST", headers: { authorization: `Bearer ${token}` },
      });
      const identity = await response.json() as Record<string, unknown>;
      if (!response.ok || identity.ok !== true || typeof identity.team_id !== "string" || typeof identity.team !== "string" || typeof identity.user !== "string") {
        return { status: "unverified", message: "Slack account and workspace could not be verified. Reconnect and try again." };
      }
      return { status: "verified", account: identity.user, workspace: identity.team, workspace_id: identity.team_id };
    }
    if (host === "mcp.linear.app") {
      // Linear's MCP OAuth tokens can be scoped to the MCP resource and
      // rejected by the separate GraphQL API. Ask the authenticated MCP
      // server for the current user/workspace; never infer identity from labels.
      if (["get_user", "get_workspace"].every(name => toolList.tools.some(tool => tool.name === name))) {
        const readIdentity = async (name: string, args: Record<string, string>) => {
          const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 10_000 });
          if (result.isError) throw new Error("Identity query failed");
          if (result.structuredContent) return result.structuredContent as Record<string, unknown>;
          for (const content of result.content as Array<{ type: string; text?: string }>) {
            if (content.type === "text" && content.text) {
              try { return JSON.parse(content.text) as Record<string, unknown>; } catch { /* Try the next text block. */ }
            }
          }
          throw new Error("Identity response unavailable");
        };
        const user = await readIdentity("get_user", { query: "me" });
        const workspace = await readIdentity("get_workspace", {});
        const account = user.email || user.name;
        if (typeof account !== "string" || !account || typeof workspace.id !== "string" || !workspace.id || typeof workspace.name !== "string" || !workspace.name.trim()) {
          return { status: "unverified", message: "Linear account and workspace could not be verified. Reconnect and try again." };
        }
        return { status: "verified", account, workspace: workspace.name.trim(), workspace_id: workspace.id };
      }
      const response = await boundedFetch("https://api.linear.app/graphql", {
        method: "POST", headers: { "content-type": "application/json", authorization: token.startsWith("lin_api_") ? token : `Bearer ${token}` },
        body: JSON.stringify({ query: "{ viewer { id name email } organization { id name } }" }),
      });
      const identity = await response.json() as { errors?: unknown; data?: { viewer?: { name?: string; email?: string }; organization?: { id?: string; name?: string } } };
      const org = identity.data?.organization;
      const account = identity.data?.viewer?.email || identity.data?.viewer?.name;
      if (!response.ok || identity.errors || !org?.id || !org.name || !account) {
        return { status: "unverified", message: "Linear account and workspace could not be verified. Reconnect and try again." };
      }
      return { status: "verified", account, workspace: org.name, workspace_id: org.id };
    }
    return { status: "verified", message: "Service access verified. This provider does not expose account/workspace identity here; confirm the selected connection is the one you intend." };
  } catch {
    // Never turn timeouts, HTTP errors or JSON-RPC errors into a grant, and
    // never return provider exception text (it can contain credentials).
    return { status: "unverified", message: "Authentication could not be verified. No access was granted. Reconnect or retry." };
  } finally {
    await client.close().catch(() => {});
  }
}

type AccessRequest = { request_id: string; service: string; mcp_server_url?: string };
interface Deps {
  services: RouteServices;
  readRequest: (sessionId: string, requestId: string) => Promise<AccessRequest | null>;
  verify?: typeof verifyConnection;
  onApproved: (input: { tenantId: string; sessionId: string; requestId: string; service: string; binding: ConnectionBinding }) => Promise<void>;
}

/** Cached identity of one saved credential (no access granted by it). */
export interface ConnectionIdentity {
  status: "verified" | "unverified";
  account?: string;
  workspace?: string;
  workspace_id?: string;
  message?: string;
  checked_at: number;
  /** Opaque marker of the credential generation this identity describes.
   *  "Use" must echo it, so the account bound is the account shown. */
  version: string;
}

export type ConnectResult =
  | { status: "connected"; account?: string; workspace?: string; message?: string }
  | { status: "unverified"; message: string };

/** Identity is cached per credential generation: a reconnect (possibly to
 *  another account) invalidates it, a token refresh doesn't. */
const identityVersion = (credential: CredentialRow) =>
  createHash("sha256")
    .update(JSON.stringify([credential.id, credential.auth.mcp_server_url, credentialGeneration(credential)]))
    .digest("hex")
    .slice(0, 24);
const identityKey = (tenantId: string, credentialId: string) =>
  `connection_identity:${encodeURIComponent(tenantId)}:${encodeURIComponent(credentialId)}`;
const IDENTITY_TTL_SECONDS = 7 * 24 * 60 * 60;

class ConnectError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) {
    super(message);
  }
}

/**
 * Which saved account an agent may use, per MCP server. Bindings live in
 * server-owned KV (not model-editable agent metadata): one credential for one
 * agent and one server URL. The proxy reads them on every call.
 *
 * A binding is created only by an explicit user action on the connect card:
 * clicking "Use" on a saved account (whose account/workspace the card shows),
 * or completing a new sign-in started from that card. Either way the
 * connection is verified (MCP handshake + provider identity) first, and an
 * unverifiable connection is never bound.
 */
export class ConnectionConsent {
  constructor(private deps: Deps) {}

  async hasApproval(tenantId: string, agentId: string, url: string): Promise<boolean> {
    return !!await this.deps.services.kv.get(connectionBindingKey(tenantId, agentId, url));
  }

  async binding(tenantId: string, agentId: string, url: string): Promise<ConnectionBinding | null> {
    const raw = await this.deps.services.kv.get(connectionBindingKey(tenantId, agentId, url));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ConnectionBinding;
    } catch {
      return null;
    }
  }

  async authorizedCredential(tenantId: string, agentId: string, url: string): Promise<CredentialRow | null> {
    const binding = await this.binding(tenantId, agentId, url);
    if (!binding) return null;
    const vault = await this.deps.services.vaults.get({ tenantId, vaultId: binding.vault_id });
    if (!vault || vault.archived_at) return null;
    const credential = await this.deps.services.credentials.get({ tenantId, vaultId: binding.vault_id, credentialId: binding.credential_id });
    if (!credential || credential.archived_at || !credential.auth.mcp_server_url || connectionUrl(credential.auth.mcp_server_url) !== connectionUrl(url)) return null;
    if (binding.generation === undefined) {
      // Bindings made before generations existed. A credential reconnected
      // after the user approved it may be someone else now: refuse, the user
      // picks again. Otherwise pin the current generation, so from now on a
      // reconnect to another account cuts access.
      const reconnectedAt = credential.auth.connected_at ? Date.parse(credential.auth.connected_at) : NaN;
      if (Number.isFinite(reconnectedAt) && reconnectedAt >= binding.approved_at) return null;
      await this.deps.services.kv.put(
        connectionBindingKey(tenantId, agentId, url),
        JSON.stringify({ ...binding, generation: credentialGeneration(credential) }),
      ).catch(() => {});
      return credential;
    }
    // Reconnected since the user chose it — maybe as someone else. The user
    // has to pick it again; never fall through to the new account.
    if (binding.generation !== credentialGeneration(credential)) return null;
    return credential;
  }

  /** Session + request + agent for a card, or a ConnectError. */
  private async context(tenantId: string, sessionId: string, requestId: string) {
    const session = await this.deps.services.sessions.get({ tenantId, sessionId });
    if (!session || session.archived_at || !session.agent_id) throw new ConnectError(404, "Session not found");
    const request = await this.deps.readRequest(sessionId, requestId);
    if (!request?.mcp_server_url) throw new ConnectError(404, "Connection request not found");
    const agent = await this.deps.services.agents.get({ tenantId, agentId: session.agent_id });
    if (!agent || !agent.mcp_servers?.some(s => s.type !== "stdio" && s.url && connectionUrl(s.url) === connectionUrl(request.mcp_server_url!))) {
      throw new ConnectError(409, `${serviceDisplayName(request.service, request.mcp_server_url)} is no longer configured on this agent`);
    }
    return { session, request, agentId: session.agent_id, url: request.mcp_server_url };
  }

  /** A credential of this tenant for exactly this server, or a ConnectError. */
  private async candidate(tenantId: string, url: string, vaultId: string, credentialId: string) {
    if (typeof vaultId !== "string" || typeof credentialId !== "string") throw new ConnectError(400, "Pick a connection first");
    const vault = await this.deps.services.vaults.get({ tenantId, vaultId });
    const credential = await this.deps.services.credentials.get({ tenantId, vaultId, credentialId });
    if (!vault || vault.archived_at || !credential || credential.archived_at || !credential.auth.mcp_server_url || connectionUrl(credential.auth.mcp_server_url) !== connectionUrl(url)) {
      throw new ConnectError(404, "That connection no longer exists");
    }
    return credential;
  }

  /** Refresh an OAuth token that is expired or about to be, so verification
   *  doesn't report a perfectly good (refreshable) account as broken. */
  private async fresh(tenantId: string, vaultId: string, credential: CredentialRow): Promise<CredentialRow> {
    const auth = credential.auth;
    if (auth.type !== "mcp_oauth" || !auth.refresh_token || !auth.token_endpoint || !auth.expires_at || Date.parse(auth.expires_at) > Date.now() + 60_000) {
      return credential;
    }
    const refreshed = await refreshNodeMcpOAuthToken(
      { refreshToken: auth.refresh_token, tokenEndpoint: auth.token_endpoint, clientId: auth.client_id, clientSecret: auth.client_secret },
      (input, init) => fetch(input, { ...init, redirect: "error", signal: AbortSignal.timeout(8_000) }),
    ).catch(() => null);
    if (!refreshed) return credential;
    await this.deps.services.credentials.refreshAuth({
      tenantId, vaultId, credentialId: credential.id,
      auth: {
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token,
        expires_at: refreshed.expires_in ? new Date(Date.now() + refreshed.expires_in * 1000).toISOString() : undefined,
      },
    });
    return (await this.deps.services.credentials.get({ tenantId, vaultId, credentialId: credential.id })) ?? credential;
  }

  private async cachedIdentity(tenantId: string, credential: CredentialRow): Promise<ConnectionIdentity | null> {
    const raw = await this.deps.services.kv.get(identityKey(tenantId, credential.id)).catch(() => null);
    if (!raw) return null;
    try {
      const cached = JSON.parse(raw) as ConnectionIdentity;
      if (cached.version !== identityVersion(credential) || cached.status !== "verified") return null;
      return cached;
    } catch {
      return null;
    }
  }

  /** Verify one saved credential (handshake + provider identity) and cache
   *  the result for the card. Reads only; grants nothing. */
  async identify(tenantId: string, vaultId: string, credential: CredentialRow): Promise<ConnectionIdentity> {
    return (await this.verifySnapshot(tenantId, vaultId, credential)).identity;
  }

  /** identify + the exact credential snapshot that was verified. */
  private async verifySnapshot(tenantId: string, vaultId: string, credential: CredentialRow): Promise<{ identity: ConnectionIdentity; verified: CredentialRow }> {
    // Freeze what is being verified before the (slow) provider check, so the
    // version/generation describe exactly this account.
    const current = structuredClone(await this.fresh(tenantId, vaultId, credential));
    const version = identityVersion(current);
    const result = await (this.deps.verify ?? verifyConnection)(structuredClone(current));
    const identity: ConnectionIdentity = { ...result, checked_at: Date.now(), version };
    // Only successes are cached: a provider blip must not mark a good
    // account unusable for days.
    if (identity.status === "verified") {
      await this.deps.services.kv.put(identityKey(tenantId, current.id), JSON.stringify(identity), {
        expirationTtl: IDENTITY_TTL_SECONDS,
      }).catch(() => {});
    } else {
      await this.deps.services.kv.delete(identityKey(tenantId, current.id)).catch(() => {});
    }
    return { identity, verified: current };
  }

  /** Verify `credential` and, when it checks out, bind it to the agent and
   *  record the grant on the session. */
  private async bind(input: {
    tenantId: string; sessionId: string; requestId: string; service: string; agentId: string; url: string;
    vaultId: string; credential: CredentialRow;
    /** What the card showed (Use): the bound account must be that one. */
    expected?: { version: string; account?: string; workspaceId?: string };
  }): Promise<ConnectResult> {
    const changed = { status: "unverified" as const, message: "This account changed since it was shown. Check the list again and pick it again." };
    if (input.expected && input.expected.version !== identityVersion(input.credential)) return changed;
    const { identity, verified } = await this.verifySnapshot(input.tenantId, input.vaultId, input.credential);
    if (identity.status !== "verified") {
      return { status: "unverified", message: identity.message ?? "The connection could not be verified. No access was granted." };
    }
    if (input.expected) {
      if (identity.version !== input.expected.version) return changed;
      if ((input.expected.account ?? "") !== (identity.account ?? "")) return changed;
      if ((input.expected.workspaceId ?? "") !== (identity.workspace_id ?? "")) return changed;
    }
    // Pin the generation that was VERIFIED. If the credential was reconnected
    // while the provider check ran, the binding is born mismatched, so it
    // never authorizes the unverified account.
    const binding: ConnectionBinding = {
      vault_id: input.vaultId, credential_id: input.credential.id, mcp_server_url: input.url,
      account: identity.account, workspace: identity.workspace, workspace_id: identity.workspace_id, approved_at: Date.now(),
      generation: credentialGeneration(verified),
    };
    const key = connectionBindingKey(input.tenantId, input.agentId, input.url);
    const existing = await this.binding(input.tenantId, input.agentId, input.url);
    await this.deps.services.kv.put(key, JSON.stringify(binding));
    // Re-picking the account that is already bound is a no-op for the agent.
    if (!existing || existing.credential_id !== binding.credential_id || existing.vault_id !== binding.vault_id || existing.generation !== binding.generation) {
      try {
        await this.deps.onApproved({ tenantId: input.tenantId, sessionId: input.sessionId, requestId: input.requestId, service: input.service, binding });
      } catch (err) {
        // The binding stands (the card reads it); only the agent's nudge was lost.
        this.deps.services.logger?.warn({ op: "connection.notify_failed", session_id: input.sessionId, err: err instanceof Error ? err.message : String(err) }, "connection bound but the session could not be notified");
      }
    }
    this.deps.services.logger?.info({ op: "connection.approved", session_id: input.sessionId, credential_id: input.credential.id }, "connection chosen for agent");
    return { status: "connected", account: identity.account, workspace: identity.workspace, ...(identity.message ? { message: identity.message } : {}) };
  }

  /** A new sign-in the card started (OAuth callback / API key): verify the
   *  credential it produced and, if it checks out, bind it to the agent.
   *  Starting the sign-in from this agent's card is the user's choice. */
  async connectNew(input: { tenantId: string; sessionId: string; requestId: string; vaultId: string; credentialId: string }): Promise<ConnectResult> {
    try {
      const { request, agentId, url } = await this.context(input.tenantId, input.sessionId, input.requestId);
      const credential = await this.candidate(input.tenantId, url, input.vaultId, input.credentialId);
      const result = await this.bind({ ...input, service: request.service, agentId, url, credential });
      if (result.status === "connected") await this.label(input.tenantId, input.vaultId, credential, request, result);
      return result;
    } catch (err) {
      if (err instanceof ConnectError) return { status: "unverified", message: err.message };
      throw err;
    }
  }

  /** Give a freshly connected account a recognizable name in Credential
   *  Vaults ("Linear · ana@acme.com · Acme") instead of "linear (OAuth)". */
  private async label(tenantId: string, vaultId: string, credential: CredentialRow, request: AccessRequest, result: ConnectResult & { status: "connected" }) {
    const service = serviceDisplayName(request.service, request.mcp_server_url);
    const who = [result.account, result.workspace].filter(Boolean).join(" · ");
    // Providers that don't reveal identity: tell accounts apart by when they
    // were connected.
    const name = who || `account connected ${new Date().toISOString().slice(0, 19).replace("T", " ")} UTC · #${credential.id.slice(-4)}`;
    await this.deps.services.credentials.update({ tenantId, vaultId, credentialId: credential.id, displayName: `${service} · ${name}` }).catch(() => {});
    await this.deps.services.vaults.update({ tenantId, vaultId, name: `${service} · ${result.workspace ?? result.account ?? "connection"}` }).catch(() => {});
  }

  routes() {
    const app = new Hono<{ Variables: { tenant_id: string } }>();
    // Card-facing errors as `{ error }` JSON (what the console's api() reads).
    app.onError((err, c) => {
      if (err instanceof ConnectError) return c.json({ error: err.message }, err.status);
      if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
      throw err;
    });
    const ids = (c: { req: { param: (k: string) => string } }) => ({ sessionId: c.req.param("sessionId"), requestId: c.req.param("requestId") });

    // Per-agent overview for the setup page: every URL server on the agent
    // and which account (if any) it is connected with. Bindings only — no
    // provider calls.
    app.get("/agent/:agentId/status", async c => {
      const tenantId = c.get("tenant_id");
      const agent = await this.deps.services.agents.get({ tenantId, agentId: c.req.param("agentId") });
      if (!agent) throw new ConnectError(404, "Agent not found");
      const servers = (agent.mcp_servers ?? []).filter(s => s.type !== "stdio" && typeof s.url === "string" && s.url);
      const data = await Promise.all(servers.map(async s => {
        const url = s.url!;
        const binding = await this.binding(tenantId, agent.id, url);
        const credential = binding ? await this.authorizedCredential(tenantId, agent.id, url) : null;
        return {
          name: s.name,
          display_name: serviceDisplayName(s.name, url),
          mcp_server_url: url,
          status: credential ? "connected" : binding ? "broken" : "pending",
          ...(credential && binding ? { account: binding.account, workspace: binding.workspace } : {}),
        };
      }));
      return c.json({ data });
    });

    // Card state: is an account chosen for this agent, and which saved
    // accounts could be. Display metadata + cached identity only — listing
    // never touches a provider and grants nothing.
    app.get("/:sessionId/:requestId", async c => {
      const tenantId = c.get("tenant_id");
      const { sessionId, requestId } = ids(c);
      const { request, agentId, url } = await this.context(tenantId, sessionId, requestId);
      const vaults = await this.deps.services.vaults.list({ tenantId, includeArchived: false });
      const groups = await this.deps.services.credentials.listByVaults({ tenantId, vaultIds: vaults.map(v => v.id) });
      const binding = await this.binding(tenantId, agentId, url);
      const bound = binding ? await this.authorizedCredential(tenantId, agentId, url) : null;
      const rows = groups.flatMap(group => group.credentials
        .filter(cred => !cred.archived_at && cred.auth.mcp_server_url && connectionUrl(cred.auth.mcp_server_url) === connectionUrl(url))
        .map(cred => ({ cred, vault_id: group.vault_id })));
      const connections = await Promise.all(rows.map(async ({ cred, vault_id }) => ({
        credential_id: cred.id,
        vault_id,
        label: cred.display_name,
        vault_name: vaults.find(v => v.id === vault_id)?.name,
        updated_at: cred.updated_at ?? cred.created_at,
        identity: await this.cachedIdentity(tenantId, cred),
      })));
      // One row per real account: the same verified account/workspace saved
      // by several agents shows once (the bound one, else the newest copy).
      connections.sort((a, b) =>
        Number(b.credential_id === bound?.id) - Number(a.credential_id === bound?.id) ||
        String(b.updated_at).localeCompare(String(a.updated_at)));
      const seenAccounts = new Set<string>();
      const unique = connections.filter(conn => {
        const id = conn.identity?.status === "verified" && conn.identity.account && conn.identity.workspace_id
          ? `${conn.identity.account}|${conn.identity.workspace_id}` : null;
        if (!id) return true;
        if (seenAccounts.has(id)) return false;
        seenAccounts.add(id);
        return true;
      });
      return c.json({
        service: request.service,
        display_name: serviceDisplayName(request.service, url),
        mcp_server_url: url,
        approved: !!bound,
        // A chosen account that was since archived/removed: the agent has no
        // access (the proxy refuses to fall back to another account).
        broken: !!binding && !bound,
        current: bound && binding ? {
          credential_id: bound.id, vault_id: binding.vault_id, label: bound.display_name,
          account: binding.account, workspace: binding.workspace,
        } : null,
        connections: unique.map(({ updated_at: _u, ...conn }) => conn),
      });
    });

    // Look up which account/workspace a saved connection belongs to.
    app.post("/:sessionId/:requestId/identify", async c => {
      const tenantId = c.get("tenant_id");
      const { sessionId, requestId } = ids(c);
      const { url } = await this.context(tenantId, sessionId, requestId);
      const body = await c.req.json<{ vault_id?: string; credential_id?: string }>().catch(() => ({} as { vault_id?: string; credential_id?: string }));
      const credential = await this.candidate(tenantId, url, body.vault_id!, body.credential_id!);
      const identity = await this.identify(tenantId, body.vault_id!, credential);
      this.deps.services.logger?.info({ op: "connection.identified", session_id: sessionId, credential_id: credential.id, status: identity.status }, "connection identity checked (no access granted)");
      return c.json(identity);
    });

    // "Use this account": the explicit choice. Verifies again, then binds.
    app.post("/:sessionId/:requestId/use", async c => {
      const tenantId = c.get("tenant_id");
      const { sessionId, requestId } = ids(c);
      const { request, agentId, url } = await this.context(tenantId, sessionId, requestId);
      type UseBody = { vault_id?: string; credential_id?: string; expected_version?: string; expected_account?: string; expected_workspace_id?: string };
      const body = await c.req.json<UseBody>().catch(() => ({} as UseBody));
      const credential = await this.candidate(tenantId, url, body.vault_id!, body.credential_id!);
      // The choice is tied to the identity the card displayed.
      if (typeof body.expected_version !== "string" || !body.expected_version) {
        throw new ConnectError(400, "Check who this account is before using it");
      }
      const result = await this.bind({
        tenantId, sessionId, requestId, service: request.service, agentId, url,
        vaultId: body.vault_id!, credential,
        expected: {
          version: body.expected_version,
          ...(typeof body.expected_account === "string" ? { account: body.expected_account } : {}),
          ...(typeof body.expected_workspace_id === "string" ? { workspaceId: body.expected_workspace_id } : {}),
        },
      });
      // 200 either way: "unverified" is an answer the card renders, not a fault.
      return c.json(result);
    });

    // New sign-in: a fresh vault per account (an OAuth callback replaces the
    // credential for the same server inside one vault, so sharing a vault
    // would swap the account under another agent), and the authorize URL the
    // popup should open. The callback binds the result to this agent.
    app.post("/:sessionId/:requestId/start", async c => {
      const tenantId = c.get("tenant_id");
      const { sessionId, requestId } = ids(c);
      const { request, url } = await this.context(tenantId, sessionId, requestId);
      const display = serviceDisplayName(request.service, url);
      // Retries from the same card reuse its still-empty vault instead of
      // leaving one abandoned "<Service> connection" vault per click.
      const startKey = `connection_start:${encodeURIComponent(tenantId)}:${encodeURIComponent(sessionId)}:${encodeURIComponent(requestId)}`;
      let vaultId: string | null = null;
      const previous = await this.deps.services.kv.get(startKey).catch(() => null);
      if (previous) {
        const vault = await this.deps.services.vaults.get({ tenantId, vaultId: previous }).catch(() => null);
        const creds = vault && !vault.archived_at
          ? await this.deps.services.credentials.listByVaults({ tenantId, vaultIds: [previous] }).catch(() => null)
          : null;
        if (creds && creds.every(g => g.credentials.every(cred => cred.archived_at))) vaultId = previous;
      }
      if (!vaultId) {
        vaultId = (await this.deps.services.vaults.create({ tenantId, name: `${display} connection` })).id;
        await this.deps.services.kv.put(startKey, vaultId, { expirationTtl: 24 * 60 * 60 }).catch(() => {});
      }
      const params = new URLSearchParams({
        mcp_server_url: url, vault_id: vaultId, service: request.service, session_id: sessionId, request_id: requestId,
      });
      const body = await c.req.json<{ redirect_uri?: string }>().catch(() => ({} as { redirect_uri?: string }));
      if (typeof body.redirect_uri === "string" && body.redirect_uri) params.set("redirect_uri", body.redirect_uri);
      return c.json({ vault_id: vaultId, authorize_url: `/v1/oauth/authorize?${params}` });
    });

    // API-key servers: store the key in its own vault, verify, bind.
    app.post("/:sessionId/:requestId/api_key", async c => {
      const tenantId = c.get("tenant_id");
      const { sessionId, requestId } = ids(c);
      const { request, url } = await this.context(tenantId, sessionId, requestId);
      const body = await c.req.json<{ token?: string }>().catch(() => ({} as { token?: string }));
      const token = typeof body.token === "string" ? body.token.trim() : "";
      if (!token) return c.json({ error: "Paste the API key first" }, 400);
      const display = serviceDisplayName(request.service, url);
      const vault = await this.deps.services.vaults.create({ tenantId, name: `${display} connection` });
      const credential = await this.deps.services.credentials.create({
        tenantId, vaultId: vault.id, displayName: `${display} API key`,
        auth: { type: "static_bearer", token, mcp_server_url: url },
      });
      const result = await this.connectNew({ tenantId, sessionId, requestId, vaultId: vault.id, credentialId: credential.id });
      if (result.status !== "connected") {
        // A key that doesn't work is not worth keeping around.
        await this.deps.services.vaults.archive({ tenantId, vaultId: vault.id }).catch(() => {});
        await this.deps.services.credentials.archiveByVault({ tenantId, vaultId: vault.id }).catch(() => {});
      }
      return c.json(result);
    });
    return app;
  }
}
