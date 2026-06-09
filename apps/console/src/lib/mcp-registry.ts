export interface McpRegistryEntry {
  id: string;
  name: string;
  url: string;
  icon?: string;
}

export const MCP_REGISTRY: McpRegistryEntry[] = [
  {
    id: "composio",
    name: "Composio Tool Router",
    url: "https://app.composio.dev/tool_router/v3/session/mcp",
    icon: "https://www.google.com/s2/favicons?domain=composio.dev&sz=64",
  },
  {
    id: "airtable",
    name: "Airtable",
    url: "https://mcp.airtable.com/mcp",
    icon: "https://www.google.com/s2/favicons?domain=airtable.com&sz=64",
  },
  {
    id: "asana",
    name: "Asana",
    url: "https://mcp.asana.com/v2/mcp",
    icon: "https://www.google.com/s2/favicons?domain=asana.com&sz=64",
  },
  {
    id: "atlassian",
    name: "Atlassian",
    url: "https://mcp.atlassian.com/v1/mcp",
    icon: "https://www.google.com/s2/favicons?domain=atlassian.com&sz=64",
  },
  {
    id: "linear",
    name: "Linear",
    url: "https://mcp.linear.app/mcp",
    icon: "https://www.google.com/s2/favicons?domain=linear.app&sz=64",
  },
  {
    id: "github",
    name: "GitHub",
    url: "https://api.githubcopilot.com/mcp/",
    icon: "https://www.google.com/s2/favicons?domain=github.com&sz=64",
  },
  {
    id: "notion",
    name: "Notion",
    url: "https://mcp.notion.com/mcp",
    icon: "https://www.google.com/s2/favicons?domain=notion.so&sz=64",
  },
  {
    id: "sentry",
    name: "Sentry",
    url: "https://mcp.sentry.dev/mcp",
    icon: "https://www.google.com/s2/favicons?domain=sentry.io&sz=64",
  },
  {
    id: "slack",
    name: "Slack",
    url: "https://mcp.slack.com/mcp",
    icon: "https://www.google.com/s2/favicons?domain=slack.com&sz=64",
  },
];
