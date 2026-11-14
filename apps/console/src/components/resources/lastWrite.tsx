import { RelativeTime } from "../RelativeTime";
import { Skeleton } from "../Skeleton";

/**
 * When a memory store was last written to: ONE story, told from its
 * entries.
 *
 * A store record has its own `updated_at`, which moves when the store
 * itself is touched (created, renamed, re-described). It used to stand in
 * for "Last write" whenever the entries had no date to give, so an empty
 * store read "0 entries · Nothing remembered yet" beside "Last write
 * Nov 3". A write is an entry; a store with no entries has no last write.
 *
 *   entries, newest written Nov 3   → Nov 3
 *   no entries                      → "Nothing written yet"
 *   entries could not be read       → "Not known" (never a guess)
 */
export type LastWrite = { kind: "at"; at: string } | { kind: "never" } | { kind: "unknown" };

export function lastWriteOf(stats: { count: number; latest: string | null } | undefined): LastWrite {
  if (!stats) return { kind: "unknown" };
  if (stats.count === 0 || !stats.latest) return { kind: "never" };
  return { kind: "at", at: stats.latest };
}

export function StoreLastWrite({
  stats,
  isLoading,
  never = "Nothing written yet",
  className,
}: {
  stats: { count: number; latest: string | null } | undefined;
  isLoading: boolean;
  /** What an empty store says. A table cell wants it short. */
  never?: string;
  className?: string;
}) {
  if (isLoading) return <Skeleton className="h-3.5 w-14" rounded="sm" />;
  const last = lastWriteOf(stats);
  if (last.kind === "at") return <RelativeTime value={last.at} className={className} />;
  return <span className="text-fg-subtle">{last.kind === "never" ? never : "Not known"}</span>;
}
