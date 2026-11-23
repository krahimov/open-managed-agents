// Decides which connect card an agent's request_access gets — the routing
// half of postAccessRequest (index.ts), split out so it is unit-testable.
//
// Two dead ends this guards against (both seen live):
//  - A service with no MCP URL used to become a Composio card blindly. When
//    Composio has no such toolkit ("origami") the card could only fail, with
//    Composio's raw 404 JSON. Now the toolkit is checked first and no card is
//    posted; the agent is told how such a service can be connected instead.
//  - An MCP server that advertises OAuth but whose auth server has no Dynamic
//    Client Registration and no preset (Origami's Clerk) got an OAuth popup
//    that always ends in "OAuth client unavailable". Now it gets the API-key
//    card, which the proxy sends as `Authorization: Bearer <key>`.

import type { OAuthAppRequirement } from "./node-oauth-routes";

export type AccessAuthKind = "llm_provider" | "composio" | "mcp_oauth" | "mcp_api_key";

/** Model providers are keyed via Model Cards, not connectable apps — a
 *  request_access for one of these must not dead-end in a Composio 400
 *  (observed live: "connect openai" → code 306). */
export const LLM_PROVIDER_SLUGS = new Set([
  "openai", "anthropic", "google", "gemini", "google-gemini",
  "openrouter", "mistral", "groq", "xai", "deepseek",
]);

export interface AccessRouteDeps {
  probeMcpAuthKind(url: string): Promise<"mcp_oauth" | "mcp_api_key">;
  /** describeOAuthAppRequirement, already time-boxed by the caller; null
   *  when discovery failed or timed out. */
  describeOAuthApp(url: string): Promise<OAuthAppRequirement | null>;
  composioKey(): Promise<{ apiKey: string } | null>;
  /** Resolves the toolkit, null when Composio has none by that slug;
   *  throws on transient failures. */
  getComposioToolkit(apiKey: string, slug: string): Promise<{ slug: string } | null>;
}

export type AccessRoute =
  | {
      kind: "card";
      authKind: AccessAuthKind;
      mcpServerUrl?: string;
      /** Only for authKind "composio". */
      composioConfigured?: boolean;
      /** Only for authKind "mcp_oauth". */
      oauthApp?: OAuthAppRequirement | null;
    }
  | { kind: "unsupported"; reason: "composio_toolkit_not_found" };

export async function resolveAccessRoute(
  service: string,
  mcpServerUrl: string | undefined,
  deps: AccessRouteDeps,
): Promise<AccessRoute> {
  if (LLM_PROVIDER_SLUGS.has(service)) return { kind: "card", authKind: "llm_provider" };

  if (mcpServerUrl) {
    const probed = await deps.probeMcpAuthKind(mcpServerUrl);
    if (probed === "mcp_api_key") return { kind: "card", authKind: "mcp_api_key", mcpServerUrl };
    const oauthApp = await deps.describeOAuthApp(mcpServerUrl).catch(() => null);
    // Only an explicit "no way to get a client" downgrades; a failed or
    // timed-out discovery keeps the OAuth card rather than guessing.
    if (oauthApp?.no_client_registration) {
      return { kind: "card", authKind: "mcp_api_key", mcpServerUrl };
    }
    return { kind: "card", authKind: "mcp_oauth", mcpServerUrl, oauthApp };
  }

  const key = await deps.composioKey().catch(() => null);
  if (key) {
    // Unknown → null; network trouble → undefined, which keeps the old
    // behaviour (post the card) instead of blocking a real app on a blip.
    const toolkit = await deps.getComposioToolkit(key.apiKey, service).catch(() => undefined);
    if (toolkit === null) return { kind: "unsupported", reason: "composio_toolkit_not_found" };
  }
  return { kind: "card", authKind: "composio", composioConfigured: !!key };
}

type McpServerLike = { name?: string; type?: string; url?: string };

/**
 * Find the agent's own URL MCP server a request_access names, so the card
 * runs against that server instead of the Composio flow. Exact name first
 * (the setup flow names servers after the service); otherwise the ONE
 * server whose name or hostname has the slug as a whole token — so
 * "origami" finds a server named "origami-mcp" or hosted on origami.chat,
 * while "git" does not match "github".
 */
export function matchMcpServerUrl(
  servers: McpServerLike[] | null | undefined,
  service: string,
): string | undefined {
  const slug = service.trim().toLowerCase();
  if (!slug) return undefined;
  const candidates = (servers ?? []).filter((s) => !!s?.url && s.type !== "stdio");
  const exact = candidates.find((s) => s.name?.trim().toLowerCase() === slug);
  if (exact) return exact.url;
  const tokens = (s: McpServerLike): string[] => {
    let host = "";
    try {
      host = new URL(s.url!).hostname;
    } catch {
      // unparseable URL: name tokens only
    }
    return [...(s.name ?? "").toLowerCase().split(/[^a-z0-9]+/), ...host.toLowerCase().split(".")];
  };
  const hits = candidates.filter((s) => tokens(s).includes(slug));
  return hits.length === 1 ? hits[0].url : undefined;
}

/** What the agent is told when no card could be posted. */
export function unsupportedAccessNote(service: string): string {
  return (
    `No connect card was posted: "${service}" isn't available as a one-click app connection (Composio has no "${service}" integration). ` +
    `If ${service} has a hosted MCP server, it must be added to this agent as an MCP server — in a setup session, find the server URL (web_search) and add it with update_harness; the platform then posts the right sign-in or API-key card automatically. ` +
    `Otherwise tell the user ${service} can't be connected here yet. Never ask for API keys or passwords in the conversation.`
  );
}
