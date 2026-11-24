// Connect links for apps Composio has no managed sign-in for.
//
// Regression for prod 2026-11-24: creating an agent with PostHog selected
// failed with the raw upstream body — Composio API 404 "Default auth
// config not found for toolkit "posthog"" (Auth_Config_DefaultAuthConfigNotFound,
// code 306). PostHog authenticates with an API key, which needs no
// credentials of ours: the link route now creates a custom API_KEY auth
// config and Composio's connect page asks the person for the key. About
// two thirds of the catalog is like this.

import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { buildVaultRoutes } from "@open-managed-agents/http-routes";
import { createInMemoryCredentialService } from "@open-managed-agents/credentials-store/test-fakes";
import { createInMemoryVaultService } from "@open-managed-agents/vaults-store/test-fakes";

const TENANT = "tnt_unmanaged";

interface FakeAuthConfig {
  id: string;
  auth_scheme?: string;
  is_composio_managed: boolean;
  status?: string;
  toolkit: { slug: string };
}

interface FakeToolkit {
  /** Schemes Composio has managed credentials for. */
  managed: string[];
  /** mode → fields an auth config of that mode needs from its creator. */
  schemes: Record<string, string[]>;
}

const TOOLKITS: Record<string, FakeToolkit> = {
  gmail: { managed: ["OAUTH2"], schemes: { OAUTH2: ["client_id", "client_secret"] } },
  posthog: { managed: [], schemes: { API_KEY: [] } },
  exa: { managed: [], schemes: { BEARER_TOKEN: [], API_KEY: [] } },
  twitter: { managed: [], schemes: { OAUTH2: ["client_id", "client_secret"] } },
  hackernews: { managed: [], schemes: { NO_AUTH: [] } },
  // Canonical slug keeps its underscore: "microsoftteams" is unknown.
  microsoft_teams: { managed: ["OAUTH2"], schemes: { OAUTH2: ["client_id", "client_secret"] } },
};

/** Fake Composio with the real API's answers for auth configs (probed
 *  against backend.composio.dev v3.1 on 2026-11-24). Like the real one it
 *  ignores an unknown `toolkit_slug` filter and returns every config. */
function fakeComposio(initial: FakeAuthConfig[] = []) {
  const configs = [...initial];
  const calls: Array<{ method: string; path: string; body: any }> = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: url.pathname, body });
    const json = (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
    const fail = (status: number, code: number, slug: string, message: string) =>
      json({ error: { message, code, slug, status } }, status);

    if (url.pathname === "/api/v3.1/auth_configs" && method === "GET") {
      const slug = url.searchParams.get("toolkit_slug") ?? "";
      const managed = url.searchParams.get("is_composio_managed");
      const ofKind = configs.filter((cfg) => managed === null || String(cfg.is_composio_managed) === managed);
      return json({ items: TOOLKITS[slug] ? ofKind.filter((cfg) => cfg.toolkit.slug === slug) : ofKind });
    }
    if (url.pathname === "/api/v3.1/auth_configs" && method === "POST") {
      const slug = body?.toolkit?.slug as string;
      const toolkit = TOOLKITS[slug];
      if (!toolkit) return fail(404, 1803, "Toolkit_ToolkitNotFound", `Could not find toolkit "${slug}"`);
      if (toolkit.schemes.NO_AUTH) {
        return fail(400, 303, "Auth_Config_NoAuthApp", `Cannot create an auth config for toolkit "${slug}" because it does not require authentication.`);
      }
      const custom = body.auth_config as { type?: string; authScheme?: string } | undefined;
      if (!custom) {
        if (toolkit.managed.length === 0) {
          return fail(404, 306, "Auth_Config_DefaultAuthConfigNotFound", `Default auth config not found for toolkit "${slug}". Composio does not have managed credentials for this toolkit.`);
        }
        const created = { id: `ac_managed_${slug}`, auth_scheme: toolkit.managed[0], is_composio_managed: true, toolkit: { slug } };
        configs.push(created);
        return json({ toolkit: { slug }, auth_config: created }, 201);
      }
      const required = custom.authScheme ? toolkit.schemes[custom.authScheme] : undefined;
      if (custom.type !== "use_custom_auth" || !required || required.length > 0) {
        return fail(400, 301, "Auth_Config_InvalidCredentials", "missing required fields");
      }
      const created = { id: `ac_custom_${slug}_${configs.length}`, auth_scheme: custom.authScheme, is_composio_managed: false, toolkit: { slug } };
      configs.push(created);
      return json({ toolkit: { slug }, auth_config: created }, 201);
    }
    const toolkitMatch = url.pathname.match(/^\/api\/v3\.1\/toolkits\/([^/]+)$/);
    if (toolkitMatch) {
      const slug = decodeURIComponent(toolkitMatch[1]);
      const toolkit = TOOLKITS[slug];
      if (!toolkit) return fail(404, 1803, "Toolkit_ToolkitNotFound", `Could not find toolkit "${slug}"`);
      return json({
        slug,
        composio_managed_auth_schemes: toolkit.managed,
        auth_config_details: Object.entries(toolkit.schemes).map(([mode, required]) => ({
          mode,
          fields: {
            auth_config_creation: { required: required.map((name) => ({ name })), optional: [] },
            connected_account_initiation: { required: [], optional: [] },
          },
        })),
      });
    }
    if (url.pathname === "/api/v3.1/connected_accounts/link") {
      return json({
        link_token: "lk_1",
        redirect_url: `https://connect.composio.dev/link/${body.auth_config_id}`,
        connected_account_id: "ca_pending",
      });
    }
    if (url.pathname === "/api/v3.1/connected_accounts") return json({ items: [], next_cursor: null });
    return json({ error: `unexpected ${url.pathname}` }, 404);
  }) as typeof fetch;
  const authConfigCreates = () => calls.filter((c) => c.method === "POST" && c.path === "/api/v3.1/auth_configs");
  return { configs, calls, fetcher, authConfigCreates };
}

async function rig(composio: ReturnType<typeof fakeComposio>) {
  const { service: vaults } = createInMemoryVaultService();
  const { service: credentials } = createInMemoryCredentialService();
  const vault = await vaults.create({ tenantId: TENANT, name: "apps" });
  const app = new Hono<{ Variables: { tenant_id: string } }>();
  app.use("*", async (c, next) => {
    c.set("tenant_id", TENANT);
    await next();
  });
  app.route(
    "/v1/vaults",
    buildVaultRoutes({
      services: { vaults, credentials } as never,
      composio: { apiKey: "platform-key", fetcher: composio.fetcher },
    }),
  );
  /** `extra.api_key` makes the request use a tenant's own Composio project. */
  const link = async (toolkit: string, extra: Record<string, unknown> = {}) => {
    const res = await app.request(`/v1/vaults/${vault.id}/credentials/composio_accounts/link`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ toolkit, ...extra }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { link };
}

describe("composio_accounts/link for apps without Composio-managed sign-in", () => {
  it("an API-key app (PostHog) gets a custom API_KEY auth config and a connect link", async () => {
    const composio = fakeComposio();
    const r = await rig(composio);
    const res = await r.link("posthog");
    expect(res.status).toBe(201);
    expect(res.body.auth_config_id).toMatch(/^ac_custom_posthog/);
    expect(res.body.redirect_url).toBe(`https://connect.composio.dev/link/${res.body.auth_config_id}`);
    // Managed first (Composio says no), then the custom one.
    expect(composio.authConfigCreates().map((c) => c.body)).toEqual([
      { toolkit: { slug: "posthog" } },
      { toolkit: { slug: "posthog" }, auth_config: { type: "use_custom_auth", authScheme: "API_KEY", credentials: {} } },
    ]);
  });

  it("the second connect reuses that config instead of creating another", async () => {
    const composio = fakeComposio();
    const r = await rig(composio);
    const first = await r.link("posthog");
    const second = await r.link("posthog");
    expect(second.status).toBe(201);
    expect(second.body.auth_config_id).toBe(first.body.auth_config_id);
    expect(composio.configs).toHaveLength(1);
  });

  it("uses the first scheme that needs nothing from us (Exa: bearer token)", async () => {
    const composio = fakeComposio();
    const r = await rig(composio);
    expect((await r.link("exa")).status).toBe(201);
    expect(composio.authConfigCreates()[1].body.auth_config).toEqual({
      type: "use_custom_auth",
      authScheme: "BEARER_TOKEN",
      credentials: {},
    });
  });

  it("a managed app is unchanged: one managed config, no toolkit lookup", async () => {
    const composio = fakeComposio();
    const r = await rig(composio);
    const res = await r.link("gmail");
    expect(res.status).toBe(201);
    expect(res.body.auth_config_id).toBe("ac_managed_gmail");
    expect(composio.calls.some((c) => c.path.startsWith("/api/v3.1/toolkits/"))).toBe(false);
    // …and an existing managed config is reused without any create.
    await r.link("gmail");
    expect(composio.authConfigCreates()).toHaveLength(1);
  });

  it("a managed app prefers the managed config over an operator's custom one", async () => {
    const composio = fakeComposio([
      { id: "ac_own_gmail", auth_scheme: "OAUTH2", is_composio_managed: false, toolkit: { slug: "gmail" } },
    ]);
    const r = await rig(composio);
    expect((await r.link("gmail")).body.auth_config_id).toBe("ac_managed_gmail");
    // …and never lists the custom ones to find that out.
    expect(composio.calls.filter((c) => c.method === "GET" && c.path === "/api/v3.1/auth_configs")).toHaveLength(1);
  });

  it("in a tenant's own Composio project, an app that needs an OAuth app (X) uses the custom config there", async () => {
    const composio = fakeComposio([
      { id: "ac_disabled_x", auth_scheme: "OAUTH2", is_composio_managed: false, status: "DISABLED", toolkit: { slug: "twitter" } },
      { id: "ac_own_x", auth_scheme: "OAUTH2", is_composio_managed: false, toolkit: { slug: "twitter" } },
    ]);
    const r = await rig(composio);
    const res = await r.link("twitter", { api_key: "tenant-own-key" });
    expect(res.status).toBe(201);
    expect(res.body.auth_config_id).toBe("ac_own_x");
  });

  it("under the platform key, a custom OAuth app in the shared project is not handed out by toolkit name", async () => {
    // The operator's X client: every tenant shares this Composio project.
    const composio = fakeComposio([
      { id: "ac_operator_x", auth_scheme: "OAUTH2", is_composio_managed: false, toolkit: { slug: "twitter" } },
    ]);
    const r = await rig(composio);
    const res = await r.link("twitter");
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("COMPOSIO_CUSTOM_AUTH_REQUIRED");
    // …and the message does not send them to a project the lookup never reads.
    expect(res.body.error).toContain("platform's Composio connection");
    expect(res.body.error).toContain("your own Composio API key");
    expect(composio.calls.some((c) => c.path === "/api/v3.1/connected_accounts/link")).toBe(false);
    // Naming the config still works, as before.
    const named = await r.link("twitter", { auth_config_id: "ac_operator_x" });
    expect(named.status).toBe(201);
    expect(named.body.auth_config_id).toBe("ac_operator_x");
  });

  it("…and says what to do, in words, when there is none", async () => {
    const composio = fakeComposio();
    const r = await rig(composio);
    const res = await r.link("twitter", { api_key: "tenant-own-key" });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("COMPOSIO_CUSTOM_AUTH_REQUIRED");
    expect(res.body.error).toContain('"twitter"');
    expect(res.body.error).toContain("in your Composio project");
    expect(res.body.error).not.toContain("{");
    expect(composio.calls.some((c) => c.path === "/api/v3.1/connected_accounts/link")).toBe(false);
  });

  it("two first connects at once create one config, not two", async () => {
    const composio = fakeComposio();
    const r = await rig(composio);
    const [a, b] = await Promise.all([r.link("posthog"), r.link("posthog")]);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.auth_config_id).toBe(b.body.auth_config_id);
    expect(composio.configs).toHaveLength(1);
  });

  it("a toolkit whose canonical slug keeps its underscore connects on the first try", async () => {
    const composio = fakeComposio();
    const r = await rig(composio);
    const res = await r.link("microsoft_teams");
    expect(res.status).toBe(201);
    expect(res.body.auth_config_id).toBe("ac_managed_microsoft_teams");
    // Stripped spelling first (unknown to Composio), then the canonical one.
    expect(composio.authConfigCreates().map((c) => c.body.toolkit.slug)).toEqual(["microsoftteams", "microsoft_teams"]);
    // The next connect finds that config without creating another.
    expect((await r.link("Microsoft Teams")).body.auth_config_id).toBe("ac_managed_microsoft_teams");
    expect(composio.configs).toHaveLength(1);
  });

  it("an app that needs no account (Hacker News) says so", async () => {
    const composio = fakeComposio();
    const r = await rig(composio);
    const res = await r.link("hackernews");
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("COMPOSIO_TOOLKIT_NO_AUTH");
    expect(res.body.error).not.toContain("{");
  });

  it("an unknown app still answers COMPOSIO_TOOLKIT_NOT_FOUND", async () => {
    const composio = fakeComposio([
      { id: "ac_other", is_composio_managed: true, toolkit: { slug: "gmail" } },
    ]);
    const r = await rig(composio);
    const res = await r.link("origami");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("COMPOSIO_TOOLKIT_NOT_FOUND");
  });
});
