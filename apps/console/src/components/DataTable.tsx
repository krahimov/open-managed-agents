import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { ArrowDownIcon, ArrowUpIcon, ChevronsUpDownIcon, Columns3Icon, PlusIcon } from "lucide-react";
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type Column,
  type ColumnDef,
  type RowData,
  type SortingState,
  type Table as TanstackTable,
  type VisibilityState,
} from "@tanstack/react-table";
import { Link, useLocation, useNavigate } from "react-router";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

import { BrandLoader } from "./BrandLoader";
import { useMeasure } from "./charts/util";
import { EmptyState, type EmptyStateKind } from "./EmptyState";
import { OverflowTip } from "./OverflowTip";
import { usePageColumn, type PageWidth } from "./Page";
import { PageHeader } from "./PageHeader";
import { ErrorState } from "./QueryProblem";
import { Skeleton, SkeletonCard } from "./Skeleton";
import { Tip } from "./Tip";
import { ListToolbar } from "./Toolbar";

declare module "@tanstack/react-table" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    /** Horizontal alignment of the header and cells. Numbers: "right". */
    align?: "left" | "right" | "center";
    /** Label for the Columns menu when `header` is not a plain string. */
    label?: string;
    /** Drop this column while the table is narrower than this many px, so a
     *  narrow panel shows fewer columns whole instead of scrolling sideways.
     *  For a column whose value is also on the record page (an environment,
     *  an agent reference), never for the identity or status column. */
    hideBelow?: number;
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface TableMeta<TData extends RowData> {
    /** Ids of the columns dropped right now because the table is narrow
     *  (`meta.hideBelow`). A cell reads it to carry that value itself:
     *  Sessions moves the environment under the title. */
    hiddenByWidth: ReadonlySet<string>;
    /** The table's width in px (0 until it is measured). */
    width: number;
  }
}

/**
 * DataTable — the list page.
 *
 * One component owns the whole page: the title row (title, description,
 * primary "New …" button), the toolbar (search, filter chips, view
 * options), the pinned column header, the rows, and the loading / failed /
 * empty / load-more states. Pass `error` + `onRetry` from the list hook and
 * a failed read says so, instead of looking like "nothing here yet".
 *
 *   <DataTable<Vault>
 *     title="Vaults"
 *     subtitle="Credentials your agents use to reach other services."
 *     createLabel="New vault" onCreate={…}
 *     searchValue={q} onSearchChange={setQ} searchPlaceholder="Search vaults"
 *     filters={<FilterChip …/>}
 *     columns={columns} data={rows} getRowId={(v) => v.id}
 *     rowHref={(v) => `/vaults/${v.id}`}
 *     loading={isLoading} error={error} onRetry={refresh}
 *     hasMore={hasMore} onLoadMore={loadMore} loadingMore={isLoadingMore}
 *     emptyKind="vault" emptyTitle="No vaults yet" emptySubtitle="…" emptyAction={<Button>New vault</Button>}
 *   />
 *
 * Rows are links. Say what a row opens with `rowHref` (a page) or
 * `onRowClick` (something in place: a side panel, a dialog), and put the
 * record's name in a <RowLink> inside the identity cell:
 *
 *   cell: ({ row }) => (
 *     <div className="flex min-w-0 items-center gap-3">
 *       <AgentAvatar … />
 *       <div className="min-w-0">
 *         <div className="flex min-w-0"><RowLink className="font-medium text-fg">{row.original.name}</RowLink></div>
 *         <div className="truncate text-xs text-fg-subtle">…</div>
 *       </div>
 *     </div>
 *   )
 *
 * <RowLink> is a real <a href> (or a <button> for `onRowClick`) whose hit
 * area is stretched over the whole row, so click, ⌘-click, middle-click,
 * "Open link in new tab" and Tab + Enter all work, and the focus ring is
 * drawn around the row. Every other link, button and tooltip in the row
 * sits above it and keeps working. A list that has not put a <RowLink> in
 * its identity cell still gets a stretched link, named after the first
 * column's value.
 *
 * Columns (TanStack `ColumnDef`):
 *   - The FIRST column is the identity cell: avatar + name + a secondary
 *     line. It never shows an id. Give it the largest `size`.
 *   - `size` is a proportion: columns share the card's width in the ratio
 *     of their sizes, so the whole row fits at any panel width. Columns of
 *     72 or less keep that exact pixel width, and on a narrow panel columns
 *     of 160 or less (status, time, numbers) keep their declared width
 *     while the long ones give way, down to their `minSize` (62% of
 *     `size` when unset). Typical: identity 320–520, text 180–300, status
 *     130–150, time 110–124, number 90–110, actions 56. A sortable
 *     heading needs 16px more than its words.
 *   - `meta: { align: "right" }` for numbers. `meta: { label }` names the
 *     column in the Columns menu when its header is not a string.
 *   - `meta: { hideBelow: 900 }` drops a column while the table is
 *     narrower than that; `table.options.meta.hiddenByWidth` tells a cell
 *     which columns are dropped right now.
 *   - `enableSorting: true` makes a column's header a sort button. It
 *     needs an `accessorFn` that returns a number or a string (undefined
 *     sorts last). See "Sorting" below.
 *   - The last column is `id: "actions"` with a <RowActionsMenu>,
 *     `size: 56`, `enableHiding: false`.
 *
 * Sorting is over the whole list or not at all. The order rows arrive in
 * is the server's. Choosing a sort on a list that still has pages to load
 * first loads the rest (through `onLoadMore`), and only then re-orders;
 * until then the rows stay in the server's order and the toolbar says the
 * list is loading. A list longer than `sortLimit` rows is not sorted: the
 * request is dropped with a message that says to narrow it first. One
 * page of a longer list is never shown as "sorted".
 *
 * One table. The rows and their column headings are one native <table>:
 * the headings are real <th scope="col"> in its <thead> (kept at zero
 * height), so every cell is announced with its column. The strip pinned
 * above the scroll area repeats the headings for the eye; it is laid out
 * as a presentational table so its columns match to the pixel, hidden
 * from assistive tech except for the sort buttons.
 *
 * Gallery: pass `layout="grid"` with `renderCard` to show the same data as
 * cards; put the switch in `toolbarTrailing` (see AgentsList).
 *
 * What it deliberately does not do: per-column text filters. Filtering is
 * whatever the server returns; structured filters live in `filters` and
 * map to real query params.
 */
export interface DataTableSort {
  /** Column id. */
  id: string;
  desc: boolean;
}

export interface DataTableProps<T> {
  /** Page title. Defaults to the route's breadcrumb label. */
  title?: string;
  /** One line under the title. */
  subtitle?: ReactNode;

  /** Primary "create" button. Both must be set to render. A leading "+ "
   *  in the label is drawn as an icon. */
  createLabel?: string;
  onCreate?: () => void;
  /** Extra buttons left of the primary one (variant="outline"). */
  headerActions?: ReactNode;

  /** Server-side search input in the toolbar. */
  searchPlaceholder?: string;
  searchValue?: string;
  onSearchChange?: (v: string) => void;

  /** Structured filter chips, wired to real server query params. */
  filters?: ReactNode;
  /** Quiet result count on the right of the toolbar ("12 agents"). */
  summary?: ReactNode;
  /** Right end of the toolbar: a view switch, a range picker. */
  toolbarTrailing?: ReactNode;

  columns: ColumnDef<T, unknown>[];
  data: T[];
  getRowId: (item: T) => string;

  /** `table` (default) or `grid` (cards via `renderCard`). */
  layout?: "table" | "grid";
  renderCard?: (item: T, index: number) => ReactNode;
  /** Grid template. Default: 1 / 2 / 3 / 4 columns by breakpoint. */
  gridClassName?: string;
  /** Page width. Default "wide". */
  width?: PageWidth;

  loading?: boolean;
  /** The list read failed. With no rows to show, the table gives way to an
   *  error block that says what could not be loaded and offers `onRetry`.
   *  (With rows already on screen a failed refresh keeps them.) */
  error?: unknown;
  onRetry?: () => unknown;
  /** Defaults to "{title} could not be loaded". */
  errorTitle?: string;
  emptyTitle?: string;
  emptySubtitle?: ReactNode;
  emptyAction?: ReactNode;
  emptyKind?: EmptyStateKind;
  emptyIcon?: ReactNode;
  /** The list is narrowed by a search or a filter, so "no rows" means "no
   *  match", not "first run". In a first run the empty state's action is
   *  the page's one ink button and the header's create button steps back
   *  to outline; with `filtered` the header keeps the ink. */
  filtered?: boolean;

  /** The page a row opens. The row becomes a real link to it. */
  rowHref?: (item: T) => string | undefined;
  /** What a row opens in place (a side panel, a dialog). The row becomes
   *  a real button. With `rowHref` set, `rowHref` wins. */
  onRowClick?: (item: T) => void;

  /** The chosen sort, when the page keeps it (to put it in the URL, or to
   *  ask for bigger pages while everything loads). Leave both unset and
   *  the table keeps it itself. `null` is the server's order. */
  sort?: DataTableSort | null;
  onSortChange?: (sort: DataTableSort | null) => void;
  /** The most rows a sort will load (they are all drawn: the table is not virtualised). Default 500. */
  sortLimit?: number;

  /** Infinite scroll — paired with `useInfiniteApiQuery`. */
  hasMore?: boolean;
  onLoadMore?: () => void;
  loadingMore?: boolean;

  /** Dialogs owned by the page. */
  children?: ReactNode;
}

const ALIGN: Record<"left" | "right" | "center", string> = {
  left: "text-left",
  right: "text-right",
  center: "text-center",
};

const DEFAULT_GRID = "grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4";

// ── Rows as links ────────────────────────────────────────────────────

/** What a row opens: a page, or something in place. */
export interface RowTarget {
  href?: string;
  activate?: () => void;
}

/** Set by a table around each row; read by <RowLink>. Exported for a table that draws its own rows. */
export const RowTargetContext = createContext<RowTarget | null>(null);

/**
 * The stretched hit area. It is anchored to the row's first cell (a table
 * cell is a positioning root in every browser; a table row is not in
 * older Safari) and reaches across the row by the table's measured width,
 * `--dt-row-w`, one pixel short so it can never add a scrollbar. The
 * row's focus ring is drawn on it, and on the last row it follows the
 * card's bottom corners.
 *
 * (Written out twice, once for a pseudo-element and once for an element:
 * Tailwind only generates classes it can read as literals.)
 */
const STRETCH_AFTER =
  "after:absolute after:inset-y-0 after:left-0 after:w-[calc(var(--dt-row-w)-1px)] focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-plum group-last/tr:after:rounded-b-[17px]";
const STRETCH_SELF =
  "absolute inset-y-0 left-0 w-[calc(var(--dt-row-w)-1px)] focus-visible:-outline-offset-2 group-last/tr:rounded-b-[17px]";

/**
 * Everything else a person can use in a row (links, buttons, menus,
 * fields, anything with a tooltip or a `title`) is lifted above the
 * stretched link, so it still answers to the pointer. A click on a lifted
 * piece of text that is not a control falls through to the row (see
 * `openRowFromEvent`). Zero specificity (:where), so a control that
 * positions itself keeps its own position.
 */
export const ROW_LIFT =
  "[:where(&)_:where(td_:is(a,button,input,select,textarea,label,summary,[role=button],[title],[data-slot=tooltip-trigger]):not([data-row-link],[data-row-fallback]))]:relative [:where(&)_:where(td_:is(a,button,input,select,textarea,label,summary,[role=button],[title],[data-slot=tooltip-trigger]):not([data-row-link],[data-row-fallback]))]:z-[1]";

/** Clicks that land on one of these belong to that control, not to the row. */
const OWN_CLICK = "a,button,input,select,textarea,label,summary,[role='button'],[role='menuitem'],[role='option']";

/**
 * The record's name, as the link that opens its row. Use it inside the
 * identity cell of a <DataTable> that has `rowHref` or
 * `onRowClick`; outside one it renders plain text.
 *
 * It truncates on one line, and while it is cut the full name is shown on
 * hover and on keyboard focus. Put it in a flex box so it can shrink:
 *
 *   <div className="flex min-w-0 items-center gap-2">
 *     <RowLink className="font-medium text-fg">{name}</RowLink>
 *     {archived && <Chip>Archived</Chip>}
 *   </div>
 */
export function RowLink({
  children,
  className,
  full,
}: {
  children: ReactNode;
  className?: string;
  /** The whole name for the tooltip. Defaults to `children` when it is a string. */
  full?: string;
}) {
  const target = useContext(RowTargetContext);
  const label = full ?? (typeof children === "string" ? children : undefined);
  const cls = cn("min-w-0 truncate rounded-sm text-left", target && STRETCH_AFTER, className);
  const node = target?.href ? (
    <Link to={target.href} data-row-link="" className={cls}>
      {children}
    </Link>
  ) : target?.activate ? (
    <button type="button" data-row-link="" onClick={target.activate} className={cls}>
      {children}
    </button>
  ) : (
    <span className={cls}>{children}</span>
  );
  return <OverflowTip label={label}>{node}</OverflowTip>;
}

/** The stretched link of a row whose identity cell holds no <RowLink>. */
export function RowFallback({ target, label }: { target: RowTarget; label: string }) {
  // A <RowLink> in the row takes over: this one is then not rendered at all.
  const cls = cn(STRETCH_SELF, "[tr:has([data-row-link])_&]:hidden");
  return target.href ? (
    <Link to={target.href} data-row-fallback="" aria-label={label} className={cls} />
  ) : (
    <button type="button" data-row-fallback="" aria-label={label} onClick={target.activate} className={cls} />
  );
}

/**
 * A click that lands on the row but not on its link (a time, a status with
 * a tooltip, the last pixel) still opens the row, with the same modifiers
 * a link understands: ⌘/Ctrl-click and middle-click open a new tab.
 */
export function openRowFromEvent(
  e: ReactMouseEvent<HTMLTableRowElement>,
  target: RowTarget,
  navigate: (to: string) => void | Promise<void>,
) {
  if (e.defaultPrevented) return;
  const el = e.target as HTMLElement;
  // A menu or dialog portalled out of the row bubbles here through React.
  if (!e.currentTarget.contains(el)) return;
  if (el.closest(OWN_CLICK)) return;
  // Releasing a text selection is not a click on the row.
  if (window.getSelection()?.toString()) return;
  if (!target.href) {
    if (e.button === 0) target.activate?.();
    return;
  }
  if (e.button === 1 || e.metaKey || e.ctrlKey) window.open(target.href, "_blank", "noopener");
  else if (e.button === 0) void navigate(target.href);
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
  summary,
  toolbarTrailing,
  columns,
  data,
  getRowId,
  layout = "table",
  renderCard,
  gridClassName = DEFAULT_GRID,
  width = "wide",
  loading,
  error,
  onRetry,
  errorTitle,
  emptyTitle = "Nothing here yet",
  emptySubtitle,
  emptyAction,
  emptyKind,
  emptyIcon,
  filtered,
  rowHref,
  onRowClick,
  sort: sortProp,
  onSortChange,
  sortLimit = 500,
  hasMore,
  onLoadMore,
  loadingMore,
  children,
}: DataTableProps<T>) {
  const navigate = useNavigate();
  // Column visibility persists per route.
  const { pathname } = useLocation();
  const storageKey = `dt-cols:${pathname}`;
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      return raw ? (JSON.parse(raw) as VisibilityState) : {};
    } catch {
      return {};
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(columnVisibility));
    } catch {
      // storage unavailable — visibility just will not persist
    }
  }, [storageKey, columnVisibility]);

  // The table's own width decides which optional columns are shown
  // (`meta.hideBelow`) and how the rest share the room (below).
  const [measureRef, bodyWidth] = useMeasure<HTMLDivElement>();
  const hiddenByWidth = useMemo(() => {
    const hidden = new Set<string>();
    if (!bodyWidth) return hidden;
    for (const col of columns) {
      const below = col.meta?.hideBelow;
      const id = col.id ?? (col as { accessorKey?: string }).accessorKey;
      if (below && id && bodyWidth < below) hidden.add(id);
    }
    return hidden;
  }, [columns, bodyWidth]);
  const responsiveVisibility = useMemo(() => {
    const hidden: VisibilityState = {};
    for (const id of hiddenByWidth) hidden[id] = false;
    return hidden;
  }, [hiddenByWidth]);

  // ── Sorting: over the whole list, or not at all ──
  const [ownSort, setOwnSort] = useState<DataTableSort | null>(null);
  const sort = sortProp !== undefined ? sortProp : ownSort;
  const setSort = (next: DataTableSort | null) => {
    if (sortProp === undefined) setOwnSort(next);
    onSortChange?.(next);
  };
  const complete = !hasMore;
  const sortPending = !!sort && !complete;
  const sorting = useMemo<SortingState>(() => (sort && complete ? [{ id: sort.id, desc: sort.desc }] : []), [sort, complete]);
  const tooLong = sortPending && data.length >= sortLimit;
  useEffect(() => {
    if (!sortPending || loading) return;
    if (tooLong) {
      setSort(null);
      toast.message("This list is too long to sort here", {
        description: `Sorting re-orders the whole list, and this one has more than ${sortLimit.toLocaleString()} rows. Narrow it with a filter, then sort.`,
      });
      return;
    }
    if (!loadingMore) onLoadMore?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortPending, tooLong, loading, loadingMore, data.length]);

  const table = useReactTable({
    data,
    columns,
    // Sorting is opt-in per column; a missing value sorts last either way.
    defaultColumn: { enableSorting: false, sortUndefined: "last" },
    state: { columnVisibility: { ...columnVisibility, ...responsiveVisibility }, sorting },
    onColumnVisibilityChange: setColumnVisibility,
    getRowId: (row) => getRowId(row),
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    enableMultiSort: false,
    meta: { hiddenByWidth, width: bodyWidth },
  });

  const toggleSort = (column: Column<T, unknown>) => {
    const first = column.getFirstSortDir() === "desc";
    if (!sort || sort.id !== column.id) setSort({ id: column.id, desc: first });
    else if (sort.desc === first) setSort({ id: column.id, desc: !first });
    else setSort(null);
  };

  const isGrid = layout === "grid" && !!renderCard;
  const showCreate = !!onCreate && !!createLabel;
  const rows = table.getRowModel().rows;
  const failed = !!error && !loading && rows.length === 0;
  const isEmpty = !loading && !failed && rows.length === 0;
  const visibleColumns = table.getAllColumns().filter((c) => c.getIsVisible());
  // One ink button per view: in a first run it is the empty state's.
  const firstRun = isEmpty && !filtered && !searchValue && !!emptyAction;

  const actions =
    headerActions || showCreate ? (
      <>
        {headerActions}
        {showCreate && (
          // aria-label keeps the full label ("+ New agent") as the accessible name.
          <Button onClick={onCreate} aria-label={createLabel} variant={firstRun ? "outline" : "default"}>
            <PlusIcon data-icon="inline-start" className="stroke-[2.25]" />
            {createLabel!.replace(/^\+\s*/, "")}
          </Button>
        )}
      </>
    ) : undefined;

  // The Columns menu only means something while there are rows. With no
  // rows and nothing to search or filter by, there is no toolbar at all
  // (a lone button above an empty state reads as a leftover).
  const showColumns = !isGrid && !isEmpty && !failed;
  const hasControls = !!onSearchChange || !!filters || !!toolbarTrailing;
  const hasToolbar = !failed && (hasControls || ((!!summary || showColumns) && !isEmpty));
  const sortLabel = sort ? columnLabel(table.getColumn(sort.id)) : "";
  const toolbar = hasToolbar ? (
    <ListToolbar
      search={
        onSearchChange
          ? { value: searchValue ?? "", onChange: onSearchChange, placeholder: (searchPlaceholder ?? "Search").replace(/\.{3}$/, "") }
          : undefined
      }
      filters={filters}
      summary={
        isEmpty ? undefined : sortPending && !isGrid ? (
          // Said in words while the rows are still in the server's order.
          <span role="status" className="inline-flex items-center gap-2">
            <BrandLoader size="sm" label="Loading" />
            Loading the whole list to sort by {sortLabel.toLowerCase()}
          </span>
        ) : (
          summary
        )
      }
      trailing={
        <>
          {showColumns && <ColumnVisibilityMenu table={table} hiddenByWidth={hiddenByWidth} />}
          {toolbarTrailing}
        </>
      }
    />
  ) : undefined;

  // Column widths. `size` is a proportion: on a wide panel every flexible
  // column grows in that ratio, so the row (and the row menu at its end)
  // always fills the card. On a narrow panel the squeeze is not shared
  // evenly: a short column (status, time, a number; 160 or less) keeps its
  // declared width, because "Needs approval" or "yesterday" cut to an
  // ellipsis reads as broken, and the long columns (names, references),
  // which truncate gracefully and carry tooltips, give up the room. Columns
  // of 72px or less are always exact (the actions column, a checkbox).
  // A long column gives way down to its `minSize` (62% of its size when it
  // names none); past that the table scrolls sideways. So a title column
  // can ask for a lot of room and still say how little it can live with.
  const floorOf = (c: Column<T, unknown>) => {
    const min = c.columnDef.minSize;
    return typeof min === "number" && min > 20 ? min : c.getSize() * 0.62;
  };
  const sizeKey = visibleColumns.map((c) => `${c.id}:${c.getSize()}:${floorOf(c)}`).join("|");
  const colWidths = useMemo(() => {
    const sizes = visibleColumns.map((c) => c.getSize());
    const floors = visibleColumns.map(floorOf);
    const isFixed = (n: number) => n <= 72;
    const isShort = (n: number) => n > 72 && n <= 160;
    const sum = (pick: (n: number) => boolean) => sizes.filter(pick).reduce((a, b) => a + b, 0);
    const fixedTotal = sum(isFixed);
    const flexTotal = sum((n) => !isFixed(n));
    if (!bodyWidth || flexTotal === 0) return sizes;
    const grow = (bodyWidth - fixedTotal) / flexTotal;
    if (grow >= 1) return sizes.map((n) => (isFixed(n) ? n : Math.floor(n * grow)));
    const shortTotal = sum(isShort);
    const longTotal = flexTotal - shortTotal;
    // No long column to give way: fall back to an even squeeze.
    if (longTotal === 0) return sizes.map((n) => (isFixed(n) ? n : Math.floor(n * Math.max(grow, 0.62))));
    // Share the room that is left among the long columns in proportion to
    // their sizes. One that would go under its floor is pinned there and
    // the rest share what remains, so a floor on one column is paid for by
    // its neighbours, not by a sideways scroll.
    const widths = [...sizes];
    let free = sizes.map((n, i) => i).filter((i) => !isFixed(sizes[i]) && !isShort(sizes[i]));
    let room = bodyWidth - fixedTotal - shortTotal;
    while (free.length > 0) {
      const total = free.reduce((a, i) => a + sizes[i], 0);
      const factor = Math.max(room, 0) / total;
      const pinned = free.filter((i) => sizes[i] * factor < floors[i]);
      if (pinned.length === 0) {
        for (const i of free) widths[i] = Math.floor(sizes[i] * factor);
        break;
      }
      for (const i of pinned) {
        widths[i] = Math.floor(floors[i]);
        room -= widths[i];
      }
      free = free.filter((i) => !pinned.includes(i));
    }
    return widths;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sizeKey, bodyWidth]);
  // How wide a row is: the card, or the columns when they no longer fit it.
  const rowWidth = Math.max(
    bodyWidth,
    colWidths.reduce((a, b) => a + b, 0),
  );

  const colgroup = (
    <colgroup>
      {visibleColumns.map((col, i) => (
        <col key={col.id} style={{ width: `${colWidths[i] ?? col.getSize()}px` }} />
      ))}
    </colgroup>
  );

  const headerGroups = table.getHeaderGroups();
  const anySortable = visibleColumns.some((c) => c.getCanSort());
  const tableName = title ?? "List";

  // Pinned column header: a strip in the PageHeader slot, outside the
  // scroll container, sharing the body's colgroup. Together they read as
  // one card: this is the card's top, the body its bottom. It is for the
  // eye: the headings assistive tech reads are the <th> inside the table
  // below. Only the sort buttons are exposed here, as a named group.
  const pinnedHeader =
    !isGrid && !loading && !isEmpty && !failed ? (
      <div
        id="dt-header-scroll"
        data-slot="table-header"
        className="overflow-x-hidden rounded-t-xl border border-b-0 border-border bg-bg-surface"
        {...(anySortable ? { role: "group", "aria-label": `Sort ${tableName.toLowerCase()}` } : { "aria-hidden": true })}
      >
        <table role="presentation" className="w-full table-fixed border-b border-border">
          {colgroup}
          <tbody>
            {headerGroups.map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const align = header.column.columnDef.meta?.align ?? "left";
                  const content = header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext());
                  const sortable = header.column.getCanSort();
                  const active = sort?.id === header.column.id;
                  return (
                    <td
                      key={header.id}
                      className={cn(
                        "h-10 px-4 align-middle text-xs font-medium whitespace-nowrap text-fg-subtle first:pl-5 last:pr-5",
                        ALIGN[align],
                      )}
                    >
                      {sortable ? (
                        <SortButton
                          label={columnLabel(header.column)}
                          align={align}
                          state={active ? (sort!.desc ? "desc" : "asc") : null}
                          pending={active && sortPending}
                          onClick={() => toggleSort(header.column)}
                        >
                          {content}
                        </SortButton>
                      ) : (
                        <span aria-hidden={anySortable ? true : undefined}>{content}</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    ) : undefined;

  // Mirror the body's horizontal scroll onto the pinned header.
  useEffect(() => {
    const body = document.getElementById("dt-body-scroll");
    const header = document.getElementById("dt-header-scroll");
    if (!body || !header) return;
    const onScroll = () => {
      header.scrollLeft = body.scrollLeft;
    };
    body.addEventListener("scroll", onScroll, { passive: true });
    return () => body.removeEventListener("scroll", onScroll);
  }, [loading, isEmpty, isGrid]);

  const openFromRow = (e: ReactMouseEvent<HTMLTableRowElement>, target: RowTarget) => openRowFromEvent(e, target, navigate);

  // The same column <Page> and <PageHeader> use: on the shared left edge for a
  // top-level list, whatever its width.
  const column = usePageColumn(width);

  return (
    <>
      <PageHeader title={title} subtitle={subtitle} actions={actions} toolbar={toolbar} tableHeader={pinnedHeader} width={width} />

      {loading ? (
        <div className={column.outer}>
          <div className={cn(column.inner, "pt-1 pb-16")}>
            {isGrid ? (
              <div className={gridClassName}>
                {Array.from({ length: 8 }).map((_, i) => (
                  <SkeletonCard key={i} />
                ))}
              </div>
            ) : (
              <SkeletonTable cols={visibleColumns.length} />
            )}
          </div>
        </div>
      ) : failed ? (
        <div className={column.outer}>
          <div className={cn(column.inner, "pt-1 pb-16")}>
            <ErrorState
              title={errorTitle ?? `${title ?? "This list"} could not be loaded`}
              error={error}
              retry={onRetry}
            />
          </div>
        </div>
      ) : isEmpty ? (
        <div className={column.outer}>
          <div className={cn(column.inner, "pt-1 pb-16")}>
            <EmptyState
              title={emptyTitle}
              body={emptySubtitle}
              action={emptyAction}
              kind={emptyKind}
              icon={emptyIcon}
              size="lg"
            />
          </div>
        </div>
      ) : isGrid ? (
        <div className={column.outer}>
          <div className={cn(column.inner, "pt-1 pb-16")}>
            <div className={gridClassName}>{rows.map((row, i) => renderCard!(row.original, i))}</div>
            {onLoadMore && hasMore && <LoadMoreSentinel loading={!!loadingMore} onLoadMore={onLoadMore} />}
          </div>
        </div>
      ) : (
        <div className={column.outer}>
          <div className={cn(column.inner, "pb-16")}>
            <div
              id="dt-body-scroll"
              ref={measureRef}
              className="overflow-x-auto rounded-b-xl border border-t-0 border-border bg-bg-surface shadow-[var(--shadow-sm)]"
            >
              <table
                aria-label={tableName}
                aria-rowcount={hasMore ? -1 : undefined}
                className="w-full table-fixed"
                style={{ "--dt-row-w": `${rowWidth}px` } as CSSProperties}
              >
                {colgroup}
                {/* The real column headings. Zero height: the pinned strip above shows them. */}
                <thead>
                  {headerGroups.map((headerGroup) => (
                    <tr key={headerGroup.id}>
                      {headerGroup.headers.map((header) => (
                        <th
                          key={header.id}
                          scope="col"
                          aria-sort={
                            header.column.getCanSort()
                              ? sort?.id === header.column.id && complete
                                ? sort.desc
                                  ? "descending"
                                  : "ascending"
                                : "none"
                              : undefined
                          }
                          className="h-0 border-0 p-0"
                        >
                          <span className="sr-only">{columnLabel(header.column) || "Actions"}</span>
                        </th>
                      ))}
                    </tr>
                  ))}
                </thead>
                <tbody className={ROW_LIFT}>
                  {rows.map((row) => {
                    const href = rowHref?.(row.original);
                    const target: RowTarget | null = href
                      ? { href }
                      : onRowClick
                        ? { activate: () => onRowClick(row.original) }
                        : null;
                    const cells = row.getVisibleCells();
                    const name = cells[0]?.getValue();
                    return (
                      <tr
                        key={row.id}
                        onClick={target ? (e) => openFromRow(e, target) : undefined}
                        onAuxClick={target?.href ? (e) => openFromRow(e, target) : undefined}
                        className={cn(
                          "group/tr border-t border-border transition-colors duration-100 first:border-t-0",
                          target && "cursor-pointer hover:bg-bg-hover",
                        )}
                      >
                        <RowTargetContext.Provider value={target}>
                          {cells.map((cell, i) => (
                            <td
                              key={cell.id}
                              className={cn(
                                "h-[52px] px-4 py-2 align-middle text-small-size text-fg first:pl-5 last:pr-5",
                                // The first cell anchors the stretched link, so the cell itself
                                // must not clip: its content is clipped one level in instead.
                                i === 0 ? "relative whitespace-nowrap" : "truncate",
                                ALIGN[cell.column.columnDef.meta?.align ?? "left"],
                              )}
                            >
                              {i === 0 ? (
                                <>
                                  {target && (
                                    <RowFallback target={target} label={typeof name === "string" && name ? `Open ${name}` : "Open"} />
                                  )}
                                  {/* Clips where the cell used to: at its padding edge. */}
                                  <div className="-my-2 -mr-4 -ml-5 truncate py-2 pr-4 pl-5">
                                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                  </div>
                                </>
                              ) : (
                                flexRender(cell.column.columnDef.cell, cell.getContext())
                              )}
                            </td>
                          ))}
                        </RowTargetContext.Provider>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {onLoadMore && hasMore && <LoadMoreSentinel loading={!!loadingMore} onLoadMore={onLoadMore} />}
          </div>
        </div>
      )}

      {children}
    </>
  );
}

/** A column's name in words: its string header, or `meta.label`. */
function columnLabel<T>(column: Column<T, unknown> | undefined): string {
  if (!column) return "";
  const header = column.columnDef.header;
  return column.columnDef.meta?.label ?? (typeof header === "string" ? header : "");
}

/**
 * A sortable column's heading. One click sorts by the column's natural
 * first direction (numbers and times largest first, text A to Z), the
 * next reverses it, the third returns to the server's order.
 */
function SortButton({
  label,
  align,
  state,
  pending,
  onClick,
  children,
}: {
  label: string;
  align: "left" | "right" | "center";
  state: "asc" | "desc" | null;
  /** Chosen, but the rest of the list is still loading. */
  pending?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  const Icon = state === "desc" ? ArrowDownIcon : state === "asc" ? ArrowUpIcon : ChevronsUpDownIcon;
  const says = state === null ? "not sorted" : pending ? "loading the whole list to sort" : state === "desc" ? "sorted descending" : "sorted ascending";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Sort by ${label.toLowerCase()}, ${says}`}
      className={cn(
        "group/sort -mx-1.5 inline-flex h-7 items-center gap-1 rounded-md px-1.5 align-middle transition-quick hover:bg-bg-hover hover:text-fg",
        // A right-aligned heading keeps its text on the numbers' edge: the arrow goes to its left.
        align === "right" && "flex-row-reverse",
        state && "text-fg",
      )}
    >
      {children}
      <Icon
        aria-hidden="true"
        className={cn(
          "size-3 shrink-0 stroke-2",
          state ? "text-fg" : "text-fg-faint group-hover/sort:text-fg-muted",
          pending && "animate-pulse",
        )}
      />
    </button>
  );
}

/** "Columns" button at the right of the toolbar: one checkbox per hideable column. */
function ColumnVisibilityMenu<T>({ table, hiddenByWidth }: { table: TanstackTable<T>; hiddenByWidth: ReadonlySet<string> }) {
  const hideable = table.getAllColumns().filter((c) => c.getCanHide());
  if (hideable.length === 0) return null;

  return (
    <DropdownMenu>
      <Tip label="Columns">
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Columns" className="text-fg-muted">
            <Columns3Icon className="stroke-[1.75]" />
          </Button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel>Show columns</DropdownMenuLabel>
        {hideable.map((column) => {
          const label = columnLabel(column) || String(column.id);
          // Dropped because the table is narrow: the box cannot bring it back, so it says why.
          const narrow = hiddenByWidth.has(column.id);
          return (
            <DropdownMenuCheckboxItem
              key={column.id}
              checked={column.getIsVisible()}
              disabled={narrow}
              onCheckedChange={(value) => column.toggleVisibility(!!value)}
              // Keep the menu open while toggling several columns in a row.
              onSelect={(e) => e.preventDefault()}
            >
              <span className="min-w-0">
                <span className="block truncate">{label}</span>
                {narrow && <span className="block text-xs">Needs a wider window</span>}
              </span>
            </DropdownMenuCheckboxItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Loading state shaped like the real table: a card of rows with an
 *  identity cell (avatar + two lines) and a few value cells. */
function SkeletonTable({ cols }: { cols: number }) {
  const n = Math.max(Math.min(cols, 6), 3);
  return (
    <div className="surface overflow-hidden rounded-xl" aria-hidden="true">
      <div className="flex h-10 items-center gap-6 border-b border-border px-5">
        <Skeleton className="h-2.5 w-16" rounded="sm" />
      </div>
      {Array.from({ length: 8 }).map((_, r) => (
        <div key={r} className="flex h-[52px] items-center gap-6 border-t border-border px-5 first:border-t-0">
          <div className="flex min-w-0 flex-[2.4] items-center gap-3">
            <Skeleton className="size-8 shrink-0" rounded="lg" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <Skeleton className="h-3" rounded="sm" style={{ width: `${40 + ((r * 13) % 35)}%` }} />
              <Skeleton className="h-2.5" rounded="sm" style={{ width: `${55 + ((r * 7) % 30)}%` }} />
            </div>
          </div>
          {Array.from({ length: n - 1 }).map((_, c) => (
            <div key={c} className="hidden flex-1 md:block">
              <Skeleton className="h-3" rounded="sm" style={{ width: `${45 + (((r + c) * 17) % 40)}%` }} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** Mounted below the last row/card when more pages exist; fetches the next
 *  page as it approaches the viewport. */
export function LoadMoreSentinel({ loading, onLoadMore }: { loading: boolean; onLoadMore: () => void }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && !loading) onLoadMore();
      },
      { rootMargin: "400px 0px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [loading, onLoadMore]);

  return (
    <div ref={ref} className="flex h-14 items-center justify-center">
      {loading && <BrandLoader size="sm" label="Loading more" />}
    </div>
  );
}

// Re-export for caller-side column definitions.
export { type ColumnDef } from "@tanstack/react-table";
