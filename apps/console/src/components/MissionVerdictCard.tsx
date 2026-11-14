import { CheckIcon, ListChecksIcon, XIcon } from "lucide-react";

import { plural } from "@/lib/format";
import { cn } from "@/lib/utils";

import type { Event } from "../lib/events";
import { StatusBadge } from "./Badge";
import { CodeWell } from "./EventCard";

/**
 * The verdict after one iteration of a "run until done" mission: the
 * supervisor ran the goal's verifier commands against the workspace, and
 * this is what they said. Done is proven by these checks, never declared
 * by the agent.
 *
 *   [icon] Verifier verdict                         ● All checks pass
 *          Iteration 3 · 2 of 2 checks pass
 *   ✓ npm test -- routes
 *   × tsc --noEmit
 *       <output of the failing check>
 */
export function MissionVerdictCard({ event }: { event: Event }) {
  const ev = event as unknown as {
    mission_id?: string;
    iteration?: number;
    all_pass?: boolean;
    results?: Array<{ command: string; pass: boolean; output_snippet?: string }>;
  };
  const results = ev.results ?? [];
  const passed = results.filter((r) => r.pass).length;

  return (
    <div className="surface animate-rise-in overflow-hidden rounded-lg">
      <div className="flex items-start gap-3 px-4 pt-3.5 pb-3">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-[8px] bg-bg-soft text-fg-muted">
          <ListChecksIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1 py-0.5">
          <p className="text-sm font-medium text-fg">Verifier verdict</p>
          <p className="mt-0.5 text-small text-fg-muted">
            {ev.iteration != null ? `Iteration ${ev.iteration} · ` : ""}
            {results.length > 0 ? `${passed} of ${plural(results.length, "check")} pass` : "No checks were reported"}
          </p>
        </div>
        <StatusBadge
          status={ev.all_pass ? "passed" : "failed"}
          label={ev.all_pass ? "All checks pass" : "Checks failing"}
          variant="soft"
          className="mt-1"
        />
      </div>
      {results.length > 0 && (
        <ul className="space-y-2 border-t border-border px-4 py-3">
          {results.map((r, i) => (
            <li key={i} className="stagger animate-rise-in" style={{ "--i": Math.min(i, 12) } as React.CSSProperties}>
              <div className="flex items-start gap-2.5">
                <span
                  className={cn(
                    "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full",
                    r.pass ? "bg-success-subtle text-success" : "bg-danger-subtle text-danger",
                  )}
                >
                  {r.pass ? <CheckIcon className="size-3 stroke-[2.5]" /> : <XIcon className="size-3 stroke-[2.5]" />}
                  <span className="sr-only">{r.pass ? "Passed" : "Failed"}</span>
                </span>
                <code className="min-w-0 font-mono text-xs leading-5 break-all text-fg">{r.command}</code>
              </div>
              {!r.pass && r.output_snippet?.trim() && (
                <CodeWell tone="danger" className="mt-1.5 ml-[1.625rem] max-h-32">
                  {r.output_snippet.trim().slice(0, 1500)}
                </CodeWell>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="border-t border-border bg-bg-inset/60 px-4 py-2.5 text-xs text-fg-muted">
        {ev.all_pass
          ? "Goal verified. The run is complete: done was proven by these checks, not declared."
          : "The next iteration starts fresh with these failures in its opening brief."}
      </p>
    </div>
  );
}
