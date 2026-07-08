import { useMemo } from "react";
import type { Event } from "../lib/events";

/**
 * Renders an update_harness call as a red/green diff card — the setup-mode
 * sibling of the access-proposal card: the agent edits its own harness, the
 * user sees exactly what changed, field by field. Data comes from the setup
 * marker's metadata (harness_previous / harness_config / changed) broadcast
 * by ClaudeAgentSdkHarness. Entrance animation lives in index.css
 * (.harness-diff-card / .harness-diff-row, reduced-motion safe).
 */

type DiffRow = { kind: "add" | "del" | "ctx" | "gap"; text: string };

/** Longest-common-subsequence line diff. Fine at harness scale (a system
 *  prompt is a few hundred lines at most); not meant for arbitrary files. */
function diffLines(before: string[], after: string[]): DiffRow[] {
  const n = before.length;
  const m = after.length;
  // lcs[i][j] = LCS length of before[i:] vs after[j:]
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] =
        before[i] === after[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      rows.push({ kind: "ctx", text: before[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      rows.push({ kind: "del", text: before[i] });
      i++;
    } else {
      rows.push({ kind: "add", text: after[j] });
      j++;
    }
  }
  while (i < n) rows.push({ kind: "del", text: before[i++] });
  while (j < m) rows.push({ kind: "add", text: after[j++] });
  return rows;
}

/** Collapse runs of unchanged lines longer than 2·context+1 into a gap row,
 *  keeping `context` lines on each side — unified-diff style. */
function collapseContext(rows: DiffRow[], context = 2): DiffRow[] {
  const out: DiffRow[] = [];
  let run: DiffRow[] = [];
  const flush = (isTail: boolean) => {
    const keepHead = out.length > 0 ? context : 0; // no leading context at top
    const keepTail = isTail ? 0 : context;
    if (run.length > keepHead + keepTail + 1) {
      out.push(...run.slice(0, keepHead));
      out.push({ kind: "gap", text: `… ${run.length - keepHead - keepTail} unchanged lines` });
      if (keepTail > 0) out.push(...run.slice(run.length - keepTail));
    } else {
      out.push(...run);
    }
    run = [];
  };
  for (const row of rows) {
    if (row.kind === "ctx") run.push(row);
    else {
      flush(false);
      out.push(row);
    }
  }
  flush(true);
  return out;
}

function valueToLines(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value === "string") return value.split("\n");
  return JSON.stringify(value, null, 2).split("\n");
}

const FIELD_ORDER = ["name", "description", "model", "system", "mcp_servers", "skills"];

export function HarnessDiffCard({ event }: { event: Event }) {
  const meta = (event.metadata ?? {}) as {
    changed?: string[];
    harness_config?: Record<string, unknown>;
    harness_previous?: Record<string, unknown>;
  };
  const changed = useMemo(
    () =>
      (meta.changed ?? []).slice().sort(
        (a, b) => FIELD_ORDER.indexOf(a) - FIELD_ORDER.indexOf(b),
      ),
    [meta.changed],
  );

  const sections = useMemo(() => {
    const before = meta.harness_previous ?? {};
    const after = meta.harness_config ?? {};
    return changed
      .map((field) => {
        const rows = collapseContext(
          diffLines(valueToLines(before[field]), valueToLines(after[field])),
        );
        return { field, rows };
      })
      .filter((s) => s.rows.some((r) => r.kind === "add" || r.kind === "del"));
  }, [changed, meta.harness_previous, meta.harness_config]);

  if (sections.length === 0) return null;

  // Stagger row reveals across the whole card, capped so huge diffs don't
  // take seconds to settle.
  let rowIndex = 0;
  const delayFor = () => `${Math.min(rowIndex++ * 28, 560)}ms`;

  return (
    <div className="harness-diff-card max-w-2xl border border-border rounded-lg bg-bg-surface overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-border">
        <div className="text-sm font-medium">
          Harness update
          <span className="ml-2 font-mono text-xs text-fg-subtle">
            {changed.join(" · ")}
          </span>
        </div>
        <span className="text-[10px] font-semibold tracking-wider uppercase text-accent whitespace-nowrap">
          applied live
        </span>
      </div>
      <div className="py-1.5 font-mono text-xs leading-relaxed overflow-x-auto">
        {sections.map(({ field, rows }) => (
          <div key={field}>
            <div
              className="harness-diff-row px-4 py-0.5 text-fg-subtle select-none"
              style={{ animationDelay: delayFor() }}
            >
              {field}
            </div>
            {rows.map((row, i) => (
              <div
                key={`${field}-${i}`}
                className={
                  "harness-diff-row px-4 whitespace-pre " +
                  (row.kind === "add"
                    ? "bg-success-subtle text-success"
                    : row.kind === "del"
                      ? "bg-danger-subtle text-danger line-through decoration-danger/50"
                      : "text-fg-subtle")
                }
                style={{ animationDelay: delayFor() }}
              >
                {row.kind === "add" ? "+ " : row.kind === "del" ? "- " : "  "}
                {row.text}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
