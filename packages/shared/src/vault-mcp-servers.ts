// Vault credentials → session MCP servers.
//
// A session's MCP servers are the agent's declared `mcp_servers` plus any
// server an integration injects for that session. Vault credentials are
// used for AUTH ONLY: the MCP proxy matches a declared server's URL
// against the credentials in the session's vaults and injects the token.
//
// Before this, attaching a vault turned EVERY active MCP credential in it
// into a session server (pinned into agent_snapshot): an agent declaring
// only GitHub got Notion, Sentry, Railway and a Composio router on every
// turn — Notion alone is ~59k tokens of tool definitions per model call —
// under hostname-derived names ("mcp", "mcp_2", "api"). That inference is
// kept only behind the agent-level opt-in `_oma.vault_mcp_servers: "all"`.

import type { AgentConfig, VaultMcpServersMode } from "@open-managed-agents/api-types";

type McpServer = NonNullable<AgentConfig["mcp_servers"]>[number];

/** The slice of a vault credential this module reads — loose on purpose so
 *  both the route DTOs and the Node credential service rows fit. */
export interface VaultMcpCredentialLike {
  archived_at?: string | null;
  auth?: {
    type?: string;
    mcp_server_url?: string;
    composio_toolkits?: string[];
  } | null;
}

export type VaultMcpCredentialGroups = ReadonlyArray<{
  vault_id: string;
  credentials: ReadonlyArray<VaultMcpCredentialLike>;
}>;

/** The agent's mode; anything but an explicit "all" means "declared". */
export function vaultMcpServersMode(agent: { vault_mcp_servers?: unknown } | null | undefined): VaultMcpServersMode {
  return agent?.vault_mcp_servers === "all" ? "all" : "declared";
}

/** origin + path without trailing slashes; query/hash dropped. Null when
 *  `raw` isn't a URL. Same rule the CF MCP proxy matches credentials by. */
export function normalizeMcpServerUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    return `${url.origin}${path}`;
  } catch {
    return null;
  }
}

/** A Composio tool-router endpoint (per-session, generic sentinel, or the
 *  connect.composio.dev gateway). */
export function isComposioMcpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    const path = url.pathname.replace(/\/+$/, "");
    if (url.hostname === "connect.composio.dev" && path === "/mcp") return true;
    return (
      (url.hostname === "app.composio.dev" || url.hostname === "backend.composio.dev") &&
      path.includes("/tool_router/") &&
      path.endsWith("/mcp")
    );
  } catch {
    return false;
  }
}

/** The session-less tool-router base URL (only a name target, not servable). */
function isGenericComposioUrl(raw: string): boolean {
  const normalized = normalizeMcpServerUrl(raw);
  return normalized === "https://app.composio.dev/tool_router/v3/session/mcp";
}

function isMcpCredentialType(type: string | undefined): boolean {
  return type === "mcp_oauth" || type === "static_bearer" || type === "composio_mcp";
}

/**
 * Servers the vaults would add on top of `declared` under the legacy "all"
 * inference: one per active MCP credential whose URL isn't declared yet.
 * At most one Composio router — none when one is already declared (a
 * second router would duplicate every Composio tool), else the first
 * concrete per-session URL (the generic sentinel 301s as an upstream).
 */
export function inferVaultMcpServers(
  declared: ReadonlyArray<McpServer>,
  vaultCredentials: VaultMcpCredentialGroups,
): McpServer[] {
  const existingUrls = new Set(
    declared
      .map((server) => (typeof server.url === "string" ? normalizeMcpServerUrl(server.url) : null))
      .filter((url): url is string => Boolean(url)),
  );
  const usedNames = new Set(declared.map((server) => server.name).filter(Boolean));
  const composioDeclared = declared.some(
    (server) => typeof server.url === "string" && isComposioMcpUrl(server.url),
  );

  const candidates: Array<{ auth: NonNullable<VaultMcpCredentialLike["auth"]>; url: string }> = [];
  for (const vault of vaultCredentials) {
    for (const credential of vault.credentials) {
      if (credential.archived_at) continue;
      const auth = credential.auth;
      const url = auth?.mcp_server_url?.trim();
      if (!auth || !url || !isMcpCredentialType(auth.type)) continue;
      const normalizedUrl = normalizeMcpServerUrl(url);
      if (normalizedUrl && existingUrls.has(normalizedUrl)) continue;
      if (normalizedUrl) existingUrls.add(normalizedUrl);
      candidates.push({ auth, url });
    }
  }

  const composio = candidates.filter((c) => c.auth.type === "composio_mcp");
  const keptComposio = composioDeclared
    ? null
    : (composio.find((c) => !isGenericComposioUrl(c.url)) ?? composio[0] ?? null);

  const inferred: McpServer[] = [];
  for (const candidate of candidates) {
    if (candidate.auth.type === "composio_mcp" && candidate !== keptComposio) continue;
    inferred.push({
      name: uniqueMcpServerName(mcpServerNameBase(candidate.auth, candidate.url), usedNames),
      type: "url",
      url: candidate.url,
    });
  }
  return inferred;
}

/** What the session's vaults add to `agent`'s servers: nothing unless the
 *  agent opted into `vault_mcp_servers: "all"`. */
export function vaultMcpServersForAgent(
  agent: Pick<AgentConfig, "mcp_servers" | "vault_mcp_servers">,
  vaultCredentials: VaultMcpCredentialGroups,
): McpServer[] {
  if (vaultMcpServersMode(agent) !== "all") return [];
  return inferVaultMcpServers(agent.mcp_servers ?? [], vaultCredentials);
}

/** `agent` with its vault-contributed servers appended (identity when none). */
export function withVaultMcpServers<A extends Pick<AgentConfig, "mcp_servers" | "vault_mcp_servers">>(
  agent: A,
  vaultCredentials: VaultMcpCredentialGroups,
): A {
  const added = vaultMcpServersForAgent(agent, vaultCredentials);
  if (added.length === 0) return agent;
  return { ...agent, mcp_servers: [...(agent.mcp_servers ?? []), ...added] };
}

function mcpServerNameBase(auth: NonNullable<VaultMcpCredentialLike["auth"]>, url: string): string {
  if (auth.type === "composio_mcp") {
    const toolkits = Array.isArray(auth.composio_toolkits)
      ? auth.composio_toolkits
          .map((toolkit) => String(toolkit).toLowerCase().replace(/[^a-z0-9]+/g, "_"))
          .filter(Boolean)
      : [];
    return ["composio", ...toolkits.slice(0, 3)].join("_");
  }
  try {
    return new URL(url).hostname.split(".").filter(Boolean)[0] || "mcp";
  } catch {
    return "mcp";
  }
}

/** `base` cleaned to [a-z0-9_] (≤48 chars), suffixed _2, _3… until unused.
 *  Adds the result to `usedNames`. */
export function uniqueMcpServerName(base: string, usedNames: Set<string>): string {
  const cleanBase = (base || "mcp").toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "mcp";
  const trimmedBase = cleanBase.slice(0, 48);
  if (!usedNames.has(trimmedBase)) {
    usedNames.add(trimmedBase);
    return trimmedBase;
  }
  for (let i = 2; ; i++) {
    const suffix = `_${i}`;
    const candidate = `${trimmedBase.slice(0, 48 - suffix.length)}${suffix}`;
    if (!usedNames.has(candidate)) {
      usedNames.add(candidate);
      return candidate;
    }
  }
}
