import { Fragment, useEffect, useState, type ReactNode } from "react";
import {
  BanIcon,
  BotIcon,
  BrainIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  ClockIcon,
  EyeIcon,
  FilePlusIcon,
  GlobeIcon,
  HourglassIcon,
  KeyRoundIcon,
  LinkIcon,
  PlugIcon,
  SearchIcon,
  SparklesIcon,
  SquarePenIcon,
  TerminalIcon,
  WrenchIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { Event } from "../../lib/events";
import { Markdown } from "../Markdown";
import { Shimmer } from "../ai-elements/shimmer";
import { Spinner } from "../ui/spinner";
import { ToolConfirmationControls } from "../ToolConfirmationControls";
import {
  callDiff,
  describeTool,
  diffStats,
  formatElapsed,
  summarizeSteps,
  thinkingPreview,
  unwrapToolCall,
  type DiffLine,
  type TimelineItem,
  type ToolCall,
  type ToolKind,
  type WorkStep,
} from "./model";

/**
 * Tool-call timeline rows, after T3 Code's work log: one 28px line per
 * call (kind icon · verb · target · status/duration), click to expand the
 * input/output, consecutive calls summarized under one header, and a
 * finished turn's work folded behind "Worked for 2m 8s".
 */

const KIND_ICON: Record<ToolKind, LucideIcon> = {
  command: TerminalIcon,
  read: EyeIcon,
  write: FilePlusIcon,
  edit: SquarePenIcon,
  search: SearchIcon,
  web_search: GlobeIcon,
  web_fetch: LinkIcon,
  tool_search: SearchIcon,
  access: KeyRoundIcon,
  skill: SparklesIcon,
  schedule: ClockIcon,
  agent: BotIcon,
  mcp: PlugIcon,
  other: WrenchIcon,
};

const ROW =
  "group/row flex w-full min-w-0 min-h-7 items-center gap-2 rounded-md px-1.5 -mx-1.5 text-left text-[13px] leading-6 outline-none transition-colors hover:bg-bg-inset/70 focus-visible:ring-2 focus-visible:ring-ring/50";

interface RowCtx {
  sessionId?: string;
  threadId?: string;
}

// ---------------------------------------------------------------- timeline

export function WorkTimeline({
  items,
  renderEvent,
  sessionId,
  threadId,
}: {
  items: TimelineItem[];
  /** Host renderer for messages, system cards and errors. */
  renderEvent: (event: Event, key: string) => ReactNode;
} & RowCtx) {
  const [openFolds, setOpenFolds] = useState<Set<string>>(() => new Set());
  const toggle = (id: string) =>
    setOpenFolds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <>
      {items.map((item) => {
        if (item.kind === "fold") {
          return (
            <FoldRow
              key={item.key}
              label={item.label}
              failed={item.failed}
              open={openFolds.has(item.id)}
              onToggle={() => toggle(item.id)}
            />
          );
        }
        if (item.foldId && !openFolds.has(item.foldId)) return null;
        if (item.kind === "work") {
          return <WorkGroup key={item.key} steps={item.steps} sessionId={sessionId} threadId={threadId} />;
        }
        return <Fragment key={item.key}>{renderEvent(item.event, item.key)}</Fragment>;
      })}
    </>
  );
}

export function FoldRow({
  label,
  failed,
  open,
  onToggle,
}: {
  label: string;
  failed?: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex max-w-2xl items-center gap-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="group/fold inline-flex shrink-0 items-center gap-1 rounded-md text-[13px] leading-6 text-fg-muted outline-none transition-colors hover:text-fg focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <span className="tabular-nums">{label}</span>
        {failed && (
          <CircleAlertIcon className="ml-0.5 size-3.5 text-danger" role="img" aria-label="Includes a failed or denied tool call" />
        )}
        <ChevronRightIcon className={cn("size-3.5 text-fg-subtle transition-transform", open && "rotate-90")} aria-hidden />
      </button>
      <span className="h-px flex-1 bg-border" aria-hidden />
    </div>
  );
}

/** Live "Working for 12s" line while a turn runs. */
export function WorkingRow({ sinceMs }: { sinceMs: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const label = sinceMs !== null && now >= sinceMs
    ? `Working for ${formatElapsed(Math.max(1000, now - sinceMs)).replace(/\.\d+s$/, "s")}`
    : "Working…";
  return (
    <div className="flex min-h-7 items-center text-[13px] leading-6 tabular-nums" role="status">
      <Shimmer as="span" duration={1.6}>{label}</Shimmer>
    </div>
  );
}

// ---------------------------------------------------------------- groups

export function WorkGroup({ steps, sessionId, threadId }: { steps: WorkStep[] } & RowCtx) {
  const summary = summarizeSteps(steps);
  const parked = steps.some(
    (s) => s.kind === "tool" && (s.call.status === "awaiting_approval" || s.call.status === "awaiting_client"),
  );
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  // Live and parked groups stay open until the user decides otherwise.
  const open = userOpen ?? (summary.running || parked);

  if (steps.length === 1) {
    return (
      <div className="flex max-w-2xl flex-col">
        <StepRow step={steps[0]} sessionId={sessionId} threadId={threadId} />
      </div>
    );
  }
  const Icon = KIND_ICON[summary.kind];
  return (
    <div className="flex max-w-2xl flex-col" data-testid="work-group">
      <button type="button" aria-expanded={open} onClick={() => setUserOpen(!open)} className={ROW}>
        <Icon className="size-4 shrink-0 text-fg-subtle" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-fg-muted">{summary.label}</span>
        {summary.failed > 0 && (
          <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-danger">
            <XIcon className="size-3" aria-hidden />
            {summary.failed} failed
          </span>
        )}
        {summary.denied > 0 && (
          <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-warning">
            <BanIcon className="size-3" aria-hidden />
            {summary.denied} denied
          </span>
        )}
        {summary.running && <Spinner className="size-3 text-fg-subtle" />}
        <ChevronRightIcon
          className={cn("size-3.5 shrink-0 text-fg-subtle transition-transform", open ? "rotate-90" : "opacity-0 group-hover/row:opacity-100")}
          aria-hidden
        />
      </button>
      {open && (
        <div className="ml-[7px] flex flex-col border-l border-border pl-3">
          {steps.map((s) => (
            <StepRow key={s.key} step={s} sessionId={sessionId} threadId={threadId} />
          ))}
        </div>
      )}
    </div>
  );
}

function StepRow({ step, sessionId, threadId }: { step: WorkStep } & RowCtx) {
  if (step.kind === "tool") return <ToolCallRow call={step.call} sessionId={sessionId} threadId={threadId} />;
  if (step.kind === "thinking") return <ThinkingRow text={step.text} />;
  return <OrphanResultRow output={step.output} failed={step.failed} />;
}

// ---------------------------------------------------------------- rows

function StatusTrail({ call }: { call: ToolCall }) {
  switch (call.status) {
    case "running":
    case "responded":
      return <Spinner className="size-3 shrink-0 text-fg-subtle" />;
    case "awaiting_approval":
      return (
        <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-warning">
          <HourglassIcon className="size-3" aria-hidden />
          Needs approval
        </span>
      );
    case "awaiting_client":
      return <span className="shrink-0 text-[11px] text-fg-subtle">Waiting for client result</span>;
    case "failed":
      return (
        <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-danger">
          <XIcon className="size-3" aria-hidden />
          Failed
          {call.durationMs !== undefined && <span className="tabular-nums text-fg-subtle">· {formatElapsed(call.durationMs)}</span>}
        </span>
      );
    case "denied":
      return (
        <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-warning">
          <BanIcon className="size-3" aria-hidden />
          Denied
        </span>
      );
    case "completed":
      return call.durationMs !== undefined && call.durationMs >= 1 ? (
        <span className="shrink-0 text-[11px] tabular-nums text-fg-subtle">{formatElapsed(call.durationMs)}</span>
      ) : null;
  }
}

export function ToolCallRow({
  call,
  sessionId,
  threadId,
  streamingInput,
}: { call: ToolCall; streamingInput?: string } & RowCtx) {
  const parked = call.status === "awaiting_approval" || call.status === "awaiting_client";
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? parked;
  const d = call.descriptor;
  const Icon = KIND_ICON[d.kind];
  const live = call.status === "running" || call.status === "responded";
  const failed = call.status === "failed";
  const diff = callDiff(call);
  const stats = diff && d.kind === "edit" ? diffStats(diff) : diff ? { added: diff.length, removed: 0 } : null;

  const verb = d.kind === "mcp" && d.server ? (
    <>
      <span className="font-medium text-fg">{d.server}</span>
      <span className="text-fg-subtle"> · </span>
      <span className="text-fg-muted">{d.tool}</span>
    </>
  ) : live ? (
    <Shimmer as="span" duration={1.6}>{d.verb}</Shimmer>
  ) : (
    <span className="text-fg-muted">{d.verb}</span>
  );

  return (
    <div className="flex min-w-0 flex-col" data-status={call.status}>
      <button
        type="button"
        aria-expanded={open}
        aria-label={failed ? `${d.verb} ${d.target ?? ""}, failed`.trim() : undefined}
        onClick={() => setUserOpen(!open)}
        className={ROW}
      >
        <Icon className={cn("size-4 shrink-0", failed ? "text-danger" : "text-fg-subtle")} aria-hidden />
        <span className="min-w-0 flex-1 truncate">
          {verb}
          {d.target && (
            <>
              {" "}
              <span
                className={cn(
                  d.targetMono ? "font-mono text-[12px]" : "",
                  d.kind === "mcp" ? "text-fg-subtle" : "text-fg",
                )}
              >
                {d.target}
              </span>
            </>
          )}
          {stats && (stats.added > 0 || stats.removed > 0) && (
            <span className="ml-1.5 font-mono text-[11px] tabular-nums">
              {stats.added > 0 && <span className="text-success">+{stats.added}</span>}
              {stats.removed > 0 && <span className="ml-1 text-danger">−{stats.removed}</span>}
            </span>
          )}
        </span>
        <StatusTrail call={call} />
        <ChevronRightIcon
          className={cn("size-3.5 shrink-0 text-fg-subtle transition-transform", open ? "rotate-90" : "opacity-0 group-hover/row:opacity-100")}
          aria-hidden
        />
      </button>
      {open && (
        <ToolCallDetail call={call} diff={diff} streamingInput={streamingInput} sessionId={sessionId} threadId={threadId} />
      )}
    </div>
  );
}

/** Tool input still streaming in (partial JSON) — a live row until the
 *  canonical tool_use lands. */
export function StreamingToolRow({ toolUseId, name, partial }: { toolUseId: string; name: string; partial: string }) {
  let input: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(partial);
    if (parsed && typeof parsed === "object") input = parsed;
  } catch {
    // Partial JSON — label falls back to the bare tool name.
  }
  const target = unwrapToolCall(name, input);
  const call: ToolCall = { id: toolUseId, ...target, descriptor: describeTool(target.name, target.input), status: "running" };
  return (
    <div className="flex max-w-2xl flex-col">
      <ToolCallRow call={call} streamingInput={partial} />
    </div>
  );
}

export function ThinkingRow({ text, active = false }: { text: string; active?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex min-w-0 flex-col">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className={ROW}>
        <BrainIcon className="size-4 shrink-0 text-fg-subtle" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-fg-muted">
          {active ? <Shimmer as="span" duration={1.6}>Thinking</Shimmer> : open ? "Thought" : thinkingPreview(text)}
          {active && text && !open && <span className="ml-1.5 text-fg-subtle">{thinkingPreview(text)}</span>}
        </span>
        <ChevronRightIcon
          className={cn("size-3.5 shrink-0 text-fg-subtle transition-transform", open ? "rotate-90" : "opacity-0 group-hover/row:opacity-100")}
          aria-hidden
        />
      </button>
      {open && (
        <div className="ml-6 max-h-96 overflow-auto py-1 text-[13px] leading-relaxed text-fg-muted">
          <Markdown>{text}</Markdown>
        </div>
      )}
    </div>
  );
}

function OrphanResultRow({ output, failed }: { output: string; failed: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex min-w-0 flex-col">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className={ROW}>
        <WrenchIcon className={cn("size-4 shrink-0", failed ? "text-danger" : "text-fg-subtle")} aria-hidden />
        <span className="min-w-0 flex-1 truncate text-fg-muted">Tool result (unpaired)</span>
        {failed && <span className="shrink-0 text-[11px] text-danger">Failed</span>}
        <ChevronRightIcon className={cn("size-3.5 shrink-0 text-fg-subtle", open && "rotate-90")} aria-hidden />
      </button>
      {open && (
        <div className="ml-6 py-1">
          <Output text={output} tone={failed ? "danger" : "default"} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- detail

function ToolCallDetail({
  call,
  diff,
  streamingInput,
  sessionId,
  threadId,
}: { call: ToolCall; diff: DiffLine[] | null; streamingInput?: string } & RowCtx) {
  const d = call.descriptor;
  const failed = call.status === "failed";
  const output = call.output?.trim() ? call.output : undefined;
  const command = typeof call.input.command === "string" ? call.input.command : undefined;
  const hasInput = Object.keys(call.input).length > 0;

  let body: ReactNode;
  if (streamingInput !== undefined) {
    body = <Block label="Input (streaming)"><Output text={streamingInput || "…"} /></Block>;
  } else if (d.kind === "command" && command !== undefined) {
    body = (
      <div className="overflow-hidden rounded-md bg-bg-inset">
        <pre className="whitespace-pre-wrap break-words px-2.5 pt-1.5 font-mono text-[12px] leading-5 text-fg">
          <span className="select-none text-fg-subtle">$ </span>
          {command}
        </pre>
        {output ? (
          <Output text={output} tone={failed ? "danger" : "default"} bare />
        ) : (
          <div className="px-2.5 pb-1.5 font-mono text-[12px] leading-5 text-fg-subtle">
            {call.status === "running" ? "Running…" : "(no output)"}
          </div>
        )}
      </div>
    );
  } else if (diff) {
    body = (
      <>
        <DiffView lines={diff} />
        {failed && output && <Output text={output} tone="danger" />}
      </>
    );
  } else if (d.kind === "read") {
    body = output ? <Output text={output} tone={failed ? "danger" : "default"} /> : <Pending call={call} />;
  } else {
    body = (
      <>
        {hasInput && <Block label="Input"><Output text={JSON.stringify(call.input, null, 2)} /></Block>}
        {output ? (
          <Block label={failed ? "Error" : call.status === "denied" ? "Denied" : "Output"}>
            <Output text={output} tone={failed ? "danger" : "default"} />
          </Block>
        ) : (
          <Pending call={call} />
        )}
      </>
    );
  }

  return (
    <div className="mb-1 ml-6 flex min-w-0 flex-col gap-2 py-1">
      {body}
      {call.status === "awaiting_approval" && sessionId && (
        <ToolConfirmationControls
          sessionId={sessionId}
          toolUseId={call.id}
          threadId={threadId}
          {...(d.kind === "mcp" && d.server && d.tool ? { server: d.server, tool: d.tool } : {})}
        />
      )}
      {call.status === "awaiting_client" && (
        <div className="text-[12px] text-fg-subtle" role="status">
          Waiting for the client to post a <span className="font-mono">user.custom_tool_result</span> for this call.
        </div>
      )}
    </div>
  );
}

function Pending({ call }: { call: ToolCall }) {
  if (call.status !== "running" && call.status !== "responded") return null;
  return <div className="text-[12px] text-fg-subtle">Waiting for result…</div>;
}

function Block({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="text-[11px] font-medium uppercase tracking-wide text-fg-subtle">{label}</div>
      {children}
    </div>
  );
}

const MAX_LINES = 20;
const MAX_CHARS = 4000;

/** Mono output well, truncated to 20 lines / 4k chars with "Show more". */
export function Output({ text, tone = "default", bare = false }: { text: string; tone?: "default" | "danger"; bare?: boolean }) {
  const [full, setFull] = useState(false);
  const lines = text.split("\n");
  const long = lines.length > MAX_LINES || text.length > MAX_CHARS;
  const clipped = !full && long;
  let shown = text;
  if (clipped) {
    shown = lines.slice(0, MAX_LINES).join("\n");
    if (shown.length > MAX_CHARS) shown = shown.slice(0, MAX_CHARS);
  }
  const hiddenLines = lines.length - shown.split("\n").length;
  return (
    <div className={cn("min-w-0", !bare && "rounded-md bg-bg-inset", tone === "danger" && !bare && "bg-danger-subtle")}>
      <pre
        className={cn(
          "max-h-96 overflow-auto whitespace-pre-wrap break-words px-2.5 py-1.5 font-mono text-[12px] leading-5",
          tone === "danger" ? "text-danger" : "text-fg-muted",
        )}
      >
        {shown}
      </pre>
      {long && (
        <button
          type="button"
          onClick={() => setFull(!full)}
          className="w-full border-t border-border/70 px-2.5 py-1 text-left text-[11px] text-fg-subtle transition-colors hover:text-fg"
        >
          {full
            ? "Show less"
            : hiddenLines > 0
              ? `Show ${hiddenLines} more ${hiddenLines === 1 ? "line" : "lines"}`
              : "Show more"}
        </button>
      )}
    </div>
  );
}

const MAX_DIFF_LINES = 40;

export function DiffView({ lines }: { lines: DiffLine[] }) {
  const [full, setFull] = useState(false);
  const shown = full ? lines : lines.slice(0, MAX_DIFF_LINES);
  return (
    <div className="min-w-0 overflow-hidden rounded-md bg-bg-inset">
      <div className="max-h-96 overflow-auto py-1 font-mono text-[12px] leading-5">
        {shown.map((l, i) => (
          <div
            key={i}
            data-op={l.op}
            className={cn(
              "flex whitespace-pre-wrap break-words px-2.5",
              l.op === "+" && "bg-success-subtle text-success",
              l.op === "-" && "bg-danger-subtle text-danger",
              l.op === " " && "text-fg-muted",
            )}
          >
            <span className="w-4 shrink-0 select-none opacity-70">{l.op === " " ? "" : l.op}</span>
            <span className="min-w-0 flex-1">{l.text || " "}</span>
          </div>
        ))}
      </div>
      {lines.length > MAX_DIFF_LINES && (
        <button
          type="button"
          onClick={() => setFull(!full)}
          className="w-full border-t border-border/70 px-2.5 py-1 text-left text-[11px] text-fg-subtle transition-colors hover:text-fg"
        >
          {full ? "Show less" : `Show ${lines.length - MAX_DIFF_LINES} more lines`}
        </button>
      )}
    </div>
  );
}
