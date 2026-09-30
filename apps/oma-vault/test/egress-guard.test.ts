import { describe, expect, it } from "vitest";
import type { LookupAddress } from "node:dns";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { resolveEgressPolicy } from "@open-managed-agents/shared";
import {
  checkEgressPolicy,
  checkPrivateDestination,
  createGuardedLookup,
  EgressBlockedError,
  forwardUpstream,
} from "../src/egress-guard";

const blockPrivate = { allowPrivate: false, privateAllowlist: new Set<string>() };
const resolverFor =
  (map: Record<string, string[]>) =>
  async (host: string): Promise<LookupAddress[]> => {
    const addrs = map[host];
    if (!addrs) throw new Error(`ENOTFOUND ${host}`);
    return addrs.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };

describe("environment egress policy", () => {
  const policy = resolveEgressPolicy({ type: "limited", allowed_hosts: ["github.com", "*.example.org"] });

  it("allows listed hosts and their subdomains", () => {
    expect(checkEgressPolicy("https://github.com/x", policy).allowed).toBe(true);
    expect(checkEgressPolicy("https://api.github.com/x", policy).allowed).toBe(true);
    expect(checkEgressPolicy("https://a.example.org/", policy).allowed).toBe(true);
  });

  it("denies everything else", () => {
    expect(checkEgressPolicy("https://evil.com/", policy).allowed).toBe(false);
    expect(checkEgressPolicy("https://github.com.evil.com/", policy).allowed).toBe(false);
    expect(checkEgressPolicy("https://example.org/", policy).allowed).toBe(false); // *.x = subdomains only
  });

  it("unrestricted environments allow all", () => {
    expect(checkEgressPolicy("https://evil.com/", resolveEgressPolicy({ type: "unrestricted" })).allowed).toBe(true);
  });

  it("package-manager hosts only when allow_package_managers is true", () => {
    const off = resolveEgressPolicy({ type: "limited", allowed_hosts: [] });
    const on = resolveEgressPolicy({ type: "limited", allowed_hosts: [], allow_package_managers: true });
    expect(checkEgressPolicy("https://pypi.org/simple/", off).allowed).toBe(false);
    expect(checkEgressPolicy("https://pypi.org/simple/", on).allowed).toBe(true);
    expect(checkEgressPolicy("https://registry.npmjs.org/x", on).allowed).toBe(true);
  });
});

describe("SSRF / private destination guard", () => {
  it("blocks private, loopback, link-local and metadata IP literals", async () => {
    for (const url of [
      "http://127.0.0.1:8787/v1/sessions",
      "http://10.0.0.5/",
      "http://172.20.1.1/",
      "http://192.168.1.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://100.100.100.200/",
      "http://0.0.0.0/",
      "http://[::1]/",
      "http://[fd00:ec2::254]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[fe80::1]/",
    ]) {
      expect((await checkPrivateDestination(url, blockPrivate)).allowed, url).toBe(false);
    }
  });

  it("allows public IP literals", async () => {
    expect((await checkPrivateDestination("https://1.1.1.1/", blockPrivate)).allowed).toBe(true);
    expect((await checkPrivateDestination("https://[2606:4700::1111]/", blockPrivate)).allowed).toBe(true);
  });

  it("blocks hostnames that resolve to private addresses (incl. any one of many)", async () => {
    const resolver = resolverFor({
      "internal.corp": ["10.1.2.3"],
      "oma-server": ["172.18.0.3"],
      "mixed.example.com": ["93.184.216.34", "127.0.0.1"],
      "public.example.com": ["93.184.216.34"],
    });
    expect((await checkPrivateDestination("https://internal.corp/", blockPrivate, resolver)).allowed).toBe(false);
    expect((await checkPrivateDestination("http://oma-server:8787/", blockPrivate, resolver)).allowed).toBe(false);
    expect((await checkPrivateDestination("https://mixed.example.com/", blockPrivate, resolver)).allowed).toBe(false);
    expect((await checkPrivateDestination("https://public.example.com/", blockPrivate, resolver)).allowed).toBe(true);
  });

  it("honours the explicit allowlist and the global opt-out", async () => {
    const resolver = resolverFor({ "mcp.internal": ["10.0.0.9"] });
    const allowlisted = { allowPrivate: false, privateAllowlist: new Set(["mcp.internal"]) };
    expect((await checkPrivateDestination("http://mcp.internal/", allowlisted, resolver)).allowed).toBe(true);
    expect(
      (await checkPrivateDestination("http://10.0.0.9/", { allowPrivate: true, privateAllowlist: new Set() }, resolver))
        .allowed,
    ).toBe(true);
  });

  it("guarded lookup refuses to connect to a private address at dial time", async () => {
    const server = http.createServer((_req, res) => res.end("secret-internal"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const { port } = server.address() as AddressInfo;
    try {
      await expect(
        forwardUpstream({
          url: `http://localhost:${port}/`,
          method: "GET",
          headers: {},
          body: null,
          lookup: createGuardedLookup(blockPrivate),
        }),
      ).rejects.toBeInstanceOf(EgressBlockedError);

      const ok = await forwardUpstream({
        url: `http://localhost:${port}/`,
        method: "GET",
        headers: {},
        body: null,
        lookup: createGuardedLookup({ allowPrivate: false, privateAllowlist: new Set(["localhost"]) }),
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.body.toString()).toBe("secret-internal");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
