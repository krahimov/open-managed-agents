import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { CheckIcon, ChevronDownIcon } from "lucide-react";

import { Command, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useApi } from "@/lib/api";
import { useQuietQuery } from "@/lib/useApiQuery";
import { cn } from "@/lib/utils";

import { Skeleton } from "../Skeleton";
import { LookupProblem } from "./LookupProblem";

/**
 * Choose the environment a session runs in.
 *
 *   <EnvironmentPicker value={id} onChange={setId} />
 *
 * Two lookups, and each says what it found. The list (searched on the
 * server, so a workspace with many environments is reachable by name) is
 * loading, has environments, has none, or could not be loaded, with a retry
 * in place. The name of the environment already chosen is looked up on its
 * own, because it may be the agent's default and not on the first page:
 * `name` reports it to the caller as loading, found, gone, or unavailable,
 * so the field around the picker can say so instead of showing an id.
 */

export interface EnvironmentPick {
  id: string;
  name: string;
  description?: string;
  archived_at?: string | null;
}

const PAGE = 50;

/** The name of one environment: found, still loading, deleted, or the lookup failed. */
export function useEnvironmentName(id: string | null | undefined) {
  const query = useQuietQuery<EnvironmentPick>(id ? `/v1/environments/${id}` : null);
  return {
    name: query.data?.name,
    archived: !!query.data?.archived_at,
    isLoading: !!id && query.isLoading,
    /** The server says there is no such environment. */
    missing: !!id && query.missing,
    /** The lookup failed for another reason: nothing is known about it. */
    failed: !!id && !!query.error && !query.missing,
    refetch: query.refetch,
  };
}

export function EnvironmentPicker({
  value,
  onChange,
  name,
  id,
  "aria-labelledby": labelledBy,
  "aria-describedby": describedBy,
  "aria-invalid": invalid,
}: {
  value: string;
  onChange: (id: string) => void;
  /** The chosen environment's name, from `useEnvironmentName`. */
  name: ReturnType<typeof useEnvironmentName>;
  id?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}) {
  const { api } = useApi();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    const t = window.setTimeout(() => setSearch(input.trim()), 250);
    return () => window.clearTimeout(t);
  }, [input]);

  const list = useQuery({
    queryKey: ["quiet", "/v1/environments", "picker", search],
    queryFn: ({ signal }) => {
      const sp = new URLSearchParams({ limit: String(PAGE) });
      if (search) sp.set("q", search);
      return api<{ data: EnvironmentPick[]; next_cursor?: string }>(`/v1/environments?${sp}`, { signal, silentErrors: true });
    },
    enabled: open,
    retry: false,
    placeholderData: keepPreviousData,
  });
  const rows = (list.data?.data ?? []).filter((e) => !e.archived_at || e.id === value);
  const inList = rows.find((e) => e.id === value);

  const label = !value
    ? "Choose an environment"
    : (inList?.name ?? name.name ?? (name.isLoading ? "Loading environment…" : name.missing ? "Deleted environment" : "Environment name unavailable"));

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setInput("");
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          id={id}
          role="combobox"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-labelledby={labelledBy}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          className="inline-flex h-9 w-full items-center justify-between gap-2 rounded-md border border-border-strong bg-bg-surface px-3 text-sm text-fg shadow-[var(--shadow-xs)] transition-quick outline-none hover:border-fg-faint focus-visible:border-plum focus-visible:shadow-[var(--shadow-focus)] focus-visible:outline-none aria-expanded:border-plum aria-invalid:border-danger dark:bg-bg-soft"
        >
          <span title={label} className={cn("flex-1 truncate text-left", (!value || (!inList && !name.name)) && "text-fg-subtle")}>
            {label}
          </span>
          <ChevronDownIcon className="size-4 shrink-0 text-fg-subtle" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] min-w-[260px] gap-0 p-0">
        <Command shouldFilter={false} className="max-h-80">
          <CommandInput value={input} onValueChange={setInput} placeholder="Search environments" autoFocus />
          <CommandList>
            {list.isPending ? (
              // Loading: the list is not known yet.
              <div className="space-y-1 p-1.5" role="status" aria-label="Loading environments">
                {[62, 48, 55].map((w) => (
                  <div key={w} className="flex h-9 items-center px-2">
                    <Skeleton className="h-3.5" rounded="sm" style={{ width: `${w}%` }} />
                  </div>
                ))}
              </div>
            ) : list.error ? (
              // Could not load: said so, with a retry in place. Never "no environments".
              <div className="p-2">
                <LookupProblem what="Environments" error={list.error} retry={() => list.refetch()} />
              </div>
            ) : rows.length === 0 ? (
              // Loaded, and there is nothing.
              <p className="px-3.5 py-6 text-center text-small text-fg-subtle">
                {search ? `No environment matches “${search}”.` : "This workspace has no environments yet."}
              </p>
            ) : (
              <>
                {rows.map((e) => (
                  <CommandItem
                    key={e.id}
                    value={e.id}
                    onSelect={() => {
                      onChange(e.id);
                      setOpen(false);
                      setInput("");
                    }}
                    className="items-start gap-2.5 py-2"
                  >
                    <span className="block min-w-0 flex-1">
                      <span className="block truncate font-medium text-fg">{e.name}</span>
                      {e.description && <span className="block truncate text-xs text-fg-subtle">{e.description}</span>}
                    </span>
                    {e.id === value && <CheckIcon className="mt-0.5 size-4 shrink-0 text-fg" />}
                  </CommandItem>
                ))}
                {list.data?.next_cursor && (
                  <p className="px-3 py-2 text-xs text-fg-subtle">Showing the first {PAGE}. Search by name to find the rest.</p>
                )}
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
