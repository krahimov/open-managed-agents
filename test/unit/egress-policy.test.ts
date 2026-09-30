// Shared egress policy (packages/shared/src/egress.ts) + the CF container
// outbound handler's enforcement hook (apps/agent/src/oma-sandbox.ts).
import { describe, expect, it } from "vitest";
import {
  isHostAllowedByEgress,
  isPrivateOrReservedIp,
  normalizeHostPattern,
  resolveEgressPolicy,
} from "@open-managed-agents/shared";
import { egressDenial } from "../../apps/agent/src/oma-sandbox";

describe("resolveEgressPolicy", () => {
  it("is null for unrestricted / missing networking", () => {
    expect(resolveEgressPolicy(undefined)).toBeNull();
    expect(resolveEgressPolicy({ type: "unrestricted", allowed_hosts: ["x.com"] })).toBeNull();
  });

  it("normalizes allowed_hosts and adds opt-in MCP / package hosts", () => {
    const p = resolveEgressPolicy(
      {
        type: "limited",
        allowed_hosts: ["HTTPS://API.GitHub.com/path", "example.org:443", "*.corp.dev"],
        allow_mcp_servers: true,
        allow_package_managers: false,
      },
      { mcpServerUrls: ["https://mcp.linear.app/sse", null] },
    );
    expect(p?.allowedHosts).toEqual(["api.github.com", "example.org", ".corp.dev", "mcp.linear.app"]);
  });

  it("limited with nothing allowed denies everything", () => {
    const p = resolveEgressPolicy({ type: "limited" });
    expect(isHostAllowedByEgress("example.com", p)).toBe(false);
  });
});

describe("isHostAllowedByEgress", () => {
  const p = resolveEgressPolicy({ type: "limited", allowed_hosts: ["github.com", "*.example.org"] });
  it("matches exact hosts and subdomains, not look-alikes", () => {
    expect(isHostAllowedByEgress("github.com", p)).toBe(true);
    expect(isHostAllowedByEgress("codeload.github.com", p)).toBe(true);
    expect(isHostAllowedByEgress("GITHUB.COM.", p)).toBe(true);
    expect(isHostAllowedByEgress("evilgithub.com", p)).toBe(false);
    expect(isHostAllowedByEgress("github.com.evil.io", p)).toBe(false);
    expect(isHostAllowedByEgress("a.example.org", p)).toBe(true);
    expect(isHostAllowedByEgress("example.org", p)).toBe(false);
  });
  it("null policy allows all", () => {
    expect(isHostAllowedByEgress("anything.io", null)).toBe(true);
  });
  it("normalizeHostPattern rejects empties", () => {
    expect(normalizeHostPattern("  ")).toBeNull();
  });
});

describe("isPrivateOrReservedIp", () => {
  it("classifies private / reserved ranges", () => {
    for (const ip of [
      "127.0.0.1", "10.2.3.4", "172.16.0.1", "172.31.255.255", "192.168.0.1", "169.254.169.254",
      "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fc00::1", "fd00:ec2::254", "fe80::1",
      "::ffff:10.0.0.1", "::ffff:7f00:1", "64:ff9b::a9fe:a9fe", "[::1]",
    ]) {
      expect(isPrivateOrReservedIp(ip), ip).toBe(true);
    }
  });
  it("allows public addresses and ignores hostnames", () => {
    for (const ip of ["8.8.8.8", "172.32.0.1", "93.184.216.34", "2606:4700::1111", "::ffff:8.8.8.8", "example.com"]) {
      expect(isPrivateOrReservedIp(ip), ip).toBe(false);
    }
  });
});

describe("CF outbound handler egressDenial", () => {
  const params = {
    tenantId: "tn",
    sessionId: "sess",
    egress: resolveEgressPolicy({ type: "limited", allowed_hosts: ["api.github.com"] }),
  };
  it("returns 403 for hosts outside allowed_hosts (e.g. bash curl)", async () => {
    const res = egressDenial(new URL("https://evil.example/x"), params);
    expect(res?.status).toBe(403);
    expect(await res!.text()).toContain("evil.example");
  });
  it("lets allowed hosts and unrestricted sessions through", () => {
    expect(egressDenial(new URL("https://api.github.com/user"), params)).toBeNull();
    expect(egressDenial(new URL("https://evil.example/"), { tenantId: "tn", sessionId: "s" })).toBeNull();
  });
});
