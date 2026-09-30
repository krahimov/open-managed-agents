import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveProxyTokenKey,
  extractProxyTokenFromTags,
  proxyAuthCredentials,
  resolveProxyTokenKey,
  signProxyToken,
  verifyProxyToken,
} from "../src/proxy-token";

const key = deriveProxyTokenKey("root-secret-a");
const id = { tenantId: "tn_a", sessionId: "sess_1" };

function flipChar(s: string, i: number): string {
  const c = s[i] === "A" ? "B" : "A";
  return s.slice(0, i) + c + s.slice(i + 1);
}

describe("proxy token sign/verify", () => {
  it("round-trips a signed identity", () => {
    const token = signProxyToken(key, id);
    const r = verifyProxyToken(key, token);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.identity).toEqual(id);
  });

  it("rejects a tampered payload (swapped session id)", () => {
    const token = signProxyToken(key, id);
    const [, mac] = token.split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({ v: 1, t: "tn_a", s: "sess_victim", iat: Math.floor(Date.now() / 1000) }),
    ).toString("base64url");
    expect(verifyProxyToken(key, `${forgedPayload}.${mac}`)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a tampered MAC", () => {
    const token = signProxyToken(key, id);
    expect(verifyProxyToken(key, flipChar(token, token.length - 3)).ok).toBe(false);
  });

  it("rejects tokens signed with a different key (other deployment / root secret)", () => {
    const token = signProxyToken(deriveProxyTokenKey("root-secret-b"), id);
    expect(verifyProxyToken(key, token)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects the legacy unsigned base64(tenant|session) format", () => {
    const legacy = Buffer.from("tn_a|sess_1").toString("base64url");
    expect(verifyProxyToken(key, legacy)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyProxyToken(key, "").ok).toBe(false);
    expect(verifyProxyToken(key, "a.b.c").ok).toBe(false);
  });

  it("enforces expiry when a TTL is set", () => {
    const now = 1_700_000_000_000;
    const token = signProxyToken(key, id, { now, ttlSec: 60 });
    expect(verifyProxyToken(key, token, { now: now + 30_000 }).ok).toBe(true);
    expect(verifyProxyToken(key, token, { now: now + 61_000 })).toEqual({ ok: false, reason: "expired" });
  });

  it("domain-separates the key from the raw root secret", () => {
    expect(key.equals(Buffer.from("root-secret-a"))).toBe(false);
    expect(key.byteLength).toBe(32);
  });

  it("refuses to sign ids with separator / control characters", () => {
    expect(() => signProxyToken(key, { tenantId: "tn|x", sessionId: "s" })).toThrow();
  });
});

describe("proxy credentials transport", () => {
  it("encodes the token as mockttp socket metadata and extracts it from tags", () => {
    const token = signProxyToken(key, id);
    const { username, password } = proxyAuthCredentials(token);
    expect(username).toBe("metadata");
    expect(password.startsWith("e")).toBe(true); // mockttp's base64-JSON sniff
    const json = JSON.parse(Buffer.from(password, "base64url").toString("utf8")) as { tags: string[] };
    const tags = json.tags.map((t) => `socket-metadata:${t}`);
    expect(extractProxyTokenFromTags(tags)).toEqual({ kind: "token", token });
    expect(extractProxyTokenFromTags([])).toEqual({ kind: "none" });
    expect(
      extractProxyTokenFromTags([...tags, "socket-metadata:oma-session:other"]),
    ).toEqual({ kind: "ambiguous" });
  });
});

describe("resolveProxyTokenKey", () => {
  it("prefers OMA_VAULT_PROXY_SECRET, then PLATFORM_ROOT_SECRET", () => {
    const a = resolveProxyTokenKey({ env: { OMA_VAULT_PROXY_SECRET: "x", PLATFORM_ROOT_SECRET: "y" } });
    expect(a?.source).toBe("OMA_VAULT_PROXY_SECRET");
    const b = resolveProxyTokenKey({ env: { PLATFORM_ROOT_SECRET: "y" } });
    expect(b?.source).toBe("PLATFORM_ROOT_SECRET");
    expect(b?.key.equals(deriveProxyTokenKey("y"))).toBe(true);
    expect(resolveProxyTokenKey({ env: {} })).toBeNull();
  });

  it("verifier creates a 0600 key file the signer can then read", () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-proxy-key-"));
    const file = join(dir, "proxy-token.key");
    expect(resolveProxyTokenKey({ env: {}, keyFile: file })).toBeNull(); // signer never creates
    const vault = resolveProxyTokenKey({ env: {}, keyFile: file, createKeyFile: true });
    expect(vault?.source).toBe("key_file");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8").length).toBeGreaterThanOrEqual(32);
    const signer = resolveProxyTokenKey({ env: {}, keyFile: file });
    expect(signer?.key.equals(vault!.key)).toBe(true);
    const token = signProxyToken(signer!.key, id);
    expect(verifyProxyToken(vault!.key, token).ok).toBe(true);
  });
});
