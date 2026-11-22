// resolveAccessRoute decides which connect card request_access posts.
// Regression: request_access("origami") used to become a Composio card that
// could only fail with Composio's raw 404, and Origami's MCP server (OAuth
// without client registration) would have got a popup that always fails.

import { describe, expect, it, vi } from "vitest";
import {
  matchMcpServerUrl,
  resolveAccessRoute,
  unsupportedAccessNote,
  type AccessRouteDeps,
} from "../src/lib/access-request-route";
import type { OAuthAppRequirement } from "../src/lib/node-oauth-routes";

function deps(over: Partial<AccessRouteDeps> = {}): AccessRouteDeps {
  return {
    probeMcpAuthKind: vi.fn(async () => "mcp_oauth" as const),
    describeOAuthApp: vi.fn(async () => null),
    composioKey: vi.fn(async () => ({ apiKey: "cmp_key" })),
    getComposioToolkit: vi.fn(async (_key: string, slug: string) => ({ slug })),
    ...over,
  };
}

const app = (over: Partial<OAuthAppRequirement> = {}): OAuthAppRequirement => ({
  required: false,
  configured: true,
  label: "clerk.origami.chat",
  issuer: "https://clerk.origami.chat",
  callback_uri: "https://orrery.example/v1/oauth/callback",
  env: { client_id: "", client_secret: "" },
  setup_steps: [],
  ...over,
});

describe("resolveAccessRoute — Composio apps", () => {
  it("posts no card when Composio has no toolkit for the service", async () => {
    const d = deps({ getComposioToolkit: vi.fn(async () => null) });
    expect(await resolveAccessRoute("origami", undefined, d)).toEqual({
      kind: "unsupported",
      reason: "composio_toolkit_not_found",
    });
    expect(d.getComposioToolkit).toHaveBeenCalledWith("cmp_key", "origami");
  });

  it("keeps the Composio card for a toolkit Composio has", async () => {
    expect(await resolveAccessRoute("gmail", undefined, deps())).toEqual({
      kind: "card",
      authKind: "composio",
      composioConfigured: true,
    });
  });

  it("still posts the Composio card when the toolkit check fails transiently", async () => {
    const d = deps({
      getComposioToolkit: vi.fn(async () => {
        throw new Error("Composio API timeout after 5000ms");
      }),
    });
    expect(await resolveAccessRoute("gmail", undefined, d)).toMatchObject({
      kind: "card",
      authKind: "composio",
      composioConfigured: true,
    });
  });

  it("without a Composio key, skips the check and guides the user to connect Composio", async () => {
    const d = deps({ composioKey: vi.fn(async () => null) });
    expect(await resolveAccessRoute("origami", undefined, d)).toEqual({
      kind: "card",
      authKind: "composio",
      composioConfigured: false,
    });
    expect(d.getComposioToolkit).not.toHaveBeenCalled();
  });

  it("routes model providers to Model Cards without asking Composio", async () => {
    const d = deps();
    expect(await resolveAccessRoute("openai", undefined, d)).toEqual({
      kind: "card",
      authKind: "llm_provider",
    });
    expect(d.composioKey).not.toHaveBeenCalled();
  });
});

describe("resolveAccessRoute — MCP servers", () => {
  const URL = "https://origami.chat/mcp";

  it("asks for an API key when the OAuth server offers no client registration and no preset", async () => {
    const d = deps({ describeOAuthApp: vi.fn(async () => app({ no_client_registration: true })) });
    expect(await resolveAccessRoute("origami", URL, d)).toEqual({
      kind: "card",
      authKind: "mcp_api_key",
      mcpServerUrl: URL,
    });
    expect(d.composioKey).not.toHaveBeenCalled();
  });

  it("keeps the OAuth card when the server supports client registration", async () => {
    const req = app();
    const d = deps({ describeOAuthApp: vi.fn(async () => req) });
    expect(await resolveAccessRoute("linear", URL, d)).toEqual({
      kind: "card",
      authKind: "mcp_oauth",
      mcpServerUrl: URL,
      oauthApp: req,
    });
  });

  it("keeps the OAuth card (with guided app setup) for preset providers", async () => {
    const req = app({ required: true, configured: false, label: "Slack" });
    const d = deps({ describeOAuthApp: vi.fn(async () => req) });
    expect(await resolveAccessRoute("slack", URL, d)).toMatchObject({
      authKind: "mcp_oauth",
      oauthApp: req,
    });
  });

  it("keeps the OAuth card when discovery failed or timed out", async () => {
    expect(await resolveAccessRoute("origami", URL, deps())).toMatchObject({
      authKind: "mcp_oauth",
      oauthApp: null,
    });
    const throwing = deps({
      describeOAuthApp: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    expect(await resolveAccessRoute("origami", URL, throwing)).toMatchObject({
      authKind: "mcp_oauth",
    });
  });

  it("uses the API-key card when the server doesn't advertise OAuth at all", async () => {
    const d = deps({ probeMcpAuthKind: vi.fn(async () => "mcp_api_key" as const) });
    expect(await resolveAccessRoute("retell", URL, d)).toEqual({
      kind: "card",
      authKind: "mcp_api_key",
      mcpServerUrl: URL,
    });
    expect(d.describeOAuthApp).not.toHaveBeenCalled();
  });
});

describe("unsupportedAccessNote", () => {
  it("tells the agent how to connect the service instead, without asking for keys in chat", () => {
    const note = unsupportedAccessNote("origami");
    expect(note).toContain("No connect card was posted");
    expect(note).toContain("update_harness");
    expect(note).toContain("Never ask for API keys");
  });
});

describe("matchMcpServerUrl", () => {
  const origami = { name: "origami-mcp", type: "url", url: "https://origami.chat/mcp" };
  const github = { name: "github", type: "url", url: "https://api.githubcopilot.com/mcp/" };

  it("prefers an exact server name", () => {
    expect(matchMcpServerUrl([origami, github], "GitHub")).toBe(github.url);
  });

  it("finds a server by a whole token of its name or hostname", () => {
    expect(matchMcpServerUrl([origami, github], "origami")).toBe(origami.url);
    expect(matchMcpServerUrl([{ name: "Lead finder", type: "url", url: "https://mcp.origami.chat" }], "origami")).toBe("https://mcp.origami.chat");
  });

  it("does not match partial words, stdio servers, or ambiguous hits", () => {
    expect(matchMcpServerUrl([github], "git")).toBeUndefined();
    expect(matchMcpServerUrl([{ name: "origami", type: "stdio", url: "https://origami.chat/mcp" }], "origami")).toBeUndefined();
    expect(matchMcpServerUrl([origami, { name: "origami autopilot", type: "url", url: "https://origami.chat/mcp/autopilot" }], "origami")).toBeUndefined();
    expect(matchMcpServerUrl(undefined, "origami")).toBeUndefined();
  });
});
