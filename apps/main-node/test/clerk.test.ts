// Clerk integration — unit tests. No network: JWKS is injected, tokens
// are minted with a local RSA keypair, svix signatures are computed
// in-test with a known secret, and the store runs on in-memory sqlite.

import { describe, it, expect, beforeEach } from "vitest";
import { createHmac, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import Database from "better-sqlite3";
import { BetterSqlite3SqlClient } from "@open-managed-agents/sql-client/adapters/better-sqlite3";
import {
  resolveClerkConfig,
  entitlementsFromClaims,
  ClerkTokenVerifier,
  ClerkStore,
  verifySvixSignature,
  buildClerkPreCreateGate,
  handleClerkWebhook,
  isPaidPlan,
  primaryEmailOf,
  type ClerkConfig,
} from "../src/lib/clerk";

// ─── helpers ─────────────────────────────────────────────────────────────

const ISSUER = "https://test-app-42.clerk.accounts.dev";

function baseConfig(overrides: Partial<ClerkConfig> = {}): ClerkConfig {
  return {
    issuer: ISSUER,
    jwksUrl: `${ISSUER}/.well-known/jwks.json`,
    authorizedParties: [],
    webhookSigningSecret: null,
    secretKey: null,
    billingEnforce: false,
    freePlanActiveSessionLimit: 3,
    ...overrides,
  };
}

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWK = { ...(publicKey.export({ format: "jwk" }) as object), kid: "key-1" } as {
  kid: string;
  kty: string;
};

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function mintToken(
  claims: Record<string, unknown>,
  opts: { kid?: string; alg?: string } = {},
): string {
  const header = { alg: opts.alg ?? "RS256", typ: "JWT", kid: opts.kid ?? "key-1" };
  const h = b64url(Buffer.from(JSON.stringify(header)));
  const p = b64url(Buffer.from(JSON.stringify(claims)));
  const sig = cryptoSign("RSA-SHA256", Buffer.from(`${h}.${p}`), privateKey);
  return `${h}.${p}.${b64url(sig)}`;
}

function goodClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: ISSUER,
    sub: "user_2abcDEF",
    sid: "sess_123",
    exp: now + 60,
    nbf: now - 10,
    iat: now,
    v: 2,
    ...overrides,
  };
}

function verifier(config = baseConfig()): ClerkTokenVerifier {
  return new ClerkTokenVerifier(config, {
    fetchJwks: async () => ({ keys: [JWK] }),
  });
}

function buildStore() {
  const db = new Database(":memory:");
  const sql = new BetterSqlite3SqlClient(db);
  // Minimal tenant/membership fakes so ensureTenant + orgTenancy behave
  // like the shell's real closures.
  const tenants: Array<{ userId: string; tenantId: string }> = [];
  const orgTenants: string[] = [];
  const memberships: Array<{ userId: string; tenantId: string; role: string }> = [];
  const store = new ClerkStore({
    sql,
    dialect: "sqlite",
    ensureTenant: async (userId) => {
      const existing = tenants.find((t) => t.userId === userId);
      if (existing) return existing.tenantId;
      const tenantId = `tn_${tenants.length + 1}`;
      tenants.push({ userId, tenantId });
      return tenantId;
    },
    orgTenancy: {
      createTenant: async (name) => {
        const tenantId = `tn_org_${orgTenants.length + 1}_${name.replace(/\W+/g, "").slice(0, 8)}`;
        orgTenants.push(tenantId);
        return tenantId;
      },
      addMembership: async (userId, tenantId, role) => {
        if (!memberships.some((m) => m.userId === userId && m.tenantId === tenantId)) {
          memberships.push({ userId, tenantId, role });
        }
      },
      removeMembership: async (userId, tenantId) => {
        const i = memberships.findIndex((m) => m.userId === userId && m.tenantId === tenantId);
        if (i >= 0) memberships.splice(i, 1);
      },
    },
  });
  return { store, tenants, memberships, sql };
}

// ─── config ──────────────────────────────────────────────────────────────

describe("resolveClerkConfig", () => {
  it("returns null when nothing is configured", () => {
    expect(resolveClerkConfig({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it("uses CLERK_ISSUER and strips trailing slash", () => {
    const c = resolveClerkConfig({ CLERK_ISSUER: `${ISSUER}/` } as NodeJS.ProcessEnv)!;
    expect(c.issuer).toBe(ISSUER);
    expect(c.jwksUrl).toBe(`${ISSUER}/.well-known/jwks.json`);
  });

  it("derives issuer from the publishable key", () => {
    const pk = `pk_test_${Buffer.from("test-app-42.clerk.accounts.dev$").toString("base64")}`;
    const c = resolveClerkConfig({ CLERK_PUBLISHABLE_KEY: pk } as NodeJS.ProcessEnv)!;
    expect(c.issuer).toBe(ISSUER);
  });
});

// ─── claims parsing ──────────────────────────────────────────────────────

describe("entitlementsFromClaims", () => {
  it("parses user plan and features", () => {
    const e = entitlementsFromClaims({ pla: "u:free_user", fea: "u:api,u:webhooks" });
    expect(e).toEqual({ plan: "free_user", planScope: "u", features: ["api", "webhooks"] });
  });

  it("org plan wins over user plan", () => {
    const e = entitlementsFromClaims({ pla: "u:free_user,o:pro" });
    expect(e.plan).toBe("pro");
    expect(e.planScope).toBe("o");
  });

  it("tolerates absent claims", () => {
    expect(entitlementsFromClaims({})).toEqual({ plan: null, planScope: null, features: [] });
  });
});

// ─── JWT verification ────────────────────────────────────────────────────

describe("ClerkTokenVerifier", () => {
  it("verifies a good token and extracts entitlements", async () => {
    const v = verifier();
    const out = await v.verify(mintToken(goodClaims({ pla: "u:pro" })));
    expect(out.userId).toBe("user_2abcDEF");
    expect(out.sessionId).toBe("sess_123");
    expect(out.entitlements.plan).toBe("pro");
  });

  it("rejects a tampered payload", async () => {
    const token = mintToken(goodClaims());
    const [h, p, s] = token.split(".");
    const forged = b64url(Buffer.from(JSON.stringify(goodClaims({ sub: "user_evil" }))));
    await expect(verifier().verify(`${h}.${forged}.${s}`)).rejects.toThrow(/bad signature/);
  });

  it("rejects wrong issuer, expiry, alg, and unknown kid", async () => {
    const v = verifier();
    await expect(v.verify(mintToken(goodClaims({ iss: "https://evil.example" })))).rejects.toThrow(
      /issuer mismatch/,
    );
    await expect(
      v.verify(mintToken(goodClaims({ exp: Math.floor(Date.now() / 1000) - 3600 }))),
    ).rejects.toThrow(/expired/);
    await expect(v.verify(mintToken(goodClaims(), { alg: "HS256" }))).rejects.toThrow(
      /unsupported alg/,
    );
    await expect(v.verify(mintToken(goodClaims(), { kid: "key-unknown" }))).rejects.toThrow(
      /no JWKS key/,
    );
  });

  it("flags whether the token carries billing claims", async () => {
    const v = verifier();
    const withPla = await v.verify(mintToken(goodClaims({ pla: "u:pro" })));
    expect(withPla.hasBillingClaims).toBe(true);
    const without = await v.verify(mintToken(goodClaims()));
    expect(without.hasBillingClaims).toBe(false);
    expect(without.entitlements.plan).toBeNull();
  });

  it("enforces the azp allowlist only when configured", async () => {
    const open = verifier();
    await expect(open.verify(mintToken(goodClaims({ azp: "https://anything" })))).resolves.toBeTruthy();
    const strict = verifier(baseConfig({ authorizedParties: ["https://app.openma.dev"] }));
    await expect(
      strict.verify(mintToken(goodClaims({ azp: "https://app.openma.dev" }))),
    ).resolves.toBeTruthy();
    await expect(strict.verify(mintToken(goodClaims({ azp: "https://evil.dev" })))).rejects.toThrow(
      /azp not allowed/,
    );
  });
});

// ─── svix signatures ─────────────────────────────────────────────────────

describe("verifySvixSignature", () => {
  const secretBytes = Buffer.from("super-secret-signing-key-32bytes!");
  const secret = `whsec_${secretBytes.toString("base64")}`;

  function signedHeaders(body: string, ts = Math.floor(Date.now() / 1000)) {
    const sig = createHmac("sha256", secretBytes).update(`msg_1.${ts}.${body}`).digest("base64");
    return { svixId: "msg_1", svixTimestamp: String(ts), svixSignature: `v1,${sig}` };
  }

  it("accepts a valid signature (and among multiple entries)", () => {
    const body = '{"type":"user.created"}';
    const h = signedHeaders(body);
    expect(verifySvixSignature({ secret, rawBody: body, ...h })).toBe(true);
    expect(
      verifySvixSignature({
        secret,
        rawBody: body,
        ...h,
        svixSignature: `v1,AAAA ${h.svixSignature}`,
      }),
    ).toBe(true);
  });

  it("rejects bad signatures, stale timestamps, and missing headers", () => {
    const body = '{"type":"user.created"}';
    const h = signedHeaders(body);
    expect(verifySvixSignature({ secret, rawBody: body + " ", ...h })).toBe(false);
    const stale = signedHeaders(body, Math.floor(Date.now() / 1000) - 601);
    expect(verifySvixSignature({ secret, rawBody: body, ...stale })).toBe(false);
    expect(
      verifySvixSignature({ secret, rawBody: body, ...h, svixSignature: undefined }),
    ).toBe(false);
  });
});

// ─── store ───────────────────────────────────────────────────────────────

describe("ClerkStore", () => {
  let t: ReturnType<typeof buildStore>;

  beforeEach(async () => {
    t = buildStore();
    await t.store.ensureSchema();
  });

  it("upserts users, provisions a tenant, and picks the primary email", async () => {
    const row = await t.store.upsertUser({
      id: "user_1",
      first_name: "Karim",
      last_name: "R",
      primary_email_address_id: "em_2",
      email_addresses: [
        { id: "em_1", email_address: "old@example.com" },
        { id: "em_2", email_address: "karim@example.com" },
      ],
    });
    expect(row?.tenant_id).toBe("tn_1");
    expect(row?.email).toBe("karim@example.com");
    expect(row?.name).toBe("Karim R");

    // user.updated: same tenant, new email; deleted flag clears.
    await t.store.markDeleted("user_1");
    const updated = await t.store.upsertUser({
      id: "user_1",
      email_addresses: [{ id: "em_3", email_address: "new@example.com" }],
    });
    expect(updated?.tenant_id).toBe("tn_1");
    expect(updated?.email).toBe("new@example.com");
    expect(updated?.deleted_at).toBeNull();
  });

  it("records events idempotently by svix id", async () => {
    expect(await t.store.recordEvent("msg_1", "user.created", "{}")).toBe(true);
    expect(await t.store.recordEvent("msg_1", "user.created", "{}")).toBe(false);
  });

  it("applies billing events to the payer's plan and reports it per tenant", async () => {
    await t.store.upsertUser({ id: "user_1" });
    await t.store.applyBillingEvent("subscriptionItem.active", {
      payer: { user_id: "user_1" },
      plan: { slug: "pro" },
      status: "active",
    });
    expect(await t.store.planForTenant("tn_1")).toEqual({ plan: "pro", billing_status: "active" });

    await t.store.applyBillingEvent("subscriptionItem.canceled", {
      payer: { user_id: "user_1" },
      plan: { slug: "pro" },
      status: "canceled",
    });
    const after = await t.store.planForTenant("tn_1");
    expect(after?.plan).toBeNull();
    expect(after?.billing_status).toBe("canceled");
  });

  it("pastDue clears the plan; abandoned/freeTrialEnding/paymentAttempt do not", async () => {
    await t.store.upsertUser({ id: "user_1" });
    const activate = () =>
      t.store.applyBillingEvent("subscriptionItem.active", {
        payer: { user_id: "user_1" },
        plan: { slug: "pro" },
        status: "active",
      });

    await activate();
    await t.store.applyBillingEvent("subscriptionItem.pastDue", {
      payer: { user_id: "user_1" },
      plan: { slug: "pro" },
      status: "past_due",
    });
    expect((await t.store.planForTenant("tn_1"))?.plan).toBeNull();

    await activate();
    await t.store.applyBillingEvent("subscriptionItem.abandoned", {
      payer: { user_id: "user_1" },
      plan: { slug: "old_plan" },
      status: "abandoned",
    });
    expect((await t.store.planForTenant("tn_1"))?.plan).toBe("pro");

    await t.store.applyBillingEvent("subscriptionItem.freeTrialEnding", {
      payer: { user_id: "user_1" },
      plan: { slug: "pro" },
    });
    expect((await t.store.planForTenant("tn_1"))?.plan).toBe("pro");

    // paymentAttempt is status-only: never sets or clears the plan.
    await t.store.applyBillingEvent("paymentAttempt.updated", {
      payer: { user_id: "user_1" },
      plan: { slug: "enterprise" },
      status: "paid",
    });
    const after = await t.store.planForTenant("tn_1");
    expect(after?.plan).toBe("pro");
    expect(after?.billing_status).toBe("paid");
  });

  it("organizations: provision tenant, membership add/remove, org billing wins for the tenant", async () => {
    await t.store.upsertOrg({ id: "org_1", name: "Acme Inc", slug: "acme" });
    const org = await t.store.getOrg("org_1");
    expect(org?.tenant_id).toMatch(/^tn_org_1_/);

    // Membership arriving before organization.created self-heals via upsertOrg.
    await t.store.addOrgMember({
      organization: { id: "org_1" },
      public_user_data: { user_id: "user_a" },
      role: "org:admin",
    });
    await t.store.addOrgMember({
      organization: { id: "org_2", name: "Beta LLC" },
      public_user_data: { user_id: "user_b" },
      role: "org:member",
    });
    expect(t.memberships).toEqual([
      { userId: "user_a", tenantId: org!.tenant_id, role: "owner" },
      { userId: "user_b", tenantId: (await t.store.getOrg("org_2"))!.tenant_id!, role: "member" },
    ]);

    // Org-payer billing event lands on clerk_orgs and wins planForTenant.
    await t.store.applyBillingEvent("subscriptionItem.active", {
      payer: { organization_id: "org_1" },
      plan: { slug: "team" },
      status: "active",
    });
    expect(await t.store.planForTenant(org!.tenant_id!)).toEqual({
      plan: "team",
      billing_status: "active",
    });

    await t.store.removeOrgMember({
      organization: { id: "org_1" },
      public_user_data: { user_id: "user_a" },
    });
    expect(t.memberships.some((m) => m.userId === "user_a")).toBe(false);

    await t.store.markOrgDeleted("org_1");
    expect(await t.store.planForTenant(org!.tenant_id!)).toBeNull();
  });

  it("primaryEmailOf falls back to the first address", () => {
    expect(primaryEmailOf({ email_addresses: [{ id: "x", email_address: "a@b.c" }] })).toBe("a@b.c");
    expect(primaryEmailOf({})).toBeNull();
  });
});

// ─── entitlement gate ────────────────────────────────────────────────────

describe("buildClerkPreCreateGate", () => {
  it("free plan over the cap → 402; paid or unknown tenants pass", async () => {
    const t = buildStore();
    await t.store.ensureSchema();
    await t.store.upsertUser({ id: "user_free" });
    await t.store.syncEntitlementsFromClaims("user_free", {
      plan: "free_user",
      planScope: "u",
      features: [],
    });

    let active = 3;
    const gate = buildClerkPreCreateGate({
      store: t.store,
      config: baseConfig({ billingEnforce: true, freePlanActiveSessionLimit: 3 }),
      countActiveSessions: async () => active,
    });

    const blocked = await gate({ tenantId: "tn_1", agentId: "a", isLocalRuntime: true });
    expect(blocked?.status).toBe(402);
    expect(JSON.stringify(blocked?.body)).toMatch(/payment_required/);

    active = 2;
    expect(await gate({ tenantId: "tn_1", agentId: "a", isLocalRuntime: true })).toBeNull();

    // Unknown tenant (better-auth user) fails open.
    expect(await gate({ tenantId: "tn_other", agentId: "a", isLocalRuntime: true })).toBeNull();

    // Paid plan passes regardless of count.
    active = 99;
    await t.store.syncEntitlementsFromClaims("user_free", {
      plan: "pro",
      planScope: "u",
      features: [],
    });
    expect(await gate({ tenantId: "tn_1", agentId: "a", isLocalRuntime: true })).toBeNull();
  });

  it("isPaidPlan treats free* slugs as unpaid", () => {
    expect(isPaidPlan("free_user")).toBe(false);
    expect(isPaidPlan("free_org")).toBe(false);
    expect(isPaidPlan(null)).toBe(false);
    expect(isPaidPlan("pro")).toBe(true);
  });
});

// ─── webhook handler end-to-end ─────────────────────────────────────────

describe("handleClerkWebhook", () => {
  const secretBytes = Buffer.from("another-32-byte-webhook-secret!!");
  const secret = `whsec_${secretBytes.toString("base64")}`;

  function signed(body: string, id = "msg_e2e_1") {
    const ts = Math.floor(Date.now() / 1000);
    const sig = createHmac("sha256", secretBytes).update(`${id}.${ts}.${body}`).digest("base64");
    return { svixId: id, svixTimestamp: String(ts), svixSignature: `v1,${sig}` };
  }

  it("verifies, syncs the user, and dedupes replays", async () => {
    const t = buildStore();
    await t.store.ensureSchema();
    const config = baseConfig({ webhookSigningSecret: secret });
    const body = JSON.stringify({
      type: "user.created",
      data: {
        id: "user_wh1",
        first_name: "Web",
        last_name: "Hook",
        primary_email_address_id: "em_1",
        email_addresses: [{ id: "em_1", email_address: "wh@example.com" }],
      },
    });
    const headers = signed(body);

    const first = await handleClerkWebhook({ config, store: t.store, rawBody: body, headers });
    expect(first.status).toBe(200);
    const row = await t.store.getByClerkId("user_wh1");
    expect(row?.email).toBe("wh@example.com");
    expect(row?.tenant_id).toBe("tn_1");

    const replay = await handleClerkWebhook({ config, store: t.store, rawBody: body, headers });
    expect(replay.status).toBe(200);
    expect(replay.body.deduped).toBe(true);
  });

  it("rejects unsigned requests and 503s without a secret", async () => {
    const t = buildStore();
    await t.store.ensureSchema();
    const body = '{"type":"user.created","data":{"id":"user_x"}}';
    const bad = await handleClerkWebhook({
      config: baseConfig({ webhookSigningSecret: secret }),
      store: t.store,
      rawBody: body,
      headers: { svixId: "m", svixTimestamp: String(Math.floor(Date.now() / 1000)), svixSignature: "v1,AAAA" },
    });
    expect(bad.status).toBe(401);

    const unconfigured = await handleClerkWebhook({
      config: baseConfig(),
      store: t.store,
      rawBody: body,
      headers: {},
    });
    expect(unconfigured.status).toBe(503);
  });
});
