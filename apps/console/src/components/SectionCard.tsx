import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Page structure.
 *
 * <Section>      an unboxed block of a page: a heading row (title, optional
 *                description, optional action on the right) and content.
 *                Pages are a vertical stack of Sections with `space-y-10`.
 * <SectionCard>  a boxed block: the standard white card (18px radius,
 *                hairline, soft shadow) with an optional header. Use it
 *                for a self-contained group of facts or controls on a
 *                detail or settings page.
 * <Card>         the bare card surface, when you need custom anatomy.
 *
 *   <Section title="Recent sessions" action={<Link to="/sessions">View all</Link>}>…</Section>
 *
 *   <SectionCard title="Triggers" description="When this agent starts on its own."
 *                actions={<Button size="sm" variant="outline">Add trigger</Button>}>
 *     …
 *   </SectionCard>
 */
export function Section({
  title,
  description,
  action,
  children,
  className,
  id,
}: {
  title?: ReactNode;
  description?: ReactNode;
  /** Right-aligned control or link in the heading row. */
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section id={id} className={className}>
      {(title || action) && (
        <div className="mb-4 flex items-end justify-between gap-4">
          <div className="min-w-0">
            {title && <h2 className="text-h2 text-fg">{title}</h2>}
            {description && <p className="mt-0.5 text-small text-fg-muted">{description}</p>}
          </div>
          {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/** Quiet text link for a Section's `action` slot ("View all"). The negative
 *  margin puts its text, not its hover fill, on the section's right edge. */
export const sectionLinkClass =
  "-mr-2.5 inline-flex h-8 items-center gap-1 rounded-full px-2.5 text-small-size font-medium text-fg-muted transition-quick hover:bg-bg-hover hover:text-fg";

export function Card({
  children,
  className,
  interactive,
  as: Tag = "div",
}: {
  children: ReactNode;
  className?: string;
  /** Hover lift + pointer: the whole card is a link or button. */
  interactive?: boolean;
  as?: "div" | "section" | "article" | "li";
}) {
  return <Tag className={cn("surface rounded-xl", interactive && "lift cursor-pointer", className)}>{children}</Tag>;
}

export function SectionCard({
  title,
  description,
  actions,
  children,
  flush,
  footer,
  className,
  id,
}: {
  title?: ReactNode;
  description?: ReactNode;
  /** Right side of the header: small buttons (size="sm"). */
  actions?: ReactNode;
  children: ReactNode;
  /** No body padding: the content is a table or a list of full-width rows. */
  flush?: boolean;
  /** A quiet footer band (totals, "View all"). */
  footer?: ReactNode;
  className?: string;
  id?: string;
}) {
  const hasHeader = !!title || !!actions;
  return (
    <section id={id} className={cn("surface flex flex-col overflow-hidden rounded-xl", className)}>
      {hasHeader && (
        <header className={cn("flex items-start justify-between gap-4 px-5 pt-4", flush ? "pb-3" : "pb-1")}>
          <div className="min-w-0 py-0.5">
            {title && <h3 className="text-h3 text-fg">{title}</h3>}
            {description && <p className="mt-0.5 text-small text-fg-muted">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cn("flex-1", !flush && "px-5 pb-5", !flush && (hasHeader ? "pt-3" : "pt-5"), flush && hasHeader && "border-t border-border")}>
        {children}
      </div>
      {footer && <footer className="border-t border-border bg-bg-inset/60 px-5 py-3 text-small text-fg-muted">{footer}</footer>}
    </section>
  );
}
