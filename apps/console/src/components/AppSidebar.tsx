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
          // Decoration follows selection — same principle as the filter
          // chips: inactive rows are completely transparent (no pill,
          // no hover fill), only the active route gets the
          // bg-sidebar-accent pill. The `!` overrides are necessary
          // because Tailwind v4's `data-active:` variant matches the
          // attribute regardless of value (true/false both fire), so
          // shadcn's built-in `data-active:bg-sidebar-accent` would
          // otherwise paint every row.
          className={
            active
              ? "border border-border bg-bg-surface text-fg font-medium shadow-[var(--shadow-sm)]"
              : "border border-transparent !bg-transparent !text-fg-muted hover:!bg-bg-surface/70 hover:!text-fg"
          }
        >
          <NavLink to={item.to} end={item.end}>
            <item.icon className="size-4 opacity-80" />
            <span>{item.label}</span>
          </NavLink>
        </SidebarMenuButton>
      </SidebarMenuItem>
    );
  };

  return (
    <Sidebar
      collapsible="icon"
      className="bg-sidebar border-0 group-data-[side=left]:border-r-0"
    >
      <SidebarHeader className="bg-sidebar h-12 px-3 flex-row items-center gap-2">
        <Logo size="sm" />
        <span className="text-sm font-semibold text-fg group-data-[collapsible=icon]:hidden">
          {BRAND_NAME}
        </span>
      </SidebarHeader>

      {/* Tenant sits between brand row and nav content — same h-11 px-3
          recipe as the brand row so the collapse animation pins its
          icon at the same x=12 axis as the product mark above. `mt-2`
          drops it 8 px below the brand row so its vertical center
          aligns with the toolbar chips on the right (PageHeader's
          py-3 pushes them down by the same amount). */}
      <div className="mt-2">
        <TenantSwitcher />
      </div>

      <SidebarContent className="bg-sidebar px-1 pb-2 [&::-webkit-scrollbar]:hidden [scrollbar-width:none]">
        {groups.map((g) => (
          <SidebarGroup key={g.label} className="py-1">
            <SidebarGroupLabel className="h-6 px-2 text-[10px] font-semibold uppercase text-fg-subtle">
              {g.label}
            </SidebarGroupLabel>
            <SidebarMenu>{g.items.map(renderItem)}</SidebarMenu>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter className="bg-sidebar p-0">
        <UserProfile />
      </SidebarFooter>
    </Sidebar>
  );
}
