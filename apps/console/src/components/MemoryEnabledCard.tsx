import { BrainIcon } from "lucide-react";

import type { Event } from "../lib/events";
import { StatusBadge } from "./Badge";
import { EntityRef } from "./EntityRef";

/**
 * Memory was just switched on for the agent (a `system.memory_enabled`
 * event): by its enable_memory setup tool, or by the server when the agent
 * got its first trigger. From the next session on, the agent reads what it
 * saved before and writes new notes as it works.
 *
 * Same card family as the trigger card it usually lands under
 * (AmbientRuleCard), with the same entrance (`.harness-diff-card` /
 * `.harness-diff-row` in index.css, off under reduced motion).
 *
 * Event fields read: mode, store_id, store_name, source.
 */
export interface MemoryEnabledCardProps {
  /** The `system.memory_enabled` event. */
  event: Event;
}

export function MemoryEnabledCard({ event }: MemoryEnabledCardProps) {
  const ev = event as unknown as { mode?: string; store_id?: string; store_name?: string; source?: string };
  const perUser = ev.mode === "per_user";
  const fromTrigger = ev.source === "ambient_rule";

  let row = 0;
  const delay = () => ({ animationDelay: `${row++ * 60}ms` });

  return (
    <div className="harness-diff-card surface overflow-hidden rounded-lg">
      <div className="flex items-center gap-3 px-4 py-3">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-[8px] bg-bg-soft text-fg-muted">
          <BrainIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-fg">Memory turned on</p>
          <p className="truncate text-xs text-fg-subtle">
            {perUser ? "A separate memory for each person" : "One memory for this agent"}
          </p>
        </div>
        <StatusBadge status="active" label="On" className="shrink-0" />
      </div>

      <div className="space-y-2.5 border-t border-border px-4 py-3.5 text-small">
        {(ev.store_name || ev.store_id) && !perUser && (
          <p className="harness-diff-row flex min-w-0 items-center gap-1.5 text-fg-muted" style={delay()}>
            <span className="shrink-0">Notes are kept in</span>
            {ev.store_id ? (
              <EntityRef kind="memory_store" id={ev.store_id} name={ev.store_name} />
            ) : (
              <span className="truncate font-medium text-fg">{ev.store_name}</span>
            )}
          </p>
        )}
        <p className="harness-diff-row text-fg" style={delay()}>
          {perUser
            ? "Applies to every new session, with one store per person."
            : "Applies to every new session of this agent, scheduled runs included."}
        </p>
        {fromTrigger && (
          <p className="harness-diff-row text-fg-muted" style={delay()}>
            Turned on with the trigger: each run is a fresh session, so memory is how it remembers the last one.
          </p>
        )}
        <p className="harness-diff-row text-xs text-fg-subtle" style={delay()}>
          The agent reads its saved notes when a session starts and writes new ones as it works. Turn it off on the
          agent's page.
        </p>
      </div>
    </div>
  );
}
