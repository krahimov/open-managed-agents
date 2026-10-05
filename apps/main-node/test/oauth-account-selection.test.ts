import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { buildNodeOAuthRoutes } from "../src/lib/node-oauth-routes";

afterEach(() => vi.unstubAllGlobals());

function fixture() {
  const kv = new Map<string, string>([[
    "oauth_dcr:https://mcp.linear.app|https://orrery.test/v1/oauth/callback",
    JSON.stringify({ client_id: "previous-workspace-client" }),
  ]]);
  let registrations = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: any) => {
    const url = String(input);
    if (url.includes("oauth-protected-resource")) return Response.json({ resource: "https://mcp.linear.app/mcp", authorization_servers: ["https://mcp.linear.app"], scopes_supported: ["read", "write"] });
    if (url.includes("oauth-authorization-server")) return Response.json({ issuer: "https://mcp.linear.app", authorization_endpoint: "https://mcp.linear.app/authorize", token_endpoint: "https://mcp.linear.app/token", registration_endpoint: "https://mcp.linear.app/register" });
    if (url.endsWith("/register")) return Response.json({ client_id: `separate-client-${++registrations}` });
    throw new Error(`Unexpected URL ${url}`);
  }));
  const create = vi.fn();
  const services = {
    kv: { get: async (key: string) => kv.get(key) ?? null, put: async (key: string, value: string) => { kv.set(key, value); }, delete: async (key: string) => { kv.delete(key); } },
    vaults: { get: async () => ({ id: "vault" }) },
    credentials: { create },
  };
  const app = new Hono<{ Variables: { tenant_id: string } }>();
  app.use(async (c, next) => { c.set("tenant_id", c.req.header("x-tenant") ?? "tenant-1"); await next(); });
  app.route("/oauth", buildNodeOAuthRoutes({ services: services as never }));
  const authorize = async (vault: string, choose = true, tenant = "tenant-1") => {
    const response = await app.request(`https://orrery.test/oauth/authorize?mcp_server_url=https://mcp.linear.app/mcp&vault_id=${vault}${choose ? "&account_selection=choose" : ""}`, { headers: { "x-tenant": tenant } });
    expect(response.status).toBe(302);
    return new URL(response.headers.get("location")!);
  };
  return { authorize, kv, create, registrations: () => registrations };
}

describe("choosing another provider account", () => {
  it("uses a separate client, without changing or granting a credential", async () => {
    const f = fixture();
    const url = await f.authorize("new-vault");
    expect(url.searchParams.has("prompt")).toBe(false);
    expect(url.searchParams.get("client_id")).toBe("separate-client-1");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const state = JSON.parse(f.kv.get(`oauth_state:${url.searchParams.get("state")}`)!);
    expect(state.vault_id).toBe("new-vault");
    expect(state.dcr_cache_key).toContain("oauth_dcr_connection:");
    expect(f.create).not.toHaveBeenCalled();
    expect([...f.kv.keys()].some(key => key.startsWith("connection_consent:"))).toBe(false);
  });

  it("reuses registration within a connection but isolates other connections and tenants", async () => {
    const f = fixture();
    const first = await f.authorize("vault-a");
    const retry = await f.authorize("vault-a");
    expect(retry.searchParams.get("client_id")).toBe(first.searchParams.get("client_id"));
    expect(retry.searchParams.get("state")).not.toBe(first.searchParams.get("state"));
    const other = await f.authorize("vault-b");
    const otherTenant = await f.authorize("vault-a", true, "tenant-2");
    expect(new Set([first, other, otherTenant].map(url => url.searchParams.get("client_id"))).size).toBe(3);
    expect(f.registrations()).toBe(3);
  });

  it("preserves the existing registration for ordinary reconnects", async () => {
    const f = fixture();
    const url = await f.authorize("old-vault", false);
    expect(url.searchParams.get("client_id")).toBe("previous-workspace-client");
    expect(url.searchParams.has("prompt")).toBe(false);
    expect(f.registrations()).toBe(0);
  });
});
