import type { CSSProperties, ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Grouped inset list — the System Settings building block.
 *
 *   <GroupSection title="General" footer="Shown to people who…">
 *     <GroupRow label="Name" value="Standup poster" />
 *     <GroupRow label="Model" value={<code>…</code>} />
 *   </GroupSection>
 *
 * A section is a header (15px semibold) above a rounded 12px surface whose
 * rows are split by hairlines inset 16px from the leading edge. Rows put
 * the label on the left and the value or control on the right. All
 * styling comes from tokens (.sq-group / .sq-row in index.css), so light
 * and dark follow automatically.
 */
export function GroupSection({
  title,
  description,
  action,
  footer,
  children,
  className,
  groupClassName,
}: {
  title?: ReactNode;
  description?: ReactNode;
  /** Trailing control on the header line (e.g. a small link button). */
  action?: ReactNode;
  /** Small secondary text under the group. */
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
  groupClassName?: string;
}) {
  return (
    <section className={cn("min-w-0", className)}>
      {(title || action) && (
        <div className="flex items-end justify-between gap-3 mb-2 px-1">
          <div className="min-w-0">
            {title && <h2 className="sq-section-title">{title}</h2>}
            {description && (
              <p className="mt-0.5 text-[12px] text-fg-muted">{description}</p>
            )}
          </div>
          {action && <div className="shrink-0 flex items-center gap-2">{action}</div>}
        </div>
      )}
      <Group className={groupClassName}>{children}</Group>
      {footer && <p className="mt-2 px-4 text-[12px] text-fg-subtle">{footer}</p>}
    </section>
  );
}

export function Group({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("sq-group", className)}>{children}</div>;
}

/**
 * One row of a grouped list. `label` on the leading edge, `value` (text or
 * any control) on the trailing edge. Pass `mono` for ids / hashes, `stack`
 * to put long values under the label instead of beside it.
 */
export function GroupRow({
  label,
  value,
  detail,
  icon,
  mono,
  stack,
  className,
  children,
}: {
  label?: ReactNode;
  value?: ReactNode;
  /** Secondary line under the label. */
  detail?: ReactNode;
  /** Leading glyph (16px) — rows with icons get a deeper hairline inset. */
  icon?: ReactNode;
  mono?: boolean;
  stack?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "sq-row flex min-h-11 gap-3 px-4 py-2.5",
        stack ? "flex-col items-stretch gap-1.5" : "items-center",
        className,
      )}
      style={icon ? ({ "--sq-inset": "44px" } as CSSProperties) : undefined}
    >
      {children ?? (
        <>
          <div className={cn("flex min-w-0 items-center gap-3", !stack && "flex-1")}>
            {icon && <span className="shrink-0 text-fg-muted [&_svg]:size-4">{icon}</span>}
            <div className="min-w-0">
              <div className="text-[13px] text-fg">{label}</div>
              {detail && <div className="text-[12px] text-fg-subtle truncate">{detail}</div>}
            </div>
          </div>
          {value !== undefined && (
            <div
              className={cn(
                "min-w-0 text-[13px] text-fg-muted",
                stack ? "" : "text-right max-w-[65%] truncate",
                mono && "font-mono text-[12px]",
              )}
            >
              {value}
            </div>
          )}
        </>
      )}
    </div>
  );
}
