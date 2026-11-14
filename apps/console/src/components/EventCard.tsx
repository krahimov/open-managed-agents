import { useState, type ComponentType, type ReactNode } from "react";
import {
  BanIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  LightbulbIcon,
  LoaderCircleIcon,
  PlugIcon,
  ShieldAlertIcon,
  TerminalIcon,
  XIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";

import { CopyButton } from "./IdChip";

/**
 * EventCard — everything an agent DOES in a conversation that is not prose:
 * tool calls, MCP calls, thinking, approval requests and errors. One
 * anatomy, five looks, so the session view reads as one system (chat and
 * timeline both use it).
 *
 *   <EventCard kind="tool" title="bash" subtitle="pytest -q tests/billing" status="completed" meta="4.1s">
 *     <EventSection label="Input" copy={command}><CodeWell>{command}</CodeWell></EventSection>
 *     <EventSection label="Output"><CodeWell>{output}</CodeWell></EventSection>
 *   </EventCard>
 *
 *   <EventCard kind="mcp" source="Linear" title="create_issue" subtitle="SUP-482 · SSO login loop" status="running" />
 *
 *   <EventCard kind="thinking" title="Thought for 4 seconds">…reasoning text…</EventCard>
 *
 *   <EventCard kind="approval" title="Finance Ops Reconciler wants to run bash"
 *              actions={<><Button size="sm">Allow</Button><Button size="sm" variant="outline">Deny</Button></>}>
 *     <CodeWell>{command}</CodeWell>
 *   </EventCard>
 *
 *   <EventCard kind="error" title="The model request failed" subtitle="insufficient_quota"
 *              actions={<Button size="sm" variant="outline">Retry</Button>}>
 *     {message}
 *   </EventCard>
 *
 * Looks:
 *   tool / mcp  a soft-fill row, 40px tall when closed: icon · name (mono)
 *               · one-line preview · duration · state. Opens to show input
 *               and output in code wells. Closed by default.
 *   thinking    no fill, muted: it folds away. While `status="running"` the
 *               title shimmers.
 *   approval    amber tint, hairline, ALWAYS open, with its actions in a
 *               footer row. It cannot be collapsed: a person is blocking.
 *   error       red tint (in dark the surface with a red edge), always open.
 *
 * State (right side of the row): running → spinner, completed → check,
 * errored → ×, denied → ban. Colour is only on the glyph.
 */
export type EventKind = "tool" | "mcp" | "thinking" | "approval" | "error";
export type EventStatus = "running" | "completed" | "errored" | "denied" | "pending";

const KIND_ICON: Record<EventKind, ComponentType<{ className?: string }>> = {
  tool: TerminalIcon,
  mcp: PlugIcon,
  thinking: LightbulbIcon,
  approval: ShieldAlertIcon,
  error: CircleAlertIcon,
};

function StateGlyph({ status }: { status?: EventStatus }) {
  if (status === "running")
    return <LoaderCircleIcon className="size-4 animate-spin text-info" aria-label="Running" />;
  if (status === "completed") return <CheckIcon className="size-4 text-success" aria-label="Completed" />;
  if (status === "errored") return <XIcon className="size-4 text-danger" aria-label="Failed" />;
  if (status === "denied") return <BanIcon className="size-4 text-fg-subtle" aria-label="Denied" />;
  return null;
}

export function EventCard({
  kind,
  title,
  subtitle,
  source,
  icon,
  status,
  meta,
  actions,
  defaultOpen,
  open: controlledOpen,
  onOpenChange,
  children,
  className,
}: {
  kind: EventKind;
  /** Tool name ("bash"), thought summary, or the approval/error sentence. */
  title: ReactNode;
  /** One-line preview of the input, or the error code. Truncates. */
  subtitle?: ReactNode;
  /** MCP server / app name, shown before the tool name ("Linear"). */
  source?: string;
  icon?: ComponentType<{ className?: string }>;
  status?: EventStatus;
  /** Right-aligned quiet text: a duration ("4.1s"). */
  meta?: ReactNode;
  /** Buttons for approval and error cards (size="sm"). */
  actions?: ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Body: EventSections, CodeWells or text. */
  children?: ReactNode;
  className?: string;
}) {
  const alwaysOpen = kind === "approval" || kind === "error";
  const [internal, setInternal] = useState(defaultOpen ?? false);
  const open = alwaysOpen || (controlledOpen ?? internal);
  const hasBody = !!children;
  const Icon = icon ?? KIND_ICON[kind];
  const toggle = () => {
    if (alwaysOpen || !hasBody) return;
    const next = !open;
    if (controlledOpen === undefined) setInternal(next);
    onOpenChange?.(next);
  };

  // ── approval / error: tinted, always open ──────────────────────────
  if (alwaysOpen) {
    const approval = kind === "approval";
    return (
      <div
        role={approval ? "group" : "alert"}
        aria-label={approval ? "Approval needed" : undefined}
        className={cn(
          "animate-rise-in rounded-lg border",
          approval ? "border-warning/30 bg-warning-subtle" : "border-[var(--failed-border)] bg-[var(--failed-bg)]",
          className,
        )}
      >
        <div className="flex items-start gap-3 px-4 pt-3.5">
          <span
            className={cn(
              "flex size-7 shrink-0 items-center justify-center rounded-[8px] bg-bg-surface shadow-[var(--shadow-xs)] dark:bg-bg-soft",
              approval ? "text-warning" : "text-danger",
            )}
          >
            <Icon className="size-4" />
          </span>
          <div className="min-w-0 flex-1 py-0.5">
            <p className="text-sm font-medium text-fg">{title}</p>
            {subtitle && <p className="mt-0.5 text-small text-fg-muted">{subtitle}</p>}
          </div>
          {meta && <span className="shrink-0 py-1 text-xs text-fg-subtle">{meta}</span>}
        </div>
        {hasBody && <div className="space-y-3 px-4 pt-3 text-small text-fg">{children}</div>}
        {actions ? (
          <div className="flex flex-wrap items-center gap-2 px-4 pt-3.5 pb-4">{actions}</div>
        ) : (
          <div className="h-4" />
        )}
      </div>
    );
  }

  // ── thinking: bare, muted ──────────────────────────────────────────
  if (kind === "thinking") {
    return (
      <div className={className}>
        <button
          type="button"
          aria-expanded={hasBody ? open : undefined}
          onClick={toggle}
          className={cn(
            "group/ev -ml-1.5 inline-flex h-8 max-w-full items-center gap-2 rounded-full pr-2.5 pl-1.5 text-small-size text-fg-muted transition-quick",
            hasBody && "hover:bg-bg-hover hover:text-fg",
          )}
        >
          <Icon className="size-4 shrink-0 text-fg-subtle" />
          <span className={cn("truncate", status === "running" && "text-shimmer")}>{title}</span>
          {hasBody && (
            <ChevronRightIcon
              className={cn(
                "size-3.5 shrink-0 text-fg-faint transition-transform duration-[var(--dur-base)] ease-[var(--ease-rise)]",
                open && "rotate-90",
              )}
            />
          )}
        </button>
        {open && hasBody && (
          <div className="mt-1 ml-[7px] animate-fade-in border-l border-border-strong pl-4 text-small leading-relaxed whitespace-pre-wrap text-fg-muted">
            {children}
          </div>
        )}
      </div>
    );
  }

  // ── tool / mcp: soft row that opens ────────────────────────────────
  return (
    <div className={cn("rounded-lg bg-bg-soft transition-quick", open && "bg-bg-soft", className)}>
      <button
        type="button"
        aria-expanded={hasBody ? open : undefined}
        onClick={toggle}
        className={cn(
          "group/ev flex h-10 w-full min-w-0 items-center gap-2.5 rounded-lg pr-3 pl-2.5 text-left transition-quick",
          hasBody ? "hover:bg-bg-hover" : "cursor-default",
        )}
      >
        <Icon className="size-4 shrink-0 text-fg-subtle" />
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="shrink-0 font-mono text-small-size font-medium text-fg">
            {source && <span className="font-sans font-normal text-fg-muted">{source} · </span>}
            {title}
          </span>
          {subtitle && <span className="min-w-0 truncate font-mono text-xs text-fg-subtle">{subtitle}</span>}
        </span>
        {meta && <span className="shrink-0 text-xs text-fg-subtle">{meta}</span>}
        <StateGlyph status={status} />
        {hasBody && (
          <ChevronRightIcon
            className={cn(
              "size-3.5 shrink-0 text-fg-faint transition-transform duration-[var(--dur-base)] ease-[var(--ease-rise)]",
              open && "rotate-90",
            )}
          />
        )}
      </button>
      {open && hasBody && <div className="animate-fade-in space-y-3 px-3 pt-1 pb-3">{children}</div>}
    </div>
  );
}

/** A labelled part of an event body ("Input", "Output"), with optional copy. */
export function EventSection({
  label,
  copy,
  children,
}: {
  label: string;
  /** Text to copy with the section's copy button. */
  copy?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 flex h-6 items-center justify-between">
        <span className="text-xs font-medium text-fg-subtle">{label}</span>
        {copy !== undefined && <CopyButton value={copy} label={`Copy ${label.toLowerCase()}`} className="size-6" />}
      </div>
      {children}
    </div>
  );
}

/**
 * A block of code or raw output: mono, horizontally scrollable, capped at
 * ~18 lines. `tone="danger"` for stderr / error payloads.
 */
export function CodeWell({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: "neutral" | "danger";
  className?: string;
}) {
  return (
    <pre
      className={cn(
        "max-h-72 overflow-auto rounded-md border border-border bg-bg-surface px-3 py-2.5 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap dark:bg-bg-inset",
        tone === "danger" ? "text-danger" : "text-fg",
        className,
      )}
    >
      {children}
    </pre>
  );
}
