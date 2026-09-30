// Egress policy — shared, runtime-agnostic evaluation of an environment's
// `networking` block. Used by:
//   - apps/agent/src/oma-sandbox.ts (CF outbound handler: every container
//     HTTP(S) request passes through it)
//   - apps/oma-vault (self-host MITM proxy: every proxied sandbox request)
//
// Semantics (aligned with the Anthropic Managed Agents environment config):
//   networking.type === "unrestricted" (or absent) → no host restriction
//   networking.type === "limited"                   → deny by default; allow:
//     - allowed_hosts entries (exact host, or any subdomain of it;
//       "*.example.com" matches subdomains only)
//     - allow_mcp_servers === true   → hosts of the agent's mcp_servers[].url
//     - allow_package_managers === true → the public package registries in
//       PACKAGE_MANAGER_HOSTS
//
// Pure functions only (no DNS, no node:* imports) so this is safe to bundle
// into Workers. Private-address (SSRF) checks that need DNS live in the Node
// proxy; `isPrivateOrReservedIp` below is the pure classification half.

export interface NetworkingConfigLike {
  type?: string;
  allowed_hosts?: string[] | null;
  allow_mcp_servers?: boolean | null;
  allow_package_managers?: boolean | null;
}

export interface EgressPolicy {
  /** Normalized host patterns. Leading "." means "subdomains only". */
  allowedHosts: string[];
}

/** Public package registries allowed when `allow_package_managers` is true. */
export const PACKAGE_MANAGER_HOSTS: readonly string[] = [
  // Python
  "pypi.org",
  "files.pythonhosted.org",
  "pypi.python.org",
  // Node
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "registry.npmmirror.com",
  // Rust
  "crates.io",
  "index.crates.io",
  "static.crates.io",
  "static.rust-lang.org",
  // Ruby
  "rubygems.org",
  "index.rubygems.org",
  // Go
  "proxy.golang.org",
  "sum.golang.org",
  // Java
  "repo.maven.apache.org",
  "repo1.maven.org",
  // apt / apk
  "deb.debian.org",
  "security.debian.org",
  "archive.ubuntu.com",
  "security.ubuntu.com",
  "ports.ubuntu.com",
  "dl-cdn.alpinelinux.org",
];

/**
 * Normalize a host pattern: strips scheme / path / port / trailing dot,
 * lowercases. "*.example.com" → ".example.com" (subdomains only).
 * Returns null for empty / unparseable input.
 */
export function normalizeHostPattern(raw: string): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim().toLowerCase();
  if (!s) return null;
  let wildcard = false;
  if (s.startsWith("*.")) {
    wildcard = true;
    s = s.slice(2);
  }
  if (s.includes("://")) {
    try {
      s = new URL(s).hostname;
    } catch {
      return null;
    }
  } else {
    s = s.split("/")[0];
    // Strip :port (but keep bracketed IPv6 intact).
    if (s.startsWith("[")) {
      const end = s.indexOf("]");
      s = end > 0 ? s.slice(1, end) : s;
    } else if ((s.match(/:/g) ?? []).length === 1) {
      s = s.split(":")[0];
    }
  }
  s = s.replace(/\.$/, "");
  if (!s) return null;
  return wildcard ? `.${s}` : s;
}

/**
 * Build the effective policy for an environment. Returns null when the
 * environment is unrestricted (no egress filtering).
 */
export function resolveEgressPolicy(
  networking: NetworkingConfigLike | null | undefined,
  opts?: { mcpServerUrls?: Array<string | null | undefined> },
): EgressPolicy | null {
  if (!networking || networking.type !== "limited") return null;
  const hosts = new Set<string>();
  for (const h of networking.allowed_hosts ?? []) {
    const n = normalizeHostPattern(h);
    if (n) hosts.add(n);
  }
  if (networking.allow_package_managers === true) {
    for (const h of PACKAGE_MANAGER_HOSTS) hosts.add(h);
  }
  if (networking.allow_mcp_servers === true) {
    for (const u of opts?.mcpServerUrls ?? []) {
      if (!u) continue;
      const n = normalizeHostPattern(u);
      if (n) hosts.add(n.replace(/^\./, ""));
    }
  }
  return { allowedHosts: [...hosts] };
}

/** True when `hostname` is permitted by `policy` (null policy = allow all). */
export function isHostAllowedByEgress(
  hostname: string,
  policy: EgressPolicy | null | undefined,
): boolean {
  if (!policy) return true;
  const host = normalizeHostPattern(hostname);
  if (!host || host.startsWith(".")) return false;
  for (const pattern of policy.allowedHosts) {
    if (pattern.startsWith(".")) {
      if (host.endsWith(pattern)) return true;
    } else if (host === pattern || host.endsWith(`.${pattern}`)) {
      return true;
    }
  }
  return false;
}

/**
 * Classify an IP literal as private / loopback / link-local / reserved /
 * cloud-metadata. Used to block SSRF into the operator's network from
 * proxied sandbox traffic. Returns false for anything that isn't an IP
 * literal (callers resolve DNS first).
 */
export function isPrivateOrReservedIp(ip: string): boolean {
  let addr = ip.trim().toLowerCase();
  if (addr.startsWith("[") && addr.endsWith("]")) addr = addr.slice(1, -1);
  const zone = addr.indexOf("%");
  if (zone >= 0) addr = addr.slice(0, zone);

  const v4 = parseIpv4(addr);
  if (v4) return isPrivateIpv4(v4);

  const v6 = parseIpv6(addr);
  if (!v6) return false;
  // IPv4-mapped (::ffff:a.b.c.d) / IPv4-compatible (::a.b.c.d)
  const allZeroPrefix = v6.slice(0, 5).every((w) => w === 0);
  if (allZeroPrefix && (v6[5] === 0xffff || v6[5] === 0) && !(v6[5] === 0 && v6[6] === 0)) {
    return isPrivateIpv4([v6[6] >> 8, v6[6] & 0xff, v6[7] >> 8, v6[7] & 0xff]);
  }
  if (v6.every((w) => w === 0)) return true; // ::
  if (v6.slice(0, 7).every((w) => w === 0) && v6[7] === 1) return true; // ::1
  const first = v6[0];
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (first === 0x0064 && v6[1] === 0xff9b) {
    // 64:ff9b::/96 NAT64 — classify the embedded IPv4
    return isPrivateIpv4([v6[6] >> 8, v6[6] & 0xff, v6[7] >> 8, v6[7] & 0xff]);
  }
  if (first === 0x2001 && v6[1] === 0x0db8) return true; // documentation
  // 2002::/16 6to4 — classify embedded IPv4
  if (first === 0x2002) {
    return isPrivateIpv4([v6[1] >> 8, v6[1] & 0xff, v6[2] >> 8, v6[2] & 0xff]);
  }
  // AWS IMDS IPv6 endpoint fd00:ec2::254 is already covered by fc00::/7.
  return false;
}

function isPrivateIpv4([a, b, c]: number[]): boolean {
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10 (incl. Alibaba metadata 100.100.100.200)
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0/24 IETF
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

function parseIpv4(s: string): number[] | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

function parseIpv6(s: string): number[] | null {
  if (!s.includes(":")) return null;
  let head = s;
  let tailV4: number[] | null = null;
  const lastColon = s.lastIndexOf(":");
  const maybeV4 = s.slice(lastColon + 1);
  if (maybeV4.includes(".")) {
    tailV4 = parseIpv4(maybeV4);
    if (!tailV4) return null;
    head = s.slice(0, lastColon + 1) + "0:0";
  }
  const dbl = head.split("::");
  if (dbl.length > 2) return null;
  const parseGroups = (g: string): number[] | null => {
    if (!g) return [];
    const out: number[] = [];
    for (const part of g.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
      out.push(parseInt(part, 16));
    }
    return out;
  };
  const left = parseGroups(dbl[0]);
  const right = dbl.length === 2 ? parseGroups(dbl[1]) : [];
  if (!left || !right) return null;
  let words: number[];
  if (dbl.length === 2) {
    const fill = 8 - left.length - right.length;
    if (fill < 0) return null;
    words = [...left, ...new Array(fill).fill(0), ...right];
  } else {
    words = left;
  }
  if (words.length !== 8) return null;
  if (tailV4) {
    words[6] = (tailV4[0] << 8) | tailV4[1];
    words[7] = (tailV4[2] << 8) | tailV4[3];
  }
  return words;
}
