import type { ReactNode } from "react";

/**
 * Status pill — small colored chip that represents a state (idle / running /
 * completed / errored / terminated). Used in session header + turn cards.
 *
 * Tones map to design-system status colors. `running` gets an animated dot
 * to communicate "in progress" without users staring for a status change.
 */
export type StatusTone = "idle" | "running" | "waiting" | "completed" | "errored" | "terminated" | "neutral";

/* Quiet dot + label status. Colour lives in a 7px dot (with a soft halo
 * so it reads on any surface); the label stays neutral for resting states
 * and picks up the tone only when something needs attention. `running`
 * breathes; everything else is static. */
const TONE_TEXT: Record<StatusTone, string> = {
  idle: "text-fg-muted",
  running: "text-info",
  waiting: "text-warning",
  completed: "text-fg-muted",
  errored: "text-danger",
  terminated: "text-danger",
  neutral: "text-fg-muted",
};

const TONE_DOT: Record<StatusTone, string> = {
  idle: "bg-fg-subtle/70 shadow-[0_0_0_3px_color-mix(in_srgb,var(--fg-subtle)_14%,transparent)]",
  running: "bg-info shadow-[0_0_0_3px_color-mix(in_srgb,var(--info)_20%,transparent)]",
  waiting: "bg-warning shadow-[0_0_0_3px_color-mix(in_srgb,var(--warning)_20%,transparent)]",
  completed: "bg-success shadow-[0_0_0_3px_color-mix(in_srgb,var(--success)_18%,transparent)]",
  errored: "bg-danger shadow-[0_0_0_3px_color-mix(in_srgb,var(--danger)_18%,transparent)]",
  terminated: "bg-danger shadow-[0_0_0_3px_color-mix(in_srgb,var(--danger)_18%,transparent)]",
  neutral: "bg-fg-subtle/70 shadow-[0_0_0_3px_color-mix(in_srgb,var(--fg-subtle)_14%,transparent)]",
};

/** Map loose server status strings onto a tone. */
const STATUS_ALIASES: Record<string, StatusTone> = {
  active: "completed",
  live: "completed",
  ready: "completed",
  success: "completed",
  succeeded: "completed",
  error: "errored",
  failed: "errored",
  archived: "neutral",
  building: "running",
  pending: "waiting",
};

export function StatusPill({ status, label }: { status: StatusTone | string; label?: string }) {
  const tone: StatusTone = (TONE_TEXT as Record<string, unknown>)[status]
    ? (status as StatusTone)
    : STATUS_ALIASES[status] ?? "neutral";
  const text = label ?? (status[0]?.toUpperCase() + status.slice(1));
  return (
    <span className={`inline-flex items-center gap-2 text-[12.5px] font-medium ${TONE_TEXT[tone]}`}>
      <span
        aria-hidden="true"
        className={`inline-block size-[7px] shrink-0 rounded-full ${TONE_DOT[tone]} ${
          tone === "running" ? "animate-pulse" : ""
        }`}
      />
      {text}
    </span>
  );
}

/**
 * Monospace ID chip — quiet tinted capsule for resource identifiers in
 * lists and headers. Truncates inside its column; full id on hover.
 */
export function IdChip({ id, className = "" }: { id: string; className?: string }) {
  return (
    <span
      title={id}
      className={`inline-flex h-6 max-w-full items-center truncate rounded-md bg-fill px-2 font-mono text-[11.5px] text-fg-muted ${className}`.trim()}
    >
      <span className="truncate">{id}</span>
    </span>
  );
}

/**
 * Generic interactive badge — icon + label with hover affordance and
 * optional click. Used by session-header resource badges (agent / env /
 * vault) and similar contexts where a chip should feel clickable.
 *
 * For non-interactive labels (duration, age, count), pass no onClick;
 * the badge renders as a plain span without hover styling.
 */
export function Badge({
  icon,
  label,
  title,
  onClick,
}: {
  icon?: ReactNode;
  label: ReactNode;
  title?: string;
  onClick?: () => void;
}) {
  const inner = (
    <>
      {icon && <span className="text-fg-subtle shrink-0 flex [&_svg]:size-3.5">{icon}</span>}
      <span className="truncate">{label}</span>
    </>
  );
  if (onClick) {
    return (
      <button
        onClick={onClick}
        className="text-[12px] font-medium h-7 px-2.5 min-h-11 sm:min-h-0 rounded-full bg-fill hover:bg-fill-strong text-fg-muted hover:text-fg flex items-center gap-1.5 max-w-xs transition-colors duration-[var(--dur-base)] press"
        title={title ?? (typeof label === "string" ? label : undefined)}
      >
        {inner}
      </button>
    );
  }
  return (
    <span
      className="text-[12px] h-7 px-1.5 text-fg-subtle flex items-center gap-1.5 tabular-nums"
      title={title}
    >
      {inner}
    </span>
  );
}
