// Vault credentials are AUTH ONLY: a session's MCP servers are the agent's
// declared mcp_servers (plus integration-injected ones). Regression for
// prod 2026-11: an agent declaring only GitHub got Notion, Sentry, Railway
// and a Composio router on every turn because attaching a vault turned
// every MCP credential in it into a session server (Notion alone ≈59k
// tokens of tool definitions per model call). The old inference survives
// only behind `_oma.vault_mcp_servers: "all"`.

import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { buildAgentRoutes, buildSessionRoutes } from "@open-managed-agents/http-routes";
import {
  createInMemoryAgentService,
  createInMemoryAmbientRuleService,
} from "@open-managed-agents/agents-store/test-fakes";
import { createInMemorySessionService } from "@open-managed-agents/sessions-store/test-fakes";
import {
  inferVaultMcpServers,
  resolveOwningToolsetPermission,
  resolveToolPermission,
} from "@open-managed-agents/shared";
import type { AgentConfig } from "@open-managed-agents/shared";
import { NodeAmbientDispatcher } from "../src/lib/node-ambient-dispatch";
import { credentialMatchesMcpServerUrl, orderMatchingCredentials } from "../src/lib/node-mcp-proxy";
import { attachGrantToAgent, withDeclaredMcpServer } from "../src/lib/setup-harness";

const TENANT = "tnt_vault_mcp";
const GITHUB = "https://api.githubcopilot.com/mcp/";
const NOTION = "https://mcp.notion.com/mcp";
const SENTRY = "https://mcp.sentry.dev/mcp";
const COMPOSIO = "https://backend.composio.dev/tool_router/trs_abc/mcp";
const COMPOSIO_GENERIC = "https://app.composio.dev/tool_router/v3/session/mcp";

type Cred = {
  id: string;
  archived_at?: string | null;
  auth: { type: string; mcp_server_url?: string; composio_toolkits?: string[] };
};

/** The vault from the incident: GitHub, Notion, Sentry and a Composio router. */
function incidentVault(extra: Cred[] = []): Array<{ vault_id: string; credentials: Cred[] }> {
  return [
    {
      vault_id: "vlt_apps",
      credentials: [
        // Stored without the trailing slash the agent declares.
        { id: "c_gh", auth: { type: "mcp_oauth", mcp_server_url: "https://api.githubcopilot.com/mcp" } },
        { id: "c_notion", auth: { type: "mcp_oauth", mcp_server_url: NOTION } },
        { id: "c_sentry", auth: { type: "static_bearer", mcp_server_url: SENTRY } },
        {
          id: "c_composio",
          auth: { type: "composio_mcp", mcp_server_url: COMPOSIO, composio_toolkits: ["gmail", "linear"] },
        },
        ...extra,
      ],
    },
  ];
}

function rig(vaults: Array<{ vault_id: string; credentials: Cred[] }>) {
  const { service: agents } = createInMemoryAgentService();
  const { service: sessions } = createInMemorySessionService();
  const services = {
    agents,
    sessions,
    credentials: { listByVaults: async () => vaults },
  } as never;
  const app = new Hono<{ Variables: { tenant_id: string } }>();
  app.use("*", async (c, next) => {
    c.set("tenant_id", TENANT);
    await next();
  });
  app.route("/v1/agents", buildAgentRoutes({ services }));
  app.route(
    "/v1/sessions",
    buildSessionRoutes({
      services,
      router: { init: async () => {}, getFullStatus: async () => null } as never,
      localRuntimeEnvId: "env_local_runtime",
      loadEnvironment: async ({ environmentId }) =>
        ({ id: environmentId, runtime: "local", sandbox_template: null }) as never,
    }),
  );
  const json = async (path: string, init?: { method?: string; body?: unknown }) => {
    const res = await app.request(path, {
      method: init?.method ?? "GET",
      headers: { "content-type": "application/json" },
      ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { agents, json };
}

async function sessionServers(
  r: ReturnType<typeof rig>,
  agent: Record<string, unknown>,
): Promise<Array<{ name: string; url: string }>> {
  const created = await r.json("/v1/agents", { method: "POST", body: { model: "claude-sonnet-4-6", ...agent } });
  expect(created.status).toBe(201);
  const session = await r.json("/v1/sessions", {
    method: "POST",
    body: { agent: created.body.id, environment_id: "env_local_runtime", vault_ids: ["vlt_apps"] },
  });
  expect(session.status).toBe(201);
  return session.body.agent.mcp_servers;
}

describe("sessions route — vault credentials authenticate, they don't add servers", () => {
  it("declared GitHub + a vault with GitHub, Notion, Sentry and Composio → only GitHub", async () => {
    const r = rig(incidentVault());
    const servers = await sessionServers(r, {
      name: "github-only",
      mcp_servers: [{ name: "github", type: "url", url: GITHUB }],
    });
    expect(servers).toEqual([{ name: "github", type: "url", url: GITHUB }]);
  });

  it('"all" keeps the legacy inference', async () => {
    const r = rig(incidentVault());
    const servers = await sessionServers(r, {
      name: "github-all",
      mcp_servers: [{ name: "github", type: "url", url: GITHUB }],
      _oma: { vault_mcp_servers: "all" },
    });
    // GitHub's credential URL differs only by the trailing slash → not re-added.
    expect(servers).toEqual([
      { name: "github", type: "url", url: GITHUB },
      // Brand label, not the first DNS label ("mcp", "mcp_2" before).
      { name: "notion", type: "url", url: NOTION },
      { name: "sentry", type: "url", url: SENTRY },
      { name: "composio_gmail_linear", type: "url", url: COMPOSIO },
    ]);
  });

  it('"all" adds no second Composio router next to a declared one', async () => {
    const r = rig(incidentVault());
    const servers = await sessionServers(r, {
      name: "composio-all",
      mcp_servers: [{ name: "composio", type: "url", url: COMPOSIO_GENERIC }],
      _oma: { vault_mcp_servers: "all" },
    });
    expect(servers.map((s) => s.url)).toEqual([COMPOSIO_GENERIC, GITHUB.replace(/\/$/, ""), NOTION, SENTRY]);
    expect(servers.some((s) => s.name.startsWith("composio_"))).toBe(false);
  });

  it("archived credentials are ignored", async () => {
    const r = rig([
      {
        vault_id: "vlt_apps",
        credentials: [
          { id: "c_old", archived_at: "2026-11-01T00:00:00.000Z", auth: { type: "mcp_oauth", mcp_server_url: NOTION } },
          { id: "c_live", auth: { type: "mcp_oauth", mcp_server_url: SENTRY } },
        ],
      },
    ]);
    const servers = await sessionServers(r, { name: "archived-all", _oma: { vault_mcp_servers: "all" } });
    expect(servers.map((s) => s.url)).toEqual([SENTRY]);
  });

  it("round-trips _oma.vault_mcp_servers and validates it", async () => {
    const r = rig([]);
    const bad = await r.json("/v1/agents", {
      method: "POST",
      body: { name: "bad", model: "claude-sonnet-4-6", _oma: { vault_mcp_servers: "everything" } },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("vault_mcp_servers must be one of declared|all");

    const created = await r.json("/v1/agents", {
      method: "POST",
      body: { name: "rt", model: "claude-sonnet-4-6", _oma: { vault_mcp_servers: "all" } },
    });
    expect(created.body._oma.vault_mcp_servers).toBe("all");
    expect("vault_mcp_servers" in created.body).toBe(false);
    const cleared = await r.json(`/v1/agents/${created.body.id}`, {
      method: "POST",
      body: { _oma: { vault_mcp_servers: null } },
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body._oma?.vault_mcp_servers).toBeUndefined();
  });
});

describe("inferVaultMcpServers (the opt-in rule)", () => {
  it("drops a sentinel-only Composio credential next to a concrete router", () => {
    const servers = inferVaultMcpServers([], [
      {
        vault_id: "v1",
        credentials: [
          { auth: { type: "composio_mcp", mcp_server_url: COMPOSIO_GENERIC } },
          { auth: { type: "composio_mcp", mcp_server_url: COMPOSIO, composio_toolkits: ["notion"] } },
        ],
      },
    ]);
    expect(servers).toEqual([{ name: "composio_notion", type: "url", url: COMPOSIO }]);
  });

  it("skips non-MCP credential types", () => {
    const servers = inferVaultMcpServers([], [
      { vault_id: "v1", credentials: [{ auth: { type: "cap_cli", mcp_server_url: NOTION } }] },
    ]);
    expect(servers).toEqual([]);
  });
});

describe("ambient dispatch is gated on the same opt-in", () => {
  async function fire(agentExtra: Partial<AgentConfig>) {
    const { service: ambientRules } = createInMemoryAmbientRuleService({ clock: { nowMs: () => 0 } });
    const created: Array<{ agentSnapshot?: { mcp_servers?: Array<{ name: string; url: string }> } }> = [];
    const asked: unknown[] = [];
    const dispatcher = new NodeAmbientDispatcher({
      ambientRules,
      agents: {
        get: async () => ({
          id: "agt_1",
          name: "a",
          archived_at: null,
          metadata: { default_vault_ids: ["vlt_apps"] },
          mcp_servers: [{ name: "github", type: "url", url: GITHUB }],
          ...agentExtra,
        }),
      } as never,
      sessions: {
        create: async (input: never) => {
          created.push(input);
          return { session: { id: "s1" }, resources: [] };
        },
      } as never,
      appendUserEvent: async () => {},
      resolveVaultMcpServers: async (_t, vaultIds, declared) => {
        asked.push({ vaultIds, declared });
        return inferVaultMcpServers(declared, incidentVault()) as never;
      },
      now: () => 0,
    });
    await ambientRules.create({
      tenantId: TENANT,
      agentId: "agt_1",
      input: {
        name: "sweep",
        trigger: { source: "schedule", config: { cron: "0 9 * * *", timezone: "UTC" } },
        wake_mode: "act",
        next_wake_at: new Date(0).toISOString(),
      },
    });
    expect(await dispatcher.dispatchDue()).toBe(1);
    return { servers: created[0].agentSnapshot?.mcp_servers ?? [], asked };
  }

  it("default: the vault is attached but contributes no servers", async () => {
    const { servers, asked } = await fire({});
    expect(asked).toEqual([]);
    expect(servers.map((s) => s.name)).toEqual(["github"]);
  });

  it('"all": vault-derived servers are appended after the declared ones', async () => {
    const { servers, asked } = await fire({ vault_mcp_servers: "all" });
    expect(asked).toHaveLength(1);
    expect(servers.map((s) => s.name)).toEqual(["github", "notion", "sentry", "composio_gmail_linear"]);
  });
});

describe("Node MCP proxy credential match", () => {
  it("matches /mcp and /mcp/ for every credential type", () => {
    for (const type of ["mcp_oauth", "static_bearer", "composio_mcp"]) {
      expect(credentialMatchesMcpServerUrl({ type, mcp_server_url: "https://mcp.example.com/mcp" }, "https://mcp.example.com/mcp/")).toBe(true);
      expect(credentialMatchesMcpServerUrl({ type, mcp_server_url: "https://mcp.example.com/mcp/" }, "https://mcp.example.com/mcp")).toBe(true);
      expect(credentialMatchesMcpServerUrl({ type, mcp_server_url: "https://MCP.example.com/mcp" }, "https://mcp.example.com/mcp")).toBe(true);
    }
  });

  it("still refuses a different server", () => {
    expect(credentialMatchesMcpServerUrl({ type: "mcp_oauth", mcp_server_url: NOTION }, SENTRY)).toBe(false);
    expect(credentialMatchesMcpServerUrl({ type: "mcp_oauth", mcp_server_url: "https://mcp.example.com/mcp" }, "https://mcp.example.com/sse")).toBe(false);
    expect(credentialMatchesMcpServerUrl({ type: "mcp_oauth" }, NOTION)).toBe(false);
  });

  it("keeps the Composio router cross-match", () => {
    expect(credentialMatchesMcpServerUrl({ type: "composio_mcp", mcp_server_url: COMPOSIO }, COMPOSIO_GENERIC)).toBe(true);
    expect(credentialMatchesMcpServerUrl({ type: "mcp_oauth", mcp_server_url: COMPOSIO }, COMPOSIO_GENERIC)).toBe(false);
  });

  it("treats the query as part of a non-Composio server's identity (only param order is cosmetic)", () => {
    const A = "https://mcp.supabase.com/mcp?project_ref=aaa";
    const B = "https://mcp.supabase.com/mcp?project_ref=bbb";
    for (const type of ["mcp_oauth", "static_bearer"]) {
      expect(credentialMatchesMcpServerUrl({ type, mcp_server_url: A }, B)).toBe(false);
      expect(credentialMatchesMcpServerUrl({ type, mcp_server_url: A }, "https://mcp.supabase.com/mcp")).toBe(false);
      expect(credentialMatchesMcpServerUrl({ type, mcp_server_url: A }, "https://mcp.supabase.com/mcp/?project_ref=aaa")).toBe(true);
      expect(
        credentialMatchesMcpServerUrl({ type, mcp_server_url: "https://x.example.com/mcp?a=1&b=2" }, "https://x.example.com/mcp?b=2&a=1"),
      ).toBe(true);
    }
    expect(
      credentialMatchesMcpServerUrl({ type: "composio_mcp", mcp_server_url: `${COMPOSIO}?user_id=u1` }, COMPOSIO),
    ).toBe(true);
  });
});

describe("Node MCP proxy credential order (orderMatchingCredentials)", () => {
  const cred = (id: string, mcp_server_url: string, extra: Record<string, unknown> = {}) => ({
    id,
    auth: { type: "mcp_oauth", mcp_server_url },
    ...extra,
  });
  const ids = (out: Array<{ credential: { id: string } }>) => out.map((m) => m.credential.id);

  it("an exact-URL credential beats an older look-alike in the same vault", () => {
    // Vault page connected `…/mcp/` first; the connect card later stored the
    // declared `…/mcp` as a second row (raw-string unique index).
    const groups = [{ vault_id: "vlt_apps", credentials: [cred("old_slash", `${NOTION}/`), cred("exact", NOTION)] }];
    expect(ids(orderMatchingCredentials(groups, NOTION))).toEqual(["exact", "old_slash"]);
  });

  it("an exact-URL credential in a later vault beats a look-alike in an earlier one", () => {
    const groups = [
      { vault_id: "vlt_personal", credentials: [cred("personal", "https://api.githubcopilot.com/mcp")] },
      { vault_id: "vlt_work", credentials: [cred("work", GITHUB)] },
    ];
    expect(ids(orderMatchingCredentials(groups, GITHUB))).toEqual(["work", "personal"]);
  });

  it("the bound vault still comes first, exact before loose inside it", () => {
    const groups = [
      { vault_id: "vlt_a", credentials: [cred("a_exact", NOTION)] },
      { vault_id: "vlt_b", credentials: [cred("b_slash", `${NOTION}/`), cred("b_exact", NOTION)] },
    ];
    expect(ids(orderMatchingCredentials(groups, NOTION, "vlt_b"))).toEqual(["b_exact", "b_slash", "a_exact"]);
  });

  it("skips archived and non-matching credentials, and never cross-matches query-scoped accounts", () => {
    const A = "https://mcp.supabase.com/mcp?project_ref=aaa";
    const B = "https://mcp.supabase.com/mcp?project_ref=bbb";
    const groups = [
      {
        vault_id: "vlt_apps",
        credentials: [
          cred("sb_a", A),
          cred("sb_b_archived", B, { archived_at: "2026-11-01T00:00:00Z" }),
          cred("sb_b", B),
          cred("sentry", SENTRY),
        ],
      },
    ];
    expect(ids(orderMatchingCredentials(groups, B))).toEqual(["sb_b"]);
    expect(ids(orderMatchingCredentials(groups, A))).toEqual(["sb_a"]);
  });
});

describe("in-product grants declare the server (recordAccessGrant → attachGrantToAgent)", () => {
  async function agentWith(input: Partial<AgentConfig>) {
    const { service } = createInMemoryAgentService();
    const row = await service.create({
      tenantId: TENANT,
      input: { name: "granted", model: "claude-sonnet-4-6", ...input } as never,
    });
    return { service, row };
  }

  it("declares the granted server + an mcp_toolset, and attaches/binds the vault", async () => {
    const { service, row } = await agentWith({});
    await attachGrantToAgent(service, TENANT, row.id, { vaultId: "vlt_apps", mcpServerUrl: NOTION, service: "notion" });
    const after = (await service.get({ tenantId: TENANT, agentId: row.id }))!;
    expect(after.mcp_servers).toEqual([{ name: "notion", type: "url", url: NOTION }]);
    expect(after.tools).toEqual([{ type: "agent_toolset_20260401" }, { type: "mcp_toolset", mcp_server_name: "notion" }]);
    expect(after.metadata?.default_vault_ids).toEqual(["vlt_apps"]);
    expect(after.metadata?.mcp_vault_bindings).toEqual({ "https://mcp.notion.com/mcp": "vlt_apps" });

    // Idempotent: a second grant for the same server changes nothing.
    await attachGrantToAgent(service, TENANT, row.id, { vaultId: "vlt_apps", mcpServerUrl: `${NOTION}/`, service: "notion" });
    expect((await service.get({ tenantId: TENANT, agentId: row.id }))!.version).toBe(after.version);
  });

  it("keeps an already-declared server (cosmetic URL difference) and its name", async () => {
    const { service, row } = await agentWith({
      mcp_servers: [{ name: "gh", type: "url", url: GITHUB }],
      metadata: { default_vault_ids: ["vlt_apps"] },
    });
    await attachGrantToAgent(service, TENANT, row.id, {
      vaultId: "vlt_apps",
      mcpServerUrl: "https://api.githubcopilot.com/mcp",
      service: "github",
    });
    const after = (await service.get({ tenantId: TENANT, agentId: row.id }))!;
    expect(after.mcp_servers).toEqual([{ name: "gh", type: "url", url: GITHUB }]);
  });

  it("leaves Composio routers to the graft route", async () => {
    const { service, row } = await agentWith({});
    await attachGrantToAgent(service, TENANT, row.id, { vaultId: "vlt_apps", mcpServerUrl: COMPOSIO, service: "gmail" });
    expect((await service.get({ tenantId: TENANT, agentId: row.id }))!.mcp_servers).toBeUndefined();
  });

  it("declaring a server never loosens approvals (PR #45 ratchet)", () => {
    const tools = [
      {
        type: "agent_toolset_20260401",
        default_config: { enabled: true, permission_policy: { type: "always_ask" as const } },
      },
    ];
    const before = { tools, mcp_servers: [] };
    const declared = withDeclaredMcpServer(before, { name: "notion", url: NOTION })!;
    for (const tool of ["mcp__notion__search", "mcp__notion__create_page"]) {
      expect(resolveToolPermission(before.tools, tool)).toBe("always_ask");
      expect(resolveToolPermission(declared.tools, tool)).toBe("always_ask");
      // SDK harnesses use the owning-toolset rule alone — still asks.
      expect(resolveOwningToolsetPermission(declared.tools, tool)).toBe("always_ask");
    }
  });

  it("picks a free name when the service name is taken", () => {
    const declared = withDeclaredMcpServer(
      { mcp_servers: [{ name: "notion", type: "url", url: "https://other.example.com/mcp" }], tools: [] },
      { name: "notion", url: NOTION },
    )!;
    expect(declared.mcp_servers.map((s) => s.name)).toEqual(["notion", "notion_2"]);
    expect(declared.tools).toEqual([{ type: "mcp_toolset", mcp_server_name: "notion_2" }]);
  });
});
