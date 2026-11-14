import type { ReactNode } from "react";
import type { AgentMemoryConfig } from "@open-managed-agents/api-types";

import { cn } from "@/lib/utils";

import type { FieldControlProps } from "./Field";
import { SegmentedControl } from "./SegmentedControl";

/** Memory mode for an agent — mirrors `_oma.memory.mode` on the wire.
 *
 *  An absent `_oma.memory` means "never configured": off, but the server
 *  switches memory on by itself when the agent gets its first trigger
 *  (every run is a fresh session). A person's "Off" is therefore always
 *  written as `{ mode: "off" }` (keeping `store_id`, so turning memory back
 *  on finds the same notes), never as null or a missing field. */
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

type StoredMemory = (AgentMemoryConfig & Record<string, unknown>) | null | undefined;

/**
 * The `_oma.memory` to write for `mode`, given what the agent has now.
 * Off keeps the store (`{ mode: "off", store_id }`), Shared keeps it too,
 * Per user drops it (each person gets their own store; the server refuses a
 * store_id there). The same mode keeps the stored object as it is.
 */
export function memoryForWire(mode: MemoryMode, current?: StoredMemory): AgentMemoryConfig {
  if (current && current.mode === mode) return current as AgentMemoryConfig;
  if (mode === "per_user") return { mode };
  const storeId = typeof current?.store_id === "string" && current.store_id ? current.store_id : undefined;
  return storeId ? { mode, store_id: storeId } : { mode };
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
  note,
}: {
  value: MemoryMode;
  onChange: (mode: MemoryMode) => void;
  disabled?: boolean;
  /** Said under the control instead of the selected mode's meaning (for
   *  example why memory is on before anyone chose it). */
  note?: ReactNode;
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
        {note ?? active.hint}
      </p>
    </div>
  );
}
