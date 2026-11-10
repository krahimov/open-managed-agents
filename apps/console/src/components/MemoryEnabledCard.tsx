import { Link } from "react-router";
import type { Event } from "../lib/events";

/**
 * Renders a system.memory_enabled event — memory was just switched on for
 * the agent, either by its enable_memory setup tool or automatically with a
 * new schedule. Same card family as AmbientRuleCard (it usually lands right
 * under one) and the same entrance choreography (.harness-diff-card /
 * .harness-diff-row in index.css, reduced-motion safe).
 */
export function MemoryEnabledCard({ event }: { event: Event }) {
  const ev = event as unknown as {
    mode?: string;
    store_id?: string;
    store_name?: string;
    source?: string;
  };
  const perUser = ev.mode === "per_user";

  let rowIndex = 0;
  const delayFor = () => `${rowIndex++ * 60}ms`;

  return (
    <div className="harness-diff-card max-w-2xl border border-border rounded-lg bg-bg-surface overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-border">
        <div className="text-sm font-medium min-w-0">Memory enabled</div>
        <span className="text-[10px] font-semibold tracking-wider uppercase text-accent whitespace-nowrap">
          on
        </span>
      </div>
      <div className="px-4 py-2.5 text-xs flex flex-col gap-1.5">
        {ev.store_name && (
          <div className="harness-diff-row flex items-baseline gap-2" style={{ animationDelay: delayFor() }}>
            <span className="text-fg-subtle w-20 shrink-0">store</span>
            {ev.store_id ? (
              <Link to={`/memory/${ev.store_id}`} className="font-mono text-fg hover:underline break-all min-w-0">
                {ev.store_name}
              </Link>
            ) : (
              <span className="font-mono break-all min-w-0">{ev.store_name}</span>
            )}
          </div>
        )}
        <div className="harness-diff-row flex items-baseline gap-2" style={{ animationDelay: delayFor() }}>
          <span className="text-fg-subtle w-20 shrink-0">applies to</span>
          <span>
            {perUser
              ? "every new session, one store per user"
              : "every new session of this agent, scheduled runs included"}
          </span>
        </div>
        {ev.source === "ambient_rule" && (
          <div className="harness-diff-row flex items-baseline gap-2" style={{ animationDelay: delayFor() }}>
            <span className="text-fg-subtle w-20 shrink-0">why</span>
            <span>turned on with the schedule — each run is a fresh session</span>
          </div>
        )}
        <div className="harness-diff-row text-[11px] text-fg-subtle mt-1" style={{ animationDelay: delayFor() }}>
          The agent reads its saved notes at the start of a session and writes new ones as it works. Turn it off
          on the agent page.
        </div>
      </div>
    </div>
  );
}
