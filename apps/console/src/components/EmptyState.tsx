import type { ComponentType, ReactNode } from "react";
import { BrandLoader } from "./BrandLoader";
import { Logo } from "./Logo";
import {
  EmptyAgentIcon,
  EmptyApiKeyIcon,
  EmptyEnvIcon,
  EmptyEvalIcon,
  EmptyFileIcon,
  EmptyMemoryIcon,
  EmptyModelCardIcon,
  EmptyRuntimeIcon,
  EmptySessionIcon,
  EmptySkillIcon,
  EmptyVaultIcon,
} from "./icons";

/**
 * Zero-data placeholder. Renders an entity-specific illustration (when
 * `kind` or `icon` is provided) or the product mark plus a title + body +
 * optional CTA slot.
 *
 * Used wherever a list / detail / dashboard panel has no content to show.
 * The illustration anchors the empty space so it reads as an intentional
 * system state instead of a broken page.
 *
 * Sizes:
 *   - sm  → fits inside table-empty rows or panel slots
 *   - md  → default, used at section level
 *   - lg  → page-level (when the whole route has no content)
 */
const SIZE: Record<
  "sm" | "md" | "lg",
  { wrap: string; icon: string; gap: string; title: string; body: string }
> = {
  sm: { wrap: "py-6 px-4", icon: "w-7 h-7", gap: "mb-2", title: "text-sm", body: "text-xs" },
  md: { wrap: "py-10 px-6", icon: "w-9 h-9", gap: "mb-3", title: "text-sm", body: "text-[13px]" },
  lg: { wrap: "py-16 px-8", icon: "w-10 h-10", gap: "mb-4", title: "text-base", body: "text-sm" },
};

/** Entities that have a hand-drawn illustration. Anything not listed
 *  falls back to the `[ ]` brand glyph — keep this in sync with
 *  `KIND_ICONS` below. */
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
  agent: EmptyAgentIcon,
  session: EmptySessionIcon,
  file: EmptyFileIcon,
  vault: EmptyVaultIcon,
  env: EmptyEnvIcon,
  eval: EmptyEvalIcon,
  skill: EmptySkillIcon,
  memory: EmptyMemoryIcon,
  model_card: EmptyModelCardIcon,
  api_key: EmptyApiKeyIcon,
  runtime: EmptyRuntimeIcon,
};

interface EmptyStateProps {
  title: string;
  /** Body text below the title. Optional. */
  body?: ReactNode;
  /** Action slot (Button, Link, or button-styled anchor). */
  action?: ReactNode;
  size?: keyof typeof SIZE;
  /** Show the BrandLoader pulse instead of the static `[ ]` mark.
   *  Used when the empty state is also a loading state — matches the
   *  visual language without a distinct spinner widget. */
  loading?: boolean;
  /** Renders an entity-specific SVG illustration above the title.
   *  Falls back to the `[ ]` brand glyph when omitted or unknown. */
  kind?: EmptyStateKind;
  /** Custom illustration override. Wins over `kind` when both are set —
   *  use this for one-off empty states (e.g. integration pages) that
   *  don't fit one of the core entity kinds. */
  icon?: ReactNode;
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
  className = "",
}: EmptyStateProps) {
  const s = SIZE[size];
  const KindIcon = kind ? KIND_ICONS[kind] : null;
  const logoSize = size === "lg" ? "lg" : size === "sm" ? "sm" : "md";
  return (
    <div
      className={`border border-border rounded-lg bg-bg-surface text-center shadow-[var(--shadow-sm)] ${s.wrap} ${className}`.trim()}
    >
      <div className={`flex justify-center ${s.gap}`}>
        {loading ? (
          <BrandLoader size={size} label={title} />
        ) : icon ? (
          <span aria-hidden="true" className={`text-fg-subtle inline-flex ${s.icon}`}>
            {icon}
          </span>
        ) : KindIcon ? (
          <KindIcon className={`${s.icon} text-fg-subtle`} />
        ) : (
          <Logo size={logoSize} className="text-fg-subtle" />
        )}
      </div>
      <p className={`text-fg ${s.title} font-medium`}>{title}</p>
      {body && <div className={`text-fg-muted mt-1.5 ${s.body}`}>{body}</div>}
      {action && <div className="mt-4 inline-flex">{action}</div>}
    </div>
  );
}
