import type { ComponentType } from "react";
import { NavLink, useLocation } from "react-router";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

import { TenantSwitcher } from "./TenantSwitcher";
import { Logo } from "./Logo";
import { UserProfile } from "./UserProfile";
import { BRAND_NAME } from "../lib/brand";
import {
  AgentIcon,
  ApiKeysIcon,
  AppsIcon,
  RuntimesIcon,
  DashboardIcon,
  DeploymentsIcon,
  EnvIcon,
  FilesIcon,
  GitHubIcon,
  LinearIcon,
  MemoryIcon,
  ModelCardsIcon,
  SessionsIcon,
  SkillsIcon,
  SlackIcon,
  VaultIcon,
} from "./icons";
import { consolePlugins } from "../plugins/registry";

interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  end?: boolean;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

/* ── Navigation groups — single source of truth for sidebar items ── */
const navGroups: NavGroup[] = [
  {
    label: "Home",
    items: [{ to: "/", label: "Dashboard", icon: DashboardIcon, end: true }],
  },
  {
    label: "Operate",
    items: [
      { to: "/agents", label: "Agents", icon: AgentIcon },
      { to: "/deployments", label: "Deployments", icon: DeploymentsIcon },
      { to: "/sessions", label: "Sessions", icon: SessionsIcon },
      { to: "/files", label: "Files", icon: FilesIcon },
      { to: "/evals", label: "Eval Runs", icon: SessionsIcon },
    ],
  },
  {
    label: "Infrastructure",
    items: [
      { to: "/environments", label: "Environments", icon: EnvIcon },
      { to: "/vaults", label: "Credential Vaults", icon: VaultIcon },
    ],
  },
  {
    label: "Configure",
    items: [
      { to: "/skills", label: "Skills", icon: SkillsIcon },
      { to: "/memory", label: "Memory Stores", icon: MemoryIcon },
      { to: "/model-cards", label: "Model Cards", icon: ModelCardsIcon },
      { to: "/api-keys", label: "API Keys", icon: ApiKeysIcon },
      { to: "/runtimes", label: "Local Runtimes", icon: RuntimesIcon },
    ],
  },
  {
    label: "Integrations",
    items: [
      { to: "/integrations/apps", label: "Apps", icon: AppsIcon },
      { to: "/integrations/linear", label: "Linear", icon: LinearIcon },
      { to: "/integrations/github", label: "GitHub", icon: GitHubIcon },
      { to: "/integrations/slack", label: "Slack", icon: SlackIcon },
    ],
  },
];

/**
 * Console sidebar — cloned from minimaxhub_benchmark/AppShell so the
 * brand-row recipe matches a known-good layout:
 *
 *   `<SidebarHeader className="bg-sidebar h-12 px-3 flex-row items-
 *   center gap-2">` directly hosts the brand row (no nested wrapper
 *   div). `flex-row` overrides shadcn's default `flex-col`, putting
 *   logo + name on one line aligned with the AppShell top toolbar.
 *
 *   `<Sidebar className="bg-sidebar border-0 group-data-[side=left]:
 *   border-r-0">` — bg-sidebar matches the AppShell outer wrapper so
 *   they read as one continuous stage; the border-0 + border-r-0
 *   pair strips shadcn's default right border which otherwise anti-
 *   aliases into a dark hairline against the rounded main panel.
 *
 * Layout from top to bottom:
 *
 *   1. SidebarHeader  — product mark and name (h-12)
 *   2. TenantSwitcher — h-11, shares the brand-row recipe so it
 *                       collapses identically (icon at x=12, text
 *                       hides via group-data-[collapsible=icon]:hidden)
 *   3. SidebarContent — nav items, flat for the first 4 groups, then a
 *                       labeled `Integrations` group at the bottom
 *   4. SidebarFooter  — UserProfile (alone — tenant lives at the top now)
 */
export function AppSidebar() {
  const { pathname } = useLocation();

  const groups = [
    ...navGroups,
    ...consolePlugins.flatMap((p) => p.navGroups ?? []),
  ];

  const isItemActive = (to: string, end?: boolean) => {
    if (end) return pathname === to;
    return pathname === to || pathname.startsWith(`${to}/`);
  };

  const renderItem = (item: NavItem) => {
    const active = isItemActive(item.to, item.end);
    return (
      <SidebarMenuItem key={item.to}>
        <SidebarMenuButton
          asChild
          isActive={active}
          tooltip={item.label}
          // Finder-with-focus selection: the active row is a filled
          // accent rounded-rect with white text and glyph; inactive rows
          // are transparent with accent-tinted glyphs. The `!` overrides
          // beat shadcn's `data-active:` variant, which Tailwind v4
          // matches regardless of the attribute's value.
          className={
            active
              ? "h-7 rounded-[6px] px-2 gap-2 !bg-brand !text-brand-fg font-medium shadow-[inset_0_0.5px_0_rgb(255_255_255/0.18)] [&_svg]:!text-brand-fg"
              : "h-7 rounded-[6px] px-2 gap-2 !bg-transparent !text-fg hover:!bg-bg-press active:!bg-bg-press [&_svg]:text-system-accent"
          }
        >
          <NavLink to={item.to} end={item.end}>
            <item.icon className="size-4 [stroke-width:1.75]" />
            <span>{item.label}</span>
          </NavLink>
        </SidebarMenuButton>
      </SidebarMenuItem>
    );
  };

  return (
    <Sidebar
      collapsible="icon"
      className="border-0 group-data-[side=left]:border-r-0 shadow-[0.5px_0_0_var(--hairline)]"
    >
      {/* Brand row shares the 52px toolbar band so mark + title sit on
          the same baseline as the toolbar to the right. */}
      <SidebarHeader className="h-[52px] px-4 flex-row items-center gap-2 group-data-[collapsible=icon]:px-3.5">
        <Logo size="sm" />
        <span className="font-display text-[14px] font-semibold tracking-[-0.01em] text-fg group-data-[collapsible=icon]:hidden">
          {BRAND_NAME}
        </span>
      </SidebarHeader>

      <div className="pb-1">
        <TenantSwitcher />
      </div>

      <SidebarContent className="px-1.5 pb-2 gap-0 [&::-webkit-scrollbar]:hidden [scrollbar-width:none]">
        {groups.map((g) => (
          <SidebarGroup key={g.label} className="px-1.5 pt-2.5 pb-0">
            {/* SF-style source-list header: sentence case, bold 11px,
                secondary label colour. */}
            <SidebarGroupLabel className="h-6 px-2 text-[11px] font-semibold tracking-[0.01em] text-fg-subtle">
              {g.label}
            </SidebarGroupLabel>
            <SidebarMenu className="gap-px">{g.items.map(renderItem)}</SidebarMenu>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter className="p-0 pt-1 shadow-[0_-0.5px_0_var(--hairline)]">
        <UserProfile />
      </SidebarFooter>
    </Sidebar>
  );
}
