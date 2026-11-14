import { cn } from "@/lib/utils";

import type { FieldControlProps } from "./Field";
import { SegmentedControl } from "./SegmentedControl";

/** Memory mode for an agent — mirrors `_oma.memory.mode` on the wire.
 *  `off` is the server default when the field is absent, so it is never
 *  stored: create omits `_oma.memory`, update sends `_oma.memory: null`. */
export type MemoryMode = "off" | "shared" | "per_user";

export const MEMORY_MODE_OPTIONS: Array<{ value: MemoryMode; label: string; hint: string }> = [
  {
    value: "off",
    label: "Off",
    hint: "Nothing carries over between sessions.",
  },
  {
    value: "shared",
    label: "Shared",
    hint: "One memory for this agent. Every session reads and writes it. Best for an assistant with a single operator.",
  },
  {
    value: "per_user",
    label: "Per user",
    hint: "A separate memory for each person who talks to the agent. Best for customer-facing agents.",
  },
];

export const MEMORY_MODE_LABELS: Record<MemoryMode, string> = {
  off: "Off",
  shared: "Shared",
  per_user: "Per user",
};

/** Parse whatever came back in `_oma.memory` into a mode; unknown/absent → "off". */
export function parseMemoryMode(memory: unknown): MemoryMode {
  const mode = (memory as { mode?: unknown } | null | undefined)?.mode;
  return mode === "shared" || mode === "per_user" ? mode : "off";
}

/**
 * Off · Shared · Per user, with a line under it that says what the
 * selected mode means. A segmented control because the three options are
 * mutually exclusive and few. Inside <Field label="Memory"> the label
 * names the group and a click on it focuses the chosen mode; the line
 * under it is read with the group.
 */
export function MemoryModeControl({
  value,
  onChange,
  disabled,
  id,
  "aria-labelledby": labelledBy,
  "aria-describedby": describedBy,
  "aria-invalid": invalid,
}: {
  value: MemoryMode;
  onChange: (mode: MemoryMode) => void;
  disabled?: boolean;
} & FieldControlProps) {
  const active = MEMORY_MODE_OPTIONS.find((o) => o.value === value) ?? MEMORY_MODE_OPTIONS[0];
  const hintId = `${id ?? "memory-mode"}-meaning`;
  return (
    <div aria-disabled={disabled || undefined} className={cn(disabled && "pointer-events-none opacity-50")}>
      <SegmentedControl<MemoryMode>
        id={id}
        label="Memory"
        aria-labelledby={labelledBy}
        aria-describedby={[hintId, describedBy].filter(Boolean).join(" ")}
        aria-invalid={invalid}
        value={value}
        onChange={onChange}
        options={MEMORY_MODE_OPTIONS.map(({ value: v, label }) => ({ value: v, label }))}
      />
      <p id={hintId} className="mt-1.5 text-xs text-fg-subtle">
        {active.hint}
      </p>
    </div>
  );
}
