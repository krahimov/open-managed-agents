import { createHash, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RouteServices } from "@open-managed-agents/http-routes";
import type { CredentialRow } from "@open-managed-agents/credentials-store";
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

/** Argument-free identity tools tried on servers without a dedicated probe. */
const GENERIC_IDENTITY_TOOLS = ["whoami", "get_me", "get_current_user", "get_viewer", "get_authenticated_user"];

/** Provider-reported names end up in the UI and in the agent's grant message:
 *  strip control characters (no injected lines) and cap the length. */
function identityText(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value).replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  return text || undefined;
}

function workspaceList(names: string[], provider: string): Pick<ConnectionVerification, "workspace" | "workspace_id"> {
  if (!names.length) return {};
  const shown = names.slice(0, 3).join(", ") + (names.length > 3 ? ` (+${names.length - 3} more)` : "");
  return { workspace: shown, workspace_id: `${provider}:${[...names].sort().join(",")}` };
}

async function callIdentityTool(client: Client, name: string, args: Record<string, string>) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 10_000 });
  if (result.isError) throw new Error("Identity query failed");
  const texts = (result.content as Array<{ type: string; text?: string }>).flatMap(c => c.type === "text" && c.text ? [c.text] : []);
  let json = result.structuredContent as Record<string, unknown> | undefined;
  for (const text of texts) {
    if (json) break;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) json = parsed;
    } catch { /* Try the next text block. */ }
  }
  return { json, text: texts.join("\n") };
}

async function readIdentityJson(client: Client, name: string, args: Record<string, string>): Promise<Record<string, unknown>> {
  const { json } = await callIdentityTool(client, name, args);
  if (!json) throw new Error("Identity response unavailable");
  return json;
}

/** Best-effort identity from an unknown server's whoami-style tool: common
 *  JSON shapes first, then an email or "logged in as X" in plain text. */
async function readIdentityAny(client: Client, name: string): Promise<Pick<ConnectionVerification, "account" | "workspace" | "workspace_id">> {
  const { json, text } = await callIdentityTool(client, name, {});
  if (json) {
    const scopes = [json, ...["user", "viewer", "me", "data"].map(k => json[k]).filter((v): v is Record<string, unknown> => !!v && typeof v === "object")];
    const pick = (keys: string[]) => {
      for (const scope of scopes) for (const key of keys) { const v = identityText(scope[key]); if (v) return v; }
      return undefined;
    };
    const account = pick(["email", "login", "username", "name"]);
    for (const key of ["workspace", "organization", "org", "team"]) {
      const ws = json[key];
      const wsName = identityText(ws) ?? identityText((ws as Record<string, unknown> | undefined)?.name);
      if (account && wsName) {
        const wsId = identityText((ws as Record<string, unknown> | undefined)?.id);
        return { account, workspace: wsName, ...(wsId ? { workspace_id: wsId } : {}) };
      }
    }
    if (account) return { account };
  }
  const email = text.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/)?.[0];
  const loggedInAs = text.match(/(?:logged in|signed in|authenticated) as\s+([^\n(]{1,80})/i)?.[1];
  const account = identityText(email ?? loggedInAs);
  return account ? { account } : {};
}

/** Only protocol discovery and fixed, read-only provider identity queries. */
export async function verifyConnection(credential: CredentialRow): Promise<ConnectionVerification> {
  const auth = credential.auth as unknown as Record<string, string | undefined>;
  const token = auth.access_token || auth.token || auth.bearer_token;
  const url = auth.mcp_server_url;
  if (!token || !url) return { status: "unverified", message: "This credential has no usable token." };
  const client = new Client({ name: "orrery-connection-verification", version: "1" });
  const boundedFetch: typeof fetch = (input, init) => fetch(input, {
    ...init, redirect: "error",
    signal: AbortSignal.any([AbortSignal.timeout(8_000), ...(init?.signal ? [init.signal] : [])]),
  });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { authorization: `Bearer ${token}` } }, fetch: boundedFetch,
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
        const user = await readIdentityJson(client, "get_user", { query: "me" });
        const workspace = await readIdentityJson(client, "get_workspace", {});
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
    const hasTool = (name: string) => toolList.tools.some(tool => tool.name === name);
    if (host === "api.githubcopilot.com") {
      // GitHub's MCP answers get_me for the token's user; the REST /user
      // endpoint is the fallback for servers/toolsets that omit it.
      let user = hasTool("get_me") ? await readIdentityJson(client, "get_me", {}).catch(() => undefined) : undefined;
      if (!user) {
        const response = await boundedFetch("https://api.github.com/user", {
          headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "orrery-connection-verification" },
        });
        user = response.ok ? await response.json() as Record<string, unknown> : undefined;
      }
      const login = identityText(user?.login);
      const id = typeof user?.id === "number" || typeof user?.id === "string" ? String(user.id) : undefined;
      if (!login || !id) return { status: "unverified", message: "GitHub account could not be verified. Reconnect and try again." };
      return { status: "verified", account: login, workspace: login, workspace_id: `github:${id}` };
    }
    if (host === "mcp.sentry.dev" && hasTool("whoami")) {
      // whoami carries the user plus the org when the grant is scoped to one;
      // otherwise list the orgs this token can reach.
      const me = await readIdentityJson(client, "whoami", {});
      const user = me.user as Record<string, unknown> | undefined;
      const account = identityText(user?.email) ?? identityText(user?.name);
      if (!account) return { status: "unverified", message: "Sentry account could not be verified. Reconnect and try again." };
      const scopedOrg = identityText((me.sessionConstraints as Record<string, unknown> | null | undefined)?.organizationSlug);
      let orgs = scopedOrg ? [scopedOrg] : [];
      if (!orgs.length && hasTool("find_organizations")) {
        const found = await readIdentityJson(client, "find_organizations", {}).catch(() => undefined);
        orgs = ((found?.organizations ?? []) as Array<{ slug?: unknown }>).flatMap(org => identityText(org.slug) ?? []);
      }
      return { status: "verified", account, ...workspaceList(orgs, "sentry") };
    }
    // Any other server: call one well-known, argument-free "who am I" tool.
    // A missing or unreadable answer leaves identity unreported rather than
    // guessed from labels or tool names.
    const whoamiTool = toolList.tools.find(tool => GENERIC_IDENTITY_TOOLS.includes(tool.name) && !tool.inputSchema.required?.length);
    if (whoamiTool) {
      const identity = await readIdentityAny(client, whoamiTool.name).catch(() => undefined);
      if (identity?.account) return { status: "verified", ...identity };
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

const fingerprint = (credential: CredentialRow) => createHash("sha256").update(JSON.stringify(credential.auth)).digest("hex");
const verificationKey = (tenantId: string, id: string) => `connection_verification:${encodeURIComponent(tenantId)}:${id}`;

/** Bindings live in server-owned KV, not model-editable agent metadata. */
export class ConnectionConsent {
  constructor(private deps: Deps) {}

  async hasApproval(tenantId: string, agentId: string, url: string): Promise<boolean> {
    return !!await this.deps.services.kv.get(connectionBindingKey(tenantId, agentId, url));
  }

  async authorizedCredential(tenantId: string, agentId: string, url: string): Promise<CredentialRow | null> {
    const raw = await this.deps.services.kv.get(connectionBindingKey(tenantId, agentId, url));
    if (!raw) return null;
    const binding = JSON.parse(raw) as ConnectionBinding;
    const vault = await this.deps.services.vaults.get({ tenantId, vaultId: binding.vault_id });
    if (!vault || vault.archived_at) return null;
    const credential = await this.deps.services.credentials.get({ tenantId, vaultId: binding.vault_id, credentialId: binding.credential_id });
    if (!credential || credential.archived_at || !credential.auth.mcp_server_url || connectionUrl(credential.auth.mcp_server_url) !== connectionUrl(url)) return null;
    return credential;
  }

  routes() {
    const app = new Hono<{ Variables: { tenant_id: string } }>();
    const context = async (tenantId: string, sessionId: string, requestId: string) => {
      const session = await this.deps.services.sessions.get({ tenantId, sessionId });
      if (!session || session.archived_at || !session.agent_id) throw new HTTPException(404, { message: "Session not found" });
      const request = await this.deps.readRequest(sessionId, requestId);
      if (!request?.mcp_server_url) throw new HTTPException(404, { message: "Connection request not found" });
      const agent = await this.deps.services.agents.get({ tenantId, agentId: session.agent_id });
      if (!agent || !agent.mcp_servers?.some(s => s.type !== "stdio" && s.url && connectionUrl(s.url) === connectionUrl(request.mcp_server_url!))) {
        throw new HTTPException(409, { message: "This service is no longer configured on the agent" });
      }
      return { session, request };
    };
    const candidate = async (tenantId: string, url: string, vaultId: string, credentialId: string) => {
      const vault = await this.deps.services.vaults.get({ tenantId, vaultId });
      const credential = await this.deps.services.credentials.get({ tenantId, vaultId, credentialId });
      if (!vault || vault.archived_at || !credential || credential.archived_at || !credential.auth.mcp_server_url || connectionUrl(credential.auth.mcp_server_url) !== connectionUrl(url)) {
        throw new HTTPException(404, { message: "Matching connection not found" });
      }
      return credential;
    };
    app.get("/:sessionId/:requestId", async c => {
      const tenantId = c.get("tenant_id");
      const { request, session } = await context(tenantId, c.req.param("sessionId"), c.req.param("requestId"));
      const vaults = await this.deps.services.vaults.list({ tenantId, includeArchived: false });
      const groups = await this.deps.services.credentials.listByVaults({ tenantId, vaultIds: vaults.map(v => v.id) });
      // Only display metadata. Listing does not probe, attach, refresh or authorize anything.
      const approved = !!await this.authorizedCredential(tenantId, session.agent_id!, request.mcp_server_url!);
      return c.json({ approved, connections: groups.flatMap(group => group.credentials.filter(cred =>
        !cred.archived_at && cred.auth.mcp_server_url && connectionUrl(cred.auth.mcp_server_url) === connectionUrl(request.mcp_server_url!),
      ).map(cred => ({ credential_id: cred.id, vault_id: group.vault_id, label: cred.display_name,
        vault_name: vaults.find(v => v.id === group.vault_id)?.name, status: "unverified" }))) });
    });
    app.post("/:sessionId/:requestId/verify", async c => {
      const tenantId = c.get("tenant_id");
      const sessionId = c.req.param("sessionId"), requestId = c.req.param("requestId");
      const { request } = await context(tenantId, sessionId, requestId);
      const body = await c.req.json<{ vault_id: string; credential_id: string }>();
      if (typeof body.vault_id !== "string" || typeof body.credential_id !== "string") return c.json({ error: "Select a connection first" }, 400);
      let cred = await candidate(tenantId, request.mcp_server_url!, body.vault_id, body.credential_id);
      const auth = cred.auth;
      if (auth.type === "mcp_oauth" && auth.refresh_token && auth.token_endpoint && auth.expires_at && Date.parse(auth.expires_at) <= Date.now() + 60_000) {
        const refreshed = await refreshNodeMcpOAuthToken({ refreshToken: auth.refresh_token, tokenEndpoint: auth.token_endpoint, clientId: auth.client_id, clientSecret: auth.client_secret }, (input, init) => fetch(input, { ...init, redirect: "error", signal: AbortSignal.timeout(8_000) }));
        if (refreshed) {
          await this.deps.services.credentials.refreshAuth({ tenantId, vaultId: body.vault_id, credentialId: cred.id,
            auth: { access_token: refreshed.access_token, refresh_token: refreshed.refresh_token, expires_at: refreshed.expires_in ? new Date(Date.now() + refreshed.expires_in * 1000).toISOString() : undefined } });
          cred = await candidate(tenantId, request.mcp_server_url!, body.vault_id, body.credential_id);
        }
      }
      const result = await (this.deps.verify ?? verifyConnection)(cred);
      this.deps.services.logger?.info({ op: "connection.verified", session_id: sessionId, credential_id: cred.id, status: result.status }, "connection verification completed without granting access");
      if (result.status !== "verified") return c.json(result);
      const id = randomUUID();
      await this.deps.services.kv.put(verificationKey(tenantId, id), JSON.stringify({
        ...result, sessionId, requestId, vaultId: body.vault_id, credentialId: cred.id,
        fingerprint: fingerprint(cred), expiresAt: Date.now() + 300_000,
      }), { expirationTtl: 300 });
      return c.json({ ...result, verification_id: id });
    });
    app.post("/:sessionId/:requestId/approve", async c => {
      const tenantId = c.get("tenant_id"), sessionId = c.req.param("sessionId"), requestId = c.req.param("requestId");
      const { session, request } = await context(tenantId, sessionId, requestId);
      const body = await c.req.json<{ verification_id?: string; confirmed?: boolean; workspace_id?: string }>();
      if (body.confirmed !== true || typeof body.verification_id !== "string") return c.json({ error: "Explicit connection approval is required" }, 400);
      const raw = await this.deps.services.kv.get(verificationKey(tenantId, body.verification_id));
      if (!raw) return c.json({ error: "Verify the connection again" }, 409);
      const verified = JSON.parse(raw);
      if (verified.sessionId !== sessionId || verified.requestId !== requestId || verified.expiresAt < Date.now() || verified.workspace_id !== body.workspace_id) return c.json({ error: "Connection verification does not match this approval" }, 409);
      const cred = await candidate(tenantId, request.mcp_server_url!, verified.vaultId, verified.credentialId);
      if (fingerprint(cred) !== verified.fingerprint) return c.json({ error: "The connection changed. Verify it again before approving." }, 409);
      const binding: ConnectionBinding = { vault_id: verified.vaultId, credential_id: cred.id, mcp_server_url: request.mcp_server_url!,
        account: verified.account, workspace: verified.workspace, workspace_id: verified.workspace_id, approved_at: Date.now() };
      const key = connectionBindingKey(tenantId, session.agent_id!, request.mcp_server_url!);
      const existing = await this.deps.services.kv.get(key);
      if (existing && JSON.parse(existing).verification_id === body.verification_id) return c.json({ status: "connected" });
      await this.deps.services.kv.put(key, JSON.stringify({ ...binding, verification_id: body.verification_id }));
      await this.deps.onApproved({ tenantId, sessionId, requestId, service: request.service, binding });
      return c.json({ status: "connected", account: binding.account, workspace: binding.workspace });
    });
    return app;
  }
}
