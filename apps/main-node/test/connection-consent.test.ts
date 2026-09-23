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
});
