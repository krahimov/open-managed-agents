import type { ComponentType } from "react";
import { BrainIcon, NetworkIcon, PlugIcon, PuzzleIcon, TerminalIcon, WrenchIcon } from "lucide-react";

import type { AgentRecord } from "../types/agent";
import { MCP_REGISTRY } from "./mcp-registry";

/**
 * What an agent can do, as a short list of chips. Read off the agent
 * config; never shows raw tool-type ids ("agent_toolset_20260401").
 *
 *   agentCapabilities(agent).map((c) => <Chip key={c.key} icon={c.icon} title={c.title}>{c.label}</Chip>)
 */
export interface AgentCapability {
  key: string;
  label: string;
  /** Longer explanation for a tooltip. */
  title: string;
  icon: ComponentType<{ className?: string }>;
}

interface ToolEntry {
  type?: string;
  name?: string;
  mcp_server_name?: string;
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** An app as people write it ("github" → "GitHub"), from the MCP registry
 *  when it is a known server; otherwise the server name, capitalised. */
const appName = (server: string) => MCP_REGISTRY.find((entry) => entry.id === server.toLowerCase())?.name ?? cap(server);

const HARNESS_LABEL: Record<string, string> = {
  "claude-agent-sdk": "Claude Agent SDK",
  "codex-sdk": "Codex SDK",
  "acp-proxy": "Local runtime",
};

export function harnessLabel(harness: string | undefined | null): string {
  if (!harness || harness === "default") return "Managed loop";
  return HARNESS_LABEL[harness] ?? harness;
}

export function agentCapabilities(agent: AgentRecord): AgentCapability[] {
  const out: AgentCapability[] = [];
  const tools = (agent.tools ?? []) as ToolEntry[];
  const servers = ((agent.mcp_servers ?? []) as Array<{ name?: string }>).map((s) => s.name).filter(Boolean) as string[];
  const custom = tools.filter((t) => t.type === "custom");
  const builtIn = tools.some((t) => (t.type ?? "").startsWith("agent_toolset"));

  if (agent.multiagent?.agents?.length) {
    const n = agent.multiagent.agents.length;
    out.push({
      key: "coordinator",
      label: `Coordinates ${n}`,
      title: `Delegates to ${n} other agent${n === 1 ? "" : "s"}`,
      icon: NetworkIcon,
    });
  }
  if (servers.length > 0) {
    out.push({
      key: "mcp",
      label: servers.length === 1 ? appName(servers[0]) : `${servers.length} apps`,
      title: `Connected apps: ${servers.map(appName).join(", ")}`,
      icon: PlugIcon,
    });
  }
  const skills = agent.skills?.length ?? 0;
  if (skills > 0) {
    out.push({
      key: "skills",
      label: `${skills} skill${skills === 1 ? "" : "s"}`,
      title: `${skills} skill${skills === 1 ? "" : "s"} installed`,
      icon: PuzzleIcon,
    });
  }
  if (custom.length > 0) {
    out.push({
      key: "custom-tools",
      label: `${custom.length} custom tool${custom.length === 1 ? "" : "s"}`,
      title: `Custom tools: ${custom.map((t) => t.name).filter(Boolean).join(", ") || custom.length}`,
      icon: WrenchIcon,
    });
  }
  const memory = agent._oma?.memory;
  if (memory && memory.mode !== "off") {
    out.push({
      key: "memory",
      label: "Memory",
      title: memory.mode === "per_user" ? "Remembers across sessions, per user" : "Remembers across sessions",
      icon: BrainIcon,
    });
  }
  if (out.length === 0 && builtIn) {
    out.push({ key: "tools", label: "Built-in tools", title: "Files, shell, web and code tools", icon: TerminalIcon });
  }
  return out;
}

/** True when the agent can start a session without the person choosing an environment. */
export function agentNeedsEnvironment(agent: AgentRecord | undefined): boolean {
  if (!agent) return false;
  return !agent._oma?.default_environment_id && !agent._oma?.runtime_binding;
}

/**
 * The column rule for a gallery of profile cards (agents, skills). Columns
 * are counted from the room the panel actually has, not from the window:
 * a card never gets narrower than 280px, so with the sidebar open a
 * 1024px window shows two cards a row and a 1280px one three, instead of
 * three squeezed cards whose names are cut to a few letters.
 */
export const GALLERY_GRID = "grid gap-4 grid-cols-[repeat(auto-fill,minmax(min(280px,100%),1fr))]";
