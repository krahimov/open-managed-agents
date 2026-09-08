import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { buildNodeOAuthRoutes } from "../src/lib/node-oauth-routes";

// Providers without Dynamic Client Registration (Slack) need a one-time
// OAuth app. The tenant registers it through the console (PUT /apps); the
// authorize flow prefers it over env presets; discovery reports the
// requirement so the card can guide the user BEFORE the popup dead-ends.

function stubSlackDiscovery() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://mcp.slack.com/.well-known/oauth-protected-resource/mcp") {
        return Response.json({
          resource: "https://mcp.slack.com",
          authorization_servers: ["https://mcp.slack.com"],
          scopes_supported: ["chat:write", "users:read"],
        });
      }
      if (url === "https://mcp.slack.com/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer: "https://mcp.slack.com",
          authorization_endpoint: "https://slack.com/oauth/v2_user/authorize",
          token_endpoint: "https://slack.com/api/oauth.v2.user.access",
        });
      }
      return new Response("not found", { status: 404 });
    }),
  );
}

function build(env: Record<string, string | undefined> = {}) {
  const kv = new Map<string, string>();
  const services = {
    kv: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => void kv.set(k, v),
      delete: async (k: string) => void kv.delete(k),
    },
    credentials: { listByVaults: async () => [], create: async () => ({}), update: async () => ({}) },
    vaults: { get: async () => ({ id: "vlt-1" }) },
  };
  const app = new Hono<{ Variables: { tenant_id: string } }>();
  app.use(async (c, next) => {
    c.set("tenant_id", "t1");
    await next();
  });
  app.route("/v1/oauth", buildNodeOAuthRoutes({ services: services as never, env }));
  return { app, kv };
}

const AUTHORIZE =
  "https://orrery.test/v1/oauth/authorize?mcp_server_url=https%3A%2F%2Fmcp.slack.com%2Fmcp&vault_id=vlt-1";

afterEach(() => vi.unstubAllGlobals());

describe("one-time OAuth app setup", () => {
  it("reports the Slack requirement with callback URL, steps and a manifest", async () => {
    stubSlackDiscovery();
    const { app } = build();
    const res = await app.request(
      "https://orrery.test/v1/oauth/apps/requirement?mcp_server_url=https%3A%2F%2Fmcp.slack.com%2Fmcp",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      required: boolean;
      configured: boolean;
      label: string;
      callback_uri: string;
      setup_steps: string[];
      manifest?: { oauth_config?: { redirect_urls?: string[]; scopes?: { user?: string[] } } };
      env: { client_id: string };
    };
    expect(body.required).toBe(true);
    expect(body.configured).toBe(false);
    expect(body.label).toBe("Slack");
    expect(body.callback_uri).toBe("https://orrery.test/v1/oauth/callback");
    expect(body.setup_steps.length).toBeGreaterThan(2);
    expect(body.manifest?.oauth_config?.redirect_urls).toEqual(["https://orrery.test/v1/oauth/callback"]);
    expect(body.manifest?.oauth_config?.scopes?.user).toContain("search:read.public");
    expect(body.env.client_id).toBe("SLACK_OAUTH_CLIENT_ID");
  });

  it("authorize without an app returns the structured oauth_app_required error", async () => {
    stubSlackDiscovery();
    const { app } = build();
    const res = await app.request(AUTHORIZE);
    expect(res.status).toBe(501);
    const html = await res.text();
    expect(html).toContain('"code":"oauth_app_required"');
    expect(html).toContain('"label":"Slack"');
  });

  it("stores a tenant app and the next authorize redirects to Slack with it", async () => {
    stubSlackDiscovery();
    const { app, kv } = build();
    const put = await app.request("https://orrery.test/v1/oauth/apps", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mcp_server_url: "https://mcp.slack.com/mcp",
        client_id: "123.456",
        client_secret: "shh",
      }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ ok: true, issuer: "https://mcp.slack.com", label: "Slack" });
    expect(kv.get("oauth_app:t1:https://mcp.slack.com")).toContain('"client_id":"123.456"');

    const req = await app.request(
      "https://orrery.test/v1/oauth/apps/requirement?mcp_server_url=https%3A%2F%2Fmcp.slack.com%2Fmcp",
    );
    expect(await req.json()).toMatchObject({ required: true, configured: true, source: "tenant" });

    const res = await app.request(AUTHORIZE);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe("https://slack.com/oauth/v2_user/authorize");
    expect(loc.searchParams.get("client_id")).toBe("123.456");
    expect(loc.searchParams.get("redirect_uri")).toBe("https://orrery.test/v1/oauth/callback");
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("falls back to the env preset and reports source:env", async () => {
    stubSlackDiscovery();
    const { app } = build({ SLACK_OAUTH_CLIENT_ID: "env-id", SLACK_OAUTH_CLIENT_SECRET: "env-secret" });
    const req = await app.request(
      "https://orrery.test/v1/oauth/apps/requirement?mcp_server_url=https%3A%2F%2Fmcp.slack.com%2Fmcp",
    );
    expect(await req.json()).toMatchObject({ required: true, configured: true, source: "env" });
    const res = await app.request(AUTHORIZE);
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!).searchParams.get("client_id")).toBe("env-id");
  });

  it("rejects an incomplete app registration", async () => {
    const { app } = build();
    const res = await app.request("https://orrery.test/v1/oauth/apps", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ issuer: "https://mcp.slack.com", client_id: "only-id" }),
    });
    expect(res.status).toBe(400);
  });
});
