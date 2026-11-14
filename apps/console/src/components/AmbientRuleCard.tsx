import { CalendarClockIcon } from "lucide-react";

import { formatAbsolute, toDate } from "@/lib/format";

import type { Event } from "../lib/events";
import { cronInWords, wakeModeMeta } from "./agents/triggers";
import { Chip, StatusBadge } from "./Badge";
import { RelativeTime } from "./RelativeTime";

/**
 * The agent set up a trigger for itself from the conversation (a
 * `system.ambient_rule_created` event): from now on it wakes on a schedule
 * without being asked. The card says, in words, when it will run, what it
 * does when it wakes and what each run is told. The same vocabulary as the
 * Triggers tab on the agent's page (`agents/triggers`), where the trigger
 * can be paused or deleted.
 *
 * Same card family as the configuration diff card, with the same entrance
 * (`.harness-diff-card` / `.harness-diff-row` in index.css, off under
 * reduced motion).
 */
export function AmbientRuleCard({ event }: { event: Event }) {
  const ev = event as unknown as {
    rule_id?: string;
    name?: string;
    description?: string;
    cron?: string;
    timezone?: string;
    wake_mode?: string;
    prompt?: string;
    next_wake_at?: string;
  };
  const schedule = ev.cron ? cronInWords(ev.cron) : null;
  const wake = ev.wake_mode ? wakeModeMeta(ev.wake_mode) : null;
  const firstRun = toDate(ev.next_wake_at);

  let row = 0;
  const delay = () => ({ animationDelay: `${row++ * 60}ms` });

  return (
    <div className="harness-diff-card surface overflow-hidden rounded-lg">
      <div className="flex items-center gap-3 px-4 py-3">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-[8px] bg-bg-soft text-fg-muted">
          <CalendarClockIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-fg">Created a trigger for itself</p>
          <p className="truncate text-xs text-fg-subtle" title={ev.name}>
            {ev.name?.trim() || "Unnamed trigger"}
          </p>
        </div>
        <StatusBadge status="active" label="On" className="shrink-0" />
      </div>

      <div className="space-y-2.5 border-t border-border px-4 py-3.5 text-small">
        {(schedule || ev.cron) && (
          <p className="harness-diff-row text-fg" style={delay()}>
            <span className="font-medium">{schedule ?? "On a custom schedule"}</span>
            {!schedule && ev.cron && <span className="ml-1.5 font-mono text-xs text-fg-muted">{ev.cron}</span>}
            {ev.timezone && <span className="text-fg-muted"> · {ev.timezone.replace(/_/g, " ")}</span>}
          </p>
        )}
        {ev.description && (
          <p className="harness-diff-row text-fg-muted" style={delay()}>
            {ev.description}
          </p>
        )}
        {ev.prompt && (
          <p className="harness-diff-row border-l-2 border-border-strong pl-3 break-words text-fg-muted" style={delay()}>
            <span className="text-fg-subtle">Each run is told: </span>
            {ev.prompt}
          </p>
        )}
        {(wake || firstRun) && (
          <div className="harness-diff-row flex flex-wrap items-center gap-x-2.5 gap-y-1.5" style={delay()}>
            {wake && <Chip title={wake.hint}>{wake.short}</Chip>}
            {firstRun && (
              <span className="text-xs text-fg-subtle" title={formatAbsolute(firstRun)}>
                First run <RelativeTime value={firstRun} className="font-medium text-fg-muted" />
              </span>
            )}
          </div>
        )}
        <p className="harness-diff-row text-xs text-fg-subtle" style={delay()}>
          Each time it fires, a fresh session of this agent starts. Pause or delete it on the agent's Triggers tab.
        </p>
      </div>
    </div>
  );
}
