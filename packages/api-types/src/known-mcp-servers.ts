// Known remote MCP servers — the one list both sides agree on.
//
// The setup agent gets it in its prompt so "connect Linear" maps straight to
// the vendor's official endpoint (no web search, no guessed URLs), the
// server canonicalizes update_harness patches against it (stable names,
// official URLs, no duplicates), and the console uses it to label connect
// cards ("Linear", with its icon) instead of echoing a raw slug.
//
// Only list endpoints that are verified to work with the platform's OAuth
// flow. Anything else is still reachable: the agent can web_search for the
// vendor's endpoint or fall back to request_access (Composio).

export interface KnownMcpServer {
  /** Canonical server name used on the harness (`mcp_servers[].name`). */
  id: string;
  /** Display name for cards and prompts. */
  name: string;
  /** Official remote MCP endpoint. */
  url: string;
  /** Lower-case words a user might say for this service. */
  aliases: string[];
  /** What the agent can do with it — one short line for the setup prompt. */
  summary: string;
  /** Domain used for the favicon on connect cards. */
  domain: string;
  /** Provider has no dynamic client registration: the first connection needs
   *  a one-time OAuth app (the connect card walks the user through it). */
  needsOAuthApp?: boolean;
}

export const KNOWN_MCP_SERVERS: readonly KnownMcpServer[] = [
  {
    id: "linear",
    name: "Linear",
    url: "https://mcp.linear.app/mcp",
    aliases: ["linear", "linear.app"],
    summary: "issues, projects, cycles, comments",
    domain: "linear.app",
  },
  {
    id: "slack",
    name: "Slack",
    url: "https://mcp.slack.com/mcp",
    aliases: ["slack"],
    summary: "read and post messages, search channels and threads",
    domain: "slack.com",
    needsOAuthApp: true,
  },
  {
    id: "github",
    name: "GitHub",
    url: "https://api.githubcopilot.com/mcp/",
    aliases: ["github", "gh"],
    summary: "repos, issues, pull requests, code search",
    domain: "github.com",
    needsOAuthApp: true,
  },
  {
    id: "notion",
    name: "Notion",
    url: "https://mcp.notion.com/mcp",
    aliases: ["notion"],
    summary: "pages, databases, docs search",
    domain: "notion.so",
  },
  {
    id: "sentry",
    name: "Sentry",
    url: "https://mcp.sentry.dev/mcp",
    aliases: ["sentry"],
    summary: "errors, issues, releases, performance",
    domain: "sentry.io",
  },
  {
    id: "atlassian",
    name: "Atlassian",
    url: "https://mcp.atlassian.com/v1/mcp",
    aliases: ["atlassian", "jira", "confluence"],
    summary: "Jira issues and Confluence pages",
    domain: "atlassian.com",
  },
  {
    id: "asana",
    name: "Asana",
    url: "https://mcp.asana.com/v2/mcp",
    aliases: ["asana"],
    summary: "tasks, projects, portfolios",
    domain: "asana.com",
  },
  {
    id: "airtable",
    name: "Airtable",
    url: "https://mcp.airtable.com/mcp",
    aliases: ["airtable"],
    summary: "bases, tables, records",
    domain: "airtable.com",
  },
];

function hostOf(raw: string): string | null {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** The known server an MCP URL points at (matched by host), if any. */
export function knownMcpServerForUrl(url: string | undefined | null): KnownMcpServer | undefined {
  const host = url ? hostOf(url) : null;
  if (!host) return undefined;
  return KNOWN_MCP_SERVERS.find((s) => hostOf(s.url) === host);
}

/** The known server a name/slug refers to ("Linear", "jira", "gh"), if any. */
export function knownMcpServerForName(name: string | undefined | null): KnownMcpServer | undefined {
  const slug = (name ?? "").trim().toLowerCase();
  if (!slug) return undefined;
  return KNOWN_MCP_SERVERS.find((s) => s.id === slug || s.aliases.includes(slug));
}

/** Human label for a service on a connect card: the known display name when
 *  the URL or slug matches one, else the slug with its first letter raised. */
export function serviceDisplayName(service: string | undefined | null, url?: string | null): string {
  const known = knownMcpServerForUrl(url) ?? knownMcpServerForName(service);
  if (known) return known.name;
  const s = (service ?? "").trim();
  if (!s) return "Service";
  return s.charAt(0).toUpperCase() + s.slice(1);
}
