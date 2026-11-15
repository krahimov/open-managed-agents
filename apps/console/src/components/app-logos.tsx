import type { ComponentType } from "react";
import { cn } from "@/lib/utils";

/**
 * Full-colour logos for the apps agents connect to (Gmail, Google Docs,
 * Slack, Notion, Jira…), bundled from src/assets/app-logos so the common
 * apps draw at once and offline. <AppIcon> uses these first; an app without
 * one falls back to its catalog logo URL, then to the single-colour glyph in
 * brand-marks.ts, then to its initial.
 */
const FILES = import.meta.glob<string>("../assets/app-logos/*.svg", {
  eager: true,
  query: "?url",
  import: "default",
});

const LOGOS: Record<string, string> = Object.fromEntries(
  Object.entries(FILES).map(([file, url]) => [file.replace(/^.*\/|\.svg$/g, ""), url]),
);

/** Other names the same app goes by. */
const ALIASES: Record<string, string> = {
  x: "twitter",
  teams: "microsoftteams",
  msteams: "microsoftteams",
  googlemail: "gmail",
  gdrive: "googledrive",
  gdocs: "googledocs",
  gsheets: "googlesheets",
  gcal: "googlecalendar",
  outlookmail: "outlook",
  microsoftoutlook: "outlook",
};

/** All-black logos that vanish on a dark tile; dark mode draws them in white, as their owners do. */
const INVERT_IN_DARK = new Set(["github", "intercom"]);

export function appLogoKey(key: string | null | undefined): string | undefined {
  if (!key) return undefined;
  const k = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!k) return undefined;
  for (const candidate of [k, k.replace(/(mcp|app|cloud)$/, "")]) {
    const resolved = ALIASES[candidate] ?? candidate;
    if (LOGOS[resolved]) return resolved;
  }
  return undefined;
}

/** The bundled logo for an app id or name, if there is one. */
export function appLogo(key: string | null | undefined): { src: string; invertInDark: boolean } | undefined {
  const k = appLogoKey(key);
  return k ? { src: LOGOS[k], invertInDark: INVERT_IN_DARK.has(k) } : undefined;
}

/** A logo image. Decorative: the app's name is always written beside it. */
export function LogoImage({
  src,
  invertInDark = false,
  className,
  onError,
}: {
  src: string;
  invertInDark?: boolean;
  className?: string;
  onError?: () => void;
}) {
  return (
    <img
      src={src}
      alt=""
      aria-hidden="true"
      draggable={false}
      decoding="async"
      onError={onError}
      className={cn("shrink-0 select-none object-contain", invertInDark && "dark:invert", className)}
    />
  );
}

/**
 * An app's logo as an icon component, for places that take one (integration
 * pages, trigger sources, tool calls, chips). Always at full opacity: a
 * faded logo reads as a disabled one. One component per app, made once.
 */
const iconCache = new Map<string, ComponentType<{ className?: string }>>();
export function appLogoIcon(key: string): ComponentType<{ className?: string }> | undefined {
  const logo = appLogo(key);
  if (!logo) return undefined;
  const k = appLogoKey(key)!;
  let icon = iconCache.get(k);
  if (!icon) {
    icon = function AppLogoIcon({ className }: { className?: string }) {
      return <LogoImage src={logo.src} invertInDark={logo.invertInDark} className={cn("size-4", className, "opacity-100")} />;
    };
    iconCache.set(k, icon);
  }
  return icon;
}

/** The three apps with their own integration pages, as icon components. */
export const SlackLogo = appLogoIcon("slack")!;
export const GitHubLogo = appLogoIcon("github")!;
export const LinearLogo = appLogoIcon("linear")!;
export const TeamsLogo = appLogoIcon("microsoftteams")!;
