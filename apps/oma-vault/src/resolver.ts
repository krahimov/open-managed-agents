// Session-scoped credential + egress-policy resolution for oma-vault.
//
// Everything here takes the SqlClient as a parameter so it can be unit
// tested against an in-memory sqlite db (apps/oma-vault/test).
//
// Security model (post-fix):
//   - A request is attributed to a session ONLY via a verified, HMAC-signed
//     proxy token (see @open-managed-agents/vault-forward/proxy-token).
//   - Credentials resolve ONLY from that session's own `vault_ids`, filtered
//     by the session's tenant — same rule as the CF path
//     (apps/main/src/routes/mcp-proxy.ts resolveOutboundCredentialByHost),
//     using the shared pickCredentialByHost / buildAuthHeader.
//   - GitHub repo tokens resolve only from the session's own
//     github_repository resources.
//   - The cross-tenant "match any credential by hostname" lookup survives
//     only as an explicitly-enabled legacy mode for anonymous traffic.

import type { SqlClient } from "@open-managed-agents/sql-client";
import type { CredentialAuth } from "@open-managed-agents/shared";
import { resolveEgressPolicy, type EgressPolicy } from "@open-managed-agents/shared";
import { buildAuthHeader, pickCredentialByHost } from "@open-managed-agents/vault-forward";
import type { ProxySessionIdentity } from "@open-managed-agents/vault-forward/proxy-token";

export interface MatchedCred {
  vaultId: string;
  credentialId: string;
  injectHeader: { name: string; value: string };
}

export interface SessionScope {
  tenantId: string;
  sessionId: string;
  vaultIds: string[];
  /** null = unrestricted networking. */
  egress: EgressPolicy | null;
}

// ─── Session lookup ─────────────────────────────────────────────────────

interface SessionRow {
  id: string;
  tenant_id: string;
  environment_id: string | null;
  vault_ids: string | null;
  agent_snapshot: string | null;
  environment_snapshot: string | null;
}

/**
 * Load the session a verified token points at. Returns null when the
 * session doesn't exist, belongs to another tenant, or is archived — the
 * caller must then refuse the request (a revoked session's sandbox must
 * not keep getting credentials).
 */
export async function loadSessionScope(
  sql: SqlClient,
  identity: ProxySessionIdentity,
): Promise<SessionScope | null> {
  const row = await sql
    .prepare(
      `SELECT id, tenant_id, environment_id, vault_ids, agent_snapshot, environment_snapshot
         FROM sessions
        WHERE id = ? AND tenant_id = ? AND archived_at IS NULL
        LIMIT 1`,
    )
    .bind(identity.sessionId, identity.tenantId)
    .first<SessionRow>();
  if (!row) return null;

  const vaultIds = parseStringArray(row.vault_ids);
  const agent = parseJson<{ mcp_servers?: Array<{ url?: string }> }>(row.agent_snapshot);
  const mcpServerUrls = (agent?.mcp_servers ?? []).map((s) => s?.url);

  // Live environment row first (an operator tightening an environment
  // applies immediately, matching the CF getEnvConfig path); fall back to
  // the snapshot frozen on the session when the row is gone.
  let networking: Parameters<typeof resolveEgressPolicy>[0] = undefined;
  if (row.environment_id) {
    const envRow = await sql
      .prepare(`SELECT config FROM environments WHERE id = ? AND tenant_id = ? LIMIT 1`)
      .bind(row.environment_id, row.tenant_id)
      .first<{ config: string }>()
      .catch(() => null);
    const cfg = parseJson<{ networking?: Parameters<typeof resolveEgressPolicy>[0] }>(envRow?.config);
    if (cfg) networking = cfg.networking;
    else {
      const snap = parseJson<{ config?: { networking?: Parameters<typeof resolveEgressPolicy>[0] } }>(
        row.environment_snapshot,
      );
      networking = snap?.config?.networking;
    }
  } else {
    const snap = parseJson<{ config?: { networking?: Parameters<typeof resolveEgressPolicy>[0] } }>(
      row.environment_snapshot,
    );
    networking = snap?.config?.networking;
  }

  return {
    tenantId: row.tenant_id,
    sessionId: row.id,
    vaultIds,
    egress: resolveEgressPolicy(networking, { mcpServerUrls }),
  };
}

// ─── Credential lookup (session-scoped) ─────────────────────────────────

/**
 * Resolve the credential to inject for `url` on behalf of `scope`.
 * Order: session GitHub repo resources (most specific), then the session's
 * own vaults. Never looks outside the session's tenant / vault_ids.
 */
export async function findSessionCredentialForUrl(
  sql: SqlClient,
  url: string,
  scope: SessionScope,
): Promise<MatchedCred | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const github = await findGithubSessionCredentialForUrl(sql, parsed, scope);
  if (github) return github;

  if (scope.vaultIds.length === 0) return null;
  const grouped = await listCredentialsByVaults(sql, scope.tenantId, scope.vaultIds);
  const picked = pickCredentialByHost(grouped, parsed.host);
  if (!picked) return null;
  const header = buildAuthHeader(picked.auth);
  if (!header) return null;
  return { vaultId: picked.vaultId, credentialId: picked.credentialId, injectHeader: header };
}

/**
 * Active credentials in `vaultIds`, grouped per vault in the session's
 * vault_ids order (first vault wins on host collisions — same precedence
 * as services.credentials.listByVaults on the CF path). Tenant-filtered so
 * a session row pointing at a foreign vault id resolves nothing.
 */
export async function listCredentialsByVaults(
  sql: SqlClient,
  tenantId: string,
  vaultIds: string[],
): Promise<Array<{ vault_id: string; credentials: Array<{ id: string; auth: CredentialAuth }> }>> {
  if (vaultIds.length === 0) return [];
  const placeholders = vaultIds.map(() => "?").join(", ");
  const result = await sql
    .prepare(
      `SELECT id, vault_id, auth
         FROM credentials
        WHERE tenant_id = ?
          AND vault_id IN (${placeholders})
          AND archived_at IS NULL
        ORDER BY created_at, id`,
    )
    .bind(tenantId, ...vaultIds)
    .all<{ id: string; vault_id: string; auth: string }>();
  const byVault = new Map<string, Array<{ id: string; auth: CredentialAuth }>>();
  for (const row of result.results ?? []) {
    const auth = parseJson<CredentialAuth>(row.auth);
    if (!auth) continue;
    const list = byVault.get(row.vault_id) ?? [];
    list.push({ id: row.id, auth });
    byVault.set(row.vault_id, list);
  }
  return vaultIds
    .filter((v, i) => vaultIds.indexOf(v) === i)
    .map((vault_id) => ({ vault_id, credentials: byVault.get(vault_id) ?? [] }));
}

async function findGithubSessionCredentialForUrl(
  sql: SqlClient,
  parsedUrl: URL,
  scope: SessionScope,
): Promise<MatchedCred | null> {
  const hostname = parsedUrl.hostname.toLowerCase();
  if (hostname !== "github.com" && hostname !== "api.github.com") return null;

  const rows = await sql
    .prepare(
      `SELECT id, config
         FROM session_resources
        WHERE session_id = ?
          AND type IN ('github_repository', 'github_repo')
        ORDER BY created_at`,
    )
    .bind(scope.sessionId)
    .all<{ id: string; config: string }>()
    .catch(() => ({ results: [] as Array<{ id: string; config: string }> }));

  const requestSlug = parseGithubRepoSlug(parsedUrl.toString());
  let fallback: MatchedCred | null = null;

  for (const row of rows.results ?? []) {
    const resource = parseJson<{ url?: string; repo_url?: string }>(row.config);
    const repoUrl = resource?.url || resource?.repo_url;
    if (!repoUrl) continue;
    const resourceSlug = parseGithubRepoSlug(repoUrl);
    if (!resourceSlug) continue;

    const token = await readSessionSecret(sql, scope.tenantId, scope.sessionId, row.id);
    if (!token) continue;

    const matched: MatchedCred = {
      vaultId: "session",
      credentialId: `session_resource:${row.id}`,
      injectHeader: githubAuthHeaderFor(hostname, token),
    };
    if (requestSlug && requestSlug === resourceSlug) return matched;
    if (!fallback) fallback = matched;
  }

  return fallback;
}

async function readSessionSecret(
  sql: SqlClient,
  tenantId: string,
  sessionId: string,
  resourceId: string,
): Promise<string | null> {
  const key = `t:${tenantId}:secret:${sessionId}:${resourceId}`;
  const now = Date.now();
  const row = await sql
    .prepare(
      `SELECT value
         FROM kv_entries
        WHERE key = ?
          AND (tenant_id = ? OR tenant_id = 'default')
          AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY CASE WHEN tenant_id = ? THEN 0 ELSE 1 END
        LIMIT 1`,
    )
    .bind(key, tenantId, now, tenantId)
    .first<{ value: string }>()
    .catch(() => null);
  return row?.value ?? null;
}

// ─── Legacy (opt-in) host-only lookup ───────────────────────────────────

/**
 * Pre-fix behaviour: first active credential whose mcp_server_url host
 * matches, across every tenant (`tenantScope === "*"`) or one tenant.
 * Only reachable when OMA_VAULT_LEGACY_HOST_MATCHING=1 and the request
 * carries no session token. Leaks credentials between tenants/sessions by
 * design — single-operator deploys only.
 */
export async function findLegacyCredentialForUrl(
  sql: SqlClient,
  url: string,
  tenantScope: string,
): Promise<MatchedCred | null> {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return null;
  }
  const result = await sql
    .prepare(
      `SELECT id, tenant_id, vault_id, auth
         FROM credentials
        WHERE archived_at IS NULL
          AND mcp_server_url IS NOT NULL
          AND ( ? = '*' OR tenant_id = ? )`,
    )
    .bind(tenantScope, tenantScope)
    .all<{ id: string; tenant_id: string; vault_id: string; auth: string }>();
  for (const row of result.results ?? []) {
    const auth = parseJson<CredentialAuth>(row.auth);
    if (!auth) continue;
    const picked = pickCredentialByHost([{ vault_id: row.vault_id, credentials: [{ id: row.id, auth }] }], host);
    if (!picked) continue;
    const header = buildAuthHeader(picked.auth);
    if (!header) continue;
    return { vaultId: row.vault_id, credentialId: row.id, injectHeader: header };
  }
  return null;
}

// ─── helpers ────────────────────────────────────────────────────────────

function githubAuthHeaderFor(hostname: string, token: string): { name: string; value: string } {
  if (hostname.toLowerCase() === "github.com") {
    return {
      name: "authorization",
      value: `Basic ${Buffer.from(`x-access-token:${token}`, "utf8").toString("base64")}`,
    };
  }
  return { name: "authorization", value: `Bearer ${token}` };
}

export function parseGithubRepoSlug(input: string): string | null {
  if (!input) return null;
  let owner: string | undefined;
  let repo: string | undefined;

  if (input.startsWith("http://") || input.startsWith("https://")) {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      return null;
    }
    const host = url.hostname.toLowerCase();
    const parts: string[] = [];
    for (const segment of url.pathname.split("/")) {
      if (!segment || segment === ".") continue;
      if (segment === "..") {
        parts.pop();
        continue;
      }
      parts.push(segment);
    }
    if (host === "github.com" || host === "www.github.com") {
      owner = parts[0];
      repo = parts[1];
    } else if (host === "api.github.com" && parts[0] === "repos") {
      owner = parts[1];
      repo = parts[2];
    }
  }

  if (!owner) {
    const ssh = input.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (ssh) {
      owner = ssh[1];
      repo = ssh[2];
    }
  }

  if (!owner) {
    const bare = input.match(/^([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (bare) {
      owner = bare[1];
      repo = bare[2];
    }
  }

  if (!owner || !repo) return null;
  repo = repo.replace(/\.git$/i, "");
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(owner)) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(repo)) return null;
  return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

function parseJson<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function parseStringArray(raw: string | null | undefined): string[] {
  const v = parseJson<unknown>(raw);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
