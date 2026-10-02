// Shared egress policy (packages/shared/src/egress.ts) + the CF container
// outbound handler's enforcement hook (apps/agent/src/oma-sandbox.ts).
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isHostAllowedByEgress,
  isPrivateOrReservedIp,
  normalizeHostPattern,
  resolveEgressPolicy,
} from "@open-managed-agents/shared";
import {
  OmaSandbox,
  egressDenial,
  isPlatformR2Request,
  platformR2Scope,
  r2EgressDenial,
} from "../../apps/agent/src/oma-sandbox";

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

// QA F1: the static `*.r2.cloudflarestorage.com` passthrough used to skip
// the egress policy for every R2 account. Only the platform's own
// account + buckets may bypass it now.
describe("CF outbound R2 scoping", () => {
  const ACCOUNT = "0123456789abcdef0123456789abcdef";
  const env = {
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
    R2_ENDPOINT: `https://${ACCOUNT}.r2.cloudflarestorage.com`,
    BACKUP_BUCKET_NAME: "managed-agents-backups",
    MEMORY_BUCKET_NAME: "managed-agents-memory",
    WORKSPACE_BUCKET_NAME: "managed-agents-workspace",
  };
  const scope = platformR2Scope(env);
  const denyAll = { tenantId: "tn", sessionId: "s", egress: resolveEgressPolicy({ type: "limited", allowed_hosts: [] }) };
  const unrestricted = { tenantId: "tn", sessionId: "s", egress: null };
  const backupUrl = new URL(`https://${ACCOUNT}.r2.cloudflarestorage.com/managed-agents-backups/backups/b1.sqsh?X-Amz-Signature=x`);
  const foreignUrl = new URL("https://attackeraccount.r2.cloudflarestorage.com/loot/exfil.tar?X-Amz-Signature=y");

  afterEach(() => vi.restoreAllMocks());

  it("derives the platform account host and buckets from configuration", () => {
    expect([...scope.hosts]).toEqual([`${ACCOUNT}.r2.cloudflarestorage.com`]);
    expect(scope.buckets).toEqual(new Set([
      "managed-agents-backups", "managed-agents-memory", "managed-agents-workspace", "managed-agents-files",
    ]));
    expect(platformR2Scope({}).hosts.size).toBe(0);
    expect(platformR2Scope({ R2_ENDPOINT: "https://minio.local:9000" }).hosts.size).toBe(0);
  });

  it("recognizes path-style and virtual-hosted platform bucket URLs only", () => {
    expect(isPlatformR2Request(backupUrl, scope)).toBe(true);
    expect(isPlatformR2Request(new URL(`https://managed-agents-memory.${ACCOUNT}.r2.cloudflarestorage.com/t/x`), scope)).toBe(true);
    expect(isPlatformR2Request(new URL(`https://${ACCOUNT}.r2.cloudflarestorage.com/managed-agents-files/t/out.txt`), scope)).toBe(true);
    // other accounts, other buckets on our account, the account root, look-alikes
    expect(isPlatformR2Request(foreignUrl, scope)).toBe(false);
    expect(isPlatformR2Request(new URL("https://attackeraccount.r2.cloudflarestorage.com/managed-agents-backups/x"), scope)).toBe(false);
    expect(isPlatformR2Request(new URL(`https://${ACCOUNT}.r2.cloudflarestorage.com/someone-elses-bucket/x`), scope)).toBe(false);
    expect(isPlatformR2Request(new URL(`https://${ACCOUNT}.r2.cloudflarestorage.com/`), scope)).toBe(false);
    expect(isPlatformR2Request(new URL(`https://evil.managed-agents-memory.${ACCOUNT}.r2.cloudflarestorage.com/x`), scope)).toBe(false);
    expect(isPlatformR2Request(new URL(`https://x${ACCOUNT}.r2.cloudflarestorage.com/managed-agents-backups/x`), scope)).toBe(false);
    // unconfigured platform: nothing is exempt
    expect(isPlatformR2Request(backupUrl, platformR2Scope({}))).toBe(false);
  });

  it("applies the session policy to non-platform R2 and fails closed without one", async () => {
    expect(r2EgressDenial(backupUrl, env, denyAll)).toBeNull();
    expect(r2EgressDenial(backupUrl, env, undefined)).toBeNull();
    const denied = r2EgressDenial(foreignUrl, env, denyAll);
    expect(denied?.status).toBe(403);
    expect(await denied!.text()).toContain("attackeraccount.r2.cloudflarestorage.com");
    expect(r2EgressDenial(foreignUrl, env, unrestricted)).toBeNull();
    expect(r2EgressDenial(foreignUrl, env, undefined)?.status).toBe(403);
    expect(r2EgressDenial(foreignUrl, env, { tenantId: "tn", sessionId: "s" })?.status).toBe(403);
    const allowR2 = { tenantId: "tn", sessionId: "s", egress: resolveEgressPolicy({ type: "limited", allowed_hosts: ["attackeraccount.r2.cloudflarestorage.com"] }) };
    expect(r2EgressDenial(foreignUrl, env, allowR2)).toBeNull();
  });

  it("wires the static and runtime R2 handlers through the policy", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("ok"));
    const cls = OmaSandbox as unknown as {
      outboundByHost: Record<string, (r: Request, e: unknown, c: unknown) => Promise<Response>>;
      outboundHandlers: Record<string, (r: Request, e: unknown, c: unknown) => Promise<Response>>;
    };
    const staticHandler = cls.outboundByHost["*.r2.cloudflarestorage.com"];
    const runtimeHandler = cls.outboundHandlers.r2_storage;
    const put = (url: URL) => new Request(url, { method: "PUT", body: "data" });
    const ctx = (params: unknown) => ({ containerId: "c", className: "OmaSandbox", params });

    // Before the session context is bound: platform storage only.
    expect((await staticHandler(put(foreignUrl), env, ctx(undefined))).status).toBe(403);
    expect((await staticHandler(put(backupUrl), env, ctx(undefined))).status).toBe(200);
    // Bound with a deny-all limited policy: still no exfil to other accounts.
    expect((await runtimeHandler(put(foreignUrl), env, ctx(denyAll))).status).toBe(403);
    expect((await runtimeHandler(put(backupUrl), env, ctx(denyAll))).status).toBe(200);
    // Unrestricted sessions keep reaching arbitrary R2.
    expect((await runtimeHandler(put(foreignUrl), env, ctx(unrestricted))).status).toBe(200);
    const forwarded = fetchSpy.mock.calls.map(([r]) => new URL((r as Request).url).hostname);
    expect(forwarded).toEqual([backupUrl.hostname, backupUrl.hostname, foreignUrl.hostname]);
  });

  it("binds the R2 host handler with the session params when the catch-all is bound", async () => {
    // @cloudflare/sandbox is stubbed in this pool (test/sandbox-stub.ts), so
    // give the parent class the SDK's setOutboundHandler for the duration
    // and check OmaSandbox forwards the same params to the R2 host binding.
    const parent = Object.getPrototypeOf(OmaSandbox.prototype) as Record<string, unknown>;
    const catchAll = vi.fn(async () => {});
    parent.setOutboundHandler = catchAll;
    try {
      const byHost = vi.fn(async () => {});
      const fake = Object.assign(Object.create(OmaSandbox.prototype), {
        setOutboundByHost: byHost,
      }) as InstanceType<typeof OmaSandbox>;
      await fake.setOutboundHandler("inject_vault_creds", denyAll);
      expect(catchAll).toHaveBeenCalledWith("inject_vault_creds", denyAll);
      expect(byHost).toHaveBeenCalledWith("*.r2.cloudflarestorage.com", "r2_storage", denyAll);
      byHost.mockClear();
      await fake.setOutboundHandler("github_auth", denyAll);
      expect(byHost).not.toHaveBeenCalled();
    } finally {
      delete parent.setOutboundHandler;
    }
  });
});
