import type { Event } from "../lib/events";

/**
 * Inline verdict after a mission iteration — the supervisor ran the goal
 * contract's verifier commands against the workspace and this is the result.
 * Same card family as connect/skill/ambient; the entrance choreography
 * (.harness-diff-card / .harness-diff-row) is reduced-motion safe.
 */
export function MissionVerdictCard({ event }: { event: Event }) {
  const ev = event as unknown as {
    mission_id?: string;
    iteration?: number;
    all_pass?: boolean;
    results?: Array<{ command: string; pass: boolean; output_snippet?: string }>;
  };
  const results = ev.results ?? [];
  let row = 0;
  const delay = () => `${row++ * 60}ms`;

  return (
    <div className="harness-diff-card max-w-2xl border border-border rounded-lg bg-bg-surface overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-border">
        <div className="text-sm font-medium">
          Verifier verdict
          <span className="ml-2 text-fg-subtle font-normal">iteration {ev.iteration}</span>
        </div>
        <span
          className={`text-[10px] uppercase tracking-wider font-bold px-2 py-0.5 rounded ${
            ev.all_pass ? "text-success bg-success-subtle" : "text-danger bg-danger-subtle"
          }`}
        >
          {ev.all_pass ? "all checks pass" : "checks failing"}
        </span>
      </div>
      <div className="px-4 py-2.5 flex flex-col gap-1.5 text-xs">
        {results.map((r, i) => (
          <div key={i} className="harness-diff-row" style={{ animationDelay: delay() }}>
            <div className="flex items-baseline gap-2">
              <span
                className={`shrink-0 text-[10px] uppercase font-bold ${r.pass ? "text-success" : "text-danger"}`}
              >
                {r.pass ? "pass" : "fail"}
              </span>
              <span className="font-mono break-all">{r.command}</span>
            </div>
            {!r.pass && r.output_snippet?.trim() && (
              <pre className="mt-1 ml-10 p-2 bg-bg rounded border border-border max-h-32 overflow-auto text-[11px] whitespace-pre-wrap text-fg-muted">
                {r.output_snippet.trim().slice(0, 1500)}
              </pre>
            )}
          </div>
        ))}
        <div className="harness-diff-row text-[11px] text-fg-subtle mt-1" style={{ animationDelay: delay() }}>
          {ev.all_pass
            ? "Goal verified — the run is complete. Done was proven, not declared."
            : "The next iteration starts fresh with these failures in its opening brief."}
        </div>
      </div>
    </div>
  );
}
