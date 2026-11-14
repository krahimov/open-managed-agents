import type { ComponentType, ReactNode } from "react";

import { MCP_REGISTRY } from "@/lib/mcp-registry";
import { cn } from "@/lib/utils";

import { GitHubIcon, LinearIcon, SlackIcon } from "../../../components/icons";
import type { AgentRecord } from "../../../types/agent";

/**
 * Shared pieces of the agent profile's tabs: the row used inside flush
 * cards, and readers that turn an agent's raw config into things a person
 * can scan (tool policy, app names).
 */

/** One row in a `<SectionCard flush>` list: mark, name, secondary line, trailing facts. */
export function ListRow({
  leading,
  title,
  description,
  trailing,
  children,
  className,
}: {
  leading?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  trailing?: ReactNode;
  /** Extra content under the text (override chips, a disclosure). */
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-start gap-3 border-t border-border px-5 py-3 first:border-t-0", className)}>
      {leading && <div className="shrink-0">{leading}</div>}
      <div className="min-w-0 flex-1 self-center">
        <div className="truncate text-small leading-5 font-medium text-fg">{title}</div>
        {description && <div className="truncate text-xs text-fg-subtle">{description}</div>}
        {children}
      </div>
      {trailing && <div className="flex min-h-8 shrink-0 items-center gap-2">{trailing}</div>}
    </div>
  );
}

// ── Tool policy ─────────────────────────────────────────────────────────

interface ToolConfig {
  name?: string;
  enabled?: boolean;
  permission_policy?: { type?: string };
}
interface ToolEntry {
  type?: string;
  name?: string;
  description?: string;
  mcp_server_name?: string;
  default_config?: { enabled?: boolean; permission_policy?: { type?: string } };
  configs?: ToolConfig[];
}

export type ToolPolicy = "allow" | "ask" | "off";

export const TOOL_POLICY: Record<ToolPolicy, { label: string; tone: "neutral" | "warning"; title: string }> = {
  allow: { label: "Allowed", tone: "neutral", title: "Runs without asking" },
  ask: { label: "Asks first", tone: "warning", title: "A person approves each call" },
  off: { label: "Off", tone: "neutral", title: "The agent cannot use it" },
};

function policyOf(enabled: boolean | undefined, type: string | undefined, fallback: ToolPolicy = "allow"): ToolPolicy {
  if (enabled === false) return "off";
  if (type === "always_ask") return "ask";
  if (type === "always_allow") return "allow";
  return fallback;
}

export interface AgentToolsSummary {
  /** The built-in toolset, when the agent has it. */
  builtIn: { policy: ToolPolicy; off: string[]; ask: string[]; allow: string[] } | null;
  custom: Array<{ name: string; description?: string }>;
  servers: Array<{ name: string; label: string; host: string; policy: ToolPolicy }>;
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

function hostOf(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Read the agent's tools and MCP servers into a shape a page can list. */
export function summarizeTools(agent: AgentRecord): AgentToolsSummary {
  const tools = (agent.tools ?? []) as ToolEntry[];
  const toolset = tools.find((t) => (t.type ?? "").startsWith("agent_toolset"));
  let builtIn: AgentToolsSummary["builtIn"] = null;
  if (toolset) {
    const policy = policyOf(toolset.default_config?.enabled, toolset.default_config?.permission_policy?.type);
    const named = (toolset.configs ?? []).filter((c): c is ToolConfig & { name: string } => !!c?.name);
    const withPolicy = named.map((c) => ({ name: c.name, policy: policyOf(c.enabled, c.permission_policy?.type, policy) }));
    builtIn = {
      policy,
      off: policy === "off" ? [] : withPolicy.filter((c) => c.policy === "off").map((c) => c.name),
      ask: policy === "ask" ? [] : withPolicy.filter((c) => c.policy === "ask").map((c) => c.name),
      allow: policy === "allow" ? [] : withPolicy.filter((c) => c.policy === "allow").map((c) => c.name),
    };
  }

  const custom = tools
    .filter((t) => t.type === "custom" && t.name)
    .map((t) => ({ name: t.name as string, description: t.description }));

  const mcpToolsets = new Map(tools.filter((t) => t.type === "mcp_toolset" && t.mcp_server_name).map((t) => [t.mcp_server_name as string, t]));
  const servers = ((agent.mcp_servers ?? []) as Array<{ name?: string; url?: string }>)
    .filter((s) => s?.name || s?.url)
    .map((s) => {
      const known = MCP_REGISTRY.find((entry) => entry.url === s.url || entry.id === s.name);
      const ts = s.name ? mcpToolsets.get(s.name) : undefined;
      return {
        name: s.name ?? hostOf(s.url),
        label: known?.name ?? cap((s.name ?? hostOf(s.url)).replace(/[_-]+/g, " ")),
        host: hostOf(s.url),
        policy: policyOf(ts?.default_config?.enabled, ts?.default_config?.permission_policy?.type),
      };
    });

  return { builtIn, custom, servers };
}

/** Brand marks we ship locally. Other apps fall back to their initial. */
const LOCAL_BRAND_ICON: Record<string, ComponentType<{ className?: string }>> = {
  github: GitHubIcon,
  linear: LinearIcon,
  slack: SlackIcon,
};

export function localBrandIcon(name: string | undefined) {
  return name ? LOCAL_BRAND_ICON[name.toLowerCase()] : undefined;
}

/** "a, b and c" for short lists inside a sentence. */
export function listInWords(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
