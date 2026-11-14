import { useMemo, type ComponentType } from "react";
import {
  ActivityIcon,
  BoxIcon,
  BrainIcon,
  ChartColumnIcon,
  CirclePlayIcon,
  CpuIcon,
  FlaskConicalIcon,
  FolderIcon,
  HouseIcon,
  KeyRoundIcon,
  LaptopIcon,
  LayoutGridIcon,
  MessagesSquareIcon,
  PlugIcon,
  PuzzleIcon,
  RocketIcon,
  Settings2Icon,
  SlidersHorizontalIcon,
  UsersRoundIcon,
  WrenchIcon,
} from "lucide-react";

import { GitHubIcon, LinearIcon, SlackIcon, VaultIcon } from "./icons";
import { consolePlugins } from "../plugins/registry";
import { useServerFeatures, type ServerFeature } from "../lib/server-features";

/**
 * Navigation — the single source of truth for where things live.
 *
 * The sidebar (AppSidebar) and the command palette (CommandPalette) both
 * render from these lists, so a route added here shows up in both. Chords
 * (`g` + key) live in lib/route-chords.ts and are looked up by path.
 *
 * Information architecture (Muse):
 *   Primary    Home · Agents · Sessions · Operations
 *              the four places people go every day; always visible.
 *   Workspace  everything else, in four collapsible groups:
 *              Run      what running agents produce and cost
 *              Build    what agents are made of
 *              Connect  where agents reach out to / are reached from
 *              Settings keys and workspace administration
 *
 * Icon rule: one icon per destination or group, never reused (lucide, 16px,
 * 1.75 stroke via the `icon` class on the consumer). Brand marks are used only
 * for the three third-party integrations.
 *
 * A destination whose endpoints only some servers have names its `feature`
 * (lib/server-features.ts). The sidebar, the palette and the `g` chords read
 * the lists through `useNavigation()`, which leaves such a destination out
 * until the server says it has it, so nobody is sent to a page that can only
 * say it is not there.
 */

export interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  /** Match the path exactly (Home). */
  end?: boolean;
  /** Extra search terms for the command palette. */
  keywords?: string;
  /** Shown only when the server has this feature (see `useNavigation`). */
  feature?: ServerFeature;
}

export interface NavGroup {
  /** Stable key for persisted open/closed state. */
  id: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  items: NavItem[];
}

export const PRIMARY_NAV: NavItem[] = [
  { to: "/", label: "Home", icon: HouseIcon, end: true, keywords: "dashboard overview start composer" },
  { to: "/agents", label: "Agents", icon: UsersRoundIcon, keywords: "bots assistants" },
  { to: "/sessions", label: "Sessions", icon: MessagesSquareIcon, keywords: "conversations chats runs history" },
  { to: "/operations", label: "Operations", icon: ActivityIcon, keywords: "approvals failures budgets attention inbox", feature: "operations" },
];

export const WORKSPACE_NAV: NavGroup[] = [
  {
    id: "run",
    label: "Run",
    icon: CirclePlayIcon,
    items: [
      { to: "/deployments", label: "Deployments", icon: RocketIcon, keywords: "publish embed widget api" },
      { to: "/evals", label: "Evals", icon: FlaskConicalIcon, keywords: "eval runs evaluations tests suites" },
      { to: "/usage", label: "Usage", icon: ChartColumnIcon, keywords: "cost spend tokens analytics billing", feature: "usage" },
      { to: "/files", label: "Files", icon: FolderIcon, keywords: "uploads artifacts outputs" },
    ],
  },
  {
    id: "build",
    label: "Build",
    icon: WrenchIcon,
    items: [
      { to: "/skills", label: "Skills", icon: PuzzleIcon, keywords: "catalog capabilities" },
      { to: "/memory", label: "Memory", icon: BrainIcon, keywords: "memory stores knowledge" },
      { to: "/environments", label: "Environments", icon: BoxIcon, keywords: "envs sandboxes containers" },
      { to: "/vaults", label: "Vaults", icon: VaultIcon, keywords: "credential vaults secrets credentials" },
      { to: "/model-cards", label: "Models", icon: CpuIcon, keywords: "model cards providers keys anthropic openai" },
    ],
  },
  {
    id: "connect",
    label: "Connect",
    icon: PlugIcon,
    items: [
      { to: "/integrations/apps", label: "Apps", icon: LayoutGridIcon, keywords: "integrations composio oauth mcp" },
      { to: "/integrations/slack", label: "Slack", icon: SlackIcon, keywords: "integration chat" },
      { to: "/integrations/github", label: "GitHub", icon: GitHubIcon, keywords: "integration repos pull requests" },
      { to: "/integrations/linear", label: "Linear", icon: LinearIcon, keywords: "integration issues" },
      { to: "/runtimes", label: "Local runtimes", icon: LaptopIcon, keywords: "daemon machine acp", feature: "runtimes" },
    ],
  },
  {
    id: "settings",
    label: "Settings",
    icon: Settings2Icon,
    items: [
      { to: "/api-keys", label: "API keys", icon: KeyRoundIcon, keywords: "tokens access" },
      { to: "/workspace", label: "Workspace", icon: SlidersHorizontalIcon, keywords: "workspace settings members budgets access", feature: "workspace_access" },
    ],
  },
];

/** Groups contributed by hosted-only plugins (billing etc.). */
export function pluginNavGroups(): NavGroup[] {
  return consolePlugins.flatMap((p) => p.navGroups ?? []).map((g, i) => ({
    id: `plugin-${i}-${g.label.toLowerCase().replace(/\s+/g, "-")}`,
    label: g.label,
    icon: Settings2Icon,
    items: g.items.map((it) => ({ to: it.to, label: it.label, icon: it.icon, end: it.end })),
  }));
}

export function allWorkspaceGroups(): NavGroup[] {
  return [...WORKSPACE_NAV, ...pluginNavGroups()];
}

/** Every destination, flattened, for the command palette. */
export function allNavItems(): Array<NavItem & { group: string }> {
  return [
    ...PRIMARY_NAV.map((i) => ({ ...i, group: "Go to" })),
    ...allWorkspaceGroups().flatMap((g) => g.items.map((i) => ({ ...i, group: g.label }))),
  ];
}

/** Every destination path that names a server feature, and that feature. */
const GATED_PATHS: ReadonlyMap<string, ServerFeature> = new Map(
  [...PRIMARY_NAV, ...WORKSPACE_NAV.flatMap((g) => g.items)].flatMap((i) =>
    i.feature ? [[i.to, i.feature] as const] : [],
  ),
);

export interface Navigation {
  primary: NavItem[];
  groups: NavGroup[];
  /** Every shown destination, flattened, for the command palette. */
  items: Array<NavItem & { group: string }>;
  /** False for a path whose destination this server does not have. */
  shows: (path: string) => boolean;
}

/**
 * The destinations this server has. One that names a `feature` is left out
 * while the feature list is loading and when the server does not list it:
 * it appears once, never flashes in and out. A group left with no
 * destinations is left out too.
 */
export function useNavigation(): Navigation {
  const { data } = useServerFeatures();
  const on = data?.features;
  return useMemo(() => {
    const has = (item: Pick<NavItem, "feature">) => !item.feature || (on?.has(item.feature) ?? false);
    const primary = PRIMARY_NAV.filter(has);
    const groups = allWorkspaceGroups()
      .map((g) => ({ ...g, items: g.items.filter(has) }))
      .filter((g) => g.items.length > 0);
    const items = [
      ...primary.map((i) => ({ ...i, group: "Go to" })),
      ...groups.flatMap((g) => g.items.map((i) => ({ ...i, group: g.label }))),
    ];
    const shows = (path: string) => {
      const feature = GATED_PATHS.get(path);
      return !feature || (on?.has(feature) ?? false);
    };
    return { primary, groups, items, shows };
  }, [on]);
}

export function isNavItemActive(pathname: string, item: Pick<NavItem, "to" | "end">): boolean {
  if (item.end) return pathname === item.to;
  return pathname === item.to || pathname.startsWith(`${item.to}/`);
}
