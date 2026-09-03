import { describe, expect, it } from "vitest";
import {
  buildNodeMcpForwardUrl,
  forwardNodeMcpRequest,
  forwardNodeMcpRequestWithRefresh,
  verifyMcpCredential,
} from "../src/lib/node-mcp-proxy";

describe("node MCP proxy", () => {
  it("preserves query strings on exact MCP endpoint requests", () => {
    expect(
      buildNodeMcpForwardUrl(
        {
          upstreamUrl: "https://backend.composio.dev/tool_router/trs_123/mcp",
          declaredServerUrl: "https://backend.composio.dev/tool_router/trs_123/mcp",
        },
        "https://backend.composio.dev/tool_router/trs_123/mcp?cursor=abc",
      ),
    ).toBe("https://backend.composio.dev/tool_router/trs_123/mcp?cursor=abc");
  });

  it("preserves subpaths when a credential rewrites generic Composio to a session URL", () => {
    expect(
      buildNodeMcpForwardUrl(
        {
          upstreamUrl: "https://backend.composio.dev/tool_router/trs_123/mcp",
          declaredServerUrl: "https://backend.composio.dev/tool_router/v3/session/mcp",
        },
        "https://backend.composio.dev/tool_router/v3/session/mcp/messages?cursor=abc",
      ),
    ).toBe("https://backend.composio.dev/tool_router/trs_123/mcp/messages?cursor=abc");
  });

  it("strips caller auth headers and injects the vault auth header", async () => {
    let forwarded: Request | null = null;
    const fetcher: typeof fetch = async (request) => {
      forwarded = request instanceof Request ? request : new Request(request);
      return new Response("ok");
    };

    await forwardNodeMcpRequest(
      {
        upstreamUrl: "https://backend.composio.dev/tool_router/trs_123/mcp",
        upstreamToken: "cmp_project_key",
        upstreamAuthHeader: { name: "x-api-key", value: "cmp_project_key" },
        declaredServerUrl: "https://backend.composio.dev/tool_router/trs_123/mcp",
      },
      "https://backend.composio.dev/tool_router/trs_123/mcp?cursor=abc",
      "POST",
      new Headers({
        authorization: "Bearer placeholder",
        "x-api-key": "placeholder",
        "content-type": "application/json",
      }),
      JSON.stringify({ jsonrpc: "2.0" }),
      fetcher,
    );

    expect(forwarded?.url).toBe("https://backend.composio.dev/tool_router/trs_123/mcp?cursor=abc");
    expect(forwarded?.headers.get("authorization")).toBeNull();
    expect(forwarded?.headers.get("x-api-key")).toBe("cmp_project_key");
    expect(forwarded?.headers.get("content-type")).toBe("application/json");
  });

  describe("token refresh", () => {
    const target = {
      upstreamUrl: "https://mcp.sentry.dev/mcp",
      upstreamToken: "stale",
    };
    const refreshDeps = (persisted: unknown[]) => ({
      refreshToken: "rt-1",
      tokenEndpoint: "https://mcp.sentry.dev/oauth/token",
      clientId: "client-1",
      persist: async (t: unknown) => {
        persisted.push(t);
      },
    });
    const fakeFetch = (
      log: Array<{ url: string; auth: string | null; body?: string }>,
      upstream: (auth: string | null) => Response,
    ): typeof fetch =>
      (async (input, init) => {
        const req = input instanceof Request ? input : new Request(input, init);
        const auth = req.headers.get("authorization");
        const body = req.method === "POST" ? await req.text() : undefined;
        log.push({ url: req.url, auth, body });
        if (req.url.endsWith("/oauth/token")) {
          return Response.json({ access_token: "fresh", refresh_token: "rt-2", expires_in: 3600 });
        }
        return upstream(auth);
      }) as typeof fetch;

    it("refreshes on 401 and retries once with the same body, persisting rotated tokens", async () => {
      const log: Array<{ url: string; auth: string | null; body?: string }> = [];
      const persisted: unknown[] = [];
      const fetcher = fakeFetch(log, (auth) =>
        auth === "Bearer fresh" ? new Response("ok") : new Response("nope", { status: 401 }),
      );
      const res = await forwardNodeMcpRequestWithRefresh(
        { ...target, refresh: refreshDeps(persisted) },
        undefined,
        "POST",
        new Headers({ "content-type": "application/json" }),
        '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
        fetcher,
      );
      expect(res.status).toBe(200);
      expect(log.map((l) => l.auth)).toEqual(["Bearer stale", null, "Bearer fresh"]);
      expect(log[1].url).toBe("https://mcp.sentry.dev/oauth/token");
      expect(log[1].body).toContain("grant_type=refresh_token");
      expect(log[1].body).toContain("refresh_token=rt-1");
      expect(log[1].body).toContain("client_id=client-1");
      expect(log[1].body).not.toContain("client_secret");
      expect(log[2].body).toBe('{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
      expect(persisted).toEqual([{ access_token: "fresh", refresh_token: "rt-2", expires_in: 3600 }]);
    });

    it("refreshes pre-emptively when the stored expiry is within the skew window", async () => {
      const log: Array<{ url: string; auth: string | null }> = [];
      const persisted: unknown[] = [];
      const fetcher = fakeFetch(log, (auth) =>
        auth === "Bearer fresh" ? new Response("ok") : new Response("nope", { status: 401 }),
      );
      const now = 1_000_000;
      const res = await forwardNodeMcpRequestWithRefresh(
        { ...target, refresh: { ...refreshDeps(persisted), expiresAtMs: now + 30_000 } },
        undefined,
        "POST",
        new Headers(),
        "{}",
        fetcher,
        () => now,
      );
      expect(res.status).toBe(200);
      // token endpoint first, then exactly one upstream call with the new token
      expect(log.map((l) => l.auth)).toEqual([null, "Bearer fresh"]);
    });

    it("surfaces the upstream 401 when the refresh itself fails", async () => {
      const log: Array<{ url: string; auth: string | null }> = [];
      const fetcher: typeof fetch = (async (input, init) => {
        const req = input instanceof Request ? input : new Request(input, init);
        log.push({ url: req.url, auth: req.headers.get("authorization") });
        if (req.url.endsWith("/oauth/token")) return new Response("bad", { status: 400 });
        return new Response("unauthorized", { status: 401 });
      }) as typeof fetch;
      const res = await forwardNodeMcpRequestWithRefresh(
        { ...target, refresh: refreshDeps([]) },
        undefined,
        "POST",
        new Headers(),
        "{}",
        fetcher,
      );
      expect(res.status).toBe(401);
      expect(log.map((l) => l.auth)).toEqual(["Bearer stale", null, "Bearer stale"]);
    });

    it("passes through untouched when the credential has no refresh metadata", async () => {
      const log: string[] = [];
      const fetcher: typeof fetch = (async (input, init) => {
        const req = input instanceof Request ? input : new Request(input, init);
        log.push(req.url);
        return new Response("unauthorized", { status: 401 });
      }) as typeof fetch;
      const res = await forwardNodeMcpRequestWithRefresh(target, undefined, "POST", new Headers(), "{}", fetcher);
      expect(res.status).toBe(401);
      expect(log).toEqual(["https://mcp.sentry.dev/mcp"]);
    });
  });

  describe("verifyMcpCredential", () => {
    const url = "https://mcp.linear.app/mcp";
    const mk = (upstream: (auth: string | null) => Response, tokenOk = true) => {
      const log: Array<string | null> = [];
      const fetcher: typeof fetch = (async (input, init) => {
        const req = input instanceof Request ? input : new Request(input, init);
        if (req.url.endsWith("/oauth/token")) {
          log.push("refresh");
          return tokenOk
            ? Response.json({ access_token: "fresh", refresh_token: "rt2", expires_in: 3600 })
            : new Response("bad", { status: 400 });
        }
        const auth = req.headers.get("authorization");
        log.push(auth);
        return upstream(auth);
      }) as typeof fetch;
      return { fetcher, log };
    };
    const refresh = (persisted: unknown[]) => ({
      refreshToken: "rt",
      tokenEndpoint: "https://mcp.linear.app/oauth/token",
      persist: async (t: unknown) => void persisted.push(t),
    });

    it("ok when the stored token is accepted (any non-auth status counts)", async () => {
      const a = mk(() => new Response("{}", { status: 200 }));
      expect(await verifyMcpCredential({ url, token: "t" }, a.fetcher)).toBe("ok");
      const b = mk(() => new Response("bad request", { status: 400 }));
      expect(await verifyMcpCredential({ url, token: "t" }, b.fetcher)).toBe("ok");
    });

    it("refreshes an expired token, persists it and re-probes", async () => {
      const persisted: unknown[] = [];
      const { fetcher, log } = mk((auth) =>
        auth === "Bearer fresh" ? new Response("{}") : new Response("nope", { status: 401 }),
      );
      expect(await verifyMcpCredential({ url, token: "stale", refresh: refresh(persisted) }, fetcher)).toBe(
        "refreshed",
      );
      expect(log).toEqual(["Bearer stale", "refresh", "Bearer fresh"]);
      expect(persisted).toEqual([{ access_token: "fresh", refresh_token: "rt2", expires_in: 3600 }]);
    });

    it("invalid when rejected and no refresh is possible, or refresh fails", async () => {
      const a = mk(() => new Response("nope", { status: 401 }));
      expect(await verifyMcpCredential({ url, token: "stale" }, a.fetcher)).toBe("invalid");
      const b = mk(() => new Response("nope", { status: 401 }), false);
      expect(await verifyMcpCredential({ url, token: "stale", refresh: refresh([]) }, b.fetcher)).toBe("invalid");
    });

    it("unreachable on network failure", async () => {
      const fetcher: typeof fetch = (async () => {
        throw new Error("ECONNRESET");
      }) as typeof fetch;
      expect(await verifyMcpCredential({ url, token: "t" }, fetcher)).toBe("unreachable");
    });
  });
});
