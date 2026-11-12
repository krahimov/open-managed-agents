// Several Composio tool routers in one session (C2) + brand-label names for
// inferred servers (C3).
//
// Regression for prod 2026-11: a session with vaults [new-connected-apps
// (router: notion, slack, …), google-workspace (router: gmail,
// googlecalendar, googledrive, googlesheets)] silently lost the Google
// router — inferVaultMcpServers kept ONE router across all vaults. And an
// inferred https://mcp.posthog.com/mcp server was named "mcp".

import { describe, expect, it } from "vitest";
import { tool } from "ai";
import { z } from "zod";
import { Hono } from "hono";
import { buildAgentRoutes, buildSessionRoutes } from "@open-managed-agents/http-routes";
import { createInMemoryAgentService } from "@open-managed-agents/agents-store/test-fakes";
import { createInMemorySessionService } from "@open-managed-agents/sessions-store/test-fakes";
import {
  evaluatePolicy,
  inferVaultMcpServers,
  mcpServerBrandLabel,
  openAiSafeToolName,
  resolveOwningToolsetPermission,
  vaultMcpInferenceOptions,
  vaultMcpServersForAgent,
  vaultMcpServersMayAdd,
  withVaultMcpServers,
} from "@open-managed-agents/shared";
import { createInMemoryAmbientRuleService } from "@open-managed-agents/agents-store/test-fakes";
import { NodeAmbientDispatcher } from "../src/lib/node-ambient-dispatch";
import { applyAgentToolBudget } from "@open-managed-agents/agent/harness/tool-budget";
import { pickComposioCandidate } from "../src/lib/node-mcp-proxy";

const TENANT = "tnt_multi";
const NOTION_ROUTER = "https://backend.composio.dev/tool_router/trs_apps/mcp";
const GOOGLE_ROUTER = "https://backend.composio.dev/tool_router/trs_google/mcp";
const GENERIC = "https://app.composio.dev/tool_router/v3/session/mcp";
const USER_APPS = `oma:${TENANT}:vlt_apps`;
const USER_GOOGLE = `oma:${TENANT}:vlt_google`;

type Cred = {
  id?: string;
  created_at?: string;
  archived_at?: string | null;
  auth: Record<string, unknown>;
};

const router = (url: string, user: string | undefined, toolkits: string[] | undefined, extra: Partial<Cred> = {}): Cred => ({
  ...extra,
  auth: {
    type: "composio_mcp",
    mcp_server_url: url,
    ...(user ? { composio_user_id: user } : {}),
    ...(toolkits ? { composio_toolkits: toolkits } : {}),
    ...(extra.auth ?? {}),
  },
});

/** The incident: one router per vault, different users and toolkits. */
function incidentVaults() {
  return [
    {
      vault_id: "vlt_apps",
      credentials: [router(NOTION_ROUTER, USER_APPS, ["notion", "slack", "linear", "hubspot"])],
    },
    {
      vault_id: "vlt_google",
      credentials: [router(GOOGLE_ROUTER, USER_GOOGLE, ["gmail", "googlecalendar", "googledrive", "googlesheets"])],
    },
  ];
}

describe("inferVaultMcpServers — every distinct Composio router is mounted", () => {
  it("two vaults, two routers with different toolkits → both, under distinct names", () => {
    expect(inferVaultMcpServers([], incidentVaults())).toEqual([
      { name: "composio_notion_slack_linear", type: "url", url: NOTION_ROUTER },
      { name: "composio_gmail_googlecalendar_googledrive", type: "url", url: GOOGLE_ROUTER },
    ]);
  });

  it("same toolkit prefix → uniqueness suffix, still both mounted", () => {
    const servers = inferVaultMcpServers([], [
      { vault_id: "v1", credentials: [router(NOTION_ROUTER, "oma:t:v1", ["gmail", "slack"])] },
      { vault_id: "v2", credentials: [router(GOOGLE_ROUTER, "oma:t:v2", ["gmail", "slack"])] },
    ]);
    // Different composio users = different accounts: not duplicates.
    expect(servers.map((s) => s.name)).toEqual(["composio_gmail_slack", "composio_gmail_slack_2"]);
  });

  it("the same router URL in two vaults is one server", () => {
    const servers = inferVaultMcpServers([], [
      { vault_id: "v1", credentials: [router(NOTION_ROUTER, USER_APPS, ["notion"])] },
      { vault_id: "v2", credentials: [router(`${NOTION_ROUTER}/`, USER_APPS, ["notion"])] },
    ]);
    expect(servers.map((s) => s.url)).toEqual([NOTION_ROUTER]);
  });

  it("same composio user: a router whose toolkits are a subset of another's is dropped", () => {
    const servers = inferVaultMcpServers([], [
      {
        vault_id: "v1",
        credentials: [
          router(NOTION_ROUTER, USER_APPS, ["notion"]),
          router(GOOGLE_ROUTER, USER_APPS, ["notion", "slack"]),
        ],
      },
    ]);
    expect(servers.map((s) => s.url)).toEqual([GOOGLE_ROUTER]);
  });

  it("same composio user, equal toolkit sets: the newest is kept", () => {
    const servers = inferVaultMcpServers([], [
      {
        vault_id: "v1",
        credentials: [
          router(GOOGLE_ROUTER, USER_APPS, ["slack", "notion"], { created_at: "2026-11-10T00:00:00.000Z" }),
          router(NOTION_ROUTER, USER_APPS, ["notion", "slack"], { created_at: "2026-11-01T00:00:00.000Z" }),
        ],
      },
    ]);
    expect(servers.map((s) => s.url)).toEqual([GOOGLE_ROUTER]);
  });

  it("same composio user, overlapping but not nested toolkits: both", () => {
    const servers = inferVaultMcpServers([], [
      {
        vault_id: "v1",
        credentials: [router(NOTION_ROUTER, USER_APPS, ["notion", "slack"]), router(GOOGLE_ROUTER, USER_APPS, ["slack", "gmail"])],
      },
    ]);
    expect(servers).toHaveLength(2);
  });

  it("an unlocked router (all toolkits) covers the same user's locked ones", () => {
    const servers = inferVaultMcpServers([], [
      {
        vault_id: "v1",
        credentials: [router(NOTION_ROUTER, USER_APPS, ["notion"]), router(GOOGLE_ROUTER, USER_APPS, undefined)],
      },
    ]);
    expect(servers).toEqual([{ name: "composio", type: "url", url: GOOGLE_ROUTER }]);
  });

  it("a declared concrete router suppresses only itself and its user's routers", () => {
    const servers = inferVaultMcpServers(
      [{ name: "composio", type: "url", url: NOTION_ROUTER }],
      [
        ...incidentVaults(),
        { vault_id: "vlt_more", credentials: [router("https://backend.composio.dev/tool_router/trs_more/mcp", USER_APPS, ["stripe"])] },
      ],
    );
    expect(servers.map((s) => s.url)).toEqual([GOOGLE_ROUTER]);
  });

  it("a declared generic router covers the router the proxy resolves it to (bound vault first)", () => {
    const declared = [{ name: "composio", type: "url" as const, url: GENERIC }];
    // Unbound: the first concrete router (vault order) — the Google one stays.
    expect(inferVaultMcpServers(declared, incidentVaults()).map((s) => s.url)).toEqual([GOOGLE_ROUTER]);
    // Bound to the Google vault: that one is covered, the apps router stays.
    const options = vaultMcpInferenceOptions({ metadata: { mcp_vault_bindings: { [GENERIC]: "vlt_google" } } });
    expect(inferVaultMcpServers(declared, incidentVaults(), options).map((s) => s.url)).toEqual([NOTION_ROUTER]);
  });

  it("a declared URL that was re-provisioned covers its successor (lineage)", () => {
    const servers = inferVaultMcpServers(
      [{ name: "composio", type: "url", url: "https://backend.composio.dev/tool_router/trs_old/mcp" }],
      [
        {
          vault_id: "vlt_apps",
          credentials: [
            router(NOTION_ROUTER, USER_APPS, ["notion"], {
              auth: { composio_previous_mcp_server_urls: ["https://backend.composio.dev/tool_router/trs_old/mcp"] },
            }),
          ],
        },
        incidentVaults()[1],
      ],
    );
    expect(servers.map((s) => s.url)).toEqual([GOOGLE_ROUTER]);
  });

  it("generic sentinel credentials: only when there is no concrete router and none declared", () => {
    const sentinelOnly = [{ vault_id: "v1", credentials: [router(GENERIC, undefined, undefined)] }];
    expect(inferVaultMcpServers([], sentinelOnly).map((s) => s.url)).toEqual([GENERIC]);
    expect(
      inferVaultMcpServers([{ name: "c", type: "url", url: NOTION_ROUTER }], sentinelOnly).map((s) => s.url),
    ).toEqual([]);
    expect(
      inferVaultMcpServers([], [...sentinelOnly, ...incidentVaults()]).map((s) => s.url),
    ).toEqual([NOTION_ROUTER, GOOGLE_ROUTER]);
  });

  it("archived routers are ignored", () => {
    const servers = inferVaultMcpServers([], [
      {
        vault_id: "v1",
        credentials: [
          router(NOTION_ROUTER, USER_APPS, ["notion", "slack"], { archived_at: "2026-11-01T00:00:00.000Z" }),
          router(GOOGLE_ROUTER, USER_APPS, ["notion"]),
        ],
      },
    ]);
    expect(servers.map((s) => s.url)).toEqual([GOOGLE_ROUTER]);
  });
});

describe("sessions route mounts both routers (opt-in agents)", () => {
  it("vaults [apps, google] → composio_notion_… and composio_gmail_…", async () => {
    const { service: agents } = createInMemoryAgentService();
    const { service: sessions } = createInMemorySessionService();
    const services = { agents, sessions, credentials: { listByVaults: async () => incidentVaults() } } as never;
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
        loadEnvironment: async ({ environmentId }) => ({ id: environmentId, runtime: "local", sandbox_template: null }) as never,
      }),
    );
    const post = async (path: string, body: unknown) => {
      const res = await app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    };
    const agent = await post("/v1/agents", { name: "two-routers", model: "claude-sonnet-4-6", _oma: { vault_mcp_servers: "all" } });
    const session = await post("/v1/sessions", {
      agent: agent.body.id,
      environment_id: "env_local_runtime",
      vault_ids: ["vlt_apps", "vlt_google"],
    });
    expect(session.status).toBe(201);
    expect(session.body.agent.mcp_servers.map((s: { name: string }) => s.name)).toEqual([
      "composio_notion_slack_linear",
      "composio_gmail_googlecalendar_googledrive",
    ]);
  });
});

describe("Node MCP proxy — each router server reaches its own credential", () => {
  const cand = (url: string, previousUrls?: string[]) => ({ upstreamUrl: url, upstreamToken: "k", previousUrls });

  it("exact URL wins over an earlier concrete router", () => {
    const picked = pickComposioCandidate([cand(NOTION_ROUTER), cand(GOOGLE_ROUTER)], GOOGLE_ROUTER);
    expect(picked?.upstreamUrl).toBe(GOOGLE_ROUTER);
  });

  it("a pinned URL that was re-provisioned reaches its successor, not another router", () => {
    const old = "https://backend.composio.dev/tool_router/trs_google_old/mcp";
    const picked = pickComposioCandidate([cand(NOTION_ROUTER), cand(GOOGLE_ROUTER, [old])], old);
    expect(picked?.upstreamUrl).toBe(GOOGLE_ROUTER);
  });

  it("the generic sentinel → first concrete router, never the sentinel itself", () => {
    expect(pickComposioCandidate([cand(GENERIC), cand(NOTION_ROUTER)], GENERIC)?.upstreamUrl).toBe(NOTION_ROUTER);
    expect(pickComposioCandidate([cand(GENERIC)], GENERIC)?.upstreamUrl).toBe(GENERIC);
    expect(pickComposioCandidate([], GENERIC)).toBeNull();
  });

  it("lineage never hijacks the sentinel", () => {
    const picked = pickComposioCandidate([cand(NOTION_ROUTER), cand(GOOGLE_ROUTER, [GENERIC])], GENERIC);
    expect(picked?.upstreamUrl).toBe(NOTION_ROUTER);
  });
});

describe("tool budget with two Composio routers", () => {
  const meta = (server: string) =>
    Object.fromEntries(
      ["COMPOSIO_SEARCH_TOOLS", "COMPOSIO_MULTI_EXECUTE_TOOL", "COMPOSIO_MANAGE_CONNECTIONS"].map((t) => [
        `mcp__${server}__${t}`,
        tool({ description: `${t} on ${server}`, inputSchema: z.object({ q: z.string().optional() }), execute: async () => "ok" }),
      ]),
    );
  const servers = inferVaultMcpServers([], incidentVaults());
  const tools = { bash: meta("x").mcp__x__COMPOSIO_SEARCH_TOOLS, ...meta(servers[0].name), ...meta(servers[1].name) };

  it("auto keeps both routers' meta tools; deferred defers both, per server", () => {
    expect(applyAgentToolBudget(tools, { mcp_servers: servers }).deferred.size).toBe(0);
    expect(applyAgentToolBudget(tools, { mcp_servers: servers, mcp_tool_loading: "deferred" }).deferredByServer).toEqual({
      composio_notion_slack_linear: 3,
      composio_gmail_googlecalendar_googledrive: 3,
    });
  });

  it("OpenAI-shortened names of the two routers' identical meta tools stay distinct", () => {
    const names = Object.keys(tools).filter((n) => n.startsWith("mcp__composio")).map((n) => openAiSafeToolName(n));
    expect(new Set(names).size).toBe(6);
    for (const name of names) expect(name.length).toBeLessThanOrEqual(64);
  });
});

describe("inferred non-Composio servers are named by brand label (C3)", () => {
  it.each([
    ["https://mcp.posthog.com/mcp", "posthog"],
    ["https://api.example.com/mcp", "example"],
    ["https://mcp.linear.app/mcp", "linear"],
    ["https://mcp.notion.com/mcp", "notion"],
    ["https://api.githubcopilot.com/mcp/", "githubcopilot"],
    ["https://tools.example.co.uk/mcp", "example"],
    ["https://my-tools.vercel.app/mcp", "my-tools"],
    ["https://sentry.dev/mcp", "sentry"],
    ["http://localhost:3000/mcp", "localhost"],
    ["http://127.0.0.1:8080/mcp", "mcp"],
    ["not a url", "mcp"],
  ])("%s → %s", (url, label) => {
    expect(mcpServerBrandLabel(url)).toBe(label);
  });

  it("keeps uniqueness: two servers of one brand get _2", () => {
    const servers = inferVaultMcpServers([{ name: "posthog", type: "url", url: "https://us.posthog.com/sse" }], [
      {
        vault_id: "v1",
        credentials: [
          { auth: { type: "static_bearer", mcp_server_url: "https://mcp.posthog.com/mcp" } },
          { auth: { type: "static_bearer", mcp_server_url: "https://eu.posthog.com/mcp" } },
          { auth: { type: "static_bearer", mcp_server_url: "https://my-tools.vercel.app/mcp" } },
        ],
      },
    ]);
    expect(servers.map((s) => s.name)).toEqual(["posthog_2", "posthog_3", "my_tools"]);
  });

  it("back-compat: an old name referenced by an mcp_toolset is kept for that server", () => {
    // Agent saved permission configs against the old inferred names: Notion
    // was "mcp", Sentry "mcp_2".
    const vaults = [
      {
        vault_id: "v1",
        credentials: [
          { auth: { type: "mcp_oauth", mcp_server_url: "https://mcp.notion.com/mcp" } },
          { auth: { type: "static_bearer", mcp_server_url: "https://mcp.sentry.dev/mcp" } },
          { auth: { type: "static_bearer", mcp_server_url: "https://mcp.posthog.com/mcp" } },
        ],
      },
    ];
    const options = vaultMcpInferenceOptions({
      tools: [
        { type: "agent_toolset_20260401" },
        { type: "mcp_toolset", mcp_server_name: "mcp_2", default_config: { permission_policy: { type: "always_ask" } } },
      ],
    });
    expect(inferVaultMcpServers([], vaults, options).map((s) => s.name)).toEqual(["notion", "mcp_2", "posthog"]);
    // Without the reference everything moves to brand names.
    expect(inferVaultMcpServers([], vaults).map((s) => s.name)).toEqual(["notion", "sentry", "posthog"]);
  });

  it("declared names are untouched", () => {
    const servers = inferVaultMcpServers([{ name: "mcp", type: "url", url: "https://mcp.github.com/mcp" }], [
      { vault_id: "v1", credentials: [{ auth: { type: "mcp_oauth", mcp_server_url: "https://mcp.posthog.com/mcp" } }] },
    ]);
    expect(servers).toEqual([{ name: "posthog", type: "url", url: "https://mcp.posthog.com/mcp" }]);
  });
});

describe("C3 back-compat: access-policy selectors keep legacy inferred names", () => {
  const vaults = [
    {
      vault_id: "v1",
      credentials: [
        { auth: { type: "static_bearer", mcp_server_url: "https://mcp.posthog.com/mcp" } },
        { auth: { type: "static_bearer", mcp_server_url: "https://mcp.sentry.dev/mcp" } },
      ],
    },
  ];

  it("a deny rule on mcp__mcp__* keeps PostHog named 'mcp', so the rule still denies", () => {
    const agent = {
      vault_mcp_servers: "all" as const,
      mcp_servers: [],
      effective_policy: { rules: [{ effect: "deny" as const, selector: "mcp__mcp__delete_*" }] },
    };
    const snapshot = withVaultMcpServers(agent, vaults);
    expect(snapshot.mcp_servers!.map((s) => s.name)).toEqual(["mcp", "sentry"]);
    expect(evaluatePolicy(snapshot.effective_policy, "mcp__mcp__delete_feature_flag").effect).toBe("deny");
  });

  it("an ask rule on the second legacy name (mcp_2) is honored too; wildcard servers reserve nothing", () => {
    const options = vaultMcpInferenceOptions({
      effective_policy: { rules: [{ effect: "ask", selector: "mcp__mcp_2__*" }, { effect: "deny", selector: "mcp__*__drop_*" }] },
    });
    expect(inferVaultMcpServers([], vaults, options).map((s) => s.name)).toEqual(["posthog", "mcp_2"]);
  });
});

describe("C2 in the default 'declared' mode: a declared generic Composio server reaches every router", () => {
  const graftedAgent = (extra: Record<string, unknown> = {}) => ({
    mcp_servers: [{ name: "composio", type: "url" as const, url: GENERIC }],
    tools: [
      { type: "agent_toolset_20260401" },
      { type: "mcp_toolset", mcp_server_name: "composio", default_config: { permission_policy: { type: "always_ask" } } },
    ],
    ...extra,
  });

  it("mounts the routers the generic server doesn't resolve to — Composio only, no other vault servers", () => {
    const vaults = [
      ...incidentVaults(),
      { vault_id: "vlt_more", credentials: [{ auth: { type: "mcp_oauth", mcp_server_url: "https://mcp.notion.com/mcp" } }] },
    ];
    expect(vaultMcpServersMayAdd(graftedAgent() as never)).toBe(true);
    expect(vaultMcpServersMayAdd({ mcp_servers: [{ name: "c", type: "url", url: NOTION_ROUTER }] })).toBe(false);
    expect(vaultMcpServersForAgent(graftedAgent() as never, vaults)).toEqual([
      { name: "composio_gmail_googlecalendar_googledrive", type: "url", url: GOOGLE_ROUTER },
    ]);
    // A declared CONCRETE router is an explicit pin — nothing added.
    expect(vaultMcpServersForAgent({ mcp_servers: [{ name: "c", type: "url", url: NOTION_ROUTER }] }, vaults)).toEqual([]);
  });

  it("the extra router inherits the Composio toolset (always_ask) and the pinned Composio policy rules", () => {
    const agent = graftedAgent({
      effective_policy: {
        rules: [
          { effect: "ask", selector: "mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL" },
          { effect: "deny", selector: "mcp__composio__*DELETE*" },
          { effect: "deny", selector: "mcp__github__*" },
        ],
      },
    });
    const snapshot = withVaultMcpServers(agent as never, incidentVaults()) as ReturnType<typeof graftedAgent> & {
      effective_policy: { rules: Array<{ effect: string; selector: string }> };
    };
    const google = "composio_gmail_googlecalendar_googledrive";
    expect(snapshot.mcp_servers.map((s) => s.name)).toEqual(["composio", google]);
    expect(resolveOwningToolsetPermission(snapshot.tools as never, `mcp__${google}__COMPOSIO_MULTI_EXECUTE_TOOL`)).toBe("always_ask");
    expect(evaluatePolicy(snapshot.effective_policy as never, `mcp__${google}__COMPOSIO_MULTI_EXECUTE_TOOL`).effect).toBe("ask");
    expect(evaluatePolicy(snapshot.effective_policy as never, `mcp__${google}__GMAIL_DELETE_MESSAGE`).effect).toBe("deny");
    expect(snapshot.effective_policy.rules.filter((r) => r.selector.startsWith("mcp__github"))).toHaveLength(1);
    // The agent row itself is not mutated.
    expect(agent.tools).toHaveLength(2);
  });

  it("'all' mode: the second inferred router copies the first router's own toolset", () => {
    const agent = {
      vault_mcp_servers: "all" as const,
      mcp_servers: [],
      tools: [{ type: "mcp_toolset", mcp_server_name: "composio_notion_slack_linear", default_config: { permission_policy: { type: "always_ask" } } }],
    };
    const snapshot = withVaultMcpServers(agent as never, incidentVaults()) as { tools: unknown[] };
    expect(resolveOwningToolsetPermission(snapshot.tools as never, "mcp__composio_gmail_googlecalendar_googledrive__COMPOSIO_MULTI_EXECUTE_TOOL")).toBe("always_ask");
  });

  it("sessions route: a declared-mode grafted agent gets both routers", async () => {
    const { service: agents } = createInMemoryAgentService();
    const { service: sessions } = createInMemorySessionService();
    const services = { agents, sessions, credentials: { listByVaults: async () => incidentVaults() } } as never;
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
        loadEnvironment: async ({ environmentId }) => ({ id: environmentId, runtime: "local", sandbox_template: null }) as never,
      }),
    );
    const post = async (path: string, body: unknown) => {
      const res = await app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    };
    const agent = await post("/v1/agents", { name: "grafted", model: "claude-sonnet-4-6", ...graftedAgent() });
    const session = await post("/v1/sessions", {
      agent: agent.body.id,
      environment_id: "env_local_runtime",
      vault_ids: ["vlt_apps", "vlt_google"],
    });
    expect(session.status).toBe(201);
    expect(session.body.agent.mcp_servers.map((s: { name: string }) => s.name)).toEqual([
      "composio",
      "composio_gmail_googlecalendar_googledrive",
    ]);
  });

  it("ambient dispatch applies the same expansion (listVaultCredentials)", async () => {
    const { service: ambientRules } = createInMemoryAmbientRuleService({ clock: { nowMs: () => 0 } });
    const created: Array<{ agentSnapshot: { mcp_servers: Array<{ name: string }>; tools: unknown[] } }> = [];
    const dispatcher = new NodeAmbientDispatcher({
      ambientRules,
      agents: {
        get: async () => ({ id: "agt_1", name: "a", archived_at: null, metadata: { default_vault_ids: ["vlt_apps", "vlt_google"] }, ...graftedAgent() }),
      } as never,
      sessions: {
        create: async (input: never) => {
          created.push(input);
          return { session: { id: "s1" }, resources: [] };
        },
      } as never,
      appendUserEvent: async () => {},
      listVaultCredentials: async () => incidentVaults() as never,
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
    expect(created[0].agentSnapshot.mcp_servers.map((s) => s.name)).toEqual(["composio", "composio_gmail_googlecalendar_googledrive"]);
    expect(created[0].agentSnapshot.tools).toHaveLength(3);
  });
});
