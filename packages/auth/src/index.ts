// Runtime-agnostic auth Hono middleware.
//
// Resolution priority (matches both apps/main/src/auth.ts and
// apps/main-node/src/auth/middleware.ts pre-extract):
//
//   1. AUTH_DISABLED → tenant_id="default", user_id undefined.
//   2. x-api-key header → resolveApiKey() → {tenant_id, user_id?}.
//   3. Cookie session → resolveSession() → {user_id} → tenant via
//      x-active-tenant (validated against membership) or
//      defaultTenantForUser → ensureTenantForUser self-heal.
//   4. Otherwise 401.
//
// Resolvers are runtime-injected: CF passes resolvers backed by D1
// + better-auth + KV-hashed apikey lookup; Node passes the same shape
// backed by SqlClient + a new api_keys table + better-auth on PG/sqlite.

import { createMiddleware } from "hono/factory";

export interface AuthSession {
  userId: string;
  email?: string | null;
  name?: string | null;
  /** Optional tenant preference from the auth provider (e.g. Clerk's
   *  active-organization claim mapped to the org's tenant). Honored after
   *  x-active-tenant and before defaultTenantForUser, and only when the
   *  user actually has a membership — a forged hint can't escalate. */
  tenantHint?: string | null;
}

export interface ApiKeyResolution {
  tenantId: string;
  userId?: string;
}

export interface AuthMiddlewareDeps {
  /** True bypasses auth entirely; tenant_id="default". */
  disabled: boolean;
  /** Resolve a session cookie → user info. Return null on miss. `request`
   *  lets a resolver accept a credential only on some routes (Clerk's
   *  __session cookie on the OAuth popup's navigations). */
  resolveSession(
    headers: Headers,
    request?: { method: string; path: string },
  ): Promise<AuthSession | null>;
  /** Resolve an x-api-key value → tenant + optional user. Null on miss. */
  resolveApiKey(apiKey: string): Promise<ApiKeyResolution | null>;
  /** Look up the user's default tenant (first membership by created_at). */
  defaultTenantForUser(userId: string): Promise<string | null>;
  /** Validate (user, tenant) membership — used for x-active-tenant. */
  hasMembership(userId: string, tenantId: string): Promise<boolean>;
  /** Self-heal: mint a tenant for a logged-in user with no memberships. */
  ensureTenantForUser(session: AuthSession): Promise<string>;
  /** Path-prefix predicate — request paths matching are allowed through
   *  without auth. Default: /health and /auth/*.  Used for /v1/internal
   *  (header-secret) and /v1/mcp-proxy (Bearer-on-every-request). */
  bypassPath?(path: string): boolean;
}

/** How the request authenticated. Routes that must not be reachable with
 *  a bare API key (minting more keys, binding an OAuth flow to a browser)
 *  branch on this; "disabled" is the AUTH_DISABLED synthetic identity. */
export type AuthType = "api_key" | "session" | "disabled";

const DEFAULT_BYPASS = (path: string) =>
  path === "/health" || path.startsWith("/auth/");

export function createAuthMiddleware(deps: AuthMiddlewareDeps) {
  const bypassPath = deps.bypassPath ?? DEFAULT_BYPASS;
  return createMiddleware<{
    Variables: { tenant_id: string; user_id?: string; auth_type?: AuthType };
  }>(async (c, next) => {
    if (bypassPath(c.req.path)) return next();

    if (deps.disabled) {
      c.set("tenant_id", "default");
      // Same synthetic identity /v1/me reports in disabled mode. Without it
      // every user-scoped route (integrations/publications) 403s in bare
      // dev with "regenerate your API key" — nonsense advice when auth is
      // off entirely.
      c.set("user_id", "default");
      c.set("auth_type", "disabled");
      return next();
    }

    // 1. API key
    const apiKey = c.req.header("x-api-key");
    if (apiKey) {
      const r = await deps.resolveApiKey(apiKey);
      if (!r) return c.json({ error: "Invalid API key" }, 401);
      c.set("tenant_id", r.tenantId);
      if (r.userId) c.set("user_id", r.userId);
      c.set("auth_type", "api_key");
      return next();
    }

    // 2. Cookie session
    let session: AuthSession | null = null;
    try {
      session = await deps.resolveSession(c.req.raw.headers, { method: c.req.method, path: c.req.path });
    } catch {
      return c.json({ error: "Unauthorized" }, 401);
    }
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    // 3. Tenant resolution.
    let tenantId: string | null = null;
    const requested = c.req.header("x-active-tenant") || "";
    if (requested) {
      const ok = await deps.hasMembership(session.userId, requested);
      if (!ok) {
        return c.json(
          {
            type: "error",
            error: { type: "not_a_member", message: "Not a member of the requested tenant" },
          },
          403,
        );
      }
      tenantId = requested;
    }
    if (!tenantId && session.tenantHint) {
      const ok = await deps.hasMembership(session.userId, session.tenantHint);
      if (ok) tenantId = session.tenantHint;
    }
    if (!tenantId) tenantId = await deps.defaultTenantForUser(session.userId);
    if (!tenantId) tenantId = await deps.ensureTenantForUser(session);

    c.set("tenant_id", tenantId);
    c.set("user_id", session.userId);
    c.set("auth_type", "session");
    return next();
  });
}
