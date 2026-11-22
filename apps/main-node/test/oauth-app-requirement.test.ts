// describeOAuthAppRequirement must flag issuers the /authorize route can't
// get a client for (no Dynamic Client Registration, no preset) so access
// requests fall back to an API key instead of a popup that always fails.

import { afterEach, describe, expect, it, vi } from "vitest";
import { describeOAuthAppRequirement } from "../src/lib/node-oauth-routes";

function stubDiscovery(authServer: string, asMeta: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/.well-known/oauth-protected-resource")) {
        return Response.json({ resource: "https://mcp.example/mcp", authorization_servers: [authServer] });
      }
      if (url.startsWith(authServer) && url.includes("/.well-known/oauth-authorization-server")) {
        return Response.json({ issuer: authServer, ...asMeta });
      }
      return new Response("not found", { status: 404 });
    }),
  );
}

const input = (over: { env?: Record<string, string> } = {}) => ({
  deps: { services: { kv: { get: async () => null } } as never, env: over.env ?? {} },
  tenantId: "tn_test",
  mcpServerUrl: "https://mcp.example/mcp",
  baseUrl: "https://orrery.example",
});

const endpoints = {
  authorization_endpoint: "https://auth.example/authorize",
  token_endpoint: "https://auth.example/token",
};

afterEach(() => vi.unstubAllGlobals());

describe("describeOAuthAppRequirement — client registration", () => {
  it("flags an issuer with no DCR and no preset (Origami's Clerk)", async () => {
    stubDiscovery("https://clerk.origami.chat", endpoints);
    const req = await describeOAuthAppRequirement(input());
    expect(req).toMatchObject({ required: false, no_client_registration: true });
  });

  it("does not flag an issuer that offers DCR", async () => {
    stubDiscovery("https://auth.example", { ...endpoints, registration_endpoint: "https://auth.example/register" });
    const req = await describeOAuthAppRequirement(input());
    expect(req?.required).toBe(false);
    expect(req?.no_client_registration).toBeUndefined();
  });

  it("does not flag preset providers — they get guided app setup instead", async () => {
    stubDiscovery("https://slack.com", endpoints);
    const req = await describeOAuthAppRequirement(input());
    expect(req).toMatchObject({ required: true, label: "Slack" });
    expect(req?.no_client_registration).toBeUndefined();
  });
});
