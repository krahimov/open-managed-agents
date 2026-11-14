import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type UIEvent } from "react";
import { Link, NavLink, useLocation } from "react-router";
import { ChevronRightIcon, PlusIcon, SearchIcon } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sidebar, SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

import { BRAND_NAME } from "../lib/brand";
import { useAgents, useRecentSessions } from "../lib/directory";
import { formatRelativeTime } from "../lib/format";
import { ROUTE_CHORDS } from "../lib/route-chords";
import { plural } from "../lib/format";
import { sessionTitle } from "../lib/sessions";
import { READ_PROBLEM } from "../lib/read-failures";
import { MOD_KEY, openCommandPalette, startSession } from "../lib/shell-events";
import type { AgentRecord } from "../types/agent";
import type { SessionRecord } from "../types/session";
import { AgentAvatar } from "./AgentAvatar";
import { StatusDot } from "./Badge";
import { SessionStatusDot } from "./sessions/SessionStatus";
import { useAgentActivityNow, usePatienceForRequests, useSessionReadings } from "./sessions/readings";
import { Kbd } from "./Kbd";
import { Logo } from "./Logo";
import { isNavItemActive, useNavigation, type NavGroup, type NavItem } from "./navigation";
import { Skeleton } from "./Skeleton";
import { TenantSwitcher } from "./TenantSwitcher";
import { Tip } from "./Tip";
import { UserProfile } from "./UserProfile";

/**
 * The sidebar — a chat-app sidebar, not a settings tree.
 *
 *   brand row         Orrery mark + collapse (⌘B)
 *   New session       the one prominent control; opens Home's composer
 *   Search            opens the command palette (⌘K)
 *   primary nav       Home · Agents · Sessions · Operations (with a count
 *                     when something is waiting on a person; only on a
 *                     server that has it, see navigation.tsx)
 *   Frequent          the agents this workspace talks to most; hover a row
 *                     for "new session with this agent"
 *   Recents           the latest sessions, one flat list, with a dot when
 *                     one is running, waiting for approval or failed
 *   Workspace         everything else, as four rows (Run, Build, Connect,
 *                     Settings). A row opens a menu beside it; it never
 *                     grows in place.
 *   foot              workspace switcher + account menu
 *
 * ONE LAYOUT. Nothing in here appears, disappears, opens or moves because
 * of the route you are on. The only thing navigation changes is which row
 * is drawn as current:
 *
 *   - a primary page, a frequent agent or a recent session is current on
 *     its own row;
 *   - a Workspace page makes its group's row current, and that row names
 *     the page: "Build · Vaults".
 *
 * A Workspace row that is not current says what is inside it in whole
 * words ("Deployments, Evals +2"), never a word cut by an ellipsis.
 *
 * The lists size themselves from the window's HEIGHT only (`planLists`):
 * Recents keeps four rows before Frequent takes any and five before
 * Frequent grows past two agents, then takes what is left. A shorter
 * window takes Frequent's rows one at a time, never the section whole, and
 * the agents it has no row for are "2 more" in the section's label (a menu
 * beside the sidebar), so none is hidden without a word.
 * Both always end on a whole row. Recents scrolls inside its own rows and snaps to them, so it rests
 * on whole rows too; its edges soften only while it is moving.
 *
 *   1080 tall   4 agents, 10 sessions
 *    900        4 agents,  5 sessions
 *    860        3 agents,  5 sessions
 *    800        2 agents,  4 sessions
 *    768        1 agent,   4 sessions
 *    720        5 sessions (no room for an agent as well)
 *
 * WHEN A READ FAILS the frame keeps its shape. A list that could not be
 * loaded stays where it is and says so in one line with a Retry, and holds
 * no blank rows under it (the other list may use them). Frequent is a ranking of agents by their
 * sessions, so it needs both reads: with either missing it says "Could not
 * load" rather than list agents in an order that means nothing. It is not
 * drawn from half the data while the other half is still on its way,
 * either. A refresh that fails while a list is on screen changes nothing:
 * the list stays as it was last known.
 *
 * Collapsed (⌘B) the sidebar is a 52px rail of icons: the same
 * destinations and the same Workspace menus, without the two lists.
 *
 * Destinations come from components/navigation.tsx (single source of
 * truth, shared with the command palette).
 */

const ROW =
  "group/row relative flex h-8 w-full min-w-0 items-center gap-2.5 rounded-md px-2 text-small leading-none transition-quick select-none";
const ROW_IDLE = "text-fg-muted hover:bg-bg-hover hover:text-fg";
const ROW_ACTIVE = "bg-bg-surface font-medium text-fg shadow-[var(--shadow-xs)] dark:bg-bg-hover dark:shadow-none";

const RAIL = "relative flex size-9 shrink-0 items-center justify-center rounded-md transition-quick";
const RAIL_IDLE = "text-fg-subtle hover:bg-bg-hover hover:text-fg";
const RAIL_ACTIVE = "bg-bg-surface text-fg shadow-[var(--shadow-xs)] dark:bg-bg-hover dark:shadow-none";

/** A menu trigger keeps its hover fill while its menu is open. */
const MENU_OPEN = "data-[state=open]:bg-bg-hover data-[state=open]:text-fg";

const FREQUENT_MAX = 4;
/** Sessions kept in the list; the rows that do not fit are a scroll away. */
const RECENT_COUNT = 12;
/** Recents keeps this many rows before Frequent is given any, and one more before Frequent grows past two. */
const RECENTS_FLOOR = 4;

/** List geometry in px: a 32px row, 2px between rows, a 28px section label. */
const ROW_GAP = 2;
const ROW_PITCH = 32 + ROW_GAP;
const LABEL_H = 28;
/** Between Frequent and Recents. */
const SECTION_GAP = 12;
/** Kept clear above the Workspace hairline. */
const LISTS_FOOT = 8;

const sectionHeight = (rows: number) => LABEL_H + rows * ROW_PITCH - ROW_GAP;
const rowsThatFit = (px: number) => Math.max(0, Math.floor((px - LABEL_H + ROW_GAP) / ROW_PITCH));

/**
 * How many rows each list shows in `height` px. A function of the window
 * only (and of how many agents and sessions exist), never of the route.
 *
 * Recents comes first, because what you were just doing matters more than
 * a shortcut to an agent: Frequent gets its first row, then its second,
 * once Recents has four, and its third and fourth once Recents has five.
 * Recents then takes every whole row that is left. Read the other way, a
 * shrinking window gives up Frequent a row at a time (4, 3, 2, 1, none)
 * and never the section whole. The Recents label is not drawn over a
 * single row unless one session is all there is.
 */
function planLists(height: number, agents: number, sessions: number): { frequent: number; recents: number } {
  const room = height - LISTS_FOOT;
  /** Rows Frequent can have while Recents keeps `kept` rows. */
  const beside = (kept: number) => {
    const held = sessions > 0 ? sectionHeight(Math.min(kept, sessions)) + SECTION_GAP : 0;
    return rowsThatFit(room - held);
  };
  // What Frequent can have while Recents keeps five rows; when that is
  // under two, what it can have (two at most) while Recents keeps four.
  // So a shrinking window takes Frequent's rows one at a time: 4, 3, 2, 2,
  // 1, none. It is never dropped whole from two.
  let frequent = Math.min(agents, FREQUENT_MAX, beside(RECENTS_FLOOR + 1));
  if (frequent < 2) frequent = Math.min(agents, 2, beside(RECENTS_FLOOR));
  const taken = frequent > 0 ? sectionHeight(frequent) + SECTION_GAP : 0;
  let recents = Math.min(sessions, rowsThatFit(room - taken));
  if (recents < Math.min(2, sessions)) recents = 0;
  return { frequent, recents };
}

function SectionLabel({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex h-7 items-center justify-between pr-1 pl-2">
      <span className="text-xs font-medium text-fg-subtle">{children}</span>
      {action}
    </div>
  );
}

function NavRow({ item, badge }: { item: NavItem; badge?: ReactNode }) {
  const { pathname } = useLocation();
  const active = isNavItemActive(pathname, item);
  return (
    <NavLink
      to={item.to}
      end={item.end}
      aria-current={active ? "page" : undefined}
      className={cn(ROW, active ? ROW_ACTIVE : ROW_IDLE)}
    >
      <item.icon className={cn("size-4 shrink-0 stroke-[1.75]", active ? "text-fg" : "text-fg-subtle group-hover/row:text-fg")} />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {badge}
    </NavLink>
  );
}

/** The same destination on the rail: an icon, named by its tooltip. */
function RailLink({ item, tip, badge }: { item: NavItem; tip?: ReactNode; badge?: ReactNode }) {
  const { pathname } = useLocation();
  const active = isNavItemActive(pathname, item);
  return (
    <Tip label={tip ?? item.label} side="right">
      <NavLink
        to={item.to}
        end={item.end}
        aria-label={item.label}
        aria-current={active ? "page" : undefined}
        className={cn(RAIL, active ? RAIL_ACTIVE : RAIL_IDLE)}
      >
        <item.icon className="size-4 stroke-[1.75]" />
        {badge}
      </NavLink>
    </Tip>
  );
}

const previewText = (labels: string[], shown: number) =>
  labels.slice(0, shown).join(", ") + (shown < labels.length ? ` +${labels.length - shown}` : "");

/**
 * What a Workspace group holds, in whole words: as many names as fit the
 * row, then a count of the rest ("Deployments, Evals +2"). When not even
 * the first name fits, nothing is shown. Measured against the real text
 * (a hidden ruler in the same font), so it holds for plugin groups and
 * after the webfont swaps in.
 */
function GroupPreview({ labels }: { labels: string[] }) {
  const box = useRef<HTMLSpanElement>(null);
  const ruler = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(Math.min(2, labels.length));

  useLayoutEffect(() => {
    const el = box.current;
    const probe = ruler.current;
    if (!el || !probe) return;
    const fit = () => {
      const room = el.clientWidth;
      if (room === 0) return;
      let n = labels.length;
      for (; n > 0; n--) {
        probe.textContent = previewText(labels, n);
        if (probe.getBoundingClientRect().width <= room) break;
      }
      probe.textContent = "";
      setShown(n);
    };
    fit();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    observer?.observe(el);
    let live = true;
    void document.fonts?.ready.then(() => live && fit());
    return () => {
      live = false;
      observer?.disconnect();
    };
  }, [labels]);

  return (
    <span
      ref={box}
      aria-hidden="true"
      className="relative min-w-0 flex-1 overflow-hidden text-left text-xs font-normal whitespace-nowrap text-fg-subtle transition-quick group-hover/row:text-fg-muted"
    >
      {shown > 0 ? previewText(labels, shown) : ""}
      <span ref={ruler} className="invisible absolute top-0 left-0" />
    </span>
  );
}

/**
 * One Workspace group: a row (or a rail icon) that opens a menu of its
 * destinations beside it. The row never grows, so opening a group moves
 * nothing. Menu items are real links (⌘-click opens a tab) and print their
 * `g` chord, which is the fast way back next time.
 */
function WorkspaceGroup({ group, rail }: { group: NavGroup; rail?: boolean }) {
  const { pathname } = useLocation();
  // In a phone's sheet there is no room beside the row: the menu opens above it.
  const { isMobile } = useSidebar();
  const current = group.items.find((it) => isNavItemActive(pathname, it));
  const labels = useMemo(() => group.items.map((it) => it.label), [group.items]);

  const trigger = rail ? (
    <button
      type="button"
      aria-label={current ? `${group.label}: ${current.label}` : group.label}
      aria-current={current ? "true" : undefined}
      className={cn(RAIL, current ? RAIL_ACTIVE : [RAIL_IDLE, MENU_OPEN])}
    >
      <group.icon className="size-4 stroke-[1.75]" />
    </button>
  ) : (
    <button
      type="button"
      aria-label={current ? `${group.label}: ${current.label}` : group.label}
      aria-current={current ? "true" : undefined}
      className={cn(ROW, current ? ROW_ACTIVE : [ROW_IDLE, MENU_OPEN])}
    >
      <group.icon
        className={cn("size-4 shrink-0 stroke-[1.75]", current ? "text-fg" : "text-fg-subtle group-hover/row:text-fg")}
      />
      {current ? (
        // The group that holds this page is the current row, and names the page.
        <span className="min-w-0 flex-1 truncate text-left" title={`${group.label} · ${current.label}`}>
          <span className="font-normal text-fg-muted">{group.label}</span>
          <span className="mx-1.5 font-normal text-fg-faint" aria-hidden="true">
            ·
          </span>
          {current.label}
        </span>
      ) : (
        <>
          <span className="w-[3.25rem] shrink-0 text-left">{group.label}</span>
          <GroupPreview labels={labels} />
        </>
      )}
      <ChevronRightIcon className="-ml-1 size-3.5 shrink-0 text-fg-faint transition-quick group-hover/row:text-fg-subtle" />
    </button>
  );

  return (
    // Not modal: a click on another group's row closes this menu and opens
    // that one in the same gesture.
    <DropdownMenu modal={false}>
      {rail ? (
        <Tip label={current ? `${group.label} · ${current.label}` : group.label} side="right">
          <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
        </Tip>
      ) : (
        <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      )}
      <DropdownMenuContent
        side={isMobile ? "top" : "right"}
        align="start"
        alignOffset={isMobile ? 0 : -6}
        sideOffset={isMobile ? 6 : rail ? 10 : 16}
        collisionPadding={8}
        className="w-60"
      >
        <DropdownMenuLabel>{group.label}</DropdownMenuLabel>
        {group.items.map((it) => {
          const active = current?.to === it.to;
          const chord = ROUTE_CHORDS[it.to];
          return (
            <DropdownMenuItem key={it.to} asChild className={cn(active && "bg-bg-soft font-medium")}>
              <Link to={it.to} aria-current={active ? "page" : undefined}>
                <it.icon className={cn("size-4 stroke-[1.75]", active && "text-fg")} />
                <span className="min-w-0 flex-1 truncate">{it.label}</span>
                {chord && (
                  <DropdownMenuShortcut className="font-sans">
                    <Kbd keys={["G", chord.toUpperCase()]} then />
                  </DropdownMenuShortcut>
                )}
              </Link>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * A list that could not be loaded: one line and a Retry, in one row. The
 * list takes no more room than that (the plan gives it one row), so no
 * blank rows sit under it; a Retry holds the loading rows again.
 */
function ListProblem({ retry }: { retry: () => void }) {
  return (
    <div>
      <div {...READ_PROBLEM} role="status" className="flex h-8 items-center gap-2 pr-1 pl-2 text-small leading-none text-fg-subtle">
        <span className="min-w-0 flex-1 truncate">Could not load</span>
        <button
          type="button"
          onClick={retry}
          className="relative flex h-6 shrink-0 items-center rounded-full px-2 text-xs font-medium text-fg-muted transition-quick after:absolute after:-inset-1 hover:bg-bg-hover hover:text-fg"
        >
          Retry
        </button>
      </div>
    </div>
  );
}

/**
 * The Frequent agents a short window has no row for: "2 more" in the
 * section's label, beside New agent, the way Recents has "View all". It
 * opens the rest as a menu beside the sidebar, so Frequent never hides an
 * agent without saying so and costs no row to say it.
 */
function FrequentMore({ agents, running }: { agents: AgentRecord[]; running: (id: string) => boolean }) {
  const { pathname } = useLocation();
  const { isMobile } = useSidebar();
  const current = agents.some((a) => pathname === `/agents/${a.id}` || pathname.startsWith(`/agents/${a.id}/`));
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`${plural(agents.length, "more frequent agent")}`}
          className={cn(
            "relative flex h-6 items-center rounded-full px-2 text-xs transition-quick after:absolute after:-inset-1 hover:bg-bg-hover hover:text-fg",
            current ? "font-medium text-fg" : "text-fg-subtle",
            MENU_OPEN,
          )}
        >
          {agents.length} more
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side={isMobile ? "bottom" : "right"} align="start" sideOffset={isMobile ? 6 : 12} collisionPadding={8} className="w-64">
        <DropdownMenuLabel>More frequent agents</DropdownMenuLabel>
        {agents.map((agent) => {
          const active = pathname === `/agents/${agent.id}` || pathname.startsWith(`/agents/${agent.id}/`);
          return (
            <DropdownMenuItem key={agent.id} asChild className={cn(active && "bg-bg-soft font-medium")}>
              <Link to={`/agents/${agent.id}`} aria-current={active ? "page" : undefined}>
                <AgentAvatar name={agent.name} id={agent.id} size="xs" />
                <span className="min-w-0 flex-1 truncate">{agent.name}</span>
                {running(agent.id) && (
                  <>
                    <StatusDot status="running" />
                    <span className="sr-only">Running</span>
                  </>
                )}
              </Link>
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/agents">All agents</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const FADE = {
  "": "",
  top: "[mask-image:linear-gradient(to_bottom,transparent,black_12px)]",
  bottom: "[mask-image:linear-gradient(to_top,transparent,black_12px)]",
  both: "[mask-image:linear-gradient(to_bottom,transparent,black_12px,black_calc(100%_-_12px),transparent)]",
} as const;

/**
 * The Recents rows. Exactly `rows` are visible; the rest scroll, and the
 * scroll snaps to rows, so the list always rests on whole rows. An edge
 * with more beyond it softens while the list is moving and is clean again
 * when it stops: a fade never sits on a resting row.
 */
function RecentRows({ sessions, rows }: { sessions: SessionRecord[]; rows: number }) {
  const { pathname } = useLocation();
  // The one reading of a session (lib/session-state.ts), the same as Home,
  // Operations, the Sessions list and the session's own header: a session
  // waiting on an access or skill request has the amber dot like one
  // waiting on an approval, and one that claims to run but has been silent
  // for half an hour is Stalled, not Running.
  const { read } = useSessionReadings();
  const [fade, setFade] = useState<keyof typeof FADE>("");
  const settle = useRef<number | undefined>(undefined);

  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const above = el.scrollTop > 1;
    const below = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
    setFade(above && below ? "both" : above ? "top" : below ? "bottom" : "");
    window.clearTimeout(settle.current);
    settle.current = window.setTimeout(() => setFade(""), 180);
  };

  return (
    <div
      onScroll={onScroll}
      style={{ height: rows * ROW_PITCH - ROW_GAP }}
      className={cn("no-scrollbar snap-y snap-mandatory space-y-0.5 overflow-y-auto overscroll-contain", FADE[fade])}
    >
      {sessions.map((s) => {
        const active = pathname === `/sessions/${s.id}`;
        const reading = read(s);
        // A session whose state is not known is marked too (a grey dot): it may be waiting on you.
        const showDot = reading.tone !== "neutral" || reading.status === "unknown";
        const title = sessionTitle(s);
        const when = formatRelativeTime(s.updated_at || s.created_at);
        return (
          <Tip
            key={s.id}
            side="right"
            label={
              <span className="block max-w-72">
                <span className="block">{title}</span>
                <span className="block font-normal opacity-75">{[s.agent?.name, when].filter(Boolean).join(" · ")}</span>
                {showDot && <span className="block font-normal opacity-75">{reading.detail}</span>}
              </span>
            }
          >
            <Link
              to={`/sessions/${s.id}`}
              aria-current={active ? "page" : undefined}
              // The ring is drawn inside the row: the list clips at its own edge.
              className={cn(ROW, "snap-start focus-visible:-outline-offset-2", active ? ROW_ACTIVE : ROW_IDLE)}
            >
              <span className="min-w-0 flex-1 truncate">{title}</span>
              {showDot && (
                <>
                  <SessionStatusDot reading={reading} />
                  <span className="sr-only">{reading.label}</span>
                </>
              )}
            </Link>
          </Tip>
        );
      })}
    </div>
  );
}

export function AppSidebar() {
  const { pathname } = useLocation();
  const { state, isMobile, setOpenMobile } = useSidebar();
  const rail = state === "collapsed" && !isMobile;
  // On a phone the sidebar is a sheet over the page: going somewhere puts it away.
  useEffect(() => {
    setOpenMobile(false);
  }, [pathname, setOpenMobile]);

  const agentsQuery = useAgents();
  const sessionsQuery = useRecentSessions();
  const { agents } = agentsQuery;
  const { sessions } = sessionsQuery;
  const { byAgent } = useAgentActivityNow();
  // The Operations count is the one Home's Needs attention shows: approvals,
  // open access and skill requests, and failed work. It waits for the open
  // requests the way Home does (the same patience), so it is drawn once and
  // does not go from 3 to 4 when a request is found a moment later.
  const readings = useSessionReadings();
  const counts = readings.counts;
  const waitForRequests = usePatienceForRequests(readings.requestsLoading);
  const countPending = readings.ops.isLoading || waitForRequests;

  // A read is "missing" until it has answered once. While it is on its way
  // (the first load, or a Retry) the list holds its rows as skeletons; when
  // it gave up, the list says so. A failed refresh of a list that is
  // already on screen is neither: the last known rows stay.
  const agentsMissing = agentsQuery.data === undefined;
  const sessionsMissing = sessionsQuery.data === undefined;
  const agentsFailed = agentsMissing && agentsQuery.isError && !agentsQuery.isFetching;
  const sessionsFailed = sessionsMissing && sessionsQuery.isError && !sessionsQuery.isFetching;
  // Frequent ranks agents by their sessions, so it needs both.
  const frequentFailed = agentsFailed || sessionsFailed;
  const frequentLoading = !frequentFailed && (agentsMissing || sessionsMissing);
  const sessionsLoading = sessionsMissing && !sessionsFailed;
  const retryFrequent = () => {
    if (agentsMissing) void agentsQuery.refetch();
    if (sessionsMissing) void sessionsQuery.refetch();
  };

  // Frequent agents: most sessions in the recent window first; padded with
  // the newest active agents so a fresh workspace still shows its agents.
  const frequent = useMemo(() => {
    const active = agents.filter((a) => !a.archived_at);
    return [...active]
      .sort((a, b) => {
        const d = (byAgent.get(b.id)?.sessions ?? 0) - (byAgent.get(a.id)?.sessions ?? 0);
        return d !== 0 ? d : b.created_at.localeCompare(a.created_at);
      })
      .slice(0, FREQUENT_MAX);
  }, [agents, byAgent]);
  const recents = useMemo(() => sessions.slice(0, RECENT_COUNT), [sessions]);

  // Destinations this server has (a page whose endpoints it lacks is left out).
  const { primary, groups } = useNavigation();

  // The lists are sized from the room between the primary nav and the
  // Workspace block. That room depends on the window's height and on
  // nothing else, so the plan is the same on every route.
  const [listsHeight, setListsHeight] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  const listsRef = useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    const measure = () => setListsHeight(el.clientHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    observer.current = new ResizeObserver(measure);
    observer.current.observe(el);
  }, []);
  // A list that is loading holds the rows it would fill: the other list
  // never grows into a place that is only briefly empty. A list that could
  // not be loaded is one line and a Retry, and holds nothing more: blank
  // rows under "Could not load" say nothing.
  const plan = planLists(
    listsHeight,
    frequentFailed ? 1 : agentsMissing ? FREQUENT_MAX : frequent.length,
    sessionsFailed ? 1 : sessionsMissing ? RECENT_COUNT : recents.length,
  );

  // The starter opens over the page (or takes focus on Home); on a phone the
  // sidebar is a sheet in front of it, so it steps away first.
  const newSession = (agentId?: string) => {
    setOpenMobile(false);
    startSession({ agentId });
  };

  const attention = countPending ? 0 : counts.attention;
  // Sessions whose requests could not be read are not in the number, and
  // the badge says so: with nothing else counted it shows "?", never nothing.
  const unknown = countPending ? 0 : counts.unknown;
  const opsTip =
    attention > 0 || unknown > 0
      ? [
          counts.approvals ? `${counts.approvals} waiting for approval` : null,
          counts.requests ? `${plural(counts.requests, "request")} for access or a skill` : null,
          counts.failed ? `${counts.failed} failed` : null,
          unknown ? `${plural(unknown, "session")} could not be checked` : null,
        ]
          .filter(Boolean)
          .join(" · ")
      : "";
  const waitingOnYou = counts.waiting > 0;
  const opsBadge =
    attention > 0 || unknown > 0 ? (
      <Tip label={opsTip} side="right">
        <span
          className={cn(
            "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 text-micro-size font-semibold",
            attention === 0 ? "bg-bg-soft text-fg-muted" : waitingOnYou ? "bg-warning-subtle text-warning" : "bg-danger-subtle text-danger",
          )}
        >
          {attention > 0 ? attention : <span aria-label={opsTip}>?</span>}
        </span>
      </Tip>
    ) : undefined;

  if (rail) {
    return (
      <Sidebar collapsible="icon" className="overflow-hidden border-0 group-data-[side=left]:border-r-0">
        <div className="no-scrollbar flex h-full min-h-0 w-(--sidebar-width-icon) flex-col items-center overflow-y-auto">
          <div className="flex h-13 shrink-0 items-center">
            <Tip label={`${BRAND_NAME} home`} side="right">
              <Link to="/" className="rounded-md p-1" aria-label={`${BRAND_NAME} home`}>
                <Logo size="md" />
              </Link>
            </Tip>
          </div>

          <div className="flex shrink-0 flex-col items-center gap-1 pb-3">
            <Tip
              label={
                <>
                  Show sidebar <Kbd tone="onInk" keys={[MOD_KEY, "B"]} />
                </>
              }
              side="right"
            >
              <SidebarTrigger className="size-9 text-fg-subtle" />
            </Tip>
            <Tip label="New session" side="right">
              <button type="button" aria-label="New session" onClick={() => newSession()} className={cn(RAIL, "group/new")}>
                <span className="flex size-7 items-center justify-center rounded-full bg-ink text-on-ink shadow-[var(--shadow-sm)] transition-base group-hover/new:bg-ink-hover group-active/new:scale-95">
                  <PlusIcon className="size-4 stroke-[2.25]" />
                </span>
              </button>
            </Tip>
            <Tip
              label={
                <>
                  Search <Kbd tone="onInk" keys={[MOD_KEY, "K"]} />
                </>
              }
              side="right"
            >
              <button type="button" aria-label="Search" onClick={() => openCommandPalette()} className={cn(RAIL, RAIL_IDLE)}>
                <SearchIcon className="size-4 stroke-[1.75]" />
              </button>
            </Tip>
          </div>

          <nav aria-label="Main" className="flex shrink-0 flex-col items-center gap-0.5">
            {primary.map((item) => {
              const flagged = item.to === "/operations" && (attention > 0 || unknown > 0);
              return (
                <RailLink
                  key={item.to}
                  item={item}
                  tip={flagged ? `${item.label} · ${opsTip}` : undefined}
                  badge={
                    flagged ? (
                      <span
                        aria-hidden="true"
                        className={cn(
                          "absolute top-1.5 right-1.5 size-2 rounded-full ring-2 ring-bg-sidebar",
                          attention === 0 ? "bg-fg-faint" : waitingOnYou ? "bg-warning-solid" : "bg-danger-solid",
                        )}
                      />
                    ) : undefined
                  }
                />
              );
            })}
          </nav>

          <div className="min-h-3 flex-1" />

          <nav aria-label="Workspace" className="flex shrink-0 flex-col items-center gap-0.5 border-t border-border px-2 pt-2 pb-1">
            {groups.map((g) => (
              <WorkspaceGroup key={g.id} group={g} rail />
            ))}
          </nav>

          <div className="flex shrink-0 flex-col items-center gap-1 pt-1 pb-2.5">
            <TenantSwitcher compact />
            <UserProfile side="right" />
          </div>
        </div>
      </Sidebar>
    );
  }

  return (
    <Sidebar collapsible="icon" className="overflow-hidden border-0 group-data-[side=left]:border-r-0">
      {/* A fixed width, so the content is revealed rather than reflowed while
          the sidebar slides open. A window too short for the fixed parts
          scrolls the whole column instead of losing the account menu. */}
      <div className={cn("no-scrollbar flex h-full min-h-0 flex-col overflow-y-auto", isMobile ? "w-full" : "w-(--sidebar-width)")}>
        {/* Brand */}
        <div className="flex h-13 shrink-0 items-center gap-2.5 pr-2.5 pl-4">
          <Link to="/" className="-ml-1 flex items-center gap-2.5 rounded-md py-1 pr-2 pl-1" aria-label={`${BRAND_NAME} home`}>
            <Logo size="md" />
            <span className="text-[0.9375rem] font-semibold tracking-[-0.01em] text-fg">{BRAND_NAME}</span>
          </Link>
          <div className="flex-1" />
          {/* On a phone the sidebar is a sheet, and this closes it. No tooltip
              there: the sheet focuses this button as it opens. */}
          <Tip
            label={
              isMobile ? null : (
                <>
                  Collapse sidebar <Kbd tone="onInk" keys={[MOD_KEY, "B"]} />
                </>
              )
            }
            side="bottom"
          >
            <SidebarTrigger className="text-fg-subtle" />
          </Tip>
        </div>

        {/* Start + search */}
        <div className="shrink-0 space-y-1 px-3 pt-0.5 pb-2">
          <button
            type="button"
            onClick={() => newSession()}
            className="group/new flex h-10 w-full items-center gap-2.5 rounded-full border border-border bg-bg-surface pr-3 pl-2 text-left text-small-size font-medium text-fg shadow-[var(--shadow-sm)] transition-base hover:border-border-strong hover:shadow-[var(--shadow-md)] active:scale-[0.985] dark:bg-bg-soft"
          >
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-ink text-on-ink transition-transform duration-[var(--dur-base)] ease-[var(--ease-rise)] group-hover/new:rotate-90">
              <PlusIcon className="size-3.5 stroke-[2.5]" />
            </span>
            <span className="flex-1">New session</span>
          </button>
          <button type="button" onClick={() => openCommandPalette()} className={cn(ROW, ROW_IDLE, "h-9 rounded-full px-3")}>
            <SearchIcon className="size-4 shrink-0 stroke-[1.75] text-fg-subtle" />
            <span className="flex-1 text-left">Search</span>
            <Kbd keys={[MOD_KEY, "K"]} />
          </button>
        </div>

        {/* Primary destinations */}
        <nav aria-label="Main" className="shrink-0 space-y-0.5 px-3 pb-2">
          {primary.map((item) => (
            <NavRow key={item.to} item={item} badge={item.to === "/operations" ? opsBadge : undefined} />
          ))}
        </nav>

        {/* Frequent and Recents: whole rows only, as many as the height holds. */}
        <div ref={listsRef} className="min-h-0 flex-1 overflow-hidden px-3">
          {plan.frequent > 0 && (
            <div>
              <SectionLabel
                action={
                  <span className="flex items-center gap-1">
                    {!frequentFailed && !frequentLoading && frequent.length > plan.frequent && (
                      <FrequentMore agents={frequent.slice(plan.frequent)} running={(id) => (byAgent.get(id)?.running ?? 0) > 0} />
                    )}
                    <Tip label="New agent" side="right">
                      <Link
                        to="/agents?create=1"
                        aria-label="New agent"
                        className="relative flex size-6 items-center justify-center rounded-full text-fg-subtle transition-quick after:absolute after:-inset-1 hover:bg-bg-hover hover:text-fg"
                      >
                        <PlusIcon className="size-3.5" />
                      </Link>
                    </Tip>
                  </span>
                }
              >
                Frequent
              </SectionLabel>
              {frequentFailed ? (
                <ListProblem retry={retryFrequent} />
              ) : (
                <div className="space-y-0.5">
                  {frequentLoading
                    ? Array.from({ length: plan.frequent }).map((_, i) => (
                        <div key={i} className="flex h-8 items-center gap-2.5 px-2">
                          <Skeleton className="size-5" rounded="sm" />
                          <Skeleton className="h-3" rounded="sm" style={{ width: `${52 + ((i * 17) % 30)}%` }} />
                        </div>
                      ))
                    : frequent.slice(0, plan.frequent).map((agent) => {
                        const active = pathname === `/agents/${agent.id}` || pathname.startsWith(`/agents/${agent.id}/`);
                        const running = (byAgent.get(agent.id)?.running ?? 0) > 0;
                        return (
                          <div key={agent.id} className="group/agent relative">
                            <Link
                              to={`/agents/${agent.id}`}
                              aria-current={active ? "page" : undefined}
                              title={agent.name}
                              className={cn(ROW, "pr-8", active ? ROW_ACTIVE : ROW_IDLE)}
                            >
                              <AgentAvatar name={agent.name} id={agent.id} size="xs" />
                              <span className="min-w-0 flex-1 truncate">{agent.name}</span>
                            </Link>
                            {running && (
                              <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 group-focus-within/agent:hidden group-hover/agent:hidden">
                                <StatusDot status="running" />
                                <span className="sr-only">Running</span>
                              </span>
                            )}
                            <Tip label={`New session with ${agent.name}`} side="right">
                              <button
                                type="button"
                                aria-label={`New session with ${agent.name}`}
                                onClick={() => newSession(agent.id)}
                                className="absolute top-1/2 right-1 flex size-6 -translate-y-1/2 items-center justify-center rounded-full text-fg-subtle opacity-0 transition-quick group-hover/agent:opacity-100 hover:bg-bg-pressed hover:text-fg focus-visible:opacity-100"
                              >
                                <PlusIcon className="size-3.5" />
                              </button>
                            </Tip>
                          </div>
                        );
                      })}
                </div>
              )}
            </div>
          )}

          {plan.recents > 0 && (
            <div style={{ marginTop: plan.frequent > 0 ? SECTION_GAP : 0 }}>
              <SectionLabel
                action={
                  <Link
                    to="/sessions"
                    className="relative flex h-6 items-center rounded-full px-2 text-xs text-fg-subtle transition-quick after:absolute after:-inset-1 hover:bg-bg-hover hover:text-fg"
                  >
                    View all
                  </Link>
                }
              >
                Recents
              </SectionLabel>
              {sessionsFailed ? (
                <ListProblem retry={() => void sessionsQuery.refetch()} />
              ) : sessionsLoading ? (
                <div className="space-y-0.5">
                  {Array.from({ length: plan.recents }).map((_, i) => (
                    <div key={i} className="flex h-8 items-center px-2">
                      <Skeleton className="h-3" rounded="sm" style={{ width: `${60 + ((i * 23) % 35)}%` }} />
                    </div>
                  ))}
                </div>
              ) : (
                <RecentRows sessions={recents} rows={plan.recents} />
              )}
            </div>
          )}
        </div>

        {/* Workspace: four rows, always. A row opens a menu beside it. */}
        <nav aria-label="Workspace" className="shrink-0 border-t border-border px-3 pt-1.5 pb-1">
          <SectionLabel>Workspace</SectionLabel>
          <div className="space-y-0.5">
            {groups.map((g) => (
              <WorkspaceGroup key={g.id} group={g} />
            ))}
          </div>
        </nav>

        {/* Foot: workspace + account */}
        <div className="flex shrink-0 items-center gap-1 px-3 pt-1 pb-2">
          <TenantSwitcher />
          <UserProfile />
        </div>
      </div>
    </Sidebar>
  );
}
