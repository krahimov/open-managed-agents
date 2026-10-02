/**
 * apps/oma-vault — outbound credential injector for Self-host OMA.
 *
 * Architecture:
 *
 *   sandbox bash → curl https://api.github.com/user
 *       │
 *       │  HTTPS_PROXY=http://oma-vault:14322
 *       │  NODE_EXTRA_CA_CERTS=/var/oma-vault-ca.crt
 *       ▼
 *   oma-vault (this process)
 *     - mockttp HTTPS proxy with self-signed CA (regenerated per install)
 *     - on incoming request: verify the HMAC-signed session token carried
 *       in the proxy credentials → (tenant, session)
 *     - enforce the session environment's egress policy + SSRF guard
 *     - resolve a credential for the host from THAT session's vault_ids
 *     - inject Authorization / x-api-key / etc. header (https only)
 *     - forward to upstream
 *       │
 *       ▼
 *   api.github.com  ← sees Authorization: Bearer ghp_xxx
 *
 * The agent never sees the credential value. main-node doesn't either at
 * request time — apps/oma-vault reads vault credentials directly from the
 * shared sqlite db.
 *
 * This is the self-host analog of @cloudflare/sandbox's outboundByHost +
 * MAIN_MCP.lookupOutboundCredential pattern. Same security model: MITM
 * proxy, session-scoped credential matched on hostname, inject header,
 * forward. Configuration + env vars: docs/self-host.md "Vault credential
 * injection".
 */

import { promises as fs } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getLocal, generateCACertificate, type CompletedRequest } from "mockttp";
import {
  createBetterSqlite3SqlClient,
  createPostgresSqlClient,
  type SqlClient,
} from "@open-managed-agents/sql-client";
import {
  defaultProxyKeyFileForCaDir,
  extractProxyTokenFromTags,
  resolveProxyTokenKey,
  verifyProxyToken,
  type ProxySessionIdentity,
} from "@open-managed-agents/vault-forward/proxy-token";
import { createNodeLogger } from "@open-managed-agents/observability/logger/node";
import { setRootLogger, type Logger } from "@open-managed-agents/observability";
import {
  findLegacyCredentialForUrl,
  findSessionCredentialForUrl,
  loadSessionScope,
  type MatchedCred,
  type SessionScope,
} from "./resolver.js";
import {
  checkEgressPolicy,
  checkPrivateDestination,
  createGuardedLookup,
  EgressBlockedError,
  forwardUpstream,
  type PrivateEgressOptions,
} from "./egress-guard.js";

const logger: Logger = await createNodeLogger({ bindings: { service: "oma-vault" } });
setRootLogger(logger);

// ─── Bootstrap ───────────────────────────────────────────────────────────

// Backend selection mirrors main-node: DATABASE_URL (postgres:// /
// postgresql://) wins, else fall back to better-sqlite3 with DATABASE_PATH.
// Vault credentials are written by main-node into the same store, so the
// two services MUST agree on the backend or oma-vault won't see the rows.
const dbUrl = process.env.DATABASE_URL ?? "";
const usePostgres =
  dbUrl.startsWith("postgres://") || dbUrl.startsWith("postgresql://");
const dbPath = process.env.DATABASE_PATH ?? "./data/oma.db";
const caDir = process.env.OMA_VAULT_CA_DIR ?? "./data/oma-vault-ca";
const port = Number(process.env.OMA_VAULT_PORT ?? 14322);
mkdirSync(resolve(caDir), { recursive: true });

const sql: SqlClient = usePostgres
  ? await createPostgresSqlClient(dbUrl)
  : await createBetterSqlite3SqlClient(dbPath);
logger.info(
  { op: "oma_vault.sql_backend", backend: usePostgres ? "postgres" : "sqlite", dsn: usePostgres ? new URL(dbUrl).host : dbPath },
  `sql backend: ${usePostgres ? `postgres ${new URL(dbUrl).host}` : `sqlite ${dbPath}`}`,
);

// ─── CA management ───────────────────────────────────────────────────────
//
// On first start we generate a self-signed CA + key, persist them at
// ${OMA_VAULT_CA_DIR}/{ca.crt,ca.key}. Subsequent starts reuse the same CA
// so sandboxes that already trust it don't need to be updated. Sandboxes
// install ca.crt at startup via NODE_EXTRA_CA_CERTS / equivalent.
//
// Multi-replica safety: when N vault replicas boot against a shared
// caDir (e.g. NFS / EFS / shared docker volume) we must avoid all N
// generating different CAs and racing to overwrite ca.key — sandboxes
// would only trust one of them. Strategy:
//   1. Try to read existing files (happy path on every start past first).
//   2. Otherwise, attempt an exclusive create (O_EXCL) on `ca.lock`. The
//      losing replicas wait+poll for ca.crt to appear, then read it.
//   3. The winner generates the CA, writes ca.crt + ca.key, then releases
//      the lock by removing ca.lock.

async function loadOrCreateCA(): Promise<{ cert: string; key: string }> {
  const certPath = resolve(caDir, "ca.crt");
  const keyPath = resolve(caDir, "ca.key");
  const lockPath = resolve(caDir, "ca.lock");

  // Happy path: cert + key already on disk.
  const existing = await tryReadCA(certPath, keyPath);
  if (existing) return existing;

  // Race-safe create. O_EXCL means exactly one replica succeeds; the
  // others fall through to the wait-and-read path.
  let lockFd: import("node:fs/promises").FileHandle | null = null;
  try {
    lockFd = await fs.open(lockPath, "wx");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    // Another replica is generating; wait for ca.crt to appear.
    return waitForCA(certPath, keyPath);
  }

  try {
    // Re-check inside the lock — a third replica may have generated
    // between our initial read and our lock acquisition.
    const inLock = await tryReadCA(certPath, keyPath);
    if (inLock) return inLock;

    logger.info({ op: "oma_vault.ca_generate", ca_dir: caDir }, `generating new CA at ${caDir}`);
    const ca = await generateCACertificate({
      subject: { commonName: "OMA Vault Local CA" },
    });
    await fs.writeFile(certPath, ca.cert);
    await fs.writeFile(keyPath, ca.key, { mode: 0o600 });
    return ca;
  } finally {
    await lockFd.close().catch(() => {});
    await fs.rm(lockPath, { force: true }).catch(() => {});
  }
}

async function tryReadCA(
  certPath: string,
  keyPath: string,
): Promise<{ cert: string; key: string } | null> {
  try {
    const [cert, key] = await Promise.all([
      fs.readFile(certPath, "utf8"),
      fs.readFile(keyPath, "utf8"),
    ]);
    return { cert, key };
  } catch {
    return null;
  }
}

/** Poll until the winning replica finishes writing ca.crt + ca.key. The
 *  generator runs in <1s on commodity hardware; bound the wait at 30s
 *  to avoid wedging a deploy when the lock holder dies mid-generation. */
async function waitForCA(
  certPath: string,
  keyPath: string,
): Promise<{ cert: string; key: string }> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const got = await tryReadCA(certPath, keyPath);
    if (got) return got;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `[oma-vault] timed out waiting for peer to generate CA at ${certPath}`,
  );
}

const ca = await loadOrCreateCA();

// ─── Session identity (signed proxy tokens) ──────────────────────────────

const proxyKey = resolveProxyTokenKey({
  env: process.env,
  keyFile: defaultProxyKeyFileForCaDir(resolve(caDir)),
  createKeyFile: true,
});
if (!proxyKey) {
  // createKeyFile: true means this only happens on an unwritable caDir.
  throw new Error(`[oma-vault] could not resolve or create a proxy token key under ${caDir}`);
}
const proxyTokenKey: Uint8Array = proxyKey.key;
logger.info(
  { op: "oma_vault.proxy_key", source: proxyKey.source, path: proxyKey.path },
  `proxy session tokens verified with key from ${proxyKey.source}${proxyKey.path ? ` (${proxyKey.path})` : ""}`,
);

const envFlag = (name: string): boolean => {
  const v = (process.env[name] ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
};

// OMA_TENANT: when set to a concrete tenant id, tokens for any other tenant
// are refused (defence-in-depth for single-tenant deploys) and it scopes the
// legacy host matcher. Default "*" = accept any tenant's (verified) token.
const tenantLock = (process.env.OMA_TENANT ?? "*").trim() || "*";
// Legacy: anonymous (token-less) traffic gets the pre-fix cross-tenant
// host-only credential match. Explicit opt-in; never used for requests that
// carry a session token.
const legacyHostMatching = envFlag("OMA_VAULT_LEGACY_HOST_MATCHING");
// Anonymous (token-less) traffic: "deny" (default) → 407; "passthrough" →
// forwarded with no credentials and no environment egress policy.
const anonymousPolicy: "deny" | "passthrough" =
  legacyHostMatching || (process.env.OMA_VAULT_ANONYMOUS ?? "").trim().toLowerCase() === "passthrough"
    ? "passthrough"
    : "deny";
// Credentials are only injected into https:// requests unless explicitly
// allowed — a plain-http request would put the bearer token on the wire.
const allowHttpInjection = envFlag("OMA_VAULT_ALLOW_INSECURE_HTTP_INJECTION");
const privateEgress: PrivateEgressOptions = {
  allowPrivate: envFlag("OMA_VAULT_ALLOW_PRIVATE_EGRESS"),
  privateAllowlist: new Set(
    (process.env.OMA_VAULT_PRIVATE_EGRESS_ALLOWLIST ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  ),
};
const guardedLookup = createGuardedLookup(privateEgress);

if (legacyHostMatching) {
  logger.warn(
    { op: "oma_vault.legacy_host_matching", tenant_scope: tenantLock },
    "OMA_VAULT_LEGACY_HOST_MATCHING=1: token-less requests get the first credential matching the host " +
      (tenantLock === "*" ? "across ALL tenants" : `in tenant ${tenantLock}`) +
      " — credentials can leak between sessions/tenants. Single-operator deploys only.",
  );
}

// Short-lived cache so a burst of requests from one sandbox doesn't hit the
// db per request. Short TTL keeps archive / vault / environment edits fresh.
const SCOPE_TTL_MS = 5_000;
const scopeCache = new Map<string, { at: number; scope: SessionScope | null }>();

async function getSessionScope(identity: ProxySessionIdentity): Promise<SessionScope | null> {
  const key = `${identity.tenantId}|${identity.sessionId}`;
  const hit = scopeCache.get(key);
  if (hit && Date.now() - hit.at < SCOPE_TTL_MS) return hit.scope;
  const scope = await loadSessionScope(sql, identity);
  scopeCache.set(key, { at: Date.now(), scope });
  if (scopeCache.size > 1_000) {
    const oldest = scopeCache.keys().next().value;
    if (oldest !== undefined) scopeCache.delete(oldest);
  }
  return scope;
}

type Attribution =
  | { kind: "session"; scope: SessionScope }
  | { kind: "anonymous" }
  | { kind: "reject"; status: number; reason: string };

async function attributeRequest(req: CompletedRequest): Promise<Attribution> {
  const extracted = extractProxyTokenFromTags(req.tags);
  if (extracted.kind === "none") return { kind: "anonymous" };
  if (extracted.kind === "ambiguous") {
    return { kind: "reject", status: 407, reason: "multiple session tokens presented" };
  }
  const verified = verifyProxyToken(proxyTokenKey, extracted.token);
  if (!verified.ok) {
    return {
      kind: "reject",
      status: 407,
      reason:
        `invalid session token (${verified.reason})` +
        (verified.reason === "bad_signature"
          ? " — main-node and oma-vault must share PLATFORM_ROOT_SECRET / OMA_VAULT_PROXY_SECRET / OMA_VAULT_PROXY_KEY_FILE"
          : ""),
    };
  }
  if (tenantLock !== "*" && verified.identity.tenantId !== tenantLock) {
    return { kind: "reject", status: 407, reason: "tenant not permitted by OMA_TENANT" };
  }
  let scope: SessionScope | null;
  try {
    scope = await getSessionScope(verified.identity);
  } catch (err) {
    logger.error({ err, op: "oma_vault.session_lookup_failed" }, "session lookup failed");
    return { kind: "reject", status: 503, reason: "session lookup failed" };
  }
  if (!scope) return { kind: "reject", status: 407, reason: "session not found or archived" };
  return { kind: "session", scope };
}

function deny(status: number, message: string) {
  return {
    statusCode: status,
    headers: {
      "content-type": "text/plain",
      ...(status === 407 ? { "proxy-authenticate": 'Basic realm="oma-vault"' } : {}),
    },
    body: `oma-vault: ${message}\n`,
  };
}

// ─── mockttp proxy ───────────────────────────────────────────────────────

const proxy = getLocal({
  https: { cert: ca.cert, key: ca.key },
  // record traffic = false; we don't keep request bodies in memory
  recordTraffic: false,
});

// Strip any incoming Authorization headers — the agent must not be able to
// override the injected value or smuggle a stolen token. Mirrors the
// Infisical Agent Vault + CF outboundByHost zero-trust behaviour. Also strip
// hop-by-hop / connection-level headers (`host` is re-derived from the URL).
const STRIP = new Set([
  "authorization",
  "x-api-key",
  "x-goog-api-key",
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

// Match all proxied traffic. Plain HTTP and HTTPS via CONNECT both flow
// through the same handler thanks to mockttp's TLS termination.
proxy.forAnyRequest().thenCallback(async (req: CompletedRequest) => {
  const url = req.url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return deny(400, "invalid request URL");
  }

  // 1. Who is this? Only a verified token attributes a request to a session.
  const who = await attributeRequest(req);
  if (who.kind === "reject") {
    logger.warn(
      { op: "oma_vault.reject", status: who.status, reason: who.reason, host: parsed.hostname },
      `rejected ${req.method} ${parsed.hostname}: ${who.reason}`,
    );
    return deny(who.status, who.reason);
  }
  if (who.kind === "anonymous" && anonymousPolicy === "deny") {
    logger.warn(
      { op: "oma_vault.reject_anonymous", host: parsed.hostname },
      `rejected ${req.method} ${parsed.hostname}: no session token (set OMA_VAULT_ANONYMOUS=passthrough to allow token-less traffic)`,
    );
    return deny(407, "session token required");
  }

  // 2. Environment egress policy (networking: limited).
  if (who.kind === "session") {
    const policy = checkEgressPolicy(url, who.scope.egress);
    if (!policy.allowed) {
      logger.info(
        { op: "oma_vault.egress_denied", session_id: who.scope.sessionId, host: parsed.hostname },
        `egress denied for session ${who.scope.sessionId}: ${policy.reason}`,
      );
      return deny(403, `egress blocked: ${policy.reason}`);
    }
  }

  // 3. SSRF guard (pre-flight; re-checked at connect time).
  const ssrf = await checkPrivateDestination(url, privateEgress);
  if (!ssrf.allowed) {
    logger.warn(
      { op: "oma_vault.private_egress_denied", host: parsed.hostname, reason: ssrf.reason },
      `private egress denied: ${ssrf.reason}`,
    );
    return deny(403, `egress blocked: ${ssrf.reason}`);
  }

  // 4. Credential resolution — session's own vaults only.
  let matched: MatchedCred | null = null;
  try {
    matched =
      who.kind === "session"
        ? await findSessionCredentialForUrl(sql, url, who.scope)
        : legacyHostMatching
          ? await findLegacyCredentialForUrl(sql, url, tenantLock)
          : null;
  } catch (err) {
    logger.error({ err, op: "oma_vault.credential_lookup_failed", host: parsed.hostname }, "credential lookup failed");
  }
  if (matched && parsed.protocol !== "https:" && !allowHttpInjection) {
    logger.warn(
      { op: "oma_vault.skip_insecure_inject", host: parsed.host, credential_id: matched.credentialId },
      `not injecting credential into plain-http request to ${parsed.host} (OMA_VAULT_ALLOW_INSECURE_HTTP_INJECTION=1 to allow)`,
    );
    matched = null;
  }

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (STRIP.has(k.toLowerCase())) continue;
    if (typeof v === "string") headers[k] = v;
    else if (Array.isArray(v)) headers[k] = v.join(", ");
  }

  if (matched) {
    headers[matched.injectHeader.name] = matched.injectHeader.value;
    logger.info(
      {
        op: "oma_vault.inject",
        header: matched.injectHeader.name,
        url,
        credential_id: matched.credentialId,
        session_id: who.kind === "session" ? who.scope.sessionId : undefined,
      },
      `inject ${matched.injectHeader.name} for ${url}`,
    );
  } else {
    logger.debug({ op: "oma_vault.passthrough", method: req.method, url }, `passthrough ${req.method} ${url}`);
  }

  // 5. Forward. node:http(s) + guarded lookup so the SSRF check covers the
  // address actually dialled. rawBody: the upstream body is passed through
  // byte-for-byte with its original content-encoding.
  const bodyBuf = req.body.buffer;
  try {
    const upstream = await forwardUpstream({
      url,
      method: req.method,
      headers,
      body: bodyBuf.byteLength > 0 ? bodyBuf : null,
      lookup: guardedLookup,
    });
    return { statusCode: upstream.statusCode, headers: upstream.headers, rawBody: upstream.body };
  } catch (err) {
    if (err instanceof EgressBlockedError) {
      logger.warn({ op: "oma_vault.private_egress_denied", host: parsed.hostname, reason: err.message }, err.message);
      return deny(403, `egress blocked: ${err.message}`);
    }
    const msg = (err as Error).message ?? String(err);
    logger.error({ err, op: "oma_vault.forward_failed", url }, `forward failed for ${url}: ${msg}`);
    return deny(502, `upstream forward failed: ${msg}`);
  }
});

await proxy.start(port);

logger.info(
  {
    op: "oma_vault.listening",
    port,
    tenant_scope: tenantLock === "*" ? "all" : tenantLock,
    anonymous: anonymousPolicy,
    legacy_host_matching: legacyHostMatching,
    private_egress: privateEgress.allowPrivate ? "allowed" : "blocked",
    ca_cert: resolve(caDir, "ca.crt"),
  },
  `listening on http://0.0.0.0:${port}`,
);
// User-facing hint on stdout. Sandbox processes don't need this copied by
// hand: main-node's sandbox adapters set HTTP(S)_PROXY per session with a
// signed session token (packages/sandbox/src/adapters/outbound-proxy.ts).
const caCert = resolve(caDir, "ca.crt");
process.stdout.write(`\n# OMA vault: point main-node at this proxy with\nOMA_VAULT_PROXY_URL=http://localhost:${port}\nOMA_VAULT_CA_CERT=${caCert}\n# (sandbox HTTP(S)_PROXY is set per session by main-node, carrying a signed session token)\n\n`);

const shutdown = (signal: string) => {
  logger.info({ op: "oma_vault.shutdown", signal }, `received ${signal}, stopping proxy`);
  proxy.stop().then(() => process.exit(0));
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
