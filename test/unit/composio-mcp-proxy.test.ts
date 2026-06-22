// @ts-nocheck
// Verifies the Composio MCP credential path keeps the Composio project key in
// main and resolves the upstream URL from vault metadata, not from the agent.

import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { resolveProxyTargetByTenant } from "../../apps/main/src/routes/mcp-proxy";
import {
  buildVaultRoutes,
  createComposioConnectedAccountLink,
  createComposioToolRouterSession,
  getOrCreateComposioManagedAuthConfig,
} from "../../packages/http-routes/src/vaults";
import { createInMemoryCredentialService } from "../../packages/credentials-store/src/test-fakes";
import { createInMemoryVaultService } from "../../packages/vaults-store/src/test-fakes";
import type { Services } from "../../packages/services/src/index";

const TENANT = "tn_test";
const SESSION = "ses_test";
const VAULT = "vlt_test";

function makeServices(): {
  services: Services;
  credService: ReturnType<typeof createInMemoryCredentialService>["service"];
} {
  const { service: credService } = createInMemoryCredentialService();
  const sessions = {
    get: async (q: { tenantId: string; sessionId: string }) => {
      if (q.tenantId !== TENANT || q.sessionId !== SESSION) return null;
      return {
        id: SESSION,
        tenant_id: TENANT,
        vault_ids: [VAULT],
        archived_at: null,
        agent_snapshot: {
          name: "Composio agent",
          model: "claude-sonnet-4-6",
          mcp_servers: [
            {
              name: "composio",
            url: "https://app.composio.dev/tool_router/v3/session/mcp",
            },
          ],
        },
      };
    },
  };
  return {
    services: { credentials: credService, sessions } as unknown as Services,
    credService,
  };
}

function makeVaultRoutesHarness(opts: {
  apiKey?: string;
  fetcher: typeof fetch;
}): {
  app: Hono<{ Variables: { tenant_id: string } }>;
  vaultService: ReturnType<typeof createInMemoryVaultService>["service"];
  credService: ReturnType<typeof createInMemoryCredentialService>["service"];
} {
  const { service: vaultService } = createInMemoryVaultService();
  const { service: credService } = createInMemoryCredentialService();
  const app = new Hono<{ Variables: { tenant_id: string } }>();
  app.use("*", async (c, next) => {
    c.set("tenant_id", TENANT);
    await next();
  });
  app.route(
    "/",
    buildVaultRoutes({
      services: {
        vaults: vaultService,
        credentials: credService,
      } as unknown as Services,
      composio: { apiKey: opts.apiKey, fetcher: opts.fetcher },
    }),
  );
  return { app, vaultService, credService };
}

describe("resolveProxyTargetByTenant — Composio MCP", () => {
  it("starts Composio account links with a user-supplied project key", async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input as never, init);
      calls.push({ url: req.url, headers: req.headers });
      if (req.url.includes("/api/v3.1/auth_configs?")) {
        return new Response(JSON.stringify({ items: [] }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (req.url.endsWith("/api/v3.1/auth_configs")) {
        return new Response(
          JSON.stringify({
            auth_config: {
              id: "acfg_gmail",
              toolkit: { slug: "gmail" },
              is_composio_managed: true,
            },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      if (req.url.endsWith("/api/v3.1/connected_accounts/link")) {
        return new Response(
          JSON.stringify({
            link_token: "link_gmail",
            redirect_url: "https://accounts.composio.dev/link/link_gmail",
            connected_account_id: "ca_gmail",
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    };
    const { app, vaultService } = makeVaultRoutesHarness({ fetcher });
    const vault = await vaultService.create({ tenantId: TENANT, name: "User vault" });

    const res = await app.request(`/${vault.id}/credentials/composio_accounts/link`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        toolkit: "gmail",
        callback_url: "http://localhost:5174/composio/callback?toolkit=gmail",
        api_key: "cmp_user_project_key",
      }),
    });

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      auth_config_id: "acfg_gmail",
      connected_account_id: "ca_gmail",
      redirect_url: "https://accounts.composio.dev/link/link_gmail",
    });
    expect(calls.map((call) => call.headers.get("x-api-key"))).toEqual([
      "cmp_user_project_key",
      "cmp_user_project_key",
      "cmp_user_project_key",
    ]);
  });

  it("stores a user-supplied Composio project key on the vault credential", async () => {
    const calls: Array<{ url: string; headers: Headers; body: unknown }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input as never, init);
      calls.push({
        url: req.url,
        headers: req.headers,
        body: await req.json(),
      });
      return new Response(
        JSON.stringify({
          session_id: "trs_user_key",
          mcp: {
            type: "http",
            url: "https://backend.composio.dev/tool_router/trs_user_key/mcp",
          },
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    };
    const { app, vaultService, credService } = makeVaultRoutesHarness({ fetcher });
    const vault = await vaultService.create({ tenantId: TENANT, name: "User vault" });

    const res = await app.request(`/${vault.id}/credentials/composio_tool_router_session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        display_name: "Gmail Composio",
        api_key: "cmp_user_project_key",
        toolkits: { enable: ["gmail"] },
      }),
    });

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.auth.api_key).toBeUndefined();
    expect(json.auth.api_key_env).toBeUndefined();
    expect(calls[0].headers.get("x-api-key")).toBe("cmp_user_project_key");

    const stored = await credService.list({ tenantId: TENANT, vaultId: vault.id });
    expect(stored).toHaveLength(1);
    expect(stored[0].auth).toMatchObject({
      type: "composio_mcp",
      api_key: "cmp_user_project_key",
      composio_toolkits: ["gmail"],
    });
  });

  it("adds Composio credentials by default while reusing the vault-scoped project key", async () => {
    const calls: Array<{ headers: Headers }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input as never, init);
      calls.push({ headers: req.headers });
      return new Response(
        JSON.stringify({
          session_id: "trs_replaced",
          mcp: {
            type: "http",
            url: "https://backend.composio.dev/tool_router/trs_replaced/mcp",
          },
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    };
    const { app, vaultService, credService } = makeVaultRoutesHarness({ fetcher });
    const vault = await vaultService.create({ tenantId: TENANT, name: "User vault" });
    await credService.create({
      tenantId: TENANT,
      vaultId: vault.id,
      displayName: "Old Composio",
      auth: {
        type: "composio_mcp",
        mcp_server_url: "https://backend.composio.dev/tool_router/trs_old/mcp",
        api_key: "cmp_existing_vault_key",
      } as never,
    });

    const res = await app.request(`/${vault.id}/credentials/composio_tool_router_session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        display_name: "New Composio",
        toolkits: { enable: ["gmail", "slack"] },
      }),
    });

    expect(res.status).toBe(201);
    expect(calls[0].headers.get("x-api-key")).toBe("cmp_existing_vault_key");
    const stored = await credService.list({ tenantId: TENANT, vaultId: vault.id });
    const active = stored.filter((cred) => !cred.archived_at);
    expect(active).toHaveLength(2);
    const created = active.find((cred) => cred.display_name === "New Composio");
    expect(created?.auth).toMatchObject({
      type: "composio_mcp",
      api_key: "cmp_existing_vault_key",
      composio_session_id: "trs_replaced",
      composio_toolkits: ["gmail", "slack"],
    });
  });

  it("replaces active Composio credentials only when explicitly requested", async () => {
    const fetcher: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          session_id: "trs_replaced",
          mcp: {
            type: "http",
            url: "https://backend.composio.dev/tool_router/trs_replaced/mcp",
          },
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    const { app, vaultService, credService } = makeVaultRoutesHarness({ fetcher });
    const vault = await vaultService.create({ tenantId: TENANT, name: "User vault" });
    await credService.create({
      tenantId: TENANT,
      vaultId: vault.id,
      displayName: "Old Composio",
      auth: {
        type: "composio_mcp",
        mcp_server_url: "https://backend.composio.dev/tool_router/trs_old/mcp",
        api_key: "cmp_existing_vault_key",
      } as never,
    });

    const res = await app.request(`/${vault.id}/credentials/composio_tool_router_session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        display_name: "New Composio",
        replace_existing: true,
        toolkits: { enable: ["gmail"] },
      }),
    });

    expect(res.status).toBe(201);
    const stored = await credService.list({ tenantId: TENANT, vaultId: vault.id });
    const active = stored.filter((cred) => !cred.archived_at);
    expect(active).toHaveLength(1);
    expect(active[0].display_name).toBe("New Composio");
  });

  it("creates a Composio Tool Router session with backend x-api-key", async () => {
    const calls: Array<{ url: string; headers: Headers; body: unknown }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input as never, init);
      calls.push({
        url: req.url,
        headers: req.headers,
        body: await req.json(),
      });
      return new Response(
        JSON.stringify({
          session_id: "trs_test",
          mcp: {
            type: "http",
            url: "https://backend.composio.dev/tool_router/trs_test/mcp",
          },
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    };

    const session = await createComposioToolRouterSession(
      { apiKey: "cmp_project_key", fetcher },
      {
        user_id: `oma:${TENANT}:${VAULT}`,
        toolkits: { enable: ["github", "slack"] },
      },
    );

    expect(session.session_id).toBe("trs_test");
    expect(session.mcp.url).toBe("https://backend.composio.dev/tool_router/trs_test/mcp");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://backend.composio.dev/api/v3.1/tool_router/session");
    expect(calls[0].headers.get("x-api-key")).toBe("cmp_project_key");
    expect(calls[0].body).toEqual({
      user_id: `oma:${TENANT}:${VAULT}`,
      toolkits: { enable: ["github", "slack"] },
    });
  });

  it("uses backend COMPOSIO_API_KEY and credential-scoped MCP URL", async () => {
    const { services, credService } = makeServices();
    await credService.create({
      tenantId: TENANT,
      vaultId: VAULT,
      displayName: "Composio",
      auth: {
        type: "composio_mcp",
        mcp_server_url: `https://backend.composio.dev/tool_router/trs_test/mcp`,
        api_key_env: "COMPOSIO_API_KEY",
        composio_user_id: VAULT,
        composio_session_id: "trs_test",
      } as never,
    });

    const target = await resolveProxyTargetByTenant(
      { COMPOSIO_API_KEY: "cmp_project_key" } as never,
      services,
      TENANT,
      SESSION,
      "composio",
    );

    expect(target).not.toBeNull();
    expect(target!.upstreamUrl).toBe(`https://backend.composio.dev/tool_router/trs_test/mcp`);
    expect(target!.upstreamAuthHeader).toEqual({
      name: "x-api-key",
      value: "cmp_project_key",
    });
  });

  it("routes credential-specific Composio MCP servers to the matching vault credential", async () => {
    const { service: credService } = createInMemoryCredentialService();
    const gmailUrl = "https://backend.composio.dev/tool_router/trs_gmail/mcp";
    const notionUrl = "https://backend.composio.dev/tool_router/trs_notion/mcp";
    const services = {
      credentials: credService,
      sessions: {
        get: async () => ({
          id: SESSION,
          tenant_id: TENANT,
          vault_ids: [VAULT],
          archived_at: null,
          agent_snapshot: {
            name: "Composio agent",
            model: "claude-sonnet-4-6",
            mcp_servers: [
              { name: "gmail", url: gmailUrl },
              { name: "notion", url: notionUrl },
            ],
          },
        }),
      },
    } as unknown as Services;
    await credService.create({
      tenantId: TENANT,
      vaultId: VAULT,
      displayName: "Gmail Composio",
      auth: {
        type: "composio_mcp",
        mcp_server_url: gmailUrl,
        api_key_env: "COMPOSIO_API_KEY",
      } as never,
    });
    await credService.create({
      tenantId: TENANT,
      vaultId: VAULT,
      displayName: "Notion Composio",
      auth: {
        type: "composio_mcp",
        mcp_server_url: notionUrl,
        api_key_env: "COMPOSIO_API_KEY",
      } as never,
    });

    const target = await resolveProxyTargetByTenant(
      { COMPOSIO_API_KEY: "cmp_project_key" } as never,
      services,
      TENANT,
      SESSION,
      "notion",
    );

    expect(target).not.toBeNull();
    expect(target!.upstreamUrl).toBe(notionUrl);
  });

  it("does not resolve Composio MCP when the backend key is missing", async () => {
    const { services, credService } = makeServices();
    await credService.create({
      tenantId: TENANT,
      vaultId: VAULT,
      displayName: "Composio",
      auth: {
        type: "composio_mcp",
        mcp_server_url: "https://backend.composio.dev/tool_router/trs_test/mcp",
        api_key_env: "COMPOSIO_API_KEY",
      } as never,
    });

    const target = await resolveProxyTargetByTenant(
      {} as never,
      services,
      TENANT,
      SESSION,
      "composio",
    );

    expect(target).toBeNull();
  });

  it("creates a Composio managed auth config and hosted OAuth link", async () => {
    const calls: Array<{ url: string; method: string; headers: Headers; body: unknown }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input as never, init);
      const text = await req.text();
      calls.push({
        url: req.url,
        method: req.method,
        headers: req.headers,
        body: text ? JSON.parse(text) : null,
      });

      if (req.url.includes("/api/v3.1/auth_configs?")) {
        return new Response(JSON.stringify({ items: [] }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (req.url.endsWith("/api/v3.1/auth_configs")) {
        return new Response(
          JSON.stringify({
            auth_config: {
              id: "acfg_github",
              toolkit: { slug: "github" },
              is_composio_managed: true,
            },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      if (req.url.endsWith("/api/v3.1/connected_accounts/link")) {
        return new Response(
          JSON.stringify({
            link_token: "link_test",
            redirect_url: "https://accounts.composio.dev/link/link_test",
            connected_account_id: "ca_github",
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    };

    const link = await createComposioConnectedAccountLink(
      { apiKey: "cmp_project_key", fetcher },
      {
        userId: `oma:${TENANT}:${VAULT}`,
        toolkitSlug: "GitHub",
        callbackUrl: "http://localhost:5173/composio/callback?toolkit=github",
      },
    );

    expect(link).toMatchObject({
      auth_config_id: "acfg_github",
      connected_account_id: "ca_github",
      redirect_url: "https://accounts.composio.dev/link/link_test",
      toolkit: "github",
      user_id: `oma:${TENANT}:${VAULT}`,
    });
    expect(calls.map((c) => [c.method, new URL(c.url).pathname])).toEqual([
      ["GET", "/api/v3.1/auth_configs"],
      ["POST", "/api/v3.1/auth_configs"],
      ["POST", "/api/v3.1/connected_accounts/link"],
    ]);
    expect(calls[0].headers.get("x-api-key")).toBe("cmp_project_key");
    expect(calls[1].body).toEqual({ toolkit: { slug: "github" } });
    expect(calls[2].body).toEqual({
      auth_config_id: "acfg_github",
      user_id: `oma:${TENANT}:${VAULT}`,
      callback_url: "http://localhost:5173/composio/callback?toolkit=github",
    });
  });

  it("reuses an existing Composio managed auth config", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input as never, init);
      calls.push({ url: req.url, method: req.method });
      return new Response(
        JSON.stringify({
          items: [
            {
              id: "acfg_slack",
              status: "ENABLED",
              toolkit: { slug: "slack" },
              is_composio_managed: true,
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );
    };

    const authConfig = await getOrCreateComposioManagedAuthConfig(
      { apiKey: "cmp_project_key", fetcher },
      "slack",
    );

    expect(authConfig.id).toBe("acfg_slack");
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
    expect(new URL(calls[0].url).searchParams.get("toolkit_slug")).toBe("slack");
  });
});
