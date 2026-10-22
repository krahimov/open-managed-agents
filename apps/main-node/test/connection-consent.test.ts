import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { ConnectionConsent, connectionBindingKey, verifyConnection } from "../src/lib/connection-consent";

const SLACK = "https://mcp.slack.com/mcp";

function fixture(opts: { mcpServers?: Array<{ type: string; name: string; url: string }> } = {}) {
  const kv = new Map<string, string>();
  const vaults: Array<{ id: string; name: string; archived_at?: string | null }> = [
    { id: "shared", name: "Existing vault" },
    { id: "other", name: "Code review agent vault" },
  ];
  const credentials: Array<{ id: string; vault_id: string; display_name: string; auth: Record<string, unknown>; archived_at?: string | null; updated_at?: string | null; created_at?: string }> = [
    { id: "chosen", vault_id: "shared", display_name: "Slack account", created_at: "2026-09-01", auth: { type: "static_bearer", token: "secret-selected", mcp_server_url: SLACK } },
    { id: "sibling", vault_id: "shared", display_name: "Another service", created_at: "2026-09-01", auth: { type: "static_bearer", token: "secret-sibling", mcp_server_url: "https://another.example/mcp" } },
    { id: "copy", vault_id: "other", display_name: "Slack MCP user token (code review agent)", created_at: "2026-09-02", auth: { type: "static_bearer", token: "secret-copy", mcp_server_url: `${SLACK}/` } },
  ];
  let nextId = 0;
  const identities: Record<string, { status: "verified" | "unverified"; account?: string; workspace?: string; workspace_id?: string; message?: string }> = {
    "secret-selected": { status: "verified", account: "karim", workspace: "Serious AI", workspace_id: "T1" },
    "secret-copy": { status: "verified", account: "karim", workspace: "Serious AI", workspace_id: "T1" },
  };
  const verify = vi.fn(async (cred: { auth: Record<string, unknown> }) =>
    identities[String(cred.auth.token)] ?? { status: "unverified", message: "Authentication could not be verified." });
  const onApproved = vi.fn(async (_input: unknown) => {});
  const agent = { id: "agent", mcp_servers: opts.mcpServers ?? [{ type: "url", name: "slack", url: SLACK }] };
  const services = {
    kv: {
      get: async (key: string) => kv.get(key) ?? null,
      put: async (key: string, value: string) => { kv.set(key, value); },
      delete: async (key: string) => { kv.delete(key); },
    },
    sessions: { get: async ({ tenantId, sessionId }: any) => tenantId === "tenant" && sessionId === "session" ? { id: sessionId, agent_id: "agent", vault_ids: [] } : null },
    agents: { get: async () => agent },
    vaults: {
      list: async () => vaults.filter(v => !v.archived_at),
      get: async ({ tenantId, vaultId }: any) => tenantId === "tenant" ? vaults.find(v => v.id === vaultId) ?? null : null,
      create: async ({ name }: any) => { const v = { id: `vault-${++nextId}`, name }; vaults.push(v); return v; },
      update: async ({ vaultId, name }: any) => { const v = vaults.find(x => x.id === vaultId)!; v.name = name; return v; },
      archive: async ({ vaultId }: any) => { const v = vaults.find(x => x.id === vaultId)!; v.archived_at = "now"; return v; },
    },
    credentials: {
      listByVaults: async ({ vaultIds }: any) => vaultIds.map((vault_id: string) => ({ vault_id, credentials: credentials.filter(c => c.vault_id === vault_id) })),
      get: async ({ tenantId, vaultId, credentialId }: any) => tenantId === "tenant" ? credentials.find(c => c.id === credentialId && c.vault_id === vaultId) ?? null : null,
      create: async ({ vaultId, displayName, auth }: any) => { const c = { id: `cred-${++nextId}`, vault_id: vaultId, display_name: displayName, auth, created_at: "2026-10-22" }; credentials.push(c); return c; },
      update: async ({ credentialId, displayName }: any) => { const c = credentials.find(x => x.id === credentialId)!; if (displayName) c.display_name = displayName; return c; },
      archiveByVault: async ({ vaultId }: any) => { for (const c of credentials) if (c.vault_id === vaultId) c.archived_at = "now"; },
      refreshAuth: async () => {},
    },
  };
  const consent = new ConnectionConsent({
    services: services as never, verify: verify as never, onApproved,
    readRequest: async (_s, id) => id === "request" ? { request_id: id, service: "slack", mcp_server_url: SLACK } : null,
  });
  const app = new Hono<{ Variables: { tenant_id: string } }>();
  app.use("*", async (c, next) => { c.set("tenant_id", c.req.header("x-tenant") ?? "tenant"); await next(); });
  app.route("/access", consent.routes());
  const post = (path: string, body: unknown, tenant = "tenant") => app.request(`/access/session/request/${path}`, {
    method: "POST", headers: { "content-type": "application/json", "x-tenant": tenant }, body: JSON.stringify(body),
  });
  const state = async () => (await app.request("/access/session/request")).json() as Promise<any>;
  const bound = () => consent.authorizedCredential("tenant", "agent", SLACK);
  return { app, post, state, bound, kv, vaults, credentials, consent, verify, onApproved, services, agent };
}

describe("connect card: saved accounts", () => {
  it("lists only this server's saved accounts, without secrets, probing, or granting", async () => {
    const f = fixture();
    const response = await f.app.request("/access/session/request");
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).not.toContain("secret");
    expect(text).not.toContain("sibling");
    const body = JSON.parse(text);
    expect(body.display_name).toBe("Slack");
    expect(body.approved).toBe(false);
    expect(body.connections.map((c: any) => c.credential_id).sort()).toEqual(["chosen", "copy"]);
    expect(body.connections.every((c: any) => c.identity === null)).toBe(true);
    expect(f.verify).not.toHaveBeenCalled();
    expect([...f.kv.keys()].some(k => k.startsWith("connection_consent:"))).toBe(false);
    expect(await f.bound()).toBeNull();
  });

  it("identify shows who an account is, caches it, and grants nothing", async () => {
    const f = fixture();
    const identity = await (await f.post("identify", { vault_id: "shared", credential_id: "chosen" })).json();
    expect(identity).toMatchObject({ status: "verified", account: "karim", workspace: "Serious AI", workspace_id: "T1" });
    expect(await f.bound()).toBeNull();
    expect(f.onApproved).not.toHaveBeenCalled();
    const body = await f.state();
    expect(body.connections.find((c: any) => c.credential_id === "chosen").identity).toMatchObject({ account: "karim", workspace: "Serious AI" });
    expect(JSON.stringify(body)).not.toContain("fingerprint");
  });

  it("collapses copies of the same account saved by different agents into one row", async () => {
    const f = fixture();
    await f.post("identify", { vault_id: "shared", credential_id: "chosen" });
    await f.post("identify", { vault_id: "other", credential_id: "copy" });
    const body = await f.state();
    expect(body.connections).toHaveLength(1);
  });

  it("re-checks identity once the saved account's token changes", async () => {
    const f = fixture();
    await f.post("identify", { vault_id: "shared", credential_id: "chosen" });
    f.credentials[0].auth.token = "rotated-unknown";
    const body = await f.state();
    expect(body.connections.find((c: any) => c.credential_id === "chosen").identity).toBeNull();
  });

  it("Use binds exactly the chosen account to exactly this agent and tells the agent who it is", async () => {
    const f = fixture();
    const result = await (await f.post("use", { vault_id: "shared", credential_id: "chosen", expected_workspace_id: "T1" })).json();
    expect(result).toEqual({ status: "connected", account: "karim", workspace: "Serious AI" });
    expect(f.onApproved).toHaveBeenCalledOnce();
    expect(f.onApproved.mock.calls[0][0]).toMatchObject({ sessionId: "session", requestId: "request", service: "slack", binding: { credential_id: "chosen", account: "karim", workspace: "Serious AI" } });
    expect((await f.bound())?.id).toBe("chosen");
    expect(await f.consent.authorizedCredential("tenant", "agent", "https://another.example/mcp")).toBeNull();
    expect(await f.consent.authorizedCredential("tenant", "different-agent", SLACK)).toBeNull();
    expect(await f.consent.authorizedCredential("other-tenant", "agent", SLACK)).toBeNull();
    expect(f.kv.get(connectionBindingKey("tenant", "agent", SLACK))).not.toContain("secret-selected");
    const body = await f.state();
    expect(body).toMatchObject({ approved: true, current: { credential_id: "chosen", account: "karim", workspace: "Serious AI" } });
  });

  it("choosing the account that is already in use does not re-notify the agent", async () => {
    const f = fixture();
    await f.post("use", { vault_id: "shared", credential_id: "chosen" });
    await f.post("use", { vault_id: "shared", credential_id: "chosen" });
    expect(f.onApproved).toHaveBeenCalledOnce();
  });

  it("switching to another account rebinds and notifies again", async () => {
    const f = fixture();
    f.verify.mockImplementation(async (cred: any) => cred.id === "copy"
      ? { status: "verified", account: "ana", workspace: "Erandry", workspace_id: "T2" }
      : { status: "verified", account: "karim", workspace: "Serious AI", workspace_id: "T1" });
    await f.post("use", { vault_id: "shared", credential_id: "chosen" });
    await f.post("use", { vault_id: "other", credential_id: "copy" });
    expect(f.onApproved).toHaveBeenCalledTimes(2);
    expect((await f.bound())?.id).toBe("copy");
  });

  it("never binds an account that fails verification or changed workspace since it was shown", async () => {
    const f = fixture();
    f.credentials[0].auth.token = "broken";
    const failed = await (await f.post("use", { vault_id: "shared", credential_id: "chosen" })).json();
    expect(failed.status).toBe("unverified");
    expect(failed.message).toBeTruthy();
    f.credentials[0].auth.token = "secret-selected";
    const moved = await (await f.post("use", { vault_id: "shared", credential_id: "chosen", expected_workspace_id: "T-other" })).json();
    expect(moved.status).toBe("unverified");
    expect(f.onApproved).not.toHaveBeenCalled();
    expect(await f.bound()).toBeNull();
  });

  it("rejects foreign tenants, unknown requests, and credentials for other servers with JSON errors", async () => {
    const f = fixture();
    const foreign = await f.app.request("/access/session/request", { headers: { "x-tenant": "other" } });
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual({ error: "Session not found" });
    expect((await f.app.request("/access/session/missing")).status).toBe(404);
    expect((await f.post("use", { vault_id: "shared", credential_id: "sibling" })).status).toBe(404);
    expect((await f.post("use", { vault_id: "shared", credential_id: "chosen" }, "other")).status).toBe(404);
    expect((await f.post("use", {})).status).toBe(400);
    expect(f.onApproved).not.toHaveBeenCalled();
  });

  it("reports a server that was removed from the agent", async () => {
    const f = fixture({ mcpServers: [] });
    const response = await f.app.request("/access/session/request");
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/Slack is no longer configured/);
  });

  it("an archived chosen account cuts access instead of falling back to another", async () => {
    const f = fixture();
    await f.post("use", { vault_id: "shared", credential_id: "chosen" });
    f.credentials[0].archived_at = "2026-09-23";
    expect(await f.bound()).toBeNull();
    expect(await f.consent.hasApproval("tenant", "agent", SLACK)).toBe(true);
    const body = await f.state();
    expect(body).toMatchObject({ approved: false, broken: true, current: null });
  });
});

describe("connect card: new sign-in", () => {
  it("start creates a fresh vault and an authorize URL bound to this card", async () => {
    const f = fixture();
    const started = await (await f.post("start", { redirect_uri: "https://console.example/agents/a/setup" })).json();
    expect(f.vaults.find(v => v.id === started.vault_id)?.name).toBe("Slack connection");
    const url = new URL(started.authorize_url, "https://x");
    expect(url.pathname).toBe("/v1/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      mcp_server_url: SLACK, vault_id: started.vault_id, session_id: "session", request_id: "request", service: "slack",
      redirect_uri: "https://console.example/agents/a/setup",
    });
    expect(await f.bound()).toBeNull();
  });

  it("retrying a sign-in reuses the card's empty vault, but never one that holds an account", async () => {
    const f = fixture();
    const first = await (await f.post("start", {})).json();
    const retry = await (await f.post("start", {})).json();
    expect(retry.vault_id).toBe(first.vault_id);
    await f.services.credentials.create({ vaultId: first.vault_id, displayName: "Slack (OAuth)", auth: { type: "mcp_oauth", access_token: "t", mcp_server_url: SLACK } });
    const afterSignIn = await (await f.post("start", {})).json();
    expect(afterSignIn.vault_id).not.toBe(first.vault_id);
    expect(f.vaults.filter(v => v.name === "Slack connection")).toHaveLength(2);
  });

  it("connectNew binds the verified new account and names it after who it is", async () => {
    const f = fixture();
    const vault = await f.services.vaults.create({ name: "Slack connection" });
    const cred = await f.services.credentials.create({ vaultId: vault.id, displayName: "slack (OAuth)", auth: { type: "mcp_oauth", access_token: "secret-selected", mcp_server_url: SLACK } });
    f.verify.mockResolvedValueOnce({ status: "verified", account: "ana@acme.com", workspace: "Acme", workspace_id: "T9" } as never);
    const result = await f.consent.connectNew({ tenantId: "tenant", sessionId: "session", requestId: "request", vaultId: vault.id, credentialId: cred.id });
    expect(result).toEqual({ status: "connected", account: "ana@acme.com", workspace: "Acme" });
    expect((await f.bound())?.id).toBe(cred.id);
    expect(f.onApproved).toHaveBeenCalledOnce();
    expect(f.credentials.find(c => c.id === cred.id)?.display_name).toBe("Slack · ana@acme.com · Acme");
    expect(f.vaults.find(v => v.id === vault.id)?.name).toBe("Slack · Acme");
  });

  it("connectNew names identity-less accounts by when they were connected", async () => {
    const f = fixture();
    const vault = await f.services.vaults.create({ name: "Slack connection" });
    const cred = await f.services.credentials.create({ vaultId: vault.id, displayName: "Slack (OAuth)", auth: { type: "mcp_oauth", access_token: "x", mcp_server_url: SLACK } });
    f.verify.mockResolvedValueOnce({ status: "verified", message: "Service access verified." } as never);
    expect((await f.consent.connectNew({ tenantId: "tenant", sessionId: "session", requestId: "request", vaultId: vault.id, credentialId: cred.id })).status).toBe("connected");
    expect(f.credentials.find(c => c.id === cred.id)?.display_name).toMatch(/^Slack · account connected \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/);
  });

  it("connectNew refuses unverifiable accounts and foreign sessions without throwing", async () => {
    const f = fixture();
    const vault = await f.services.vaults.create({ name: "Slack connection" });
    const cred = await f.services.credentials.create({ vaultId: vault.id, displayName: "slack (OAuth)", auth: { type: "mcp_oauth", access_token: "nope", mcp_server_url: SLACK } });
    expect((await f.consent.connectNew({ tenantId: "tenant", sessionId: "session", requestId: "request", vaultId: vault.id, credentialId: cred.id })).status).toBe("unverified");
    expect((await f.consent.connectNew({ tenantId: "other", sessionId: "session", requestId: "request", vaultId: vault.id, credentialId: cred.id })).status).toBe("unverified");
    expect(await f.bound()).toBeNull();
    expect(f.onApproved).not.toHaveBeenCalled();
  });

  it("an API key is saved in its own vault and connected only if it works", async () => {
    const f = fixture();
    const bad = await (await f.post("api_key", { token: "wrong-key" })).json();
    expect(bad.status).toBe("unverified");
    const badVault = f.vaults.find(v => v.name.startsWith("Slack connection"))!;
    expect(badVault.archived_at).toBeTruthy();
    expect((await f.post("api_key", { token: "  " })).status).toBe(400);
    const good = await (await f.post("api_key", { token: "secret-selected" })).json();
    expect(good).toMatchObject({ status: "connected", account: "karim" });
    const bound = await f.bound();
    expect(bound?.auth).toMatchObject({ type: "static_bearer", mcp_server_url: SLACK });
    expect(bound?.vault_id).not.toBe("shared");
  });
});

describe("live protocol and workspace verification", () => {
  const credential = { auth: { type: "static_bearer", token: "test-token", mcp_server_url: SLACK } } as never;
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

describe("agent connection overview", () => {
  it("lists every URL server with its status and the chosen account, without touching providers", async () => {
    const f = fixture({ mcpServers: [
      { type: "url", name: "slack", url: SLACK },
      { type: "url", name: "linear", url: "https://mcp.linear.app/mcp" },
      { type: "stdio", name: "local", url: "" },
    ] });
    await f.post("use", { vault_id: "shared", credential_id: "chosen" });
    f.verify.mockClear();
    const res = await f.app.request("/access/agent/agent/status");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [
      { name: "slack", display_name: "Slack", mcp_server_url: SLACK, status: "connected", account: "karim", workspace: "Serious AI" },
      { name: "linear", display_name: "Linear", mcp_server_url: "https://mcp.linear.app/mcp", status: "pending" },
    ] });
    expect(f.verify).not.toHaveBeenCalled();
    f.credentials[0].archived_at = "now";
    const after = await (await f.app.request("/access/agent/agent/status")).json();
    expect(after.data[0]).toMatchObject({ name: "slack", status: "broken" });
    expect(after.data[0].account).toBeUndefined();
  });

  it("404s for an agent the tenant can't see", async () => {
    const f = fixture();
    f.services.agents.get = (async () => null) as never;
    expect((await f.app.request("/access/agent/nope/status")).status).toBe(404);
  });
});
