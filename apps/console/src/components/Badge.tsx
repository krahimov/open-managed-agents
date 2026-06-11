import type { ReactNode } from "react";

/**
 * Status pill — small colored chip that represents a state (idle / running /
 * completed / errored / terminated). Used in session header + turn cards.
 *
 * Tones map to design-system status colors. `running` gets an animated dot
 * to communicate "in progress" without users staring for a status change.
 */
export type StatusTone = "idle" | "running" | "completed" | "errored" | "terminated" | "neutral";

/* Quiet dot+text status — color appears as a 6px dot, not a filled chip,
 * so state reads at a glance without competing with the accent. `running`
 * pulses; everything else is static. */
const TONE_TEXT: Record<StatusTone, string> = {
  idle: "text-fg-muted",
  running: "text-info",
  completed: "text-success",
  errored: "text-danger",
  terminated: "text-danger",
  neutral: "text-fg-muted",
};

const TONE_DOT: Record<StatusTone, string> = {
  idle: "bg-fg-subtle",
  running: "bg-info",
  completed: "bg-success",
  errored: "bg-danger",
  terminated: "bg-danger",
  neutral: "bg-fg-subtle",
};

export function StatusPill({ status, label }: { status: StatusTone | string; label?: string }) {
  const tone: StatusTone = (TONE_TEXT as Record<string, unknown>)[status] ? (status as StatusTone) : "neutral";
  const text = label ?? (status[0]?.toUpperCase() + status.slice(1));
  return (
    <span className={`inline-flex items-center gap-1.5 text-[11px] font-medium ${TONE_TEXT[tone]}`}>
      <span
        className={`inline-block w-1.5 h-1.5 rounded-full ${TONE_DOT[tone]} ${
          tone === "running" ? "animate-pulse" : ""
        }`}
      />
      {text}
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
      {icon && <span className="text-fg-subtle shrink-0 flex">{icon}</span>}
      <span className="truncate">{label}</span>
    </>
  );
  if (onClick) {
    return (
      <button
        onClick={onClick}
        className="text-[11px] px-2 py-0.5 min-h-11 sm:min-h-0 rounded border border-border hover:border-border-strong hover:bg-bg-surface text-fg-muted flex items-center gap-1.5 font-mono max-w-xs"
        title={title ?? (typeof label === "string" ? label : undefined)}
      >
        {inner}
      </button>
    );
  }
  return (
    <span
      className="text-[11px] px-2 py-0.5 text-fg-subtle font-mono flex items-center gap-1.5"
      title={title}
    >
      {inner}
    </span>
  );
}
