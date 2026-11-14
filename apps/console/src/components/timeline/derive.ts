import { parseSearchMcpTools } from "../../lib/deferred-mcp";
import { formatCompact } from "../../lib/format";
import type { Event } from "../../lib/events";
import { buildToolCallIndex, isErrorResult } from "../../lib/tool-status";
import { eventTime, formatElapsed, handoffKey, handoffKeyOf, readToolUse } from "../sessions/model";
import { serverInfo } from "../sessions/tools";
import type { Span, Turn, TurnTriggerKind } from "./types";

/**
 * Derive a flat list of waterfall spans from a session's event stream.
 *
 * One row per logical "thing that happened" — model call, tool call,
 * scheduled wait, agent message, etc. Paired events (start + end) become
 * a single span with duration; instant events become zero-duration
 * markers. Each span carries its source events so the side detail panel
 * can show the underlying JSON without re-walking the stream.
 *
 * timestamp basis is `processed_at` (millisecond ISO string set by
 * SessionDO at write time). The legacy `ts` field is unix SECONDS and
 * collapses sub-second events together — only used as a fallback for
 * very old sessions that predate processed_at.
 */
export function deriveSpans(
  events: Event[],
  /**
   * The wider log (the whole thread) a call's fate is read from. A call
   * asked in one turn is answered in the next (the decision, a custom
   * tool's result), so one turn's own events cannot tell "still waiting"
   * from "denied". Bars and times always come from `events` alone.
   */
  statusContext: Event[] = events,
): { spans: Span[]; totalMs: number } {
  // One clock for the whole session view: `processed_at` (ms ISO) first,
  // then the numeric `ts` (ms on Node, seconds on Cloudflare).
  const tsMs = eventTime;

  const timed = events.map((e) => ({ e, t: tsMs(e) })).filter((x): x is { e: Event; t: number } => x.t !== null);
  if (timed.length === 0) return { spans: [], totalMs: 0 };

  const t0 = timed[0].t;
  const tEnd = timed[timed.length - 1].t;
  const totalMs = Math.max(1, tEnd - t0);

  const spans: Span[] = [];

  // Index look-ahead pairings. O(1) instead of nested scans. Each map
  // stores both timestamp (for span math) and the source Event (for
  // click-to-expand JSON inspection).
  const toolResults = new Map<string, { t: number; e: Event }>();
  const mcpResults = new Map<string, { t: number; e: Event }>();
  const customResults = new Map<string, { t: number; e: Event }>();
  // model_request_start_id → end's timestamp + usage. Anthropic's wire
  // format pairs the per-call span pair this way (rather than positional
  // FIFO), so multiple parallel or nested model calls stay correctly
  // associated. FIFO fallback below for events that predate the field.
  const modelEndsById = new Map<string, { t: number; e: Event; usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }; finishReason?: string }>();
  const modelEndsFifo: { t: number; e: Event; usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }; finishReason?: string }[] = [];
  // OMA-extension span — pairs to model_request_start the same way the end
  // does. Lets the model bar split into TTFT (start→first_token) and
  // generation (first_token→end). FIFO fallback for events without ids.
  const modelFirstTokensById = new Map<string, { t: number; e: Event }>();
  const modelFirstTokensFifo: { t: number; e: Event }[] = [];
  const compactEnds: { t: number; e: Event }[] = [];
  const outcomeEnds: { t: number; e: Event }[] = [];
  // parent_event_id → child {t, event}. Used to pair span.wakeup_scheduled
  // (parent) with its eventual user.message (child) — same EventBase field
  // tool_result→tool_use uses, so this generalizes to any future
  // schedule→fire / outcome→eval / etc. causal pair without needing
  // custom id fields per kind.
  const childByParent = new Map<string, { t: number; e: Event }>();
  // tool_use_id → the person's decision, for calls that had to ask first.
  const confirmations = new Map<string, { t: number; e: Event }>();
  // The same, from the wider log: a decision made after this turn ended.
  const laterDecisions = new Map<string, Event>();
  for (const e of statusContext) {
    if (e.type === "user.tool_confirmation" && e.tool_use_id) laterDecisions.set(e.tool_use_id, e);
  }
  const fate = buildToolCallIndex(statusContext);
  for (const { e, t } of timed) {
    if (e.type === "user.tool_confirmation" && e.tool_use_id) confirmations.set(e.tool_use_id, { t, e });
    if (e.type === "agent.tool_result" && e.tool_use_id) toolResults.set(e.tool_use_id, { t, e });
    else if (e.type === "agent.mcp_tool_result" && e.mcp_tool_use_id) mcpResults.set(e.mcp_tool_use_id, { t, e });
    else if (e.type === "user.custom_tool_result") {
      // Keyed by the call it answers, not by its own id.
      const cid = (e as { custom_tool_use_id?: unknown }).custom_tool_use_id;
      if (typeof cid === "string") customResults.set(cid, { t, e });
    }
    else if (e.type === "span.model_request_end") {
      const data = (e.data as { model_request_start_id?: string; model_usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }; finish_reason?: string } | undefined);
      const sid = (e as { model_request_start_id?: string }).model_request_start_id ?? data?.model_request_start_id;
      const entry = { t, e, usage: data?.model_usage, finishReason: data?.finish_reason };
      modelEndsFifo.push(entry);
      if (sid) modelEndsById.set(sid, entry);
    }
    else if (e.type === "span.model_first_token") {
      modelFirstTokensFifo.push({ t, e });
      const data = (e.data as { model_request_start_id?: string } | undefined);
      const sid = (e as { model_request_start_id?: string }).model_request_start_id ?? data?.model_request_start_id;
      if (sid) modelFirstTokensById.set(sid, { t, e });
    }
    else if (e.type === "span.compaction_summarize_end") compactEnds.push({ t, e });
    else if (e.type === "span.outcome_evaluation_end") outcomeEnds.push({ t, e });
    const pid = (e as { parent_event_id?: string }).parent_event_id
      ?? (e.data as { parent_event_id?: string } | undefined)?.parent_event_id;
    if (pid) childByParent.set(pid, { t, e });
  }

  // Who a hand-off went to: the runtime names the tool after the agent's id
  // (`call_agent_agent_rrtc…`); the thread it starts carries the name.
  const handoffNames = new Map<string, string>();
  for (const { e } of timed) {
    const started = e as { agent_id?: unknown; agent_name?: unknown };
    if (e.type === "session.thread_created" && typeof started.agent_id === "string" && typeof started.agent_name === "string") {
      handoffNames.set(handoffKeyOf(started.agent_id), started.agent_name);
    }
  }

  // FIFO fallback indices for events that lack id-based pairing.
  let modelEndFifoIdx = 0;
  let modelFirstTokenFifoIdx = 0;
  let compactEndIdx = 0;
  let outcomeEndIdx = 0;

  // Streaming chunks (deltas + start/end markers from incremental
  // rendering) are broadcast-only; the canonical event (agent.message /
  // agent.thinking) lands on commit and is what timeline should show.
  const STREAMING_NOISE = new Set([
    "agent.message_chunk",
    "agent.message_stream_start",
    "agent.message_stream_end",
    "agent.thinking_chunk",
    "agent.thinking_stream_start",
    "agent.thinking_stream_end",
    "agent.tool_use_input_chunk",
    "agent.tool_use_input_stream_start",
    "agent.tool_use_input_stream_end",
  ]);

  for (let i = 0; i < timed.length; i++) {
    const { e, t } = timed[i];
    const startMs = t - t0;

    if (STREAMING_NOISE.has(e.type)) continue;

    const sourceEvents: Event[] = [e];
    const pushSpan = (span: Omit<Span, "events">) => spans.push({ ...span, events: sourceEvents });

    if (e.type === "agent.tool_use" || e.type === "agent.custom_tool_use" || e.type === "agent.mcp_tool_use") {
      const id = String(e.id ?? "");
      // A custom tool is closed by the runtime's agent.tool_result too; the
      // app's own user.custom_tool_result is the fallback.
      const result =
        e.type === "agent.mcp_tool_use"
          ? mcpResults.get(id)
          : (toolResults.get(id) ?? (e.type === "agent.custom_tool_use" ? customResults.get(id) : undefined));
      const status = fate.info(id || undefined).status;
      // A call that had to ask first: the wait for a person is its own
      // span, and the tool only starts running once they answered.
      const decision = confirmations.get(id);
      const later = decision ? undefined : laterDecisions.get(id);
      const asked =
        (e as { evaluated_permission?: string }).evaluated_permission === "ask" || !!decision || !!later || status === "awaiting_approval";
      let runStartMs = startMs;
      // A denied call never ran; its error result is the runtime's note of the denial.
      const denied = ((decision?.e ?? later) as { result?: string } | undefined)?.result === "deny" || status === "denied";
      if (asked && (decision || later || !result)) {
        // Decided in a later turn: this turn waited on it until it closed.
        const decidedMs = decision ? decision.t - t0 : later ? tEnd - t0 : startMs;
        const verdict = (decision?.e ?? later) as { result?: string } | undefined;
        spans.push({
          key: `approval-${e.id ?? i}`,
          family: "approval",
          label: "Waiting for approval",
          detail: verdict ? (verdict.result === "deny" ? "denied" : "allowed") : status === "awaiting_approval" ? "still waiting" : "never answered",
          startMs,
          durationMs: Math.max(0, decidedMs - startMs),
          events: decision ? [e, decision.e] : later ? [e, later] : [e],
        });
        runStartMs = decidedMs;
      }
      const endMs = result ? result.t - t0 : runStartMs;
      if (result) sourceEvents.push(result.e);
      // A bash result that reports a non-zero exit failed, whatever its is_error says.
      const failed = !denied && !!result && isErrorResult(result.e);
      const call = readToolUse(e);
      const handoff = handoffKey(call.name);
      const search = call.flavor === "tool" ? parseSearchMcpTools(call.name, call.input) : null;
      const where = search?.server ? serverInfo(search.server).label : null;
      pushSpan({
        key: `${e.type === "agent.mcp_tool_use" ? "mcp" : "tool"}-${e.id ?? i}`,
        // A deferred MCP call (call_mcp_tool) reads as the app call it is.
        family: call.flavor === "mcp" ? "mcp" : call.flavor === "custom" ? "custom_tool" : "tool",
        source: call.flavor === "mcp" ? serverInfo(call.server).label : undefined,
        label: handoff
          ? `Asked ${handoffNames.get(handoff) ?? "another agent"}`
          : search
            ? `Searched ${where ?? "all"} tools for “${search.query}”`
            : call.name,
        plain: !!handoff || !!search || undefined,
        detail: denied
          ? "denied"
          : result
            ? failed
              ? "failed"
              : undefined
            : status === "awaiting_client"
              ? "waiting for the app's result"
              : asked && !decision && !later
                ? "not run yet"
                : "no result",
        failed,
        startMs: runStartMs,
        durationMs: Math.max(0, endMs - runStartMs),
      });
    } else if (
      e.type === "agent.tool_result" ||
      e.type === "agent.mcp_tool_result" ||
      e.type === "user.custom_tool_result"
    ) {
      // consumed via pairing above — no row
      continue;
    } else if (e.type === "span.model_request_start") {
      // One pair per ai-sdk step (= one model API call). Pair via the
      // start event id; old data without ids falls back to FIFO order.
      const sid = String((e as { id?: string }).id ?? (e.data as { id?: string } | undefined)?.id ?? "");
      const matched = sid ? modelEndsById.get(sid) : (modelEndsFifo[modelEndFifoIdx++] ?? undefined);
      const ftMatch = sid ? modelFirstTokensById.get(sid) : (modelFirstTokensFifo[modelFirstTokenFifoIdx++] ?? undefined);
      const end = matched?.t ?? t;
      const usage = matched?.usage;
      if (matched?.e) sourceEvents.push(matched.e);
      if (ftMatch?.e) sourceEvents.push(ftMatch.e);
      const tokSummary = usage
        ? `${formatCompact(usage.input_tokens)} in · ${formatCompact(usage.output_tokens)} out`
        : undefined;
      const ttftMs = ftMatch ? Math.max(0, ftMatch.t - t) : undefined;
      const ttftSummary = typeof ttftMs === "number" ? `first token ${formatElapsed(ttftMs)}` : undefined;
      const modelFailed = matched?.finishReason === "error";
      pushSpan({
        key: `model-${sid || i}`,
        family: "model",
        label: "Model call",
        detail: [modelFailed ? "failed" : undefined, tokSummary, ttftSummary].filter(Boolean).join(" · ") || undefined,
        failed: modelFailed,
        startMs,
        durationMs: Math.max(0, end - t0 - startMs),
        ttftMs,
      });
    } else if (e.type === "span.compaction_summarize_start") {
      const matched = compactEnds[compactEndIdx++];
      const end = matched?.t ?? t;
      if (matched?.e) sourceEvents.push(matched.e);
      pushSpan({
        key: `compact-${i}`,
        family: "compaction",
        label: "Context compaction",
        startMs,
        durationMs: Math.max(0, end - t0 - startMs),
      });
    } else if (e.type === "span.outcome_evaluation_start") {
      const matched = outcomeEnds[outcomeEndIdx++];
      const end = matched?.t ?? t;
      if (matched?.e) sourceEvents.push(matched.e);
      pushSpan({
        key: `outcome-${i}`,
        family: "outcome",
        label: "Outcome evaluation",
        startMs,
        durationMs: Math.max(0, end - t0 - startMs),
      });
    } else if (e.type === "user.tool_confirmation") {
      continue; // folded into the approval span
    } else if (e.type === "user.interrupt") {
      pushSpan({ key: `stop-${i}`, family: "system", label: "Stopped by you", startMs, durationMs: 0 });
    } else if (
      e.type === "span.model_request_end" ||
      e.type === "span.model_first_token" ||
      e.type === "span.compaction_summarize_end" ||
      e.type === "span.outcome_evaluation_end" ||
      e.type === "span.outcome_evaluation_ongoing"
    ) {
      continue; // paired or progress noise
    } else if (e.type === "span.wakeup_scheduled") {
      // Pair via parent_event_id: the eventual wakeup user.message sets its
      // parent_event_id to this span's id (mint-then-emit, see
      // session-do.ts:scheduleWakeup). Bar runs scheduled → fired and
      // visualizes the actual wait, which dwarfs everything else (10s, 1h,
      // 1d…); without it the operator can't see the wait at all on the
      // waterfall.
      const sid = String((e as { id?: string }).id ?? (e.data as { id?: string } | undefined)?.id ?? "");
      const fired = sid ? childByParent.get(sid) : undefined;
      const endMs = fired ? fired.t - t0 : startMs;
      if (fired?.e) sourceEvents.push(fired.e);
      // A turn's own events rarely contain the wake-up it scheduled (that
      // message opens the NEXT turn, after the idle gap the view shows
      // between cards), so an unpaired schedule reads as what it is: the
      // moment the agent set an alarm, and for when.
      const due = (e as { scheduled_at?: string }).scheduled_at ?? (e.data as { scheduled_at?: string } | undefined)?.scheduled_at;
      const dueAt = due ? new Date(due) : null;
      pushSpan({
        key: `sched-${sid || i}`,
        family: "schedule",
        label: fired ? "Asleep until wake-up" : "Scheduled a wake-up",
        detail:
          fired || !dueAt || Number.isNaN(dueAt.getTime())
            ? undefined
            : `for ${dueAt.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`,
        startMs,
        durationMs: Math.max(0, endMs - startMs),
      });
    } else if (e.type === "user.message") {
      const md = (e as { metadata?: { harness?: string; kind?: string } }).metadata;
      const isWakeup = md?.harness === "schedule" && md?.kind === "wakeup";
      pushSpan({
        key: `u-${i}`,
        family: isWakeup ? "wakeup" : "user",
        label: isWakeup ? "Woke up on schedule" : "Message from you",
        startMs,
        durationMs: 0,
      });
    } else if (e.type === "agent.message") {
      pushSpan({ key: `a-${i}`, family: "agent", label: "Agent reply", startMs, durationMs: 0 });
    } else if (e.type === "agent.thinking") {
      pushSpan({ key: `think-${i}`, family: "thinking", label: "Thinking", startMs, durationMs: 0 });
    } else if (e.type === "aux.model_call") {
      pushSpan({ key: `aux-${i}`, family: "aux", label: "Helper model call", startMs, durationMs: 0 });
    } else if (
      e.type === "agent.thread_message_sent" ||
      e.type === "agent.thread_message_received" ||
      e.type === "agent.thread_message" ||
      e.type === "session.thread_created" ||
      e.type === "session.thread_idle"
    ) {
      const who = e.type === "session.thread_created" && typeof (e as { agent_name?: unknown }).agent_name === "string" ? String((e as { agent_name?: unknown }).agent_name) : null;
      pushSpan({
        key: `thread-${i}`,
        family: "thread",
        label: who ? `${who} started` : (SYSTEM_LABEL[e.type] ?? e.type.replace(/^.*\./, "").replace(/_/g, " ")),
        startMs,
        durationMs: 0,
      });
    } else if (e.type === "agent.thread_context_compacted") {
      pushSpan({ key: `compact-marker-${i}`, family: "compaction", label: "Context compacted", startMs, durationMs: 0 });
    } else if (e.type === "session.error") {
      pushSpan({
        key: `err-${i}`,
        family: "error",
        label: "Turn failed",
        detail: typeof e.message === "string" && e.message ? e.message : typeof e.error === "string" ? e.error.replace(/_/g, " ") : undefined,
        failed: true,
        startMs,
        durationMs: 0,
      });
    } else if (e.type === "session.warning") {
      pushSpan({
        key: `warn-${i}`,
        family: "warn",
        label: e.source ? `Warning from ${String(e.source).replace(/_/g, " ")}` : "Warning",
        detail: String(e.message ?? ""),
        startMs,
        durationMs: 0,
      });
    } else if (e.type.startsWith("session.")) {
      pushSpan({ key: `s-${i}`, family: "system", label: SYSTEM_LABEL[e.type] ?? humanizeType(e.type), startMs, durationMs: 0 });
    } else {
      // Catch-all: surface unknown types as instant markers rather than
      // silently dropping. New event types added later show up immediately
      // and the operator can decide whether to give them dedicated visuals.
      pushSpan({ key: `mk-${i}`, family: "marker", label: SYSTEM_LABEL[e.type] ?? humanizeType(e.type), startMs, durationMs: 0 });
    }
  }

  return { spans, totalMs };
}

/** Plain words for lifecycle events that have no dedicated visual. */
const SYSTEM_LABEL: Record<string, string> = {
  "session.status_running": "Started working",
  "session.status_idle": "Went idle",
  "session.status_terminated": "Session ended",
  "session.status_rescheduled": "Retry scheduled",
  "session.thread_created": "Sub-agent started",
  "session.thread_idle": "Sub-agent went idle",
  "agent.thread_message_sent": "Message to sub-agent",
  "agent.thread_message_received": "Message from sub-agent",
  "agent.thread_message": "Thread message",
  "system.access_request": "Asked for access",
  "system.skill_request": "Asked for a skill",
  "system.mission_verdict": "Verifier verdict",
  "system.ambient_rule_created": "Created a trigger",
};

/** "system.some_new_event" → "Some new event": a readable name for types with no label yet. */
function humanizeType(type: string): string {
  const tail = type.replace(/^.*\./, "").replace(/_/g, " ").trim();
  return tail ? tail[0].toUpperCase() + tail.slice(1) : type;
}

function parseEventTs(e: Event): number {
  return eventTime(e) ?? 0;
}

/**
 * Group a session's flat event stream into per-turn buckets, where a
 * "turn" starts on a user trigger event and ends on the next session
 * status_idle / .status_terminated / .error. Same definition the harness
 * uses internally (see drainEventQueue in session-do.ts).
 */
export function bucketIntoTurns(events: Event[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;

  // user.message metadata.harness === "schedule" + kind === "wakeup" is
  // the wire convention for cron-fired turns (see SessionDO.onScheduledWakeup).
  // Distinguish them in the trigger badge so an operator scanning the
  // timeline can tell at a glance "the agent woke itself" from "the user
  // sent something".
  const triggerKindOf = (e: Event): TurnTriggerKind | null => {
    if (e.type === "user.message") {
      const md = (e as { metadata?: { harness?: string; kind?: string } }).metadata;
      if (md?.harness === "schedule" && md?.kind === "wakeup") return "wakeup";
      return "user_message";
    }
    if (e.type === "user.tool_confirmation") return "tool_confirmation";
    if (e.type === "user.custom_tool_result") return "custom_tool_result";
    return null;
  };

  for (const e of events) {
    const k = triggerKindOf(e);
    if (k) {
      // Someone answered (or moved on): the turn that asked is settled.
      if (current?.status === "approval" || current?.status === "awaiting_client") current.status = "completed";
      current = {
        id: `turn-${turns.length}`,
        triggerKind: k,
        trigger: e,
        triggerTs: parseEventTs(e),
        events: [e],
        status: "running",
      };
      turns.push(current);
      continue;
    }
    if (!current) {
      // Pre-trigger init events (init_events injected by /init handler,
      // platform reminders, etc.) — bucket into a synthetic init turn so
      // they get a card rather than being silently dropped.
      current = {
        id: `turn-init`,
        triggerKind: "init",
        triggerTs: parseEventTs(e),
        events: [e],
        status: "running",
      };
      turns.push(current);
      continue;
    }
    current.events.push(e);
    if (e.type === "session.status_idle") {
      // Parked on requires_action: the turn waits on a person's decision,
      // or on the app for a custom tool's result. Either way it has not
      // completed; the next turn starts with the answer.
      const stop = (e as { stop_reason?: { type?: string; action_type?: string; event_ids?: unknown } }).stop_reason;
      const parked = stop?.type === "requires_action" || stop?.action_type === "tool_confirmation" || stop?.action_type === "custom_tool_result";
      if (!parked) current.status = "completed";
      else if (stop?.action_type === "custom_tool_result") current.status = "awaiting_client";
      else if (stop?.action_type === "tool_confirmation") current.status = "approval";
      else {
        // No action type: what the named calls are says what is owed.
        const ids = new Set(Array.isArray(stop?.event_ids) ? stop.event_ids : []);
        const custom = current.events.some((x) => x.type === "agent.custom_tool_use" && ids.has(x.id));
        current.status = custom ? "awaiting_client" : "approval";
      }
      current.endedAt = parseEventTs(e);
    } else if (e.type === "session.status_terminated") {
      current.status = "terminated";
      current.endedAt = parseEventTs(e);
    } else if (e.type === "session.error") {
      current.status = "errored";
      current.endedAt = parseEventTs(e);
    }
  }

  return turns;
}
