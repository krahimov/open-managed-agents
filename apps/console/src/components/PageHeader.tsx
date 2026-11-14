import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useOutletContext } from "react-router";

import { cn } from "@/lib/utils";

import { useCrumbs } from "./AppBreadcrumb";
import type { AppOutletContext } from "./AppShell";
import { usePageColumn, useRegisterPageWidth, type PageWidth } from "./Page";

/**
 * Page header — rendered via portal into AppShell's `pageHeaderSlot`,
 * which sits ABOVE the scroll container. It never scrolls.
 *
 * Use it for LIST and INDEX pages: a title, a one-line description, the
 * page's primary action, and (optionally) a toolbar row.
 *
 *   <PageHeader
 *     title="Environments"
 *     subtitle="Sandboxes your agents run in."
 *     actions={<Button>New environment</Button>}
 *     toolbar={<ListToolbar … />}
 *   />
 *
 * Detail pages do NOT use the title slot: they render <DetailHeader> in
 * the page flow so the identity scrolls with the record.
 *
 * Slots, all optional:
 *   title / subtitle   page name (text-h1) and a one-line description.
 *                      On a top-level route `title` defaults to the route's
 *                      breadcrumb label, so every list page has a heading.
 *   actions            right side of the title row; the primary button is
 *                      last (rightmost)
 *   toolbar            second row: search, filter chips, view switch
 *   tableHeader        used by DataTable for its pinned column header
 *
 * The header sits in the same column as the <Page> below it (usePageColumn):
 * on a top-level page that is the shared left edge, so the title of
 * Sessions, Usage and Workspace starts at the same x.
 */
interface PageHeaderProps {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  toolbar?: ReactNode;
  tableHeader?: ReactNode;
  /** Match the <Page width> below it. */
  width?: PageWidth;
  className?: string;
}

export function PageHeader(props: PageHeaderProps) {
  const ctx = useOutletContext<AppOutletContext | undefined>();
  const slot = ctx?.pageHeaderSlot;
  // No shell (unit tests, pages outside AppShell): nothing to portal into.
  if (!slot) return null;
  return <PageHeaderPortal {...props} slot={slot} />;
}

function PageHeaderPortal({
  title: titleProp,
  subtitle,
  actions,
  toolbar,
  tableHeader,
  width = "default",
  className,
  slot,
}: PageHeaderProps & { slot: HTMLDivElement }) {
  useRegisterPageWidth(width);
  const column = usePageColumn(width);
  // A top-level page that passes no title is named by its route: the
  // breadcrumb bar is hidden there, so the header must say where you are.
  const crumbs = useCrumbs();
  const title = titleProp ?? (crumbs.length === 1 ? crumbs[0].label : undefined);

  const hasTopRow = !!title || !!subtitle || !!actions;
  if (!hasTopRow && !toolbar && !tableHeader) return null;

  return createPortal(
    <div data-slot="page-header" className={className}>
      {hasTopRow && (
        <div className={column.outer}>
          <div
            className={cn(
              column.inner,
              "flex items-center gap-4 pb-3",
              // No breadcrumb bar above (top-level page): the title needs air.
              "pt-7 group-data-[topbar=true]/panel:pt-1.5",
            )}
          >
            <div className="min-w-0 flex-1">
              {title && <h1 className="truncate text-h1 text-fg">{title}</h1>}
              {subtitle && <p className="mt-1 max-w-[72ch] text-sm text-fg-muted">{subtitle}</p>}
            </div>
            {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
          </div>
        </div>
      )}
      {toolbar && (
        <div className={column.outer}>
          <div
            className={cn(
              column.inner,
              "flex items-center gap-2 pb-3",
              hasTopRow ? "pt-1" : "pt-5 group-data-[topbar=true]/panel:pt-1.5",
            )}
          >
            {toolbar}
          </div>
        </div>
      )}
      {tableHeader && (
        <div className={column.outer}>
          <div className={column.inner || undefined}>{tableHeader}</div>
        </div>
      )}
    </div>,
    slot,
  );
}
