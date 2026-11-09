import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { buildNodeOAuthRoutes, type GrantNotification } from "../src/lib/node-oauth-routes";

// The vault MCP OAuth callback must record the grant SERVER-SIDE when the
// connect card handed it a session_id/request_id — the browser popup → card
// handoff was the only path before and silently dropped grants (2026-09-02:
// Sentry credential stored, agent never told).

function fakeServices(state: Record<string, unknown>) {
  const kv = new Map<string, string>();
  kv.set("oauth_state:st1", JSON.stringify(state));
  const created: unknown[] = [];
  return {
    created,
    kv,
    services: {
      kv: {
        get: async (k: string) => kv.get(k) ?? null,
        put: async (k: string, v: string) => void kv.set(k, v),
        delete: async (k: string) => void kv.delete(k),
      },
      credentials: {
        listByVaults: async () => [],
        create: async (input: unknown) => {
          created.push(input);
          return { id: "cred-new" };
        },
        update: async () => ({}),
      },
      vaults: { get: async () => ({ id: "vlt-1" }) },
    },
  };
}

function stubUpstreams() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/oauth/token")) {
        return Response.json({ access_token: "at", refresh_token: "rt", expires_in: 3600 });
      }
      // MCP probe (tools/list)
      return new Response("{}", { status: 200 });
    }),
  );
}

const baseState = {
  tenant_id: "t1",
  vault_id: "vlt-1",
  mcp_server_url: "https://mcp.sentry.dev/mcp",
  code_verifier: "v",
  client_id: "c",
  token_endpoint: "https://mcp.sentry.dev/oauth/token",
  authorization_server: "https://mcp.sentry.dev",
  redirect_uri: "https://console.example/sessions/s1",
  resource_uri: "https://mcp.sentry.dev/mcp",
};

afterEach(() => vi.unstubAllGlobals());

describe("oauth authorize for Switch account", () => {
  function stubDiscovery() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes("oauth-protected-resource")) {
          return Response.json({
            resource: "https://mcp.sentry.dev/mcp",
            authorization_servers: ["https://mcp.sentry.dev"],
          });
        }
        if (url.includes("oauth-authorization-server")) {
          return Response.json({
            issuer: "https://mcp.sentry.dev",
            authorization_endpoint: "https://mcp.sentry.dev/oauth/authorize",
            token_endpoint: "https://mcp.sentry.dev/oauth/token",
            registration_endpoint: "https://mcp.sentry.dev/oauth/register",
          });
        }
        return Response.json({ client_id: "dcr-client" });
      }),
    );
  }
  const authorize = (query: string) => {
    const f = fakeServices(baseState);
    const app = new Hono().route("/v1/oauth", buildNodeOAuthRoutes({ services: f.services as never }));
    return app.request(`https://api.example/v1/oauth/authorize?mcp_server_url=https://mcp.sentry.dev/mcp&${query}`);
  };

  it("asks the provider for an account choice when saving into a new vault", async () => {
    stubDiscovery();
    const res = await authorize("new_vault_name=sentry%20%C2%B7%20A");
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!).searchParams.get("prompt")).toBe("select_account");
  });

  it("leaves a plain Connect flow's sign-in unchanged", async () => {
    stubDiscovery();
    const res = await authorize("vault_id=vlt-1");
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!).searchParams.has("prompt")).toBe(false);
  });

  it("still requires somewhere to save the login", async () => {
    expect((await authorize("service=sentry")).status).toBe(400);
  });
});

describe("oauth callback grant recording", () => {
  it("calls onGranted with the session/request from the flow and tells the popup grant_recorded", async () => {
    stubUpstreams();
    const grants: GrantNotification[] = [];
    const f = fakeServices({ ...baseState, session_id: "sess-1", request_id: "acreq-1", service: "sentry" });
    const app = new Hono().route(
      "/v1/oauth",
      buildNodeOAuthRoutes({
        services: f.services as never,
        onGranted: async (g) => void grants.push(g),
      }),
    );
    const res = await app.request("https://api.example/v1/oauth/callback?code=abc&state=st1");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(grants).toEqual([
      {
        tenantId: "t1",
        sessionId: "sess-1",
        requestId: "acreq-1",
        service: "sentry",
        vaultId: "vlt-1",
        mcpServerUrl: "https://mcp.sentry.dev/mcp",
      },
    ]);
    expect(f.created).toHaveLength(1);
    expect(html).toContain('"grant_recorded":true');
    expect(html).toContain('"request_id":"acreq-1"');
    expect(html).toContain('"service":"sentry"');
  });

  it("saves a switched account in a new vault and never touches the shared one", async () => {
    stubUpstreams();
    const grants: GrantNotification[] = [];
    const f = fakeServices({
      ...baseState,
      vault_id: undefined,
      new_vault_name: "sentry · Incident commander",
      session_id: "sess-1",
      request_id: "acreq-1",
      service: "sentry",
    });
    const newVaults: unknown[] = [];
    const update = vi.fn(async () => ({}));
    const services = {
      ...f.services,
      credentials: { ...f.services.credentials, update },
      vaults: {
        ...f.services.vaults,
        create: async (input: unknown) => {
          newVaults.push(input);
          return { id: "vlt-new" };
        },
      },
    };
    const app = new Hono().route(
      "/v1/oauth",
      buildNodeOAuthRoutes({ services: services as never, onGranted: async (g) => void grants.push(g) }),
    );
    const res = await app.request("https://api.example/v1/oauth/callback?code=abc&state=st1");
    expect(res.status).toBe(200);
    expect(newVaults).toEqual([{ tenantId: "t1", name: "sentry · Incident commander" }]);
    expect(f.created).toEqual([expect.objectContaining({ vaultId: "vlt-new" })]);
    expect(update).not.toHaveBeenCalled();
    expect(grants[0]).toMatchObject({ vaultId: "vlt-new", requestId: "acreq-1" });
    expect(await res.text()).toContain('"vault_id":"vlt-new"');
  });

  it("creates no vault when the provider refuses a switch", async () => {
    stubUpstreams();
    const f = fakeServices({ ...baseState, vault_id: undefined, new_vault_name: "sentry · A" });
    const create = vi.fn(async () => ({ id: "vlt-new" }));
    const services = { ...f.services, vaults: { ...f.services.vaults, create } };
    const app = new Hono().route("/v1/oauth", buildNodeOAuthRoutes({ services: services as never }));
    const res = await app.request("https://api.example/v1/oauth/callback?error=access_denied&state=st1");
    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("skips onGranted (grant_recorded:false) for flows started outside a session, e.g. the vault page", async () => {
    stubUpstreams();
    const grants: GrantNotification[] = [];
    const f = fakeServices(baseState);
    const app = new Hono().route(
      "/v1/oauth",
      buildNodeOAuthRoutes({ services: f.services as never, onGranted: async (g) => void grants.push(g) }),
    );
    const res = await app.request("https://api.example/v1/oauth/callback?code=abc&state=st1");
    expect(res.status).toBe(200);
    expect(grants).toEqual([]);
    expect(await res.text()).toContain('"grant_recorded":false');
  });

  it("still completes (grant_recorded:false) when onGranted throws — the credential is already stored", async () => {
    stubUpstreams();
    const f = fakeServices({ ...baseState, session_id: "sess-1", request_id: "acreq-1", service: "sentry" });
    const app = new Hono().route(
      "/v1/oauth",
      buildNodeOAuthRoutes({
        services: f.services as never,
        onGranted: async () => {
          throw new Error("router down");
        },
      }),
    );
    const res = await app.request("https://api.example/v1/oauth/callback?code=abc&state=st1");
    expect(res.status).toBe(200);
    expect(f.created).toHaveLength(1);
    expect(await res.text()).toContain('"grant_recorded":false');
  });
});

describe("Telegram MCP OAuth completion receipts", () => {
  it("writes a receipt only after credentials are stored, and does not accept a query-supplied key", async () => {
    stubUpstreams();
    const f = fakeServices({ ...baseState, completion_key: "telegram_oauth:trusted-flow" });
    const app = new Hono().route("/v1/oauth", buildNodeOAuthRoutes({ services: f.services as never }));
    const response = await app.request("https://api.example/v1/oauth/callback?code=abc&state=st1&completion_key=telegram_oauth:forged");
    expect(response.status).toBe(200);
    expect(f.created).toHaveLength(1);
    expect(f.kv.get("telegram_oauth:trusted-flow")).toBe("complete");
    expect(f.kv.has("telegram_oauth:forged")).toBe(false);
    expect(f.kv.has("oauth_state:st1")).toBe(false);
  });
  it("never issues a receipt if credential storage fails", async () => {
    stubUpstreams();
    const f = fakeServices({ ...baseState, completion_key: "telegram_oauth:trusted-flow" });
    f.services.credentials.create = async () => { throw new Error("storage unavailable"); };
    const app = new Hono().route("/v1/oauth", buildNodeOAuthRoutes({ services: f.services as never }));
    const response = await app.request("https://api.example/v1/oauth/callback?code=abc&state=st1");
    expect(response.status).toBe(500);
    expect(f.kv.has("telegram_oauth:trusted-flow")).toBe(false);
  });
});
