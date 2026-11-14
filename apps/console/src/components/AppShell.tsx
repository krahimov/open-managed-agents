import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Outlet, Navigate, useLocation, useNavigate } from "react-router";
import { PlusIcon, SearchIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SidebarProvider, SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { useAuth } from "../lib/auth";
import { useChordKeybinding, type ChordBinding } from "../lib/useChordKeybinding";
import { ROUTE_CHORD_ALIASES, ROUTE_CHORDS } from "../lib/route-chords";
import { MOD_KEY, openCommandPalette, startSession } from "../lib/shell-events";

import { AppSidebar } from "./AppSidebar";
import { AppBreadcrumb, useCrumbs, useRouteTitle } from "./AppBreadcrumb";
import { BrandLoader } from "./BrandLoader";
import { CommandPalette } from "./CommandPalette";
import { Kbd } from "./Kbd";
import { NavigationProgress } from "./NavigationProgress";
import { pageColumn, type PageWidth } from "./Page";
import { NewSessionHost } from "./sessions/NewSessionDialog";
import { Tip } from "./Tip";

/**
 * AppShell — the Muse frame.
 *
 *   ┌ stage (warm tint) ──────────────────────────────────────────┐
 *   │ sidebar │ ╭ panel (page canvas, rounded, 8px inset) ──────╮ │
 *   │         │ │ top bar      only on nested pages (breadcrumb) │ │
 *   │         │ │              or while the sidebar is hidden    │ │
 *   │         │ │ header slot  <PageHeader> portals here; fixed  │ │
 *   │         │ │ <main>       the only scroll container         │ │
 *   │         │ ╰────────────────────────────────────────────────╯ │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * - Top-level pages have no top bar: the page title is the first thing in
 *   the panel. A breadcrumb bar appears only when there is a trail to show.
 * - `backdropSlot` sits behind everything in the panel. <Wash> portals the
 *   signature gradient into it so it runs to the panel's top edge. The
 *   panel publishes `--scroll-y`; the wash uses it to fade and drift away
 *   as the page scrolls, leaving a quiet canvas for reading.
 * - The header slot is transparent at rest and turns into a blurred bar
 *   with a hairline once content scrolls under it.
 */
export interface AppOutletContext {
  pageHeaderSlot: HTMLDivElement | null;
  backdropSlot: HTMLDivElement | null;
  /** `<Page>` and `<PageHeader>` report their width so the breadcrumb can share the page's left edge. */
  registerPageWidth: (width: PageWidth) => void;
  /** No breadcrumb above the page: it starts on the shared left edge (see Page.tsx). */
  topLevel: boolean;
}

/** Where "Skip to content" lands: the panel, so the page's own header is not skipped too. */
const CONTENT_ID = "content";

/** The sidebar remembers whether it was collapsed (the primitive writes this cookie). */
function sidebarStartsOpen(): boolean {
  try {
    return !/(?:^|;\s*)sidebar_state=false(?:;|$)/.test(document.cookie);
  } catch {
    return true;
  }
}

export function AppShell() {
  const { isAuthenticated, isLoading } = useAuth();
  const navigate = useNavigate();

  // `g` chords: g h → Home, g a → Agents, g s → Sessions, … plus the older
  // aliases that still work (lib/route-chords.ts).
  const chordBindings = useMemo<ChordBinding[]>(
    () =>
      [...Object.entries(ROUTE_CHORDS), ...Object.entries(ROUTE_CHORD_ALIASES)].map(([path, key]) => ({
        prefix: "g",
        key,
        handler: () => navigate(path),
        label: path,
      })),
    [navigate],
  );
  useChordKeybinding(chordBindings);

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-bg-sidebar">
        <BrandLoader size="lg" label="Loading session" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return (
    <TooltipProvider delayDuration={350} skipDelayDuration={200}>
      <SidebarProvider
        defaultOpen={sidebarStartsOpen()}
        className="h-svh overflow-hidden"
        style={
          {
            "--sidebar-width": "17rem",
            "--sidebar-width-icon": "3.25rem",
          } as React.CSSProperties
        }
      >
        {/* First tab stop on every page: past the sidebar, to the page. */}
        <a
          href={`#${CONTENT_ID}`}
          onClick={(e) => {
            e.preventDefault();
            document.getElementById(CONTENT_ID)?.focus();
          }}
          className="fixed top-3 left-3 z-50 flex h-9 -translate-y-[200%] items-center rounded-full bg-ink px-4 text-small-size font-medium text-on-ink shadow-[var(--shadow-md)] transition-transform duration-[var(--dur-quick)] ease-[var(--ease-rise)] focus-visible:translate-y-0"
        >
          Skip to content
        </a>
        <NavigationProgress />
        <CommandPalette />
        {/* The one place a session starts from; see lib/shell-events startSession(). */}
        <NewSessionHost />

        {/* Autofill honeypot — Chrome/Safari ignore autoComplete="off" and
            fill the first plausible input. A hidden username/password pair
            at the top of the authenticated DOM absorbs it. */}
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            left: "-9999px",
            top: "-9999px",
            height: 0,
            width: 0,
            overflow: "hidden",
            pointerEvents: "none",
          }}
        >
          <input type="text" tabIndex={-1} autoComplete="username" name="username" />
          <input type="password" tabIndex={-1} autoComplete="current-password" name="password" />
        </div>

        <div className="flex h-full w-full overflow-hidden bg-bg-sidebar">
          <AppSidebar />
          <ShellPanel />
        </div>
      </SidebarProvider>
    </TooltipProvider>
  );
}

function ShellPanel() {
  const { pathname } = useLocation();
  const { isMobile } = useSidebar();
  const crumbs = useCrumbs();

  const [pageHeaderSlot, setPageHeaderSlot] = useState<HTMLDivElement | null>(null);
  const [backdropSlot, setBackdropSlot] = useState<HTMLDivElement | null>(null);
  // The width the current route's page reported. Keyed by path so a stale
  // value from the previous route never positions the next one's breadcrumb.
  const [pageWidth, setPageWidth] = useState<{ path: string; width: PageWidth } | null>(null);
  const registerPageWidth = useCallback(
    (width: PageWidth) =>
      setPageWidth((cur) => (cur?.path === pathname && cur.width === width ? cur : { path: pathname, width })),
    [pathname],
  );
  const crumbWidth = pageWidth?.path === pathname ? pageWidth.width : null;
  const topLevel = crumbs.length <= 1;
  const outletContext: AppOutletContext = useMemo(
    () => ({ pageHeaderSlot, backdropSlot, registerPageWidth, topLevel }),
    [pageHeaderSlot, backdropSlot, registerPageWidth, topLevel],
  );

  // The tab says where you are: "<page or record> · Orrery".
  const title = useRouteTitle();
  useEffect(() => {
    document.title = title;
  }, [title]);

  // Scroll state drives the header's blurred background + hairline.
  // `<main>` remounts on route change (key), which rebinds the listener.
  const mainRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [scrolled, setScrolled] = useState(false);

  // Collapsed, the sidebar is still there as a rail of icons. Only a phone
  // hides it (it becomes a sheet), and then the top bar carries its controls.
  const sidebarHidden = isMobile;
  const showTopbar = sidebarHidden || crumbs.length > 1;

  return (
    <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col py-2 pr-2", sidebarHidden ? "pl-2" : "pl-0")}>
      <div
        ref={panelRef}
        id={CONTENT_ID}
        tabIndex={-1}
        data-topbar={showTopbar}
        className="group/panel relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border bg-bg shadow-[var(--shadow-sm)] outline-none"
      >
        {/* Backdrop: behind header + content. Empty unless a page mounts <Wash>.
            It is first in DOM order and nothing here sets a z-index, on
            purpose: a z-index on the panel, the header or <main> would
            create a stacking context and trap page-level `fixed` overlays
            underneath the sidebar. */}
        <div
          ref={setBackdropSlot}
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]"
        />

        <div
          className={cn(
            "relative shrink-0 border-b transition-[background-color,border-color,backdrop-filter] duration-[var(--dur-base)]",
            scrolled
              ? "border-border bg-bg/80 backdrop-blur-xl backdrop-saturate-150"
              : "border-transparent bg-transparent",
            // A pinned table header draws its own bottom edge.
            "has-[[data-slot=table-header]]:border-transparent",
          )}
        >
          {showTopbar && (
            <header
              data-slot="topbar"
              className={cn("flex h-12 items-center gap-1", (sidebarHidden || !crumbWidth) && "pr-4 pl-3")}
            >
              {sidebarHidden && (
                <>
                  <Tip
                    label={
                      <>
                        Show sidebar <Kbd tone="onInk" keys={[MOD_KEY, "B"]} />
                      </>
                    }
                    side="bottom"
                  >
                    <SidebarTrigger className="text-fg-subtle" />
                  </Tip>
                  <Tip label="New session" side="bottom">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="New session"
                      className="text-fg-subtle"
                      onClick={() => startSession()}
                    >
                      <PlusIcon />
                    </Button>
                  </Tip>
                  <Tip
                    label={
                      <>
                        Search <Kbd tone="onInk" keys={[MOD_KEY, "K"]} />
                      </>
                    }
                    side="bottom"
                  >
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Open command palette"
                      className="text-fg-subtle"
                      onClick={() => openCommandPalette()}
                    >
                      <SearchIcon />
                    </Button>
                  </Tip>
                  {crumbs.length > 0 && <span className="mx-1.5 h-4 w-px bg-border-strong" aria-hidden="true" />}
                </>
              )}
              <div
                className={
                  // The breadcrumb sits in the page's own column, so it shares
                  // a left edge with the title below it.
                  !sidebarHidden && crumbWidth
                    ? cn("min-w-0", pageColumn(crumbWidth, false).outer)
                    : cn("min-w-0 flex-1", !sidebarHidden && "pl-2 lg:pl-5")
                }
              >
                {(sidebarHidden || crumbs.length > 1) && <AppBreadcrumb />}
              </div>
            </header>
          )}
          <div ref={setPageHeaderSlot} className="empty:hidden" />
        </div>

        <main
          ref={(el) => {
            mainRef.current = el;
            if (!el) {
              setScrolled(false);
              panelRef.current?.style.setProperty("--scroll-y", "0");
              return;
            }
            const onScroll = () => {
              setScrolled(el.scrollTop > 4);
              // <Wash> reads this to recede as content scrolls over it.
              panelRef.current?.style.setProperty("--scroll-y", String(Math.round(el.scrollTop)));
            };
            onScroll();
            el.addEventListener("scroll", onScroll, { passive: true });
          }}
          key={pathname}
          className="no-scrollbar relative min-h-0 flex-1 overflow-y-auto"
        >
          <Outlet context={outletContext} />
        </main>
      </div>
    </div>
  );
}
