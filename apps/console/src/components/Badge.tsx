import type { ComponentType, ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Status and labels.
 *
 * <StatusBadge>  the state of a thing (session, run, deployment, key…).
 *                One vocabulary for the whole product — see STATUS below.
 *                `variant="dot"` (default) is a coloured dot + label for
 *                tables and dense rows; `variant="soft"` is a tinted pill
 *                for headers and cards.
 * <Chip>         a fact about a record ("3 tools", "v4", "Slack"). Neutral
 *                by default; a tone only when the fact itself is a state.
 * <StatusPill>   legacy name for <StatusBadge variant="dot">.
 * <Badge>        legacy mono chip used by the session header.
 */

export type StatusTone = "neutral" | "info" | "success" | "warning" | "danger" | "plum";

interface StatusDef {
  tone: StatusTone;
  label: string;
  /** Animated halo: the thing is live right now. */
  live?: boolean;
}

/**
 * The status vocabulary. Colour meaning is fixed:
 *   info (blue)     working right now
 *   success (green) finished well / healthy / enabled
 *   warning (amber) waiting on a person, or degraded
 *   danger (red)    failed
 *   neutral (grey)  at rest, ended, archived, off, or waiting on nobody
 *
 * Every state the product shows is named here once: session lifecycle,
 * generic lifecycle, publications (Slack, GitHub, Linear), skill scans and
 * eval verdicts. A slice may add words around a state (what a scan result
 * means, what a verdict counts) but never its own label or tone.
 */
const STATUS: Record<string, StatusDef> = {
  // sessions
  running: { tone: "info", label: "Running", live: true },
  idle: { tone: "neutral", label: "Idle" },
  // The runtime's word is "rescheduling": it is trying the turn again after
  // a transient failure.
  rescheduling: { tone: "warning", label: "Retrying", live: true },
  terminated: { tone: "neutral", label: "Ended" },
  approval: { tone: "warning", label: "Needs approval" },
  errored: { tone: "danger", label: "Failed" },
  // generic lifecycle
  active: { tone: "success", label: "Active" },
  enabled: { tone: "success", label: "Enabled" },
  ready: { tone: "success", label: "Ready" },
  online: { tone: "success", label: "Online" },
  connected: { tone: "success", label: "Connected" },
  completed: { tone: "success", label: "Completed" },
  success: { tone: "success", label: "Success" },
  passed: { tone: "success", label: "Passed" },
  published: { tone: "success", label: "Published" },
  pending: { tone: "warning", label: "Pending" },
  // Waiting for a runner, not for a person: neutral, not amber.
  queued: { tone: "neutral", label: "Queued" },
  provisioning: { tone: "info", label: "Provisioning", live: true },
  in_progress: { tone: "info", label: "In progress", live: true },
  degraded: { tone: "warning", label: "Degraded" },
  warning: { tone: "warning", label: "Warning" },
  failed: { tone: "danger", label: "Failed" },
  error: { tone: "danger", label: "Error" },
  dead_letter: { tone: "danger", label: "Failed" },
  expired: { tone: "danger", label: "Expired" },
  revoked: { tone: "danger", label: "Revoked" },
  offline: { tone: "neutral", label: "Offline" },
  disabled: { tone: "neutral", label: "Disabled" },
  archived: { tone: "neutral", label: "Archived" },
  draft: { tone: "neutral", label: "Draft" },
  cancelled: { tone: "neutral", label: "Cancelled" },
  canceled: { tone: "neutral", label: "Cancelled" },
  // publications: an agent published into Slack, GitHub or Linear
  live: { tone: "success", label: "Live" },
  pending_setup: { tone: "warning", label: "Setup not finished" },
  credentials_filled: { tone: "warning", label: "Ready to install" },
  awaiting_install: { tone: "warning", label: "Waiting for install" },
  needs_reauth: { tone: "danger", label: "Needs reconnecting" },
  unpublished: { tone: "neutral", label: "Unpublished" },
  // skill security scans
  curated: { tone: "success", label: "Curated" },
  approved: { tone: "success", label: "Approved" },
  flagged: { tone: "warning", label: "Flagged" },
  quarantined: { tone: "warning", label: "Awaiting review" },
  blocked: { tone: "danger", label: "Blocked" },
  rejected: { tone: "danger", label: "Blocked" },
  // eval verdicts
  flaky: { tone: "warning", label: "Flaky" },
  ungraded: { tone: "neutral", label: "Not graded" },
  neutral: { tone: "neutral", label: "" },
};

export function statusDef(status: string | undefined | null): StatusDef {
  const key = (status ?? "").toLowerCase();
  if (STATUS[key]) return STATUS[key];
  const label = key ? key[0].toUpperCase() + key.slice(1).replace(/_/g, " ") : "Unknown";
  return { tone: "neutral", label };
}

const TONE_TEXT: Record<StatusTone, string> = {
  neutral: "text-fg-muted",
  info: "text-info",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  plum: "text-plum",
};

const TONE_DOT: Record<StatusTone, string> = {
  neutral: "bg-fg-faint text-fg-faint",
  info: "bg-info-solid text-info-solid",
  success: "bg-success-solid text-success-solid",
  warning: "bg-warning-solid text-warning-solid",
  danger: "bg-danger-solid text-danger-solid",
  plum: "bg-plum text-plum",
};

const TONE_SOFT: Record<StatusTone, string> = {
  neutral: "bg-bg-soft text-fg-muted",
  info: "bg-info-subtle text-info",
  success: "bg-success-subtle text-success",
  warning: "bg-warning-subtle text-warning",
  danger: "bg-danger-subtle text-danger",
  plum: "bg-plum-subtle text-plum",
};

/** The dot on its own, for places that have no room for a label (sidebar
 *  rows, avatars). Always pair with a tooltip or an sr-only label. */
export function StatusDot({
  status,
  tone,
  live,
  className,
}: {
  status?: string;
  tone?: StatusTone;
  live?: boolean;
  className?: string;
}) {
  const def = statusDef(status);
  const t = tone ?? def.tone;
  const isLive = live ?? def.live;
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block size-1.5 shrink-0 rounded-full", TONE_DOT[t], isLive && "live-dot", className)}
    />
  );
}

export function StatusBadge({
  status,
  label,
  variant = "dot",
  tone,
  className,
}: {
  /** A key from the status vocabulary, or any raw status string. */
  status: string;
  /** Override the label. */
  label?: string;
  variant?: "dot" | "soft";
  /** Override the tone (rare: prefer adding the status to the vocabulary). */
  tone?: StatusTone;
  className?: string;
}) {
  const def = statusDef(status);
  const t = tone ?? def.tone;
  const text = label ?? def.label;
  if (variant === "soft") {
    return (
      <span
        className={cn(
          "inline-flex h-[22px] shrink-0 items-center gap-1.5 rounded-full px-2 text-xs leading-none font-medium whitespace-nowrap",
          TONE_SOFT[t],
          className,
        )}
      >
        <StatusDot tone={t} live={def.live} />
        {text}
      </span>
    );
  }
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 text-small leading-none font-medium whitespace-nowrap",
        t === "neutral" ? "text-fg-muted" : TONE_TEXT[t],
        className,
      )}
    >
      <StatusDot tone={t} live={def.live} />
      {text}
    </span>
  );
}

/** Legacy alias: dot + label. */
export function StatusPill({ status, label }: { status: StatusTone | string; label?: string }) {
  return <StatusBadge status={status} label={label} />;
}

const CHIP_TONE: Record<"neutral" | "outline" | StatusTone, string> = {
  neutral: "bg-bg-soft text-fg-muted",
  outline: "border border-border-strong text-fg-muted",
  info: "bg-info-subtle text-info",
  success: "bg-success-subtle text-success",
  warning: "bg-warning-subtle text-warning",
  danger: "bg-danger-subtle text-danger",
  plum: "bg-plum-subtle text-plum",
};

/**
 * A fact on a record. `icon` takes a component (16px grid, drawn at 12px).
 *
 *   <Chip icon={WrenchIcon}>4 tools</Chip>
 *   <Chip tone="outline">v3</Chip>
 */
export function Chip({
  children,
  icon: Icon,
  tone = "neutral",
  mono,
  title,
  className,
}: {
  children: ReactNode;
  icon?: ComponentType<{ className?: string }>;
  tone?: keyof typeof CHIP_TONE;
  /** Monospace content (versions, short ids). */
  mono?: boolean;
  title?: string;
  className?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex h-[22px] max-w-full shrink-0 items-center gap-1 rounded-full px-2 text-xs leading-none font-medium whitespace-nowrap",
        CHIP_TONE[tone],
        mono && "font-mono text-micro-size font-normal",
        className,
      )}
    >
      {Icon && <Icon className="size-3 shrink-0 opacity-80" />}
      <span className="truncate">{children}</span>
    </span>
  );
}

/**
 * Legacy mono chip — icon + label with hover affordance and optional
 * click. Used by session-header resource badges. New code: <Chip> for
 * facts, <EntityRef> for links to another record.
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
      {icon && <span className="flex shrink-0 text-fg-subtle">{icon}</span>}
      <span className="truncate">{label}</span>
    </>
  );
  if (onClick) {
    return (
      <button
        onClick={onClick}
        className="flex h-7 max-w-xs items-center gap-1.5 rounded-full border border-border bg-bg-surface px-2.5 text-xs text-fg-muted transition-quick hover:border-border-strong hover:text-fg"
        title={title ?? (typeof label === "string" ? label : undefined)}
      >
        {inner}
      </button>
    );
  }
  return (
    <span className="flex h-7 items-center gap-1.5 px-1 text-xs text-fg-subtle" title={title}>
      {inner}
    </span>
  );
}
