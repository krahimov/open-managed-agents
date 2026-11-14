import { Fragment, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import {
  AlarmClockIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleDotIcon,
  LightbulbIcon,
  MessageSquareIcon,
  MinusIcon,
  MoonIcon,
  PlusIcon,
  ShieldAlertIcon,
  SparklesIcon,
  UserRoundIcon,
  XIcon,
  UsersRoundIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { formatCompact, pickTickStep } from "@/lib/format";
import type { Event } from "@/lib/events";
import { isErrorResult } from "@/lib/tool-status";
import { cn } from "@/lib/utils";

import { StatusBadge } from "../Badge";
import { ChartLegend } from "../charts/ChartLegend";
import { useMeasure } from "../charts/util";
import { Disclosure } from "../Disclosure";
import { EmptyState } from "../EmptyState";
import { CodeWell } from "../EventCard";
import { CopyButton } from "../IdChip";
import { Markdown } from "../Markdown";
import { ModelBadge } from "../ModelBadge";
import { Skeleton } from "../Skeleton";
import { eventText, eventTime, formatElapsed, readToolUse, resultText, type ToolCall } from "../sessions/model";
import { presentTool, ToolBody } from "../sessions/tools";
import { Tip } from "../Tip";
import { bucketIntoTurns, deriveSpans } from "./derive";
import {
  DURATION_COL_W,
  FAMILY_KIND,
  KIND_COLOR,
  KIND_LABEL,
  LABEL_COL_W,
  ROW_H,
  SIDE_PANEL_W,
  TRIGGER_LABEL,
  type Span,
  type SpanKind,
  type TimelineSelection,
  type Turn,
  type TurnTriggerKind,
} from "./types";

/**
 * The timeline: the same session as a waterfall of time.
 *
 *   summary    how long it took and where the time went, by kind of work
 *   turns      one card per turn (a message, a wake-up or an approval and
 *              everything the agent did in response); each card is its own
 *              waterfall on its own scale, so a 40-second turn is not
 *              flattened by a 4-day wait before it
 *   inspector  click any row: the same body the conversation shows for
 *              that step, plus the raw events it was built from
 *
 * Colour encodes the KIND of work and nothing else (types.ts KIND_COLOR).
 */
export function TimelineView({
  events,
  scrollTarget,
  loading,
  onInspect,
  sender,
}: {
  events: Event[];
  /** Who sends the messages that start a turn. In a session it is the
   *  person reading ("You"); in an eval trial it is the task or the
   *  simulated user, so the trial page passes its own words. */
  sender?: { name: string; message: string };
  /** Deep-link request: scroll to (and select the span containing) the
   *  event with this id. `nonce` lets the same id re-trigger the scroll
   *  on repeat clicks. Matches EventBase.id (sevt_*) or the trace-facts
   *  `seq:<n>` fallback id. */
  scrollTarget?: { eventId: string; nonce: number } | null;
  /** History is still loading: show the shape, not "nothing here". */
  loading?: boolean;
  /** Told when the inspector opens or closes, so a host can make room. */
  onInspect?: (open: boolean) => void;
}) {
  const turns = useMemo(() => bucketIntoTurns(events), [events]);
  const derived = useMemo(
    () =>
      turns.map((t) => {
        // A call's fate (denied, still waiting) is read from the whole log:
        // it is often decided in the turn after the one that asked.
        const d = deriveSpans(t.events, events);
        if (!sender) return { turn: t, ...d };
        // deriveSpans writes "Message from you"; say who actually sent it.
        return { turn: t, ...d, spans: d.spans.map((sp) => (sp.label === "Message from you" ? { ...sp, label: sender.message } : sp)) };
      }),
    [turns, sender, events],
  );
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [selection, setSelection] = useState<TimelineSelection | null>(null);

  const inspecting = !!selection;
  useEffect(() => {
    onInspect?.(inspecting);
  }, [inspecting]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onInspect?.(false), []); // eslint-disable-line react-hooks/exhaustive-deps

  // Follow new turns while the reader is at the bottom; never yank them
  // away from an older turn they are inspecting.
  // (Only when a turn is added after the first paint: a short session is
  // "at the bottom" on arrival, and jumping there hid the summary.)
  const seenTurns = useRef<number | null>(null);
  useEffect(() => {
    const el = containerRef.current;
    const before = seenTurns.current;
    seenTurns.current = turns.length;
    if (!el || before === null || before === 0 || turns.length <= before) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 200) el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
  }, [turns.length]);

  // Evidence deep-link: open the span that holds the requested event and
  // bring its turn into view.
  useEffect(() => {
    if (!scrollTarget) return;
    const { eventId } = scrollTarget;
    const matches = (e: Event) =>
      (e as { id?: string }).id === eventId ||
      (typeof (e as { seq?: number }).seq === "number" && `seq:${(e as { seq?: number }).seq}` === eventId);
    const hit = derived.find((d) => d.turn.events.some(matches));
    if (!hit) return;
    const span = hit.spans.find((s) => s.events.some(matches));
    if (span) setSelection({ turnId: hit.turn.id, span });
    containerRef.current?.querySelector(`[data-turn-id="${hit.turn.id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [scrollTarget]); // eslint-disable-line react-hooks/exhaustive-deps -- fire per click, not per event batch

  // Step through rows from the inspector, across turns.
  const order = useMemo(() => derived.flatMap((d) => d.spans.map((span) => ({ turnId: d.turn.id, span }))), [derived]);
  const index = selection ? order.findIndex((o) => o.span.key === selection.span.key && o.turnId === selection.turnId) : -1;
  const step = (delta: number) => {
    const next = order[index + delta];
    if (!next) return;
    setSelection(next);
    containerRef.current
      ?.querySelector(`[data-span-key="${CSS.escape(`${next.turnId}:${next.span.key}`)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  };

  if (loading && turns.length === 0) {
    return (
      <div className="min-h-0 flex-1 overflow-hidden px-6 py-6 lg:px-8" aria-hidden="true">
        <div className="mx-auto max-w-[1440px] space-y-4">
          <Skeleton className="h-[88px] w-full" rounded="xl" />
          <div className="surface rounded-xl p-5">
            <Skeleton className="h-4 w-56" rounded="sm" />
            <div className="mt-5 space-y-3.5">
              {[38, 64, 22, 80, 47, 30].map((w, i) => (
                <div key={i} className="flex items-center gap-4">
                  <Skeleton className="h-3 w-40" rounded="sm" />
                  <Skeleton className="h-2" rounded="full" style={{ width: `${w / 2}%`, marginLeft: `${i * 7}%` }} />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (turns.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6">
        <EmptyState
          variant="plain"
          size="md"
          icon={<CircleDotIcon />}
          title="Nothing to chart yet"
          body="Send a message and the timeline fills in as the agent works: every model call, tool call and wait, to scale."
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
      <div ref={containerRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1440px] space-y-4 px-6 py-6 lg:px-8">
          <Summary derived={derived} />
          {derived.map(({ turn, spans, totalMs }, i) => {
            const prev = i > 0 ? turns[i - 1] : null;
            const idleMs = prev && prev.endedAt && turn.triggerTs && turn.triggerTs > prev.endedAt ? turn.triggerTs - prev.endedAt : 0;
            return (
              <Fragment key={turn.id}>
                {idleMs > 0 && <IdleDivider ms={idleMs} nextKind={turn.triggerKind} />}
                {/* data-turn-id anchors the evidence deep-link scroll above. */}
                <div data-turn-id={turn.id}>
                  <TurnCard
                    turn={turn}
                    index={i}
                    spans={spans}
                    totalMs={totalMs}
                    senderName={sender?.name}
                    selectedKey={selection?.turnId === turn.id ? selection.span.key : null}
                    onSelectSpan={(span) =>
                      setSelection((cur) => (cur?.span.key === span.key && cur.turnId === turn.id ? null : { turnId: turn.id, span }))
                    }
                  />
                </div>
              </Fragment>
            );
          })}
        </div>
      </div>
      {selection && (
        <Inspector
          span={selection.span}
          position={index >= 0 ? `${index + 1} of ${order.length}` : undefined}
          onPrev={index > 0 ? () => step(-1) : undefined}
          onNext={index >= 0 && index < order.length - 1 ? () => step(1) : undefined}
          onClose={() => setSelection(null)}
        />
      )}
    </div>
  );
}

// ── summary ─────────────────────────────────────────────────────────────

const MIX_ORDER: SpanKind[] = ["model", "tool", "mcp", "approval", "schedule"];

function turnTokens(events: Event[]) {
  let input = 0;
  let output = 0;
  let calls = 0;
  for (const e of events) {
    if (e.type !== "span.model_request_end") continue;
    const usage =
      (e as { model_usage?: Record<string, number> }).model_usage ??
      (e.data as { model_usage?: Record<string, number> } | undefined)?.model_usage;
    calls += 1;
    if (usage) {
      input += (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
      output += usage.output_tokens ?? 0;
    }
  }
  return { input, output, calls };
}

/** Headline numbers and "where the time went": one proportion bar by kind of work. */
function Summary({ derived }: { derived: Array<{ turn: Turn; spans: Span[]; totalMs: number }> }) {
  const stats = useMemo(() => {
    const byKind = new Map<SpanKind, number>();
    let working = 0;
    let tools = 0;
    let modelCalls = 0;
    let input = 0;
    let output = 0;
    let first: number | null = null;
    let last: number | null = null;
    for (const { turn, spans, totalMs } of derived) {
      working += turn.endedAt && turn.triggerTs ? Math.max(0, turn.endedAt - turn.triggerTs) : totalMs;
      for (const s of spans) {
        const kind = FAMILY_KIND[s.family];
        if (s.durationMs > 0) byKind.set(kind, (byKind.get(kind) ?? 0) + s.durationMs);
        if (s.family === "tool" || s.family === "custom_tool" || s.family === "mcp") tools += 1;
      }
      const t = turnTokens(turn.events);
      modelCalls += t.calls;
      input += t.input;
      output += t.output;
      for (const e of turn.events) {
        const at = eventTime(e);
        if (at == null) continue;
        if (first == null || at < first) first = at;
        if (last == null || at > last) last = at;
      }
    }
    return { byKind, working, tools, modelCalls, input, output, elapsed: first != null && last != null ? last - first : 0 };
  }, [derived]);

  const mix = MIX_ORDER.map((kind) => ({ kind, ms: stats.byKind.get(kind) ?? 0 })).filter((m) => m.ms > 0);
  const mixTotal = mix.reduce((n, m) => n + m.ms, 0);

  return (
    <section aria-label="Timeline summary" className="surface rounded-xl px-5 py-4">
      <dl className="flex flex-wrap gap-x-10 gap-y-3">
        <SummaryStat label="Elapsed" hint="First event to last">
          {formatElapsed(stats.elapsed) || "0s"}
        </SummaryStat>
        <SummaryStat label="Working" hint="Time inside turns; waits between turns are left out">
          {formatElapsed(stats.working) || "0s"}
        </SummaryStat>
        <SummaryStat label="Turns">{derived.length.toLocaleString()}</SummaryStat>
        <SummaryStat label="Model calls">{stats.modelCalls.toLocaleString()}</SummaryStat>
        <SummaryStat label="Tool calls">{stats.tools.toLocaleString()}</SummaryStat>
        <SummaryStat label="Tokens" hint={`${stats.input.toLocaleString()} in · ${stats.output.toLocaleString()} out`}>
          {formatCompact(stats.input + stats.output)}
        </SummaryStat>
      </dl>
      {mixTotal > 0 && (
        <div className="mt-4">
          <div
            className="flex h-2 gap-0.5 overflow-hidden rounded-full"
            role="img"
            aria-label={`Where the time went: ${mix.map((m) => `${KIND_LABEL[m.kind]} ${Math.round((100 * m.ms) / mixTotal)}%`).join(", ")}`}
          >
            {mix.map((m) => (
              <span
                key={m.kind}
                className="h-full min-w-1 rounded-full"
                style={{ width: `${(100 * m.ms) / mixTotal}%`, backgroundColor: KIND_COLOR[m.kind] }}
              />
            ))}
          </div>
          <ChartLegend
            className="mt-2.5"
            items={mix.map((m) => ({ label: KIND_LABEL[m.kind], color: KIND_COLOR[m.kind], value: formatElapsed(m.ms) }))}
          />
        </div>
      )}
    </section>
  );
}

function SummaryStat({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  const body = (
    <div className="min-w-[4.5rem]">
      <dt className="text-xs text-fg-subtle">{label}</dt>
      <dd className="mt-0.5 text-h2 text-fg tabular-nums">{children}</dd>
    </div>
  );
  return hint ? <Tip label={hint}>{body}</Tip> : body;
}

function IdleDivider({ ms, nextKind }: { ms: number; nextKind: TurnTriggerKind }) {
  return (
    <div className="flex items-center justify-center gap-1.5 py-0.5 text-xs text-fg-subtle">
      <MoonIcon className="size-3.5" />
      Idle for {formatElapsed(ms)}
      {nextKind === "wakeup" && ", then woke on schedule"}
    </div>
  );
}

// ── one turn ────────────────────────────────────────────────────────────

const TRIGGER_ICON: Record<TurnTriggerKind, ComponentType<{ className?: string }>> = {
  user_message: UserRoundIcon,
  wakeup: AlarmClockIcon,
  tool_confirmation: ShieldAlertIcon,
  custom_tool_result: CircleDotIcon,
  init: CircleDotIcon,
};

function spanIcon(span: Span): ComponentType<{ className?: string }> {
  switch (span.family) {
    case "model":
    case "aux":
    case "outcome":
      return SparklesIcon;
    case "tool":
    case "custom_tool":
    case "mcp":
      // A hand-off to another agent, already in words ("Asked PR Reviewer").
      if (span.plain) return UsersRoundIcon;
      return presentTool({
        name: span.label,
        flavor: span.family === "mcp" ? "mcp" : "tool",
        server: span.family === "mcp" ? span.source : undefined,
        input: {},
      }).icon;
    case "user":
      return UserRoundIcon;
    case "agent":
      return MessageSquareIcon;
    case "thinking":
      return LightbulbIcon;
    case "schedule":
    case "wakeup":
      return AlarmClockIcon;
    case "approval":
      return ShieldAlertIcon;
    case "error":
    case "warn":
      return CircleAlertIcon;
    default:
      return CircleDotIcon;
  }
}

const isToolSpan = (s: Span) => s.family === "tool" || s.family === "custom_tool" || s.family === "mcp";

/** Axis labels share one precision: whole seconds once the step is a second or more ("5s", not "5.0s"). */
function formatTick(ms: number, step: number): string {
  if (ms === 0) return "0";
  if (step >= 1000 && ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return formatElapsed(ms);
}

/**
 * One turn as a card: what started it, how it went, and a waterfall of
 * every step on the turn's own time scale. The scale starts fitted to the
 * card; zoom in to pull short steps apart (the chart then scrolls sideways
 * with the labels pinned).
 */
function TurnCard({
  turn,
  index,
  spans,
  totalMs,
  senderName,
  selectedKey,
  onSelectSpan,
}: {
  turn: Turn;
  index: number;
  spans: Span[];
  totalMs: number;
  /** Replaces "You" as the sender of a message-triggered turn. */
  senderName?: string;
  selectedKey: string | null;
  onSelectSpan: (span: Span) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [measureRef, width] = useMeasure<HTMLDivElement>();
  const [mode, setMode] = useState<"fit" | "auto" | "manual">("fit");
  const [manual, setManual] = useState<number | null>(null);

  const viewportChartPx = Math.max(160, width - LABEL_COL_W - DURATION_COL_W - 24);
  const fitPxPerMs = totalMs > 0 ? viewportChartPx / totalMs : 1;

  // "Auto" scales by event density: the median gap between consecutive
  // events is drawn ~28px wide, so bursts of short steps separate.
  const autoPxPerMs = useMemo(() => {
    const times: number[] = [];
    for (const s of spans) {
      times.push(s.startMs);
      if (s.durationMs > 0) times.push(s.startMs + s.durationMs);
    }
    times.sort((a, b) => a - b);
    const gaps: number[] = [];
    for (let i = 1; i < times.length; i++) {
      const g = times[i] - times[i - 1];
      if (g > 0) gaps.push(g);
    }
    if (gaps.length === 0) return fitPxPerMs;
    gaps.sort((a, b) => a - b);
    const median = gaps[Math.floor(gaps.length / 2)] || 1;
    return Math.min(5, Math.max(28 / median, fitPxPerMs));
  }, [spans, fitPxPerMs]);

  const pxPerMs = mode === "fit" ? fitPxPerMs : mode === "auto" ? autoPxPerMs : (manual ?? fitPxPerMs);
  const chartPx = Math.max(viewportChartPx, Math.round(totalMs * pxPerMs));
  const zoomBy = (factor: number) => {
    setManual(Math.min(50, Math.max(fitPxPerMs, pxPerMs * factor)));
    setMode("manual");
  };

  // Ticks ~110px apart at the current scale.
  const tickStep = pickTickStep((110 / pxPerMs) * 6);
  const ticks: number[] = [];
  for (let t = 0; t <= totalMs + tickStep * 0.001 && ticks.length < 400; t += tickStep) ticks.push(t);

  const tokens = useMemo(() => turnTokens(turn.events), [turn.events]);
  const turnDurationMs = turn.endedAt && turn.triggerTs ? turn.endedAt - turn.triggerTs : totalMs;
  const quote = turn.trigger ? eventText(turn.trigger).replace(/\s+/g, " ").trim() || null : null;
  const TriggerIcon = TRIGGER_ICON[turn.triggerKind];
  const steps = spans.length;

  return (
    <section className="surface overflow-hidden rounded-xl" aria-label={`Turn ${index + 1}`}>
      <header className="flex h-12 items-center gap-2.5 pr-3 pl-2">
        <Tip label={collapsed ? "Show steps" : "Hide steps"}>
          <button
            type="button"
            aria-expanded={!collapsed}
            aria-label={collapsed ? "Show steps" : "Hide steps"}
            onClick={() => setCollapsed((c) => !c)}
            className="flex size-8 shrink-0 items-center justify-center rounded-full text-fg-subtle transition-quick hover:bg-bg-hover hover:text-fg"
          >
            <ChevronDownIcon
              className={cn("size-4 transition-transform duration-[var(--dur-base)] ease-[var(--ease-rise)]", collapsed && "-rotate-90")}
            />
          </button>
        </Tip>
        <span className="flex size-6 shrink-0 items-center justify-center rounded-[7px] bg-bg-soft text-fg-muted">
          <TriggerIcon className="size-3.5" />
        </span>
        <p className="flex min-w-0 flex-1 items-baseline gap-2 text-small">
          <span className="shrink-0 font-medium text-fg">{turn.triggerKind === "user_message" && senderName ? senderName : TRIGGER_LABEL[turn.triggerKind]}</span>
          {quote && (
            <span className="min-w-0 truncate text-fg-muted" title={quote}>
              {quote}
            </span>
          )}
        </p>
        <div className="flex shrink-0 items-center gap-3 text-xs text-fg-subtle tabular-nums">
          <span className="hidden md:inline">
            {steps} {steps === 1 ? "step" : "steps"}
          </span>
          {tokens.calls > 0 && (
            <Tip
              label={`${tokens.calls} model ${tokens.calls === 1 ? "call" : "calls"} · ${tokens.input.toLocaleString()} tokens in, ${tokens.output.toLocaleString()} out`}
            >
              <span className="hidden lg:inline">
                {formatCompact(tokens.input)} in · {formatCompact(tokens.output)} out
              </span>
            </Tip>
          )}
          <span className="font-medium text-fg">{formatElapsed(turnDurationMs) || "0s"}</span>
          {turn.status === "awaiting_client" ? (
            <StatusBadge status="idle" label="Waiting for the app" className="text-xs" />
          ) : (
            <StatusBadge status={turn.status} className="text-xs" />
          )}
        </div>
        {!collapsed && steps > 0 && totalMs > 1 && (
          <ZoomControls
            mode={mode}
            onZoomOut={() => zoomBy(0.5)}
            onZoomIn={() => zoomBy(2)}
            onFit={() => setMode("fit")}
            onAuto={() => setMode("auto")}
            canZoomOut={pxPerMs > fitPxPerMs * 1.01}
          />
        )}
      </header>

      {!collapsed && steps > 0 && (
        <div ref={measureRef} className="border-t border-border">
          <div className="overflow-x-auto pb-2">
            <div style={{ width: LABEL_COL_W + chartPx + DURATION_COL_W }} className="relative">
              {/* time axis */}
              <div className="flex h-8 items-end">
                <div className="sticky left-0 z-10 h-full shrink-0 bg-bg-surface" style={{ width: LABEL_COL_W }} />
                <div className="relative h-full shrink-0" style={{ width: chartPx }}>
                  {ticks.map((t) => (
                    <span
                      key={t}
                      className={cn(
                        "absolute bottom-1.5 text-micro font-normal whitespace-nowrap text-fg-subtle tabular-nums",
                        t === 0 ? "translate-x-0" : "-translate-x-1/2",
                      )}
                      style={{ left: t * pxPerMs }}
                    >
                      {formatTick(t, tickStep)}
                    </span>
                  ))}
                </div>
                <div className="sticky right-0 z-10 h-full shrink-0 bg-bg-surface" style={{ width: DURATION_COL_W }} />
              </div>

              {/* grid lines run behind every row */}
              <div aria-hidden="true" className="pointer-events-none absolute top-8 bottom-0" style={{ left: LABEL_COL_W, width: chartPx }}>
                {ticks.map((t) => (
                  <span key={t} className="absolute inset-y-0 w-px" style={{ left: t * pxPerMs, backgroundColor: "var(--chart-grid)" }} />
                ))}
              </div>

              {spans.map((s) => (
                <SpanRow
                  key={s.key}
                  turnId={turn.id}
                  span={s}
                  pxPerMs={pxPerMs}
                  chartPx={chartPx}
                  selected={selectedKey === s.key}
                  onClick={() => onSelectSpan(s)}
                />
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function SpanRow({
  turnId,
  span,
  pxPerMs,
  chartPx,
  selected,
  onClick,
}: {
  turnId: string;
  span: Span;
  pxPerMs: number;
  chartPx: number;
  selected: boolean;
  onClick: () => void;
}) {
  const kind = FAMILY_KIND[span.family];
  const color = span.failed ? KIND_COLOR.error : KIND_COLOR[kind];
  const Icon = spanIcon(span);
  const left = Math.min(span.startMs * pxPerMs, chartPx - 4);
  const barW = span.durationMs > 0 ? Math.max(4, span.durationMs * pxPerMs) : 0;
  const ttftW = typeof span.ttftMs === "number" && span.durationMs > 0 ? Math.min(barW, span.ttftMs * pxPerMs) : 0;
  const mono = isToolSpan(span) && !span.plain;
  const quiet = kind === "system";
  // Sticky cells need an opaque fill; the hover/selected tint is layered on top.
  const cell = cn(
    "sticky z-10 flex h-full shrink-0 items-center bg-bg-surface before:absolute before:inset-0 before:transition-colors before:duration-100",
    selected ? "before:bg-bg-pressed" : "group-hover/row:before:bg-bg-hover",
  );
  return (
    <Tip
      delay={500}
      side="top"
      align="start"
      label={
        <span className="block">
          <span className="block font-medium">
            {span.source ? `${span.source} · ` : ""}
            {span.label}
          </span>
          <span className="block opacity-80">
            Starts at {formatElapsed(span.startMs) || "0s"}
            {span.durationMs > 0 ? ` · takes ${formatElapsed(span.durationMs)}` : ""}
          </span>
          {span.detail && <span className="block max-w-[320px] truncate opacity-80">{span.detail}</span>}
        </span>
      }
    >
      <button
        type="button"
        data-span-key={`${turnId}:${span.key}`}
        aria-pressed={selected}
        onClick={onClick}
        className={cn(
          "group/row relative flex w-full items-center text-left transition-colors duration-100 focus-visible:z-20 focus-visible:-outline-offset-2",
          selected ? "bg-bg-pressed" : "hover:bg-bg-hover",
        )}
        style={{ height: ROW_H }}
      >
        <span className={cn(cell, "left-0 gap-2 pr-3 pl-5")} style={{ width: LABEL_COL_W }}>
          <Icon className={cn("relative size-3.5 shrink-0", span.failed ? "text-danger" : quiet ? "text-fg-faint" : "text-fg-subtle")} />
          <span className="relative flex min-w-0 items-baseline gap-1.5">
            <span className={cn("shrink-0 text-xs", quiet ? "text-fg-subtle" : "font-medium text-fg")}>
              {span.source && <span className="font-normal text-fg-muted">{span.source} · </span>}
              <span className={cn(mono && "font-mono")}>{span.label}</span>
            </span>
            {span.detail && (
              <span className={cn("min-w-0 truncate text-micro font-normal", span.failed ? "text-danger" : "text-fg-subtle")}>{span.detail}</span>
            )}
          </span>
        </span>
        <span className="relative h-full shrink-0" style={{ width: chartPx }}>
          {barW > 0 ? (
            <span className="absolute top-1/2 h-2 -translate-y-1/2 overflow-hidden rounded-full" style={{ left, width: barW, backgroundColor: color }}>
              {/* waiting for the first token reads lighter than generating */}
              {ttftW > 0 && <span className="absolute inset-y-0 left-0 bg-bg-surface/55" style={{ width: ttftW }} />}
            </span>
          ) : (
            <span
              className={cn("absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full", quiet ? "size-1.5" : "size-2")}
              style={{ left: Math.max(left, 4), backgroundColor: color }}
            />
          )}
        </span>
        <span className={cn(cell, "right-0 justify-end pr-5 text-xs text-fg-muted tabular-nums")} style={{ width: DURATION_COL_W }}>
          <span className="relative">{span.durationMs > 0 ? formatElapsed(span.durationMs) : ""}</span>
        </span>
      </button>
    </Tip>
  );
}

function ZoomControls({
  mode,
  onZoomOut,
  onZoomIn,
  onFit,
  onAuto,
  canZoomOut,
}: {
  mode: "fit" | "auto" | "manual";
  onZoomOut: () => void;
  onZoomIn: () => void;
  onFit: () => void;
  onAuto: () => void;
  canZoomOut: boolean;
}) {
  const seg = (active: boolean) =>
    cn(
      "inline-flex h-full items-center rounded-full px-2.5 text-xs font-medium transition-quick",
      active ? "bg-bg-surface text-fg shadow-[var(--shadow-xs)] dark:bg-bg-pressed" : "text-fg-muted hover:text-fg",
    );
  const icon =
    "inline-flex size-7 items-center justify-center rounded-full text-fg-muted transition-quick hover:bg-bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-40";
  return (
    <div className="ml-1 hidden shrink-0 items-center gap-0.5 sm:flex" role="group" aria-label="Time scale">
      <Tip label="Zoom out">
        <button type="button" aria-label="Zoom out" onClick={onZoomOut} disabled={!canZoomOut} className={icon}>
          <MinusIcon className="size-3.5" />
        </button>
      </Tip>
      <div className="inline-flex h-7 items-center rounded-full bg-bg-soft p-0.5">
        <Tip label="Fit the whole turn in view">
          <button type="button" aria-label="Fit turn duration to viewport" aria-pressed={mode === "fit"} onClick={onFit} className={seg(mode === "fit")}>
            Fit
          </button>
        </Tip>
        <Tip label="Spread steps apart by how densely they happen">
          <button
            type="button"
            aria-label="Auto-pick scale by event density"
            aria-pressed={mode === "auto"}
            onClick={onAuto}
            className={seg(mode === "auto")}
          >
            Auto
          </button>
        </Tip>
      </div>
      <Tip label="Zoom in">
        <button type="button" aria-label="Zoom in" onClick={onZoomIn} className={icon}>
          <PlusIcon className="size-3.5" />
        </button>
      </Tip>
    </div>
  );
}

// ── inspector ───────────────────────────────────────────────────────────

/** Rebuild the conversation's tool-call shape from a span's source events. */
function toolCallOf(span: Span): ToolCall | null {
  const use = span.events.find((e) => e.type === "agent.tool_use" || e.type === "agent.custom_tool_use" || e.type === "agent.mcp_tool_use");
  if (!use) return null;
  const result = span.events.find(
    (e) => e.type === "agent.tool_result" || e.type === "agent.mcp_tool_result" || e.type === "user.custom_tool_result",
  );
  const isError = isErrorResult(result);
  return {
    key: span.key,
    id: typeof use.id === "string" ? use.id : undefined,
    ...readToolUse(use),
    use,
    result,
    output: resultText(result),
    isError,
    status: result
      ? isError
        ? "errored"
        : "completed"
      : span.detail === "denied"
        ? "denied"
        : span.detail === "waiting for the app's result"
          ? "waiting"
          : undefined,
    startedAt: eventTime(use),
    durationMs: span.durationMs,
  };
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-7 items-center justify-between gap-4 text-small">
      <dt className="shrink-0 text-fg-subtle">{label}</dt>
      <dd className="min-w-0 truncate text-right text-fg tabular-nums">{children}</dd>
    </div>
  );
}

/**
 * The step inspector. It stays open beside the waterfall (no scrim), so
 * rows remain clickable and the arrows step through them in order.
 */
function Inspector({
  span,
  position,
  onPrev,
  onNext,
  onClose,
}: {
  span: Span;
  position?: string;
  onPrev?: () => void;
  onNext?: () => void;
  onClose: () => void;
}) {
  const kind = FAMILY_KIND[span.family];
  const Icon = spanIcon(span);
  const call = isToolSpan(span) || span.family === "approval" ? toolCallOf(span) : null;
  const end = span.events.find((e) => e.type === "span.model_request_end");
  const usage = end
    ? ((end as { model_usage?: Record<string, number> }).model_usage ??
      (end.data as { model_usage?: Record<string, number> } | undefined)?.model_usage)
    : undefined;
  const model = span.events.map((e) => (e as { model?: unknown }).model).find((m): m is string => typeof m === "string");
  const finish = end
    ? ((end as { finish_reason?: string }).finish_reason ?? (end.data as { finish_reason?: string } | undefined)?.finish_reason)
    : undefined;
  const errorMessage = end ? (end as { error_message?: string }).error_message : undefined;
  const first = span.events[0];
  const prose = first && (first.type === "agent.message" || first.type === "user.message") ? eventText(first) : "";
  const thought = first?.type === "agent.thinking" ? String((first as { text?: unknown }).text ?? "") : "";
  const failure = first?.type === "session.error" ? String((first as { message?: unknown }).message ?? first.error ?? "") : "";

  return (
    <aside
      aria-label="Step details"
      className="flex min-h-0 shrink-0 animate-fade-in flex-col border-l border-border bg-bg"
      style={{ width: `min(${SIDE_PANEL_W}px, 46%)` }}
    >
      <header className="flex items-start gap-3 px-5 pt-4 pb-3">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-bg-soft text-fg-muted">
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-xs text-fg-subtle">
            <span
              aria-hidden="true"
              className="size-2 rounded-full"
              style={{ backgroundColor: span.failed ? KIND_COLOR.error : KIND_COLOR[kind] }}
            />
            {KIND_LABEL[kind]}
            {position && <span className="text-fg-faint">· {position}</span>}
          </p>
          <h2 className="mt-0.5 truncate text-h3 text-fg" title={span.label}>
            {span.source && <span className="font-normal text-fg-muted">{span.source} · </span>}
            <span className={cn(isToolSpan(span) && !span.plain && "font-mono text-sm")}>{span.label}</span>
          </h2>
        </div>
        <div className="-mr-2 flex shrink-0 items-center">
          <Tip label="Previous step">
            <Button variant="ghost" size="icon-sm" aria-label="Previous step" disabled={!onPrev} onClick={onPrev}>
              <ChevronLeftIcon />
            </Button>
          </Tip>
          <Tip label="Next step">
            <Button variant="ghost" size="icon-sm" aria-label="Next step" disabled={!onNext} onClick={onNext}>
              <ChevronRightIcon />
            </Button>
          </Tip>
          <Tip label="Close">
            <Button variant="ghost" size="icon-sm" aria-label="Close panel" onClick={onClose}>
              <XIcon />
            </Button>
          </Tip>
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 pb-8">
        <dl>
          <Fact label="Starts at">{formatElapsed(span.startMs) || "0s"} into the turn</Fact>
          <Fact label="Duration">{span.durationMs > 0 ? formatElapsed(span.durationMs) : <span className="text-fg-subtle">Instant</span>}</Fact>
          {typeof span.ttftMs === "number" && <Fact label="First token after">{formatElapsed(span.ttftMs)}</Fact>}
          {model && (
            <Fact label="Model">
              <ModelBadge model={model} variant="plain" />
            </Fact>
          )}
          {usage && (
            <>
              <Fact label="Input tokens">{(usage.input_tokens ?? 0).toLocaleString()}</Fact>
              {(usage.cache_read_input_tokens ?? 0) > 0 && <Fact label="Read from cache">{usage.cache_read_input_tokens.toLocaleString()}</Fact>}
              {(usage.cache_creation_input_tokens ?? 0) > 0 && (
                <Fact label="Written to cache">{usage.cache_creation_input_tokens.toLocaleString()}</Fact>
              )}
              <Fact label="Output tokens">{(usage.output_tokens ?? 0).toLocaleString()}</Fact>
            </>
          )}
          {finish && <Fact label="Finished with">{finish.replace(/[-_]/g, " ")}</Fact>}
          {span.family === "approval" && span.detail && <Fact label="Decision">{span.detail.replace(/^./, (c) => c.toUpperCase())}</Fact>}
        </dl>

        {call && (
          <div className="space-y-3">
            <ToolBody call={call} />
          </div>
        )}
        {prose && (
          <div>
            <p className="mb-1.5 text-xs font-medium text-fg-subtle">{first.type === "user.message" ? "Message" : "Reply"}</p>
            <div className="text-small leading-relaxed text-fg">
              {first.type === "user.message" ? <p className="break-words whitespace-pre-wrap">{prose}</p> : <Markdown>{prose}</Markdown>}
            </div>
          </div>
        )}
        {thought && (
          <div>
            <p className="mb-1.5 text-xs font-medium text-fg-subtle">Reasoning</p>
            <p className="text-small leading-relaxed whitespace-pre-wrap text-fg-muted">{thought}</p>
          </div>
        )}
        {(failure || errorMessage) && (
          <div>
            <p className="mb-1.5 text-xs font-medium text-fg-subtle">Error</p>
            <CodeWell tone="danger">{errorMessage || failure}</CodeWell>
          </div>
        )}

        <div>
          <p className="mb-1.5 text-xs font-medium text-fg-subtle">
            {span.events.length === 1 ? "Source event" : `Source events · ${span.events.length}`}
          </p>
          <div className="space-y-1.5">
            {span.events.map((ev, i) => {
              const json = JSON.stringify(ev, null, 2);
              const at = eventTime(ev);
              return (
                <Disclosure
                  key={`${span.key}-${i}`}
                  title={<span className="font-mono text-xs font-normal">{ev.type}</span>}
                  meta={at != null ? new Date(at).toISOString().slice(11, 23) : undefined}
                >
                  <div className="relative">
                    <CodeWell className="max-h-80 pr-9">{json}</CodeWell>
                    <CopyButton value={json} label="Copy JSON" className="absolute top-1.5 right-1.5" />
                  </div>
                </Disclosure>
              );
            })}
          </div>
        </div>
      </div>
    </aside>
  );
}
