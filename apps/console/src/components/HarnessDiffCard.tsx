import { useMemo } from "react";
import { SlidersHorizontalIcon } from "lucide-react";

import type { Event } from "../lib/events";
import { DiffLines, collapseContext, diffLines, hasChanges, valueToLines, type DiffRow } from "./agents/diff";
import { StatusBadge } from "./Badge";

/**
 * The agent changed its own configuration (an `update_harness` call during
 * setup). The card names the parts that changed and shows the exact diff
 * for each, so nothing the agent does to itself is a surprise. Data comes
 * from the setup marker's metadata (harness_previous / harness_config /
 * changed) broadcast by ClaudeAgentSdkHarness.
 *
 * It belongs to the conversation's card family (see EventCard): a quiet
 * bordered block in the agent's turn, with a state on the right. Rows fade
 * in one after another (`.harness-diff-card` / `.harness-diff-row` in
 * index.css, off under reduced motion).
 */

/** Configuration fields as people call them, in reading order. */
const FIELDS: Array<[key: string, label: string]> = [
  ["name", "Name"],
  ["description", "Description"],
  ["model", "Model"],
  ["system", "Instructions"],
  ["tools", "Tools"],
  ["mcp_servers", "MCP servers"],
  ["skills", "Skills"],
];
const FIELD_ORDER = FIELDS.map(([key]) => key);
const FIELD_LABEL: Record<string, string> = Object.fromEntries(FIELDS);

/** The name of a configuration field for a person ("system" → "Instructions"). */
export function harnessFieldLabel(field: string): string {
  if (FIELD_LABEL[field]) return FIELD_LABEL[field];
  const s = field.replace(/[._-]+/g, " ").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : field;
}

const orderOf = (field: string) => {
  const i = FIELD_ORDER.indexOf(field);
  return i === -1 ? FIELD_ORDER.length : i;
};

export function HarnessDiffCard({ event }: { event: Event }) {
  const meta = (event.metadata ?? {}) as {
    changed?: string[];
    harness_config?: Record<string, unknown>;
    harness_previous?: Record<string, unknown>;
  };
  const changed = useMemo(() => (meta.changed ?? []).slice().sort((a, b) => orderOf(a) - orderOf(b)), [meta.changed]);

  const sections = useMemo(() => {
    const before = meta.harness_previous ?? {};
    const after = meta.harness_config ?? {};
    return changed
      .map((field): { field: string; rows: DiffRow[] } => ({
        field,
        rows: collapseContext(diffLines(valueToLines(before[field]), valueToLines(after[field]))),
      }))
      .filter((s) => hasChanges(s.rows));
  }, [changed, meta.harness_previous, meta.harness_config]);

  if (sections.length === 0) return null;

  // Stagger row reveals across the whole card, capped so a long diff does
  // not take seconds to settle.
  let offset = 0;

  return (
    <div className="harness-diff-card surface overflow-hidden rounded-lg">
      <div className="flex items-center gap-3 px-4 py-3">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-[8px] bg-bg-soft text-fg-muted">
          <SlidersHorizontalIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-fg">Updated its own configuration</p>
          <p className="truncate text-xs text-fg-subtle" title={sections.map((s) => harnessFieldLabel(s.field)).join(", ")}>
            {sections.map((s) => harnessFieldLabel(s.field)).join(" · ")}
          </p>
        </div>
        <StatusBadge status="completed" label="Applied" className="shrink-0" />
      </div>
      <div className="max-h-[26rem] overflow-y-auto border-t border-border pb-2">
        {sections.map(({ field, rows }) => {
          const start = offset;
          offset += rows.length + 1;
          return (
            <section key={field}>
              <h4
                className="harness-diff-row px-4 pt-3 pb-1 text-xs font-medium text-fg-subtle"
                style={{ animationDelay: `${Math.min(start * 28, 560)}ms` }}
              >
                {harnessFieldLabel(field)}
              </h4>
              <DiffLines
                rows={rows}
                rowClassName="harness-diff-row"
                rowStyle={(i) => ({ animationDelay: `${Math.min((start + 1 + i) * 28, 560)}ms` })}
              />
            </section>
          );
        })}
      </div>
    </div>
  );
}
