/** Memory mode for an agent — mirrors `_oma.memory.mode` on the wire.
 *  `off` is the server default when the field is absent, so it is never
 *  stored: create omits `_oma.memory`, update sends `_oma.memory: null`. */
export type MemoryMode = "off" | "shared" | "per_user";

export const MEMORY_MODE_OPTIONS: Array<{ value: MemoryMode; label: string; hint: string }> = [
  {
    value: "off",
    label: "Off",
    hint: "No cross-session memory. Nothing the user says persists.",
  },
  {
    value: "shared",
    label: "Shared",
    hint: "One memory for this agent — every session reads and writes it. For single-operator assistants.",
  },
  {
    value: "per_user",
    label: "Per user",
    hint: "A separate memory per user talking to this agent. For customer-facing agents.",
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

/** Segmented control: Off · Shared · Per user, with a hint that tracks the
 *  selection. Inset track, coral (--brand) fill on the active segment. */
export function MemoryModeControl({
  value,
  onChange,
  disabled,
  id = "agent-memory-mode",
}: {
  value: MemoryMode;
  onChange: (mode: MemoryMode) => void;
  disabled?: boolean;
  id?: string;
}) {
  const active = MEMORY_MODE_OPTIONS.find((o) => o.value === value) ?? MEMORY_MODE_OPTIONS[0];
  return (
    <div>
      <div
        id={id}
        role="radiogroup"
        aria-label="Memory"
        className="inline-flex items-center gap-0.5 p-0.5 rounded-md bg-bg-inset border border-border"
      >
        {MEMORY_MODE_OPTIONS.map((opt) => {
          const selected = opt.value === value;
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled}
              onClick={() => onChange(opt.value)}
              className={`px-3 py-1 text-sm rounded-[5px] transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] disabled:opacity-50 disabled:cursor-not-allowed ${
                selected
                  ? "bg-brand text-brand-fg font-medium shadow-sm"
                  : "text-fg-muted hover:text-fg hover:bg-bg-surface/70"
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
      <p className="text-xs text-fg-muted mt-1">{active.hint}</p>
    </div>
  );
}
