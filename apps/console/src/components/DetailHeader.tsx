import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import { Wash } from "./Wash";

/**
 * The header of a record page: who/what this is, what state it is in, the
 * few facts that matter, and what you can do.
 *
 *   <DetailHeader
 *     avatar={<AgentAvatar name={agent.name} id={agent.id} size="xl" />}
 *     title={agent.name}
 *     status={<StatusBadge status="active" variant="soft" />}
 *     description={agent.description}
 *     meta={<><ModelBadge model={agent.model} /><Chip tone="outline" mono>v{agent.version}</Chip><IdChip id={agent.id} /></>}
 *     actions={<><Button variant="outline">Edit</Button><Button>Start session</Button></>}
 *     menu={<RowActionsMenu actions={[…archive, delete]} />}
 *   />
 *
 * Rules:
 *   - It renders in the page flow (inside <Page>), not in <PageHeader>.
 *   - `actions`: at most one primary (ink) button, placed LAST. Secondary
 *     actions are `variant="outline"`. Anything destructive or rare goes in
 *     `menu` (a "more" menu), never as a visible button.
 *   - `meta` is a single row of chips. The id appears here once, as an
 *     <IdChip>, last.
 *   - `wash` adds the brand wash behind the header, edge to edge in the
 *     panel. Agent profile only.
 *   - `children` renders under the header, typically a <TabBar>.
 */
export function DetailHeader({
  avatar,
  title,
  status,
  description,
  meta,
  actions,
  menu,
  wash,
  children,
  className,
}: {
  avatar?: ReactNode;
  title: ReactNode;
  status?: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  menu?: ReactNode;
  /** `true` on a page (portalled to the panel backdrop); `"inline"` inside a card. */
  wash?: boolean | "inline";
  children?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("relative", className)}>
      {wash === "inline" ? (
        // In place, for a header drawn inside a card (the kit page). First
        // in DOM order, no z-index: content below is `relative` and paints
        // over it without creating a stacking context.
        <div
          aria-hidden="true"
          className="wash-corner pointer-events-none absolute -inset-x-5 -top-16 h-56 opacity-80 [mask-image:linear-gradient(to_bottom,black_20%,transparent)] lg:-inset-x-8"
        />
      ) : wash ? (
        // On a page: in the panel's backdrop, so it runs edge to edge under
        // the top bar and recedes as the page scrolls. (Sized to the page
        // column it showed as a tinted rectangle on wide panels.)
        <Wash variant="header" className="h-64" />
      ) : null}
      <div className="relative flex flex-col gap-5 pt-4 pb-6 md:flex-row md:items-start">
        {avatar && <div className="shrink-0">{avatar}</div>}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <h1 className="min-w-0 text-h1 break-words text-fg">{title}</h1>
            {status}
          </div>
          {description && (
            <p className="mt-1.5 max-w-[72ch] text-[0.9375rem] leading-relaxed text-fg-muted">{description}</p>
          )}
          {meta && <div className="mt-3.5 flex flex-wrap items-center gap-1.5">{meta}</div>}
        </div>
        {(actions || menu) && (
          <div className="flex shrink-0 items-center gap-2 md:pt-0.5">
            {actions}
            {menu}
          </div>
        )}
      </div>
      {children && <div className="relative">{children}</div>}
    </header>
  );
}
