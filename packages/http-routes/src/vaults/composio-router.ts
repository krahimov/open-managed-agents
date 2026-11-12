// Composio tool-router provisioning — the one place a router session is
// created, and the account binding every router gets.
//
// A tool-router session does NOT reliably see a connected account just
// because it is ACTIVE under the session's user_id: prod 2026-11, a router
// for {airtable,hubspot,linear,notion,slack,…} with no `connected_accounts`
// binding reported "No Active connection for toolkit=hubspot" while
// HubSpot and Airtable sat ACTIVE under that exact user_id (Linear, Notion,
// Slack worked). A fresh router with the accounts bound explicitly saw all
// of them. So every router we create binds `connected_accounts`: per
// toolkit in scope, the account the router was already bound to (or the
// caller chose) while it is still bindable, else the newest ACTIVE one —
// listed live from Composio for that one user_id, never an account of
// another user, never an INITIATED/EXPIRED/FAILED/disabled one. When the
// listing fails nothing is bound (caller-supplied ids are never forwarded
// unverified) and the binding is recorded as unknown, so the refresher
// fixes the router later.
//
// The binding is stored as `auth.composio_connected_accounts` (toolkit →
// id), written ONLY here and only when the listing succeeded, so a router
// without it is of unknown binding. The older `composio_connected_account_ids`
// is kept in sync for existing readers; on old rows it is only a hint (the
// link route used to re-provision routers without a binding while carrying
// the previous ids forward), used to keep those accounts when they are
// still bindable. `auth.composio_auth_configs` (toolkit → auth config) is
// passed back on every re-provision so custom auth configs (X/twitter)
// survive; old rows rebuild it from the listed accounts' auth configs.
//
// Existing routers are repaired by ComposioRouterRefresher (lazily before
// a session starts, and on demand via
// POST /v1/vaults/:id/credentials/composio_tool_router_session/refresh).
// Every rotation of a router credential (refresher, toolkit add, graft,
// replace_existing) runs under the refresher's per-vault lock.

import type { CredentialAuth } from "@open-managed-agents/shared";
import { COMPOSIO_PLATFORM_API_KEY_ENV } from "@open-managed-agents/shared";
import { MAX_CREDENTIALS_PER_VAULT } from "@open-managed-agents/credentials-store";

export interface ComposioClientDeps {
  apiKey?: string;
  baseUrl?: string;
  fetcher?: typeof fetch;
  /** Per-request timeout (default 15s). A Composio that accepts
   *  connections but never answers must not hold callers for undici's
   *  5-minute defaults. */
  timeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export interface ComposioToolRouterSessionInput {
  user_id: string;
  toolkits?: {
    enable?: string[];
    disable?: string[];
  };
  auth_configs?: Record<string, string>;
  connected_accounts?: Record<string, string | string[]>;
}

export interface ComposioToolRouterSession {
  session_id: string;
  mcp: {
    type?: string;
    url: string;
    headers?: Record<string, string>;
  };
  config?: unknown;
}

export interface ComposioConnectedAccount {
  id: string;
  status?: string;
  /** Deprecated upstream ("we will not be providing userId from this api
   *  anymore"): usually absent. The listing is filtered server-side by
   *  `user_ids`, so absent means "the queried user"; only a PRESENT,
   *  different value disqualifies an account. */
  user_id?: string | null;
  is_disabled?: boolean;
  toolkit?: { slug?: string; name?: string; logo?: string };
  auth_config?: { id?: string };
  created_at?: string;
  updated_at?: string;
}

export function normalizeComposioToolkitSlug(slug: string): string {
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

function timeoutSignal(ms: number): AbortSignal | undefined {
  const timeout = (AbortSignal as { timeout?: (ms: number) => AbortSignal }).timeout;
  return typeof timeout === "function" ? timeout.call(AbortSignal, ms) : undefined;
}

export async function composioRequest<T>(
  deps: ComposioClientDeps,
  path: string,
  init?: RequestInit,
): Promise<T> {
  if (!deps.apiKey) {
    throw new Error("COMPOSIO_API_KEY is not configured");
  }
  const baseUrl = deps.baseUrl || "https://backend.composio.dev";
  const fetcher = deps.fetcher ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  let res: Response;
  try {
    res = await fetcher(`${baseUrl}${path}`, {
      ...init,
      signal: init?.signal ?? timeoutSignal(timeoutMs),
      headers: {
        "content-type": "application/json",
        "x-api-key": deps.apiKey,
        ...init?.headers,
      },
    });
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      throw new Error(`Composio API timeout after ${timeoutMs}ms`);
    }
    throw err;
  }
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

export async function listComposioConnectedAccounts(
  deps: ComposioClientDeps,
  opts: { userId: string; toolkit?: string; limit?: number; cursor?: string },
): Promise<{ items: ComposioConnectedAccount[]; next_cursor?: string | null }> {
  const params = new URLSearchParams({
    user_ids: opts.userId,
  });
  const limit = Number.isFinite(opts.limit) ? opts.limit! : 100;
  params.set("limit", String(Math.min(Math.max(limit, 1), 1000)));
  if (opts.toolkit) params.set("toolkit_slugs", normalizeComposioToolkitSlug(opts.toolkit));
  if (opts.cursor) params.set("cursor", opts.cursor);
  return composioRequest(deps, `/api/v3.1/connected_accounts?${params.toString()}`);
}

/** Every connected account of `userId` (follows next_cursor, bounded). */
export async function listAllComposioConnectedAccounts(
  deps: ComposioClientDeps,
  userId: string,
): Promise<ComposioConnectedAccount[]> {
  const out: ComposioConnectedAccount[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const listed = await listComposioConnectedAccounts(deps, { userId, limit: 1000, cursor });
    out.push(...(listed.items ?? []));
    const next = typeof listed.next_cursor === "string" ? listed.next_cursor : "";
    if (!next || next === cursor) break;
    cursor = next;
  }
  return out;
}

export async function createComposioToolRouterSession(
  deps: ComposioClientDeps,
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

/** Composio user ids we mint are `oma:<tenant>:<vault>`. Under the shared
 *  operator key every tenant's users live in ONE Composio project, so a
 *  router (or listing) for another tenant's user id would expose that
 *  tenant's accounts — only a tenant's own key may name arbitrary users. */
export function isTenantScopedComposioUserId(userId: string, tenantId: string): boolean {
  return userId === `oma:${tenantId}` || userId.startsWith(`oma:${tenantId}:`);
}

function timestampOf(raw: string | undefined): number {
  const ms = raw ? Date.parse(raw) : Number.NaN;
  return Number.isFinite(ms) ? ms : 0;
}

/** Bindable = ACTIVE, not disabled, and not another user's (see
 *  ComposioConnectedAccount.user_id: absent counts as the queried user). */
function isBindableAccount(account: ComposioConnectedAccount, userId: string): boolean {
  return (
    typeof account.id === "string" &&
    account.id.length > 0 &&
    account.status === "ACTIVE" &&
    account.is_disabled !== true &&
    (account.user_id === undefined || account.user_id === null || account.user_id === "" || account.user_id === userId)
  );
}

function scopeFilter(enabled: ReadonlyArray<string>, disabled: ReadonlyArray<string>) {
  const on = new Set(enabled.map(normalizeComposioToolkitSlug).filter(Boolean));
  const off = new Set(disabled.map(normalizeComposioToolkitSlug).filter(Boolean));
  return (slug: string) => !!slug && (on.size > 0 ? on.has(slug) : !off.has(slug));
}

/**
 * toolkit → account id to bind: per toolkit in scope (`enabled`, or every
 * toolkit minus `disabled` when unlocked), a preferred account if it is
 * bindable, else the newest bindable one (created_at, then updated_at;
 * listing order breaks ties — Composio lists newest first).
 */
export function selectComposioAccountBindings(input: {
  accounts: ReadonlyArray<ComposioConnectedAccount>;
  userId: string;
  enabled?: ReadonlyArray<string>;
  disabled?: ReadonlyArray<string>;
  preferred?: Record<string, string | string[]>;
}): Record<string, string> {
  const inScope = scopeFilter(input.enabled ?? [], input.disabled ?? []);

  const byToolkit = new Map<string, Array<{ account: ComposioConnectedAccount; index: number }>>();
  input.accounts.forEach((account, index) => {
    if (!isBindableAccount(account, input.userId)) return;
    const slug = normalizeComposioToolkitSlug(account.toolkit?.slug ?? "");
    if (!inScope(slug)) return;
    const list = byToolkit.get(slug) ?? [];
    list.push({ account, index });
    byToolkit.set(slug, list);
  });

  const preferred = new Map<string, string[]>();
  for (const [toolkit, value] of Object.entries(input.preferred ?? {})) {
    const ids = (Array.isArray(value) ? value : [value]).filter(
      (id): id is string => typeof id === "string" && id.length > 0,
    );
    preferred.set(normalizeComposioToolkitSlug(toolkit), ids);
  }

  const out: Record<string, string> = {};
  for (const slug of [...byToolkit.keys()].sort()) {
    const candidates = byToolkit.get(slug)!;
    const chosen = preferred.get(slug)?.find((id) => candidates.some((c) => c.account.id === id));
    if (chosen) {
      out[slug] = chosen;
      continue;
    }
    candidates.sort(
      (a, b) =>
        timestampOf(b.account.created_at) - timestampOf(a.account.created_at) ||
        timestampOf(b.account.updated_at) - timestampOf(a.account.updated_at) ||
        a.index - b.index,
    );
    out[slug] = candidates[0].account.id;
  }
  return out;
}

/** Account ids with no toolkit attached (legacy `composio_connected_account_ids`)
 *  → toolkit → ids, through the listing. Ids the listing doesn't know drop out. */
function preferredFromIds(
  accounts: ReadonlyArray<ComposioConnectedAccount>,
  ids: ReadonlyArray<string> | undefined,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!ids || ids.length === 0) return out;
  const wanted = new Set(ids);
  for (const account of accounts) {
    if (!wanted.has(account.id)) continue;
    const slug = normalizeComposioToolkitSlug(account.toolkit?.slug ?? "");
    if (!slug) continue;
    (out[slug] ??= []).push(account.id);
  }
  return out;
}

/** toolkit → auth config for the toolkits in scope: `explicit` first, then
 *  (for legacy rows that only kept the flat id list) the auth config of a
 *  listed account of that toolkit whose config is one of `ids`. */
function resolveAuthConfigs(input: {
  accounts: ReadonlyArray<ComposioConnectedAccount> | null;
  explicit?: Record<string, string>;
  ids?: ReadonlyArray<string>;
  inScope: (slug: string) => boolean;
}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [toolkit, id] of Object.entries(input.explicit ?? {})) {
    const slug = normalizeComposioToolkitSlug(toolkit);
    if (typeof id === "string" && id && input.inScope(slug)) out[slug] = id;
  }
  const ids = new Set((input.ids ?? []).filter(Boolean));
  if (ids.size > 0 && input.accounts) {
    for (const account of input.accounts) {
      const config = account.auth_config?.id;
      const slug = normalizeComposioToolkitSlug(account.toolkit?.slug ?? "");
      if (!config || !ids.has(config) || !input.inScope(slug) || out[slug]) continue;
      out[slug] = config;
    }
  }
  return out;
}

export interface ProvisionComposioRouterInput {
  userId: string;
  enabled?: string[];
  disabled?: string[];
  /** toolkit → auth config the router uses for that toolkit. */
  authConfigs?: Record<string, string>;
  /** Flat auth-config ids of an old row: mapped to toolkits through the
   *  listed accounts for toolkits `authConfigs` doesn't name. */
  authConfigIds?: string[];
  /** Accounts to keep (the router's current binding, or what a connect
   *  flow just produced). Bound only when they are bindable for `userId`. */
  preferredAccounts?: Record<string, string | string[]>;
  /** Account ids with no toolkit (legacy rows) — preferred likewise. */
  preferredAccountIds?: string[];
  /** Accounts already listed for `userId` — skips the listing call. */
  accounts?: ReadonlyArray<ComposioConnectedAccount>;
}

export interface ProvisionedComposioRouter {
  session: ComposioToolRouterSession;
  connectedAccounts: Record<string, string>;
  authConfigs: Record<string, string>;
  /** false when the account listing failed: nothing was bound and the
   *  binding must not be recorded as known (the refresher re-checks such
   *  a router later). */
  verified: boolean;
}

/** Create a tool-router session with its accounts bound (see header). */
export async function provisionComposioToolRouter(
  deps: ComposioClientDeps,
  input: ProvisionComposioRouterInput,
): Promise<ProvisionedComposioRouter> {
  const enabled = (input.enabled ?? []).map(normalizeComposioToolkitSlug).filter(Boolean);
  const disabled = enabled.length > 0
    ? []
    : (input.disabled ?? []).map(normalizeComposioToolkitSlug).filter(Boolean);
  const inScope = scopeFilter(enabled, disabled);

  let accounts: ReadonlyArray<ComposioConnectedAccount> | null = input.accounts ?? null;
  if (!accounts) {
    accounts = await listAllComposioConnectedAccounts(deps, input.userId).catch(() => null);
  }
  // Listing failed → bind NOTHING. Caller-supplied ids are tenant-writable
  // (request bodies, stored rows) and the platform key spans every
  // tenant's users, so they are only ever forwarded after the listing for
  // this user vouched for them.
  const connectedAccounts = accounts
    ? selectComposioAccountBindings({
        accounts,
        userId: input.userId,
        enabled,
        disabled,
        preferred: {
          ...preferredFromIds(accounts, input.preferredAccountIds),
          ...(input.preferredAccounts ?? {}),
        },
      })
    : {};
  const authConfigs = resolveAuthConfigs({
    accounts,
    explicit: input.authConfigs,
    ids: input.authConfigIds,
    inScope,
  });

  const payload: ComposioToolRouterSessionInput = { user_id: input.userId };
  if (enabled.length > 0) payload.toolkits = { enable: enabled };
  else if (disabled.length > 0) payload.toolkits = { disable: disabled };
  if (Object.keys(authConfigs).length > 0) payload.auth_configs = authConfigs;
  if (Object.keys(connectedAccounts).length > 0) payload.connected_accounts = connectedAccounts;

  const session = await createComposioToolRouterSession(deps, payload);
  return { session, connectedAccounts, authConfigs, verified: accounts !== null };
}

const MAX_PREVIOUS_ROUTER_URLS = 8;

/** A per-session router URL (…/tool_router/<id>/mcp), not the generic
 *  …/tool_router/v3/session/mcp sentinel. */
function isConcreteRouterUrl(raw: string): boolean {
  try {
    const path = new URL(raw).pathname.replace(/\/+$/, "");
    return path.includes("/tool_router/") && path.endsWith("/mcp") && path !== "/tool_router/v3/session/mcp";
  } catch {
    return false;
  }
}

/** The credential auth for a provisioned router. `key` carries how the
 *  Composio key is stored (env pointer for the platform key, raw key for a
 *  tenant's own). */
export function composioRouterAuth(input: {
  key: { api_key?: string; api_key_env?: string };
  userId: string;
  router: ProvisionedComposioRouter;
  enabled?: string[];
  disabled?: string[];
  authConfigIds?: string[];
  /** URLs of the routers this one replaces (and their own predecessors). */
  replacedUrls?: ReadonlyArray<string | undefined>;
}): CredentialAuth {
  const enabled = (input.enabled ?? []).map(normalizeComposioToolkitSlug).filter(Boolean);
  const disabled = enabled.length > 0
    ? []
    : (input.disabled ?? []).map(normalizeComposioToolkitSlug).filter(Boolean);
  const newUrl = input.router.session.mcp.url;
  // Concrete routers only: the generic sentinel is a name target every
  // router answers to, not a lineage.
  const previous = [...new Set((input.replacedUrls ?? []).filter(
    (url): url is string => typeof url === "string" && url !== newUrl && isConcreteRouterUrl(url),
  ))].slice(0, MAX_PREVIOUS_ROUTER_URLS);
  const authConfigIds = [
    ...new Set([...(input.authConfigIds ?? []), ...Object.values(input.router.authConfigs)].filter(Boolean)),
  ];
  return {
    type: "composio_mcp",
    mcp_server_url: newUrl,
    ...(input.key.api_key
      ? { api_key: input.key.api_key }
      : { api_key_env: COMPOSIO_PLATFORM_API_KEY_ENV }),
    composio_user_id: input.userId,
    composio_session_id: input.router.session.session_id,
    ...(enabled.length > 0 ? { composio_toolkits: enabled } : {}),
    ...(disabled.length > 0 ? { composio_disabled_toolkits: disabled } : {}),
    composio_connected_account_ids: [...new Set(Object.values(input.router.connectedAccounts))],
    ...(input.router.verified ? { composio_connected_accounts: input.router.connectedAccounts } : {}),
    ...(Object.keys(input.router.authConfigs).length > 0 ? { composio_auth_configs: input.router.authConfigs } : {}),
    ...(authConfigIds.length > 0 ? { composio_auth_config_ids: authConfigIds } : {}),
    ...(previous.length > 0 ? { composio_previous_mcp_server_urls: previous } : {}),
  };
}

/** What a stored router's re-provision should carry over: its binding
 *  (recorded map, else the legacy id list) and its auth configs. */
export function routerCarryOver(auth: {
  composio_connected_accounts?: Record<string, string> | null;
  composio_connected_account_ids?: string[];
  composio_auth_configs?: Record<string, string> | null;
  composio_auth_config_ids?: string[];
}): Pick<ProvisionComposioRouterInput, "preferredAccounts" | "preferredAccountIds" | "authConfigs" | "authConfigIds"> {
  const recorded = auth.composio_connected_accounts && typeof auth.composio_connected_accounts === "object"
    ? auth.composio_connected_accounts
    : undefined;
  return {
    preferredAccounts: recorded,
    preferredAccountIds: recorded ? undefined : (Array.isArray(auth.composio_connected_account_ids) ? auth.composio_connected_account_ids : undefined),
    authConfigs: auth.composio_auth_configs && typeof auth.composio_auth_configs === "object" ? auth.composio_auth_configs : undefined,
    authConfigIds: Array.isArray(auth.composio_auth_config_ids) ? auth.composio_auth_config_ids : undefined,
  };
}

/** Which Composio key a stored router is called with — the same rule as the
 *  MCP proxies: its own raw `api_key`, else the platform key, and only when
 *  `api_key_env` names the platform key's variable (any other name is
 *  refused by the proxies, so a router provisioned "for" it would not
 *  match what serves it). */
export function resolveRouterApiKey(
  auth: { api_key?: unknown; api_key_env?: unknown },
  platformKey: string | undefined,
): { apiKey: string; own: boolean } | null {
  if (typeof auth.api_key === "string" && auth.api_key.length > 0) return { apiKey: auth.api_key, own: true };
  const env = typeof auth.api_key_env === "string" && auth.api_key_env ? auth.api_key_env : COMPOSIO_PLATFORM_API_KEY_ENV;
  if (env !== COMPOSIO_PLATFORM_API_KEY_ENV || !platformKey) return null;
  return { apiKey: platformKey, own: false };
}

// ─── Rotation ─────────────────────────────────────────────────────────────

interface RefresherCredential {
  id: string;
  display_name?: string;
  archived_at?: string | null;
  auth?: unknown;
}

/** The slice of CredentialService the refresher writes through. */
export interface ComposioRouterCredentialStore {
  listByVaults(opts: {
    tenantId: string;
    vaultIds: string[];
  }): Promise<Array<{ vault_id: string; credentials: ReadonlyArray<RefresherCredential> }>>;
  create(opts: {
    tenantId: string;
    vaultId: string;
    displayName: string;
    auth: CredentialAuth;
  }): Promise<{ id: string }>;
  archive(opts: { tenantId: string; vaultId: string; credentialId: string }): Promise<unknown>;
  /** Merge-update (CredentialService.update). Optional: used to record a
   *  verified-empty binding without rotating the router. */
  update?(opts: {
    tenantId: string;
    vaultId: string;
    credentialId: string;
    auth: Partial<CredentialAuth>;
  }): Promise<unknown>;
}

/**
 * Replace router credential `replaced` with a new one holding `auth`:
 * create first (no window without a router), then archive. If `replaced`
 * was archived meanwhile — another process rotated it — the new row is the
 * redundant one and is archived instead, so two active routers never claim
 * the same lineage. Callers hold the vault lock (same-process rotations).
 */
export async function rotateRouterCredential(
  store: ComposioRouterCredentialStore,
  input: {
    tenantId: string;
    vaultId: string;
    replaced: { id: string; display_name?: string } | null;
    displayName: string;
    auth: CredentialAuth;
  },
): Promise<{ id: string; conflict: boolean }> {
  const { tenantId, vaultId } = input;
  const created = await store.create({ tenantId, vaultId, displayName: input.displayName, auth: input.auth });
  if (!input.replaced) return { id: created.id, conflict: false };
  const fresh = await store.listByVaults({ tenantId, vaultIds: [vaultId] }).catch(() => null);
  const current = fresh
    ?.flatMap((group) => group.credentials)
    .find((credential) => credential.id === input.replaced!.id);
  if (fresh && (!current || current.archived_at)) {
    await store.archive({ tenantId, vaultId, credentialId: created.id }).catch(() => {});
    return { id: created.id, conflict: true };
  }
  await store.archive({ tenantId, vaultId, credentialId: input.replaced.id });
  return { id: created.id, conflict: false };
}

/** Promise-chain mutex per key. */
class KeyedLock {
  readonly #tails = new Map<string, Promise<unknown>>();
  readonly #held = new Map<string, number>();

  busy(key: string): boolean {
    return (this.#held.get(key) ?? 0) > 0;
  }

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    this.#held.set(key, (this.#held.get(key) ?? 0) + 1);
    const previous = this.#tails.get(key) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(fn);
    const tail = run.catch(() => {});
    this.#tails.set(key, tail);
    try {
      return await run;
    } finally {
      const left = (this.#held.get(key) ?? 1) - 1;
      if (left > 0) this.#held.set(key, left);
      else this.#held.delete(key);
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    }
  }
}

// ─── Repair of existing routers ───────────────────────────────────────────

type RouterAuth = CredentialAuth & Record<string, unknown>;

/**
 * - lazy:  before a session starts. A fully bound router (every enabled
 *          toolkit recorded) costs nothing. A router of unknown binding
 *          (legacy rows) is checked inline — the session-start caller
 *          waits on it within its budget — at most once per ttlMs, and a
 *          verified-empty result is recorded so it isn't repeated. A
 *          recorded router with toolkits that had no account is re-checked
 *          in the BACKGROUND at most once per backgroundTtlMs (new accounts
 *          normally arrive through the connect flows, which refresh
 *          explicitly). A vault whose routers are being rotated right now
 *          is skipped, not waited on. Unlocked routers are left to the
 *          explicit modes.
 * - check: re-provision when the binding is unknown, a bound account is no
 *          longer bindable, or a toolkit without a binding now has an
 *          account. Accounts still bindable stay bound — a newer account
 *          of the same toolkit (a second Slack workspace connected for
 *          another agent) does not move existing routers to it.
 * - force: re-provision every router (keeping bindable accounts).
 */
export type ComposioRouterRefreshMode = "lazy" | "check" | "force";

export interface ComposioRouterRefreshResult {
  vault_id: string;
  credential_id: string;
  status: "refreshed" | "unchanged" | "skipped";
  reason?: string;
  replacement_credential_id?: string;
  mcp_server_url?: string;
  toolkits?: string[];
  connected_accounts?: Record<string, string>;
}

export interface ComposioRouterRefresherOptions {
  /** Operator-level key — what a credential storing `api_key_env` (or no
   *  key at all) was provisioned with. */
  platformApiKey?: string | (() => string | undefined);
  baseUrl?: string;
  fetcher?: typeof fetch;
  /** Inline lazy checks of unknown-binding routers: minimum spacing per
   *  credential (also the back-off after a failure). */
  ttlMs?: number;
  /** Background lazy re-checks of recorded routers with unbound toolkits. */
  backgroundTtlMs?: number;
  /** Per Composio request. */
  requestTimeoutMs?: number;
  now?: () => number;
  onError?: (err: unknown, ctx: { tenantId: string; vaultId: string; credentialId: string }) => void;
}

const DEFAULT_REFRESH_TTL_MS = 5 * 60_000;
const DEFAULT_BACKGROUND_TTL_MS = 30 * 60_000;
const DEFAULT_REFRESHER_REQUEST_TIMEOUT_MS = 5_000;

function isConcreteRouterAuth(auth: RouterAuth): boolean {
  if (auth.type !== "composio_mcp" || !auth.composio_session_id) return false;
  return isConcreteRouterUrl(typeof auth.mcp_server_url === "string" ? auth.mcp_server_url : "");
}

function sameBinding(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if (a[key] !== b[key]) return false;
  return true;
}

function slugList(raw: unknown): string[] {
  return (Array.isArray(raw) ? raw : []).map((t) => normalizeComposioToolkitSlug(String(t))).filter(Boolean);
}

function recordedBinding(auth: RouterAuth): Record<string, string> | null {
  const raw = auth.composio_connected_accounts;
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, string>) : null;
}

export class ComposioRouterRefresher {
  readonly #opts: ComposioRouterRefresherOptions;
  /** `${tenant}|${credentialId}` → when a lazy check last started. */
  readonly #checkedAt = new Map<string, number>();
  readonly #lock = new KeyedLock();
  /** Credentials this process already replaced (any rotation path). */
  readonly #replaced = new Set<string>();
  readonly #background = new Set<Promise<unknown>>();

  constructor(opts: ComposioRouterRefresherOptions = {}) {
    this.#opts = opts;
  }

  #now(): number {
    return this.#opts.now ? this.#opts.now() : Date.now();
  }

  #platformKey(): string | undefined {
    const raw = this.#opts.platformApiKey;
    const key = typeof raw === "function" ? raw() : raw;
    return key?.trim() || undefined;
  }

  /** Run `fn` holding the vault's rotation lock — every path that replaces
   *  a router credential in that vault goes through here. */
  withVaultLock<T>(tenantId: string, vaultId: string, fn: () => Promise<T>): Promise<T> {
    return this.#lock.run(`${tenantId}|${vaultId}`, fn);
  }

  /** Record a rotation done outside the refresher (toolkit add, graft). */
  markReplaced(tenantId: string, credentialId: string): void {
    this.#replaced.add(`${tenantId}|${credentialId}`);
    this.#checkedAt.delete(`${tenantId}|${credentialId}`);
  }

  /** Settles when every background check started so far has (tests). */
  async idle(): Promise<void> {
    while (this.#background.size > 0) await Promise.allSettled([...this.#background]);
  }

  async refreshVaults(input: {
    credentials: ComposioRouterCredentialStore;
    tenantId: string;
    vaultIds: string[];
    mode?: ComposioRouterRefreshMode;
  }): Promise<ComposioRouterRefreshResult[]> {
    const mode = input.mode ?? "lazy";
    const vaultIds = [...new Set(input.vaultIds)];
    if (vaultIds.length === 0) return [];
    return mode === "lazy" ? this.#lazy(input.credentials, input.tenantId, vaultIds) : this.#explicit(input.credentials, input.tenantId, vaultIds, mode);
  }

  /** check/force: per vault, under the lock, on a fresh read — so a run
   *  that queued behind another rotation sees its result, not stale rows. */
  async #explicit(
    store: ComposioRouterCredentialStore,
    tenantId: string,
    vaultIds: string[],
    mode: "check" | "force",
  ): Promise<ComposioRouterRefreshResult[]> {
    const results: ComposioRouterRefreshResult[] = [];
    for (const vaultId of vaultIds) {
      const vaultResults = await this.withVaultLock(tenantId, vaultId, async () => {
        const [group] = await store.listByVaults({ tenantId, vaultIds: [vaultId] });
        const listings = new Map<string, Promise<ComposioConnectedAccount[]>>();
        const out: ComposioRouterRefreshResult[] = [];
        for (const credential of group?.credentials ?? []) {
          if (credential.archived_at) continue;
          const auth = credential.auth as RouterAuth | null | undefined;
          if (!auth || !isConcreteRouterAuth(auth)) continue;
          out.push(await this.#refreshOne({ store, tenantId, vaultId, credential, auth, mode, listings, siblings: group.credentials }));
        }
        return out;
      });
      results.push(...vaultResults);
    }
    return results;
  }

  async #lazy(
    store: ComposioRouterCredentialStore,
    tenantId: string,
    vaultIds: string[],
  ): Promise<ComposioRouterRefreshResult[]> {
    const grouped = await store.listByVaults({ tenantId, vaultIds });
    const ttl = this.#opts.ttlMs ?? DEFAULT_REFRESH_TTL_MS;
    const backgroundTtl = this.#opts.backgroundTtlMs ?? DEFAULT_BACKGROUND_TTL_MS;
    const results: ComposioRouterRefreshResult[] = [];
    const inline: Array<Promise<ComposioRouterRefreshResult[]>> = [];
    for (const group of grouped) {
      const vaultId = group.vault_id;
      const due: Array<{ credential: RefresherCredential; recorded: boolean }> = [];
      for (const credential of group.credentials) {
        if (credential.archived_at) continue;
        const auth = credential.auth as RouterAuth | null | undefined;
        if (!auth || !isConcreteRouterAuth(auth)) continue;
        const base = { vault_id: vaultId, credential_id: credential.id };
        const key = `${tenantId}|${credential.id}`;
        if (this.#replaced.has(key)) continue;
        const enabled = slugList(auth.composio_toolkits);
        if (enabled.length === 0) {
          results.push({ ...base, status: "unchanged", reason: "unlocked router" });
          continue;
        }
        const recorded = recordedBinding(auth);
        if (recorded && enabled.every((toolkit) => recorded[toolkit])) {
          results.push({ ...base, status: "unchanged" });
          continue;
        }
        const checked = this.#checkedAt.get(key);
        if (checked !== undefined && this.#now() - checked < (recorded ? backgroundTtl : ttl)) {
          results.push({ ...base, status: "unchanged", reason: "recently checked" });
          continue;
        }
        due.push({ credential, recorded: recorded !== null });
      }
      if (due.length === 0) continue;
      if (this.#lock.busy(`${tenantId}|${vaultId}`)) {
        // A rotation is running for this vault; the proxy routes the
        // pinned URL to its successor once it lands — don't wait on it.
        for (const { credential } of due) {
          results.push({ vault_id: vaultId, credential_id: credential.id, status: "skipped", reason: "refresh in flight" });
        }
        continue;
      }
      // Stamped at START: callers arriving while Composio hangs back off
      // instead of piling onto the same slow request.
      for (const { credential } of due) this.#checkedAt.set(`${tenantId}|${credential.id}`, this.#now());
      const run = this.withVaultLock(tenantId, vaultId, async () => {
        const [fresh] = await store.listByVaults({ tenantId, vaultIds: [vaultId] });
        const listings = new Map<string, Promise<ComposioConnectedAccount[]>>();
        const out: ComposioRouterRefreshResult[] = [];
        for (const { credential } of due) {
          const base = { vault_id: vaultId, credential_id: credential.id };
          const current = fresh?.credentials.find((c) => c.id === credential.id);
          const auth = current?.auth as RouterAuth | null | undefined;
          if (!current || current.archived_at || !auth || this.#replaced.has(`${tenantId}|${credential.id}`)) {
            out.push({ ...base, status: "unchanged", reason: "already replaced" });
            continue;
          }
          out.push(await this.#refreshOne({
            store,
            tenantId,
            vaultId,
            credential: current,
            auth,
            mode: "check",
            listings,
            siblings: fresh.credentials,
          }));
        }
        return out;
      });
      if (due.some((d) => !d.recorded)) {
        // Unknown binding (legacy rows): the session-start caller waits
        // for this within its budget — its router may not see accounts.
        inline.push(run);
      } else {
        const tracked: Promise<unknown> = run.catch(() => {}).finally(() => this.#background.delete(tracked));
        this.#background.add(tracked);
        for (const { credential } of due) {
          results.push({ vault_id: vaultId, credential_id: credential.id, status: "unchanged", reason: "background check" });
        }
      }
    }
    for (const vaultResults of await Promise.all(inline)) results.push(...vaultResults);
    return results;
  }

  async #refreshOne(ctx: {
    store: ComposioRouterCredentialStore;
    tenantId: string;
    vaultId: string;
    credential: RefresherCredential;
    auth: RouterAuth;
    mode: "check" | "force";
    listings: Map<string, Promise<ComposioConnectedAccount[]>>;
    siblings: ReadonlyArray<RefresherCredential>;
  }): Promise<ComposioRouterRefreshResult> {
    const { auth, credential, tenantId, vaultId, mode } = ctx;
    const base = { vault_id: vaultId, credential_id: credential.id };
    const userId = typeof auth.composio_user_id === "string" ? auth.composio_user_id : "";
    if (!userId) return { ...base, status: "skipped", reason: "no composio_user_id" };
    const key = resolveRouterApiKey(auth, this.#platformKey());
    if (!key) return { ...base, status: "skipped", reason: "no usable Composio API key" };
    if (!key.own && !isTenantScopedComposioUserId(userId, tenantId)) {
      return { ...base, status: "skipped", reason: "user_id outside this tenant" };
    }

    const enabled = slugList(auth.composio_toolkits);
    const disabled = slugList(auth.composio_disabled_toolkits);
    const recorded = recordedBinding(auth);
    // A router created with toolkits.disable before that list was stored
    // looks unlocked; re-provisioning it would re-enable what the user
    // disabled. Only an explicit force touches it.
    if (mode === "check" && enabled.length === 0 && disabled.length === 0 && recorded === null) {
      return { ...base, status: "skipped", reason: "legacy unlocked router (use mode=force)" };
    }

    const deps: ComposioClientDeps = {
      apiKey: key.apiKey,
      baseUrl: this.#opts.baseUrl,
      fetcher: this.#opts.fetcher,
      timeoutMs: this.#opts.requestTimeoutMs ?? DEFAULT_REFRESHER_REQUEST_TIMEOUT_MS,
    };
    const carry = routerCarryOver(auth);
    try {
      const listingKey = `${key.apiKey}|${userId}`;
      let listing = ctx.listings.get(listingKey);
      if (!listing) {
        listing = listAllComposioConnectedAccounts(deps, userId);
        ctx.listings.set(listingKey, listing);
      }
      const accounts = await listing;
      const desired = selectComposioAccountBindings({
        accounts,
        userId,
        enabled,
        disabled,
        preferred: { ...preferredFromIds(accounts, carry.preferredAccountIds), ...(carry.preferredAccounts ?? {}) },
      });

      const needed =
        mode === "force" ||
        (recorded === null ? Object.keys(desired).length > 0 : !sameBinding(desired, recorded));
      if (!needed) {
        if (recorded === null && ctx.store.update) {
          // Verified: nothing in scope is bindable, so "bound to nothing"
          // is the truth — record it so lazy repair stops re-checking.
          await ctx.store
            .update({ tenantId, vaultId, credentialId: credential.id, auth: { composio_connected_accounts: {} } })
            .catch(() => {});
        }
        return { ...base, status: "unchanged", connected_accounts: recorded ?? {} };
      }

      // Rotation creates before it archives: needs a free slot. Checked
      // before the Composio session exists, so a full vault doesn't
      // orphan one router per attempt.
      const active = ctx.siblings.filter((c) => !c.archived_at).length;
      if (active >= MAX_CREDENTIALS_PER_VAULT) {
        return { ...base, status: "skipped", reason: `vault holds ${MAX_CREDENTIALS_PER_VAULT} active credentials` };
      }

      const router = await provisionComposioToolRouter(deps, {
        userId,
        enabled,
        disabled,
        accounts,
        preferredAccounts: desired,
        authConfigs: carry.authConfigs,
        authConfigIds: carry.authConfigIds,
      });
      const previous = Array.isArray(auth.composio_previous_mcp_server_urls)
        ? auth.composio_previous_mcp_server_urls
        : [];
      const rotated = await rotateRouterCredential(ctx.store, {
        tenantId,
        vaultId,
        replaced: credential,
        displayName: credential.display_name || "Composio Tool Router",
        auth: composioRouterAuth({
          key: key.own ? { api_key: key.apiKey } : { api_key_env: COMPOSIO_PLATFORM_API_KEY_ENV },
          userId,
          router,
          enabled,
          disabled,
          authConfigIds: carry.authConfigIds,
          replacedUrls: [auth.mcp_server_url, ...previous],
        }),
      });
      this.markReplaced(tenantId, credential.id);
      if (rotated.conflict) {
        return { ...base, status: "unchanged", reason: "replaced concurrently" };
      }
      this.#checkedAt.set(`${tenantId}|${rotated.id}`, this.#now());
      return {
        ...base,
        status: "refreshed",
        replacement_credential_id: rotated.id,
        mcp_server_url: router.session.mcp.url,
        toolkits: enabled,
        connected_accounts: router.connectedAccounts,
      };
    } catch (err) {
      this.#opts.onError?.(err, { tenantId, vaultId, credentialId: credential.id });
      return { ...base, status: "skipped", reason: err instanceof Error ? err.message : String(err) };
    }
  }
}
