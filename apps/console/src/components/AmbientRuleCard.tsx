import type { Event } from "../lib/events";

/**
 * Renders a system.ambient_rule_created event — the agent just wired a
 * standing cron on itself from chat. Same card family as the access-request
 * and harness-diff cards; reuses their entrance choreography
 * (.harness-diff-card / .harness-diff-row in index.css, reduced-motion safe).
 */

/** "0 9 * * 1-5" → "at 09:00, Mon–Fri" for the common shapes; anything
 *  fancier falls back to the raw cron (shown alongside regardless). */
function humanizeCron(cron: string): string | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, mon, dow] = parts;
  if (dom !== "*" || mon !== "*") return null;
  if (!/^\d{1,2}$/.test(min) || !/^\d{1,2}$/.test(hour)) return null;
  const time = `${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  if (dow === "*") return `daily at ${time}`;
  if (dow === "1-5") return `at ${time}, Mon–Fri`;
  if (dow === "0,6" || dow === "6,0") return `at ${time}, weekends`;
  if (/^\d$/.test(dow)) return `every ${DAYS[Number(dow)]} at ${time}`;
  return null;
}

const WAKE_MODE_HINT: Record<string, string> = {
  act: "does the task",
  decide: "assesses, then acts if warranted",
  observe: "logs only",
  escalate: "flags a human",
};

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
  const human = ev.cron ? humanizeCron(ev.cron) : null;
  const nextWake = ev.next_wake_at ? new Date(ev.next_wake_at) : null;

  let rowIndex = 0;
  const delayFor = () => `${rowIndex++ * 60}ms`;

  return (
    <div className="harness-diff-card max-w-2xl border border-border rounded-lg bg-bg-surface overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-border">
        <div className="text-sm font-medium min-w-0">
          Ambient rule created
          <span className="ml-2 text-fg-subtle font-normal">{ev.name}</span>
        </div>
        <span className="text-[10px] font-semibold tracking-wider uppercase text-accent whitespace-nowrap">
          standing
        </span>
      </div>
      <div className="px-4 py-2.5 text-xs flex flex-col gap-1.5">
        {ev.description && (
          <div className="harness-diff-row text-fg-subtle" style={{ animationDelay: delayFor() }}>
            {ev.description}
          </div>
        )}
        {ev.cron && (
          <div className="harness-diff-row flex items-baseline gap-2" style={{ animationDelay: delayFor() }}>
            <span className="text-fg-subtle w-20 shrink-0">cadence</span>
            <span className="font-mono">{ev.cron}</span>
            {human && <span className="text-fg-subtle">— {human}</span>}
            {ev.timezone && ev.timezone !== "UTC" && (
              <span className="text-fg-subtle">({ev.timezone})</span>
            )}
          </div>
        )}
        {ev.wake_mode && (
          <div className="harness-diff-row flex items-baseline gap-2" style={{ animationDelay: delayFor() }}>
            <span className="text-fg-subtle w-20 shrink-0">wake mode</span>
            <span className="font-mono">{ev.wake_mode}</span>
            {WAKE_MODE_HINT[ev.wake_mode] && (
              <span className="text-fg-subtle">— {WAKE_MODE_HINT[ev.wake_mode]}</span>
            )}
          </div>
        )}
        {ev.prompt && (
          <div className="harness-diff-row flex items-baseline gap-2" style={{ animationDelay: delayFor() }}>
            <span className="text-fg-subtle w-20 shrink-0">each run</span>
            <span className="font-mono text-fg-muted break-words min-w-0">“{ev.prompt}”</span>
          </div>
        )}
        {nextWake && Number.isFinite(nextWake.getTime()) && (
          <div className="harness-diff-row flex items-baseline gap-2" style={{ animationDelay: delayFor() }}>
            <span className="text-fg-subtle w-20 shrink-0">first wake</span>
            <span className="text-success font-medium">{nextWake.toLocaleString()}</span>
          </div>
        )}
        <div className="harness-diff-row text-[11px] text-fg-subtle mt-1" style={{ animationDelay: delayFor() }}>
          Each firing starts a fresh session of this agent. Manage it in the agent's Ambient panel.
        </div>
      </div>
    </div>
  );
}
