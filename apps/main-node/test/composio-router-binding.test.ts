// Composio tool routers bind their toolkits' ACTIVE connected accounts (C1).
//
// Regression for prod 2026-11: router trs_GQ6W9zVLSHs5 was created with
// toolkits [airtable, hubspot, linear, notion, slack, …] and NO
// connected_accounts binding; HubSpot (ca_6pGEZwWUC6Bt) and Airtable
// (ca_5XCjRXf-2I02) were ACTIVE under its exact user_id, yet
// COMPOSIO_SEARCH_TOOLS said "No Active connection for toolkit=hubspot". A
// router created with the accounts bound saw them. Every provisioning path
// now binds; existing routers are repaired lazily before a session starts
// and via POST …/composio_tool_router_session/refresh.

import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  buildVaultRoutes,
  ComposioRouterRefresher,
  rotateRouterCredential,
  selectComposioAccountBindings,
  type ComposioConnectedAccount,
} from "@open-managed-agents/http-routes";
import { composioCredentialAuthError, composioPlatformKeyEnvFor } from "@open-managed-agents/shared";
import { createInMemoryCredentialService } from "@open-managed-agents/credentials-store/test-fakes";
import { createInMemoryVaultService } from "@open-managed-agents/vaults-store/test-fakes";
import { createInMemoryAmbientRuleService } from "@open-managed-agents/agents-store/test-fakes";
import { NodeAmbientDispatcher } from "../src/lib/node-ambient-dispatch";

const TENANT = "tnt_bind";
const PLATFORM_KEY = "platform-key";

type Call = { method: string; path: string; query: URLSearchParams; body: any; apiKey: string | null };

const account = (
  id: string,
  toolkit: string,
  user: string,
  extra: Partial<ComposioConnectedAccount> = {},
): ComposioConnectedAccount => ({
  id,
  toolkit: { slug: toolkit },
  user_id: user,
  status: "ACTIVE",
  created_at: "2026-11-10T10:00:00.000Z",
  ...extra,
});

/** Fake Composio. The listing IGNORES the user filter on purpose — the
 *  client must still never bind another user's account. `omitUserId`
 *  mimics the real v3.1 listing, which no longer returns `user_id`
 *  ("deprecated … we will not be providing userId from this api"). `hang`
 *  never answers until the request's signal aborts. */
function fakeComposio(initial: ComposioConnectedAccount[] = []) {
  const state = { accounts: [...initial], failListing: false, omitUserId: false, hang: false };
  const calls: Call[] = [];
  let routers = 0;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    calls.push({
      method: init?.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      apiKey: headers.get("x-api-key"),
    });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/api/v3.1/connected_accounts") {
      if (state.hang) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason ?? new DOMException("aborted", "AbortError")));
        });
      }
      if (state.failListing) return json({ error: "boom" }, 500);
      const items = state.omitUserId ? state.accounts.map(({ user_id: _u, ...rest }) => rest) : state.accounts;
      return json({ items, next_cursor: null });
    }
    if (url.pathname === "/api/v3.1/tool_router/session") {
      routers++;
      return json({
        session_id: `trs_new${routers}`,
        mcp: { type: "http", url: `https://backend.composio.dev/tool_router/trs_new${routers}/mcp` },
      });
    }
    if (url.pathname === "/api/v3.1/auth_configs") {
      const slug = url.searchParams.get("toolkit_slug") || "airtable";
      return json({ items: [{ id: `ac_${slug}`, toolkit: { slug } }] });
    }
    if (url.pathname === "/api/v3.1/connected_accounts/link") {
      return json({ link_token: "lt", redirect_url: "https://composio.example/consent", connected_account_id: "ca_pending" });
    }
    return json({ error: `unexpected ${url.pathname}` }, 404);
  }) as typeof fetch;
  const routerCreates = () => calls.filter((c) => c.path === "/api/v3.1/tool_router/session");
  const listings = () => calls.filter((c) => c.path === "/api/v3.1/connected_accounts");
  return { state, calls, fetcher, routerCreates, listings };
}

async function rig(opts: { composio: ReturnType<typeof fakeComposio>; now?: () => number; requestTimeoutMs?: number }) {
  const { service: vaults } = createInMemoryVaultService();
  const { service: credentials } = createInMemoryCredentialService();
  const vault = await vaults.create({ tenantId: TENANT, name: "apps" });
  const refresher = new ComposioRouterRefresher({
    platformApiKey: PLATFORM_KEY,
    fetcher: opts.composio.fetcher,
    now: opts.now,
    requestTimeoutMs: opts.requestTimeoutMs,
  });
  const app = new Hono<{ Variables: { tenant_id: string } }>();
  app.use("*", async (c, next) => {
    c.set("tenant_id", TENANT);
    await next();
  });
  app.route(
    "/v1/vaults",
    buildVaultRoutes({
      services: { vaults, credentials } as never,
      composio: { apiKey: PLATFORM_KEY, fetcher: opts.composio.fetcher, refresher },
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
  const active = async () =>
    (await credentials.list({ tenantId: TENANT, vaultId: vault.id })).filter((c) => !c.archived_at);
  const user = `oma:${TENANT}:${vault.id}`;
  return { vaults, credentials, vault, refresher, post, active, user };
}

describe("selectComposioAccountBindings", () => {
  const U = "oma:t:v";
  it("newest ACTIVE per toolkit in scope; never another user's, disabled, or non-ACTIVE accounts", () => {
    const accounts = [
      account("hub_old", "hubspot", U, { created_at: "2026-11-01T00:00:00.000Z" }),
      account("hub_new", "hubspot", U, { created_at: "2026-11-09T00:00:00.000Z" }),
      account("air", "airtable", U),
      account("lin_pending", "linear", U, { status: "INITIATED" }),
      account("not_expired", "notion", U, { status: "EXPIRED" }),
      account("sl_failed", "slack", U, { status: "FAILED" }),
      account("zen_disabled", "zendesk", U, { is_disabled: true }),
      account("gm_foreign", "gmail", "oma:other:vault"),
      account("stripe_unscoped", "stripe", U),
    ];
    expect(
      selectComposioAccountBindings({
        accounts,
        userId: U,
        enabled: ["hubspot", "airtable", "linear", "notion", "slack", "zendesk", "gmail"],
      }),
    ).toEqual({ airtable: "air", hubspot: "hub_new" });
  });

  it("a preferred account wins when bindable; a pending one falls back to the newest ACTIVE", () => {
    const accounts = [
      account("hub_old", "hubspot", U, { created_at: "2026-11-01T00:00:00.000Z" }),
      account("hub_new", "hubspot", U, { created_at: "2026-11-09T00:00:00.000Z" }),
      account("air", "airtable", U),
      account("air_pending", "airtable", U, { status: "INITIATED" }),
    ];
    expect(
      selectComposioAccountBindings({
        accounts,
        userId: U,
        enabled: ["hubspot", "airtable"],
        preferred: { hubspot: "hub_old", airtable: "air_pending" },
      }),
    ).toEqual({ airtable: "air", hubspot: "hub_old" });
  });

  it("unlocked routers bind every toolkit except the disabled ones", () => {
    const accounts = [account("a", "airtable", U), account("h", "hubspot", U)];
    expect(selectComposioAccountBindings({ accounts, userId: U, disabled: ["hubspot"] })).toEqual({ airtable: "a" });
  });
});

describe("POST /v1/vaults/:id/credentials/composio_tool_router_session binds ACTIVE accounts", () => {
  it("sends connected_accounts and records the binding", async () => {
    const composio = fakeComposio();
    const r = await rig({ composio });
    composio.state.accounts = [
      account("ca_6pGEZwWUC6Bt", "hubspot", r.user),
      account("ca_5XCjRXf-2I02", "airtable", r.user),
      account("ca_linear_pending", "linear", r.user, { status: "INITIATED" }),
      account("ca_foreign", "notion", `oma:${TENANT}:other_vault`),
    ];
    const res = await r.post(`/v1/vaults/${r.vault.id}/credentials/composio_tool_router_session`, {
      toolkits: { enable: ["hubspot", "airtable", "linear", "notion"] },
      // The console passes the connect popup's id — still INITIATED here.
      connected_accounts: { linear: "ca_linear_pending" },
    });
    expect(res.status).toBe(201);
    const [create] = composio.routerCreates();
    expect(create.body).toEqual({
      user_id: r.user,
      toolkits: { enable: ["hubspot", "airtable", "linear", "notion"] },
      connected_accounts: { airtable: "ca_5XCjRXf-2I02", hubspot: "ca_6pGEZwWUC6Bt" },
    });
    expect(composio.listings()[0].query.get("user_ids")).toBe(r.user);
    const [cred] = await r.active();
    expect(cred.auth).toMatchObject({
      type: "composio_mcp",
      mcp_server_url: "https://backend.composio.dev/tool_router/trs_new1/mcp",
      api_key_env: "COMPOSIO_API_KEY",
      composio_user_id: r.user,
      composio_toolkits: ["hubspot", "airtable", "linear", "notion"],
      composio_connected_accounts: { airtable: "ca_5XCjRXf-2I02", hubspot: "ca_6pGEZwWUC6Bt" },
      composio_connected_account_ids: ["ca_5XCjRXf-2I02", "ca_6pGEZwWUC6Bt"],
    });
  });

  it("listing failure: caller ids are NOT forwarded unverified; the binding is recorded as unknown", async () => {
    const composio = fakeComposio();
    composio.state.failListing = true;
    const r = await rig({ composio });
    const res = await r.post(`/v1/vaults/${r.vault.id}/credentials/composio_tool_router_session`, {
      toolkits: { enable: ["hubspot"] },
      // Could be another tenant's account id — only the listing vouches.
      connected_accounts: { hubspot: "ca_someone_elses" },
    });
    expect(res.status).toBe(201);
    expect(composio.routerCreates()[0].body.connected_accounts).toBeUndefined();
    const [cred] = await r.active();
    expect(cred.auth.composio_connected_account_ids).toEqual([]);
    expect(cred.auth.composio_connected_accounts).toBeUndefined();

    // Unknown binding → the next session start repairs it.
    composio.state.failListing = false;
    composio.state.accounts = [account("ca_hub", "hubspot", r.user)];
    const results = await r.refresher.refreshVaults({ credentials: r.credentials, tenantId: TENANT, vaultIds: [r.vault.id] });
    expect(results.map((x) => x.status)).toEqual(["refreshed"]);
    expect(composio.routerCreates()[1].body.connected_accounts).toEqual({ hubspot: "ca_hub" });
  });

  it("binds accounts the real listing returns WITHOUT user_id (deprecated field)", async () => {
    const composio = fakeComposio();
    composio.state.omitUserId = true;
    const r = await rig({ composio });
    composio.state.accounts = [
      account("ca_6pGEZwWUC6Bt", "hubspot", r.user),
      account("ca_5XCjRXf-2I02", "airtable", r.user),
    ];
    await r.post(`/v1/vaults/${r.vault.id}/credentials/composio_tool_router_session`, {
      toolkits: { enable: ["hubspot", "airtable"] },
    });
    expect(composio.routerCreates()[0].body.connected_accounts).toEqual({
      airtable: "ca_5XCjRXf-2I02",
      hubspot: "ca_6pGEZwWUC6Bt",
    });
  });

  it("stores the toolkit→auth_config map it created the router with", async () => {
    const composio = fakeComposio();
    const r = await rig({ composio });
    await r.post(`/v1/vaults/${r.vault.id}/credentials/composio_tool_router_session`, {
      toolkits: { enable: ["twitter", "gmail"] },
      auth_configs: { twitter: "ac_custom_x", slack: "ac_out_of_scope" },
    });
    expect(composio.routerCreates()[0].body.auth_configs).toEqual({ twitter: "ac_custom_x" });
    const [cred] = await r.active();
    expect(cred.auth.composio_auth_configs).toEqual({ twitter: "ac_custom_x" });
  });

  it("replace_existing creates before it archives: a failed create keeps the old router", async () => {
    const composio = fakeComposio();
    const r = await rig({ composio });
    await r.post(`/v1/vaults/${r.vault.id}/credentials/composio_tool_router_session`, { toolkits: { enable: ["hubspot"] } });
    // Fill the vault to its 20-credential cap.
    for (let i = 0; i < 19; i++) {
      await r.credentials.create({
        tenantId: TENANT,
        vaultId: r.vault.id,
        displayName: `k${i}`,
        auth: { type: "static_bearer", mcp_server_url: `https://mcp${i}.example.com/mcp`, token: "t" } as never,
      });
    }
    const res = await r.post(`/v1/vaults/${r.vault.id}/credentials/composio_tool_router_session`, {
      toolkits: { enable: ["hubspot", "gmail"] },
      replace_existing: true,
    });
    expect(res.status).toBe(400);
    const routers = (await r.active()).filter((c) => c.auth.type === "composio_mcp");
    expect(routers.map((c) => c.auth.mcp_server_url)).toEqual(["https://backend.composio.dev/tool_router/trs_new1/mcp"]);
  });

  it("replace_existing records the replaced router's URL as lineage", async () => {
    const composio = fakeComposio();
    const r = await rig({ composio });
    await r.post(`/v1/vaults/${r.vault.id}/credentials/composio_tool_router_session`, { toolkits: { enable: ["hubspot"] } });
    await r.post(`/v1/vaults/${r.vault.id}/credentials/composio_tool_router_session`, {
      toolkits: { enable: ["hubspot", "gmail"] },
      replace_existing: true,
    });
    const active = await r.active();
    expect(active).toHaveLength(1);
    expect(active[0].auth.composio_previous_mcp_server_urls).toEqual([
      "https://backend.composio.dev/tool_router/trs_new1/mcp",
    ]);
  });

  it("the platform key never provisions (or lists, or links) another tenant's composio user", async () => {
    const composio = fakeComposio();
    const r = await rig({ composio });
    const foreign = "oma:tnt_victim:vlt_victim";
    const create = await r.post(`/v1/vaults/${r.vault.id}/credentials/composio_tool_router_session`, {
      user_id: foreign,
      toolkits: { enable: ["gmail"] },
    });
    expect(create.status).toBe(403);
    const link = await r.post(`/v1/vaults/${r.vault.id}/credentials/composio_accounts/link`, { toolkit: "gmail", user_id: foreign });
    expect(link.status).toBe(403);
    expect(composio.calls).toEqual([]);
    // A tenant's own key owns its whole Composio project.
    const own = await r.post(`/v1/vaults/${r.vault.id}/credentials/composio_tool_router_session`, {
      user_id: "custom-user",
      api_key: "tenant-own-key",
      toolkits: { enable: ["gmail"] },
    });
    expect(own.status).toBe(201);
    expect(composio.routerCreates()[0].apiKey).toBe("tenant-own-key");
  });
});

describe("toolkit add (composio_accounts/link) re-provisions with the binding", () => {
  it("binds the router's other ACTIVE accounts and keeps lineage", async () => {
    const composio = fakeComposio();
    const r = await rig({ composio });
    composio.state.accounts = [account("ca_hub", "hubspot", r.user)];
    await r.post(`/v1/vaults/${r.vault.id}/credentials/composio_tool_router_session`, { toolkits: { enable: ["hubspot"] } });
    const link = await r.post(`/v1/vaults/${r.vault.id}/credentials/composio_accounts/link`, { toolkit: "airtable" });
    expect(link.status).toBe(201);
    expect(link.body.toolkits_expanded).toBe(true);
    const creates = composio.routerCreates();
    expect(creates).toHaveLength(2);
    expect(creates[1].body).toEqual({
      user_id: r.user,
      toolkits: { enable: ["hubspot", "airtable"] },
      // The link's auth config governs the new toolkit in the router.
      auth_configs: { airtable: "ac_airtable" },
      // airtable's account is still INITIATED at link time — not bound.
      connected_accounts: { hubspot: "ca_hub" },
    });
    const active = await r.active();
    expect(active).toHaveLength(1);
    expect(active[0].auth).toMatchObject({
      composio_toolkits: ["hubspot", "airtable"],
      composio_connected_accounts: { hubspot: "ca_hub" },
      composio_previous_mcp_server_urls: ["https://backend.composio.dev/tool_router/trs_new1/mcp"],
    });
  });
});

/** The prod row: locked to 8 toolkits, ids recorded but never bound. */
async function seedLegacyRouter(r: Awaited<ReturnType<typeof rig>>, extra: Record<string, unknown> = {}) {
  return r.credentials.create({
    tenantId: TENANT,
    vaultId: r.vault.id,
    displayName: "Composio Tool Router (ops)",
    auth: {
      type: "composio_mcp",
      mcp_server_url: "https://backend.composio.dev/tool_router/trs_GQ6W9zVLSHs5/mcp",
      api_key_env: "COMPOSIO_API_KEY",
      composio_user_id: r.user,
      composio_session_id: "trs_GQ6W9zVLSHs5",
      composio_toolkits: ["airtable", "hubspot", "linear", "notion", "slack", "slackbot", "stripe", "zendesk"],
      composio_connected_account_ids: ["ca_1", "ca_2", "ca_3", "ca_4", "ca_5", "ca_6"],
      ...extra,
    } as never,
  });
}

describe("POST …/composio_tool_router_session/refresh repairs an existing router", () => {
  it("re-provisions the prod router with HubSpot/Airtable/Linear bound, archives the old row", async () => {
    const composio = fakeComposio();
    const r = await rig({ composio });
    composio.state.accounts = [
      account("ca_6pGEZwWUC6Bt", "hubspot", r.user),
      account("ca_5XCjRXf-2I02", "airtable", r.user),
      account("ca_buW", "linear", r.user),
      account("ca_expired_notion", "notion", r.user, { status: "EXPIRED" }),
    ];
    const legacy = await seedLegacyRouter(r);
    const res = await r.post(`/v1/vaults/${r.vault.id}/credentials/composio_tool_router_session/refresh`, {});
    expect(res.status).toBe(200);
    expect(res.body.refreshed).toBe(1);
    expect(composio.routerCreates()[0].body.connected_accounts).toEqual({
      airtable: "ca_5XCjRXf-2I02",
      hubspot: "ca_6pGEZwWUC6Bt",
      linear: "ca_buW",
    });
    const active = await r.active();
    expect(active).toHaveLength(1);
    expect(active[0].id).not.toBe(legacy.id);
    expect(active[0].display_name).toBe("Composio Tool Router (ops)");
    expect(active[0].auth).toMatchObject({
      api_key_env: "COMPOSIO_API_KEY",
      composio_toolkits: legacy.auth.composio_toolkits,
      composio_connected_accounts: { airtable: "ca_5XCjRXf-2I02", hubspot: "ca_6pGEZwWUC6Bt", linear: "ca_buW" },
      composio_connected_account_ids: ["ca_5XCjRXf-2I02", "ca_6pGEZwWUC6Bt", "ca_buW"],
      composio_previous_mcp_server_urls: ["https://backend.composio.dev/tool_router/trs_GQ6W9zVLSHs5/mcp"],
    });

    // Up to date now: a second check lists but provisions nothing.
    const again = await r.post(`/v1/vaults/${r.vault.id}/credentials/composio_tool_router_session/refresh`, {});
    expect(again.body.refreshed).toBe(0);
    expect(composio.routerCreates()).toHaveLength(1);
    // force re-provisions anyway.
    const forced = await r.post(`/v1/vaults/${r.vault.id}/credentials/composio_tool_router_session/refresh`, { mode: "force" });
    expect(forced.body.refreshed).toBe(1);
  });

  it("a newly ACTIVE account (Sheets after OAuth) gets bound on refresh", async () => {
    const composio = fakeComposio();
    const r = await rig({ composio });
    await r.post(`/v1/vaults/${r.vault.id}/credentials/composio_tool_router_session`, {
      toolkits: { enable: ["gmail", "googlesheets"] },
    });
    expect(composio.routerCreates()[0].body.connected_accounts).toBeUndefined();
    composio.state.accounts = [account("ca_wrTa4mQxt1UE", "googlesheets", r.user)];
    const res = await r.post(`/v1/vaults/${r.vault.id}/credentials/composio_tool_router_session/refresh`, {});
    expect(res.body.refreshed).toBe(1);
    expect((await r.active())[0].auth.composio_connected_accounts).toEqual({ googlesheets: "ca_wrTa4mQxt1UE" });
  });

  it("leaves the bare API-key credential (generic URL, no session) alone", async () => {
    const composio = fakeComposio();
    const r = await rig({ composio });
    await r.credentials.create({
      tenantId: TENANT,
      vaultId: r.vault.id,
      displayName: "Composio",
      auth: { type: "composio_mcp", mcp_server_url: "https://app.composio.dev/tool_router/v3/session/mcp", api_key: "k" } as never,
    });
    const res = await r.post(`/v1/vaults/${r.vault.id}/credentials/composio_tool_router_session/refresh`, { mode: "force" });
    expect(res.body.data).toEqual([]);
    expect(composio.calls).toEqual([]);
  });
});

describe("lazy repair before a session (ComposioRouterRefresher mode=lazy)", () => {
  it("a fully bound router costs no Composio call", async () => {
    const composio = fakeComposio();
    const r = await rig({ composio });
    await seedLegacyRouter(r, {
      composio_toolkits: ["hubspot"],
      composio_connected_accounts: { hubspot: "ca_hub" },
    });
    const results = await r.refresher.refreshVaults({ credentials: r.credentials, tenantId: TENANT, vaultIds: [r.vault.id] });
    expect(results.map((x) => x.status)).toEqual(["unchanged"]);
    expect(composio.calls).toEqual([]);
  });

  it("a recorded router with an unbound toolkit is re-checked in the BACKGROUND, at most once per background TTL", async () => {
    let now = 1_000_000;
    const composio = fakeComposio();
    const r = await rig({ composio, now: () => now });
    composio.state.accounts = [account("ca_hub", "hubspot", r.user)];
    await seedLegacyRouter(r, {
      composio_toolkits: ["hubspot", "airtable"],
      composio_connected_accounts: { hubspot: "ca_hub" },
    });
    const lazy = () => r.refresher.refreshVaults({ credentials: r.credentials, tenantId: TENANT, vaultIds: [r.vault.id] });

    // Not awaited by the session start.
    expect((await lazy()).map((x) => x.reason)).toEqual(["background check"]);
    await r.refresher.idle();
    expect(composio.listings()).toHaveLength(1);
    expect(composio.routerCreates()).toHaveLength(0);
    // Within the background TTL (30 min): no Composio call.
    now += 20 * 60_000;
    expect((await lazy()).map((x) => x.reason)).toEqual(["recently checked"]);
    await r.refresher.idle();
    expect(composio.listings()).toHaveLength(1);

    // Airtable's OAuth completes; after the TTL the next session's
    // background check binds it.
    composio.state.accounts.push(account("ca_air", "airtable", r.user));
    now += 15 * 60_000;
    await lazy();
    await r.refresher.idle();
    expect(composio.routerCreates()[0].body.connected_accounts).toEqual({ airtable: "ca_air", hubspot: "ca_hub" });
    // Now every toolkit is bound: no further calls.
    now += 60 * 60_000;
    await lazy();
    await r.refresher.idle();
    expect(composio.listings()).toHaveLength(2);
  });

  it("a legacy row with nothing bindable records a verified-empty binding instead of re-listing every TTL", async () => {
    let now = 0;
    const composio = fakeComposio();
    const r = await rig({ composio, now: () => now });
    composio.state.accounts = [account("ca_lin_pending", "linear", r.user, { status: "INITIATED" })];
    await seedLegacyRouter(r);
    const lazy = () => r.refresher.refreshVaults({ credentials: r.credentials, tenantId: TENANT, vaultIds: [r.vault.id] });
    expect((await lazy()).map((x) => x.status)).toEqual(["unchanged"]);
    expect((await r.active())[0].auth.composio_connected_accounts).toEqual({});
    expect(composio.routerCreates()).toHaveLength(0);
    // Inline TTL (5 min) passes: the row is "recorded" now, so the next
    // check is a background one on the 30-minute spacing.
    now += 6 * 60_000;
    expect((await lazy()).map((x) => x.reason)).toEqual(["recently checked"]);
    expect(composio.listings()).toHaveLength(1);
  });

  it("legacy rows (no recorded binding) are repaired on the first session", async () => {
    const composio = fakeComposio();
    const r = await rig({ composio });
    composio.state.accounts = [account("ca_6pGEZwWUC6Bt", "hubspot", r.user)];
    await seedLegacyRouter(r);
    const results = await r.refresher.refreshVaults({ credentials: r.credentials, tenantId: TENANT, vaultIds: [r.vault.id] });
    expect(results.map((x) => x.status)).toEqual(["refreshed"]);
    expect((await r.active())[0].auth.composio_connected_accounts).toEqual({ hubspot: "ca_6pGEZwWUC6Bt" });
  });

  it("concurrent session starts re-provision a router once", async () => {
    const composio = fakeComposio();
    const r = await rig({ composio });
    composio.state.accounts = [account("ca_hub", "hubspot", r.user)];
    await seedLegacyRouter(r);
    const lazy = () => r.refresher.refreshVaults({ credentials: r.credentials, tenantId: TENANT, vaultIds: [r.vault.id] });
    await Promise.all([lazy(), lazy(), lazy()]);
    expect(composio.routerCreates()).toHaveLength(1);
    expect(await r.active()).toHaveLength(1);
  });

  it("never binds or even lists another tenant's user under the platform key", async () => {
    const composio = fakeComposio();
    const r = await rig({ composio });
    await seedLegacyRouter(r, { composio_user_id: "oma:tnt_victim:vlt_victim" });
    const results = await r.refresher.refreshVaults({ credentials: r.credentials, tenantId: TENANT, vaultIds: [r.vault.id] });
    expect(results[0]).toMatchObject({ status: "skipped", reason: "user_id outside this tenant" });
    expect(composio.calls).toEqual([]);
  });

  it("a router stored with its tenant's own key is re-provisioned with that key", async () => {
    const composio = fakeComposio();
    const r = await rig({ composio });
    composio.state.accounts = [account("ca_hub", "hubspot", r.user)];
    await seedLegacyRouter(r, { api_key: "tenant-key", api_key_env: undefined });
    await r.refresher.refreshVaults({ credentials: r.credentials, tenantId: TENANT, vaultIds: [r.vault.id] });
    expect(composio.calls.every((c) => c.apiKey === "tenant-key")).toBe(true);
    expect((await r.active())[0].auth).toMatchObject({ api_key: "tenant-key" });
  });

  it("a hung Composio: requests time out, concurrent session starts don't queue behind it, and back-off starts at once", async () => {
    let now = 0;
    const composio = fakeComposio();
    composio.state.hang = true;
    const r = await rig({ composio, now: () => now, requestTimeoutMs: 50 });
    await seedLegacyRouter(r);
    const lazy = () => r.refresher.refreshVaults({ credentials: r.credentials, tenantId: TENANT, vaultIds: [r.vault.id] });
    const first = lazy();
    // While the first run hangs, another session start returns at once.
    const t0 = Date.now();
    const second = await lazy();
    expect(Date.now() - t0).toBeLessThan(40);
    expect(second.map((x) => x.reason)).toEqual(["recently checked"]);
    const [result] = await first;
    expect(result).toMatchObject({ status: "skipped" });
    expect(result.reason).toMatch(/timeout/i);
    expect(composio.listings()).toHaveLength(1);
  });

  it("a Composio outage backs off instead of failing every session start", async () => {
    let now = 0;
    const composio = fakeComposio();
    composio.state.failListing = true;
    const r = await rig({ composio, now: () => now });
    await seedLegacyRouter(r);
    const lazy = () => r.refresher.refreshVaults({ credentials: r.credentials, tenantId: TENANT, vaultIds: [r.vault.id] });
    expect((await lazy())[0].status).toBe("skipped");
    now += 1_000;
    await lazy();
    expect(composio.listings()).toHaveLength(1);
  });
});

describe("ambient dispatch repairs vault credentials before the session snapshot", () => {
  it("calls refreshVaultCredentials with the agent's default vaults before sessions.create", async () => {
    const { service: ambientRules } = createInMemoryAmbientRuleService({ clock: { nowMs: () => 0 } });
    const order: string[] = [];
    const dispatcher = new NodeAmbientDispatcher({
      ambientRules,
      agents: {
        get: async () => ({ id: "agt_1", name: "a", archived_at: null, metadata: { default_vault_ids: ["vlt_apps"] } }),
      } as never,
      sessions: {
        create: async () => {
          order.push("create");
          return { session: { id: "s1" }, resources: [] };
        },
      } as never,
      appendUserEvent: async () => {},
      refreshVaultCredentials: async (_tenantId, vaultIds) => {
        order.push(`refresh:${vaultIds.join(",")}`);
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
    expect(order).toEqual(["refresh:vlt_apps", "create"]);
  });
});

describe("explicit bindings are kept (check / force / lazy)", () => {
  const SLACK_A = "ca_A_chosen";
  const SLACK_B = "ca_B_new";

  it("check: a newer ACTIVE account of a bound toolkit does NOT move the router", async () => {
    const composio = fakeComposio();
    const r = await rig({ composio });
    composio.state.accounts = [account(SLACK_A, "slack", r.user, { created_at: "2026-11-01T00:00:00.000Z" })];
    await r.post(`/v1/vaults/${r.vault.id}/credentials/composio_tool_router_session`, { toolkits: { enable: ["slack"] } });
    // A second workspace is connected (for another agent).
    composio.state.accounts.push(account(SLACK_B, "slack", r.user, { created_at: "2026-11-10T00:00:00.000Z" }));
    const res = await r.post(`/v1/vaults/${r.vault.id}/credentials/composio_tool_router_session/refresh`, {});
    expect(res.body.refreshed).toBe(0);
    expect((await r.active())[0].auth.composio_connected_accounts).toEqual({ slack: SLACK_A });
    // force re-provisions, still on the chosen account.
    await r.post(`/v1/vaults/${r.vault.id}/credentials/composio_tool_router_session/refresh`, { mode: "force" });
    expect(composio.routerCreates().at(-1)!.body.connected_accounts).toEqual({ slack: SLACK_A });
  });

  it("check: a bound account that EXPIRED is replaced by the newest ACTIVE one", async () => {
    const composio = fakeComposio();
    const r = await rig({ composio });
    composio.state.accounts = [account(SLACK_A, "slack", r.user)];
    await r.post(`/v1/vaults/${r.vault.id}/credentials/composio_tool_router_session`, { toolkits: { enable: ["slack"] } });
    composio.state.accounts = [
      account(SLACK_A, "slack", r.user, { status: "EXPIRED" }),
      account(SLACK_B, "slack", r.user, { created_at: "2026-11-11T00:00:00.000Z" }),
    ];
    const res = await r.post(`/v1/vaults/${r.vault.id}/credentials/composio_tool_router_session/refresh`, {});
    expect(res.body.refreshed).toBe(1);
    expect((await r.active())[0].auth.composio_connected_accounts).toEqual({ slack: SLACK_B });
  });

  it("lazy on a legacy row keeps the accounts its composio_connected_account_ids named", async () => {
    const composio = fakeComposio();
    const r = await rig({ composio });
    composio.state.accounts = [
      account(SLACK_A, "slack", r.user, { created_at: "2026-11-01T00:00:00.000Z" }),
      account(SLACK_B, "slack", r.user, { created_at: "2026-11-10T00:00:00.000Z" }),
      account("ca_hub", "hubspot", r.user),
    ];
    await seedLegacyRouter(r, { composio_connected_account_ids: [SLACK_A] });
    await r.refresher.refreshVaults({ credentials: r.credentials, tenantId: TENANT, vaultIds: [r.vault.id] });
    expect(composio.routerCreates()[0].body.connected_accounts).toEqual({ hubspot: "ca_hub", slack: SLACK_A });
  });
});

describe("re-provision keeps the router's auth configs", () => {
  it("passes the stored toolkit→auth_config map back (refresh)", async () => {
    const composio = fakeComposio();
    const r = await rig({ composio });
    await r.post(`/v1/vaults/${r.vault.id}/credentials/composio_tool_router_session`, {
      toolkits: { enable: ["twitter", "gmail"] },
      auth_configs: { twitter: "ac_custom_x" },
    });
    composio.state.accounts = [account("ca_gm", "gmail", r.user)];
    await r.post(`/v1/vaults/${r.vault.id}/credentials/composio_tool_router_session/refresh`, {});
    expect(composio.routerCreates()[1].body).toMatchObject({
      auth_configs: { twitter: "ac_custom_x" },
      connected_accounts: { gmail: "ca_gm" },
    });
    expect((await r.active())[0].auth.composio_auth_configs).toEqual({ twitter: "ac_custom_x" });
  });

  it("legacy rows rebuild the map from the listed accounts' auth configs", async () => {
    const composio = fakeComposio();
    const r = await rig({ composio });
    composio.state.accounts = [account("ca_hub", "hubspot", r.user, { auth_config: { id: "ac_hub_custom" } })];
    await seedLegacyRouter(r, { composio_auth_config_ids: ["ac_hub_custom"] });
    await r.refresher.refreshVaults({ credentials: r.credentials, tenantId: TENANT, vaultIds: [r.vault.id] });
    expect(composio.routerCreates()[0].body.auth_configs).toEqual({ hubspot: "ac_hub_custom" });
  });

  it("toolkit add carries the map and adds the connect flow's auth config for the new toolkit", async () => {
    const composio = fakeComposio();
    const r = await rig({ composio });
    await r.post(`/v1/vaults/${r.vault.id}/credentials/composio_tool_router_session`, {
      toolkits: { enable: ["hubspot"] },
      auth_configs: { hubspot: "ac_hub" },
    });
    await r.post(`/v1/vaults/${r.vault.id}/credentials/composio_accounts/link`, { toolkit: "twitter", auth_config_id: "ac_x" });
    expect(composio.routerCreates()[1].body.auth_configs).toEqual({ hubspot: "ac_hub", twitter: "ac_x" });
    // Without an explicit one: the config the link was created with.
    await r.post(`/v1/vaults/${r.vault.id}/credentials/composio_accounts/link`, { toolkit: "gmail" });
    expect(composio.routerCreates()[2].body.auth_configs).toEqual({ hubspot: "ac_hub", twitter: "ac_x", gmail: "ac_gmail" });
  });
});

describe("refresh safety rails", () => {
  it("check skips a legacy unlocked router (its disable list was never stored); force still re-provisions", async () => {
    const composio = fakeComposio();
    const r = await rig({ composio });
    composio.state.accounts = [account("ca_hub", "hubspot", r.user)];
    await seedLegacyRouter(r, { composio_toolkits: undefined });
    const check = await r.post(`/v1/vaults/${r.vault.id}/credentials/composio_tool_router_session/refresh`, {});
    expect(check.body.data[0]).toMatchObject({ status: "skipped" });
    expect(composio.routerCreates()).toHaveLength(0);
    const force = await r.post(`/v1/vaults/${r.vault.id}/credentials/composio_tool_router_session/refresh`, { mode: "force" });
    expect(force.body.refreshed).toBe(1);
  });

  it("a row naming another env var for its key is skipped (the proxies would refuse it too)", async () => {
    const composio = fakeComposio();
    const r = await rig({ composio });
    await seedLegacyRouter(r, { api_key_env: "OTHER_COMPOSIO_KEY" });
    const results = await r.refresher.refreshVaults({ credentials: r.credentials, tenantId: TENANT, vaultIds: [r.vault.id], mode: "force" });
    expect(results[0]).toMatchObject({ status: "skipped", reason: "no usable Composio API key" });
    expect(composio.calls).toEqual([]);
  });

  it("a full vault is skipped BEFORE a Composio session is created (no orphan routers)", async () => {
    const composio = fakeComposio();
    const r = await rig({ composio });
    composio.state.accounts = [account("ca_hub", "hubspot", r.user)];
    await seedLegacyRouter(r);
    for (let i = 0; i < 19; i++) {
      await r.credentials.create({
        tenantId: TENANT,
        vaultId: r.vault.id,
        displayName: `k${i}`,
        auth: { type: "static_bearer", mcp_server_url: `https://mcp${i}.example.com/mcp`, token: "t" } as never,
      });
    }
    const results = await r.refresher.refreshVaults({ credentials: r.credentials, tenantId: TENANT, vaultIds: [r.vault.id] });
    expect(results[0].status).toBe("skipped");
    expect(composio.routerCreates()).toHaveLength(0);
  });

  it("a check that queues behind an in-flight lazy run re-reads and sees its result", async () => {
    const composio = fakeComposio();
    const r = await rig({ composio });
    composio.state.accounts = [account("ca_hub", "hubspot", r.user)];
    await seedLegacyRouter(r);
    const [lazy, check] = await Promise.all([
      r.refresher.refreshVaults({ credentials: r.credentials, tenantId: TENANT, vaultIds: [r.vault.id] }),
      r.post(`/v1/vaults/${r.vault.id}/credentials/composio_tool_router_session/refresh`, {}),
    ]);
    expect(lazy.map((x) => x.status)).toEqual(["refreshed"]);
    // Ran on the replacement (already bound), not on the stale legacy row.
    expect(check.body.data).toHaveLength(1);
    expect(check.body.data[0]).toMatchObject({ status: "unchanged", credential_id: lazy[0].replacement_credential_id });
    expect(composio.routerCreates()).toHaveLength(1);
    expect(await r.active()).toHaveLength(1);
  });

  it("toolkit add and a session-start repair racing on one vault leave ONE active router", async () => {
    const composio = fakeComposio();
    const r = await rig({ composio });
    composio.state.accounts = [account("ca_hub", "hubspot", r.user)];
    await seedLegacyRouter(r);
    await Promise.all([
      r.refresher.refreshVaults({ credentials: r.credentials, tenantId: TENANT, vaultIds: [r.vault.id] }),
      r.post(`/v1/vaults/${r.vault.id}/credentials/composio_accounts/link`, { toolkit: "gmail" }),
    ]);
    const active = (await r.active()).filter((c) => c.auth.type === "composio_mcp");
    expect(active).toHaveLength(1);
    expect(active[0].auth.composio_toolkits).toContain("gmail");
  });

  it("rotateRouterCredential: when another process already archived the replaced row, the new one is archived", async () => {
    const composio = fakeComposio();
    const r = await rig({ composio });
    const legacy = await seedLegacyRouter(r);
    await r.credentials.archive({ tenantId: TENANT, vaultId: r.vault.id, credentialId: legacy.id });
    const rotated = await rotateRouterCredential(r.credentials, {
      tenantId: TENANT,
      vaultId: r.vault.id,
      replaced: legacy,
      displayName: "x",
      auth: { type: "composio_mcp", mcp_server_url: "https://backend.composio.dev/tool_router/trs_mine/mcp" } as never,
    });
    expect(rotated.conflict).toBe(true);
    expect(await r.active()).toHaveLength(0);
  });
});

describe("composio_mcp key exfiltration guard", () => {
  it("the proxies read only the platform key's variable, only towards a Composio endpoint", () => {
    const router = "https://backend.composio.dev/tool_router/trs_x/mcp";
    expect(composioPlatformKeyEnvFor({}, router)).toBe("COMPOSIO_API_KEY");
    expect(composioPlatformKeyEnvFor({ api_key_env: "COMPOSIO_API_KEY" }, router)).toBe("COMPOSIO_API_KEY");
    expect(composioPlatformKeyEnvFor({ api_key_env: "DATABASE_URL" }, router)).toBeNull();
    expect(composioPlatformKeyEnvFor({ api_key_env: "COMPOSIO_API_KEY" }, "https://attacker.example/tool_router/x/mcp")).toBeNull();
    expect(composioPlatformKeyEnvFor({}, "https://app.composio.dev.attacker.example/tool_router/x/mcp")).toBeNull();
  });

  it("credential create/update refuse composio_mcp auth aimed at another host or another env var", async () => {
    const composio = fakeComposio();
    const r = await rig({ composio });
    const attack = await r.post(`/v1/vaults/${r.vault.id}/credentials`, {
      display_name: "x",
      auth: { type: "composio_mcp", mcp_server_url: "https://attacker.example/tool_router/x/mcp", api_key_env: "COMPOSIO_API_KEY" },
    });
    expect(attack.status).toBe(400);
    const otherEnv = await r.post(`/v1/vaults/${r.vault.id}/credentials`, {
      display_name: "x",
      auth: { type: "composio_mcp", mcp_server_url: "https://backend.composio.dev/tool_router/trs_x/mcp", api_key_env: "DATABASE_URL" },
    });
    expect(otherEnv.status).toBe(400);
    const ok = await r.post(`/v1/vaults/${r.vault.id}/credentials`, {
      display_name: "Composio",
      auth: { type: "composio_mcp", mcp_server_url: "https://app.composio.dev/tool_router/v3/session/mcp", api_key: "tenant-key" },
    });
    expect(ok.status).toBe(201);
    const update = await r.post(`/v1/vaults/${r.vault.id}/credentials/${ok.body.id}`, { auth: { api_key_env: "ANTHROPIC_API_KEY" } });
    expect(update.status).toBe(400);
    expect(composioCredentialAuthError({ type: "static_bearer", mcp_server_url: "https://mcp.example.com/mcp" })).toBeNull();
  });
});
