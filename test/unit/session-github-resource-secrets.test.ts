import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  buildSessionRoutes,
  type RouteServices,
} from "@open-managed-agents/http-routes";
import { createInMemoryAgentService } from "@open-managed-agents/agents-store/test-fakes";
import { createInMemoryCredentialService } from "@open-managed-agents/credentials-store/test-fakes";
import { createInMemoryMemoryStoreService } from "@open-managed-agents/memory-store/test-fakes";
import { createInMemorySessionSecretService } from "@open-managed-agents/session-secrets-store/test-fakes";
import { createInMemorySessionService } from "@open-managed-agents/sessions-store/test-fakes";
import { createInMemoryVaultService } from "@open-managed-agents/vaults-store/test-fakes";

const tenantId = "tenant_github_secret";

function buildTestApp() {
  const agents = createInMemoryAgentService().service;
  const credentials = createInMemoryCredentialService().service;
  const memory = createInMemoryMemoryStoreService().service;
  const sessionSecrets = createInMemorySessionSecretService().service;
  const sessions = createInMemorySessionService().service;
  const vaults = createInMemoryVaultService().service;
  const initCalls: unknown[] = [];

  const services = {
    agents,
    credentials,
    memory,
    sessionSecrets,
    sessions,
    vaults,
    sql: {} as never,
    kv: {} as never,
    newEventLog: () => ({
      appendAsync: async () => {},
      getEventsAsync: async () => [],
    }),
    hub: {
      publish: () => {},
      attach: () => () => {},
    },
    background: {
      run: () => {},
    },
  } satisfies RouteServices;

  const app = new Hono<{ Variables: { tenant_id: string } }>();
  app.use("*", async (c, next) => {
    c.set("tenant_id", tenantId);
    await next();
  });
  app.route(
    "/v1/sessions",
    buildSessionRoutes({
      services,
      router: {
        init: async (_sessionId, params) => {
          initCalls.push(params);
        },
        getFullStatus: async () => null,
      },
      loadEnvironment: async () => ({
        id: "env_test",
        name: "Env",
        config: { type: "cloud" },
        created_at: new Date().toISOString(),
        updated_at: null,
        archived_at: null,
      }),
      lifecycle: {
        githubBindingFastPath: async ({ repoUrl }) =>
          repoUrl === "https://github.com/acme/private-repo"
            ? { token: "ghs_installation_token", vaultId: "vlt_github_installation" }
            : null,
      },
    }),
  );

  return { app, agents, initCalls, sessionSecrets };
}

describe("session github_repository resource secrets", () => {
  it("persists GitHub fast-path installation token as a per-resource secret", async () => {
    const { app, agents, initCalls, sessionSecrets } = buildTestApp();
    const agent = await agents.create({
      tenantId,
      input: {
        name: "Reviewer",
        model: "claude-opus-4-8",
        system: "Review code.",
      },
    });

    const res = await app.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: agent.id,
        environment_id: "env_test",
        resources: [
          {
            type: "github_repository",
            repo_url: "https://github.com/acme/private-repo",
            checkout: { type: "commit", sha: "abc123" },
          },
        ],
      }),
    });

    expect(res.status).toBe(201);
    const session = await res.json() as {
      id: string;
      vault_ids: string[];
      resources: Array<{ id: string; authorization_token?: string }>;
    };
    expect(session.vault_ids).toContain("vlt_github_installation");
    expect(session.resources[0].authorization_token).toBeUndefined();
    expect(JSON.stringify(session)).not.toContain("ghs_installation_token");
    expect(initCalls).toHaveLength(1);

    await expect(
      sessionSecrets.get({
        tenantId,
        sessionId: session.id,
        resourceId: session.resources[0].id,
      }),
    ).resolves.toBe("ghs_installation_token");
  });
});
