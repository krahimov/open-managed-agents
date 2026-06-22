import { describe, expect, it } from "vitest";
import { buildNodeMcpForwardUrl, forwardNodeMcpRequest } from "../src/lib/node-mcp-proxy";

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
});
