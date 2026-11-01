import { useMemo, useRef, useState } from "react";
import { Outlet, Navigate, useLocation, useNavigate } from "react-router";
import { SearchIcon } from "lucide-react";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";

import { useAuth } from "../lib/auth";
import { useChordKeybinding, type ChordBinding } from "../lib/useChordKeybinding";
import { ROUTE_CHORDS } from "../lib/route-chords";

void SidebarContent;
void SidebarFooter;
void SidebarGroup;
void SidebarGroupContent;
void SidebarGroupLabel;
void SidebarHeader;
void SidebarMenu;
void SidebarMenuButton;
void SidebarMenuItem;

import { AppSidebar } from "./AppSidebar";
import { AppBreadcrumb } from "./AppBreadcrumb";
import { BrandLoader } from "./BrandLoader";
import { CommandPalette } from "./CommandPalette";
import { TelegramOnboarding } from "./TelegramOnboarding";
import { NavigationProgress } from "./NavigationProgress";

/**
 * AppShell — sidebar + main outlet.
 *
 *   ┌─sidebar──┬───────────────────────────┐
 *   │ brand    │ trigger + breadcrumb      │
 *   │ nav      ├───────────────────────────┤
 *   │ ...      │ rounded-tl panel          │
 *   │ user     │  pageHeaderSlot           │
 *   │          │  <Outlet> (scrolls)       │
 *   └──────────┴───────────────────────────┘
 *
 * Structurally cloned from minimaxhub_benchmark/AppShell so the
 * sidebar/stage seam, sticky behavior, and dimensions match a known-
 * good layout instead of repeatedly inventing variants:
 *   - Outer flex container is `bg-sidebar h-full overflow-hidden` —
 *     the "stage" tint runs continuously behind sidebar + main header,
 *     so the rounded white panel reads as a card floating on it.
 *   - `<Sidebar className="bg-sidebar border-0 group-data-[side=left]:
 *     border-r-0">` — explicit border kill, otherwise shadcn's default
 *     `group-data-[side=left]:border-r` leaves a hairline at the seam
 *     that anti-aliases into a visible dark line against the rounded
 *     corner next door.
 *   - Top header is `h-12 bg-sidebar shrink-0` — same baseline as the
 *     sidebar brand row so brand + trigger / crumb align
 *     align horizontally on one shared 44-px band.
 *   - PageHeader is portaled into a `shrink-0` slot that sits ABOVE
 *     `<main>` (the scroll context) — slot literally cannot scroll,
 *     so the per-page header is "sticky" by construction, no CSS
 *     positioning involved.
 */
export interface AppOutletContext {
  pageHeaderSlot: HTMLDivElement | null;
}

/**
 * Toolbar search field — a quiet macOS-style capsule that opens the
 * existing ⌘K command palette (CommandPalette listens on window). It's a
 * discoverable affordance only; the palette owns all behaviour.
 */
function ToolbarSearch() {
  const isMac =
    typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  return (
    <button
      type="button"
      onClick={() =>
        window.dispatchEvent(
          new KeyboardEvent("keydown", { key: "k", metaKey: isMac, ctrlKey: !isMac, bubbles: true }),
        )
      }
      className="sq-press hidden md:inline-flex h-7 w-56 items-center gap-2 rounded-[7px] bg-bg-inset pl-2 pr-1.5 text-[13px] text-fg-subtle shadow-[inset_0_0_0_0.5px_var(--border)] hover:text-fg-muted outline-none"
      aria-label="Search and jump to a page"
    >
      <SearchIcon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="flex-1 text-left">Search</span>
      <kbd className="font-sans text-[11px] text-fg-subtle rounded-[4px] px-1 py-px shadow-[inset_0_0_0_0.5px_var(--border-strong)]">
        {isMac ? "⌘K" : "Ctrl K"}
      </kbd>
    </button>
  );
}

export function AppShell() {
  const { isAuthenticated, isLoading } = useAuth();
  const { pathname, search, hash } = useLocation();
  const navigate = useNavigate();
  const [pageHeaderSlot, setPageHeaderSlot] = useState<HTMLDivElement | null>(null);

  // Linear-style chord bindings.
  const chordBindings = useMemo<ChordBinding[]>(
    () =>
      Object.entries(ROUTE_CHORDS).map(([path, key]) => ({
        prefix: "g",
        key,
        handler: () => navigate(path),
        label: path,
      })),
    [navigate],
  );
  useChordKeybinding(chordBindings);

  const outletContext: AppOutletContext = useMemo(
    () => ({ pageHeaderSlot }),
    [pageHeaderSlot],
  );

  // Scroll-shadow: hide the divider under PageHeader when at top,
  // show it once user has scrolled the panel content. `<main>`
  // remounts on route change so the listener gets re-bound there.
  const mainRef = useRef<HTMLElement | null>(null);
  const [scrolled, setScrolled] = useState(false);
  // Large-title fold: only once the user has actually scrolled AND the
  // page has enough slack that folding the title can't bounce the
  // scroll position back to 0 (which would unfold it again).
  const [collapsed, setCollapsed] = useState(false);
  useMemo(() => {
    // re-binding handled by `key={pathname}` on <main> + a ref callback.
    void pathname;
  }, [pathname]);

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-bg">
        <BrandLoader size="lg" label="Loading session" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to={`/login?next=${encodeURIComponent(pathname + search + hash)}`} replace />;
  }

  return (
    <TooltipProvider delayDuration={250}>
      <SidebarProvider
        className="h-svh overflow-hidden"
        style={{
          // 240px source list, 52px collapsed-icon.
          "--sidebar-width": "15rem",
          "--sidebar-width-icon": "3.25rem",
        } as React.CSSProperties}
      >
        <NavigationProgress />
        <CommandPalette />

        {/* Autofill honeypot — Chrome/Safari ignore autoComplete="off"
            and fill the first plausible input. Sit a hidden username/
            password pair at the top of the authenticated DOM so the
            browser fills it instead of any real input below. */}
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
          <input
            type="password"
            tabIndex={-1}
            autoComplete="current-password"
            name="password"
          />
        </div>

        {/* Window: a softly tinted "desktop" canvas sits behind the
            translucent source list; the content pane is an opaque
            window surface to its right. */}
        <div
          data-scrolled={scrolled ? "true" : "false"}
          data-collapsed={collapsed ? "true" : "false"}
          className="group/shell sq-shell sq-canvas flex w-full h-full overflow-hidden"
        >
          <AppSidebar />

          <div className="relative flex-1 min-w-0 flex flex-col min-h-0 bg-bg shadow-[-0.5px_0_0_var(--hairline)]">
            {/* Unified toolbar. Hairline fades in once the content below
                has scrolled, exactly like a macOS window toolbar. */}
            <header
              className={[
                "h-[52px] shrink-0 flex items-center gap-2 pl-3 pr-4 bg-bg transition-[box-shadow] duration-[var(--dur-base)]",
                scrolled ? "shadow-[0_0.5px_0_var(--hairline)]" : "",
              ].join(" ")}
            >
              <SidebarTrigger className="size-7 rounded-md text-fg-muted hover:text-fg hover:bg-bg-hover" />
              <div aria-hidden="true" className="h-4 w-px bg-hairline mx-1" />
              <AppBreadcrumb />
              <div className="flex-1" />
              <ToolbarSearch />
            </header>

            <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
              <div
                ref={setPageHeaderSlot}
                className={[
                  "empty:hidden shrink-0 relative z-10 transition-[box-shadow] duration-[var(--dur-base)]",
                  scrolled ? "shadow-[0_0.5px_0_var(--hairline)]" : "",
                ].join(" ")}
              />
              <TelegramOnboarding />
              <main
                ref={(el) => {
                  mainRef.current = el;
                  if (!el) {
                    setScrolled(false);
                    setCollapsed(false);
                    return;
                  }
                  const onScroll = () => {
                    setScrolled(el.scrollTop > 0);
                    if (el.scrollTop <= 0) setCollapsed(false);
                    else if (el.scrollTop > 8 && el.scrollHeight - el.clientHeight > 120)
                      setCollapsed(true);
                  };
                  onScroll();
                  el.addEventListener("scroll", onScroll, { passive: true });
                  // Cleanup handled when ref unmounts (el = null branch above).
                }}
                key={pathname}
                className="flex-1 min-h-0 overflow-y-auto bg-bg [scrollbar-gutter:stable] [&::-webkit-scrollbar]:hidden [scrollbar-width:none]"
              >
                <Outlet context={outletContext} />
              </main>
            </div>
          </div>
        </div>
      </SidebarProvider>
    </TooltipProvider>
  );
}
