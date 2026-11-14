import { useMemo } from "react";
import { Link } from "react-router";

import { useAgents } from "@/lib/directory";
import { plural } from "@/lib/format";
import { modelId } from "@/lib/models";
import { cn } from "@/lib/utils";

import type { AgentRecord } from "../../types/agent";
import { AgentAvatar } from "../AgentAvatar";
import { Skeleton } from "../Skeleton";
import { Tip } from "../Tip";

/**
 * Which agents depend on a resource.
 *
 * An environment, a vault, a memory store, a skill or a model is only
 * interesting through the agents that use it, so every resource list has
 * a "Used by" column and every record page a "Used by" card. Both read
 * the workspace directory (`useAgents`, one cached request): nothing here
 * adds an endpoint.
 *
 *   const usage = useResourceUsage();
 *   <UsedBy agents={usage.environments.get(env.id)} loading={usage.isLoading} />
 *   <UsedByList agents={usage.vaults.get(vault.id)} loading={usage.isLoading} noun="vault" />
 *
 * Only active agents are counted; archived ones cannot start sessions.
 */
export interface ResourceUsage {
  environments: Map<string, AgentRecord[]>;
  vaults: Map<string, AgentRecord[]>;
  memoryStores: Map<string, AgentRecord[]>;
  /** Keyed by skill id and, for built-in skills, by skill name. */
  skills: Map<string, AgentRecord[]>;
  /** Keyed by the model handle an agent references (`card.model_id`). */
  models: Map<string, AgentRecord[]>;
  isLoading: boolean;
}

function push(map: Map<string, AgentRecord[]>, key: string | null | undefined, agent: AgentRecord) {
  if (!key) return;
  const list = map.get(key);
  if (!list) map.set(key, [agent]);
  else if (!list.includes(agent)) list.push(agent);
}

export function useResourceUsage(): ResourceUsage {
  const { agents, isLoading } = useAgents();
  return useMemo(() => {
    const environments = new Map<string, AgentRecord[]>();
    const vaults = new Map<string, AgentRecord[]>();
    const memoryStores = new Map<string, AgentRecord[]>();
    const skills = new Map<string, AgentRecord[]>();
    const models = new Map<string, AgentRecord[]>();
    for (const agent of agents) {
      if (agent.archived_at) continue;
      push(environments, agent._oma?.default_environment_id, agent);
      for (const id of agent._oma?.default_vault_ids ?? []) push(vaults, id, agent);
      const memory = agent._oma?.memory;
      if (memory && memory.mode !== "off") push(memoryStores, memory.store_id, agent);
      for (const ref of (agent.skills ?? []) as Array<{ skill_id?: string }>) push(skills, ref?.skill_id, agent);
      push(models, modelId(agent.model), agent);
      push(models, agent._oma?.aux_model?.id, agent);
    }
    return { environments, vaults, memoryStores, skills, models, isLoading };
  }, [agents, isLoading]);
}

/**
 * The "Used by" cell: up to three agent avatars (overlapping by a hair, so
 * both initials stay readable) and a count.
 * Names are in the tooltip. Zero reads "No agents", never a blank cell.
 */
export function UsedBy({
  agents,
  loading,
  max = 3,
  className,
}: {
  agents: AgentRecord[] | undefined;
  loading?: boolean;
  max?: number;
  className?: string;
}) {
  if (loading && !agents) return <Skeleton className="h-4 w-20" rounded="sm" />;
  const list = agents ?? [];
  if (list.length === 0) return <span className={cn("text-fg-subtle", className)}>No agents</span>;
  const shown = list.slice(0, max);
  return (
    <Tip
      label={
        <span className="block max-w-56">
          {list.slice(0, 8).map((a) => (
            <span key={a.id} className="block truncate">
              {a.name}
            </span>
          ))}
          {list.length > 8 && <span className="block opacity-75">and {list.length - 8} more</span>}
        </span>
      }
    >
      {/* A tab stop: the names behind "3 agents" (or a name cut short) are reachable without a pointer. */}
      <span tabIndex={0} className={cn("inline-flex max-w-full items-center gap-2 rounded-sm align-middle", className)}>
        <span className="flex shrink-0 -space-x-0.5">
          {shown.map((a) => (
            <AgentAvatar
              key={a.id}
              name={a.name}
              id={a.id}
              size="xs"
              className="ring-2 ring-bg-surface"
            />
          ))}
        </span>
        <span className="truncate text-fg-muted">
          {list.length === 1 ? list[0].name : plural(list.length, "agent")}
        </span>
      </span>
    </Tip>
  );
}

/**
 * The "Used by" card body on a record page: one linked row per agent.
 * `empty` explains what attaching would do.
 */
export function UsedByList({
  agents,
  loading,
  empty,
  max = 6,
}: {
  agents: AgentRecord[] | undefined;
  loading?: boolean;
  /** Shown when no agent uses the resource. */
  empty: string;
  max?: number;
}) {
  if (loading && !agents) {
    return (
      <div className="space-y-2.5" aria-hidden="true">
        {[60, 45, 70].map((w) => (
          <div key={w} className="flex items-center gap-2.5">
            <Skeleton className="size-6" rounded="md" />
            <Skeleton className="h-3" rounded="sm" style={{ width: `${w}%` }} />
          </div>
        ))}
      </div>
    );
  }
  const list = agents ?? [];
  if (list.length === 0) return <p className="text-small text-fg-subtle">{empty}</p>;
  const shown = list.slice(0, max);
  return (
    <ul className="-mx-2 space-y-0.5">
      {shown.map((a) => (
        <li key={a.id}>
          <Link
            to={`/agents/${a.id}`}
            className="flex min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 transition-quick hover:bg-bg-hover"
          >
            <AgentAvatar name={a.name} id={a.id} size="sm" />
            <span className="truncate text-small font-medium text-fg" title={a.name}>
              {a.name}
            </span>
          </Link>
        </li>
      ))}
      {list.length > max && (
        <li className="px-2 pt-1 text-xs text-fg-subtle">and {plural(list.length - max, "more agent")}</li>
      )}
    </ul>
  );
}
