import type { ComponentType } from "react";
import { KeyRoundIcon, LayoutGridIcon, PlugIcon, SquareTerminalIcon } from "lucide-react";

import { useApiQuery } from "@/lib/useApiQuery";

/**
 * Vault + credential model and display helpers, shared by the Vaults
 * list, the vault record and the add-credential dialog.
 *
 * A credential's secret never comes back from the API. What does come
 * back is safe to show: its name, its kind, the server or CLI it is for,
 * and (for some kinds) a public identifier such as an access key id.
 */
export interface Vault {
  id: string;
  name: string;
  created_at: string;
  updated_at?: string | null;
  archived_at?: string | null;
}

export interface Credential {
  id: string;
  display_name: string;
  vault_id: string;
  auth: {
    type: string;
    mcp_server_url?: string;
    cli_id?: string;
    /** OAuth: when the current access token expires. */
    expires_at?: string | null;
    token_endpoint?: string;
    client_id?: string;
    /** Non-secret extras stored next to a CLI token (e.g. AWS access key id). */
    extras?: Record<string, unknown>;
  };
  created_at: string;
  updated_at?: string | null;
  archived_at?: string | null;
}

/** The vault the product creates on its own to hold app connections. */
export const CONNECTED_APPS_VAULT = "Connected Apps";
export function isConnectedAppsVault(vault: Pick<Vault, "name"> | null | undefined): boolean {
  return vault?.name === CONNECTED_APPS_VAULT;
}

/** First-wave CLI list. Mirrors @open-managed-agents/cap builtinSpecs. */
export const CAP_CLIS: ReadonlyArray<{ cli_id: string; label: string; helper: string; oauth?: boolean }> = [
  { cli_id: "gh", label: "GitHub CLI (gh)", helper: "Personal access token (ghp_...)", oauth: true },
  { cli_id: "glab", label: "GitLab CLI (glab)", helper: "Personal access token (glpat-...)", oauth: true },
  { cli_id: "az", label: "Azure CLI (az)", helper: "ARM access token", oauth: true },
  { cli_id: "gcloud", label: "Google Cloud SDK", helper: "OAuth access token", oauth: true },
  { cli_id: "fly", label: "Fly.io (fly / flyctl)", helper: "Fly API token (fo1_...)" },
  { cli_id: "vercel", label: "Vercel CLI", helper: "Account access token" },
  { cli_id: "doctl", label: "DigitalOcean (doctl)", helper: "API token (dop_v1_...)" },
  { cli_id: "heroku", label: "Heroku CLI", helper: "API token (heroku auth:token)" },
  { cli_id: "cf", label: "Cloudflare (cf / wrangler)", helper: "API token (CLOUDFLARE_API_TOKEN)" },
  { cli_id: "npm", label: "npm registry", helper: "Granular access token (npm_...)" },
  { cli_id: "aws", label: "AWS CLI / SDKs", helper: "AWS secret access key" },
  { cli_id: "kubectl", label: "kubectl", helper: "Bearer token for the API server" },
  { cli_id: "docker", label: "Docker registry", helper: "Registry password / PAT" },
  { cli_id: "git", label: "git (HTTPS remotes)", helper: "Personal access token" },
];

export type CredentialGroup = "mcp" | "cli" | "apps";

export interface CredentialKind {
  /** How the secret is held: "OAuth", "Bearer token", "CLI token", "Composio". */
  label: string;
  /** What kind of thing it unlocks, for counting: MCP servers, CLIs, app sessions. */
  group: CredentialGroup;
  icon: ComponentType<{ className?: string }>;
  /** One sentence on how the secret behaves, for tooltips. */
  about: string;
}

export function credentialKind(cred: Pick<Credential, "auth">): CredentialKind {
  switch (cred.auth.type) {
    case "mcp_oauth":
      return {
        label: "OAuth",
        group: "mcp",
        icon: PlugIcon,
        about: "Signed in with OAuth. The access token refreshes on its own.",
      };
    case "cap_cli":
      return {
        label: "CLI token",
        group: "cli",
        icon: SquareTerminalIcon,
        about: "A token injected when the agent runs this command-line tool.",
      };
    case "composio_mcp":
      return {
        label: "Composio",
        group: "apps",
        icon: LayoutGridIcon,
        about: "A Composio session that carries the app connections you authorised.",
      };
    case "static_bearer":
      return {
        label: "Bearer token",
        group: "mcp",
        icon: PlugIcon,
        about: "A fixed token sent to the MCP server. It does not refresh.",
      };
    default:
      return { label: "Secret", group: "mcp", icon: KeyRoundIcon, about: "A stored secret." };
  }
}

/** Where a credential points: an MCP host, or the CLI it is for. */
export function credentialTarget(cred: Pick<Credential, "auth">): { text: string; full?: string; mono: boolean } {
  const url = cred.auth.mcp_server_url;
  if (url) {
    try {
      return { text: new URL(url).host, full: url, mono: true };
    } catch {
      return { text: url, full: url, mono: true };
    }
  }
  const cli = cred.auth.cli_id;
  if (cli) {
    const known = CAP_CLIS.find((c) => c.cli_id === cli);
    return { text: known?.label ?? cli, mono: false };
  }
  if (cred.auth.type === "composio_mcp") return { text: "Composio tool router", mono: false };
  return { text: "Not set", mono: false };
}

const GROUP_NOUN: Record<CredentialGroup, [string, string]> = {
  mcp: ["MCP server", "MCP servers"],
  cli: ["CLI", "CLIs"],
  apps: ["app session", "app sessions"],
};

/** "3 MCP servers · 2 CLIs" for the active credentials of a vault. */
export function credentialBreakdown(creds: Credential[]): Array<{ group: CredentialGroup; count: number; label: string }> {
  const counts = new Map<CredentialGroup, number>();
  for (const c of creds) {
    if (c.archived_at) continue;
    const g = credentialKind(c).group;
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  return (["mcp", "cli", "apps"] as const)
    .filter((g) => counts.has(g))
    .map((g) => {
      const count = counts.get(g)!;
      return { group: g, count, label: `${count} ${GROUP_NOUN[g][count === 1 ? 0 : 1]}` };
    });
}

/** A vault's credentials. Shares its cache entry between the list rows and the record page. */
export function useVaultCredentials(vaultId: string | null | undefined) {
  const query = useApiQuery<{ data: Credential[] }>(vaultId ? `/v1/vaults/${vaultId}/credentials` : null);
  return { ...query, credentials: query.data?.data };
}
