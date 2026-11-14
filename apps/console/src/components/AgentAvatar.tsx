import { useContext, type ComponentType, type ReactNode } from "react";
import { QueryClientContext } from "@tanstack/react-query";

import { faceBook, naturalFace, tintClass, type AgentFace } from "@/lib/agent-face";
import { useAgents } from "@/lib/directory";
import { initials } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Identity marks.
 *
 * <AgentAvatar>   an agent's face: a soft-tinted squircle with a glyph that
 *                 says what the agent does. The face is chosen by a person,
 *                 carried over from the template the agent was created
 *                 from, or read from its name and description; two initials
 *                 are the last fallback (see `lib/agent-face.ts`). Pass the
 *                 agent's `id` and `name` and the avatar finds the rest in
 *                 the workspace directory, so one agent wears one face on
 *                 every screen and two agents never wear the same one.
 *                 Tint carries identity only, never status.
 * <EntityAvatar>  any other resource (environment, vault, skill, file…):
 *                 a neutral squircle with that resource's icon. No colour
 *                 coding by type.
 *
 * People (the signed-in user) and workspaces keep the round/squared
 * initial <Avatar>.
 *
 * Sizes (px): xs 20 · sm 24 · md 32 · lg 40 · xl 56 · 2xl 72.
 */
export type AvatarSize = "xs" | "sm" | "md" | "lg" | "xl" | "2xl";

const BOX: Record<AvatarSize, string> = {
  xs: "size-5 rounded-[6px] text-[0.53125rem] tracking-[-0.02em]",
  sm: "size-6 rounded-[7px] text-[0.625rem]",
  md: "size-8 rounded-[10px] text-caption-size",
  lg: "size-10 rounded-[12px] text-body-size",
  xl: "size-14 rounded-[16px] text-[1.125rem]",
  "2xl": "size-[72px] rounded-[20px] text-[1.5rem]",
};

const ICON: Record<AvatarSize, string> = {
  xs: "size-3",
  sm: "size-3.5",
  md: "size-4",
  lg: "size-5",
  xl: "size-6",
  "2xl": "size-8",
};

/**
 * An agent's glyph fills more of its tile than a resource icon does, and
 * its stroke is corrected for the size: a 24-grid icon drawn at 14px would
 * thin to under a pixel, and at 36px it would turn heavy.
 */
const GLYPH: Record<AvatarSize, string> = {
  xs: "size-3.5 [stroke-width:2.2]",
  sm: "size-[15px] [stroke-width:2.1]",
  md: "size-[18px] [stroke-width:1.9]",
  lg: "size-[22px] [stroke-width:1.75]",
  xl: "size-7 [stroke-width:1.6]",
  "2xl": "size-9 [stroke-width:1.5]",
};

interface AgentAvatarProps {
  name: string | null | undefined;
  /** Agent id: how the avatar finds the agent's face in the directory. */
  id?: string | null;
  size?: AvatarSize;
  /** Archived agents lose their tint. */
  archived?: boolean;
  /** Draw this face instead of looking one up: a stored choice such as
   *  `"telescope:lilac"` (a template that is not an agent yet), or a face
   *  already resolved (the avatar picker's preview). */
  face?: AgentFace | string | null;
  className?: string;
}

export function AgentAvatar({ face, ...props }: AgentAvatarProps) {
  // No query client means an isolated render (a test, a story): there is no
  // directory to ask, so the face is read from the name alone.
  const client = useContext(QueryClientContext);
  if (face === undefined && props.id && client) return <DirectoryFace {...props} id={props.id} />;
  const resolved =
    face && typeof face === "object" ? face : naturalFace({ id: props.id, name: props.name, metadata: { avatar: face } });
  return <FaceTile {...props} face={resolved} />;
}

/** Looks the agent up among the workspace's agents (one shared, cached read). */
function DirectoryFace({ id, ...props }: Omit<AgentAvatarProps, "face"> & { id: string }) {
  const { agents } = useAgents();
  const face = faceBook(agents).get(id) ?? naturalFace({ id, name: props.name });
  return <FaceTile {...props} face={face} />;
}

function FaceTile({
  name,
  size = "md",
  archived,
  face,
  className,
}: Omit<AgentAvatarProps, "face" | "id"> & { face: AgentFace }) {
  const Glyph = face.glyph?.icon;
  return (
    <span
      aria-hidden="true"
      data-face={`${face.glyph?.id ?? "initials"}/${face.tint}`}
      className={cn(
        "inline-flex shrink-0 items-center justify-center font-semibold tracking-tight select-none",
        archived
          ? "bg-bg-soft text-fg-subtle"
          : `${tintClass(face.tint)} bg-[var(--tint-bg)] text-[var(--tint-fg)] shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--tint-fg)_10%,transparent)]`,
        BOX[size],
        className,
      )}
    >
      {Glyph ? <Glyph className={GLYPH[size]} /> : initials(name)}
    </span>
  );
}

export function EntityAvatar({
  icon: Icon,
  children,
  size = "md",
  tone = "neutral",
  className,
}: {
  /** A lucide (or icons.tsx) component. */
  icon?: ComponentType<{ className?: string }>;
  /** Or any node (a brand glyph, a letter). Wins over `icon`. */
  children?: ReactNode;
  size?: AvatarSize;
  /** `neutral` everywhere; `wash` only in hero spots (profile header, empty state). */
  tone?: "neutral" | "wash" | "surface";
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden text-fg-muted",
        tone === "neutral" && "bg-bg-soft",
        tone === "surface" && "border border-border bg-bg-surface shadow-[var(--shadow-xs)]",
        tone === "wash" && "wash-corner border border-border bg-bg-surface text-fg",
        BOX[size],
        className,
      )}
    >
      {children ?? (Icon ? <Icon className={ICON[size]} /> : null)}
    </span>
  );
}
