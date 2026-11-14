import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationOptions,
  type UseQueryOptions,
} from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { ApiError, useApi } from "./api";
import { reportReadFailure } from "./read-failures";

/**
 * Thin TanStack Query wrappers around `useApi`. Existing semantics (auth
 * headers, error toasting, tenant pinning) come from `useApi` itself —
 * these hooks just wire its `api` / fetch promise into TQ's lifecycle.
 *
 * Why these exist:
 *   - List/detail pages can stop hand-rolling `useEffect` + `useState` for
 *     fetched data. `useApiQuery` returns the canonical `{ data, isLoading,
 *     error, refetch }`; loading state derives from `isLoading` automatically.
 *   - Cache + dedup: two components asking for the same path within
 *     `staleTime` (30s) get one fetch. Tab-switch refetch is built in.
 *   - Mutations: `useApiMutation` + `queryClient.invalidateQueries(...)`
 *     replaces ad-hoc "POST then call refresh()" patterns; the list
 *     refetches automatically.
 *
 * Defaults inherited from `queryClient` (`src/lib/query-client.ts`):
 *   staleTime 30s, gcTime 5min, refetchOnWindowFocus, retry 1.
 *
 * Don't reach past these wrappers unless you actually need a TQ feature
 * they don't expose — the goal is a tiny surface so the codebase stays
 * easy to scan.
 *
 * WHEN A READ FAILS. The request itself raises no toast (`silentErrors`).
 * The query settles into its error state, and the page draws that in place.
 * Once, after the last attempt, the failure is handed to
 * `reportReadFailure` (lib/read-failures.ts), which raises one toast only
 * when nothing on screen reports it. It used to be a toast per attempt, in
 * the server's bare words, on top of the page's own notice. Two kinds of
 * failure are never reported at all: a 404 on a single-record read (the
 * page draws "does not exist"), and a background refresh that failed while
 * the last good data is still on screen.
 */

/** Failed refreshes of data that is already on screen: nothing is missing, so nothing is said. */
const refreshFailures = new WeakSet<object>();

/** A failure a second attempt cannot fix: the server understood and said no. */
function isFinal(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  return error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
}

/**
 * The retry rule for reads: the client's own count (one retry, none in
 * tests), no second attempt at a 4xx, and a report when it gives up.
 */
function useReadRetry(quietNotFound: boolean) {
  const configured = useQueryClient().getDefaultOptions().queries?.retry;
  const max = configured === false ? 0 : configured === true ? Infinity : typeof configured === "number" ? configured : 1;
  return useCallback(
    (failureCount: number, error: unknown) => {
      // `failureCount` is 0 on the first failure.
      if (failureCount < max && !isFinal(error)) return true;
      const notFound = error instanceof ApiError && error.status === 404;
      const refresh = typeof error === "object" && error !== null && refreshFailures.has(error);
      if (!(quietNotFound && notFound) && !refresh) reportReadFailure(error);
      return false;
    },
    [max, quietNotFound],
  );
}

// ────────────────────────────────────────────────────────────────────────
// URL building shared by both query hooks. Mirrors the inline param logic
// `useCursorList` / `usePagedList` carry. Drops undefined/empty values so
// `params: { agent_id: undefined }` is a no-op rather than `?agent_id=`.
// ────────────────────────────────────────────────────────────────────────

export function buildUrl(
  path: string,
  params?: Record<string, string | undefined>,
  extra?: Record<string, string | undefined>,
): string {
  const sp = new URLSearchParams();
  for (const src of [params, extra]) {
    if (!src) continue;
    for (const [k, v] of Object.entries(src)) {
      if (v !== undefined && v !== "") sp.set(k, v);
    }
  }
  const qs = sp.toString();
  return qs ? `${path}?${qs}` : path;
}

// ────────────────────────────────────────────────────────────────────────
// Single-resource fetch (detail page / aux fetch).
// ────────────────────────────────────────────────────────────────────────

export interface ApiQueryOpts<T> {
  /** When false, defer the fetch (e.g. waiting for an upstream id). */
  enabled?: boolean;
  /** Per-query cache override. Defaults to the QueryClient's 30s. */
  staleTime?: number;
  /** Useful for things like polling; supply a number in ms or a fn. */
  refetchInterval?: UseQueryOptions<T>["refetchInterval"];
}

export function useApiQuery<T>(
  path: string | null | undefined,
  params?: Record<string, string | undefined>,
  opts: ApiQueryOpts<T> = {},
) {
  const { api } = useApi();
  const client = useQueryClient();
  // A missing record is a state every record page and reference draws
  // itself, so a 404 here is never reported (other failures are, once).
  const retry = useReadRetry(true);

  // Normalize params into a stable JSON-shaped object for the queryKey so
  // two callers passing `{ a: "x" }` from different render origins still
  // dedupe. Empty `{}` is the canonical "no params" key.
  const normalizedParams = useMemo(() => params ?? {}, [params]);

  return useQuery<T>({
    // [path, params] is the cache identity. Two consumers with the same
    // path + params share a single in-flight fetch + cache entry.
    queryKey: [path, normalizedParams],
    queryFn: async ({ signal, queryKey }) => {
      // `enabled: false` already short-circuits TQ; this guard is just a
      // safety net for the type system since `path` may be nullable.
      if (!path) throw new Error("useApiQuery: path is required");
      try {
        return await api<T>(buildUrl(path, normalizedParams), { signal, silentErrors: true });
      } catch (err) {
        if (typeof err === "object" && err !== null && client.getQueryData(queryKey) !== undefined) refreshFailures.add(err);
        throw err;
      }
    },
    retry,
    // A read that failed (and had no data) is asked again by its Retry, its
    // interval or a refresh, never just because another component that
    // shows it mounted. Otherwise a screen that draws something only once a
    // read has settled starts a loop: the read fails, the piece mounts, its
    // mount asks again, the read is pending, the piece unmounts, the read
    // fails… (Home asked for the agents about once a second while they
    // were failing).
    retryOnMount: false,
    enabled: (opts.enabled ?? true) && !!path,
    staleTime: opts.staleTime,
    refetchInterval: opts.refetchInterval,
    // Stale-while-revalidate: when params change (filter chip, search,
    // tenant switch), keep the previous result rendered while the new
    // fetch runs in the background. Pages that read `isLoading` only see
    // it true on a truly cold cache; subsequent param tweaks feel
    // instant (no skeleton flash, no layout jump). `isFetching` is still
    // available for callers that want a subtle "refreshing" indicator.
    placeholderData: keepPreviousData,
  });
}

// ────────────────────────────────────────────────────────────────────────
// Cursor-paginated infinite list. Drop-in replacement for `useCursorList`.
// Returned shape mirrors what the existing list pages destructure today
// (items, isLoading, hasMore, loadMore, isLoadingMore, refresh).
// ────────────────────────────────────────────────────────────────────────

interface PageResponse<T> {
  data: T[];
  next_cursor?: string;
}

export interface InfiniteApiQueryOpts<T = unknown> {
  /** Per-page limit. Mirrors `useCursorList`'s `limit`. */
  limit?: number;
  /** Stable identity recommended (pass `useMemo` if reactive). */
  params?: Record<string, string | undefined>;
  /** When false, skip the initial fetch. Defaults to true. */
  enabled?: boolean;
  /** Cursor query param name. Defaults to `cursor` (most OMA endpoints).
   *  Override for endpoints that follow a different convention — e.g.
   *  Anthropic Files uses `before_id`. */
  cursorParam?: string;
  /** Custom extractor for the next-cursor in the response body. Defaults
   *  to `res.next_cursor`. Override for endpoints that return it under
   *  a different key — e.g. Anthropic Files returns `last_id` only when
   *  `has_more` is true. */
  getNextCursor?: (res: unknown) => string | undefined;
}

export function useInfiniteApiQuery<T>(
  endpoint: string,
  opts: InfiniteApiQueryOpts<T> = {},
) {
  const { api } = useApi();
  const client = useQueryClient();
  const retry = useReadRetry(false);
  const cursorParam = opts.cursorParam ?? "cursor";
  const getNextCursor =
    opts.getNextCursor ??
    ((res: unknown) => (res as PageResponse<T>).next_cursor);

  // JSON.stringify keeps the queryKey stable across inline-object renders.
  // Same trick `useCursorList` used internally for its effect deps; with
  // TQ we surface it through the queryKey instead.
  const paramsKey = useMemo(
    () => JSON.stringify(opts.params ?? {}),
    [opts.params],
  );

  const query = useInfiniteQuery<PageResponse<T>>({
    queryKey: [endpoint, "infinite", opts.limit ?? null, paramsKey, cursorParam],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal, queryKey }) => {
      try {
        return await api<PageResponse<T>>(
          buildUrl(
            endpoint,
            opts.params,
            {
              limit: opts.limit ? String(opts.limit) : undefined,
              [cursorParam]: typeof pageParam === "string" ? pageParam : undefined,
            },
          ),
          { signal, silentErrors: true },
        );
      } catch (err) {
        // A failed refresh of a list that is on screen is not reported. A
        // failed "load more" is: `pageParam` is set, and the rows asked for
        // are missing.
        const refreshing = pageParam === undefined && client.getQueryData(queryKey) !== undefined;
        if (refreshing && typeof err === "object" && err !== null) refreshFailures.add(err);
        throw err;
      }
    },
    retry,
    getNextPageParam: (lastPage) => getNextCursor(lastPage),
    enabled: opts.enabled ?? true,
    // Same stale-while-revalidate behavior as useApiQuery: when
    // filter chips change `params` (and therefore the queryKey), TQ
    // would normally toss the old pages and re-skeleton from empty.
    // keepPreviousData makes it render the prior page list while the
    // new fetch runs in the background — page swaps under filter
    // changes feel instant, and `isPending` (→ `isLoading`) only
    // fires on cold cache.
    placeholderData: keepPreviousData,
  });

  // Flatten pages into a single items array so the consumer doesn't have
  // to know about TQ's page-of-pages shape. Stable across renders if the
  // underlying pages array is unchanged.
  const items = useMemo<T[]>(() => {
    const pages = query.data?.pages ?? [];
    if (pages.length === 0) return [];
    if (pages.length === 1) return pages[0].data;
    return pages.flatMap((p) => p.data);
  }, [query.data]);

  const loadMore = useCallback(() => {
    if (query.hasNextPage && !query.isFetchingNextPage) {
      void query.fetchNextPage();
    }
  }, [query]);

  const refresh = useCallback(() => {
    void query.refetch();
  }, [query]);

  return {
    items,
    isLoading: query.isPending,
    isLoadingMore: query.isFetchingNextPage,
    hasMore: !!query.hasNextPage,
    loadMore,
    refresh,
    // The error itself, not its message: what reads it (QueryProblem) words
    // it from the status as well as the text.
    error: (query.error ?? null) as Error | null,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Mutation wrapper. Same surface as `useMutation` but with the toasting
// `api` already wired in. Most callers will pair it with
// `queryClient.invalidateQueries({ queryKey: [path] })` in `onSuccess` —
// re-fetches every list/detail keyed under that path automatically.
// ────────────────────────────────────────────────────────────────────────

export interface ApiMutationVariables<TBody> {
  path: string;
  method?: "POST" | "PUT" | "PATCH" | "DELETE";
  body?: TBody;
  /** Override the JSON-encoding default — pass FormData here directly. */
  formData?: FormData;
}

export function useApiMutation<TResult = unknown, TBody = unknown>(
  options?: Omit<
    UseMutationOptions<TResult, Error, ApiMutationVariables<TBody>>,
    "mutationFn"
  >,
) {
  const { api } = useApi();

  return useMutation<TResult, Error, ApiMutationVariables<TBody>>({
    mutationFn: ({ path, method = "POST", body, formData }) =>
      api<TResult>(path, {
        method,
        body: formData ?? (body !== undefined ? JSON.stringify(body) : undefined),
      }),
    ...options,
  });
}

// Re-export for callers that need direct cache control (e.g. optimistic
// patches, manual invalidation outside a mutation lifecycle).
export { useQueryClient };

// ────────────────────────────────────────────────────────────────────────
// A read that is allowed to fail. No toast: the caller draws the outcome
// (for example "History is not kept on this server"). `missing` is true
// when the server answered 404 or 501.
// ────────────────────────────────────────────────────────────────────────

export function useQuietQuery<T>(path: string | null | undefined, enabled = true) {
  const { api } = useApi();
  const query = useQuery<T>({
    queryKey: ["quiet", path],
    queryFn: ({ signal }) => api<T>(path!, { signal, silentErrors: true }),
    enabled: enabled && !!path,
    retry: false,
  });
  const status = query.error instanceof ApiError ? query.error.status : undefined;
  return { ...query, missing: status === 404 || status === 501 };
}
