import type { ComponentType, ReactNode } from "react";
import { Link } from "react-router";
import {
  BoxIcon,
  BrainIcon,
  CpuIcon,
  FlaskConicalIcon,
  FolderIcon,
  InboxIcon,
  KeyRoundIcon,
  LaptopIcon,
  MessagesSquareIcon,
  PuzzleIcon,
  UsersRoundIcon,
} from "lucide-react";

import { VaultIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { BrandLoader } from "./BrandLoader";

/**
 * Nothing here (yet). Every empty list, panel and page uses this block:
 * an icon tile, one line that says what is missing, one line that says
 * what to do about it, and — when the person can fix it — one action.
 *
 *   <EmptyState
 *     kind="vault"
 *     title="No vaults yet"
 *     body="Vaults hold the credentials your agents use to reach other services."
 *     action={<Button onClick={create}>New vault</Button>}
 *   />
 *
 * Sizes:
 *   sm  inside a card or a table body
 *   md  a section of a page (default)
 *   lg  the whole page is empty: gets the brand wash behind the tile
 *
 * Copy: the title names the thing ("No sessions yet", "No agents match
 * 'foo'"), never "Nothing here". For a filtered-empty result the action is
 * "Clear filters", not "Create".
 *
 * The title of an `lg` state is a heading (the page has nothing else to
 * say): `h2` under a page title, `h1` when the state is the whole page,
 * as on a not-found page (`heading="h1"`). Smaller ones stay a paragraph
 * unless you say otherwise.
 *
 * A record that is not there is <RecordNotFound>, below: one wording for
 * every kind of record.
 */
const SIZE: Record<
  "sm" | "md" | "lg",
  { wrap: string; tile: string; icon: string; title: string; body: string }
> = {
  sm: { wrap: "px-4 py-8", tile: "size-9 rounded-[10px]", icon: "size-4", title: "text-sm font-medium", body: "text-small" },
  md: { wrap: "px-6 py-12", tile: "size-11 rounded-[12px]", icon: "size-5", title: "text-h3", body: "text-small" },
  lg: { wrap: "px-8 py-20", tile: "size-14 rounded-[16px]", icon: "size-6", title: "text-h2", body: "text-sm" },
};

/** Entities with a matching icon. Same icon as the destination's nav item. */
export type EmptyStateKind =
  | "agent"
  | "session"
  | "file"
  | "vault"
  | "env"
  | "eval"
  | "skill"
  | "memory"
  | "model_card"
  | "api_key"
  | "runtime";

const KIND_ICONS: Record<EmptyStateKind, ComponentType<{ className?: string }>> = {
  agent: UsersRoundIcon,
  session: MessagesSquareIcon,
  file: FolderIcon,
  vault: VaultIcon,
  env: BoxIcon,
  eval: FlaskConicalIcon,
  skill: PuzzleIcon,
  memory: BrainIcon,
  model_card: CpuIcon,
  api_key: KeyRoundIcon,
  runtime: LaptopIcon,
};

interface EmptyStateProps {
  title: string;
  /** One or two sentences below the title. */
  body?: ReactNode;
  /** A Button (or two: primary + ghost). */
  action?: ReactNode;
  size?: keyof typeof SIZE;
  /** Show the loader instead of the icon: an empty state that is also a wait. */
  loading?: boolean;
  /** Picks the icon for a core entity. */
  kind?: EmptyStateKind;
  /** Custom icon node (16–24px). Wins over `kind`. */
  icon?: ReactNode;
  /** `card` (default) draws the white card; `plain` sits on the parent surface. */
  variant?: "card" | "plain";
  /** The element the title is. Default: `h2` for `lg`, a paragraph otherwise. */
  heading?: "h1" | "h2" | "h3" | "p";
  className?: string;
}

export function EmptyState({
  title,
  body,
  action,
  size = "md",
  loading,
  kind,
  icon,
  variant = "card",
  heading,
  className = "",
}: EmptyStateProps) {
  const s = SIZE[size];
  const Title = heading ?? (size === "lg" ? "h2" : "p");
  const KindIcon = kind ? KIND_ICONS[kind] : InboxIcon;
  return (
    <div
      className={cn(
        "relative flex flex-col items-center overflow-hidden text-center *:relative",
        variant === "card" && "surface rounded-xl",
        s.wrap,
        className,
      )}
    >
      {size === "lg" && (
        <div
          aria-hidden="true"
          className="wash-corner pointer-events-none absolute! inset-x-0 top-0 h-48 opacity-70 [mask-image:linear-gradient(to_bottom,black,transparent)]"
        />
      )}
      {loading ? (
        <div className={cn("flex items-center justify-center", s.tile)}>
          <BrandLoader size={size} label={title} />
        </div>
      ) : (
        <div
          aria-hidden="true"
          className={cn(
            "flex items-center justify-center text-fg-muted",
            size === "lg" ? "border border-border bg-bg-surface shadow-[var(--shadow-sm)]" : "bg-bg-soft",
            s.tile,
          )}
        >
          {icon ? <span className={cn("inline-flex [&>svg]:size-full", s.icon)}>{icon}</span> : <KindIcon className={cn(s.icon, "stroke-[1.75]")} />}
        </div>
      )}
      <Title className={cn("mt-4 text-fg", s.title)}>{title}</Title>
      {body && <div className={cn("mt-1.5 max-w-[46ch] text-fg-muted", s.body)}>{body}</div>}
      {action && <div className="mt-5 flex flex-wrap items-center justify-center gap-2">{action}</div>}
    </div>
  );
}

/**
 * A record that is not there (a 404 on the read of one record). Every
 * record page draws this, so the words are the same everywhere:
 *
 *   This {thing} does not exist
 *   It may have been deleted, or the link is from another workspace.
 *   [ Back to {things} ]
 *
 * A read that failed for any other reason is not this: it is an
 * <ErrorState> that says the record "could not be loaded", with a retry.
 */
export function RecordNotFound({
  thing,
  kind,
  icon,
  back,
  className,
}: {
  /** The record in the singular, lower case: "agent", "memory store", "eval run". */
  thing: string;
  kind?: EmptyStateKind;
  icon?: ReactNode;
  /** Where the list is, and what to call it: `{ to: "/agents", label: "agents" }`. */
  back: { to: string; label: string };
  className?: string;
}) {
  return (
    <EmptyState
      size="lg"
      heading="h1"
      kind={kind}
      icon={icon}
      title={`This ${thing} does not exist`}
      body="It may have been deleted, or the link is from another workspace."
      action={
        <Button asChild>
          <Link to={back.to}>Back to {back.label}</Link>
        </Button>
      }
      className={className}
    />
  );
}
