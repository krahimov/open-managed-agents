import { useMemo, useRef, useState } from "react";
import { CheckIcon, ChevronDownIcon } from "lucide-react";

import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useAgentActivity, useAgents } from "@/lib/directory";
import { describeModel } from "@/lib/models";
import { cn } from "@/lib/utils";

import type { AgentRecord } from "../types/agent";
import { AgentAvatar } from "./AgentAvatar";
import { QueryProblem } from "./QueryProblem";
import { Skeleton } from "./Skeleton";

/**
 * Choose which agent to talk to. A pill trigger (avatar + name) that opens
 * a searchable list of the workspace's active agents with their model and
 * one-line description.
 *
 *   <AgentPicker value={agentId} onChange={(id, agent) => setAgentId(id)} />
 *
 * Reads the shared agent directory (no extra request). The agents the
 * workspace uses most come first, so the likely choice is at the top. Used
 * in the session starter; reuse it anywhere a person picks an agent to
 * converse with.
 *
 * The list says what it is: still loading, could not be loaded (with a
 * retry in place), loaded with no agents, or the agents. After a choice,
 * focus stays wherever `onChange` put it (the starter puts it in the
 * message); closing without choosing returns it to the pill.
 */
export function AgentPicker({
  value,
  onChange,
  placeholder = "Choose an agent",
  align = "start",
  className,
}: {
  value: string | null;
  onChange: (id: string, agent: AgentRecord) => void;
  placeholder?: string;
  align?: "start" | "center" | "end";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const { agents, isLoading, error, refetch } = useAgents();
  /** A choice was just made: `onChange` decides where focus goes. */
  const picked = useRef(false);
  const { byAgent } = useAgentActivity();
  const active = useMemo(
    () =>
      agents
        .filter((a) => !a.archived_at)
        .sort((a, b) => {
          const d = (byAgent.get(b.id)?.sessions ?? 0) - (byAgent.get(a.id)?.sessions ?? 0);
          return d !== 0 ? d : a.name.localeCompare(b.name);
        }),
    [agents, byAgent],
  );
  const selected = value ? agents.find((a) => a.id === value) : undefined;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-label={selected ? `Agent: ${selected.name}` : placeholder}
          className={cn(
            "flex h-9 max-w-64 min-w-0 items-center gap-2 rounded-full border border-border bg-bg-surface pr-2.5 pl-1.5 text-small font-medium text-fg transition-quick hover:border-border-strong hover:bg-bg-inset aria-expanded:border-border-strong aria-expanded:bg-bg-inset dark:bg-bg-soft",
            className,
          )}
        >
          {selected ? (
            <AgentAvatar name={selected.name} id={selected.id} size="sm" />
          ) : (
            <span className="size-6 shrink-0 rounded-[7px] border border-dashed border-border-strong" aria-hidden="true" />
          )}
          <span className={cn("min-w-0 flex-1 truncate text-left", !selected && "text-fg-muted")}>
            {selected ? selected.name : isLoading ? "Loading agents…" : error && agents.length === 0 ? "Agents unavailable" : placeholder}
          </span>
          <ChevronDownIcon className="size-3.5 shrink-0 text-fg-subtle" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align={align}
        sideOffset={8}
        className="w-[380px] max-w-[calc(100vw-1.5rem)] gap-0 p-0"
        onCloseAutoFocus={(e) => {
          if (picked.current) e.preventDefault();
          picked.current = false;
        }}
      >
        <Command>
          <CommandInput placeholder="Search agents" />
          <CommandList className="max-h-80">
            {isLoading ? (
              <div className="space-y-1 p-1.5" role="status" aria-label="Loading agents">
                {[58, 44, 51].map((w) => (
                  <div key={w} className="flex h-12 items-center gap-2.5 px-2">
                    <Skeleton className="size-8 shrink-0" rounded="lg" />
                    <Skeleton className="h-3.5" rounded="sm" style={{ width: `${w}%` }} />
                  </div>
                ))}
              </div>
            ) : error && agents.length === 0 ? (
              <div className="p-2">
                <QueryProblem compact title="Agents could not be loaded" error={error} retry={() => void refetch()} />
              </div>
            ) : active.length === 0 ? (
              <p className="px-3.5 py-6 text-center text-small text-fg-subtle">This workspace has no agents yet.</p>
            ) : (
              <CommandEmpty>No agent matches.</CommandEmpty>
            )}
            {active.map((a) => (
              <CommandItem
                key={a.id}
                value={`${a.name} ${a.description ?? ""} ${a.id}`}
                onSelect={() => {
                  picked.current = true;
                  onChange(a.id, a);
                  setOpen(false);
                }}
                className="items-start gap-2.5 py-2"
              >
                <AgentAvatar name={a.name} id={a.id} size="md" className="mt-0.5" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium text-fg">{a.name}</span>
                    <span className="shrink-0 text-xs text-fg-subtle">{describeModel(a.model).label}</span>
                  </div>
                  {a.description && <p className="mt-0.5 line-clamp-2 text-xs text-fg-muted">{a.description}</p>}
                </div>
                {a.id === value && <CheckIcon className="mt-1 size-4 shrink-0 text-fg" />}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
