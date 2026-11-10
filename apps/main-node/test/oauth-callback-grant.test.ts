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

// Callback requests arrive behind the auth middleware; stand in for it.
function mount(routes: ReturnType<typeof buildNodeOAuthRoutes>, vars: Record<string, string> = { tenant_id: "t1", user_id: "u1" }) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    for (const [k, v] of Object.entries(vars)) c.set(k as never, v as never);
    await next();
  });
  return app.route("/v1/oauth", routes);
}

const baseState = {
  initiator: { tenant_id: "t1", user_id: "u1", auth: "api_key", expires_at: Date.now() + 3_600_000 },
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
    const app = mount(buildNodeOAuthRoutes({ services: f.services as never }));
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
    const app = mount(buildNodeOAuthRoutes({
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

  /** Run the success page's script in a stand-in browser window. */
  function runCallbackScript(html: string, opener: unknown) {
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;
    const win = { opener, close: vi.fn(), location: { href: "" } };
    const posted: unknown[] = [];
    class FakeChannel {
      postMessage(m: unknown) { posted.push(m); }
      close() {}
    }
    new Function("window", "BroadcastChannel", script)(win, FakeChannel);
    return { win, posted };
  }

  it("oma connect: the success page still navigates to the CLI's localhost redirect after broadcasting", async () => {
    stubUpstreams();
    const f = fakeServices({ ...baseState, redirect_uri: "http://localhost:19300/callback" });
    const res = await mount(buildNodeOAuthRoutes({ services: f.services as never })).request(
      "https://api.example/v1/oauth/callback?code=abc&state=st1",
    );
    expect(res.status).toBe(200);
    // OS-opened tab: no opener, BroadcastChannel available (every modern browser).
    const { win, posted } = runCallbackScript(await res.text(), null);
    expect(posted).toHaveLength(1);
    expect(win.close).not.toHaveBeenCalled();
    const to = new URL(win.location.href);
    expect(`${to.origin}${to.pathname}`).toBe("http://localhost:19300/callback");
    expect(to.searchParams.get("oauth")).toBe("success");
  });

  it("console popup: the success page notifies and closes instead of navigating", async () => {
    stubUpstreams();
    const f = fakeServices(baseState);
    const res = await mount(buildNodeOAuthRoutes({ services: f.services as never })).request(
      "https://api.example/v1/oauth/callback?code=abc&state=st1",
    );
    const opener = { closed: false, postMessage: vi.fn() };
    const { win } = runCallbackScript(await res.text(), opener);
    expect(opener.postMessage).toHaveBeenCalledTimes(1);
    expect(win.close).toHaveBeenCalledTimes(1);
    expect(win.location.href).toBe("");
  });

  it("console popup on a localhost console (local dev, self-host) still closes instead of loading the console in the popup", async () => {
    stubUpstreams();
    const f = fakeServices({ ...baseState, redirect_uri: "http://localhost:8787/vaults/vlt-1" });
    const res = await mount(buildNodeOAuthRoutes({ services: f.services as never })).request(
      "https://api.example/v1/oauth/callback?code=abc&state=st1",
    );
    const opener = { closed: false, postMessage: vi.fn() };
    const { win } = runCallbackScript(await res.text(), opener);
    expect(opener.postMessage).toHaveBeenCalledTimes(1);
    expect(win.close).toHaveBeenCalledTimes(1);
    expect(win.location.href).toBe("");
  });

  it("an https console tab with no opener closes once it has broadcast", async () => {
    stubUpstreams();
    const f = fakeServices(baseState);
    const res = await mount(buildNodeOAuthRoutes({ services: f.services as never })).request(
      "https://api.example/v1/oauth/callback?code=abc&state=st1",
    );
    const { win, posted } = runCallbackScript(await res.text(), null);
    expect(posted).toHaveLength(1);
    expect(win.close).toHaveBeenCalledTimes(1);
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
    const app = mount(buildNodeOAuthRoutes({ services: services as never, onGranted: async (g) => void grants.push(g) }),
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
    const app = mount(buildNodeOAuthRoutes({ services: services as never }));
    const res = await app.request("https://api.example/v1/oauth/callback?error=access_denied&state=st1");
    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("skips onGranted (grant_recorded:false) for flows started outside a session, e.g. the vault page", async () => {
    stubUpstreams();
    const grants: GrantNotification[] = [];
    const f = fakeServices(baseState);
    const app = mount(buildNodeOAuthRoutes({ services: f.services as never, onGranted: async (g) => void grants.push(g) }),
    );
    const res = await app.request("https://api.example/v1/oauth/callback?code=abc&state=st1");
    expect(res.status).toBe(200);
    expect(grants).toEqual([]);
    expect(await res.text()).toContain('"grant_recorded":false');
  });

  it("still completes (grant_recorded:false) when onGranted throws — the credential is already stored", async () => {
    stubUpstreams();
    const f = fakeServices({ ...baseState, session_id: "sess-1", request_id: "acreq-1", service: "sentry" });
    const app = mount(buildNodeOAuthRoutes({
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

describe("oauth callback success page", () => {
  it("keeps MCP-server and caller-supplied strings inside the inline script (no </script> breakout)", async () => {
    const payload = "</script><script>window.pwned=1</script>";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.endsWith("/oauth/token")) return Response.json({ access_token: "at", expires_in: 3600 });
        // The MCP server writes the probe failure text.
        return new Response(payload, { status: 401 });
      }),
    );
    const f = fakeServices({ ...baseState, service: `x${payload}` });
    const res = await mount(buildNodeOAuthRoutes({ services: f.services as never })).request(
      "https://api.example/v1/oauth/callback?code=abc&state=st1",
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    // Only the page's own script element; the payload survives as data.
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(html).not.toContain(payload);
    const msg = JSON.parse(/var msg = (\{.*?\});\n/s.exec(html)![1]!);
    expect(msg.service).toBe(`x${payload}`);
    expect(msg.probe_message).toContain(payload);
  });
});

describe("Telegram MCP OAuth completion receipts", () => {
  it("writes a receipt only after credentials are stored, and does not accept a query-supplied key", async () => {
    stubUpstreams();
    const f = fakeServices({ ...baseState, completion_key: "telegram_oauth:trusted-flow" });
    const app = mount(buildNodeOAuthRoutes({ services: f.services as never }));
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
    const app = mount(buildNodeOAuthRoutes({ services: f.services as never }));
    const response = await app.request("https://api.example/v1/oauth/callback?code=abc&state=st1");
    expect(response.status).toBe(500);
    expect(f.kv.has("telegram_oauth:trusted-flow")).toBe(false);
  });
});

describe("oauth callback is bound to the initiator", () => {
  // Discovery + DCR + token + probe in one stub, for authorize → callback round trips.
  function stubAll() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes("oauth-protected-resource")) {
          return Response.json({ resource: "https://mcp.sentry.dev/mcp", authorization_servers: ["https://mcp.sentry.dev"] });
        }
        if (url.includes("oauth-authorization-server")) {
          return Response.json({
            issuer: "https://mcp.sentry.dev",
            authorization_endpoint: "https://mcp.sentry.dev/oauth/authorize",
            token_endpoint: "https://mcp.sentry.dev/oauth/token",
            registration_endpoint: "https://mcp.sentry.dev/oauth/register",
          });
        }
        if (url.endsWith("/oauth/register")) return Response.json({ client_id: "dcr-client" });
        if (url.endsWith("/oauth/token")) return Response.json({ access_token: "at", refresh_token: "rt", expires_in: 3600 });
        return new Response("{}", { status: 200 });
      }),
    );
  }

  const startQuery = "mcp_server_url=https%3A%2F%2Fmcp.sentry.dev%2Fmcp&vault_id=vlt-1";

  /** POST /start-token as the console does (fetch, JSON, same-origin). */
  async function mintToken(
    routes: ReturnType<typeof buildNodeOAuthRoutes>,
    vars: Record<string, string>,
    query = startQuery,
    headers: Record<string, string> = { "content-type": "application/json", "sec-fetch-site": "same-origin" },
  ) {
    return mount(routes, vars).request("https://api.example/v1/oauth/start-token", {
      method: "POST",
      headers,
      body: JSON.stringify({ query }),
    });
  }

  /** Start a flow as `vars` and return what the browser walks away with. */
  async function start(vars: Record<string, string>) {
    const f = fakeServices(baseState);
    f.kv.delete("oauth_state:st1");
    const routes = buildNodeOAuthRoutes({ services: f.services as never });
    let url = `https://api.example/v1/oauth/authorize?${startQuery}`;
    if (vars.auth_type === "session") {
      const minted = await mintToken(routes, vars);
      expect(minted.status).toBe(200);
      url += `&oauth_confirm=${encodeURIComponent(((await minted.json()) as { token: string }).token)}`;
    }
    const res = await mount(routes, vars).request(url, {
      headers: { "sec-fetch-site": "same-origin", "sec-fetch-dest": "document" },
    });
    expect(res.status).toBe(302);
    const state = new URL(res.headers.get("location")!).searchParams.get("state")!;
    const setCookie = res.headers.get("set-cookie");
    const cookie = setCookie ? setCookie.split(";")[0] : undefined;
    const callback = (as: Record<string, string>, opts: { cookie?: string } = {}) =>
      mount(routes, as).request(`https://api.example/v1/oauth/callback?code=abc&state=${state}`, {
        headers: opts.cookie ? { cookie: opts.cookie } : {},
      });
    return { f, state, setCookie, cookie, callback };
  }

  const alice = { tenant_id: "t1", user_id: "alice", auth_type: "session" };

  it("session flow: sets an HttpOnly SameSite=Lax nonce cookie and stores who started it", async () => {
    stubAll();
    const { f, state, setCookie } = await start(alice);
    expect(setCookie).toMatch(/^oma_oauth_[A-Za-z0-9_-]+=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Path=\/v1\/oauth/);
    expect(setCookie).toMatch(/Secure/);
    expect(setCookie).not.toContain(state);
    const stored = JSON.parse(f.kv.get(`oauth_state:${state}`)!);
    expect(stored.initiator).toMatchObject({ tenant_id: "t1", user_id: "alice", auth: "session" });
    expect(stored.initiator.nonce_hash).toEqual(expect.any(String));
  });

  it("session flow completes for the same user in the same browser", async () => {
    stubAll();
    const { f, cookie, callback } = await start(alice);
    const res = await callback(alice, { cookie });
    expect(res.status).toBe(200);
    expect(f.created).toHaveLength(1);
    // The nonce cookie is cleared once used.
    expect(res.headers.get("set-cookie")).toMatch(/Max-Age=0/);
  });

  it("rejects a different console user finishing the flow (account mix-up)", async () => {
    stubAll();
    const { f, cookie, callback } = await start(alice);
    const res = await callback({ tenant_id: "t2", user_id: "mallory", auth_type: "session" }, { cookie });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("different user");
    expect(f.created).toHaveLength(0);
  });

  it("rejects the same user without the nonce cookie (link opened in another browser)", async () => {
    stubAll();
    const { f, callback } = await start(alice);
    const res = await callback(alice);
    expect(res.status).toBe(403);
    expect(f.created).toHaveLength(0);
  });

  it("rejects a forged nonce cookie", async () => {
    stubAll();
    const { f, cookie, callback } = await start(alice);
    const forged = `${cookie!.split("=")[0]}=not-the-nonce`;
    expect((await callback(alice, { cookie: forged })).status).toBe(403);
    expect(f.created).toHaveLength(0);
  });

  it("is single use: a replayed callback finds no state", async () => {
    stubAll();
    const { f, cookie, callback } = await start(alice);
    expect((await callback(alice, { cookie })).status).toBe(200);
    expect((await callback(alice, { cookie })).status).toBe(400);
    expect(f.created).toHaveLength(1);
  });

  it("a rejected attempt also burns the state, so it can't be retried by someone else", async () => {
    stubAll();
    const { f, cookie, callback } = await start(alice);
    expect((await callback({ tenant_id: "t2", user_id: "mallory", auth_type: "session" })).status).toBe(403);
    expect((await callback(alice, { cookie })).status).toBe(400);
    expect(f.created).toHaveLength(0);
  });

  it("API-key flow: no cookie; bound to the key's user at the callback", async () => {
    stubAll();
    const { f, setCookie, callback } = await start({ tenant_id: "t1", user_id: "alice", auth_type: "api_key" });
    expect(setCookie).toBeNull();
    expect((await callback({ tenant_id: "t1", user_id: "bob", auth_type: "session" })).status).toBe(403);
    expect(f.created).toHaveLength(0);
  });

  it("API-key flow completes when the key's user signs in to finish it", async () => {
    stubAll();
    const { f, callback } = await start({ tenant_id: "t1", user_id: "alice", auth_type: "api_key" });
    expect((await callback(alice)).status).toBe(200);
    expect(f.created).toHaveLength(1);
  });

  it("legacy user-less API key: any session in the key's tenant may finish, other tenants may not", async () => {
    stubAll();
    const a = await start({ tenant_id: "t1", auth_type: "api_key" });
    expect((await a.callback({ tenant_id: "t2", user_id: "mallory", auth_type: "session" })).status).toBe(403);
    const b = await start({ tenant_id: "t1", auth_type: "api_key" });
    expect((await b.callback({ tenant_id: "t1", user_id: "carol", auth_type: "session" })).status).toBe(200);
    expect(b.f.created).toHaveLength(1);
  });

  it("refuses a cookie-session start triggered by another site (forced-start login CSRF)", async () => {
    stubAll();
    const f = fakeServices(baseState);
    const routes = buildNodeOAuthRoutes({ services: f.services as never });
    const url = "https://api.example/v1/oauth/authorize?mcp_server_url=https://mcp.sentry.dev/mcp&vault_id=vlt-1";
    const crossSite = await mount(routes, alice).request(url, { headers: { "sec-fetch-site": "cross-site" } });
    expect(crossSite.status).toBe(403);
    expect(crossSite.headers.get("set-cookie")).toBeNull();
    expect((await mount(routes, alice).request(url, { headers: { "sec-fetch-site": "same-site" } })).status).toBe(403);
    // API-key starts aren't browser navigations; the header doesn't apply.
    const viaKey = { tenant_id: "t1", user_id: "alice", auth_type: "api_key" };
    expect((await mount(routes, viaKey).request(url, { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(302);
  });

  describe("same-origin is not proof the console started it (agent-written links in chat)", () => {
    const url = `https://api.example/v1/oauth/authorize?mcp_server_url=https://evil.example/mcp&new_vault_name=r&session_id=s1`;

    it("a same-origin link click without a start token gets the confirm page, never a 302", async () => {
      stubAll();
      const f = fakeServices(baseState);
      f.kv.delete("oauth_state:st1");
      const routes = buildNodeOAuthRoutes({ services: f.services as never });
      const res = await mount(routes, alice).request(url, {
        headers: { "sec-fetch-site": "same-origin", "sec-fetch-dest": "document" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(await res.text()).toContain("Connect evil.example?");
      expect([...f.kv.keys()].some((k) => k.startsWith("oauth_state:"))).toBe(false);
    });

    it("an <img>, fetch or iframe request to /authorize is refused outright", async () => {
      stubAll();
      const f = fakeServices(baseState);
      f.kv.delete("oauth_state:st1");
      const routes = buildNodeOAuthRoutes({ services: f.services as never });
      for (const dest of ["image", "empty", "iframe"]) {
        const res = await mount(routes, alice).request(url, {
          headers: { "sec-fetch-site": "same-origin", "sec-fetch-dest": dest },
        });
        expect(res.status).toBe(403);
      }
      // No confirm token was minted for any of them either.
      expect([...f.kv.keys()].some((k) => k.startsWith("oauth_start:") || k.startsWith("oauth_state:"))).toBe(false);
    });

    it("the console's fetch-minted token starts the flow once, for that exact query only", async () => {
      stubAll();
      const routes = buildNodeOAuthRoutes({ services: fakeServices(baseState).services as never });
      // Param order doesn't matter; the token is bound to the parameters.
      const minted = await mintToken(routes, alice, "vault_id=vlt-1&mcp_server_url=https%3A%2F%2Fmcp.sentry.dev%2Fmcp");
      expect(minted.status).toBe(200);
      expect(minted.headers.get("cache-control")).toBe("no-store");
      const { token } = (await minted.json()) as { token: string };
      const go = `https://api.example/v1/oauth/authorize?${startQuery}&oauth_confirm=${encodeURIComponent(token)}`;
      expect((await mount(routes, alice).request(go, { headers: { "sec-fetch-site": "same-origin" } })).status).toBe(302);
      expect((await mount(routes, alice).request(go, { headers: { "sec-fetch-site": "same-origin" } })).status).toBe(403);

      const other = (await (await mintToken(routes, alice)).json()) as { token: string };
      const swapped = `https://api.example/v1/oauth/authorize?mcp_server_url=https%3A%2F%2Fevil.example%2Fmcp&vault_id=vlt-1&oauth_confirm=${encodeURIComponent(other.token)}`;
      expect((await mount(routes, alice).request(swapped)).status).toBe(403);
      const mallory = { tenant_id: "t1", user_id: "mallory", auth_type: "session" };
      const forAlice = (await (await mintToken(routes, alice)).json()) as { token: string };
      expect((await mount(routes, mallory).request(
        `https://api.example/v1/oauth/authorize?${startQuery}&oauth_confirm=${encodeURIComponent(forAlice.token)}`,
      )).status).toBe(403);
    });

    it("start tokens are minted only for a same-origin JSON POST from a console session", async () => {
      const routes = buildNodeOAuthRoutes({ services: fakeServices(baseState).services as never });
      expect((await mintToken(routes, alice, startQuery, { "content-type": "application/json", "sec-fetch-site": "cross-site" })).status).toBe(403);
      expect((await mintToken(routes, alice, startQuery, { "content-type": "application/json", "sec-fetch-site": "same-site" })).status).toBe(403);
      expect((await mintToken(routes, alice, startQuery, { "content-type": "text/plain", "sec-fetch-site": "same-origin" })).status).toBe(415);
      expect((await mintToken(routes, alice, "vault_id=vlt-1")).status).toBe(400);
      expect((await mintToken(routes, { tenant_id: "t1", user_id: "alice", auth_type: "api_key" })).status).toBe(400);
      // A browser without Sec-Fetch-* headers can still mint.
      expect((await mintToken(routes, alice, startQuery, { "content-type": "application/json" })).status).toBe(200);
    });
  });

  describe("a start with no web initiator (Sec-Fetch-Site none / missing) must be confirmed", () => {
    const url = "https://api.example/v1/oauth/authorize?mcp_server_url=https://mcp.sentry.dev/mcp&vault_id=vlt-1";
    /** Render the confirm page and pull out its Continue link. */
    async function confirmPage(routes: ReturnType<typeof buildNodeOAuthRoutes>, headers: Record<string, string>) {
      const res = await mount(routes, alice).request(url, { headers });
      expect(res.status).toBe(200);
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      const html = await res.text();
      expect(html).toContain("mcp.sentry.dev");
      const href = /<a href="([^"]+)">Continue<\/a>/.exec(html)![1]!.replace(/&amp;/g, "&");
      return new URL(href, "https://api.example").toString();
    }

    it("a link opened from a desktop app (none) or a browser without the header shows a confirm page, not a 302", async () => {
      stubAll();
      const f = fakeServices(baseState);
      f.kv.delete("oauth_state:st1");
      const routes = buildNodeOAuthRoutes({ services: f.services as never });
      await confirmPage(routes, { "sec-fetch-site": "none" });
      await confirmPage(routes, {});
      // No flow state was minted for either.
      expect([...f.kv.keys()].some((k) => k.startsWith("oauth_state:"))).toBe(false);
    });

    it("Continue starts the flow once; the token can't be replayed", async () => {
      stubAll();
      const f = fakeServices(baseState);
      const routes = buildNodeOAuthRoutes({ services: f.services as never });
      const next = await confirmPage(routes, { "sec-fetch-site": "none" });
      const go = await mount(routes, alice).request(next, { headers: { "sec-fetch-site": "same-origin" } });
      expect(go.status).toBe(302);
      expect(go.headers.get("set-cookie")).toMatch(/^oma_oauth_/);
      // Same token again (even from a header-less browser) is refused.
      expect((await mount(routes, alice).request(next)).status).toBe(403);
    });

    it("a header-less browser can finish the confirm with the token", async () => {
      stubAll();
      const routes = buildNodeOAuthRoutes({ services: fakeServices(baseState).services as never });
      const next = await confirmPage(routes, {});
      expect((await mount(routes, alice).request(next)).status).toBe(302);
    });

    it("the token is bound to the user and to the exact request", async () => {
      stubAll();
      const routes = buildNodeOAuthRoutes({ services: fakeServices(baseState).services as never });
      const mallory = { tenant_id: "t1", user_id: "mallory", auth_type: "session" };
      const forOther = await confirmPage(routes, {});
      expect((await mount(routes, mallory).request(forOther)).status).toBe(403);

      const altered = new URL(await confirmPage(routes, {}));
      altered.searchParams.set("mcp_server_url", "https://evil.example/mcp");
      expect((await mount(routes, alice).request(altered.toString())).status).toBe(403);

      const forged = new URL(url);
      forged.searchParams.set("oauth_confirm", "made-up");
      expect((await mount(routes, alice).request(forged.toString())).status).toBe(403);
    });

    it("a repeated key (percent-encoded or literal) never gets a confirm page or a token", async () => {
      stubAll();
      const f = fakeServices(baseState);
      f.kv.delete("oauth_state:st1");
      const routes = buildNodeOAuthRoutes({ services: f.services as never });
      // Hono reads the first literal key (Linear) for the page; re-serialized,
      // the encoded copy (evil) would come first and the handler would use it.
      const smuggled = [
        "https://api.example/v1/oauth/authorize?mcp%5Fserver%5Furl=https://evil.example/mcp&mcp_server_url=https://mcp.linear.app/mcp&vault_id=vlt-1",
        "https://api.example/v1/oauth/authorize?mcp_server_url=https://mcp.linear.app/mcp&mcp_server_url=https://evil.example/mcp&vault_id=vlt-1",
        "https://api.example/v1/oauth/authorize?mcp_server_url=https://mcp.linear.app/mcp&vault_id=vlt-1&vault%5Fid=vlt-2",
      ];
      for (const u of smuggled) {
        for (const headers of [{ "sec-fetch-site": "none" }, { "sec-fetch-site": "same-origin" }, {}]) {
          const res = await mount(routes, alice).request(u, { headers });
          expect(res.status).toBe(403);
          expect(await res.text()).not.toContain("Continue");
        }
      }
      expect([...f.kv.keys()].some((k) => k.startsWith("oauth_start:") || k.startsWith("oauth_state:"))).toBe(false);
      // API-key callers aren't gated; this is about what a victim's browser is shown.
    });

    it("Continue repeats the original query as sent, plus the token", async () => {
      stubAll();
      const routes = buildNodeOAuthRoutes({ services: fakeServices(baseState).services as never });
      const raw = "mcp%5Fserver%5Furl=https://mcp.sentry.dev/mcp&vault_id=vlt-1&oauth_confirm=";
      const res = await mount(routes, alice).request(`https://api.example/v1/oauth/authorize?${raw}`, {
        headers: { "sec-fetch-site": "none" },
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Connect mcp.sentry.dev?");
      const href = /<a href="([^"]+)">Continue<\/a>/.exec(html)![1]!.replace(/&amp;/g, "&");
      expect(href).toMatch(/^\/v1\/oauth\/authorize\?mcp%5Fserver%5Furl=https:\/\/mcp\.sentry\.dev\/mcp&vault_id=vlt-1&oauth_confirm=[A-Za-z0-9_-]+$/);
      const go = await mount(routes, alice).request(new URL(href, "https://api.example").toString());
      expect(go.status).toBe(302);
      expect(new URL(go.headers.get("location")!).origin).toBe("https://mcp.sentry.dev");
    });
  });

  it("rejects an expired state even if the KV entry outlived its TTL", async () => {
    stubUpstreams();
    const f = fakeServices({ ...baseState, initiator: { ...baseState.initiator, expires_at: Date.now() - 1 } });
    const res = await mount(buildNodeOAuthRoutes({ services: f.services as never })).request(
      "https://api.example/v1/oauth/callback?code=abc&state=st1",
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("expired");
    expect(f.created).toHaveLength(0);
  });

  it("rejects a state written before initiator binding", async () => {
    stubUpstreams();
    const { initiator: _drop, ...legacy } = baseState;
    const f = fakeServices(legacy);
    const res = await mount(buildNodeOAuthRoutes({ services: f.services as never })).request(
      "https://api.example/v1/oauth/callback?code=abc&state=st1",
    );
    expect(res.status).toBe(403);
    expect(f.created).toHaveLength(0);
    expect(f.kv.has("oauth_state:st1")).toBe(false);
  });
});
