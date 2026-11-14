import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useOutletContext } from "react-router";
import {
  ArchiveIcon,
  BoxIcon,
  BracesIcon,
  CopyIcon,
  FlaskConicalIcon,
  FolderIcon,
  LaptopIcon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
  SquareIcon,
  Trash2Icon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { copyText } from "@/lib/clipboard";
import { MOD_KEY } from "@/lib/shell-events";
import { cn } from "@/lib/utils";
import { linkHitArea } from "@/lib/links";
import type { SessionReading } from "@/lib/session-state";

import { AgentAvatar } from "../AgentAvatar";
import type { AppOutletContext } from "../AppShell";
import { Chip } from "../Badge";
import { EntityRef } from "../EntityRef";
import { GitHubIcon, LinearIcon, SlackIcon } from "../icons";
import { Kbd } from "../Kbd";
import { PAGE_GUTTER } from "../Page";
import { RelativeTime } from "../RelativeTime";
import { RowActionsMenu, type RowAction } from "../RowActionsMenu";
import { Skeleton } from "../Skeleton";
import { Tip } from "../Tip";
import { onTablistKeyDown, useMediaQuery } from "./hooks";
import { formatElapsed } from "./model";
import { SessionStatus } from "./SessionStatus";
import { githubLink, slackLink, type GitHubSource, type LinearSource, type SlackSource } from "./source";

export type SessionView = "chat" | "timeline";

/** DOM ids that tie the view tabs to the panel they switch (set on the page body by SessionDetail). */
export const SESSION_VIEW_PANEL_ID = "session-view-panel";
export const sessionViewTabId = (view: SessionView) => `session-view-tab-${view}`;

export interface SessionSourceInfo {
  linear?: LinearSource | null;
  /** The issue's own address in Linear, when it can be built (see source.ts). */
  linearUrl?: string | null;
  slack?: SlackSource | null;
  github?: GitHubSource | null;
  /** "console" | "linear" | "slack" | "github" | "eval" | "api" | "setup" */
  kind: string;
  evalRunId?: string;
}

/**
 * The session bar: the fixed header of a session. It answers, by name,
 * "what is this, what state is it in, who is it with", and holds the view
 * switch and the session's actions. It never scrolls; only the
 * conversation under it does.
 *
 *   [av] Title  ● Running                 [Conversation | Timeline]  [Stop] [Save as eval] ⋯ ▯
 *        Support Triage · Cloud sandbox · Linear SUP-482 · Started 5d ago · 6m 50s
 *
 * The one ink button on this screen is Send, in the composer. Everything
 * here is outline or ghost; rare and destructive actions are in the menu.
 */
export function SessionHeader({
  loading,
  title,
  titleParts,
  agent,
  reading,
  onShowWaiting,
  archived,
  source,
  environmentId,
  environmentName,
  startedAt,
  durationMs,
  view,
  onViewChange,
  eventCount,
  running,
  stopping,
  onStop,
  onSaveAsEval,
  onOpenTrajectory,
  trajectoryDisabled,
  onShowFiles,
  onArchive,
  onDelete,
  sessionId,
  panelOpen,
  onTogglePanel,
  below,
}: {
  loading: boolean;
  title: string;
  /** A title in two parts ("the goal" · "iteration 3"): the first is cut when there is no room, the second never. */
  titleParts?: { main: string; suffix: string } | null;
  agent: { id?: string; name?: string };
  /** The one reading of this session (lib/session-state.ts). */
  reading: SessionReading;
  /** Set while a person is being waited on: brings the first request into view. */
  onShowWaiting?: () => void;
  archived: boolean;
  source: SessionSourceInfo;
  /** Where it runs, by name. Shown when there is room; always in the details panel. */
  environmentId?: string;
  environmentName?: string;
  startedAt?: string | number | null;
  durationMs: number | null;
  view: SessionView;
  onViewChange: (view: SessionView) => void;
  eventCount: number;
  running: boolean;
  stopping: boolean;
  onStop: () => void;
  onSaveAsEval: () => void;
  onOpenTrajectory: () => void;
  trajectoryDisabled: boolean;
  onShowFiles: () => void;
  onArchive: () => void;
  onDelete: () => void;
  sessionId: string;
  panelOpen: boolean;
  onTogglePanel: () => void;
  /** Rows under the bar: thread tabs, the mission banner. */
  below?: ReactNode;
}) {
  const ctx = useOutletContext<AppOutletContext | undefined>();
  const slot = ctx?.pageHeaderSlot;
  const roomy = useMediaQuery("(min-width: 1400px)");
  if (!slot) return null;

  // "Save as eval" is a button while there is room for it, and a menu item when there is not.
  const menu: RowAction[] = [
    ...(roomy ? [] : [{ label: "Save as eval", icon: <FlaskConicalIcon />, onSelect: onSaveAsEval }]),
    { label: "View trajectory", icon: <BracesIcon />, disabled: trajectoryDisabled, onSelect: onOpenTrajectory },
    { label: "Files", icon: <FolderIcon />, onSelect: onShowFiles },
    { label: "Copy session id", icon: <CopyIcon />, onSelect: () => void copyText(sessionId) },
    { label: archived ? "Archived" : "Archive", icon: <ArchiveIcon />, disabled: archived, onSelect: onArchive },
    { label: "Delete", icon: <Trash2Icon />, destructive: true, onSelect: onDelete },
  ];

  return createPortal(
    <div data-slot="session-bar" className="border-b border-border">
      {/* One row while the title can keep about 24rem beside the controls.
          On a narrower panel the controls drop to a row of their own (view
          switch left, actions right), so the title has the full width
          instead of being squeezed to a few words, or to nothing. */}
      <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-2.5 pt-1 pb-3.5", PAGE_GUTTER)}>
        {loading ? (
          <div className="flex min-w-0 grow-[999] basis-[24rem] items-center gap-3">
            <Skeleton className="size-8 shrink-0" rounded="lg" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4.5 w-[min(26rem,70%)]" rounded="sm" />
              <Skeleton className="h-3 w-[min(16rem,55%)]" rounded="sm" />
            </div>
          </div>
        ) : (
          <div className="flex min-w-0 grow-[999] basis-[24rem] items-center gap-3">
            <AgentAvatar name={agent.name} id={agent.id} size="md" className="self-start mt-0.5" />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2.5 max-sm:items-start">
                <Tip label={title} delay={600}>
                  {titleParts ? (
                    <h1 className="flex min-w-0 text-h2 text-fg">
                      <span className="min-w-0 truncate">{titleParts.main}</span>
                      <span className="shrink-0 whitespace-pre"> · {titleParts.suffix}</span>
                    </h1>
                  ) : (
                    <h1 className="min-w-0 truncate text-h2 text-fg max-sm:line-clamp-2 max-sm:whitespace-normal">{title}</h1>
                  )}
                </Tip>
                <HeaderStatus reading={reading} onShowWaiting={onShowWaiting} />
                {archived && <Chip icon={ArchiveIcon}>Archived</Chip>}
              </div>
              <div className="mt-0.5 flex min-w-0 items-center gap-x-1.5 overflow-hidden text-small text-fg-muted">
                {agent.id ? (
                  <EntityRef kind="agent" id={agent.id} name={agent.name} avatar={false} className="shrink-0 font-normal text-fg-muted max-lg:shrink" />
                ) : (
                  <span>Unknown agent</span>
                )}
                {/* The details panel names the environment in full; the bar
                    repeats it only while the panel is closed. */}
                {environmentId && !panelOpen && (
                  <span className="hidden min-w-0 items-center gap-x-1.5 min-[1180px]:inline-flex">
                    <Dot />
                    {environmentId === "env_local_runtime" ? (
                      <span className="inline-flex shrink-0 items-center gap-1.5">
                        <LaptopIcon className="size-3.5 text-fg-subtle" /> Local runtime
                      </span>
                    ) : (
                      <span className="inline-flex max-w-[24rem] min-w-0 shrink items-center gap-1.5">
                        <BoxIcon className="size-3.5 shrink-0 text-fg-subtle" />
                        <EntityRef kind="environment" id={environmentId} name={environmentName} avatar={false} className="min-w-0 font-normal text-fg-muted" />
                      </span>
                    )}
                  </span>
                )}
                <SourceFact source={source} />
                {startedAt != null && (
                  <span className="inline-flex shrink-0 items-center gap-x-1.5 max-sm:hidden">
                    <Dot />
                    <RelativeTime value={startedAt} prefix="Started" className="shrink-0" />
                  </span>
                )}
                {durationMs != null && durationMs >= 1000 && (
                  <span className="hidden shrink-0 items-center gap-x-1.5 min-[1180px]:inline-flex">
                    <Dot />
                    <Tip label="From the first event to the last">
                      <span>{formatElapsed(durationMs)}</span>
                    </Tip>
                  </span>
                )}
              </div>
            </div>
          </div>
        )}

        <div className="flex shrink-0 grow items-center justify-end gap-1.5 self-start">
          {/* Roving tabindex: Tab reaches the selected view, ← → Home End move between views. */}
          <div className="mr-auto pr-1">
          <div
            role="tablist"
            aria-label="Session view"
            onKeyDown={onTablistKeyDown}
            className="inline-flex h-9 items-center gap-0.5 rounded-full bg-bg-soft p-[3px]"
          >
            <ViewTab view="chat" label="Conversation" active={view === "chat"} onClick={() => onViewChange("chat")} />
            <ViewTab
              view="timeline"
              label="Timeline"
              active={view === "timeline"}
              onClick={() => onViewChange("timeline")}
              count={eventCount > 0 ? eventCount : undefined}
            />
          </div>
          </div>
          {running && (
            <Tip label="Interrupt the turn that is running">
              <Button variant="outline" onClick={onStop} loading={stopping} loadingLabel="Stopping…">
                <SquareIcon data-icon="inline-start" className="size-3! fill-current" />
                Stop
              </Button>
            </Tip>
          )}
          {roomy && (
            <Tip label="Turn this session into a repeatable eval task">
              <Button variant="outline" onClick={onSaveAsEval}>
                <FlaskConicalIcon data-icon="inline-start" />
                Save as eval
              </Button>
            </Tip>
          )}
          <RowActionsMenu label="Session actions" actions={menu} />
          <Tip
            label={
              <>
                {panelOpen ? "Hide details" : "Show details"} <Kbd tone="onInk" keys={[MOD_KEY, "."]} />
              </>
            }
          >
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={panelOpen ? "Hide details" : "Show details"}
              aria-pressed={panelOpen}
              onClick={onTogglePanel}
              className={cn(panelOpen && "bg-bg-soft text-fg")}
            >
              {panelOpen ? <PanelRightCloseIcon /> : <PanelRightOpenIcon />}
            </Button>
          </Tip>
        </div>
      </div>
      {below}
    </div>,
    slot,
  );
}

/**
 * The session's state beside its title: the same badge every list shows.
 * While a person is being waited on it is also the way to what they are
 * waited on for: it says how many things, and pressing it shows the first.
 */
function HeaderStatus({ reading, onShowWaiting }: { reading: SessionReading; onShowWaiting?: () => void }) {
  const waiting = reading.waiting;
  if (!waiting || !onShowWaiting) return <SessionStatus reading={reading} variant="soft" className="max-sm:mt-0.5" />;
  const counted = waiting.count > 1 ? { ...reading, label: `${reading.label} · ${waiting.count}` } : reading;
  return (
    <Tip label={`Waiting on you: ${waiting.summary}. Show ${waiting.count === 1 ? "it" : "the first"}.`}>
      <button
        type="button"
        onClick={onShowWaiting}
        aria-label={`${reading.label}: ${waiting.summary} waiting on you. Show ${waiting.count === 1 ? "it" : "the first"}`}
        className="inline-flex shrink-0 rounded-full transition-quick hover:brightness-95 max-sm:mt-0.5 dark:hover:brightness-110"
      >
        <SessionStatus reading={counted} variant="soft" tip={false} />
      </button>
    </Tip>
  );
}

function Dot() {
  return (
    <span aria-hidden="true" className="shrink-0 text-fg-faint">
      ·
    </span>
  );
}

function ViewTab({
  view,
  label,
  active,
  onClick,
  count,
}: {
  view: SessionView;
  label: string;
  active: boolean;
  onClick: () => void;
  count?: number;
}) {
  return (
    <button
      type="button"
      role="tab"
      id={sessionViewTabId(view)}
      aria-controls={SESSION_VIEW_PANEL_ID}
      aria-selected={active}
      aria-label={label}
      tabIndex={active ? 0 : -1}
      onClick={onClick}
      className={cn(
        "inline-flex h-full items-center justify-center gap-1.5 rounded-full px-3.5 text-small leading-none font-medium whitespace-nowrap transition-quick select-none",
        active ? "bg-bg-surface text-fg shadow-[var(--shadow-xs)] dark:bg-bg-pressed" : "text-fg-muted hover:text-fg",
      )}
    >
      {label}
      {count !== undefined && (
        <span className={cn("text-micro tabular-nums", active ? "text-fg-muted" : "text-fg-subtle")} title={`${count} events`}>
          {count}
        </span>
      )}
    </button>
  );
}

/** Where the session came from, as one short fact after the agent's name. */
function SourceFact({ source }: { source: SessionSourceInfo }) {
  const { linear, slack, kind } = source;
  if (linear && (linear.issueIdentifier || linear.issueId)) {
    // A link when the issue's address is known (see source.ts); otherwise a
    // fact, and the details panel has the id to copy.
    const ident = linear.issueIdentifier;
    const inner = (
      <>
        <LinearIcon className="size-3.5 shrink-0" />
        <span className="truncate">{ident ? `Linear ${ident}` : "Linear issue"}</span>
      </>
    );
    return (
      <>
        <Dot />
        {source.linearUrl ? (
          <a
            href={source.linearUrl}
            target="_blank"
            rel="noreferrer"
            title={ident ? `Open ${ident} in Linear` : "Open the issue in Linear"}
            className={cn("inline-flex min-w-0 shrink-0 items-center gap-1.5 rounded-sm underline-offset-4 hover:text-fg hover:underline max-lg:shrink", linkHitArea)}
          >
            {inner}
          </a>
        ) : (
          <span
            title={ident ? `Started from Linear issue ${ident}` : "Started from a Linear issue"}
            className="inline-flex min-w-0 shrink-0 items-center gap-1.5 max-lg:shrink"
          >
            {inner}
          </span>
        )}
      </>
    );
  }
  if (slack && (slack.channelId || slack.threadTs)) {
    const label = slack.channelId ? (slack.channelId.startsWith("D") ? "Slack DM" : "Slack thread") : "Slack";
    const link = slackLink(slack);
    const inner = (
      <>
        <SlackIcon className="size-3.5 shrink-0" />
        <span className="truncate">{label}</span>
      </>
    );
    return (
      <>
        <Dot />
        {link ? (
          <a
            href={link.href}
            target="_blank"
            rel="noreferrer"
            title={link.opens === "thread" ? "Open the thread in Slack" : "Open the channel in Slack"}
            className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-sm underline-offset-4 hover:text-fg hover:underline", linkHitArea)}
          >
            {inner}
          </a>
        ) : (
          <span className="inline-flex shrink-0 items-center gap-1.5">{inner}</span>
        )}
      </>
    );
  }
  if (kind === "github" || source.github) {
    const to = githubLink(source.github);
    const inner = (
      <>
        <GitHubIcon className="size-3.5 shrink-0" />
        <span className="truncate">{to && to.label !== "GitHub" ? `GitHub ${to.label}` : "GitHub"}</span>
      </>
    );
    return (
      <>
        <Dot />
        {to ? (
          <a
            href={to.href}
            target="_blank"
            rel="noreferrer"
            title={`Open the ${to.opens} on GitHub`}
            className={cn("inline-flex min-w-0 shrink-0 items-center gap-1.5 rounded-sm underline-offset-4 hover:text-fg hover:underline max-lg:shrink", linkHitArea)}
          >
            {inner}
          </a>
        ) : (
          <span className="inline-flex shrink-0 items-center gap-1.5">{inner}</span>
        )}
      </>
    );
  }
  if (kind === "eval") {
    return (
      <>
        <Dot />
        {source.evalRunId ? (
          // The run by its name ("Support triage regression"), not the words "Eval run".
          <span className="inline-flex max-w-[16rem] min-w-0 items-center gap-1.5">
            <FlaskConicalIcon className="size-3.5 shrink-0 text-fg-subtle" />
            <EntityRef kind="eval_run" id={source.evalRunId} avatar={false} className="min-w-0 font-normal text-fg-muted" />
          </span>
        ) : (
          <span className="shrink-0">Eval run</span>
        )}
      </>
    );
  }
  if (kind === "setup") {
    return (
      <>
        <Dot />
        <span className="shrink-0">Agent setup</span>
      </>
    );
  }
  if (kind === "api") {
    return (
      <>
        <Dot />
        <span className="shrink-0">Started over the API</span>
      </>
    );
  }
  return null;
}
