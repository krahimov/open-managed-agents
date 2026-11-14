import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { MonitorIcon, MoonIcon, PlusIcon, SquarePenIcon, SunIcon } from "lucide-react";

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

import { ENTITY_META, useAgents, useRecentSessions, type EntityKind } from "../lib/directory";
import { plural } from "../lib/format";
import { describeModel } from "../lib/models";
import { matchRanges, NAME_TIER, rank, unmatchedWords, type Range, type Rankable } from "../lib/palette-rank";
import { READ_PROBLEM } from "../lib/read-failures";
import { useApiQuery } from "../lib/useApiQuery";
import { ROUTE_CHORDS } from "../lib/route-chords";
import { sessionTitle } from "../lib/sessions";
import { onOpenCommandPalette, startSession } from "../lib/shell-events";
import { useTheme } from "../lib/theme";
import { cn } from "../lib/utils";
import type { AgentRecord } from "../types/agent";
import type { SessionRecord } from "../types/session";
import { AgentAvatar } from "./AgentAvatar";
import { SessionStatusDot } from "./sessions/SessionStatus";
import { useSessionReadings } from "./sessions/readings";
import { Kbd } from "./Kbd";
import { useNavigation, type NavItem } from "./navigation";
import { RelativeTime } from "./RelativeTime";

const THEMES = [
  { value: "light" as const, label: "Switch to light theme", more: "appearance", icon: SunIcon },
  { value: "dark" as const, label: "Switch to dark theme", more: "appearance", icon: MoonIcon },
  { value: "system" as const, label: "Match the system theme", more: "appearance auto", icon: MonitorIcon },
];

/** Sessions listed before anything is typed. A search looks through every loaded session. */
const RECENT_SHOWN = 30;
/** How many sessions the directory keeps (lib/directory.ts, useRecentSessions). */
const RECENT_WINDOW = 100;

/** "agents", "agents and sessions", "agents, sessions and vaults". */
const listOf = (items: string[]) =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

type Icon = ComponentType<{ className?: string }>;

/**
 * One thing the palette can open or do. `name`, `more`, `id` and `weight`
 * are what it is ranked on. `found` is where else a query can find the row,
 * in the order it is explained from: when the name does not hold every word
 * that was typed, the first of these that does is shown under the name
 * with those words in bold.
 */
type Row = Rankable & { key: string; run: () => void; found?: Evidence[] } & (
    | { kind: "action"; icon: Icon }
    | { kind: "page"; item: NavItem & { group: string } }
    | { kind: "agent"; agent: AgentRecord }
    | { kind: "record"; label: string; archived: boolean; icon: Icon }
    | { kind: "session"; session: SessionRecord }
    | { kind: "theme"; icon: Icon }
  );

/** A piece of a row, other than its name, that a query can match. */
interface Evidence {
  /** Said before the text when the text alone would not explain itself ("Keyword"). */
  label?: string;
  text: string;
  /** A list of separate words (keywords): only the ones that matched are shown. */
  words?: boolean;
}

/** The other things with names: found in a search, never listed before one. */
const RECORD_KINDS: Array<{ kind: EntityKind; label: string; nav: string }> = [
  { kind: "environment", label: "Environment", nav: "/environments" },
  { kind: "vault", label: "Vault", nav: "/vaults" },
  { kind: "memory_store", label: "Memory store", nav: "/memory" },
];
const RECORD_PARAMS = { limit: "200" } as const;

interface NamedRecord {
  id: string;
  name?: string | null;
  description?: string | null;
  archived_at?: string | null;
}

/** `text` with the stretches a query matched set in bold. */
function Marked({ text, ranges }: { text: string; ranges: Range[] }) {
  if (ranges.length === 0) return <>{text}</>;
  const parts: ReactNode[] = [];
  let at = 0;
  ranges.forEach(([start, end], i) => {
    if (start > at) parts.push(text.slice(at, start));
    parts.push(
      <mark key={i} className="bg-transparent font-semibold text-fg">
        {text.slice(start, end)}
      </mark>,
    );
    at = end;
  });
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

/** How far before the first match a long text starts being shown. */
const LEAD_IN = 36;

/**
 * Why a row that did not match on its name is in the list: the keyword,
 * description, agent or id that holds the words, with those words in bold.
 * Null when the name explains itself.
 */
function explain(query: string, row: Row, tier: number): { label?: string; text: string; ranges: Range[]; mono?: boolean } | null {
  if (tier <= NAME_TIER) return null;
  if (tier === 6 && row.id) return { label: "Id", text: row.id, ranges: matchRanges(query, row.id), mono: true };
  // What the name does not account for.
  const left = unmatchedWords(query, row.name);
  if (left.length === 0) return null;
  for (const ev of row.found ?? []) {
    if (!ev.text) continue;
    const explains = unmatchedWords(left.join(" "), ev.text).length < left.length;
    if (!explains) continue;
    if (ev.words) {
      // Only the keywords that matched: "billing", not the whole list.
      const hit = ev.text.split(/\s+/).filter((w) => matchRanges(query, w).length > 0);
      const text = hit.join(", ");
      return { label: ev.label, text, ranges: hit.length ? matchRangesInList(query, hit) : [] };
    }
    const ranges = matchRanges(query, ev.text);
    // A long description opens a little before the match, on a whole word.
    const first = ranges[0]?.[0] ?? 0;
    let from = 0;
    if (first > LEAD_IN + 12) {
      from = ev.text.lastIndexOf(" ", first - LEAD_IN) + 1;
    }
    const text = (from > 0 ? "…" : "") + ev.text.slice(from);
    const shift = from > 0 ? 1 - from : 0;
    return { label: ev.label, text, ranges: ranges.filter(([a]) => a >= from).map(([a, b]) => [a + shift, b + shift]) };
  }
  return null;
}

/** Ranges for a query over words joined by ", ". */
function matchRangesInList(query: string, list: string[]): Range[] {
  const out: Range[] = [];
  let offset = 0;
  for (const w of list) {
    for (const [a, b] of matchRanges(query, w)) out.push([a + offset, b + offset]);
    offset += w.length + 2;
  }
  return out;
}

/**
 * Global command palette (⌘K / Ctrl+K).
 *
 * Before anything is typed it is a menu, five groups in the order people
 * reach for them:
 *
 *   Actions          start a session, create an agent
 *   Go to            every destination in the sidebar (from navigation.tsx,
 *                    so a new route appears here automatically), with its
 *                    `g` chord
 *   Agents           jump to an agent
 *   Recent sessions  jump to a session
 *   Appearance       the themes you are not on; last, because it is rare
 *
 * Once something is typed it is a search: ONE list across all of those,
 * plus the workspace's environments, vaults and memory stores (read when
 * the palette opens). It is ordered by how well the NAME matches
 * (lib/palette-rank.ts): an exact name, then names that start with the
 * query, then names with a word that starts with it, then names that
 * contain it; and among those, the named things (pages, agents,
 * environments…) before session titles. Rows that only mention the query
 * in a keyword, a description or an id follow under "Other matches".
 *
 * Every row says why it is there. The words that matched are in bold: in
 * the name, or, when the name does not hold them, in a second line that
 * shows the keyword, the description, the session's agent or the id they
 * were found in. Each row also says what kind of thing it is, since the
 * group headings are gone.
 *
 * A search can only be as complete as what was loaded. When agents,
 * sessions or the other records could not be read, the list says which,
 * with a Retry, rather than answer "no match" for things it never saw.
 *
 * The palette ranks its own rows, so cmdk's fuzzy filter is off
 * (`shouldFilter={false}`): that filter scored names, keywords and ids as
 * one string, which is how "triage" used to open on Operations.
 *
 * Opens from the keyboard, from the sidebar's Search row and from the
 * account menu (lib/shell-events.ts → openCommandPalette()).
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const nav = useNavigate();
  const { theme, setTheme } = useTheme();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const cmdK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k";
      if (cmdK) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    const off = onOpenCommandPalette(() => setOpen(true));
    return () => {
      window.removeEventListener("keydown", onKey);
      off();
    };
  }, []);

  // Every opening starts clean.
  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  // A new query selects its first row, so the list starts from the top.
  // Left alone, cmdk scrolls to the row that WAS selected whenever that row
  // is still among the new results ("s" opened on its twelfth row, where
  // "New session" had moved to). So a row's identity includes the query
  // (`rowValue`): no selection survives a keystroke, and the list is put
  // back at the top.
  const listRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    listRef.current?.scrollTo({ top: 0 });
  }, [query]);
  const rowValue = (key: string) => `${key} @${query.trim()}`;

  // The directory hooks are shared with the sidebar: no extra requests.
  const agentsQuery = useAgents();
  const sessionsQuery = useRecentSessions();
  const { agents } = agentsQuery;
  const { sessions } = sessionsQuery;
  // The one reading of a session, as the sidebar and the lists draw it.
  const { read: readSession } = useSessionReadings();
  // The other named records are read when the palette first opens (the same
  // cache entries a record page's name lookups use).
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    if (open) setOpened(true);
  }, [open]);
  const environments = useApiQuery<{ data: NamedRecord[] }>(opened ? ENTITY_META.environment.endpoint : null, RECORD_PARAMS, { staleTime: 5 * 60_000 });
  const vaults = useApiQuery<{ data: NamedRecord[] }>(opened ? ENTITY_META.vault.endpoint : null, RECORD_PARAMS, { staleTime: 5 * 60_000 });
  const memoryStores = useApiQuery<{ data: NamedRecord[] }>(opened ? ENTITY_META.memory_store.endpoint : null, RECORD_PARAMS, { staleTime: 5 * 60_000 });
  const recordLists = useMemo(
    () => [environments.data?.data, vaults.data?.data, memoryStores.data?.data],
    [environments.data, vaults.data, memoryStores.data],
  );

  // What a search cannot see right now, in words, and how to try again.
  const sources = [
    { what: "agents", query: agentsQuery },
    { what: "sessions", query: sessionsQuery },
    { what: "environments", query: environments },
    { what: "vaults", query: vaults },
    { what: "memory stores", query: memoryStores },
  ];
  const unread = sources.filter((s) => s.query.data === undefined && s.query.isError && !s.query.isFetching);

  // Only the destinations this server has.
  const { items: navItems } = useNavigation();

  const rows = useMemo<Row[]>(() => {
    const run = (fn: () => void) => () => {
      setOpen(false);
      fn();
    };
    const go = (to: string) => run(() => nav(to));
    return [
      {
        kind: "action",
        key: "action:new-session",
        name: "New session",
        more: "start conversation chat compose action",
        weight: 0,
        icon: SquarePenIcon,
        run: run(() => startSession()),
      },
      {
        kind: "action",
        key: "action:new-agent",
        name: "New agent",
        more: "create action",
        weight: 0,
        icon: PlusIcon,
        run: go("/agents?create=1"),
      },
      ...navItems.map(
        (item): Row => ({
          kind: "page",
          key: `page:${item.to}`,
          name: item.label,
          more: `${item.keywords ?? ""} ${item.group} page`,
          weight: 1,
          item,
          found: [
            { label: "Also called", text: item.keywords ?? "", words: true },
            { label: "In", text: item.group === "Go to" ? "" : item.group },
          ],
          run: go(item.to),
        }),
      ),
      ...agents.map(
        (agent): Row => ({
          kind: "agent",
          key: `agent:${agent.id}`,
          name: agent.name,
          more: `agent ${agent.description ?? ""}`,
          id: agent.id,
          // An archived agent is still findable, after the ones in use.
          weight: agent.archived_at ? 2.5 : 2,
          agent,
          found: [{ text: agent.description ?? "" }],
          run: go(`/agents/${agent.id}`),
        }),
      ),
      ...RECORD_KINDS.flatMap(({ kind, label, nav: to }, i) => {
        const icon = navItems.find((it) => it.to === to)?.icon ?? PlusIcon;
        return (recordLists[i] ?? []).map(
          (record): Row => ({
            kind: "record",
            key: `${kind}:${record.id}`,
            name: record.name?.trim() || `Unnamed ${label.toLowerCase()}`,
            more: `${label} ${record.description ?? ""}`,
            id: record.id,
            weight: record.archived_at ? 2.5 : 2.2,
            label,
            archived: !!record.archived_at,
            icon,
            found: [{ text: record.description ?? "" }],
            run: go(`${ENTITY_META[kind].route}/${record.id}`),
          }),
        );
      }),
      ...sessions.map(
        (session): Row => ({
          kind: "session",
          key: `session:${session.id}`,
          name: sessionTitle(session),
          more: `session ${session.agent?.name ?? ""}`,
          id: session.id,
          weight: 3,
          many: true,
          session,
          found: [{ label: "With", text: session.agent?.name ?? "" }],
          run: go(`/sessions/${session.id}`),
        }),
      ),
      ...THEMES.filter((t) => t.value !== theme).map(
        (t): Row => ({
          kind: "theme",
          key: `theme:${t.value}`,
          name: t.label,
          more: t.more,
          weight: 4,
          icon: t.icon,
          run: run(() => setTheme(t.value)),
        }),
      ),
    ];
  }, [agents, sessions, recordLists, theme, nav, setTheme, navItems]);

  const searching = query.trim().length > 0;
  const results = useMemo(() => (searching ? rank(query, rows) : []), [searching, query, rows]);
  const best = results.filter((r) => r.tier <= NAME_TIER);
  const other = results.filter((r) => r.tier > NAME_TIER);

  const of = <K extends Row["kind"]>(kind: K) => rows.filter((r): r is Extract<Row, { kind: K }> => r.kind === kind);

  const renderRow = (row: Row, tier = 0) => {
    let lead: ReactNode;
    let trail: ReactNode = null;
    /** Said only in a search, where no group heading names the kind. */
    let kindLabel = "";
    switch (row.kind) {
      case "action":
      case "theme":
        lead = <row.icon />;
        kindLabel = row.kind === "action" ? "Action" : "Appearance";
        break;
      case "page": {
        const chord = ROUTE_CHORDS[row.item.to];
        lead = <row.item.icon className="size-4 stroke-[1.75]" />;
        kindLabel = row.item.group === "Go to" ? "" : row.item.group;
        trail = (
          <>
            {!searching && kindLabel && <span className="text-xs text-fg-subtle">{kindLabel}</span>}
            {chord && (
              <CommandShortcut className={searching ? "ml-0 pl-0" : undefined}>
                <Kbd keys={["G", chord.toUpperCase()]} then />
              </CommandShortcut>
            )}
          </>
        );
        break;
      }
      case "agent": {
        const archived = !!row.agent.archived_at;
        lead = <AgentAvatar name={row.agent.name} id={row.agent.id} size="sm" archived={archived} />;
        kindLabel = archived ? "Archived agent" : "Agent";
        trail = <span className="text-xs text-fg-subtle">{describeModel(row.agent.model).label}</span>;
        break;
      }
      case "record":
        lead = <row.icon className="size-4 stroke-[1.75]" />;
        kindLabel = row.archived ? `Archived ${row.label.toLowerCase()}` : row.label;
        break;
      case "session": {
        const s = row.session;
        const reading = readSession(s);
        lead = <AgentAvatar name={s.agent?.name} id={s.agent?.id} size="sm" />;
        kindLabel = "Session";
        trail = (
          <>
            {reading.tone !== "neutral" && (
              <>
                <SessionStatusDot reading={reading} />
                <span className="sr-only">{reading.label}</span>
              </>
            )}
            <RelativeTime value={s.updated_at || s.created_at} className="text-xs text-fg-subtle" />
          </>
        );
        break;
      }
    }
    const why = searching ? explain(query, row, tier) : null;
    return (
      // `value` is the row's identity for cmdk's selection, not a search string.
      <CommandItem key={rowValue(row.key)} value={rowValue(row.key)} onSelect={row.run}>
        {/* One 24px column for an icon or a face, so every name starts on the same edge. */}
        <span className="flex size-6 shrink-0 items-center justify-center">{lead}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate">{searching ? <Marked text={row.name} ranges={matchRanges(query, row.name)} /> : row.name}</span>
          {why && (
            // Why it matched, when the name does not say: the words are in bold.
            <span className={cn("block truncate text-xs leading-[1.35] text-fg-subtle", why.mono && "font-mono text-micro-size")}>
              {why.label && <span className="font-sans text-xs">{why.label} </span>}
              <Marked text={why.text} ranges={why.ranges} />
            </span>
          )}
        </span>
        {searching && kindLabel && (
          <span className="shrink-0 text-xs text-fg-subtle">
            {/* A query that names the kind ("vault") matched this label. */}
            <Marked text={kindLabel} ranges={why ? [] : tier > NAME_TIER ? matchRanges(query, kindLabel) : []} />
          </span>
        )}
        {trail}
      </CommandItem>
    );
  };

  const activeAgents = of("agent").filter((r) => !r.agent.archived_at);
  const recentSessions = of("session").slice(0, RECENT_SHOWN);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="top-[18%] translate-y-0 gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-[640px]"
        showCloseButton={false}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Command palette</DialogTitle>
          <DialogDescription>Search for a page, an agent or a session, or run an action.</DialogDescription>
        </DialogHeader>
        <Command loop shouldFilter={false} className="rounded-none bg-transparent">
          <CommandInput value={query} onValueChange={setQuery} placeholder="Search or jump to…" />
          <CommandList ref={listRef}>
            <CommandEmpty>
              {searching ? (
                <>
                  <span className="block">
                    Nothing matches <span className="font-medium text-fg">“{query.trim()}”</span>.
                  </span>
                  <span className="mx-auto mt-1 block max-w-[26rem] text-xs">
                    Searched pages, agents, environments, vaults, memory stores and the latest {RECENT_WINDOW} sessions. Older
                    sessions can be searched on the Sessions page.
                  </span>
                </>
              ) : (
                "Nothing to show yet."
              )}
            </CommandEmpty>

            {searching ? (
              <>
                {best.length > 0 && <CommandGroup heading="Best matches">{best.map((r) => renderRow(r.item, r.tier))}</CommandGroup>}
                {other.length > 0 && (
                  <CommandGroup heading={best.length > 0 ? "Other matches" : "Matches"}>
                    {other.map((r) => renderRow(r.item, r.tier))}
                  </CommandGroup>
                )}
              </>
            ) : (
              <>
                <CommandGroup heading="Actions">{of("action").map((r) => renderRow(r))}</CommandGroup>
                <CommandGroup heading="Go to">{of("page").map((r) => renderRow(r))}</CommandGroup>
                {activeAgents.length > 0 && <CommandGroup heading="Agents">{activeAgents.map((r) => renderRow(r))}</CommandGroup>}
                {recentSessions.length > 0 && (
                  <CommandGroup heading="Recent sessions">{recentSessions.map((r) => renderRow(r))}</CommandGroup>
                )}
                <CommandGroup heading="Appearance">{of("theme").map((r) => renderRow(r))}</CommandGroup>
              </>
            )}

            {unread.length > 0 && (
              // Not a result: what the list above is missing, and a way to get it.
              <div
                {...READ_PROBLEM}
                role="status"
                className="mx-1 mt-1.5 flex min-h-10 items-center gap-2 rounded-md bg-bg-soft px-3 py-1.5 text-small text-fg-muted"
              >
                <span className="min-w-0 flex-1">
                  Could not load {listOf(unread.map((u) => u.what))}
                  {searching ? ", so they are not in these results." : "."}
                </span>
                <button
                  type="button"
                  onClick={() => unread.forEach((u) => void u.query.refetch())}
                  className="flex h-7 shrink-0 items-center rounded-full px-2.5 text-xs font-medium text-fg transition-quick hover:bg-bg-hover"
                >
                  Retry
                </button>
              </div>
            )}
          </CommandList>

          {/* Keyboard hints: not on a phone, where there are no such keys. */}
          <div className="hidden h-10 shrink-0 items-center gap-4 border-t border-border px-4 text-xs text-fg-subtle sm:flex">
            <span className="flex items-center gap-1.5">
              <Kbd keys={["↑", "↓"]} /> Move
            </span>
            <span className="flex items-center gap-1.5">
              <Kbd>↵</Kbd> Open
            </span>
            <span className="flex items-center gap-1.5">
              <Kbd>esc</Kbd> Close
            </span>
            {searching && results.length > 0 && <span className="ml-auto">{plural(results.length, "result")}</span>}
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
