import { BookOpenIcon, CommandIcon, LogOutIcon, MonitorIcon, MoonIcon, SunIcon } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import { useAuth } from "../lib/auth";
import { useTheme } from "../lib/theme";
import { useApiQuery } from "../lib/useApiQuery";
import { authClient } from "../lib/auth-client";
import { BRAND_DOCS_URL } from "../lib/brand";
import { MOD_KEY, openCommandPalette } from "../lib/shell-events";
import { Avatar } from "./Avatar";
import { Kbd } from "./Kbd";
import { SegmentedControl } from "./SegmentedControl";
import { Tip } from "./Tip";

/**
 * Account menu — the round avatar at the foot of the sidebar. Holds what
 * belongs to the person rather than the workspace:
 *
 *   identity (name, email) · theme (Light / Dark / System) ·
 *   command palette · documentation · sign out
 */
const THEME_OPTIONS = [
  { value: "light" as const, label: "Light", icon: SunIcon },
  { value: "dark" as const, label: "Dark", icon: MoonIcon },
  { value: "system" as const, label: "System", icon: MonitorIcon },
];

export function UserProfile({ side = "top" }: { /** Where the menu opens: above the avatar, or beside it on the rail. */ side?: "top" | "right" }) {
  const { user } = useAuth();
  const { theme, setTheme } = useTheme();
  const me = useApiQuery<{ user: { name: string | null; email: string } | null }>("/v1/me", undefined, {
    staleTime: 5 * 60_000,
  });

  if (!user) return null;

  const handleSignOut = async () => {
    await authClient.signOut();
    window.location.href = "/login";
  };

  // The server's record of who this is wins over the session's copy, so the
  // person has one name here and on the Workspace page (in a local setup
  // without sign-in the session only holds a placeholder).
  const name = me.data?.user?.name?.trim() || user.name;
  const email = me.data?.user?.email || user.email;
  const label = name || email || "Account";

  return (
    <DropdownMenu>
      <Tip label={label} side={side}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Account menu"
            className="flex size-9 shrink-0 items-center justify-center rounded-full transition-quick hover:bg-bg-hover aria-expanded:bg-bg-hover"
          >
            <Avatar name={label} size="md" />
          </button>
        </DropdownMenuTrigger>
      </Tip>

      <DropdownMenuContent side={side} align="end" sideOffset={side === "right" ? 10 : 4} className="w-64" collisionPadding={8}>
        <div className="flex items-center gap-3 px-2 pt-2 pb-2.5">
          <Avatar name={label} size="lg" />
          <div className="min-w-0 leading-tight">
            <div className="truncate text-sm font-medium text-fg">{name || email}</div>
            {email && name && <div className="mt-0.5 truncate text-xs text-fg-subtle">{email}</div>}
          </div>
        </div>

        <div className="px-1 pb-1.5">
          <SegmentedControl
            label="Theme"
            size="sm"
            stretch
            value={theme}
            onChange={setTheme}
            options={THEME_OPTIONS.map((o) => ({ ...o, label: o.label }))}
          />
        </div>

        <DropdownMenuSeparator />

        <DropdownMenuGroup>
          <DropdownMenuItem onSelect={() => openCommandPalette()}>
            <CommandIcon />
            Command palette
            <DropdownMenuShortcut>
              <Kbd keys={[MOD_KEY, "K"]} />
            </DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <a href={BRAND_DOCS_URL} target="_blank" rel="noopener noreferrer">
              <BookOpenIcon />
              Documentation
            </a>
          </DropdownMenuItem>
        </DropdownMenuGroup>

        <DropdownMenuSeparator />

        <DropdownMenuItem onClick={handleSignOut}>
          <LogOutIcon />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
