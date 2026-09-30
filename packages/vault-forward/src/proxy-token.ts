// Signed session tokens for the self-host oma-vault outbound proxy.
//
// Node-only (node:crypto / node:fs). Deliberately NOT re-exported from the
// package root so CF bundles that import `@open-managed-agents/vault-forward`
// never pull these modules in.
//
// Flow:
//   main-node (signer) → sandbox adapter setOutboundContext():
//     HTTPS_PROXY=http://metadata:<b64url({"tags":["oma-session:<token>"]})>@oma-vault:14322
//   sandbox curl/python → CONNECT … Proxy-Authorization: Basic …
//   mockttp → req.tags = ["socket-metadata:oma-session:<token>"]
//   oma-vault (verifier) → verifyProxyToken() → (tenantId, sessionId)
//
// Token = base64url(JSON payload) "." base64url(HMAC-SHA256(key, payloadB64))
//
// The key is derived with HKDF-SHA256 from a shared secret
// (OMA_VAULT_PROXY_SECRET, else PLATFORM_ROOT_SECRET) under the fixed info
// label "oma-vault-proxy-v1", so it's domain-separated from every other use
// of PLATFORM_ROOT_SECRET (AES-GCM at-rest keys etc). When neither secret is
// configured (docker-compose quickstart without a .env), oma-vault generates
// a random 32-byte key file next to its CA (`<OMA_VAULT_CA_DIR>/proxy-token.key`,
// mode 0600) and main-node reads the same file via the shared ./data volume.
//
// Before this module the proxy "token" was unsigned base64url("tenant|session"),
// so any sandbox that learned another session id could impersonate it and
// receive that session's credentials.

import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, openSync, readFileSync, writeSync, closeSync } from "node:fs";
import { dirname, join } from "node:path";

export const PROXY_TOKEN_LABEL = "oma-vault-proxy-v1";
export const PROXY_AUTH_USERNAME = "metadata";
export const PROXY_TOKEN_TAG_PREFIX = "oma-session:";
const KEY_FILE_NAME = "proxy-token.key";
const ID_RE = /^[A-Za-z0-9_.:-]{1,200}$/;

export interface ProxySessionIdentity {
  tenantId: string;
  sessionId: string;
}

interface ProxyTokenPayload {
  v: 1;
  t: string;
  s: string;
  iat: number;
  exp?: number;
}

export type ProxyTokenVerifyResult =
  | { ok: true; identity: ProxySessionIdentity; issuedAt: number; expiresAt?: number }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" | "bad_payload" };

export type ProxyKeySource = "OMA_VAULT_PROXY_SECRET" | "PLATFORM_ROOT_SECRET" | "key_file";

export interface ResolvedProxyKey {
  key: Buffer;
  source: ProxyKeySource;
  /** Set when source === "key_file". */
  path?: string;
}

/** Derive the 32-byte HMAC key from a shared secret. */
export function deriveProxyTokenKey(secret: string | Uint8Array): Buffer {
  const ikm = typeof secret === "string" ? Buffer.from(secret, "utf8") : Buffer.from(secret);
  if (ikm.byteLength === 0) throw new Error("deriveProxyTokenKey: empty secret");
  return Buffer.from(hkdfSync("sha256", ikm, Buffer.alloc(0), PROXY_TOKEN_LABEL, 32));
}

export function signProxyToken(
  key: Uint8Array,
  identity: ProxySessionIdentity,
  opts?: { now?: number; ttlSec?: number },
): string {
  if (!ID_RE.test(identity.tenantId) || !ID_RE.test(identity.sessionId)) {
    throw new Error("signProxyToken: tenantId/sessionId contain unsupported characters");
  }
  const iat = Math.floor((opts?.now ?? Date.now()) / 1000);
  const payload: ProxyTokenPayload = { v: 1, t: identity.tenantId, s: identity.sessionId, iat };
  if (opts?.ttlSec && opts.ttlSec > 0) payload.exp = iat + Math.floor(opts.ttlSec);
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${payloadB64}.${mac(key, payloadB64)}`;
}

export function verifyProxyToken(
  key: Uint8Array,
  token: string,
  opts?: { now?: number },
): ProxyTokenVerifyResult {
  if (typeof token !== "string" || token.length > 4096) return { ok: false, reason: "malformed" };
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".") || dot === token.length - 1) {
    return { ok: false, reason: "malformed" };
  }
  const payloadB64 = token.slice(0, dot);
  const macB64 = token.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(payloadB64) || !/^[A-Za-z0-9_-]+$/.test(macB64)) {
    return { ok: false, reason: "malformed" };
  }
  const expected = Buffer.from(mac(key, payloadB64), "base64url");
  const given = Buffer.from(macB64, "base64url");
  if (given.byteLength !== expected.byteLength || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: "bad_signature" };
  }
  let payload: Partial<ProxyTokenPayload>;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as Partial<ProxyTokenPayload>;
  } catch {
    return { ok: false, reason: "bad_payload" };
  }
  if (
    payload.v !== 1 ||
    typeof payload.t !== "string" || !ID_RE.test(payload.t) ||
    typeof payload.s !== "string" || !ID_RE.test(payload.s) ||
    typeof payload.iat !== "number"
  ) {
    return { ok: false, reason: "bad_payload" };
  }
  if (payload.exp !== undefined) {
    if (typeof payload.exp !== "number") return { ok: false, reason: "bad_payload" };
    const nowSec = Math.floor((opts?.now ?? Date.now()) / 1000);
    if (nowSec >= payload.exp) return { ok: false, reason: "expired" };
  }
  return {
    ok: true,
    identity: { tenantId: payload.t, sessionId: payload.s },
    issuedAt: payload.iat,
    ...(payload.exp !== undefined ? { expiresAt: payload.exp } : {}),
  };
}

function mac(key: Uint8Array, payloadB64: string): string {
  return createHmac("sha256", key).update(payloadB64, "utf8").digest("base64url");
}

/** Default key-file path for the signer side: next to OMA_VAULT_CA_CERT. */
export function defaultProxyKeyFileForCaCert(caCertPath: string | undefined): string | undefined {
  return caCertPath ? join(dirname(caCertPath), KEY_FILE_NAME) : undefined;
}

/** Default key-file path for the verifier side: inside OMA_VAULT_CA_DIR. */
export function defaultProxyKeyFileForCaDir(caDir: string): string {
  return join(caDir, KEY_FILE_NAME);
}

/**
 * Resolve the proxy-token key from the environment.
 *
 * Priority: OMA_VAULT_PROXY_SECRET → PLATFORM_ROOT_SECRET → key file.
 * `createKeyFile: true` (oma-vault only) generates the key file when it is
 * missing; the signer never creates it (it would diverge from the vault's).
 * Returns null when no key source is available.
 */
export function resolveProxyTokenKey(opts: {
  env: Record<string, string | undefined>;
  keyFile?: string;
  createKeyFile?: boolean;
}): ResolvedProxyKey | null {
  const explicit = opts.env.OMA_VAULT_PROXY_SECRET?.trim();
  if (explicit) return { key: deriveProxyTokenKey(explicit), source: "OMA_VAULT_PROXY_SECRET" };
  const root = opts.env.PLATFORM_ROOT_SECRET?.trim();
  if (root) return { key: deriveProxyTokenKey(root), source: "PLATFORM_ROOT_SECRET" };
  const keyFile = opts.env.OMA_VAULT_PROXY_KEY_FILE?.trim() || opts.keyFile;
  if (!keyFile) return null;
  const existing = readKeyFile(keyFile);
  if (existing) return { key: existing, source: "key_file", path: keyFile };
  if (!opts.createKeyFile) return null;
  mkdirSync(dirname(keyFile), { recursive: true });
  try {
    // O_EXCL: when N vault replicas race on a shared volume exactly one
    // writes; the others fall through and read the winner's file.
    const fd = openSync(keyFile, "wx", 0o600);
    try {
      writeSync(fd, randomBytes(32).toString("base64url"));
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  const created = readKeyFile(keyFile);
  return created ? { key: created, source: "key_file", path: keyFile } : null;
}

function readKeyFile(path: string): Buffer | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
  if (raw.length < 32) return null;
  return deriveProxyTokenKey(raw);
}

/**
 * Encode a token as proxy credentials that mockttp (oma-vault's proxy
 * engine) surfaces to request handlers.
 *
 * mockttp strips `Proxy-Authorization` from the request it hands to
 * callbacks, and for HTTPS the header only exists on the CONNECT, not on
 * the tunnelled requests. The one channel it does preserve is "socket
 * metadata": username `metadata`, password = base64url(JSON) whose `tags`
 * array is exposed as `req.tags` entries prefixed `socket-metadata:` — for
 * both absolute-URL HTTP requests and every request inside a CONNECT tunnel.
 */
export function proxyAuthCredentials(token: string): { username: string; password: string } {
  const json = JSON.stringify({ tags: [`${PROXY_TOKEN_TAG_PREFIX}${token}`] });
  return {
    username: PROXY_AUTH_USERNAME,
    password: Buffer.from(json, "utf8").toString("base64url"),
  };
}

/**
 * Pull the session token(s) out of mockttp request tags. Returns:
 *   - { kind: "none" } when no token tag is present (anonymous traffic)
 *   - { kind: "token", token } for exactly one distinct token
 *   - { kind: "ambiguous" } when multiple distinct tokens are present
 */
export function extractProxyTokenFromTags(
  tags: readonly string[] | null | undefined,
): { kind: "none" } | { kind: "token"; token: string } | { kind: "ambiguous" } {
  const prefix = `socket-metadata:${PROXY_TOKEN_TAG_PREFIX}`;
  const found = new Set<string>();
  for (const tag of tags ?? []) {
    if (typeof tag === "string" && tag.startsWith(prefix)) found.add(tag.slice(prefix.length));
  }
  if (found.size === 0) return { kind: "none" };
  if (found.size > 1) return { kind: "ambiguous" };
  return { kind: "token", token: [...found][0] };
}
