import { useMemo } from "react";

import { useApiQuery } from "@/lib/useApiQuery";

/**
 * Memory store model + small read helpers, shared by the Memory list and
 * the store record.
 */
export interface MemoryStore {
  id: string;
  name: string;
  description?: string | null;
  created_at: string;
  updated_at?: string | null;
  archived_at?: string | null;
}

export interface MemoryListItem {
  id: string;
  store_id: string;
  path: string;
  content_sha256: string;
  etag: string;
  size_bytes: number;
  created_at: string;
  updated_at: string;
}

export interface Memory extends MemoryListItem {
  content: string;
}

export interface MemoryVersion {
  id: string;
  memory_id: string;
  store_id: string;
  operation: "created" | "modified" | "deleted";
  path?: string;
  content?: string;
  content_sha256?: string;
  size_bytes?: number;
  actor: { type: string; id: string };
  created_at: string;
  redacted?: boolean;
}

/** Where a store appears inside a sandbox when it is attached to a session. */
export function mountPath(store: Pick<MemoryStore, "name">): string {
  return `/mnt/memory/${store.name}/`;
}

/**
 * A store's entries (unfiltered) and their totals. The list rows and the
 * record page read the same cache entry.
 */
export function useMemoryEntries(storeId: string | null | undefined) {
  const query = useApiQuery<{ data: MemoryListItem[] }>(storeId ? `/v1/memory_stores/${storeId}/memories` : null);
  const entries = query.data?.data;
  const stats = useMemo(() => {
    if (!entries) return undefined;
    let bytes = 0;
    let latest: string | null = null;
    const folders = new Set<string>();
    for (const m of entries) {
      bytes += m.size_bytes ?? 0;
      if (!latest || m.updated_at > latest) latest = m.updated_at;
      const folder = topFolder(m.path);
      if (folder) folders.add(folder);
    }
    return { count: entries.length, bytes, latest, folders: folders.size };
  }, [entries]);
  return { ...query, entries, stats };
}

/** "/customers/acme.md" → "customers"; "/readme.md" → "" (root). */
export function topFolder(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 1 ? parts[0] : "";
}

/** File name of a memory path. */
export function baseName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
