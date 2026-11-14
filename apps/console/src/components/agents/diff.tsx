import { cn } from "@/lib/utils";

/**
 * Line diffs for agent configuration: what changed between two versions of
 * an agent, or what the agent just changed about itself during setup.
 *
 *   const rows = collapseContext(diffLines(valueToLines(before), valueToLines(after)));
 *   <DiffLines rows={rows} />
 *
 * `diffLines` is a longest-common-subsequence diff. It is fine at
 * configuration scale (a system prompt is a few hundred lines at most) and
 * is not meant for arbitrary files.
 */
export type DiffRow = { kind: "add" | "del" | "ctx" | "gap"; text: string };

export function diffLines(before: string[], after: string[]): DiffRow[] {
  const n = before.length;
  const m = after.length;
  // lcs[i][j] = LCS length of before[i:] vs after[j:]
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = before[i] === after[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
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
 *  keeping `context` lines on each side, unified-diff style. */
export function collapseContext(rows: DiffRow[], context = 2): DiffRow[] {
  const out: DiffRow[] = [];
  let run: DiffRow[] = [];
  const flush = (isTail: boolean) => {
    const keepHead = out.length > 0 ? context : 0; // no leading context at top
    const keepTail = isTail ? 0 : context;
    if (run.length > keepHead + keepTail + 1) {
      out.push(...run.slice(0, keepHead));
      const hidden = run.length - keepHead - keepTail;
      out.push({ kind: "gap", text: `${hidden} unchanged ${hidden === 1 ? "line" : "lines"}` });
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

export function valueToLines(value: unknown): string[] {
  if (value === undefined || value === null || value === "") return [];
  if (typeof value === "string") return value.split("\n");
  return JSON.stringify(value, null, 2).split("\n");
}

/** True when a diff contains at least one added or removed line. */
export function hasChanges(rows: DiffRow[]): boolean {
  return rows.some((r) => r.kind === "add" || r.kind === "del");
}

const SIGN: Record<DiffRow["kind"], string> = { add: "+", del: "−", ctx: "", gap: "" };

/**
 * The rows of a diff: a sign gutter and wrapped mono text. Added lines are
 * green-tinted, removed lines red-tinted, context is muted. Long prose
 * lines wrap instead of scrolling sideways, because instructions are
 * paragraphs, not code.
 *
 * `rowClassName` and `rowStyle` let a caller stagger rows in (setup chat).
 */
export function DiffLines({
  rows,
  className,
  rowClassName,
  rowStyle,
}: {
  rows: DiffRow[];
  className?: string;
  rowClassName?: string;
  rowStyle?: (index: number) => React.CSSProperties | undefined;
}) {
  return (
    <div className={cn("font-mono text-xs leading-relaxed", className)}>
      {rows.map((row, i) =>
        row.kind === "gap" ? (
          <div
            key={i}
            style={rowStyle?.(i)}
            className={cn("px-4 py-1 text-fg-subtle select-none", rowClassName)}
          >
            <span aria-hidden="true" className="mr-2 text-fg-faint">
              ⋯
            </span>
            {row.text}
          </div>
        ) : (
          <div
            key={i}
            style={rowStyle?.(i)}
            className={cn(
              "grid grid-cols-[1rem_minmax(0,1fr)] gap-1 px-4 py-px",
              row.kind === "add" && "bg-success-subtle text-success",
              row.kind === "del" && "bg-danger-subtle text-danger",
              row.kind === "ctx" && "text-fg-muted",
              rowClassName,
            )}
          >
            <span aria-hidden="true" className="select-none">
              {SIGN[row.kind]}
            </span>
            <span className="min-w-0 break-words whitespace-pre-wrap">
              <span className="sr-only">{row.kind === "add" ? "Added: " : row.kind === "del" ? "Removed: " : ""}</span>
              {row.text || " "}
            </span>
          </div>
        ),
      )}
    </div>
  );
}
