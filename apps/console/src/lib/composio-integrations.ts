export interface ComposioIntegrationEntry {
  slug: string;
  name: string;
  category: string;
  description: string;
  domain: string;
  icon?: string;
}

export interface ComposioToolkitCatalogItem {
  slug: string;
  name?: string;
  auth_schemes?: string[];
  composio_managed_auth_schemes?: string[];
  no_auth?: boolean;
  meta?: {
    description?: string;
    logo?: string;
    app_url?: string;
    tools_count?: number;
    triggers_count?: number;
    categories?: Array<{ id?: string; name?: string }>;
  };
}

export interface ComposioToolkitCatalogResponse {
  items?: ComposioToolkitCatalogItem[];
  next_cursor?: string;
  total_items?: number;
}

export interface ComposioStatusResponse {
  configured: boolean;
  /** Where the active key came from: the tenant's own pasted key, the
   *  operator-level fallback, or null when unconfigured. */
  source?: "tenant" | "platform" | null;
  message?: string | null;
}

export const COMPOSIO_NOT_CONFIGURED_MESSAGE =
  "Composio isn't connected for this workspace yet — add your API key in Apps.";

function favicon(domain: string): string {
  return `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
}

function titleCaseSlug(slug: string): string {
  return slug
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function domainFromToolkit(toolkit: ComposioToolkitCatalogItem): string {
  const appUrl = toolkit.meta?.app_url;
  if (appUrl) {
    try {
      return new URL(appUrl).hostname.replace(/^www\./, "");
    } catch {
      // fall through
    }
  }
  return `${toolkit.slug.replace(/_/g, "")}.com`;
}

export const COMPOSIO_MANAGED_AGENT_INTEGRATIONS: ComposioIntegrationEntry[] = [
  {
    slug: "github",
    name: "GitHub",
    category: "Development",
    description: "Repositories, issues, pull requests, and code workflows.",
    domain: "github.com",
  },
  {
    slug: "linear",
    name: "Linear",
    category: "Development",
    description: "Issues, projects, comments, and engineering triage.",
    domain: "linear.app",
  },
  {
    slug: "jira",
    name: "Jira",
    category: "Development",
    description: "Issues, projects, epics, and release tracking.",
    domain: "atlassian.com",
  },
  {
    slug: "sentry",
    name: "Sentry",
    category: "Development",
    description: "Errors, traces, projects, and incident context.",
    domain: "sentry.io",
  },
  {
    slug: "slack",
    name: "Slack",
    category: "Communication",
    description: "Channels, messages, users, and team notifications.",
    domain: "slack.com",
  },
  {
    slug: "gmail",
    name: "Gmail",
    category: "Communication",
    description: "Email search, drafts, replies, and mailbox actions.",
    domain: "mail.google.com",
  },
  {
    slug: "microsoft_teams",
    name: "Microsoft Teams",
    category: "Communication",
    description: "Chats, channels, meetings, and workspace messages.",
    domain: "teams.microsoft.com",
  },
  {
    slug: "notion",
    name: "Notion",
    category: "Knowledge",
    description: "Pages, databases, docs, and internal knowledge bases.",
    domain: "notion.so",
  },
  {
    slug: "googledrive",
    name: "Google Drive",
    category: "Knowledge",
    description: "Drive files, folders, permissions, and document lookup.",
    domain: "drive.google.com",
  },
  {
    slug: "googledocs",
    name: "Google Docs",
    category: "Knowledge",
    description: "Docs, comments, document edits, and text extraction.",
    domain: "docs.google.com",
  },
  {
    slug: "googlesheets",
    name: "Google Sheets",
    category: "Knowledge",
    description: "Spreadsheets, ranges, formulas, and tabular data.",
    domain: "sheets.google.com",
  },
  {
    slug: "confluence",
    name: "Confluence",
    category: "Knowledge",
    description: "Spaces, pages, docs, and Atlassian knowledge content.",
    domain: "atlassian.com",
  },
  {
    slug: "asana",
    name: "Asana",
    category: "Tasks",
    description: "Tasks, projects, portfolios, and team planning.",
    domain: "asana.com",
  },
  {
    slug: "clickup",
    name: "ClickUp",
    category: "Tasks",
    description: "Tasks, spaces, docs, and project workflows.",
    domain: "clickup.com",
  },
  {
    slug: "trello",
    name: "Trello",
    category: "Tasks",
    description: "Boards, cards, lists, comments, and assignments.",
    domain: "trello.com",
  },
  {
    slug: "salesforce",
    name: "Salesforce",
    category: "Business",
    description: "Accounts, contacts, leads, opportunities, and cases.",
    domain: "salesforce.com",
  },
  {
    slug: "hubspot",
    name: "HubSpot",
    category: "Business",
    description: "CRM records, tickets, companies, and sales activity.",
    domain: "hubspot.com",
  },
  {
    slug: "zendesk",
    name: "Zendesk",
    category: "Business",
    description: "Support tickets, users, organizations, and replies.",
    domain: "zendesk.com",
  },
  {
    slug: "intercom",
    name: "Intercom",
    category: "Business",
    description: "Conversations, contacts, companies, and support inboxes.",
    domain: "intercom.com",
  },
  {
    slug: "stripe",
    name: "Stripe",
    category: "Business",
    description: "Customers, invoices, subscriptions, and payments.",
    domain: "stripe.com",
  },
  {
    slug: "airtable",
    name: "Airtable",
    category: "Data",
    description: "Bases, tables, records, and operational data.",
    domain: "airtable.com",
  },
  {
    slug: "supabase",
    name: "Supabase",
    category: "Data",
    description: "Projects, databases, auth, and storage operations.",
    domain: "supabase.com",
  },
  {
    slug: "shopify",
    name: "Shopify",
    category: "Commerce",
    description: "Products, orders, customers, and store operations.",
    domain: "shopify.com",
  },
  {
    slug: "dropbox",
    name: "Dropbox",
    category: "Files",
    description: "Files, folders, sharing, and document retrieval.",
    domain: "dropbox.com",
  },
];

export function composioIntegrationIcon(entry: Pick<ComposioIntegrationEntry, "domain" | "icon">): string {
  return typeof entry.icon === "string" && entry.icon
    ? entry.icon
    : favicon(entry.domain);
}

export function composioEntriesFromCatalog(
  catalog: ComposioToolkitCatalogResponse | null | undefined,
): ComposioIntegrationEntry[] {
  const dynamic = (catalog?.items ?? [])
    .filter((toolkit) => toolkit.slug)
    .map<ComposioIntegrationEntry>((toolkit) => ({
      slug: toolkit.slug.trim().toLowerCase(),
      name: toolkit.name || titleCaseSlug(toolkit.slug),
      category: toolkit.meta?.categories?.[0]?.name || "Apps",
      description:
        toolkit.meta?.description ||
        `${toolkit.name || titleCaseSlug(toolkit.slug)} tools through Composio.`,
      domain: domainFromToolkit(toolkit),
      icon: toolkit.meta?.logo,
    }));

  const bySlug = new Map<string, ComposioIntegrationEntry>();
  for (const entry of [...dynamic, ...COMPOSIO_MANAGED_AGENT_INTEGRATIONS]) {
    if (!bySlug.has(entry.slug)) bySlug.set(entry.slug, entry);
  }
  return [...bySlug.values()];
}

export function filterComposioEntries(
  entries: ComposioIntegrationEntry[],
  search: string,
): ComposioIntegrationEntry[] {
  const q = search.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter((entry) =>
    [entry.name, entry.slug, entry.category, entry.description]
      .join(" ")
      .toLowerCase()
      .includes(q),
  );
}
