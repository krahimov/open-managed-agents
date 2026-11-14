import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import {
  AlarmClockIcon,
  CheckIcon,
  CircleCheckIcon,
  CircleStopIcon,
  CopyIcon,
  FileIcon,
  FlagIcon,
  GoalIcon,
  HourglassIcon,
  ImageIcon,
  MinimizeIcon,
  RefreshCwIcon,
  SplitIcon,
  Undo2Icon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { getActiveTenantId } from "@/lib/api";
import type { Event } from "@/lib/events";
import type { SessionOutputFile } from "@/lib/session-outputs";
import { useCopy } from "@/lib/clipboard";
import { readFailure } from "@/lib/failures";
import { formatAbsolute, toDate, type DateInput } from "@/lib/format";
import { cn } from "@/lib/utils";
import { inlineLink, quietLink } from "@/lib/links";

import { AccessRequestCard } from "../AccessRequestCard";
import { AgentAvatar } from "../AgentAvatar";
import { AmbientRuleCard } from "../AmbientRuleCard";
import { BrandLoader } from "../BrandLoader";
import { Callout } from "../Callout";
import { ConfirmDialog } from "../ConfirmDialog";
import { CodeWell, EventCard, EventSection } from "../EventCard";
import { Markdown } from "../Markdown";
import { MemoryEnabledCard } from "../MemoryEnabledCard";
import { MissionVerdictCard } from "../MissionVerdictCard";
import { ModelBadge } from "../ModelBadge";
import { RelativeTime } from "../RelativeTime";
import { humanSkillName } from "../resources/skills";
import { SavedLoginLine } from "../SavedLoginLine";
import { SkillRequestCard } from "../SkillRequestCard";
import { Tip } from "../Tip";
import { AccessNote, ApprovalControls } from "./ApprovalControls";
import { MessageAttachmentChips } from "./AttachmentChips";
import type { SessionOperations } from "./hooks";
import { formatElapsed, type Block, type Item, type ToolCall } from "./model";
import { NEEDS_YOU_CARD } from "./RequestParts";
import { presentTool, ProviderResponse, serverInfo, ThreadNav, ToolInputPreview, ToolRun } from "./tools";
import { TurnFiles } from "./TurnFiles";

/**
 * The conversation: a 720px reading column of turns.
 *
 *   person   a soft bubble on the right
 *   agent    a header (avatar · name · time), then prose with NO bubble,
 *            interleaved with what the agent did: thinking that folds
 *            away, tool rows that open, approvals that cannot be missed,
 *            errors that say what failed
 *   system   wake-ups and endings as quiet rows, so nobody mistakes them
 *            for something a person typed
 *
 * It renders `Item[]` from `buildConversation` and nothing else; the page
 * owns the stream.
 */

export interface LiveStreams {
  thinking: Array<[string, string]>;
  toolInputs: Array<[string, { name?: string; partial: string }]>;
  messages: Array<[string, string]>;
}

export interface QueuedMessage {
  key: string;
  text: string;
  images: number;
  /** Other files sent with it (not images). */
  files?: number;
  /** Still on its way to the server (uploading, posting); otherwise the server holds it in its queue. */
  sending?: boolean;
}

const COLUMN = "mx-auto w-full max-w-[720px]";

export function ConversationView({
  items,
  agent,
  sessionId,
  running,
  streams,
  queued,
  ops,
  onApproveEnvironmentYaml,
  findEnvironmentYaml,
  onSelectThread,
  asker,
  turnFiles,
}: {
  items: Item[];
  agent: { id?: string; name?: string };
  sessionId: string;
  running: boolean;
  streams: LiveStreams;
  queued: QueuedMessage[];
  ops: SessionOperations;
  onApproveEnvironmentYaml?: (source: string) => void;
  findEnvironmentYaml?: (message: string) => string | null;
  onSelectThread?: (threadId: string) => void;
  /** In a sub-agent's thread: the agent that handed it the work. What reads
   *  as "you said" in a main thread was said by that agent here. */
  asker?: { id?: string; name?: string };
  /** Files the agent wrote, by the agent message that closes the turn they
   *  were written in (`outputsByTurn` in lib/session-outputs). Each turn
   *  shows its own under its prose. */
  turnFiles?: ReadonlyMap<Event, SessionOutputFile[]>;
}) {
  const last = items[items.length - 1];
  const streaming = streams.thinking.length + streams.toolInputs.length + streams.messages.length > 0;
  const lastBlock = last?.kind === "agent" ? last.blocks[last.blocks.length - 1] : undefined;
  const lastBlockBusy =
    lastBlock?.kind === "approval" || (lastBlock?.kind === "tools" && lastBlock.calls.some((c) => c.status === "running"));
  const showTyping = running && !streaming && !lastBlockBusy;

  const tail: ReactNode =
    streaming || showTyping ? (
      <>
        {streams.thinking.map(([id, text]) => (
          <EventCard key={`think-${id}`} kind="thinking" title="Thinking…" status="running" defaultOpen>
            {text || undefined}
          </EventCard>
        ))}
        {streams.toolInputs.map(([id, { name, partial }]) => {
          const p = presentTool({ name: name ?? "tool", flavor: "tool", input: {} });
          return (
            <EventCard
              key={`tin-${id}`}
              kind={p.kind}
              icon={p.icon}
              source={p.source}
              title={p.title}
              subtitle="Preparing the call…"
              status="running"
              defaultOpen={!!partial}
            >
              {partial ? (
                <EventSection label="Input so far">
                  <CodeWell>{partial}</CodeWell>
                </EventSection>
              ) : undefined}
            </EventCard>
          );
        })}
        {streams.messages.map(([id, text]) => (
          <div key={`stream-${id}`}>
            {text ? <Prose>{text}</Prose> : null}
            <BrandLoader size="sm" label="Writing" className={text ? "mt-2" : ""} />
          </div>
        ))}
        {showTyping && <BrandLoader size="md" label={`${agent.name ?? "The agent"} is working`} className="h-6" />}
      </>
    ) : null;

  // A quiet date line opens the conversation and marks each new day, so a
  // session that spans a week (wake-ups, follow-ups) keeps its bearings.
  let lastDay = "";
  const dayMark = (at: number | null, key: string): ReactNode => {
    if (at == null) return null;
    const day = new Date(at).toDateString();
    if (day === lastDay) return null;
    lastDay = day;
    return <DayDivider key={`day-${key}`} at={at} />;
  };

  return (
    <ThreadNav.Provider value={onSelectThread ?? null}>
    <div data-slot="conv-column" className={cn(COLUMN, "space-y-6")}>
      {items.map((item, i) => {
        const isLast = i === items.length - 1;
        const mark = dayMark(item.at, item.key);
        let node: ReactNode;
        switch (item.kind) {
          case "user":
            node = asker ? <AskedTurn key={item.key} item={item} asker={asker} asked={agent} /> : <UserTurn key={item.key} item={item} />;
            break;
          case "wakeup":
            node = <WakeupRow key={item.key} item={item} />;
            break;
          case "brief":
            node = <MissionBriefRow key={item.key} item={item} />;
            break;
          case "answered":
            node = <AnsweredRow key={item.key} item={item} />;
            break;
          case "note":
            node = <NoteRow key={item.key} item={item} />;
            break;
          case "agent":
            node = (
              <AgentTurn
                key={item.key}
                item={item}
                agent={agent}
                sessionId={sessionId}
                ops={ops}
                live={isLast && running}
                tail={isLast ? tail : null}
                onApproveEnvironmentYaml={onApproveEnvironmentYaml}
                findEnvironmentYaml={findEnvironmentYaml}
                onSelectThread={onSelectThread}
                files={turnFiles}
              />
            );
            break;
        }
        return mark ? [mark, node] : node;
      })}
      {tail && last?.kind !== "agent" && (
        <div className="space-y-3">
          <TurnHeader agent={agent} at={null} />
          {tail}
        </div>
      )}
      {queued.map((q) => (
        <QueuedTurn key={q.key} message={q} />
      ))}
    </div>
    </ThreadNav.Provider>
  );
}

/** "Today" · "Yesterday" · "Tuesday, Nov 4": the day a stretch of the conversation happened. */
function DayDivider({ at }: { at: number }) {
  const d = new Date(at);
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86_400_000);
  const label =
    days === 0
      ? "Today"
      : days === 1
        ? "Yesterday"
        : d.toLocaleDateString(undefined, {
            weekday: "long",
            month: "short",
            day: "numeric",
            ...(d.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }),
          });
  return (
    <div className="flex justify-center">
      <time dateTime={d.toISOString()} title={formatAbsolute(d)} className="text-xs font-medium text-fg-subtle">
        {label}
      </time>
    </div>
  );
}

/**
 * The time of day something in the conversation happened: "5:58 AM". The
 * day is already said once, by the divider above, so a turn says when in
 * that day; the full timestamp is in the tooltip.
 */
function ClockTime({ value, className }: { value: DateInput; className?: string }) {
  const d = toDate(value);
  if (!d) return null;
  return (
    <Tip label={formatAbsolute(d)}>
      <time dateTime={d.toISOString()} className={cn("whitespace-nowrap tabular-nums", className)}>
        {d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
      </time>
    </Tip>
  );
}

// ── person ──────────────────────────────────────────────────────────────

/** What a person said: a soft bubble on the right. Shared with the setup chat. */
export const BUBBLE = "max-w-[85%] rounded-2xl rounded-br-md bg-bg-soft px-4 py-2.5 text-prose text-fg";

/**
 * Agent prose: Markdown at the reading size. Every code block carries a
 * "Copy code" button in its corner (on hover or keyboard focus), so a
 * command can be lifted out without selecting it by hand.
 */
export function Prose({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn("text-prose text-fg", className)}>
      <Markdown copyCode>{children}</Markdown>
    </div>
  );
}

function UserTurn({ item }: { item: Extract<Item, { kind: "user" }> }) {
  const long = item.text.length > 900 || item.text.split("\n").length > 14;
  const [open, setOpen] = useState(false);
  return (
    <div className="group/turn flex flex-col items-end gap-1.5">
      {item.images.length > 0 && (
        <div className="flex max-w-[85%] flex-wrap justify-end gap-2">
          {item.images.map((id) => (
            <FileThumb key={id} fileId={id} />
          ))}
        </div>
      )}
      {item.text && (
        <div className={cn(BUBBLE, item.cancelled && "text-fg-subtle line-through opacity-70")}>
          <p className={cn("break-words whitespace-pre-wrap", long && !open && "line-clamp-[10]")}>{item.text}</p>
          {long && (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              className={cn(quietLink, "mt-1.5 text-small")}
            >
              {open ? "Show less" : "Show more"}
            </button>
          )}
        </div>
      )}
      {/* Images are shown above; every other file sent with the message is a chip. */}
      <MessageAttachmentChips attachments={item.attachments.filter((a) => a.kind !== "image")} />
      {item.cancelled ? (
        <span className="flex items-center gap-1 pr-1 text-xs text-fg-subtle">
          <Undo2Icon className="size-3" /> Retracted before the agent read it
        </span>
      ) : (
        item.at != null && (
          <ClockTime
            value={item.at}
            className="pr-1 text-xs text-fg-subtle opacity-0 transition-opacity duration-[var(--dur-base)] group-focus-within/turn:opacity-100 group-hover/turn:opacity-100"
          />
        )
      )}
    </div>
  );
}

const countOf = (n: number, one: string, many: string): string => (n === 1 ? `1 ${one}` : `${n} ${many}`);

function QueuedTurn({ message }: { message: QueuedMessage }) {
  const files = message.files ?? 0;
  const sent = [
    message.images > 0 ? countOf(message.images, "image", "images") : null,
    files > 0 ? countOf(files, "file", "files") : null,
  ]
    .filter(Boolean)
    .join(" and ");
  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className={cn(BUBBLE, "opacity-60")}>
        {message.text ? (
          <p className="break-words whitespace-pre-wrap">{message.text}</p>
        ) : (
          <p className="flex items-center gap-2 text-fg-muted">
            {message.images > 0 ? <ImageIcon className="size-4" /> : <FileIcon className="size-4" />}
            {sent || "Nothing to send"}
          </p>
        )}
      </div>
      <span className="flex items-center gap-1 pr-1 text-xs text-fg-subtle">
        {message.sending ? (
          <>Sending{sent && message.text ? ` with ${sent}` : ""}…</>
        ) : (
          <>
            <HourglassIcon className="size-3" /> Queued
          </>
        )}
      </span>
    </div>
  );
}

/** An attached image, fetched through the files endpoint with the workspace header. */
function FileThumb({ fileId }: { fileId: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    const tenant = getActiveTenantId();
    fetch(`/v1/files/${fileId}/content`, { credentials: "include", headers: tenant ? { "x-active-tenant": tenant } : {} })
      .then((res) => (res.ok ? res.blob() : Promise.reject(new Error(String(res.status)))))
      .then((blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setSrc(url);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [fileId]);
  if (src) {
    return (
      <a href={src} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-lg border border-border">
        <img src={src} alt="Attached image" className="size-16 object-cover" />
      </a>
    );
  }
  return (
    <span
      title={failed ? "This image could not be loaded" : "Loading image"}
      className={cn("flex size-16 items-center justify-center rounded-lg bg-bg-soft text-fg-subtle", !failed && "skeleton-pulse")}
    >
      <ImageIcon className="size-5" />
    </span>
  );
}

// ── system rows ─────────────────────────────────────────────────────────

function WakeupRow({ item }: { item: Extract<Item, { kind: "wakeup" }> }) {
  return (
    <Callout
      icon={AlarmClockIcon}
      title={
        <>
          Woke up on schedule
          {item.at != null && (
            <span className="font-normal text-fg-subtle">
              {" "}
              · <ClockTime value={item.at} />
            </span>
          )}
        </>
      }
    >
      {item.text ? <p className="break-words whitespace-pre-wrap">{item.text}</p> : "The agent resumed on a timer it set earlier."}
    </Callout>
  );
}

/**
 * The opening of a mission iteration. The run wrote this message, not a
 * person, so it is a note from the run: which iteration began, what it
 * picks up from, and the brief itself folded away for whoever wants the
 * exact words the agent was given.
 */
function MissionBriefRow({ item }: { item: Extract<Item, { kind: "brief" }> }) {
  const [open, setOpen] = useState(false);
  const n = item.failing.length;
  return (
    <Callout
      icon={GoalIcon}
      title={
        <>
          {item.iteration != null ? `Iteration ${item.iteration} started` : "The run started an iteration"}
          {item.at != null && (
            <span className="font-normal text-fg-subtle">
              {" "}
              · <ClockTime value={item.at} />
            </span>
          )}
        </>
      }
    >
      <p>
        {n === 0 ? (
          "The run gave the agent its goal and the checks that must pass when its turn ends."
        ) : (
          <>
            The run sent the agent back in because {n === 1 ? "a check" : `${n} checks`} failed last time:{" "}
            {item.failing.map((c, i) => (
              <span key={c}>
                {i > 0 && ", "}
                <code className="rounded-sm bg-bg-pressed/60 px-1 py-0.5 font-mono text-xs text-fg">{c}</code>
              </span>
            ))}
            .
          </>
        )}
      </p>
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className={cn(quietLink, "mt-1.5")}>
        {open ? "Hide the brief" : "Read the brief the agent was given"}
      </button>
      {open && (
        <div className="mt-2 animate-fade-in">
          <CodeWell>{item.text}</CodeWell>
        </div>
      )}
    </Callout>
  );
}

/**
 * The server telling the agent that a request was answered: an app was
 * connected, or a skill attached (and with it the skill's whole playbook).
 * Nobody typed it, so it is a line of the record, with the exact message
 * folded away for whoever wants to see what the agent was given.
 */
function AnsweredRow({ item }: { item: Extract<Item, { kind: "answered" }> }) {
  const [open, setOpen] = useState(false);
  const what =
    item.grant.kind === "access"
      ? `${serverInfo(item.grant.service).label} was connected`
      : item.grant.skill
        ? `The ${humanSkillName(item.grant.skill)} skill was attached`
        : "A skill was attached";
  return (
    <div className="text-xs text-fg-subtle">
      <div className="flex flex-wrap items-center justify-center gap-x-1.5 gap-y-1 py-1">
        <CircleCheckIcon className="size-3.5 text-success" />
        <span>
          {what}, and the agent was told
          {item.grant.kind === "skill" ? " how to use it" : ""}
        </span>
        {item.at != null && (
          <>
            <span aria-hidden="true">·</span>
            <ClockTime value={item.at} />
          </>
        )}
        <span aria-hidden="true">·</span>
        <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className={quietLink}>
          {open ? "Hide the message" : "Read the message"}
        </button>
      </div>
      {open && (
        <div className="mt-1.5 animate-fade-in">
          <CodeWell>{item.text}</CodeWell>
        </div>
      )}
    </div>
  );
}

/**
 * The message that opens a sub-agent's thread. Another agent wrote it, so it
 * sits on the left under that agent's name, not on the right as "you".
 */
function AskedTurn({
  item,
  asker,
  asked,
}: {
  item: Extract<Item, { kind: "user" }>;
  asker: { id?: string; name?: string };
  asked: { id?: string; name?: string };
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-small">
        <AgentAvatar name={asker.name} id={asker.id} size="sm" />
        <span className="min-w-0 truncate">
          <span className="font-medium text-fg">{asker.name ?? "Another agent"}</span>
          <span className="text-fg-muted"> asked {asked.name ?? "this agent"}</span>
        </span>
        {item.at != null && <ClockTime value={item.at} className="text-xs text-fg-subtle" />}
      </div>
      {item.text && (
        <div className="max-w-[85%] rounded-2xl rounded-tl-md bg-bg-soft px-4 py-2.5 text-prose text-fg">
          <p className="break-words whitespace-pre-wrap">{item.text}</p>
        </div>
      )}
    </div>
  );
}

function NoteRow({ item }: { item: Extract<Item, { kind: "note" }> }) {
  const Icon = item.note === "stopped" ? CircleStopIcon : FlagIcon;
  return (
    <div className="flex items-center justify-center gap-1.5 py-1 text-xs text-fg-subtle">
      <Icon className="size-3.5" />
      <span>{item.note === "stopped" ? "You stopped the agent" : "Session ended"}</span>
      {item.at != null && (
        <>
          <span aria-hidden="true">·</span>
          <ClockTime value={item.at} />
        </>
      )}
    </div>
  );
}

// ── agent ───────────────────────────────────────────────────────────────

function TurnHeader({ agent, at }: { agent: { id?: string; name?: string }; at: number | null }) {
  return (
    <div className="flex items-center gap-2 text-small">
      <AgentAvatar name={agent.name} id={agent.id} size="sm" />
      <span className="truncate font-medium text-fg">{agent.name ?? "Agent"}</span>
      {at != null && <ClockTime value={at} className="text-xs text-fg-subtle" />}
    </div>
  );
}

/**
 * The foot of a finished agent turn: how long it worked, then what can be
 * done with the reply. The action is a labelled button of its own, set
 * apart from the caption, so its glyph is never read as the caption's icon.
 */
function TurnFooter({ text, durationMs }: { text: string; durationMs: number | null }) {
  const { copied, copy } = useCopy();
  const worked = durationMs != null && durationMs >= 1000 ? formatElapsed(durationMs) : null;
  return (
    <div className="flex h-8 items-center gap-2 text-xs text-fg-subtle">
      {worked && (
        <>
          <span>Worked for {worked}</span>
          <span aria-hidden="true" className="h-3 w-px bg-border-strong" />
        </>
      )}
      <button
        type="button"
        onClick={() => void copy(text)}
        className={cn(
          "inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 font-medium text-fg-muted transition-quick hover:bg-bg-hover hover:text-fg",
          !worked && "-ml-2.5",
        )}
      >
        {copied ? <CheckIcon className="size-3.5 text-success" /> : <CopyIcon className="size-3.5" />}
        <span aria-live="polite">{copied ? "Copied" : "Copy reply"}</span>
      </button>
    </div>
  );
}

function AgentTurn({
  item,
  agent,
  sessionId,
  ops,
  live,
  tail,
  onApproveEnvironmentYaml,
  findEnvironmentYaml,
  onSelectThread,
  files,
}: {
  item: Extract<Item, { kind: "agent" }>;
  agent: { id?: string; name?: string };
  sessionId: string;
  ops: SessionOperations;
  live: boolean;
  tail: ReactNode;
  onApproveEnvironmentYaml?: (source: string) => void;
  findEnvironmentYaml?: (message: string) => string | null;
  onSelectThread?: (threadId: string) => void;
  files?: ReadonlyMap<Event, SessionOutputFile[]>;
}) {
  const waiting = item.blocks.some((b) => b.kind === "approval");
  const showFooter = !live && !waiting && !!item.text;
  const written = files?.size
    ? item.blocks.flatMap((b) => (b.kind === "text" ? (files.get(b.event) ?? []) : []))
    : [];
  return (
    <div className="space-y-3">
      <TurnHeader agent={agent} at={item.at} />
      {item.blocks.map((block) => (
        <BlockView
          key={block.key}
          block={block}
          agent={agent}
          sessionId={sessionId}
          ops={ops}
          onApproveEnvironmentYaml={onApproveEnvironmentYaml}
          findEnvironmentYaml={findEnvironmentYaml}
          onSelectThread={onSelectThread}
        />
      ))}
      {written.length > 0 && <TurnFiles sessionId={sessionId} files={written} />}
      {tail}
      {showFooter && <TurnFooter text={item.text} durationMs={item.durationMs} />}
    </div>
  );
}

function BlockView({
  block,
  agent,
  sessionId,
  ops,
  onApproveEnvironmentYaml,
  findEnvironmentYaml,
  onSelectThread,
}: {
  block: Block;
  agent: { id?: string; name?: string };
  sessionId: string;
  ops: SessionOperations;
  onApproveEnvironmentYaml?: (source: string) => void;
  findEnvironmentYaml?: (message: string) => string | null;
  onSelectThread?: (threadId: string) => void;
}) {
  switch (block.kind) {
    case "text": {
      const yaml = onApproveEnvironmentYaml && findEnvironmentYaml ? findEnvironmentYaml(block.text) : null;
      return (
        <div>
          <Prose>{block.text}</Prose>
          {yaml && onApproveEnvironmentYaml && (
            <Callout
              className="mt-3"
              title="This reply proposes an environment"
              action={
                <Button type="button" size="sm" variant="outline" onClick={() => onApproveEnvironmentYaml(yaml)}>
                  Approve environment
                </Button>
              }
            >
              Approving creates it from the YAML above. Nothing else changes.
            </Callout>
          )}
        </div>
      );
    }

    case "thinking": {
      const seconds = block.durationMs != null ? Math.max(1, Math.round(block.durationMs / 1000)) : null;
      return (
        <EventCard kind="thinking" title={seconds != null ? `Thought for ${seconds} ${seconds === 1 ? "second" : "seconds"}` : "Thought"}>
          {block.text}
        </EventCard>
      );
    }

    case "tools":
      return <ToolRun calls={block.calls} />;

    case "approval":
      return <ApprovalCard call={block.call} agentName={agent.name} sessionId={sessionId} />;

    case "error":
      return <ErrorCard block={block} ops={ops} />;

    case "warning":
      return (
        <Callout tone="warning" title={block.source ? `Warning from ${block.source.replace(/_/g, " ")}` : "Warning"}>
          {block.message}
        </Callout>
      );

    case "card":
      if (block.card === "access_request")
        return <AccessRequestCard event={block.event} sessionId={sessionId} state={block.request} granted={block.granted} />;
      if (block.card === "saved_login") return <SavedLoginLine event={block.event} sessionId={sessionId} switched={block.granted} />;
      if (block.card === "memory_enabled") return <MemoryEnabledCard event={block.event} />;
      if (block.card === "ambient_rule") return <AmbientRuleCard event={block.event} />;
      if (block.card === "mission_verdict") return <MissionVerdictCard event={block.event} />;
      return <SkillRequestCard event={block.event} sessionId={sessionId} state={block.request} />;

    case "note":
      return <InlineNote block={block} onSelectThread={onSelectThread} />;
  }
}

/** Things the agent did to its own run: scheduled a wake-up, compacted its context, started a sub-agent. */
function InlineNote({
  block,
  onSelectThread,
}: {
  block: Extract<Block, { kind: "note" }>;
  onSelectThread?: (threadId: string) => void;
}) {
  const e = block.event as Event & { scheduled_at?: string; reason?: string; agent_name?: string; session_thread_id?: string };
  const row = "flex min-h-8 items-start gap-2 py-1.5 text-small text-fg-muted";
  const icon = "mt-0.5 size-4 shrink-0 text-fg-subtle";
  if (block.note === "wake_scheduled") {
    return (
      <div className={row}>
        <AlarmClockIcon className={icon} />
        <p className="min-w-0">
          Scheduled a wake-up{e.scheduled_at ? <> for <span className="font-medium text-fg">{formatAbsolute(e.scheduled_at)}</span></> : null}
          {e.reason ? <span className="text-fg-subtle"> · {e.reason}</span> : null}
        </p>
      </div>
    );
  }
  if (block.note === "thread_started") {
    const threadId = e.session_thread_id;
    return (
      <div className={row}>
        <SplitIcon className={icon} />
        <p className="min-w-0">
          Handed work to <span className="font-medium text-fg">{e.agent_name ?? "another agent"}</span>
          {threadId && onSelectThread && (
            <>
              {" "}
              ·{" "}
              <button
                type="button"
                onClick={() => onSelectThread(threadId)}
                className={inlineLink}
              >
                Open its thread
              </button>
            </>
          )}
        </p>
      </div>
    );
  }
  if (block.note === "rescheduled") {
    return (
      <div className={row}>
        <RefreshCwIcon className={icon} />
        <p>The turn hit a temporary failure and will be retried automatically.</p>
      </div>
    );
  }
  return (
    <div className={row}>
      <MinimizeIcon className={icon} />
      <p>Earlier messages were summarised to free up context.</p>
    </div>
  );
}

// ── approval ────────────────────────────────────────────────────────────

/**
 * A tool call that is waiting on a person. Always open, amber, with the
 * exact input and two decisions. It scrolls itself into view when it
 * appears: the session cannot continue until someone answers.
 */
function ApprovalCard({ call, agentName, sessionId }: { call: ToolCall; agentName?: string; sessionId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, []);
  const p = presentTool(call);
  const toolLabel = p.source ? `${p.source} · ${p.title}` : p.title;
  const threadId = typeof call.use.session_thread_id === "string" ? call.use.session_thread_id : undefined;
  return (
    <div ref={ref} data-needs-you="approval" className="scroll-my-24">
      <EventCard
        kind="approval"
        className={NEEDS_YOU_CARD}
        title={`${agentName ?? "The agent"} wants to ${p.verb}`}
        subtitle={
          <>
            <span className="font-mono text-xs">{toolLabel}</span> is set to ask first. Nothing runs until you decide, and your answer
            applies to this call only.
          </>
        }
        meta={call.startedAt != null ? <RelativeTime value={call.startedAt} prefix="Asked" /> : undefined}
        actions={
          <ApprovalControls
            sessionId={sessionId}
            toolUseId={call.id ?? ""}
            threadId={threadId}
            {...(p.kind === "mcp" && p.source ? { server: p.source, tool: p.title.replace(/_/g, " ") } : {})}
          />
        }
      >
        <ToolInputPreview call={call} />
      </EventCard>
    </div>
  );
}

// ── error ───────────────────────────────────────────────────────────────

const ERROR_TITLES: Record<string, string> = {
  harness_turn_failed: "This turn failed",
  model_error: "The model request failed",
  sandbox_error: "The sandbox failed",
  budget_exceeded: "A budget limit stopped this turn",
};

/**
 * A failed turn. Leads with the cause in plain words and what to do next
 * (lib/failures.ts); the provider's exact response is folded under
 * "Provider response". The same failure reads the same on Operations.
 */
function ErrorCard({ block, ops }: { block: Extract<Block, { kind: "error" }>; ops: SessionOperations }) {
  const [confirm, setConfirm] = useState(false);
  const title = ERROR_TITLES[block.code] ?? (block.code ? block.code.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : "Something failed");
  const reading = readFailure(block.cause ?? block.message);
  const canRetry = !!block.workItemId && ops.retryable.has(block.workItemId);
  const retrying = ops.busy === `retry:${block.workItemId}`;
  const keys = reading.auth || reading.quota;
  return (
    <>
      <EventCard
        kind="error"
        title={title}
        subtitle={<span className="block text-pretty">{reading.cause ?? reading.headline}</span>}
        meta={block.at != null ? <ClockTime value={block.at} /> : undefined}
        actions={
          canRetry || keys ? (
            <>
              {canRetry && (
                <Button size="sm" variant="outline" disabled={!ops.canOperate || !!ops.busy} loading={retrying} onClick={() => setConfirm(true)}>
                  <RefreshCwIcon data-icon="inline-start" />
                  Retry
                </Button>
              )}
              {keys && (
                <Button size="sm" variant={canRetry ? "ghost" : "outline"} asChild>
                  <Link to="/model-cards">Review model keys</Link>
                </Button>
              )}
              {canRetry && <AccessNote ops={ops} action="retry a turn" />}
            </>
          ) : undefined
        }
      >
        {reading.next || block.model || reading.raw ? (
          <>
            {(reading.next || block.model) && (
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-small text-fg-muted">
                {block.model && <ModelBadge model={block.model} />}
                {reading.next}
              </p>
            )}
            {reading.raw && <ProviderResponse>{reading.raw}</ProviderResponse>}
          </>
        ) : undefined}
      </EventCard>
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Retry this turn?"
        body="The agent starts the failed turn again. Anything it finished before the failure may run a second time, so check the steps above first."
        confirmLabel="Retry turn"
        onConfirm={async () => {
          if (block.workItemId && !(await ops.retry(block.workItemId))) throw new Error("retry failed");
        }}
      />
    </>
  );
}
