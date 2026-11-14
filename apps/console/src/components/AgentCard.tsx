import type { ReactNode } from "react";
import { Link } from "react-router";
import { MessageSquarePlusIcon } from "lucide-react";

import { agentCapabilities } from "@/lib/agents";
import type { AgentActivity } from "@/lib/directory";
import { plural } from "@/lib/format";
import { startSession } from "@/lib/shell-events";
import { cn } from "@/lib/utils";

import type { AgentRecord } from "../types/agent";
import { AgentAvatar } from "./AgentAvatar";
import { Chip, StatusDot } from "./Badge";
import { ModelBadge } from "./ModelBadge";
import { RelativeTime } from "./RelativeTime";
import { Tip } from "./Tip";

/**
 * An agent, as a profile card. Two targets, and each says what it does:
 * the card opens the agent's profile; the round button at the bottom right
 * (a speech bubble with a plus, the same mark as the profile's "Start
 * session") starts a session with it.
 *
 *   <AgentCard agent={agent} activity={byAgent.get(agent.id)} menu={<RowActionsMenu …/>} />
 *
 * Anatomy: identity row (face · name · what it has been doing) · two-line
 * description · chips (model, then up to `maxChips` capabilities) with the
 * start button beside them. `compact` drops the chips for dense strips and
 * moves the start button up to the identity row.
 */
export function AgentCard({
  agent,
  activity,
  menu,
  compact,
  maxChips = 2,
  className,
  style,
}: {
  agent: AgentRecord;
  activity?: AgentActivity;
  /** Top-right overflow menu (archive, delete). */
  menu?: ReactNode;
  compact?: boolean;
  maxChips?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  const archived = !!agent.archived_at;
  const caps = agentCapabilities(agent);
  const shown = caps.slice(0, maxChips);
  const hidden = caps.slice(maxChips);
  const running = (activity?.running ?? 0) > 0;

  const start = !archived && (
    <Tip label={`Start a session with ${agent.name}`}>
      <button
        type="button"
        aria-label={`Start a session with ${agent.name}`}
        onClick={() => startSession({ agentId: agent.id })}
        // Lights up under its own pointer only: lit by the whole card, it
        // read as "this is what clicking the card does".
        className="relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full bg-bg-soft text-fg-muted transition-quick hover:bg-ink hover:text-on-ink focus-visible:bg-ink focus-visible:text-on-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-plum active:scale-95"
      >
        <MessageSquarePlusIcon className="size-4" />
      </button>
    </Tip>
  );

  return (
    <article
      style={style}
      className={cn(
        "group/card lift relative flex flex-col rounded-xl border border-border bg-bg-surface p-5 shadow-[var(--shadow-sm)]",
        // Keyboard focus rings the whole card, since the whole card is the link.
        "has-[h3>a:focus-visible]:outline-2 has-[h3>a:focus-visible]:outline-offset-2 has-[h3>a:focus-visible]:outline-plum",
        archived && "bg-bg-inset shadow-none",
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <AgentAvatar name={agent.name} id={agent.id} size="lg" archived={archived} />
        <div className="min-w-0 flex-1">
          <h3 className="flex items-start gap-2 text-h3 text-fg">
            {/* The stretched link makes the whole card the click target. A long
                name takes a second line rather than losing its end. */}
            <Link
              to={`/agents/${agent.id}`}
              className="line-clamp-2 min-w-0 rounded-sm break-words after:absolute after:inset-0 after:rounded-xl focus-visible:outline-none"
            >
              {agent.name}
            </Link>
            {archived && (
              <Chip tone="outline" className="mt-px shrink-0">
                Archived
              </Chip>
            )}
          </h3>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-fg-subtle">
            {running ? (
              <>
                <StatusDot status="running" />
                <span className="truncate font-medium text-info">{plural(activity!.running, "session")} running</span>
              </>
            ) : activity && activity.sessions > 0 ? (
              <span className="truncate">
                {plural(activity.sessions, "session")} · active <RelativeTime value={activity.lastActiveAt} />
              </span>
            ) : (
              <span className="truncate">No sessions yet</span>
            )}
          </div>
        </div>
        {compact && start}
      </div>
      {/* The menu floats over the corner on hover: it takes no room from the name. */}
      {menu && (
        <div className="absolute top-3 right-3 z-10 rounded-full bg-bg-surface opacity-0 shadow-[0_0_0_4px_var(--bg-surface)] transition-quick group-focus-within/card:opacity-100 group-hover/card:opacity-100 has-[[aria-expanded=true]]:opacity-100 dark:bg-bg-surface">
          {menu}
        </div>
      )}

      <p className={cn("mt-3 text-small text-fg-muted", compact ? "line-clamp-1" : "line-clamp-2 min-h-[2.5rem]")}>
        {agent.description?.trim() || "No description yet."}
      </p>

      {!compact && (
        <div className="mt-auto flex items-center gap-3 pt-3.5">
          <div className="flex h-[22px] min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-2 overflow-hidden">
            <ModelBadge model={agent.model} className="relative z-10" />
            {shown.map((c) => (
              <Tip key={c.key} label={c.title}>
                <span className="relative z-10 inline-flex">
                  <Chip icon={c.icon}>{c.label}</Chip>
                </span>
              </Tip>
            ))}
            {hidden.length > 0 && (
              <Tip label={hidden.map((c) => c.title).join(" · ")}>
                <span className="relative z-10 inline-flex">
                  <Chip>+{hidden.length}</Chip>
                </span>
              </Tip>
            )}
          </div>
          {/* Keeps the row's height on an archived card, so a mixed row stays level. */}
          {start || <span aria-hidden="true" className="size-8 shrink-0" />}
        </div>
      )}
    </article>
  );
}
