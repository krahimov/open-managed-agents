// Pick a known MCP server from the shared MCP_REGISTRY (same registry the
// vault page's "Connect a service" flow uses). Keeps the agent-config
// form, the vault-credential flow, and any future consumer (session
// creation, integration UI, etc.) in sync — adding a new server to the
// registry surfaces it everywhere automatically.
//
// Two forms of the same list:
//
//   <McpServerPicker … />        the searchable list on its own, for a
//                                popover or an inline panel
//   <McpServerPickerModal … />   the list in a dialog, for pages that have
//                                no dialog open already
//
//   <McpServerPickerModal
//     open={...}
//     onClose={...}
//     alreadyAddedUrls={form.mcpServers.map((s) => s.url)}  // disables row + shows "Added"
//     onPick={(entry) => { addToYourForm(entry); }}
//   />
//
// The modal closes itself after a pick — caller doesn't need to manage that.

import { useState, type JSX, type ReactNode } from "react";
import { CheckIcon, PlusIcon, SearchIcon } from "lucide-react";

import { cn } from "@/lib/utils";

import { MCP_REGISTRY, type McpRegistryEntry } from "../lib/mcp-registry";
import { AppIcon } from "./agents/controls";
import { Modal } from "./Modal";

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export interface McpServerPickerProps {
  /** URLs already added in the calling form — shown with an "Added" mark
   *  instead of letting the user double-add. */
  alreadyAddedUrls?: ReadonlyArray<string>;
  onPick: (entry: McpRegistryEntry) => void;
  /** A last row under the list (e.g. "Add a custom URL"). */
  footer?: ReactNode;
  autoFocus?: boolean;
  /** Tailwind max-height for the scrolling list. */
  listClassName?: string;
}

/** The searchable list of known MCP servers. */
export function McpServerPicker({
  alreadyAddedUrls = [],
  onPick,
  footer,
  autoFocus = true,
  listClassName = "max-h-80",
}: McpServerPickerProps): JSX.Element {
  const [search, setSearch] = useState("");
  const addedSet = new Set(alreadyAddedUrls);
  const q = search.trim().toLowerCase();
  const filtered = q
    ? MCP_REGISTRY.filter((e) => e.name.toLowerCase().includes(q) || e.url.toLowerCase().includes(q))
    : MCP_REGISTRY;

  return (
    <div className="flex min-h-0 flex-col">
      <div className="relative shrink-0">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden="true" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search servers"
          aria-label="Search MCP servers"
          autoFocus={autoFocus}
          autoComplete="off"
          className="h-9 w-full rounded-full border border-border-strong bg-bg-surface pr-3 pl-9 text-small-size text-fg shadow-[var(--shadow-xs)] transition-quick outline-none placeholder:text-fg-subtle hover:border-fg-faint focus-visible:border-plum focus-visible:shadow-[var(--shadow-focus)] focus-visible:outline-none dark:bg-bg-soft"
        />
      </div>
      <ul className={cn("-mx-1.5 mt-2 min-h-0 overflow-y-auto px-1.5", listClassName)}>
        {filtered.map((entry) => {
          const alreadyAdded = addedSet.has(entry.url);
          return (
            <li key={entry.id}>
              <button
                type="button"
                onClick={() => {
                  if (alreadyAdded) return;
                  onPick(entry);
                  setSearch("");
                }}
                disabled={alreadyAdded}
                className={cn(
                  "group/server flex min-h-12 w-full items-center gap-3 rounded-md px-2 py-1.5 text-left transition-quick",
                  alreadyAdded ? "cursor-default" : "hover:bg-bg-hover",
                )}
              >
                <AppIcon slug={entry.id} name={entry.name} size="md" className={cn(alreadyAdded && "opacity-60")} />
                <span className="min-w-0 flex-1">
                  <span className={cn("block truncate text-small leading-5 font-medium", alreadyAdded ? "text-fg-muted" : "text-fg")}>
                    {entry.name}
                  </span>
                  <span className="block truncate text-xs text-fg-subtle" title={entry.url}>
                    {hostOf(entry.url)}
                  </span>
                </span>
                {alreadyAdded ? (
                  <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-fg-subtle">
                    <CheckIcon className="size-3.5" />
                    Added
                  </span>
                ) : (
                  <PlusIcon className="size-4 shrink-0 text-fg-faint transition-quick group-hover/server:text-fg" aria-hidden="true" />
                )}
              </button>
            </li>
          );
        })}
        {filtered.length === 0 && (
          <li className="px-2 py-6 text-center text-small text-fg-subtle">
            No known server matches "{search.trim()}". Add it by URL instead.
          </li>
        )}
      </ul>
      {footer && <div className="mt-2 shrink-0 border-t border-border pt-2">{footer}</div>}
    </div>
  );
}

export interface McpServerPickerModalProps {
  open: boolean;
  onClose: () => void;
  /** URLs already added in the calling form — picker shows them disabled
   *  with an "Added" badge instead of letting the user double-add. */
  alreadyAddedUrls?: ReadonlyArray<string>;
  onPick: (entry: McpRegistryEntry) => void;
}

export function McpServerPickerModal({
  open,
  onClose,
  alreadyAddedUrls = [],
  onPick,
}: McpServerPickerModalProps): JSX.Element {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add an MCP server"
      subtitle="Servers we know how to reach. The same list is used when you connect a service to a vault."
      maxWidth="max-w-lg"
    >
      {/* Remounts on open, so the search starts empty every time. */}
      {open && (
        <McpServerPicker
          alreadyAddedUrls={alreadyAddedUrls}
          onPick={(entry) => {
            onPick(entry);
            onClose();
          }}
        />
      )}
    </Modal>
  );
}
