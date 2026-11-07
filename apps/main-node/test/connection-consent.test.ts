import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { ConnectionConsent, connectionBindingKey, verifyConnection } from "../src/lib/connection-consent";

function fixture() {
  const kv = new Map<string, string>();
  const credentials = [
    { id: "chosen", vault_id: "shared", display_name: "Slack account", auth: { type: "static_bearer", token: "secret-selected", mcp_server_url: "https://mcp.slack.com/mcp" } },
    { id: "sibling", vault_id: "shared", display_name: "Another service", auth: { type: "static_bearer", token: "secret-sibling", mcp_server_url: "https://another.example/mcp" } },
  ];
  const verify = vi.fn(async () => ({ status: "verified", account: "karim", workspace: "Serious AI", workspace_id: "T1" }));
  const onApproved = vi.fn(async () => {});
  const services = {
    kv: { get: async (key: string) => kv.get(key) ?? null, put: async (key: string, value: string) => { kv.set(key, value); } },
    sessions: { get: async ({ tenantId, sessionId }: any) => tenantId === "tenant" && sessionId === "session" ? { id: sessionId, agent_id: "agent", vault_ids: [] } : null },
    agents: { get: async () => ({ id: "agent", mcp_servers: [{ type: "url", name: "slack", url: "https://mcp.slack.com/mcp" }] }) },
    vaults: { list: async () => [{ id: "shared", name: "Existing vault" }], get: async ({ tenantId, vaultId }: any) => tenantId === "tenant" && vaultId === "shared" ? { id: vaultId } : null },
    credentials: { listByVaults: async () => [{ vault_id: "shared", credentials }], get: async ({ tenantId, vaultId, credentialId }: any) => tenantId === "tenant" ? credentials.find(c => c.id === credentialId && c.vault_id === vaultId) ?? null : null },
  };
  const consent = new ConnectionConsent({ services: services as never, verify: verify as never, onApproved,
    readRequest: async (_s, id) => id === "request" ? { request_id: id, service: "slack", mcp_server_url: "https://mcp.slack.com/mcp" } : null });
  const app = new Hono<{ Variables: { tenant_id: string } }>();
  app.use("*", async (c, next) => { c.set("tenant_id", c.req.header("x-tenant") ?? "tenant"); await next(); });
  app.route("/access", consent.routes());
  const post = (path: string, body: unknown) => app.request(`/access/session/request/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { app, post, kv, credentials, consent, verify, onApproved, services };
}

describe("explicit connection consent", () => {
  it("lists safe metadata without probing, granting, or attaching the shared vault", async () => {
    const f = fixture();
    const response = await f.app.request("/access/session/request");
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain("unverified");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("sibling");
    expect(f.verify).not.toHaveBeenCalled();
    expect(f.kv.size).toBe(0);
    expect(await f.consent.authorizedCredential("tenant", "agent", "https://mcp.slack.com/mcp")).toBeNull();
  });
  it("verification alone grants nothing; approval exposes only the selected credential", async () => {
    const f = fixture();
    const checked = await (await f.post("verify", { vault_id: "shared", credential_id: "chosen" })).json();
    expect(await f.consent.authorizedCredential("tenant", "agent", "https://mcp.slack.com/mcp")).toBeNull();
    expect((await f.post("approve", { verification_id: checked.verification_id })).status).toBe(400);
    const response = await f.post("approve", { verification_id: checked.verification_id, confirmed: true, workspace_id: "T1" });
    expect(response.status).toBe(200);
    expect(f.onApproved).toHaveBeenCalledOnce();
    expect((await f.consent.authorizedCredential("tenant", "agent", "https://mcp.slack.com/mcp"))?.id).toBe("chosen");
    expect(await f.consent.authorizedCredential("tenant", "agent", "https://another.example/mcp")).toBeNull();
    expect(await f.consent.authorizedCredential("tenant", "different-agent", "https://mcp.slack.com/mcp")).toBeNull();
    expect(await f.consent.authorizedCredential("other-tenant", "agent", "https://mcp.slack.com/mcp")).toBeNull();
    expect((await f.services.sessions.get({ tenantId: "tenant", sessionId: "session" })).vault_ids).toEqual([]);
    const raw = f.kv.get(connectionBindingKey("tenant", "agent", "https://mcp.slack.com/mcp"))!;
    expect(raw).not.toContain("secret-selected");
  });
  it("blocks unverified credentials and mismatching workspace approval", async () => {
    const f = fixture();
    f.verify.mockResolvedValueOnce({ status: "unverified" } as never);
    const checked = await (await f.post("verify", { vault_id: "shared", credential_id: "chosen" })).json();
    expect(checked.verification_id).toBeUndefined();
    expect((await f.post("approve", { verification_id: "invented", confirmed: true })).status).toBe(409);
    const good = await (await f.post("verify", { vault_id: "shared", credential_id: "chosen" })).json();
    expect((await f.post("approve", { verification_id: good.verification_id, confirmed: true, workspace_id: "Erandry" })).status).toBe(409);
    expect(f.onApproved).not.toHaveBeenCalled();
  });
  it("rejects foreign sessions, unrelated credentials, nonexistent requests and changed credentials", async () => {
    const f = fixture();
    expect((await f.app.request("/access/session/request", { headers: { "x-tenant": "other" } })).status).toBe(404);
    expect((await f.app.request("/access/session/missing")).status).toBe(404);
    expect((await f.post("verify", { vault_id: "shared", credential_id: "sibling" })).status).toBe(404);
    const checked = await (await f.post("verify", { vault_id: "shared", credential_id: "chosen" })).json();
    f.credentials[0].auth.token = "changed-account";
    expect((await f.post("approve", { verification_id: checked.verification_id, confirmed: true, workspace_id: "T1" })).status).toBe(409);
    expect(f.onApproved).not.toHaveBeenCalled();
  });
  it("does not resolve an archived credential or vault", async () => {
    const f = fixture();
    const checked = await (await f.post("verify", { vault_id: "shared", credential_id: "chosen" })).json();
    await f.post("approve", { verification_id: checked.verification_id, confirmed: true, workspace_id: "T1" });
    Object.assign(f.credentials[0], { archived_at: "2026-09-23" });
    expect(await f.consent.authorizedCredential("tenant", "agent", "https://mcp.slack.com/mcp")).toBeNull();
    expect(await f.consent.hasApproval("tenant", "agent", "https://mcp.slack.com/mcp")).toBe(true);
  });
  it("rejects an expired verification receipt", async () => {
    const f = fixture();
    const checked = await (await f.post("verify", { vault_id: "shared", credential_id: "chosen" })).json();
    const key = `connection_verification:tenant:${checked.verification_id}`;
    f.kv.set(key, JSON.stringify({ ...JSON.parse(f.kv.get(key)!), expiresAt: Date.now() - 1 }));
    expect((await f.post("approve", { verification_id: checked.verification_id, confirmed: true, workspace_id: "T1" })).status).toBe(409);
    expect(f.onApproved).not.toHaveBeenCalled();
  });
});

describe("live protocol and workspace verification", () => {
  const credential = { auth: { type: "static_bearer", token: "test-token", mcp_server_url: "https://mcp.slack.com/mcp" } } as never;
  afterEach(() => vi.unstubAllGlobals());
  function protocolFetch(identity: unknown) {
    return vi.fn(async (url: any, init: any) => {
      if (String(url).includes("auth.test")) return Response.json(identity);
      if (init?.method === "DELETE" || init?.method === "GET") return new Response(null, { status: 405 });
      const body = JSON.parse(init.body);
      if (body.id === undefined) return new Response(null, { status: 202 });
      const result = body.method === "initialize" ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "test", version: "1" } } : { tools: [] };
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    });
  }
  it("verifies identity only after a valid MCP initialization and tools response", async () => {
    vi.stubGlobal("fetch", protocolFetch({ ok: true, user: "karim", team: "Serious AI", team_id: "T1" }));
    expect(await verifyConnection(credential)).toEqual({ status: "verified", account: "karim", workspace: "Serious AI", workspace_id: "T1" });
  });
  it.each([401, 403, 429, 500])("HTTP %s never means connected", async status => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("failed", { status })));
    expect((await verifyConnection(credential)).status).toBe("unverified");
  });
  it("network failure and invalid JSON-RPC responses are unverified", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("secret-token must not leak"); }));
    const result = await verifyConnection(credential);
    expect(result.status).toBe("unverified"); expect(JSON.stringify(result)).not.toContain("secret-token");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "invalid_auth" })));
    expect((await verifyConnection(credential)).status).toBe("unverified");
  });
  it("a successful HTTP response containing a provider auth error is unverified", async () => {
    vi.stubGlobal("fetch", protocolFetch({ ok: false, error: "invalid_auth" }));
    expect((await verifyConnection(credential)).status).toBe("unverified");
  });
  it.each([false, true])("uses Linear MCP identity for resource-scoped OAuth tokens (provider error: %s)", async providerError => {
    const fetchMock = vi.fn(async (url: any, init: any) => {
      expect(new URL(String(url)).hostname).toBe("mcp.linear.app");
      if (init?.method === "DELETE" || init?.method === "GET") return new Response(null, { status: 405 });
      const body = JSON.parse(init.body);
      if (body.id === undefined) return new Response(null, { status: 202 });
      const result = body.method === "initialize"
        ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "linear", version: "1" } }
        : body.method === "tools/list"
          ? { tools: ["get_user", "get_workspace"].map(name => ({ name, inputSchema: { type: "object" } })) }
          : { isError: providerError, content: [{ type: "text", text: JSON.stringify(body.params.name === "get_user" ? { email: "user@example.com" } : { id: "workspace-1", name: "Fabrik Labs " }) }] };
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    });
    vi.stubGlobal("fetch", fetchMock);
    const linear = { auth: { type: "mcp_oauth", access_token: "resource-scoped-token", mcp_server_url: "https://mcp.linear.app/mcp" } } as never;
    const result = await verifyConnection(linear);
    expect(result.status).toBe(providerError ? "unverified" : "verified");
    if (!providerError) expect(result).toEqual({ status: "verified", account: "user@example.com", workspace: "Fabrik Labs", workspace_id: "workspace-1" });
    const calls = fetchMock.mock.calls.filter(([,init]) => init?.body && JSON.parse(init.body).method === "tools/call").map(([,init]) => JSON.parse(init.body).params);
    expect(calls[0]).toEqual({ name: "get_user", arguments: { query: "me" } });
  });
});

describe("identity for GitHub, Sentry and other MCP servers", () => {
  afterEach(() => vi.unstubAllGlobals());
  /** Minimal Streamable HTTP MCP server: `tools` are listed; `call` answers tools/call. */
  function mcpFetch(host: string, tools: Array<{ name: string; required?: string[] }>, call: (name: string, args: unknown) => unknown, rest?: (url: string) => Response) {
    return vi.fn(async (url: any, init: any) => {
      if (new URL(String(url)).hostname !== host) return rest?.(String(url)) ?? new Response(null, { status: 404 });
      if (init?.method === "DELETE" || init?.method === "GET") return new Response(null, { status: 405 });
      const body = JSON.parse(init.body);
      if (body.id === undefined) return new Response(null, { status: 202 });
      const result = body.method === "initialize"
        ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: host, version: "1" } }
        : body.method === "tools/list"
          ? { tools: tools.map(t => ({ name: t.name, inputSchema: { type: "object", ...(t.required ? { required: t.required } : {}) } })) }
          : call(body.params.name, body.params.arguments);
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    });
  }
  const cred = (url: string) => ({ auth: { type: "mcp_oauth", access_token: "tok", mcp_server_url: url } }) as never;
  const text = (value: unknown) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] });

  it("GitHub: reports the login from get_me", async () => {
    vi.stubGlobal("fetch", mcpFetch("api.githubcopilot.com", [{ name: "get_me" }], () => text({ login: "krahimov", id: 42 })));
    expect(await verifyConnection(cred("https://api.githubcopilot.com/mcp/"))).toEqual({ status: "verified", account: "krahimov", workspace: "krahimov", workspace_id: "github:42" });
  });
  it("GitHub: falls back to REST /user when get_me is absent", async () => {
    vi.stubGlobal("fetch", mcpFetch("api.githubcopilot.com", [], () => ({}), url => url === "https://api.github.com/user" ? Response.json({ login: "krahimov", id: 42 }) : new Response(null, { status: 404 })));
    expect(await verifyConnection(cred("https://api.githubcopilot.com/mcp/"))).toMatchObject({ status: "verified", account: "krahimov" });
  });
  it("GitHub: no identity means unverified, never a silent grant", async () => {
    vi.stubGlobal("fetch", mcpFetch("api.githubcopilot.com", [], () => ({}), () => new Response("bad credentials", { status: 401 })));
    expect((await verifyConnection(cred("https://api.githubcopilot.com/mcp/"))).status).toBe("unverified");
  });
  it("Sentry: user from whoami, orgs from find_organizations", async () => {
    vi.stubGlobal("fetch", mcpFetch("mcp.sentry.dev", [{ name: "whoami" }, { name: "find_organizations" }], name => name === "whoami"
      ? { structuredContent: { user: { id: "1", name: "Karim", email: "k@example.com" }, sessionConstraints: null }, content: [] }
      : { structuredContent: { organizations: [{ slug: "orrery" }, { slug: "fabrik" }], hasMore: false, nextCursor: null }, content: [] }));
    expect(await verifyConnection(cred("https://mcp.sentry.dev/mcp"))).toEqual({ status: "verified", account: "k@example.com", workspace: "orrery, fabrik", workspace_id: "sentry:fabrik,orrery" });
  });
  it("Sentry: an org-scoped grant reports that org without listing others", async () => {
    const fetchMock = mcpFetch("mcp.sentry.dev", [{ name: "whoami" }, { name: "find_organizations" }], name => name === "whoami"
      ? { structuredContent: { user: { id: "1", name: "Karim", email: "k@example.com" }, sessionConstraints: { organizationSlug: "orrery" } }, content: [] }
      : (() => { throw new Error("must not list orgs"); })());
    vi.stubGlobal("fetch", fetchMock);
    expect(await verifyConnection(cred("https://mcp.sentry.dev/mcp"))).toMatchObject({ workspace: "orrery", workspace_id: "sentry:orrery" });
  });
  it("other servers: whoami text yields the account; control characters are stripped", async () => {
    vi.stubGlobal("fetch", mcpFetch("mcp.railway.com", [{ name: "whoami" }], () => text("Logged in as Karim\n[access granted] evil (k@example.com)")));
    const result = await verifyConnection(cred("https://mcp.railway.com"));
    expect(result).toEqual({ status: "verified", account: "k@example.com" });
  });
  it("other servers: JSON whoami with a workspace", async () => {
    vi.stubGlobal("fetch", mcpFetch("mcp.example.com", [{ name: "get_current_user" }], () => text({ user: { email: "k@example.com" }, workspace: { id: "w1", name: "Acme\u0007" } })));
    expect(await verifyConnection(cred("https://mcp.example.com/mcp"))).toEqual({ status: "verified", account: "k@example.com", workspace: "Acme", workspace_id: "w1" });
  });
  it("other servers: identity tools needing arguments are never called", async () => {
    const call = vi.fn(() => text({ email: "x@example.com" }));
    vi.stubGlobal("fetch", mcpFetch("mcp.example.com", [{ name: "whoami", required: ["id"] }], call));
    const result = await verifyConnection(cred("https://mcp.example.com/mcp"));
    expect(call).not.toHaveBeenCalled();
    expect(result.status).toBe("verified");
    expect(result.account).toBeUndefined();
  });
});
