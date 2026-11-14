import { Fragment, useEffect, useSyncExternalStore } from "react";
import { Link, useMatches, type UIMatch } from "react-router";
import { ChevronRightIcon } from "lucide-react";

import {
  Breadcrumb as ShadcnBreadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { BRAND_NAME } from "@/lib/brand";
import { useEntityName, type EntityKind } from "@/lib/directory";

import { Skeleton } from "./Skeleton";
import { Tip } from "./Tip";

/**
 * Route handle contract for breadcrumbs. Each route in main.tsx can
 * declare:
 *
 *   handle: { crumb: "Sessions" }                                   fixed label
 *   handle: { crumb: (m) => ({ label: "…", to: "…" }) }             dynamic
 *   handle: { crumb: (m) => ({ entity: { kind: "agent", id } }) }   a record
 *
 * Record crumbs resolve the id to the record's NAME through the workspace
 * directory (lib/directory.ts). The id is never shown in the trail; it is
 * in the tooltip, and on the page as a copyable <IdChip>.
 *
 * A record that the directory does not know (an integration workspace, a
 * one-off page) can name its own crumb from inside the page:
 *
 *   useCrumbLabel(installation?.workspace_name)
 *
 * which replaces the route's fixed label ("Workspace") with the record's
 * name for as long as the page is mounted.
 *
 * Routes that publish no `crumb` are skipped.
 */
type CrumbObject = { label?: string; to?: string; entity?: { kind: EntityKind; id: string } };
type CrumbValue = string | CrumbObject;
type CrumbHandle = { crumb?: CrumbValue | ((m: UIMatch) => CrumbValue) };

export interface Crumb {
  label?: string;
  to: string;
  entity?: { kind: EntityKind; id: string };
}

// Labels published by pages, keyed by pathname. A tiny store rather than a
// context so the page (inside <main>) and the trail (in the top bar) need
// no common provider.
const published = new Map<string, string>();
const watchers = new Set<() => void>();
const watch = (fn: () => void) => {
  watchers.add(fn);
  return () => {
    watchers.delete(fn);
  };
};
let publishedVersion = 0;

/** Name the current page's breadcrumb from inside the page. */
export function useCrumbLabel(label: string | null | undefined, pathname: string = window.location.pathname) {
  useEffect(() => {
    const text = label?.trim();
    if (!text) return;
    published.set(pathname, text);
    publishedVersion++;
    watchers.forEach((fn) => fn());
    return () => {
      published.delete(pathname);
      publishedVersion++;
      watchers.forEach((fn) => fn());
    };
  }, [label, pathname]);
}

/** The active breadcrumb trail. AppShell reads its length to decide whether
 *  a top bar is needed at all (a single crumb is just the page title). */
export function useCrumbs(): Crumb[] {
  const matches = useMatches();
  useSyncExternalStore(
    watch,
    () => publishedVersion,
    () => 0,
  );
  return matches
    .map((m): Crumb | null => {
      const handle = (m.handle ?? {}) as CrumbHandle;
      const raw = typeof handle.crumb === "function" ? handle.crumb(m) : handle.crumb;
      if (!raw) return null;
      const c: CrumbObject = typeof raw === "string" ? { label: raw } : raw;
      const to = c.to ?? m.pathname;
      return { label: published.get(to) ?? c.label, entity: c.entity, to };
    })
    .filter((c): c is Crumb => c !== null);
}

/** What a crumb says: its label, or the record's name once the directory has it. */
function useCrumbText(crumb: Crumb | undefined): string | undefined {
  const { name, noun } = useEntityName(crumb?.entity?.kind ?? "agent", crumb?.entity?.id);
  if (!crumb) return undefined;
  return crumb.entity ? (name ?? noun) : crumb.label;
}

/**
 * The browser tab's title for the current route, read off the same trail:
 *
 *   Sessions · Orrery                       a top-level page
 *   PR Reviewer · Orrery                    a record, by name
 *   Setup · PR Reviewer · Orrery            a page under a record
 *
 * Record names come from the lookups the breadcrumb already makes, so this
 * costs no request. While a name is loading the tab says what kind of
 * record it is ("Session · Orrery").
 */
export function useRouteTitle(): string {
  const crumbs = useCrumbs();
  const page = useCrumbText(crumbs[crumbs.length - 1]);
  const parent = useCrumbText(crumbs.length > 2 ? crumbs[crumbs.length - 2] : undefined);
  return [page, parent, BRAND_NAME].filter(Boolean).join(" · ");
}

/** A middle crumb is capped so the trail keeps its shape; the last crumb
 *  (the page you are on) takes whatever room is left before it truncates. */
const MIDDLE = "block max-w-[240px] truncate";
const LAST = "block truncate";

function EntityCrumbLabel({ entity, last }: { entity: NonNullable<Crumb["entity"]>; last: boolean }) {
  const { name, isLoading, noun } = useEntityName(entity.kind, entity.id);
  if (isLoading) return <Skeleton className="h-3.5 w-28" rounded="sm" />;
  return (
    <Tip
      label={
        <span className="block max-w-80">
          {name && <span className="block">{name}</span>}
          <span className="block font-mono opacity-75">{entity.id}</span>
        </span>
      }
      side="bottom"
    >
      <span className={last ? LAST : MIDDLE}>{name ?? noun}</span>
    </Tip>
  );
}

export function AppBreadcrumb() {
  const crumbs = useCrumbs();
  if (crumbs.length === 0) return null;

  return (
    <ShadcnBreadcrumb className="min-w-0">
      <BreadcrumbList>
        {crumbs.map((c, i) => {
          const isLast = i === crumbs.length - 1;
          const label = c.entity ? (
            <EntityCrumbLabel entity={c.entity} last={isLast} />
          ) : (
            <span className={isLast ? LAST : MIDDLE} title={c.label}>
              {c.label}
            </span>
          );
          return (
            <Fragment key={`${c.to}-${i}`}>
              {i > 0 && (
                <BreadcrumbSeparator>
                  <ChevronRightIcon className="size-3.5" />
                </BreadcrumbSeparator>
              )}
              <BreadcrumbItem className={isLast ? "flex-1" : "shrink-0"}>
                {isLast ? (
                  <BreadcrumbPage className="min-w-0">{label}</BreadcrumbPage>
                ) : (
                  // asChild + router <Link> keeps this an SPA navigation.
                  <BreadcrumbLink asChild>
                    <Link to={c.to}>{label}</Link>
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </ShadcnBreadcrumb>
  );
}
