import type { ReactNode } from "react";

/**
 * Status pill — small colored chip that represents a state (idle / running /
 * completed / errored / terminated). Used in session header + turn cards.
 *
 * Tones map to design-system status colors. `running` gets an animated dot
 * to communicate "in progress" without users staring for a status change.
 */
export type StatusTone = "idle" | "running" | "waiting" | "completed" | "errored" | "terminated" | "neutral";

/* Tinted capsule status (macOS semantic colours): a subtle fill of the
 * status hue with a 6px dot and same-hue label. `running` pulses;
 * everything else is static. */
const TONE_TEXT: Record<StatusTone, string> = {
  idle: "text-fg-muted",
  running: "text-info",
  waiting: "text-warning",
  completed: "text-success",
  errored: "text-danger",
  terminated: "text-danger",
  neutral: "text-fg-muted",
};

const TONE_BG: Record<StatusTone, string> = {
  idle: "bg-bg-hover dark:bg-white/[0.08]",
  running: "bg-info-subtle",
  waiting: "bg-warning-subtle",
  completed: "bg-success-subtle",
  errored: "bg-danger-subtle",
  terminated: "bg-danger-subtle",
  neutral: "bg-bg-hover dark:bg-white/[0.08]",
};

const TONE_DOT: Record<StatusTone, string> = {
  idle: "bg-fg-subtle",
  running: "bg-info",
  waiting: "bg-warning",
  completed: "bg-success",
  errored: "bg-danger",
  terminated: "bg-danger",
  neutral: "bg-fg-subtle",
};

export function StatusPill({ status, label }: { status: StatusTone | string; label?: string }) {
  const tone: StatusTone = (TONE_TEXT as Record<string, unknown>)[status] ? (status as StatusTone) : "neutral";
  const text = label ?? (status[0]?.toUpperCase() + status.slice(1));
  return (
    <span
      className={`inline-flex items-center gap-1.5 h-5 pl-1.5 pr-2 rounded-full text-[11px] font-medium leading-none whitespace-nowrap ${TONE_TEXT[tone]} ${TONE_BG[tone]}`}
    >
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
        className="sq-press text-[11px] h-6 px-2 min-h-11 sm:min-h-0 rounded-full bg-bg-hover hover:bg-bg-press text-fg-muted hover:text-fg flex items-center gap-1.5 font-mono max-w-xs dark:bg-white/[0.07] dark:hover:bg-white/[0.11]"
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
