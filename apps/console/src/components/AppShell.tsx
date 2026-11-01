import { useMemo, useRef, useState } from "react";
import { Outlet, Navigate, useLocation, useNavigate } from "react-router";

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
  useMemo(() => {
    // re-binding handled by `key={pathname}` on <main> + a ref callback.
    void pathname;
  }, [pathname]);

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
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
          // 224px expanded, 52px collapsed-icon — matches benchmark.
          "--sidebar-width": "16.25rem",
          "--sidebar-width-icon": "3.5rem",
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

        {/* Liquid Glass frame: the static colour mesh (painted on
            <body>) runs edge to edge; the sidebar floats over it as a
            detached glass panel and the toolbar is a glass capsule. The
            content canvas is transparent so cards sit directly on the
            mesh. */}
        <div className="flex w-full h-full overflow-hidden">
          <AppSidebar />

          <div className="flex-1 min-w-0 flex flex-col min-h-0">
            <header className="h-[60px] flex items-end pb-1 pl-6 pr-6 shrink-0">
              <div className="glass h-9 rounded-full flex items-center gap-1 pl-1 pr-3.5 min-w-0 max-w-full">
                <SidebarTrigger className="size-7 text-fg-muted hover:text-fg" />
                <span aria-hidden="true" className="h-4 w-px bg-border-strong mx-1" />
                <AppBreadcrumb />
              </div>
            </header>

            <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
              <div
                ref={setPageHeaderSlot}
                className={[
                  "empty:hidden shrink-0 relative z-10 transition-[box-shadow] duration-200",
                  scrolled
                    ? "shadow-[0_1px_0_var(--border),0_10px_20px_-18px_rgb(15_23_42/0.4)]"
                    : "shadow-none",
                ].join(" ")}
              />
              <TelegramOnboarding />
              <main
                ref={(el) => {
                  mainRef.current = el;
                  if (!el) {
                    setScrolled(false);
                    return;
                  }
                  const onScroll = () => setScrolled(el.scrollTop > 0);
                  onScroll();
                  el.addEventListener("scroll", onScroll, { passive: true });
                  // Cleanup handled when ref unmounts (el = null branch above).
                }}
                key={pathname}
                className={`flex-1 min-h-0 overflow-y-auto [scrollbar-gutter:stable] [&::-webkit-scrollbar]:hidden [scrollbar-width:none] ${scrolled ? "[mask-image:linear-gradient(to_bottom,transparent,black_10px)]" : ""}`}
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
