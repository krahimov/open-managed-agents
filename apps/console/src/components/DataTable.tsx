import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  EyeIcon,
  EyeOffIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
} from "lucide-react";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type Table as TanstackTable,
  type VisibilityState,
} from "@tanstack/react-table";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";

import { EmptyState, type EmptyStateKind } from "./EmptyState";
import { PageHeader } from "./PageHeader";
import { Skeleton } from "./Skeleton";
import { cn } from "@/lib/utils";
import { useLocation } from "react-router";
import { usePageTitle } from "./AppBreadcrumb";
import { pageDescription } from "../lib/page-meta";

/**
 * DataTable — list page chrome with a frozen, column-aligned header.
 *
 * Built on TanStack Table (headless) + shadcn `<Table>` primitives.
 * Used when a page wants:
 *
 *   - A header pinned outside the scroll container (Excel-style frozen
 *     first row, never moves as the body scrolls).
 *   - A toolbar with a server-side global search box, page-specific
 *     filter chips, and a "Columns" dropdown for show/hide.
 *   - IntersectionObserver-driven load-more for infinite scroll (same
 *     API as ListPage — `hasMore` / `loadingMore` / `onLoadMore`).
 *
 * What DataTable deliberately does NOT do:
 *
 *   - **No click-header sorting.** Order is whatever the server returns
 *     (today: `created_at DESC, id DESC` on cursor pages). Adding a
 *     client-side sort over already-loaded rows is a lie when more
 *     pages exist — the next page lands at the bottom in raw order.
 *     If a list needs to be sorted differently, the server endpoint
 *     decides; the UI doesn't pretend.
 *   - **No per-column free-text filter popovers.** Same lie: a contains-
 *     match on loaded rows hides the user's data without telling them.
 *     Structured filters (enum, time bucket) belong in the toolbar
 *     `filters` slot, where each page pushes them as real query params.
 */
export interface DataTableProps<T> {
  /** Page title — usually omitted for list pages where AppBreadcrumb
   *  already names the route at the top of the shell. Detail/sub-views
   *  that need a richer label (entity name) still pass it. */
  title?: string;
  /** Brief one-liner under the title — kept even when title is hidden
   *  so list pages can publish a description. */
  subtitle?: ReactNode;

  /** Primary "create" button. Both must be set to render. */
  createLabel?: string;
  onCreate?: () => void;
  headerActions?: ReactNode;

  /** Server-side search input rendered in the toolbar. */
  searchPlaceholder?: string;
  searchValue?: string;
  onSearchChange?: (v: string) => void;

  /** Page-specific filter slot — structured chips (status enum,
   *  created-at bucket, agent dropdown). Pages own these and wire them
   *  to real server query params, so the UI doesn't promise filtering
   *  it can't deliver. */
  filters?: ReactNode;

  /** TanStack column definitions. Each column should set `id` (or
   *  derive from `accessorKey`) so column visibility can key by it.
   *  Use `enableHiding: false` to pin a column visible. */
  columns: ColumnDef<T, unknown>[];
  data: T[];
  getRowId: (item: T) => string;

  loading?: boolean;
  emptyTitle?: string;
  emptySubtitle?: ReactNode;
  emptyAction?: ReactNode;
  emptyKind?: EmptyStateKind;
  emptyIcon?: ReactNode;

  onRowClick?: (item: T) => void;

  /** Infinite-scroll mode — paired with `useInfiniteApiQuery`. */
  hasMore?: boolean;
  onLoadMore?: () => void;
  loadingMore?: boolean;

  children?: ReactNode;
}

export function DataTable<T>({
  title,
  subtitle,
  createLabel,
  onCreate,
  headerActions,
  searchPlaceholder,
  searchValue,
  onSearchChange,
  filters,
  columns,
  data,
  getRowId,
  loading,
  emptyTitle = "Nothing here yet",
  emptySubtitle,
  emptyAction,
  emptyKind,
  emptyIcon,
  onRowClick,
  hasMore,
  onLoadMore,
  loadingMore,
  children,
}: DataTableProps<T>) {
  // Column visibility persists per route in localStorage — toggling
  // Columns on /agents doesn't leak to /sessions, but coming back to
  // /agents restores the user's last choice. Auto-keyed by pathname
  // so callers don't need to pass anything; lift to a `tableId` prop
  // if a page ever stacks two DataTables.
  const { pathname } = useLocation();
  const storageKey = `dt-cols:${pathname}`;
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(
    () => {
      try {
        const raw = localStorage.getItem(storageKey);
        return raw ? (JSON.parse(raw) as VisibilityState) : {};
      } catch {
        return {};
      }
    },
  );
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(columnVisibility));
    } catch {
      // localStorage unavailable (private mode / quota) — silently skip;
      // visibility just won't persist this session.
    }
  }, [storageKey, columnVisibility]);

  const table = useReactTable({
    data,
    columns,
    state: { columnVisibility },
    onColumnVisibilityChange: setColumnVisibility,
    getRowId: (row) => getRowId(row),
    getCoreRowModel: getCoreRowModel(),
  });

  const showCreate = !!onCreate && !!createLabel;
  // Editorial header: every list page gets a large title (the route's own
  // crumb unless the caller names it) and a one-line deck.
  const routeTitle = usePageTitle();
  const headerTitle = title ?? routeTitle;
  const headerSubtitle = subtitle ?? pageDescription(pathname);

  // Single-row toolbar: [+ New X] on far left, page-specific filter
  // chips next, then a flex spacer pushes [search] + [Columns] to the
  // far right. Matches the LangSmith / Linear / Vercel pattern of one
  // continuous action row above the table (no separate top-right
  // "actions" zone). When there's no createCTA and no filters, the
  // search box still right-aligns via `ml-auto`.
  const toolbar = (
    <>
      {filters}
      <div className="flex-1" />
      {onSearchChange && (
        <InputGroup className="w-full sm:w-64 shrink-0 rounded-full bg-fill border-transparent hover:border-transparent dark:bg-fill has-[[data-slot=input-group-control]:focus-visible]:bg-bg-surface">
          <InputGroupAddon className="pl-3">
            <SearchIcon className="size-3.5 opacity-60" />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            value={searchValue ?? ""}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={searchPlaceholder ?? "Search..."}
            autoComplete="off"
            name="oma-list-search"
          />
        </InputGroup>
      )}
      <ColumnVisibilityMenu table={table} />
    </>
  );

  // Title-row actions: page-specific extras + the primary create pill.
  const titleActions =
    headerActions || showCreate ? (
      <>
        {headerActions}
        {showCreate && <CreateButton label={createLabel!} onClick={onCreate!} />}
      </>
    ) : undefined;

  const filteredRows = table.getRowModel().rows;
  const isEmpty = !loading && filteredRows.length === 0;
  const visibleColumns = table.getAllColumns().filter((c) => c.getIsVisible());
  const visibleColumnCount = visibleColumns.length;

  // Excel-style frozen column header: rendered as its own <table> inside
  // the PageHeader portal slot, physically OUTSIDE the scroll container.
  // Body table below shares the same colgroup widths via
  // `table-layout: fixed` so columns line up perfectly across both
  // tables. TanStack drives the cell sizes via `column.getSize()`
  // (defaults to 150 per column).
  const colgroup = (
    <colgroup>
      {visibleColumns.map((col) => (
        <col key={col.id} style={{ width: `${col.getSize()}px` }} />
      ))}
    </colgroup>
  );

  const frozenHeader = !loading && !isEmpty ? (
    // Wrap the header table in an overflow-x:hidden container with a
    // stable id so the body's horizontal scroll can drive scrollLeft
    // on this element — see the useEffect below. Without this sync,
    // wide tables (many columns / long URLs) horizontal-scroll the
    // body but the header stays put → cells lose alignment.
    <div id="dt-header-scroll" className="overflow-x-hidden px-px">
      <table className="w-full table-fixed text-fg-subtle">
        {colgroup}
        <thead>
          {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <th
                  key={header.id}
                  className="h-8 px-4 first:pl-6 text-left eyebrow align-middle whitespace-nowrap"
                >
                  {header.isPlaceholder ? null : (
                    <span>
                      {flexRender(header.column.columnDef.header, header.getContext())}
                    </span>
                  )}
                </th>
              ))}
            </tr>
          ))}
        </thead>
      </table>
    </div>
  ) : undefined;

  // Sync the frozen header's horizontal scroll to the body's. Both
  // elements are identified by id (single DataTable per page is the
  // current usage; lift to refs + context if we ever stack two on the
  // same page). passive listener — we're only reading scrollLeft.
  useEffect(() => {
    const body = document.getElementById("dt-body-scroll");
    const header = document.getElementById("dt-header-scroll");
    if (!body || !header) return;
    const onScroll = () => {
      header.scrollLeft = body.scrollLeft;
    };
    body.addEventListener("scroll", onScroll, { passive: true });
    return () => body.removeEventListener("scroll", onScroll);
  }, [loading, isEmpty]);

  return (
    <>
      <PageHeader
        title={headerTitle}
        subtitle={headerSubtitle}
        actions={titleActions}
        toolbar={toolbar}
        tableHeader={frozenHeader}
      />

      {loading ? (
        <SkeletonRows colSpan={visibleColumnCount} />
      ) : isEmpty ? (
        <div className="px-8 pt-2 pb-12">
          <EmptyState
            title={emptyTitle}
            body={emptySubtitle}
            action={emptyAction}
            kind={emptyKind}
            icon={emptyIcon}
            size="lg"
          />
        </div>
      ) : (
        <div className="px-8 pt-1 pb-12">
          {/* One continuous card, rows divided by inset hairlines — an
              editorial list rather than a stack of boxes. */}
          <div id="dt-body-scroll" className="card overflow-x-auto">
            <table className="w-full table-fixed border-separate border-spacing-0">
              {colgroup}
              <tbody>
                {filteredRows.map((row, i) => {
                  const cells = row.getVisibleCells();
                  return (
                    <tr
                      key={row.id}
                      onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                      className={cn(
                        "group/row transition-colors duration-[var(--dur-base)] ease-[var(--ease-soft)] hover:bg-fill/70",
                        "[&>td]:h-[60px] [&>td]:px-4 [&>td:first-child]:pl-6 [&>td]:align-middle [&>td]:text-sm",
                        i > 0 && "[&>td]:border-t [&>td]:border-border",
                        onRowClick && "cursor-pointer",
                      )}
                    >
                      {cells.map((cell) => (
                        <td key={cell.id} className="truncate">
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      ))}
                    </tr>
                  );
                })}
                {onLoadMore && hasMore && (
                  <LoadMoreRow
                    colSpan={visibleColumnCount}
                    loading={!!loadingMore}
                    onLoadMore={onLoadMore}
                  />
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {children}
    </>
  );
}

/** Primary create pill. A leading "+ " in the label becomes a glyph so
 *  the pill reads like an Apple action ("＋ New agent"). */
export function CreateButton({ label, onClick }: { label: string; onClick: () => void }) {
  const plus = label.startsWith("+ ");
  return (
    <Button onClick={onClick} className={plus ? "pl-3" : undefined}>
      {plus && <PlusIcon className="size-4 -ml-0.5" strokeWidth={2.25} />}
      {plus ? label.slice(2) : label}
    </Button>
  );
}

/** Right-pinned "Columns" toggle in the toolbar — shadcn dropdown
 *  with one checkbox per non-required column. Required columns
 *  (id, name) typically set `enableHiding: false` on their def. */
function ColumnVisibilityMenu<T>({ table }: { table: TanstackTable<T> }) {
  const hideableColumns = table.getAllColumns().filter((c) => c.getCanHide());
  if (hideableColumns.length === 0) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="ml-auto shrink-0">
          <SettingsIcon className="size-3.5" />
          Columns
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel className="eyebrow px-2">
          Visible columns
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {hideableColumns.map((column) => (
          <DropdownMenuCheckboxItem
            key={column.id}
            checked={column.getIsVisible()}
            onCheckedChange={(value) => column.toggleVisibility(!!value)}
            // Keep menu open while toggling several columns in a row.
            onSelect={(e) => e.preventDefault()}
            className="capitalize"
          >
            {column.getIsVisible() ? (
              <EyeIcon className="size-3.5 opacity-60" />
            ) : (
              <EyeOffIcon className="size-3.5 opacity-60" />
            )}
            {String(column.id)}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Skeleton state — matches the live row recipe exactly (pill-style
 *  rows on a `border-separate border-spacing-y-1.5` table) so loading
 *  → loaded has zero visual jump and no rogue table borders.
 *
 *  The earlier version reused shadcn's `<Table>` / `<TableRow>` /
 *  `<TableCell>` primitives which carry `border-b` on every row; those
 *  paint visible dark hairlines between skeleton rows that the loaded
 *  view doesn't have. Rolling the markup by hand here gives us the
 *  same `<table>` shape as the live body, just with a Skeleton inside
 *  each cell instead of a value.
 *
 *  Width distribution is identical to ListPage's skeleton so list
 *  pages on either chrome show the same loading texture. */
function SkeletonRows({ colSpan }: { colSpan: number }) {
  const cols = colSpan || 4;
  return (
    <div className="px-8 pt-[33px] pb-12">
      <div className="card overflow-hidden">
        <table className="w-full table-fixed border-separate border-spacing-0">
          <tbody>
            {Array.from({ length: 8 }).map((_, rowIdx) => (
              <tr
                key={`sk-${rowIdx}`}
                className={cn(
                  "[&>td]:h-[60px] [&>td]:px-4 [&>td:first-child]:pl-6 [&>td]:align-middle",
                  rowIdx > 0 && "[&>td]:border-t [&>td]:border-border",
                )}
              >
                {Array.from({ length: cols }).map((_, colIdx) => {
                  const widthClass = (() => {
                    if (colIdx === 0) return rowIdx % 2 === 0 ? "w-[55%]" : "w-[42%]";
                    if (colIdx === cols - 1)
                      return rowIdx % 2 === 0 ? "w-[38%]" : "w-[48%]";
                    return rowIdx % 3 === 0 ? "w-[85%]" : rowIdx % 3 === 1 ? "w-[72%]" : "w-[60%]";
                  })();
                  return (
                    <td key={colIdx}>
                      <Skeleton className={`h-3 ${widthClass}`} rounded="full" />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function LoadMoreRow({
  colSpan,
  loading,
  onLoadMore,
}: {
  colSpan: number;
  loading: boolean;
  onLoadMore: () => void;
}) {
  const ref = useRef<HTMLTableRowElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && !loading) {
          onLoadMore();
        }
      },
      { rootMargin: "400px 0px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [loading, onLoadMore]);

  return (
    <tr ref={ref}>
      <td colSpan={colSpan} className="text-center py-4 text-xs text-fg-subtle border-t border-border">
        {loading ? "Loading more…" : " "}
      </td>
    </tr>
  );
}

// Re-export for caller-side column definitions.
export { type ColumnDef } from "@tanstack/react-table";
