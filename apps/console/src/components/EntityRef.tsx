import type { ComponentType } from "react";
import { Link } from "react-router";
import { BoxIcon, BrainIcon, FlaskConicalIcon, MessagesSquareIcon } from "lucide-react";

import { VaultIcon } from "@/components/icons";
import { ENTITY_META, useEntityName, type EntityKind } from "@/lib/directory";
import { cn } from "@/lib/utils";

import { AgentAvatar, EntityAvatar } from "./AgentAvatar";
import { Skeleton } from "./Skeleton";
import { Tip } from "./Tip";

const KIND_ICON: Record<Exclude<EntityKind, "agent">, ComponentType<{ className?: string }>> = {
  session: MessagesSquareIcon,
  environment: BoxIcon,
  vault: VaultIcon,
  memory_store: BrainIcon,
  eval_run: FlaskConicalIcon,
};

/**
 * A reference to another record, shown by NAME. Give it a kind and an id;
 * it resolves the name through the workspace directory, links to the
 * record, and keeps the id in a tooltip.
 *
 *   <EntityRef kind="environment" id={agent._oma.default_environment_id} />
 *   <EntityRef kind="agent" id={session.agent.id} name={session.agent.name} />
 *   <EntityRef kind="vault" id={id} variant="chip" />
 *
 * Pass `name` when the parent payload already carries it (sessions embed
 * their agent): no lookup is made. While resolving it shows a skeleton,
 * never the raw id. If the record is gone it says so.
 */
export function EntityRef({
  kind,
  id,
  name: knownName,
  variant = "inline",
  link = true,
  avatar = true,
  className,
}: {
  kind: EntityKind;
  id: string | null | undefined;
  /** Skip the lookup when the name is already known. */
  name?: string | null;
  /** `inline`: avatar + name, for rows and property values. `chip`: a pill. */
  variant?: "inline" | "chip";
  /** Link to the record's page (default true). */
  link?: boolean;
  /** Show the leading avatar/icon (default true). */
  avatar?: boolean;
  className?: string;
}) {
  const resolved = useEntityName(kind, knownName ? null : id);
  if (!id) return <span className={cn("text-fg-subtle", className)}>None</span>;

  const name = knownName ?? resolved.name;
  const href = `${ENTITY_META[kind].route}/${id}`;

  if (!knownName && resolved.isLoading) {
    return <Skeleton className={cn("inline-block h-4 w-28 align-middle", className)} rounded="sm" />;
  }

  const mark = !avatar ? null : kind === "agent" ? (
    <AgentAvatar name={name ?? "?"} id={id} size="xs" />
  ) : (
    <EntityAvatar icon={KIND_ICON[kind]} size="xs" />
  );

  const label = name ?? `Deleted ${ENTITY_META[kind].noun.toLowerCase()}`;
  const body = (
    <>
      {mark}
      {/* `data-ref-label`: a <PropertyList> lets a long name take a second line instead of cutting it. */}
      <span data-ref-label="" className={cn("truncate", !name && "text-fg-subtle italic")}>
        {label}
      </span>
    </>
  );

  const cls = cn(
    "inline-flex max-w-full min-w-0 items-center gap-1.5 align-middle",
    variant === "chip"
      ? "h-[26px] rounded-full bg-bg-soft pr-2.5 pl-1 text-xs font-medium text-fg"
      : "text-small-size font-medium text-fg",
    link && name && (variant === "chip" ? "transition-quick hover:bg-bg-pressed" : "rounded-sm decoration-border-strong underline-offset-4 hover:underline"),
    className,
  );

  return (
    <Tip
      label={
        <span>
          {name && <span className="block">{name}</span>}
          <span className="block font-mono opacity-75">{id}</span>
        </span>
      }
    >
      {link && name ? (
        <Link to={href} onClick={(e) => e.stopPropagation()} className={cls}>
          {body}
        </Link>
      ) : (
        <span className={cls}>{body}</span>
      )}
    </Tip>
  );
}
