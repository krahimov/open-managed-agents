// Egress enforcement for oma-vault proxied traffic.
//
// Two independent checks:
//   1. Environment policy — `networking: { type: "limited", ... }` on the
//      session's environment (shared evaluation in
//      @open-managed-agents/shared egress.ts).
//   2. SSRF guard — by default refuse destinations that resolve to private /
//      loopback / link-local / metadata / reserved addresses, so a sandbox
//      can't use the proxy to reach the operator's internal network, the
//      oma-server admin surface, or 169.254.169.254. The check runs at
//      connect time via a custom `lookup`, so the address that was checked is
//      the address we connect to (no DNS-rebinding window).
//
// Upstream forwarding uses node:http / node:https (not fetch) precisely so
// the guarded lookup can be installed on the socket.

import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { isIP, type LookupFunction } from "node:net";
import http from "node:http";
import https from "node:https";
import { isHostAllowedByEgress, isPrivateOrReservedIp, type EgressPolicy } from "@open-managed-agents/shared";

export interface PrivateEgressOptions {
  /** OMA_VAULT_ALLOW_PRIVATE_EGRESS=1 disables the SSRF guard entirely. */
  allowPrivate: boolean;
  /** Hostnames (exact, lowercase) exempt from the SSRF guard, e.g. an MCP
   *  server on the docker network. OMA_VAULT_PRIVATE_EGRESS_ALLOWLIST. */
  privateAllowlist: ReadonlySet<string>;
}

export type EgressDecision = { allowed: true } | { allowed: false; reason: string };

export class EgressBlockedError extends Error {
  readonly code = "EOMA_EGRESS_BLOCKED";
  constructor(message: string) {
    super(message);
  }
}

/** Environment allow-list check. null policy = unrestricted. */
export function checkEgressPolicy(url: string, policy: EgressPolicy | null): EgressDecision {
  if (!policy) return { allowed: true };
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return { allowed: false, reason: "invalid URL" };
  }
  if (isHostAllowedByEgress(hostname, policy)) return { allowed: true };
  return {
    allowed: false,
    reason: `host "${hostname}" is not in this environment's allowed_hosts (networking: limited)`,
  };
}

export function isPrivateExempt(hostname: string, opts: PrivateEgressOptions): boolean {
  return opts.allowPrivate || opts.privateAllowlist.has(hostname.toLowerCase().replace(/\.$/, ""));
}

type Resolver = (hostname: string) => Promise<LookupAddress[]>;

const defaultResolver: Resolver = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses);
    });
  });

/**
 * Pre-flight SSRF check (gives a clean 403 before we try to connect). The
 * connect-time guarded lookup below re-checks whatever address is actually
 * dialled.
 */
export async function checkPrivateDestination(
  url: string,
  opts: PrivateEgressOptions,
  resolver: Resolver = defaultResolver,
): Promise<EgressDecision> {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return { allowed: false, reason: "invalid URL" };
  }
  const bare = hostname.replace(/^\[|\]$/g, "");
  if (isPrivateExempt(bare, opts)) return { allowed: true };
  if (isIP(bare)) {
    return isPrivateOrReservedIp(bare)
      ? { allowed: false, reason: `destination ${bare} is a private/reserved address` }
      : { allowed: true };
  }
  let addresses: LookupAddress[];
  try {
    addresses = await resolver(bare);
  } catch (err) {
    return { allowed: false, reason: `DNS lookup failed for ${bare}: ${(err as Error).message}` };
  }
  const bad = addresses.find((a) => isPrivateOrReservedIp(a.address));
  if (bad) {
    return { allowed: false, reason: `host ${bare} resolves to private/reserved address ${bad.address}` };
  }
  return { allowed: true };
}

/** `lookup` for net/tls sockets that refuses private/reserved results. */
export function createGuardedLookup(opts: PrivateEgressOptions): LookupFunction {
  return ((hostname: string, options: { all?: boolean; family?: number }, callback: (...args: unknown[]) => void) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err);
      const list = addresses as LookupAddress[];
      if (!isPrivateExempt(hostname, opts)) {
        const bad = list.find((a) => isPrivateOrReservedIp(a.address));
        if (bad) {
          return callback(new EgressBlockedError(`host ${hostname} resolves to private/reserved address ${bad.address}`));
        }
      }
      if (list.length === 0) return callback(new Error(`no addresses for ${hostname}`));
      if (options?.all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  }) as unknown as LookupFunction;
}

const HOP_BY_HOP_RESPONSE = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "proxy-authenticate",
  "proxy-connection",
  "trailer",
  "upgrade",
  "content-length",
]);

export interface UpstreamResponse {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: Buffer;
}

/** Forward to upstream over node:http(s) with the guarded lookup installed. */
export function forwardUpstream(opts: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Buffer | null;
  lookup: LookupFunction;
  timeoutMs?: number;
}): Promise<UpstreamResponse> {
  const target = new URL(opts.url);
  const mod = target.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      opts.url,
      {
        method: opts.method,
        headers: opts.headers,
        lookup: opts.lookup,
        // No connection reuse across requests: every request re-runs the
        // guarded lookup.
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("error", reject);
        res.on("end", () => {
          const headers: Record<string, string | string[]> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (v === undefined || HOP_BY_HOP_RESPONSE.has(k.toLowerCase())) continue;
            headers[k] = v;
          }
          resolve({ statusCode: res.statusCode ?? 502, headers, body: Buffer.concat(chunks) });
        });
      },
    );
    req.setTimeout(opts.timeoutMs ?? 300_000, () => {
      req.destroy(new Error(`upstream timed out after ${opts.timeoutMs ?? 300_000}ms`));
    });
    req.on("error", reject);
    if (opts.body && opts.body.byteLength > 0) req.end(opts.body);
    else req.end();
  });
}
