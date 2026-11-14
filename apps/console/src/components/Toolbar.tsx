import type { ReactNode } from "react";
import { SearchIcon, XIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import type { FieldControlProps } from "./Field";

/**
 * The list toolbar: search, filters, and view options as ONE row.
 *
 *   <ListToolbar
 *     search={{ value: q, onChange: setQ, placeholder: "Search agents" }}
 *     filters={<><FilterChip …/><CreatedFilterChip …/></>}
 *     summary="12 agents"
 *     trailing={<SegmentedControl … iconOnly />}
 *   />
 *
 * Order, left to right: search · filter chips · (space) · summary · view
 * controls. The page's primary "New …" button is NOT in the toolbar: it
 * lives in <PageHeader actions>.
 */
export function ListToolbar({
  search,
  filters,
  summary,
  trailing,
  className,
}: {
  search?: SearchInputProps;
  filters?: ReactNode;
  /** Quiet result count on the right: "12 agents". */
  summary?: ReactNode;
  trailing?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex w-full min-w-0 items-center gap-2", className)}>
      {search && <SearchInput {...search} />}
      {/* Chips never slide under the controls on the right: on a narrow panel
          the row of chips scrolls, and the summary waits for a wider one. */}
      {filters && <div className="no-scrollbar -my-1 flex min-w-0 items-center gap-1.5 overflow-x-auto py-1">{filters}</div>}
      <div className="flex-1" />
      {summary && (
        <span className={cn("hidden shrink-0 text-small text-fg-subtle", filters ? "xl:inline" : "md:inline")}>{summary}</span>
      )}
      {trailing && <div className="flex shrink-0 items-center gap-2">{trailing}</div>}
    </div>
  );
}

export interface SearchInputProps extends FieldControlProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Tailwind width class. Default `w-64`. */
  width?: string;
  autoFocus?: boolean;
  className?: string;
}

/** Pill search field with a clear button. Server-side search: debounce in
 *  the caller if the endpoint is slow. */
export function SearchInput({
  value,
  onChange,
  placeholder = "Search",
  width = "w-64",
  autoFocus,
  className,
  id,
  "aria-labelledby": labelledBy,
  "aria-describedby": describedBy,
  "aria-invalid": invalid,
}: SearchInputProps) {
  return (
    <div
      className={cn(
        "group/search relative flex h-9 shrink-0 items-center rounded-full border border-border-strong bg-bg-surface shadow-[var(--shadow-xs)] transition-quick hover:border-fg-faint has-[input:focus-visible]:border-plum has-[input:focus-visible]:shadow-[var(--shadow-focus)] dark:bg-bg-soft",
        width,
        className,
      )}
    >
      <SearchIcon className="pointer-events-none absolute left-3 size-4 text-fg-subtle" aria-hidden="true" />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        id={id}
        aria-label={labelledBy ? undefined : placeholder}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        autoComplete="off"
        autoFocus={autoFocus}
        name="oma-list-search"
        className="h-full w-full min-w-0 rounded-full bg-transparent pr-8 pl-9 text-small-size text-fg outline-none placeholder:text-fg-subtle focus-visible:outline-none [&::-webkit-search-cancel-button]:hidden"
      />
      {value && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => onChange("")}
          className="absolute right-1.5 flex size-6 items-center justify-center rounded-full text-fg-subtle transition-quick hover:bg-bg-hover hover:text-fg"
        >
          <XIcon className="size-3.5" />
        </button>
      )}
    </div>
  );
}
