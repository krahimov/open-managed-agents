// Vaults + credentials routes — full CRUD with stripSecrets on every read,
// mcp_oauth_validate, and the cross-store cascade-archive of credentials
// when a vault is archived.

import { Hono } from "hono";
import {
  CredentialDuplicateMcpUrlError,
  CredentialImmutableFieldError,
  CredentialMaxExceededError,
  CredentialNotFoundError,
  stripSecrets,
} from "@open-managed-agents/credentials-store";
import { VaultNotFoundError } from "@open-managed-agents/vaults-store";
import {
  buildAuthHeader,
  refreshMetadataOf,
  refreshMcpOAuth,
} from "@open-managed-agents/vault-forward";
import type {
  CredentialAuth,
  CredentialConfig,
} from "@open-managed-agents/shared";
import type { RouteServicesArg } from "../types";
import { resolveServices } from "../types";

interface Vars {
  Variables: { tenant_id: string };
}

interface ComposioToolRouterSessionInput {
  user_id: string;
  toolkits?: {
    enable?: string[];
    disable?: string[];
  };
  auth_configs?: Record<string, string>;
  connected_accounts?: Record<string, string | string[]>;
}

interface ComposioToolRouterSession {
  session_id: string;
  mcp: {
    type?: string;
    url: string;
    headers?: Record<string, string>;
  };
  config?: unknown;
}

interface ComposioToolkit {
  slug: string;
  name?: string;
  auth_schemes?: string[];
  composio_managed_auth_schemes?: string[];
  no_auth?: boolean;
  meta?: {
    description?: string;
    logo?: string;
    app_url?: string;
    tools_count?: number;
    triggers_count?: number;
    categories?: Array<{ id?: string; name?: string }>;
  };
}

interface ComposioAuthConfig {
  id: string;
  status?: string;
  is_composio_managed?: boolean;
  toolkit?: { slug?: string };
}

interface ComposioConnectedAccount {
  id: string;
  status?: string;
  user_id?: string;
  toolkit?: { slug?: string; name?: string; logo?: string };
  auth_config?: { id?: string };
  created_at?: string;
  updated_at?: string;
}

interface ComposioAuthLink {
  link_token: string;
  redirect_url: string;
  expires_at?: string;
  connected_account_id: string;
}

function handleError(err: unknown): Response {
  if (err instanceof VaultNotFoundError)
    return new Response(JSON.stringify({ error: err.message }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  if (err instanceof CredentialNotFoundError)
    return new Response(JSON.stringify({ error: err.message }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  if (err instanceof CredentialMaxExceededError)
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  if (err instanceof CredentialDuplicateMcpUrlError)
    return new Response(JSON.stringify({ error: err.message }), {
      status: 409,
      headers: { "content-type": "application/json" },
    });
  if (err instanceof CredentialImmutableFieldError)
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  throw err;
}

interface VaultRow {
  id: string;
  name: string;
  created_at: string;
  updated_at: string | null;
  archived_at: string | null;
}
function toApiVault(v: VaultRow) {
  return {
    type: "vault" as const,
    id: v.id,
    name: v.name,
    created_at: v.created_at,
    updated_at: v.updated_at,
    archived_at: v.archived_at,
  };
}

interface CredRowSliced {
  id: string;
  vault_id: string;
  display_name: string;
  auth: unknown;
  created_at: string;
  updated_at: string | null;
  archived_at: string | null;
}
function toApiCred<T extends CredRowSliced>(c: T) {
  return {
    id: c.id,
    vault_id: c.vault_id,
    display_name: c.display_name,
    auth: c.auth,
    created_at: c.created_at,
    updated_at: c.updated_at,
    archived_at: c.archived_at,
  };
}

export interface VaultRoutesDeps {
  services: RouteServicesArg;
  composio?: {
    /** Operator-level fallback key (self-host convenience). */
    apiKey?: string;
    baseUrl?: string;
    fetcher?: typeof fetch;
    /** Per-tenant key override (managed-first: tenants paste their own key
     *  in the console). When it returns a key, it wins over `apiKey`. */
    resolveApiKey?: (tenantId: string) => Promise<string | null>;
  };
}

type ComposioDeps = NonNullable<VaultRoutesDeps["composio"]>;
type ComposioApiKeySource = "request" | "vault" | "tenant" | "platform";

interface ResolvedComposioDeps {
  creds: ComposioDeps & { apiKey: string };
  apiKey: string;
  source: ComposioApiKeySource;
}

const COMPOSIO_NOT_CONNECTED =
  "Composio is not connected — configure COMPOSIO_API_KEY on the API server.";

function normalizeComposioToolkitSlug(slug: string): string {
  // Composio toolkit slugs are bare alphanumerics ("googledrive",
  // "googlecalendar"). Agents and users write human variants
  // ("google-drive", "Google Drive", "google_drive") — strip separators so
  // those resolve instead of flowing through as unknown slugs. An unknown
  // slug is DANGEROUS, not just broken: Composio's auth_configs list
  // silently ignores an unrecognized toolkit_slug filter and returns every
  // config, which once routed a google-drive connect card to a LinkedIn
  // OAuth page (first config in the unfiltered list).
  return slug.trim().toLowerCase().replace(/[-_.\s]+/g, "");
}

function normalizeComposioApiKey(apiKey: string | null | undefined): string | undefined {
  const trimmed = apiKey?.trim();
  return trimmed ? trimmed : undefined;
}

function collectComposioMapValues(input: Record<string, string | string[]> | undefined): string[] {
  if (!input) return [];
  const values: string[] = [];
  for (const value of Object.values(input)) {
    if (Array.isArray(value)) values.push(...value);
    else if (value) values.push(value);
  }
  return Array.from(new Set(values.filter(Boolean)));
}

async function resolveComposioForVault(input: {
  routeDeps?: ComposioDeps;
  services: ReturnType<typeof resolveServices>;
  tenantId: string;
  vaultId: string;
  explicitApiKey?: string | null;
}): Promise<ResolvedComposioDeps | null> {
  const base = input.routeDeps;
  if (!base) return null;

  const makeResolved = (
    apiKey: string,
    source: ComposioApiKeySource,
  ): ResolvedComposioDeps => ({
    apiKey,
    source,
    creds: {
      ...base,
      apiKey,
    },
  });

  const explicitKey = normalizeComposioApiKey(input.explicitApiKey);
  if (explicitKey) return makeResolved(explicitKey, "request");

  const platformKey = normalizeComposioApiKey(base.apiKey);
  if (platformKey) return makeResolved(platformKey, "platform");

  const tenantKey =
    (await base.resolveApiKey?.(input.tenantId).catch(() => null)) ?? null;
  if (tenantKey) return makeResolved(tenantKey, "tenant");

  const current = await input.services.credentials.list({
    tenantId: input.tenantId,
    vaultId: input.vaultId,
  });
  for (const cred of current) {
    const auth = (cred as unknown as CredentialConfig).auth;
    if (cred.archived_at || auth.type !== "composio_mcp") continue;
    const vaultKey = normalizeComposioApiKey(auth.api_key);
    if (vaultKey) return makeResolved(vaultKey, "vault");
  }

  return null;
}

async function composioRequest<T>(
  deps: ComposioDeps,
  path: string,
  init?: RequestInit,
): Promise<T> {
  if (!deps.apiKey) {
    throw new Error("COMPOSIO_API_KEY is not configured");
  }
  const baseUrl = deps.baseUrl || "https://backend.composio.dev";
  const fetcher = deps.fetcher ?? fetch;
  const res = await fetcher(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-api-key": deps.apiKey,
      ...init?.headers,
    },
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  if (!res.ok) {
    const detail =
      typeof data === "object" && data && "error" in data
        ? JSON.stringify((data as { error?: unknown }).error)
        : text || `HTTP ${res.status}`;
    throw new Error(`Composio API ${res.status}: ${detail}`);
  }
  return data as T;
}

export async function listComposioToolkits(
  deps: NonNullable<VaultRoutesDeps["composio"]>,
  opts: { search?: string; category?: string; limit?: number; cursor?: string } = {},
): Promise<{
  items: ComposioToolkit[];
  next_cursor?: string;
  total_items?: number;
}> {
  const params = new URLSearchParams();
  if (opts.search) params.set("search", opts.search);
  if (opts.category) params.set("category", opts.category);
  params.set("managed_by", "all");
  params.set("sort_by", opts.search ? "alphabetically" : "usage");
  const limit = Number.isFinite(opts.limit) ? opts.limit! : 50;
  params.set("limit", String(Math.min(Math.max(limit, 1), 1000)));
  if (opts.cursor) params.set("cursor", opts.cursor);
  return composioRequest(deps, `/api/v3.1/toolkits?${params.toString()}`);
}

export async function getOrCreateComposioManagedAuthConfig(
  deps: NonNullable<VaultRoutesDeps["composio"]>,
  toolkitSlug: string,
): Promise<ComposioAuthConfig> {
  const slug = normalizeComposioToolkitSlug(toolkitSlug);
  const params = new URLSearchParams({
    toolkit_slug: slug,
    is_composio_managed: "true",
    limit: "50",
  });
  const listed = await composioRequest<{ items?: ComposioAuthConfig[] }>(
    deps,
    `/api/v3.1/auth_configs?${params.toString()}`,
  );
  // Composio silently IGNORES an unrecognized toolkit_slug filter and
  // returns the full config list — picking the first item then hands the
  // caller a random provider's OAuth (observed live: "google-drive" →
  // LinkedIn). Only accept configs whose toolkit actually matches; a
  // truly unknown slug falls through to the create call below, which
  // fails loudly instead of misrouting.
  const existing = (listed.items ?? []).find(
    (cfg) =>
      cfg.id &&
      cfg.status !== "DISABLED" &&
      normalizeComposioToolkitSlug(cfg.toolkit?.slug ?? "") === slug,
  );
  if (existing) return existing;

  const created = await composioRequest<{
    auth_config?: ComposioAuthConfig;
    toolkit?: { slug?: string };
  }>(deps, "/api/v3.1/auth_configs", {
    method: "POST",
    body: JSON.stringify({
      toolkit: { slug },
    }),
  });
  if (!created.auth_config?.id) {
    throw new Error("Composio auth config response did not include auth_config.id");
  }
  return created.auth_config;
}

export async function createComposioConnectedAccountLink(
  deps: NonNullable<VaultRoutesDeps["composio"]>,
  input: {
    userId: string;
    toolkitSlug: string;
    callbackUrl?: string;
    alias?: string;
    authConfigId?: string;
  },
): Promise<ComposioAuthLink & { auth_config_id: string; toolkit: string; user_id: string }> {
  const toolkit = normalizeComposioToolkitSlug(input.toolkitSlug);
  const authConfig = input.authConfigId
    ? ({ id: input.authConfigId } satisfies ComposioAuthConfig)
    : await getOrCreateComposioManagedAuthConfig(deps, toolkit);
  const payload: Record<string, unknown> = {
    auth_config_id: authConfig.id,
    user_id: input.userId,
  };
  if (input.callbackUrl) payload.callback_url = input.callbackUrl;
  if (input.alias) payload.alias = input.alias;
  const link = await composioRequest<ComposioAuthLink>(
    deps,
    "/api/v3.1/connected_accounts/link",
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  );
  if (!link.redirect_url || !link.connected_account_id) {
    throw new Error("Composio auth link response did not include redirect_url and connected_account_id");
  }
  return {
    ...link,
    auth_config_id: authConfig.id,
    toolkit,
    user_id: input.userId,
  };
}

export async function listComposioConnectedAccounts(
  deps: NonNullable<VaultRoutesDeps["composio"]>,
  opts: { userId: string; toolkit?: string; limit?: number },
): Promise<{ items: ComposioConnectedAccount[]; next_cursor?: string }> {
  const params = new URLSearchParams({
    user_ids: opts.userId,
  });
  const limit = Number.isFinite(opts.limit) ? opts.limit! : 100;
  params.set("limit", String(Math.min(Math.max(limit, 1), 1000)));
  if (opts.toolkit) params.set("toolkit_slugs", normalizeComposioToolkitSlug(opts.toolkit));
  return composioRequest(deps, `/api/v3.1/connected_accounts?${params.toString()}`);
}

export async function createComposioToolRouterSession(
  deps: NonNullable<VaultRoutesDeps["composio"]>,
  input: ComposioToolRouterSessionInput,
): Promise<ComposioToolRouterSession> {
  const session = await composioRequest<Partial<ComposioToolRouterSession>>(
    deps,
    "/api/v3.1/tool_router/session",
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  ).catch((err) => {
    if (err instanceof Error && err.message.startsWith("Composio API")) {
      throw new Error(`Composio session create failed: ${err.message}`);
    }
    throw err;
  });
  if (!session.session_id || !session.mcp?.url) {
    throw new Error("Composio session response did not include session_id and mcp.url");
  }
  return session as ComposioToolRouterSession;
}

export function buildVaultRoutes(deps: VaultRoutesDeps) {
  const app = new Hono<Vars>();

  // ── Vaults ────────────────────────────────────────────────────────────
  app.post("/", async (c) => {
    const services = resolveServices(deps.services, c);
    const t = c.var.tenant_id;
    const body = await c.req.json<{ name: string }>();
    if (!body.name) return c.json({ error: "name is required" }, 400);
    const v = await services.vaults.create({ tenantId: t, name: body.name });
    return c.json(toApiVault(v as unknown as VaultRow), 201);
  });

  app.get("/", async (c) => {
    const services = resolveServices(deps.services, c);
    const t = c.var.tenant_id;
    const limitStr = c.req.query("limit");
    const limit = limitStr ? Math.min(Math.max(1, Number(limitStr)), 100) : 50;
    const cursor = c.req.query("cursor") || undefined;
    const includeArchivedRaw = c.req.query("include_archived");
    const includeArchived = includeArchivedRaw === "true";

    // status: enum filter on archive state. Whitelist strictly — any
    // unknown value is a 400, NOT a silent fallback to "any". Allowing
    // arbitrary strings here would mask client bugs (typo'd "active "
    // returning every row looks like a feature).
    const statusRaw = c.req.query("status");
    let status: "active" | "archived" | "any" | undefined;
    if (statusRaw !== undefined) {
      if (statusRaw === "active" || statusRaw === "archived" || statusRaw === "any") {
        status = statusRaw;
      } else {
        return c.json(
          {
            error: {
              type: "invalid_request_error",
              code: "invalid_status",
              message: `Invalid status '${statusRaw}'; expected one of active|archived|any.`,
            },
          },
          400,
        );
      }
    }

    // created_after / created_before: ISO timestamps → epoch ms. Reject
    // unparseable values explicitly so the client knows it's a malformed
    // request, not just "no results".
    const parseMs = (
      raw: string | undefined,
      field: string,
    ): { value: number | undefined; err?: Response } => {
      if (raw === undefined) return { value: undefined };
      const ms = Date.parse(raw);
      if (Number.isNaN(ms)) {
        return {
          value: undefined,
          err: c.json(
            {
              error: {
                type: "invalid_request_error",
                code: "invalid_timestamp",
                message: `Invalid ${field} '${raw}'; expected ISO-8601 timestamp.`,
              },
            },
            400,
          ),
        };
      }
      return { value: ms };
    };
    const createdAfterRes = parseMs(c.req.query("created_after"), "created_after");
    if (createdAfterRes.err) return createdAfterRes.err;
    const createdBeforeRes = parseMs(c.req.query("created_before"), "created_before");
    if (createdBeforeRes.err) return createdBeforeRes.err;

    const page = await services.vaults.listPage({
      tenantId: t,
      limit,
      cursor,
      // Prefer the new `status` filter. Keep includeArchived as a
      // back-compat fallback (older callers / older console builds). The
      // service layer maps includeArchived→status when status is unset,
      // so passing both is fine.
      ...(status !== undefined ? { status } : {}),
      ...(includeArchivedRaw !== undefined ? { includeArchived } : {}),
      ...(createdAfterRes.value !== undefined
        ? { createdAfter: createdAfterRes.value }
        : {}),
      ...(createdBeforeRes.value !== undefined
        ? { createdBefore: createdBeforeRes.value }
        : {}),
    });
    return c.json({
      data: page.items.map((v) => toApiVault(v as unknown as VaultRow)),
      ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}),
      has_more: !!page.nextCursor,
    });
  });

  app.get("/:id", async (c) => {
    const services = resolveServices(deps.services, c);
    const v = await services.vaults.get({
      tenantId: c.var.tenant_id,
      vaultId: c.req.param("id"),
    });
    if (!v) return c.json({ error: "Vault not found" }, 404);
    return c.json(toApiVault(v as unknown as VaultRow));
  });

  // POST/PUT — Anthropic SDK uses POST; PUT accepted for compat.
  const updateVault = async (c: import("hono").Context<Vars, "/:id">) => {
    const services = resolveServices(deps.services, c);
    const body = await c.req.json<{
      display_name?: string;
      name?: string;
    }>();
    try {
      const v = await services.vaults.update({
        tenantId: c.var.tenant_id,
        vaultId: c.req.param("id"),
        name: body.display_name ?? body.name,
      });
      return c.json(toApiVault(v as unknown as VaultRow));
    } catch (err) {
      return handleError(err);
    }
  };
  app.put("/:id", updateVault);
  app.post("/:id", updateVault);

  app.post("/:id/archive", async (c) => {
    const services = resolveServices(deps.services, c);
    const t = c.var.tenant_id;
    const id = c.req.param("id");
    try {
      const v = await services.vaults.archive({ tenantId: t, vaultId: id });
      // Cross-store cascade: archive every active credential in this vault.
      await services.credentials.archiveByVault({ tenantId: t, vaultId: id });
      return c.json(toApiVault(v as unknown as VaultRow));
    } catch (err) {
      return handleError(err);
    }
  });

  app.delete("/:id", async (c) => {
    const services = resolveServices(deps.services, c);
    try {
      await services.vaults.delete({
        tenantId: c.var.tenant_id,
        vaultId: c.req.param("id"),
      });
      return c.json({ type: "vault_deleted", id: c.req.param("id") });
    } catch (err) {
      return handleError(err);
    }
  });

  // ── Credentials (nested under vaults) ─────────────────────────────────
  app.post("/:id/credentials", async (c) => {
    const services = resolveServices(deps.services, c);
    const t = c.var.tenant_id;
    const vaultId = c.req.param("id");
    if (!(await services.vaults.exists({ tenantId: t, vaultId }))) {
      return c.json({ error: "Vault not found" }, 404);
    }
    const body = await c.req.json<{
      display_name: string;
      auth: CredentialAuth;
    }>();
    if (!body.display_name || !body.auth) {
      return c.json({ error: "display_name and auth are required" }, 400);
    }
    try {
      const cred = await services.credentials.create({
        tenantId: t,
        vaultId,
        displayName: body.display_name,
        auth: body.auth,
      });
      return c.json(toApiCred(stripSecrets(cred) as unknown as CredRowSliced), 201);
    } catch (err) {
      return handleError(err);
    }
  });

  app.post("/:id/credentials/composio_tool_router_session", async (c) => {
    const services = resolveServices(deps.services, c);
    const tenantId = c.var.tenant_id;
    const vaultId = c.req.param("id");
    if (!(await services.vaults.exists({ tenantId, vaultId }))) {
      return c.json({ error: "Vault not found" }, 404);
    }
    const body = await c.req.json<{
      display_name?: string;
      api_key?: string;
      user_id?: string;
      toolkits?: { enable?: string[]; disable?: string[] };
      auth_configs?: Record<string, string>;
      connected_accounts?: Record<string, string | string[]>;
      replace_existing?: boolean;
    }>();
    const enabledToolkits = (body.toolkits?.enable ?? [])
      .map(normalizeComposioToolkitSlug)
      .filter(Boolean);
    const disabledToolkits = (body.toolkits?.disable ?? [])
      .map(normalizeComposioToolkitSlug)
      .filter(Boolean);
    if (enabledToolkits.length > 0 && disabledToolkits.length > 0) {
      return c.json({ error: "toolkits.enable and toolkits.disable are mutually exclusive" }, 400);
    }

    const composioUserId = body.user_id || `oma:${tenantId}:${vaultId}`;
    const sessionPayload: ComposioToolRouterSessionInput = {
      user_id: composioUserId,
    };
    if (enabledToolkits.length > 0) {
      sessionPayload.toolkits = { enable: enabledToolkits };
    } else if (disabledToolkits.length > 0) {
      sessionPayload.toolkits = { disable: disabledToolkits };
    }
    if (body.auth_configs) sessionPayload.auth_configs = body.auth_configs;
    if (body.connected_accounts) sessionPayload.connected_accounts = body.connected_accounts;

    try {
      const composio = await resolveComposioForVault({
        routeDeps: deps.composio,
        services,
        tenantId,
        vaultId,
        explicitApiKey: body.api_key,
      });
      if (!composio) {
        return c.json({ error: COMPOSIO_NOT_CONNECTED }, 503);
      }
      const session = await createComposioToolRouterSession(composio.creds, sessionPayload);
      const auth: CredentialAuth = {
        type: "composio_mcp",
        mcp_server_url: session.mcp.url,
        ...(composio.source === "platform"
          ? { api_key_env: "COMPOSIO_API_KEY" }
          : { api_key: composio.apiKey }),
        composio_user_id: composioUserId,
        composio_session_id: session.session_id,
        composio_toolkits: enabledToolkits.length > 0 ? enabledToolkits : undefined,
        composio_connected_account_ids: collectComposioMapValues(body.connected_accounts),
        composio_auth_config_ids: body.auth_configs
          ? Array.from(new Set(Object.values(body.auth_configs).filter(Boolean)))
          : undefined,
      };
      if (body.replace_existing === true) {
        const current = await services.credentials.list({ tenantId, vaultId });
        await Promise.all(
          current
            .filter((cred) => {
              const existingAuth = (cred as unknown as CredentialConfig).auth;
              return !cred.archived_at && existingAuth.type === "composio_mcp";
            })
            .map((cred) =>
              services.credentials.archive({
                tenantId,
                vaultId,
                credentialId: cred.id,
              }),
            ),
        );
      }
      const cred = await services.credentials.create({
        tenantId,
        vaultId,
        displayName: body.display_name || "Composio Tool Router",
        auth,
      });
      return c.json(toApiCred(stripSecrets(cred) as unknown as CredRowSliced), 201);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Composio session create failed")) {
        return c.json({ error: err.message }, 502);
      }
      if (err instanceof Error && err.message.includes("Composio session response")) {
        return c.json({ error: err.message }, 502);
      }
      return handleError(err);
    }
  });

  app.get("/:id/credentials/composio_toolkits", async (c) => {
    const services = resolveServices(deps.services, c);
    const tenantId = c.var.tenant_id;
    const vaultId = c.req.param("id");
    if (!(await services.vaults.exists({ tenantId, vaultId }))) {
      return c.json({ error: "Vault not found" }, 404);
    }
    try {
      const composio = await resolveComposioForVault({
        routeDeps: deps.composio,
        services,
        tenantId,
        vaultId,
      });
      if (!composio) {
        return c.json({ error: COMPOSIO_NOT_CONNECTED }, 503);
      }
      const catalog = await listComposioToolkits(composio.creds, {
        search: c.req.query("q") || undefined,
        category: c.req.query("category") || undefined,
        cursor: c.req.query("cursor") || undefined,
        limit: Number.parseInt(c.req.query("limit") || "100", 10),
      });
      return c.json(catalog);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502);
    }
  });

  app.get("/:id/credentials/composio_accounts", async (c) => {
    const services = resolveServices(deps.services, c);
    const tenantId = c.var.tenant_id;
    const vaultId = c.req.param("id");
    if (!(await services.vaults.exists({ tenantId, vaultId }))) {
      return c.json({ error: "Vault not found" }, 404);
    }
    const userId = c.req.query("user_id") || `oma:${tenantId}:${vaultId}`;
    try {
      const composio = await resolveComposioForVault({
        routeDeps: deps.composio,
        services,
        tenantId,
        vaultId,
      });
      if (!composio) {
        return c.json({ error: COMPOSIO_NOT_CONNECTED }, 503);
      }
      const accounts = await listComposioConnectedAccounts(composio.creds, {
        userId,
        toolkit: c.req.query("toolkit") || undefined,
        limit: Number.parseInt(c.req.query("limit") || "100", 10),
      });
      return c.json(accounts);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502);
    }
  });

  app.post("/:id/credentials/composio_accounts/link", async (c) => {
    const services = resolveServices(deps.services, c);
    const tenantId = c.var.tenant_id;
    const vaultId = c.req.param("id");
    if (!(await services.vaults.exists({ tenantId, vaultId }))) {
      return c.json({ error: "Vault not found" }, 404);
    }
    const body = await c.req.json<{
      toolkit?: string;
      callback_url?: string;
      alias?: string;
      user_id?: string;
      auth_config_id?: string;
      api_key?: string;
    }>();
    if (!body.toolkit) return c.json({ error: "toolkit is required" }, 400);
    const userId = body.user_id || `oma:${tenantId}:${vaultId}`;
    try {
      const composio = await resolveComposioForVault({
        routeDeps: deps.composio,
        services,
        tenantId,
        vaultId,
        explicitApiKey: body.api_key,
      });
      if (!composio) {
        return c.json({ error: COMPOSIO_NOT_CONNECTED }, 503);
      }
      const link = await createComposioConnectedAccountLink(composio.creds, {
        userId,
        toolkitSlug: body.toolkit,
        callbackUrl: body.callback_url,
        alias: body.alias,
        authConfigId: body.auth_config_id,
      });

      // Toolkit-locked tool-router sessions in this vault won't expose the
      // new toolkit's tools even after the OAuth completes — the agent then
      // reports "authorization succeeded but no tools found" (observed with
      // a gmail+github-locked session and a google-drive grant). Re-provision
      // any such credential with the union list; credential rotation is
      // transparent to agents (the MCP proxy matches any Composio tool-router
      // URL and always uses the ACTIVE credential's URL). Best-effort: a
      // failure here must not break the link handoff.
      let toolkitsExpanded = false;
      try {
        const requested = normalizeComposioToolkitSlug(body.toolkit);
        const creds = await services.credentials.list({ tenantId, vaultId });
        for (const cred of creds) {
          if (cred.archived_at) continue;
          const auth = (cred as unknown as CredentialConfig).auth as CredentialAuth & {
            composio_toolkits?: string[];
            composio_user_id?: string;
          };
          if (auth.type !== "composio_mcp") continue;
          const locked = (auth.composio_toolkits ?? []).map(normalizeComposioToolkitSlug);
          if (locked.length === 0 || locked.includes(requested)) continue;
          const union = [...locked, requested];
          const session = await createComposioToolRouterSession(composio.creds, {
            user_id: auth.composio_user_id || userId,
            toolkits: { enable: union },
          });
          await services.credentials.create({
            tenantId,
            vaultId,
            displayName: cred.display_name,
            auth: {
              ...auth,
              mcp_server_url: session.mcp.url,
              composio_session_id: session.session_id,
              composio_toolkits: union,
            },
          });
          await services.credentials.archive({ tenantId, vaultId, credentialId: cred.id });
          toolkitsExpanded = true;
        }
      } catch {
        // Expansion is an enhancement to the grant, not a precondition for
        // the OAuth link — swallow and let the card proceed.
      }

      return c.json({ ...link, toolkits_expanded: toolkitsExpanded }, 201);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502);
    }
  });

  app.get("/:id/credentials", async (c) => {
    const services = resolveServices(deps.services, c);
    const t = c.var.tenant_id;
    const vaultId = c.req.param("id");
    if (!(await services.vaults.exists({ tenantId: t, vaultId }))) {
      return c.json({ error: "Vault not found" }, 404);
    }
    try {
      const creds = await services.credentials.list({ tenantId: t, vaultId });
      return c.json({
        data: creds.map((c) => toApiCred(stripSecrets(c) as unknown as CredRowSliced)),
      });
    } catch (err) {
      return handleError(err);
    }
  });

  app.get("/:id/credentials/:cred_id", async (c) => {
    const services = resolveServices(deps.services, c);
    try {
      const cred = await services.credentials.get({
        tenantId: c.var.tenant_id,
        vaultId: c.req.param("id"),
        credentialId: c.req.param("cred_id"),
      });
      if (!cred) return c.json({ error: "Credential not found" }, 404);
      return c.json(toApiCred(stripSecrets(cred) as unknown as CredRowSliced));
    } catch (err) {
      return handleError(err);
    }
  });

  app.post("/:id/credentials/:cred_id", async (c) => {
    const services = resolveServices(deps.services, c);
    const body = await c.req.json<{
      display_name?: string;
      auth?: Partial<CredentialAuth>;
    }>();
    try {
      const cred = await services.credentials.update({
        tenantId: c.var.tenant_id,
        vaultId: c.req.param("id"),
        credentialId: c.req.param("cred_id"),
        displayName: body.display_name,
        auth: body.auth,
      });
      return c.json(toApiCred(stripSecrets(cred) as unknown as CredRowSliced));
    } catch (err) {
      return handleError(err);
    }
  });

  // POST /v1/vaults/:id/credentials/:cred_id/mcp_oauth_validate — verify the
  // stored OAuth credential by attempting a refresh against its
  // token_endpoint. Returns 200 with the refreshed access_token on success,
  // 502 when the endpoint is unreachable, or 400 when the credential isn't
  // an mcp_oauth type.
  app.post("/:id/credentials/:cred_id/mcp_oauth_validate", async (c) => {
    const services = resolveServices(deps.services, c);
    const t = c.var.tenant_id;
    const cred = await services.credentials
      .get({
        tenantId: t,
        vaultId: c.req.param("id"),
        credentialId: c.req.param("cred_id"),
      })
      .catch(() => null);
    if (!cred) return c.json({ error: "Credential not found" }, 404);
    const auth = (cred as unknown as CredentialConfig).auth;
    const meta = refreshMetadataOf(auth);
    if (!meta) {
      return c.json(
        { error: "Credential is not mcp_oauth or has no refresh_token / token_endpoint" },
        400,
      );
    }
    const refreshed = await refreshMcpOAuth(meta);
    if (!refreshed) {
      return c.json({ error: "token_endpoint unreachable or refresh refused" }, 502);
    }
    try {
      await services.credentials.refreshAuth({
        tenantId: t,
        vaultId: c.req.param("id"),
        credentialId: c.req.param("cred_id"),
        auth: {
          access_token: refreshed.access_token,
          refresh_token: refreshed.refresh_token,
          expires_at: refreshed.expires_in
            ? new Date(Date.now() + refreshed.expires_in * 1000).toISOString()
            : undefined,
        },
      });
    } catch {
      // Best-effort persist; the validation call itself was a success.
    }
    return c.json({
      type: "mcp_oauth_validation",
      validated: true,
      expires_in: refreshed.expires_in ?? null,
    });
  });

  app.post("/:id/credentials/:cred_id/archive", async (c) => {
    const services = resolveServices(deps.services, c);
    try {
      const cred = await services.credentials.archive({
        tenantId: c.var.tenant_id,
        vaultId: c.req.param("id"),
        credentialId: c.req.param("cred_id"),
      });
      return c.json(toApiCred(stripSecrets(cred) as unknown as CredRowSliced));
    } catch (err) {
      return handleError(err);
    }
  });

  app.delete("/:id/credentials/:cred_id", async (c) => {
    const services = resolveServices(deps.services, c);
    try {
      await services.credentials.delete({
        tenantId: c.var.tenant_id,
        vaultId: c.req.param("id"),
        credentialId: c.req.param("cred_id"),
      });
      return c.json({ type: "credential_deleted", id: c.req.param("cred_id") });
    } catch (err) {
      return handleError(err);
    }
  });

  // Suppress unused-import lint when route paths skip a code path.
  void buildAuthHeader;

  return app;
}
