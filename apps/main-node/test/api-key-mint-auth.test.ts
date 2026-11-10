import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createAuthMiddleware } from "@open-managed-agents/auth";
import {
  buildApiKeyRoutes,
  buildMeRoutes,
  type ApiKeyRecord,
  type ApiKeyStorage,
} from "@open-managed-agents/http-routes";

// Keys have no scopes (each is a full tenant credential), so a request
// authenticated BY a key must not mint more keys — a leaked key would
// otherwise outlive its own revocation. Console sessions keep minting.

function memoryStorage() {
  const rows = new Map<string, ApiKeyRecord>();
  const storage: ApiKeyStorage = {
    insert: async ({ hash, record }) => void rows.set(hash, record),
    listByTenant: async (tenantId) =>
      [...rows.values()]
        .filter((r) => r.tenant_id === tenantId)
        .map((r) => ({ id: r.id, name: r.name, prefix: "oma_xxxx", created_at: r.created_at })),
    findByHash: async (hash) => rows.get(hash) ?? null,
    deleteById: async () => false,
  };
  return { rows, storage };
}

/** The real auth middleware in front of the key + me routes. */
function appWith(storage: ApiKeyStorage, opts: { disabled?: boolean } = {}) {
  const auth = createAuthMiddleware({
    disabled: opts.disabled ?? false,
    resolveSession: async (headers) =>
      headers.get("cookie") === "session=alice" ? { userId: "alice" } : null,
    resolveApiKey: async (key) =>
      key === "oma_scoped" ? { tenantId: "t1", userId: "alice" } : key === "oma_legacy" ? { tenantId: "t1" } : null,
    defaultTenantForUser: async () => "t1",
    hasMembership: async () => true,
    ensureTenantForUser: async () => "t1",
  });
  const app = new Hono();
  app.use("/v1/*", auth);
  app.route("/v1/api_keys", buildApiKeyRoutes({ storage }));
  app.route(
    "/v1/me",
    buildMeRoutes({
      services: {} as never,
      authDisabled: opts.disabled ?? false,
      hasMembership: async () => true,
      mintApiKey: async () => ({ id: "ak_1", key: "oma_new", prefix: "oma_new", createdAt: "now" }),
    }),
  );
  return app;
}

const post = (headers: Record<string, string>, body: unknown = { name: "k" }) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

describe("API key minting over API-key auth", () => {
  it("refuses POST /v1/api_keys from a user-scoped key", async () => {
    const { rows, storage } = memoryStorage();
    const res = await appWith(storage).request("/v1/api_keys", post({ "x-api-key": "oma_scoped" }));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { type: string } }).error.type).toBe("permission_error");
    expect(rows.size).toBe(0);
  });

  it("refuses POST /v1/api_keys from a legacy (user-less) key", async () => {
    const { rows, storage } = memoryStorage();
    const res = await appWith(storage).request("/v1/api_keys", post({ "x-api-key": "oma_legacy" }));
    expect(res.status).toBe(403);
    expect(rows.size).toBe(0);
  });

  it("refuses POST /v1/me/cli-tokens from a key, even one that carries a user_id", async () => {
    const { storage } = memoryStorage();
    const res = await appWith(storage).request("/v1/me/cli-tokens", post({ "x-api-key": "oma_scoped" }, {}));
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("oma_new");
  });

  it("still lets a key list keys (read paths are unchanged)", async () => {
    const { storage } = memoryStorage();
    const res = await appWith(storage).request("/v1/api_keys", { headers: { "x-api-key": "oma_scoped" } });
    expect(res.status).toBe(200);
  });

  it("console sessions keep full ability on both mint paths", async () => {
    const { rows, storage } = memoryStorage();
    const app = appWith(storage);
    const created = await app.request("/v1/api_keys", post({ cookie: "session=alice" }));
    expect(created.status).toBe(201);
    expect(rows.size).toBe(1);
    expect([...rows.values()][0]).toMatchObject({ tenant_id: "t1", user_id: "alice" });
    const cli = await app.request("/v1/me/cli-tokens", post({ cookie: "session=alice" }, {}));
    expect(cli.status).toBe(201);
  });

  it("AUTH_DISABLED dev keeps minting", async () => {
    const { storage } = memoryStorage();
    const res = await appWith(storage, { disabled: true }).request("/v1/api_keys", post({}));
    expect(res.status).toBe(201);
  });
});

describe("auth middleware records how the request authenticated", () => {
  const probe = (disabled = false) => {
    const app = new Hono<{ Variables: { auth_type?: string } }>();
    app.use(
      "*",
      createAuthMiddleware({
        disabled,
        resolveSession: async (h) => (h.get("cookie") ? { userId: "alice" } : null),
        resolveApiKey: async () => ({ tenantId: "t1" }),
        defaultTenantForUser: async () => "t1",
        hasMembership: async () => true,
        ensureTenantForUser: async () => "t1",
      }),
    );
    app.get("/x", (c) => c.text(c.var.auth_type ?? "none"));
    return app;
  };

  it("api_key / session / disabled", async () => {
    expect(await (await probe().request("/x", { headers: { "x-api-key": "k" } })).text()).toBe("api_key");
    expect(await (await probe().request("/x", { headers: { cookie: "s=1" } })).text()).toBe("session");
    expect(await (await probe(true).request("/x")).text()).toBe("disabled");
  });

  it("a key wins over a cookie sent alongside it", async () => {
    const res = await probe().request("/x", { headers: { "x-api-key": "k", cookie: "s=1" } });
    expect(await res.text()).toBe("api_key");
  });
});
