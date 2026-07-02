// Clerk integration for main-node — auth verification, user sync, billing
// entitlements. Opt-in: everything here activates only when Clerk env vars
// are present (see resolveClerkConfig). better-auth remains the OSS
// default; Clerk is the managed-first overlay for hosted deployments
// whose user store lives in Clerk and whose app DB is Neon Postgres.
//
// Three pieces, matching how Clerk recommends custom backends integrate:
//
//   1. ClerkTokenVerifier — networkless verification of the session JWT
//      (RS256 against the instance JWKS, issuer pinned via env, optional
//      azp allowlist). Plugs into packages/auth's resolveSession hook so
//      `Authorization: Bearer <session-token>` works everywhere the
//      better-auth cookie works. v2 tokens carry billing claims:
//      pla "u:free" / "o:pro" and fea "u:a,o:b".
//
//   2. Clerk webhooks (svix-signed) — user.created/updated/deleted keep a
//      `clerk_users` row in the app DB (Neon) in sync and provision a
//      tenant+membership through the same ensureTenant path better-auth
//      signups use, so every downstream feature (agents, sessions,
//      vaults) sees Clerk users as first-class. subscription.* /
//      subscriptionItem.* / paymentAttempt.* events are stored raw in
//      `clerk_webhook_events` and folded into the user's plan columns.
//
//   3. clerkPreCreateGate — SessionLifecycleHooks.preCreateGate impl:
//      free-plan tenants get a concurrent-session cap, paid plans pass.
//      Fail-open when Clerk has no data for the tenant (better-auth
//      users on the same instance are unaffected).
//
// No new dependencies: RS256 via node:crypto, svix HMAC via node:crypto,
// JWKS over fetch. Tables use the ensureSchema-owns-DDL pattern
// (node-session-work-queue.ts, node-session-wakeups.ts).

import {
  createHmac,
  createPublicKey,
  timingSafeEqual,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import type { SqlClient } from "@open-managed-agents/sql-client";
import { getLogger } from "@open-managed-agents/observability";

const log = getLogger("clerk");

// ─── Config ──────────────────────────────────────────────────────────────

export interface ClerkConfig {
  /** Frontend API origin, e.g. https://coolapp-12.clerk.accounts.dev —
   *  also the JWT issuer. */
  issuer: string;
  jwksUrl: string;
  /** Optional azp allowlist (browser origins). Empty = skip azp check. */
  authorizedParties: string[];
  /** svix signing secret (whsec_…) for /clerk/webhook. */
  webhookSigningSecret: string | null;
  /** Backend API secret key (sk_…). Not required for verification; kept
   *  for future Backend API calls. */
  secretKey: string | null;
  /** When true, free-plan tenants are capped (402) by the gate. */
  billingEnforce: boolean;
  freePlanActiveSessionLimit: number;
}

/**
 * Derive config from env. Returns null when Clerk isn't configured.
 * Issuer resolution: CLERK_ISSUER wins; else derived from
 * CLERK_PUBLISHABLE_KEY (pk_test_/pk_live_ + base64("<frontend-api>$")).
 */
export function resolveClerkConfig(env: NodeJS.ProcessEnv = process.env): ClerkConfig | null {
  let issuer = (env.CLERK_ISSUER ?? "").trim().replace(/\/+$/, "");
  const pk = (env.CLERK_PUBLISHABLE_KEY ?? "").trim();
  if (!issuer && pk) {
    const m = /^pk_(test|live)_(.+)$/.exec(pk);
    if (m) {
      try {
        const decoded = Buffer.from(m[2], "base64").toString("utf8");
        const host = decoded.replace(/\$$/, "").trim();
        if (host) issuer = `https://${host}`;
      } catch {
        // fall through — issuer stays empty
      }
    }
  }
  if (!issuer) return null;
  return {
    issuer,
    jwksUrl: `${issuer}/.well-known/jwks.json`,
    authorizedParties: (env.CLERK_AUTHORIZED_PARTIES ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    webhookSigningSecret: env.CLERK_WEBHOOK_SIGNING_SECRET?.trim() || null,
    secretKey: env.CLERK_SECRET_KEY?.trim() || null,
    billingEnforce: env.CLERK_BILLING_ENFORCE === "1",
    freePlanActiveSessionLimit: Math.max(
      1,
      Number.parseInt(env.CLERK_FREE_PLAN_ACTIVE_SESSION_LIMIT ?? "3", 10) || 3,
    ),
  };
}

// ─── Session-token verification ─────────────────────────────────────────

export interface ClerkEntitlements {
  /** Plan slug without scope prefix, e.g. "free_user", "pro". */
  plan: string | null;
  /** "u" (user-scoped) or "o" (org-scoped) plan. */
  planScope: "u" | "o" | null;
  /** Feature slugs without scope prefixes. */
  features: string[];
}

export interface VerifiedClerkToken {
  userId: string;
  sessionId: string | null;
  orgId: string | null;
  claims: Record<string, unknown>;
  entitlements: ClerkEntitlements;
  /** True when the token carries billing claims at all (pla/fea keys).
   *  Tokens minted without billing claims (older instances, custom JWT
   *  templates) must NOT overwrite webhook-derived plan state — a parsed
   *  null means "unknown", not "no plan". */
  hasBillingClaims: boolean;
}

interface Jwk {
  kid?: string;
  kty?: string;
  [k: string]: unknown;
}

const CLOCK_SKEW_MS = 60_000;
const JWKS_TTL_MS = 5 * 60_000;

function b64urlToBuf(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/** Parse "u:free,o:pro" style scoped claim lists. */
export function parseScopedClaim(raw: unknown): Array<{ scope: "u" | "o"; slug: string }> {
  if (typeof raw !== "string" || !raw.trim()) return [];
  const out: Array<{ scope: "u" | "o"; slug: string }> = [];
  for (const part of raw.split(",")) {
    const [scope, ...rest] = part.trim().split(":");
    const slug = rest.join(":").trim();
    if ((scope === "u" || scope === "o") && slug) out.push({ scope, slug });
  }
  return out;
}

export function entitlementsFromClaims(claims: Record<string, unknown>): ClerkEntitlements {
  const plans = parseScopedClaim(claims.pla);
  // Org plan wins when an org is active (matches has() resolution: the o
  // claim is only present with an active org).
  const active = plans.find((p) => p.scope === "o") ?? plans.find((p) => p.scope === "u") ?? null;
  return {
    plan: active?.slug ?? null,
    planScope: active?.scope ?? null,
    features: parseScopedClaim(claims.fea).map((f) => f.slug),
  };
}

export class ClerkTokenVerifier {
  #config: ClerkConfig;
  #fetchJwks: () => Promise<{ keys: Jwk[] }>;
  #cache: { keys: Map<string, KeyObject>; fetchedAt: number } | null = null;

  constructor(
    config: ClerkConfig,
    opts?: { fetchJwks?: () => Promise<{ keys: Jwk[] }> },
  ) {
    this.#config = config;
    this.#fetchJwks =
      opts?.fetchJwks ??
      (async () => {
        const res = await fetch(config.jwksUrl);
        if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
        return (await res.json()) as { keys: Jwk[] };
      });
  }

  async #keyFor(kid: string | undefined, allowRefetch = true): Promise<KeyObject | null> {
    const fresh = this.#cache && Date.now() - this.#cache.fetchedAt < JWKS_TTL_MS;
    if (!fresh) {
      const jwks = await this.#fetchJwks();
      const keys = new Map<string, KeyObject>();
      for (const jwk of jwks.keys ?? []) {
        if (jwk.kty !== "RSA") continue;
        try {
          keys.set(jwk.kid ?? "", createPublicKey({ key: jwk as never, format: "jwk" }));
        } catch {
          // skip unparseable keys
        }
      }
      this.#cache = { keys, fetchedAt: Date.now() };
    }
    const hit = kid != null ? this.#cache!.keys.get(kid) : null;
    if (hit) return hit;
    // kid rotation: one forced refetch.
    if (allowRefetch && kid != null) {
      this.#cache = null;
      return this.#keyFor(kid, false);
    }
    return null;
  }

  /**
   * Verify a Clerk session JWT. Throws with a reason on any failure.
   * Checks: structure, alg=RS256, signature vs JWKS, iss pinned to the
   * configured instance, exp/nbf with 60s skew, azp allowlist when
   * configured and present.
   */
  async verify(token: string): Promise<VerifiedClerkToken> {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("malformed token");
    const [h, p, s] = parts;
    let header: { alg?: string; kid?: string };
    let claims: Record<string, unknown>;
    try {
      header = JSON.parse(b64urlToBuf(h).toString("utf8"));
      claims = JSON.parse(b64urlToBuf(p).toString("utf8"));
    } catch {
      throw new Error("malformed token json");
    }
    if (header.alg !== "RS256") throw new Error(`unsupported alg: ${header.alg}`);

    const key = await this.#keyFor(header.kid);
    if (!key) throw new Error(`no JWKS key for kid ${header.kid}`);
    const ok = cryptoVerify(
      "RSA-SHA256",
      Buffer.from(`${h}.${p}`),
      key,
      b64urlToBuf(s),
    );
    if (!ok) throw new Error("bad signature");

    if (claims.iss !== this.#config.issuer) {
      throw new Error(`issuer mismatch: ${String(claims.iss)}`);
    }
    const now = Date.now();
    if (typeof claims.exp === "number" && now > claims.exp * 1000 + CLOCK_SKEW_MS) {
      throw new Error("token expired");
    }
    if (typeof claims.nbf === "number" && now < claims.nbf * 1000 - CLOCK_SKEW_MS) {
      throw new Error("token not yet valid");
    }
    if (
      this.#config.authorizedParties.length &&
      typeof claims.azp === "string" &&
      claims.azp &&
      !this.#config.authorizedParties.includes(claims.azp)
    ) {
      throw new Error(`azp not allowed: ${claims.azp}`);
    }
    const sub = typeof claims.sub === "string" ? claims.sub : "";
    if (!sub) throw new Error("missing sub");

    const org = claims.o as { id?: string } | undefined;
    return {
      userId: sub,
      sessionId: typeof claims.sid === "string" ? claims.sid : null,
      orgId: typeof org?.id === "string" ? org.id : null,
      claims,
      entitlements: entitlementsFromClaims(claims),
      hasBillingClaims: "pla" in claims || "fea" in claims,
    };
  }
}

// ─── svix webhook signature ──────────────────────────────────────────────

/**
 * Verify a svix signature (Clerk webhooks). Signed content is
 * `${svixId}.${svixTimestamp}.${rawBody}`, HMAC-SHA256 keyed with the
 * base64-decoded secret after `whsec_`, compared (timing-safe) against
 * each space-separated `v1,<base64>` entry. Timestamp must be within
 * ±5 minutes.
 */
export function verifySvixSignature(input: {
  secret: string;
  svixId: string | undefined;
  svixTimestamp: string | undefined;
  svixSignature: string | undefined;
  rawBody: string;
  nowMs?: number;
}): boolean {
  const { secret, svixId, svixTimestamp, svixSignature, rawBody } = input;
  if (!svixId || !svixTimestamp || !svixSignature) return false;
  const ts = Number.parseInt(svixTimestamp, 10);
  if (!Number.isFinite(ts)) return false;
  const now = input.nowMs ?? Date.now();
  if (Math.abs(now - ts * 1000) > 5 * 60_000) return false;

  const keyB64 = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  let key: Buffer;
  try {
    key = Buffer.from(keyB64, "base64");
  } catch {
    return false;
  }
  const expected = createHmac("sha256", key)
    .update(`${svixId}.${ts}.${rawBody}`)
    .digest();
  for (const entry of svixSignature.split(" ")) {
    const [version, sig] = entry.split(",");
    if (version !== "v1" || !sig) continue;
    let candidate: Buffer;
    try {
      candidate = Buffer.from(sig, "base64");
    } catch {
      continue;
    }
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) {
      return true;
    }
  }
  return false;
}

// ─── User + billing store ────────────────────────────────────────────────

export interface ClerkUserRow {
  clerk_user_id: string;
  tenant_id: string | null;
  email: string | null;
  name: string | null;
  image_url: string | null;
  plan: string | null;
  plan_scope: string | null;
  features: string | null;
  billing_status: string | null;
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface ClerkStoreDeps {
  sql: SqlClient;
  dialect: "sqlite" | "postgres";
  /** Provision (or find) the user's tenant — same helper better-auth
   *  signups use (ensureTenantSqlite), so Clerk users get tenant +
   *  membership rows and every downstream feature works unchanged. */
  ensureTenant(userId: string, name: string | null, email: string | null): Promise<string>;
  /** Org tenancy — injected so the tenant/membership SQL (camelCase
   *  better-auth columns) stays beside ensureTenantSqlite in the shell.
   *  Optional: when absent, organization.* webhooks are audit-only. */
  orgTenancy?: {
    createTenant(name: string): Promise<string>;
    addMembership(userId: string, tenantId: string, role: "owner" | "member"): Promise<void>;
    removeMembership(userId: string, tenantId: string): Promise<void>;
  };
  now?(): number;
}

/** Minimal shape of Clerk's user.* webhook payload data we consume. */
export interface ClerkUserPayload {
  id?: string;
  first_name?: string | null;
  last_name?: string | null;
  image_url?: string | null;
  primary_email_address_id?: string | null;
  email_addresses?: Array<{ id?: string; email_address?: string }>;
}

export function primaryEmailOf(u: ClerkUserPayload): string | null {
  const list = u.email_addresses ?? [];
  const primary = list.find((e) => e.id && e.id === u.primary_email_address_id);
  return primary?.email_address ?? list[0]?.email_address ?? null;
}

export class ClerkStore {
  constructor(private readonly deps: ClerkStoreDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  async ensureSchema(): Promise<void> {
    const int = this.deps.dialect === "postgres" ? "BIGINT" : "INTEGER";
    await this.deps.sql.exec(`
      CREATE TABLE IF NOT EXISTS clerk_users (
        clerk_user_id TEXT PRIMARY KEY,
        tenant_id TEXT,
        email TEXT,
        name TEXT,
        image_url TEXT,
        plan TEXT,
        plan_scope TEXT,
        features TEXT,
        billing_status TEXT,
        deleted_at ${int},
        created_at ${int} NOT NULL,
        updated_at ${int} NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_clerk_users_tenant ON clerk_users(tenant_id);
      CREATE TABLE IF NOT EXISTS clerk_webhook_events (
        svix_id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        received_at ${int} NOT NULL
      );
      CREATE TABLE IF NOT EXISTS clerk_orgs (
        clerk_org_id TEXT PRIMARY KEY,
        tenant_id TEXT,
        name TEXT,
        slug TEXT,
        plan TEXT,
        billing_status TEXT,
        deleted_at ${int},
        created_at ${int} NOT NULL,
        updated_at ${int} NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_clerk_orgs_tenant ON clerk_orgs(tenant_id);
    `);
  }

  /** Record an event for idempotency + audit. Returns false when the
   *  svix id was already processed (caller should 200 and skip). */
  async recordEvent(svixId: string, eventType: string, payloadJson: string): Promise<boolean> {
    const now = this.now();
    if (this.deps.dialect === "postgres") {
      const r = await this.deps.sql
        .prepare(
          `INSERT INTO clerk_webhook_events (svix_id, event_type, payload_json, received_at)
           VALUES (?, ?, ?, ?) ON CONFLICT (svix_id) DO NOTHING`,
        )
        .bind(svixId, eventType, payloadJson, now)
        .run();
      return (r.meta.changes ?? 0) > 0;
    }
    const r = await this.deps.sql
      .prepare(
        `INSERT OR IGNORE INTO clerk_webhook_events (svix_id, event_type, payload_json, received_at)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(svixId, eventType, payloadJson, now)
      .run();
    return (r.meta.changes ?? 0) > 0;
  }

  /** user.created / user.updated — upsert profile + provision tenant. */
  async upsertUser(u: ClerkUserPayload): Promise<ClerkUserRow | null> {
    const id = u.id;
    if (!id) return null;
    const email = primaryEmailOf(u);
    const name = [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || null;
    const tenantId = await this.deps.ensureTenant(id, name, email);
    const now = this.now();
    await this.deps.sql
      .prepare(
        `INSERT INTO clerk_users (clerk_user_id, tenant_id, email, name, image_url, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (clerk_user_id) DO UPDATE SET
           tenant_id = excluded.tenant_id,
           email = excluded.email,
           name = excluded.name,
           image_url = excluded.image_url,
           deleted_at = NULL,
           updated_at = excluded.updated_at`,
      )
      .bind(id, tenantId, email, name, u.image_url ?? null, now, now)
      .run();
    return this.getByClerkId(id);
  }

  async markDeleted(clerkUserId: string): Promise<void> {
    await this.deps.sql
      .prepare(`UPDATE clerk_users SET deleted_at = ?, updated_at = ? WHERE clerk_user_id = ?`)
      .bind(this.now(), this.now(), clerkUserId)
      .run();
  }

  async getByClerkId(clerkUserId: string): Promise<ClerkUserRow | null> {
    const r = await this.deps.sql
      .prepare(`SELECT * FROM clerk_users WHERE clerk_user_id = ?`)
      .bind(clerkUserId)
      .first<ClerkUserRow>();
    return r ?? null;
  }

  /** Latest plan info for a tenant. Org mapping wins (an org tenant's
   *  plan is the org subscription); else any member's user-scoped plan.
   *  Null when Clerk knows nothing about this tenant — callers fail open
   *  in that case. */
  async planForTenant(tenantId: string): Promise<{
    plan: string | null;
    billing_status: string | null;
  } | null> {
    const org = await this.deps.sql
      .prepare(
        `SELECT plan, billing_status FROM clerk_orgs
         WHERE tenant_id = ? AND deleted_at IS NULL LIMIT 1`,
      )
      .bind(tenantId)
      .first<{ plan: string | null; billing_status: string | null }>();
    if (org) return org;
    const r = await this.deps.sql
      .prepare(
        `SELECT plan, billing_status FROM clerk_users
         WHERE tenant_id = ? AND deleted_at IS NULL
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .bind(tenantId)
      .first<{ plan: string | null; billing_status: string | null }>();
    return r ?? null;
  }

  // ── Organizations ──────────────────────────────────────────────────────

  async getOrg(clerkOrgId: string): Promise<{
    clerk_org_id: string;
    tenant_id: string | null;
    name: string | null;
    plan: string | null;
    deleted_at: number | null;
  } | null> {
    const r = await this.deps.sql
      .prepare(`SELECT clerk_org_id, tenant_id, name, plan, deleted_at FROM clerk_orgs WHERE clerk_org_id = ?`)
      .bind(clerkOrgId)
      .first<{
        clerk_org_id: string;
        tenant_id: string | null;
        name: string | null;
        plan: string | null;
        deleted_at: number | null;
      }>();
    return r ?? null;
  }

  /** organization.created / organization.updated — upsert and provision a
   *  tenant for the org (once). No-op tenant-wise without orgTenancy. */
  async upsertOrg(o: { id?: string; name?: string | null; slug?: string | null }): Promise<void> {
    if (!o.id) return;
    const existing = await this.getOrg(o.id);
    let tenantId = existing?.tenant_id ?? null;
    if (!tenantId && this.deps.orgTenancy) {
      tenantId = await this.deps.orgTenancy.createTenant(o.name?.trim() || o.slug || "Organization");
    }
    const now = this.now();
    await this.deps.sql
      .prepare(
        `INSERT INTO clerk_orgs (clerk_org_id, tenant_id, name, slug, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (clerk_org_id) DO UPDATE SET
           tenant_id = COALESCE(clerk_orgs.tenant_id, excluded.tenant_id),
           name = excluded.name,
           slug = excluded.slug,
           deleted_at = NULL,
           updated_at = excluded.updated_at`,
      )
      .bind(o.id, tenantId, o.name ?? null, o.slug ?? null, now, now)
      .run();
  }

  async markOrgDeleted(clerkOrgId: string): Promise<void> {
    await this.deps.sql
      .prepare(`UPDATE clerk_orgs SET deleted_at = ?, updated_at = ? WHERE clerk_org_id = ?`)
      .bind(this.now(), this.now(), clerkOrgId)
      .run();
  }

  /** organizationMembership.created — add the member to the org's tenant.
   *  Clerk roles: org:admin → owner, anything else → member. */
  async addOrgMember(input: {
    organization?: { id?: string; name?: string | null; slug?: string | null };
    public_user_data?: { user_id?: string };
    role?: string;
  }): Promise<void> {
    const orgId = input.organization?.id;
    const userId = input.public_user_data?.user_id;
    if (!orgId || !userId || !this.deps.orgTenancy) return;
    // Membership webhooks can outrun organization.created — self-heal.
    await this.upsertOrg(input.organization ?? { id: orgId });
    const org = await this.getOrg(orgId);
    if (!org?.tenant_id) return;
    const role = input.role === "org:admin" ? "owner" : "member";
    await this.deps.orgTenancy.addMembership(userId, org.tenant_id, role);
  }

  async removeOrgMember(input: {
    organization?: { id?: string };
    public_user_data?: { user_id?: string };
  }): Promise<void> {
    const orgId = input.organization?.id;
    const userId = input.public_user_data?.user_id;
    if (!orgId || !userId || !this.deps.orgTenancy) return;
    const org = await this.getOrg(orgId);
    if (!org?.tenant_id) return;
    await this.deps.orgTenancy.removeMembership(userId, org.tenant_id);
  }

  /** Update plan columns from verified JWT claims (cheap freshness path —
   *  the token is minted by Clerk and carries pla/fea). Callers diff
   *  against the loaded row first to keep the request path read-mostly. */
  async syncEntitlementsFromClaims(
    clerkUserId: string,
    ent: ClerkEntitlements,
  ): Promise<void> {
    await this.deps.sql
      .prepare(
        `UPDATE clerk_users SET plan = ?, plan_scope = ?, features = ?, updated_at = ?
         WHERE clerk_user_id = ?`,
      )
      .bind(ent.plan, ent.planScope, ent.features.join(","), this.now(), clerkUserId)
      .run();
  }

  /**
   * Fold a billing webhook event into plan state, for user payers
   * (clerk_users) and organization payers (clerk_orgs).
   *
   * Event catalog (clerk.com/docs/…/webhooks/billing): subscription.
   * created|updated|active|pastDue; subscriptionItem.updated|active|
   * canceled|upcoming|ended|abandoned|incomplete|pastDue|freeTrialEnding;
   * paymentAttempt.created|updated.
   *
   * Plan-clearing: canceled/ended/pastDue/incomplete (note Clerk uses
   * camelCase `pastDue`). NOT clearing: `abandoned` (fires for the OLD
   * item when the payer switches plans — the paired `…active` for the
   * new plan may arrive first, and clearing here would wipe it),
   * `upcoming`, `freeTrialEnding`, and paymentAttempt.* (status-only).
   * Payload parsing stays defensive; unknown shapes are still recorded
   * in clerk_webhook_events for audit.
   */
  async applyBillingEvent(eventType: string, data: Record<string, unknown>): Promise<void> {
    const payer = (data.payer ?? {}) as { user_id?: string; organization_id?: string };
    const planObj = (data.plan ?? {}) as { slug?: string; name?: string };
    const status = typeof data.status === "string" ? data.status : null;
    const planSlug = planObj.slug ?? (typeof data.plan_slug === "string" ? data.plan_slug : null);
    const userId = payer.user_id ?? (typeof data.user_id === "string" ? data.user_id : null);
    const orgId =
      payer.organization_id ??
      (typeof data.organization_id === "string" ? data.organization_id : null);

    // Status-only events never move the plan column: paymentAttempt.* is
    // payment telemetry; `abandoned` describes the OLD item on a plan
    // switch (the paired `…active` for the new plan carries the truth);
    // `upcoming`/`freeTrialEnding` describe future state.
    const statusOnly =
      /^paymentAttempt\./.test(eventType) ||
      /(abandoned|upcoming|freetrialending)/i.test(eventType.replace(/_/g, ""));
    const clearing =
      !statusOnly &&
      (/(cancel|pastdue|ended|incomplete|expired)/i.test(eventType.replace(/_/g, "")) ||
        (status ? /(cancel|pastdue|ended|expired)/i.test(status.replace(/_/g, "")) : false));

    const apply = async (table: "clerk_users" | "clerk_orgs", idCol: string, id: string) => {
      if (clearing && !statusOnly) {
        await this.deps.sql
          .prepare(
            `UPDATE ${table} SET plan = NULL, billing_status = ?, updated_at = ? WHERE ${idCol} = ?`,
          )
          .bind(status ?? eventType, this.now(), id)
          .run();
        return;
      }
      await this.deps.sql
        .prepare(
          `UPDATE ${table}
           SET plan = COALESCE(?, plan), billing_status = ?, updated_at = ?
           WHERE ${idCol} = ?`,
        )
        .bind(statusOnly ? null : planSlug, status ?? eventType, this.now(), id)
        .run();
    };

    if (userId) await apply("clerk_users", "clerk_user_id", userId);
    if (orgId) await apply("clerk_orgs", "clerk_org_id", orgId);
  }
}

// ─── Entitlement gate ────────────────────────────────────────────────────

/** True when the plan slug reads as a paying tier. Clerk's default free
 *  tier slugs are free_user / free_org; treat anything else as paid. */
export function isPaidPlan(plan: string | null): boolean {
  if (!plan) return false;
  return !/^free/i.test(plan);
}

/**
 * SessionLifecycleHooks.preCreateGate implementation. Free-plan (or
 * plan-unknown-but-Clerk-managed) tenants are capped at N concurrent
 * non-archived sessions; paid plans pass. Tenants Clerk has never seen
 * (better-auth users, api-key service tenants) fail OPEN — this gate
 * only meters tenants that came in through Clerk.
 */
export function buildClerkPreCreateGate(deps: {
  store: ClerkStore;
  config: ClerkConfig;
  countActiveSessions(tenantId: string): Promise<number>;
}): (input: {
  tenantId: string;
  agentId: string;
  isLocalRuntime: boolean;
}) => Promise<{ status: number; body: unknown } | null> {
  return async ({ tenantId }) => {
    if (!deps.config.billingEnforce) return null;
    const info = await deps.store.planForTenant(tenantId);
    if (!info) return null; // not a Clerk-managed tenant → open
    if (isPaidPlan(info.plan)) return null;
    const active = await deps.countActiveSessions(tenantId);
    if (active < deps.config.freePlanActiveSessionLimit) return null;
    return {
      status: 402,
      body: {
        type: "error",
        error: {
          type: "payment_required",
          message:
            `Free plan is limited to ${deps.config.freePlanActiveSessionLimit} active sessions ` +
            `(${active} in use). Upgrade your plan to start more, or archive finished sessions.`,
        },
      },
    };
  };
}

// ─── Webhook handler ─────────────────────────────────────────────────────

/**
 * Handle one Clerk webhook request. Returns the HTTP response pieces so
 * the caller (a Hono route in index.ts) stays a two-liner. 2xx tells
 * svix "done"; anything else is retried by Clerk.
 */
export async function handleClerkWebhook(input: {
  config: ClerkConfig;
  store: ClerkStore;
  rawBody: string;
  headers: { svixId?: string; svixTimestamp?: string; svixSignature?: string };
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const { config, store, rawBody, headers } = input;
  if (!config.webhookSigningSecret) {
    return { status: 503, body: { error: "clerk webhook secret not configured" } };
  }
  const ok = verifySvixSignature({
    secret: config.webhookSigningSecret,
    svixId: headers.svixId,
    svixTimestamp: headers.svixTimestamp,
    svixSignature: headers.svixSignature,
    rawBody,
  });
  if (!ok) return { status: 401, body: { error: "bad signature" } };

  let evt: { type?: string; data?: Record<string, unknown> };
  try {
    evt = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { error: "bad json" } };
  }
  const type = evt.type ?? "unknown";
  const data = evt.data ?? {};

  const firstDelivery = await store.recordEvent(headers.svixId!, type, rawBody);
  if (!firstDelivery) return { status: 200, body: { ok: true, deduped: true } };

  try {
    if (type === "user.created" || type === "user.updated") {
      await store.upsertUser(data as ClerkUserPayload);
    } else if (type === "user.deleted") {
      const id = (data as { id?: string }).id;
      if (id) await store.markDeleted(id);
    } else if (type === "organization.created" || type === "organization.updated") {
      await store.upsertOrg(data as { id?: string; name?: string | null; slug?: string | null });
    } else if (type === "organization.deleted") {
      const id = (data as { id?: string }).id;
      if (id) await store.markOrgDeleted(id);
    } else if (type === "organizationMembership.created" || type === "organizationMembership.updated") {
      await store.addOrgMember(data as Parameters<ClerkStore["addOrgMember"]>[0]);
    } else if (type === "organizationMembership.deleted") {
      await store.removeOrgMember(data as Parameters<ClerkStore["removeOrgMember"]>[0]);
    } else if (/^(subscription|subscriptionItem|paymentAttempt)\./.test(type)) {
      await store.applyBillingEvent(type, data);
    }
    // Unknown event families: recorded above, acknowledged here.
    return { status: 200, body: { ok: true } };
  } catch (err) {
    log.warn({ err, op: "clerk.webhook_failed", event_type: type }, "clerk webhook failed");
    return { status: 500, body: { error: "handler failed" } };
  }
}
