import {
  Avatar as ShadcnAvatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import { initials } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Initials avatar for PEOPLE (round) and WORKSPACES (`squared`). Image when
 * present, otherwise up to two initials, at every size, so a name reads
 * the same wherever it is drawn. Agents wear a face instead (a glyph and a
 * tint, <AgentAvatar>); other resources use <EntityAvatar>.
 */
const SIZE: Record<"xs" | "sm" | "md" | "lg", string> = {
  xs: "size-5 text-[0.53125rem]",
  sm: "size-6 text-[0.625rem]",
  md: "size-7 text-micro-size",
  lg: "size-9 text-small-size",
};

interface AvatarProps {
  /** Display name; up to two initials are used for the fallback. */
  name: string;
  /** Optional image url (e.g. persona avatar from an integration). */
  src?: string | null;
  size?: keyof typeof SIZE;
  /** Rounded square instead of a circle: reads as "workspace", not "person". */
  squared?: boolean;
  className?: string;
}

export function Avatar({ name, src, size = "md", squared, className = "" }: AvatarProps) {
  const initial = initials(name);
  const shape = squared ? "rounded-[30%] after:rounded-[30%] *:rounded-[30%]" : "rounded-full";

  return (
    <ShadcnAvatar className={cn(SIZE[size], shape, "shrink-0 after:hidden", className)}>
      {src && (
        <AvatarImage
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          className={squared ? "rounded-[30%]" : undefined}
        />
      )}
      <AvatarFallback
        className={cn(
          "font-semibold tracking-tight",
          squared ? "rounded-[30%] bg-bg-pressed text-fg" : "rounded-full bg-ink text-on-ink",
        )}
      >
        {initial}
      </AvatarFallback>
    </ShadcnAvatar>
  );
}
