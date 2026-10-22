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

describe("oauth callback grant recording", () => {
  it("binds the new account to the card's agent when the sign-in came from a connect card", async () => {
    stubUpstreams();
    const grants: GrantNotification[] = [];
    const connects: unknown[] = [];
    const f = fakeServices({ ...baseState, session_id: "sess-1", request_id: "acreq-1", service: "sentry" });
    const app = new Hono().route(
      "/v1/oauth",
      buildNodeOAuthRoutes({
        services: f.services as never,
        onGranted: async (g) => void grants.push(g),
        onConnected: async (input) => {
          connects.push(input);
          return { status: "connected", account: "ana@acme.com", workspace: "Acme" };
        },
      }),
    );
    const res = await app.request("https://api.example/v1/oauth/callback?code=abc&state=st1");
    expect(res.status).toBe(200);
    const html = await res.text();
    // The card path owns the grant; the legacy onGranted nudge must not double it.
    expect(grants).toEqual([]);
    expect(connects).toEqual([{ tenantId: "t1", sessionId: "sess-1", requestId: "acreq-1", vaultId: "vlt-1", credentialId: "cred-new" }]);
    expect(f.created).toHaveLength(1);
    expect(html).toContain('"grant_recorded":true');
    expect(html).toContain('"connected":true');
    expect(html).toContain('"account":"ana@acme.com"');
    expect(html).toContain('"request_id":"acreq-1"');
    expect(html).toContain('"service":"sentry"');
    expect(html).toContain("Sentry connected as ana@acme.com · Acme");
  });

  it("keeps the popup open with the reason when the new account can't be verified", async () => {
    stubUpstreams();
    const f = fakeServices({ ...baseState, session_id: "sess-1", request_id: "acreq-1", service: "sentry" });
    const app = new Hono().route(
      "/v1/oauth",
      buildNodeOAuthRoutes({
        services: f.services as never,
        onConnected: async () => ({ status: "unverified", message: "Authentication could not be verified." }),
      }),
    );
    const html = await (await app.request("https://api.example/v1/oauth/callback?code=abc&state=st1")).text();
    expect(html).toContain('"grant_recorded":false');
    expect(html).toContain('"connected":false');
    expect(html).toContain('"connect_error":"Authentication could not be verified."');
    expect(html).toContain("isn&#39;t connected yet");
    expect(html).toContain("if (false) window.close()");
  });

  it("provider-controlled names can't break out of the callback page's script", async () => {
    stubUpstreams();
    const f = fakeServices({ ...baseState, session_id: "sess-1", request_id: "acreq-1", service: "sentry</script><script>alert(2)</script>" });
    const app = new Hono().route(
      "/v1/oauth",
      buildNodeOAuthRoutes({
        services: f.services as never,
        onConnected: async () => ({ status: "connected", account: "a", workspace: "</script><script>alert(1)</script>" }),
      }),
    );
    const html = await (await app.request("https://api.example/v1/oauth/callback?code=abc&state=st1")).text();
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("\\u003c/script\\u003e\\u003cscript\\u003ealert(1)");
  });

  it("treats a throwing onConnected as not connected — the credential is already stored", async () => {
    stubUpstreams();
    const f = fakeServices({ ...baseState, session_id: "sess-1", request_id: "acreq-1", service: "sentry" });
    const app = new Hono().route(
      "/v1/oauth",
      buildNodeOAuthRoutes({
        services: f.services as never,
        onConnected: async () => {
          throw new Error("router down");
        },
      }),
    );
    const res = await app.request("https://api.example/v1/oauth/callback?code=abc&state=st1");
    expect(res.status).toBe(200);
    expect(f.created).toHaveLength(1);
    const html = await res.text();
    expect(html).toContain('"grant_recorded":false');
    expect(html).not.toContain("router down");
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

describe("token responses from Slack", () => {
  function stubToken(body: unknown) {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/oauth/token")) return Response.json(body);
      return new Response("{}", { status: 200 });
    }));
  }
  it("shows Slack's own error code (HTTP 200 + ok:false) instead of a generic failure", async () => {
    stubToken({ ok: false, error: "invalid_code" });
    const f = fakeServices(baseState);
    const app = new Hono().route("/v1/oauth", buildNodeOAuthRoutes({ services: f.services as never }));
    const res = await app.request("https://api.example/v1/oauth/callback?code=abc&state=st1");
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("Provider error: invalid_code");
    expect(f.created).toHaveLength(0);
  });
  it("accepts the user token Slack nests under authed_user", async () => {
    stubToken({ ok: true, authed_user: { access_token: "xoxp-user", refresh_token: "xoxe-r", expires_in: 3600 } });
    const f = fakeServices(baseState);
    const app = new Hono().route("/v1/oauth", buildNodeOAuthRoutes({ services: f.services as never }));
    const res = await app.request("https://api.example/v1/oauth/callback?code=abc&state=st1");
    expect(res.status).toBe(200);
    expect((f.created[0] as { auth: { access_token: string; refresh_token: string } }).auth).toMatchObject({ access_token: "xoxp-user", refresh_token: "xoxe-r" });
  });
});
