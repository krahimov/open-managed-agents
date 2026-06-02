// @ts-nocheck
// Verifies the Composio MCP credential path keeps the Composio project key in
// main and resolves the upstream URL from vault metadata, not from the agent.

import { describe, expect, it } from "vitest";
import { resolveProxyTargetByTenant } from "../../apps/main/src/routes/mcp-proxy";
import {
  createComposioConnectedAccountLink,
  createComposioToolRouterSession,
  getOrCreateComposioManagedAuthConfig,
} from "../../packages/http-routes/src/vaults";
import { createInMemoryCredentialService } from "../../packages/credentials-store/src/test-fakes";
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

describe("resolveProxyTargetByTenant — Composio MCP", () => {
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
