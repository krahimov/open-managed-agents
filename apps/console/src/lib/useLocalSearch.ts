import { useEffect, useMemo, useState } from "react";

/**
 * A list's search field, for an endpoint that has no text search of its own
 * (vaults, memory stores, deployments).
 *
 * Every list page reads the same way: search first, then filters. Where the
 * server can search (`?q=`), the page sends the query. Where it cannot,
 * this hook narrows the rows in the browser, and so that "no match" is true
 * of the whole list and not of its first page, it keeps asking for the next
 * page for as long as there is a query and more to load.
 *
 *   const found = useLocalSearch(vaults, (v) => [v.name], { hasMore, isLoadingMore, loadMore });
 *   <DataTable searchValue={found.search} onSearchChange={found.setSearch} data={found.rows} … />
 *
 * A row matches when every word typed appears somewhere in the texts given
 * for it, in any order, ignoring case.
 */
export function useLocalSearch<T>(
  rows: T[],
  textOf: (row: T) => Array<string | null | undefined>,
  more?: { hasMore: boolean; isLoadingMore: boolean; loadMore: () => void },
) {
  const [search, setSearch] = useState("");
  const words = useMemo(() => matchWords(search), [search]);
  const searching = words.length > 0;

  const found = useMemo(
    () => (searching ? rows.filter((row) => matchesWords(words, textOf(row))) : rows),
    // `textOf` is a plain projection; callers pass it inline.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, words, searching],
  );

  const hasMore = more?.hasMore ?? false;
  const isLoadingMore = more?.isLoadingMore ?? false;
  const loadMore = more?.loadMore;
  useEffect(() => {
    if (searching && hasMore && !isLoadingMore) loadMore?.();
  }, [searching, hasMore, isLoadingMore, loadMore]);

  return {
    search,
    setSearch,
    /** True when something is typed. */
    searching,
    /** The query as typed, trimmed, for "No vaults match “…”". */
    query: search.trim(),
    rows: found,
  };
}

/** The words of a query, lower-cased. */
export function matchWords(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** True when every word appears in one of the texts. */
export function matchesWords(words: string[], texts: Array<string | null | undefined>): boolean {
  const hay = texts.filter(Boolean).join("\n").toLowerCase();
  return words.every((w) => hay.includes(w));
}
