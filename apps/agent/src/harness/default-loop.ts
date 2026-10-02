import { streamText, stepCountIs, wrapLanguageModel } from "ai";
import type { ContentPart, ModelMessage, LanguageModel, SystemModelMessage } from "ai";
import type { HarnessInterface, HarnessContext, HarnessRuntime, FileResolver } from "./interface";
import type { SessionEvent, ContentBlock, AgentToolUseEvent } from "@open-managed-agents/shared";
import { generateEventId, classifyExternalError, ModelError } from "@open-managed-agents/shared";
import { eventsToMessagesAsync } from "../runtime/history";
import { SummarizeCompactionStrategy, resolveCompactionStrategy } from "./compaction";
import type { CompactionStrategy } from "./compaction";
import { ALL_TOOLS } from "./tools";
import { llmLoggingMiddleware, llmLogKey } from "./llm-logging-middleware";
import { isOpenAiCompatModel, sanitizeOpenAiToolNames, reasoningProviderOptions } from "./provider";
import type { ToolSet } from "ai";
import { OPENAI_MAX_TOOLS, SEARCH_TOOL_NAME, CALL_TOOL_NAME, applyToolBudget } from "./tool-budget";
import { classifyTool, idempotencyKeyFor } from "@open-managed-agents/session-runtime";
import type { ToolExecutionClass } from "@open-managed-agents/shared";
import {
  ToolUseGates,
  wrapToolsWriteAhead,
  reconcileOrphanedToolCalls,
  mergePersistedResults,
  type ToolSettlement,
} from "./durable-tools";

// Single source of truth lives in ./tools.ts (ALL_TOOLS). Importing here so
// adding a new toolset entry can't drift the event-classification list — the
// previous hard-coded duplicate caused `browser`, `schedule`,
// `cancel_schedule`, and `list_schedules` to mis-emit as
// `agent.custom_tool_use` instead of `agent.tool_use`.
const BUILTIN_TOOLS = new Set(ALL_TOOLS);
const isMcpTool = (name: string) => name.startsWith("mcp_");
// Exported so tests can assert classification directly. Returning true here
// makes `runtime.broadcast` emit `agent.tool_use`; false routes to
// `agent.custom_tool_use`. Down-stream consumers (Console UI, SDK event
// filters, billing dashboards) split on those event types.
export const isBuiltinTool = (name: string): boolean =>
  BUILTIN_TOOLS.has(name) || isMcpTool(name) || name.startsWith("call_agent_");


/**
 * Extract the MCP server name from a tool name like "mcp_github_call" or "mcp_github_list_tools".
 */
function extractMcpServerName(toolName: string): string {
  // mcp_{server_name}_{call|list_tools}
  const withoutPrefix = toolName.slice(4); // Remove "mcp_"
  const lastUnderscore = withoutPrefix.lastIndexOf("_");
  // Handle _list_tools (two underscores)
  if (withoutPrefix.endsWith("_list_tools")) {
    return withoutPrefix.slice(0, withoutPrefix.length - "_list_tools".length);
  }
  if (lastUnderscore > 0) {
    return withoutPrefix.slice(0, lastUnderscore);
  }
  return withoutPrefix;
}

/**
 * Durable-execution metadata stamped on every tool_use flavor (see
 * docs/durable-execution.md): idempotency key, recovery class, and the
 * model step that produced the call (history projection keeps one step in
 * one assistant message even when results were persisted in between).
 */
export interface ToolUseExtras {
  idempotency_key?: string;
  execution_class?: ToolExecutionClass;
  model_request_start_id?: string;
  /** True when the tool has no server-side execute (→ "ask" for built-ins). */
  pending?: boolean;
}

/**
 * Map a tool-call ContentPart to the right wire event family
 * (mcp / built-in / custom). Also emits agent.thread_message_sent for
 * call_agent_* sub-agent invocations.
 *
 * Lives outside DefaultHarness so the bijection contract is co-located
 * with `eventsToMessages` — the inverse mapping in history.ts.
 *
 * Returns the events in emit order; the caller decides whether they go
 * through the durable (awaited) or the fire-and-forget write path.
 */
export function toolCallEvents(
  part: { toolCallId: string; toolName: string; input?: unknown },
  extras: ToolUseExtras = {},
): SessionEvent[] {
  const callInput = (part.input ?? {}) as Record<string, unknown>;
  const toolName = part.toolName;
  const toolCallId = part.toolCallId;
  const out: SessionEvent[] = [];
  const durable = {
    ...(extras.idempotency_key ? { idempotency_key: extras.idempotency_key } : {}),
    ...(extras.execution_class ? { execution_class: extras.execution_class } : {}),
    ...(extras.model_request_start_id ? { model_request_start_id: extras.model_request_start_id } : {}),
  };

  if (toolName.startsWith("call_agent_")) {
    out.push({
      type: "agent.thread_message_sent",
      to_thread_id: toolCallId,
      content: [{ type: "text", text: String(callInput.message || "") }],
      // v1-additive (docs/trajectory-v1-spec.md "Causality"): mint a
      // deterministic id keyed on toolCallId so the matching
      // `agent.thread_message_received` (emitted in toolResultEvents)
      // can set parent_event_id back to the same value. There is exactly
      // one sent / received pair per call_agent_* tool invocation, so
      // a derived-from-toolCallId id collides with nothing.
      id: threadSentEventId(toolCallId),
    });
  }

  if (isMcpTool(toolName)) {
    out.push({
      type: "agent.mcp_tool_use",
      id: toolCallId,
      mcp_server_name: extractMcpServerName(toolName),
      name: toolName,
      input: callInput,
      ...durable,
    });
  } else if (isBuiltinTool(toolName)) {
    const event: AgentToolUseEvent = {
      type: "agent.tool_use",
      id: toolCallId,
      name: toolName,
      input: callInput,
      ...durable,
    };
    if (extras.pending) event.evaluated_permission = "ask";
    out.push(event);
  } else {
    out.push({
      type: "agent.custom_tool_use",
      id: toolCallId,
      name: toolName,
      input: callInput,
      ...durable,
    });
  }
  return out;
}

/**
 * Deterministic id for the `agent.thread_message_sent` event paired with
 * a given call_agent_* tool invocation. Lets the eventual
 * `agent.thread_message_received` set parent_event_id = this id without
 * sharing state across the two emit callbacks.
 *
 * Format mirrors the `sevt-` prefix `generateEventId` mints so downstream
 * id-format sniffing keeps working.
 */
function threadSentEventId(toolCallId: string): string {
  return `sevt-thread-sent-${toolCallId}`;
}

/**
 * Map a tool-result (or tool-error) ContentPart to wire events,
 * normalizing the AI SDK's ToolResultOutput union into the wire's
 * `string | ContentBlock[]` representation. Also emits
 * agent.thread_message_received for call_agent_*.
 *
 * Normalization rules — fixed so that read(write(m)) === m at byte level:
 *   text       → string
 *   content[]  → ContentBlock[] (TextBlock for text parts; image/document
 *                ContentBlocks pass through if already shaped that way)
 *   json/error → JSON-stringified string (lossy for the AI SDK type tag,
 *                but Anthropic only ever sees the string, so derive can
 *                rebuild a {type:"text"} ToolResultOutput equivalently)
 *   already-shaped ContentBlock or ContentBlock[] (legacy tool returns)
 *                → wrap or pass through
 */
export function toolResultEvents(part: {
  type: "tool-result" | "tool-error";
  toolCallId: string;
  toolName: string;
  output?: unknown;
  result?: unknown;
  error?: unknown;
}): SessionEvent[] {
  const toolCallId = part.toolCallId;
  const toolName = part.toolName;
  const out: SessionEvent[] = [];
  // tool-error has `error`, tool-result has `output`.
  const raw =
    part.type === "tool-error"
      ? { type: "error-text", value: String(part.error ?? "") }
      : (part.output ?? part.result);

  const content = normalizeToolOutputForWire(raw);

  if (isMcpTool(toolName)) {
    out.push({
      type: "agent.mcp_tool_result",
      mcp_tool_use_id: toolCallId,
      content: typeof content === "string" ? content : JSON.stringify(content),
      // v1-additive: causal predecessor is the matching agent.mcp_tool_use,
      // whose EventBase.id is set explicitly to toolCallId in
      // toolCallEvents above. Same identity, no extra plumbing.
      parent_event_id: toolCallId,
    });
  } else {
    out.push({
      type: "agent.tool_result",
      tool_use_id: toolCallId,
      content,
      ...(part.type === "tool-error" ? { is_error: true } : {}),
      // v1-additive: causal predecessor is the matching agent.tool_use,
      // whose EventBase.id is set explicitly to toolCallId in
      // toolCallEvents above. (AgentToolUseEvent.id overrides
      // EventBase.id, so tool_use_id IS the parent's EventBase.id.)
      parent_event_id: toolCallId,
    });
  }

  if (toolName.startsWith("call_agent_")) {
    const text = typeof content === "string"
      ? content
      : content.map((b) => (b.type === "text" ? b.text : "")).join("");
    out.push({
      type: "agent.thread_message_received",
      from_thread_id: toolCallId,
      content: [{ type: "text", text }],
      // v1-additive: causal predecessor is the agent.thread_message_sent
      // emitted in toolCallEvents above for the same toolCallId.
      parent_event_id: threadSentEventId(toolCallId),
    });
  }
  return out;
}

/**
 * AI SDK ToolResultOutput union → wire `string | ContentBlock[]`.
 * Pure function; same input → same output bytes.
 */
function normalizeToolOutputForWire(raw: unknown): string | ContentBlock[] {
  if (typeof raw === "string") return raw;
  if (raw == null) return "";

  // Already wire-shape (single ContentBlock or array)
  if (typeof raw === "object" && "type" in raw) {
    const r = raw as { type: string };
    if (r.type === "text" && "text" in raw) return [raw as ContentBlock];
    if (r.type === "image" && "source" in raw) return [raw as ContentBlock];
    if (r.type === "document" && "source" in raw) return [raw as ContentBlock];

    // AI SDK ToolResultOutput discriminated union
    if (r.type === "text" && "value" in raw) return String((raw as unknown as { value: unknown }).value);
    if (r.type === "json") return JSON.stringify((raw as unknown as { value: unknown }).value);
    if (r.type === "error-text" || r.type === "error-json") {
      const v = (raw as unknown as { value: unknown }).value;
      return typeof v === "string" ? v : JSON.stringify(v);
    }
    if (r.type === "execution-denied") {
      return JSON.stringify({ denied: true, reason: (raw as unknown as { reason?: string }).reason });
    }
    if (r.type === "content" && Array.isArray((raw as unknown as { value: unknown[] }).value)) {
      const parts = (raw as unknown as { value: Array<{ type: string; text?: string; data?: string; mediaType?: string; url?: string }> }).value;
      return parts.map((p): ContentBlock => {
        if (p.type === "text") return { type: "text", text: p.text ?? "" };
        if (p.type === "image-data" || p.type === "media") {
          return {
            type: "image",
            source: { type: "base64", media_type: p.mediaType, data: p.data },
          };
        }
        if (p.type === "image-url") {
          return { type: "image", source: { type: "url", url: p.url, media_type: p.mediaType } };
        }
        if (p.type === "file-data") {
          return {
            type: "document",
            source: { type: "base64", media_type: p.mediaType, data: p.data },
          };
        }
        if (p.type === "file-url") {
          return { type: "document", source: { type: "url", url: p.url, media_type: p.mediaType } };
        }
        return { type: "text", text: JSON.stringify(p) };
      });
    }
  }

  if (Array.isArray(raw) && raw.every((b) => b && typeof b === "object" && "type" in b)) {
    return raw as ContentBlock[];
  }

  return JSON.stringify(raw);
}

export class DefaultHarness implements HarnessInterface {
  /**
   * Compaction strategy resolved from agent config. Cached on the harness
   * instance so shouldCompact / compact (which don't get ctx) can use it.
   * Set in run() before any compaction hook fires.
   */
  private compactionStrategy: CompactionStrategy = new SummarizeCompactionStrategy();

  async run(ctx: HarnessContext): Promise<void> {
    const { agent, userMessage, runtime, tools, model, systemPrompt } = ctx;

    // Resolve compaction params from agent config. Strategy class is
    // selectable via `agent.metadata.compaction_strategy` (defaults to
    // "summarize" for backward compat); shared knobs (tail, trigger
    // fraction) apply to whichever strategy is picked.
    const meta = (agent.metadata ?? {}) as Record<string, unknown>;
    const triggerFraction = typeof meta.compaction_trigger_fraction === "number"
      ? meta.compaction_trigger_fraction as number
      : undefined;
    const tailMinTokens = typeof meta.compaction_tail_min_tokens === "number"
      ? meta.compaction_tail_min_tokens as number
      : undefined;
    const tailMaxTokens = typeof meta.compaction_tail_max_tokens === "number"
      ? meta.compaction_tail_max_tokens as number
      : undefined;
    const tailMinMessages = typeof meta.compaction_tail_min_messages === "number"
      ? meta.compaction_tail_min_messages as number
      : undefined;
    const strategyName = typeof meta.compaction_strategy === "string"
      ? meta.compaction_strategy as string
      : undefined;
    this.compactionStrategy = resolveCompactionStrategy(strategyName, {
      tailMinTokens,
      tailMaxTokens,
      tailMinMessages,
      triggerFraction,
    });

    // --- Durable execution setup (docs/durable-execution.md) ---
    //
    // `persist` is the awaited, durable write path used for write-ahead
    // tool_use + immediate tool_result. Runtimes that predate it fall back
    // to the fire-and-forget broadcast (no durability guarantee, same
    // ordering).
    const persist = runtime.persist
      ? (event: SessionEvent) => runtime.persist!(event)
      : async (event: SessionEvent) => { runtime.broadcast(event); };
    const sessionId = ctx.session_id;
    // Primary-thread turns must not see sub-agent thread events (runSubAgent
    // mirrors them into the parent log tagged with their session_thread_id).
    // With write-ahead ordering those land BETWEEN the parent's call_agent
    // tool_use and its result, which would break tool_use/tool_result
    // pairing in the projection. Thread-scoped turns keep the legacy
    // unfiltered view.
    const turnThread = (userMessage as { session_thread_id?: string } | undefined)?.session_thread_id;
    const visibleEvents = (): SessionEvent[] => {
      const all = runtime.history.getEvents();
      if (turnThread && turnThread !== "sthr_primary") return all;
      return all.filter((e) => {
        const t = (e as { session_thread_id?: string }).session_thread_id;
        return t == null || t === "sthr_primary";
      });
    };

    // 0. Resolve tool calls an interrupted run left without a result
    // (crash, DO eviction, in-process retry) BEFORE any model call —
    // idempotent calls are re-executed, side-effect calls get an
    // "outcome unknown, verify before retrying" error result, client
    // calls are left for the client. See durable-tools.ts.
    const reconciled = await reconcileOrphanedToolCalls({
      events: visibleEvents(),
      tools,
      sessionId,
      persist,
      resultEvents: (s) => toolResultEvents(s),
      abortSignal: runtime.abortSignal,
    });
    if (reconciled.reexecuted.length || reconciled.injected.length) {
      runtime.broadcast({
        type: "session.warning",
        source: "tool_call_recovered",
        message:
          `Resolved ${reconciled.reexecuted.length + reconciled.injected.length} interrupted tool call(s) ` +
          `before resuming: re-executed idempotent [${reconciled.reexecuted.join(", ")}], ` +
          `reported unknown outcome for [${reconciled.injected.join(", ")}].`,
        details: { reexecuted: reconciled.reexecuted, injected: reconciled.injected },
      } as SessionEvent);
    }

    // --- Harness decides HOW to deliver context to the model ---

    // 1. Compaction check: ask the harness's own shouldCompact + compact
    // hooks. Default impls live below the class. Custom harnesses override.
    // compact() persists its product as a agent.thread_context_compacted
    // event with summary — derive() then sees the boundary and serves the
    // summarized view from this turn forward (NOT recomputed per turn).
    const allEvents = runtime.history.getEvents();
    const ctxWindow = resolveContextWindowTokens(model);
    if (this.shouldCompact && this.compact && this.shouldCompact(allEvents, { contextWindowTokens: ctxWindow })) {
      try {
        await this.compact(allEvents, runtime, { model, systemPrompt, tools });
      } catch (err) {
        // Compaction is best-effort. Log and continue — the next turn will
        // try again. Don't fail the whole turn over a summarize error.
        console.warn(`[compact] failed: ${(err as Error).message}`);
      }
    }

    // 2. Derive ModelMessage[] from events. Default = eventsToMessagesAsync
    // (strict bijection inverse of write-side, with boundary handling +
    // async file_id → bytes resolution via ctx.fileFetcher). Custom harnesses
    // can override for sliding-window / RAG / etc. — the await unwraps either
    // sync or async overrides so existing implementations keep working.
    //
    // Resume-from-log: after a crash the log already holds every completed
    // step (assistant content + write-ahead tool_use + tool_result), so the
    // model continues from the last durable step — completed tools are not
    // re-run and the user message is not re-sent as a fresh turn.
    const contextEvents = mergePersistedResults(visibleEvents(), reconciled.extraEvents);
    const messages = this.deriveModelContext
      ? await this.deriveModelContext(contextEvents, { fileFetcher: ctx.fileFetcher })
      : await eventsToMessagesAsync(contextEvents, ctx.fileFetcher);

    // 3. Apply provider-specific cache strategy. Anthropic: tag system block
    // + last tool + last message + (optional) one mid-conversation breakpoint
    // for long turns. Other providers: no-op (OpenAI prompt caching is
    // automatic; Google uses cachedContent; MiniMax TBD).
    //
    // AI SDK doesn't expose a provider-agnostic cache abstraction — each
    // provider exposes its own knobs via providerOptions. We branch on
    // model.provider here. To add OpenAI/Gemini cache support later, extend
    // the strategy table below; the harness loop above doesn't change.
    const cached = applyProviderCacheStrategy(model, systemPrompt, tools, messages);
    // OpenAI hard-caps function names at 64 chars — in the tools array AND
    // in replayed history tool_calls. Long MCP names (Composio) 400 the
    // whole turn otherwise. Deterministic mangle; no-op for other providers.
    if (isOpenAiCompatModel(model)) {
      // …and the tools array at 128 entries. Keep built-ins + whole MCP
      // servers in harness order while they fit; the rest stay reachable
      // via search_mcp_tools / call_mcp_tool (see tool-budget.ts). Seen
      // live: 6 servers → 224 tools → 400 on every turn.
      if (cached.tools && Object.keys(cached.tools).length > OPENAI_MAX_TOOLS) {
        const budget = applyToolBudget(cached.tools as ToolSet, {
          maxTools: OPENAI_MAX_TOOLS,
          serverOrder: (agent.mcp_servers ?? []).map((srv) => srv.name).filter(Boolean) as string[],
        });
        cached.tools = budget.tools as typeof cached.tools;
        runtime.broadcast({
          type: "session.warning",
          source: "tool_budget",
          message:
            `Model accepts at most ${OPENAI_MAX_TOOLS} tools; deferred ${budget.deferred.size} MCP tools from ` +
            `${Object.entries(budget.deferredByServer).map(([srv, n]) => `${srv} (${n})`).join(", ")} — ` +
            `reachable via ${SEARCH_TOOL_NAME} / ${CALL_TOOL_NAME}.`,
        } as SessionEvent);
      }
      const safe = sanitizeOpenAiToolNames({ tools: cached.tools, messages: cached.messages });
      if (safe.tools) cached.tools = safe.tools as typeof cached.tools;
      if (safe.messages) cached.messages = safe.messages as typeof cached.messages;
    }
    const finalMessages = cached.messages;

    // 4. Resolve model id (used by per-step span events emitted via the
    //    streamText `start-step`/`finish-step` chunk + onStepFinish hooks).
    //    The OUTER span.model_request_start/end pair around streamText() that
    //    used to live here was removed: ai-sdk's streamText loops internally
    //    (one call per tool round-trip), so a single outer span hid the actual
    //    per-call timing + per-call usage that Anthropic's Managed Agents wire
    //    spec exposes.
    const modelId = typeof agent.model === "string" ? agent.model : agent.model.id;

    // 5. Run agent loop with retry + timeout + prompt caching.
    //
    // Streaming mode: streamText emits text-delta chunks via onChunk as
    // tokens arrive. We forward each delta through `runtime.broadcastChunk`
    // (broadcast + persist to streams table; NOT to events log) so chatbot
    // clients see live token-by-token rendering.
    //
    // Message boundary: one logical "message" = one step's text part.
    // We mint a fresh `currentMessageId` lazily on first text-delta of
    // each step, broadcast a stream_start, accumulate chunks, then on
    // onStepFinish (which still owns the persisted `agent.message`)
    // broadcast stream_end with the same id and finalize the stream
    // row. The same id lands on the `agent.message` event so clients
    // can swap chunk display for canonical content.
      // Single-attempt model call. Retry/keepAlive/permanent-stall logic
      // moved out to runtime/turn-runtime.ts (Primitive 1). Caller decides
      // whether to retry on TurnAborted; default-loop just runs the model
      // once and propagates errors. Stale-chunk detection stays here
      // because it needs direct access to streamText's onChunk timing —
      // turn-runtime would need a chunk-arrival callback to do it from
      // outside, which is more plumbing for marginal gain.
      const result = await (async () => {
      let currentMessageId: string | null = null;
      // Per-step thinking and tool-input streams keyed by the AI SDK
      // chunk's id (reasoning) or toolCallId (tool input). Multiple
      // can be in flight simultaneously within one step (parallel
      // tool calls). Cleared between steps via onStepFinish, but the
      // canonical event landing is what tells the client to swap.
      const liveThinking = new Set<string>();
      const liveToolInput = new Set<string>();

      // Per-step model_request span pair. We hook ai-sdk's
      // `experimental_onStepStart` (fires before each provider call) to mint
      // an id + broadcast span.model_request_start, and pair via
      // model_request_start_id from onStepFinish / onError / onAbort.
      // The `experimental_` prefix means vercel-ai may rename / change
      // signature without notice; pin the ai-sdk version on dep upgrade.
      // Anthropic's Managed Agents wire spec uses one pair per actual
      // model call (not per streamText loop), which is what this gives us.
      //
      // OMA extension: between start and end we also emit
      // span.model_first_token at the first chunk of each step (any chunk
      // type counts — text, reasoning, tool-input). Splits the bar into
      // TTFT vs generation in the timeline. `stepSawFirstChunk` is the
      // per-step latch; reset on each onStepStart.
      let stepStartId: string | null = null;
      let stepSawFirstChunk = false;
      // Last in-stream provider error (onError below). When the stream ends
      // with finishReason="error" and the turn shipped nothing, this is the
      // diagnostic the thrown ModelError carries — without it the turn
      // "completes" silently: no reply, no session.error, just an idle
      // session (observed 2026-07-15/16: OpenAI insufficient_quota mid-
      // stream looked like "the model does not answer").
      let lastStreamErrorMessage: string | null = null;

      // ── Write-ahead step state (docs/durable-execution.md) ──────────
      //
      // The stream observer (experimental_transform below) mirrors the
      // current step's content in stream order. When a tool-call part
      // arrives it durably persists, in order: every not-yet-emitted
      // reasoning/text part that precedes it, then the agent.tool_use
      // (with idempotency key + execution class), and only then opens the
      // gate that lets the wrapped execute run. Results are persisted by
      // the execute wrapper as soon as the tool settles. onStepFinish then
      // emits only what the write-ahead path didn't (trailing text,
      // SDK-generated tool errors, spans) — no double emission.
      type MirrorPart =
        | { kind: "reasoning"; id: string; text: string; providerMetadata?: unknown }
        | { kind: "text"; id: string; text: string }
        | { kind: "tool-call"; toolCallId: string };
      let stepParts: MirrorPart[] = [];
      let stepFlushedIdx = 0;
      let stepFlushedReasoning = 0;
      let stepFlushedText = 0;
      const writeAheadToolUses = new Set<string>();
      const persistedResults = new Set<string>();
      const gates = new ToolUseGates();
      const finalTools = (cached.tools ?? {}) as Record<string, any>;
      const lookupTool = (name: string) => finalTools[name] ?? tools[name];

      const toolUseExtras = (toolName: string, toolCallId: string): ToolUseExtras => {
        const t = lookupTool(toolName);
        const hasExecute = typeof t?.execute === "function";
        return {
          idempotency_key: idempotencyKeyFor(sessionId, toolCallId),
          execution_class: classifyTool(toolName, { hasExecute, annotations: t?.annotations }),
          model_request_start_id: stepStartId ?? undefined,
          pending: !hasExecute,
        };
      };

      const emitThinking = async (
        p: { text: string; providerMetadata?: unknown; id?: string },
        write: (e: SessionEvent) => Promise<void> | void,
      ) => {
        // AI SDK reasoning parts in step.content[] don't carry the chunk
        // id; the mirror does. Fall back to the single-live-stream guess
        // for parts emitted from onStepFinish.
        const tid = p.id ?? (liveThinking.size === 1 ? [...liveThinking][0] : undefined);
        if (tid) {
          await runtime.broadcastThinkingEnd(tid, "completed");
          liveThinking.delete(tid);
        }
        await write({
          type: "agent.thinking",
          text: p.text,
          providerOptions: p.providerMetadata as Record<string, unknown> | undefined,
          ...(tid ? { thinking_id: tid } : {}),
          ...(stepStartId ? { model_request_start_id: stepStartId } : {}),
        } as SessionEvent);
      };

      const emitText = async (text: string, write: (e: SessionEvent) => Promise<void> | void) => {
        // Trim trailing whitespace at write time. Anthropic's @ai-sdk
        // provider trims the LAST text of the LAST assistant message
        // before sending; without our normalization, the same stored
        // assistant text would render with vs. without `\n` depending on
        // whether it's the tail of the conversation, busting the cache
        // on the next turn.
        const messageId = currentMessageId ?? generateEventId();
        if (currentMessageId) {
          await runtime.broadcastStreamEnd(currentMessageId, "completed");
        }
        await write({
          type: "agent.message",
          message_id: messageId,
          content: [{ type: "text", text: text.replace(/\s+$/, "") }],
          ...(stepStartId ? { model_request_start_id: stepStartId } : {}),
        } as SessionEvent);
        currentMessageId = null; // reset for next step
      };

      // Write-ahead: persist the step prefix + tool_use for one tool call,
      // then open its execution gate. Runs inside the stream transform, so
      // the pipeline (and therefore every later part of this step) waits.
      const writeAheadToolCall = async (part: { toolCallId: string; toolName: string; input?: unknown }) => {
        try {
          for (; stepFlushedIdx < stepParts.length; stepFlushedIdx++) {
            const p = stepParts[stepFlushedIdx];
            if (p.kind === "reasoning") {
              await emitThinking(p, persist);
              stepFlushedReasoning++;
            } else if (p.kind === "text") {
              await emitText(p.text, persist);
              stepFlushedText++;
            }
          }
          if (liveToolInput.has(part.toolCallId)) {
            await runtime.broadcastToolInputEnd(part.toolCallId, "completed");
            liveToolInput.delete(part.toolCallId);
          }
          for (const e of toolCallEvents(part, toolUseExtras(part.toolName, part.toolCallId))) {
            await persist(e);
          }
          writeAheadToolUses.add(part.toolCallId);
          gates.open(part.toolCallId);
        } catch (err) {
          // Intent could not be made durable → the tool must not run.
          gates.fail(part.toolCallId, err);
          throw err;
        }
      };

      const persistSettlement = async (s: ToolSettlement): Promise<SessionEvent[]> => {
        if (persistedResults.has(s.toolCallId)) return [];
        persistedResults.add(s.toolCallId);
        const events = toolResultEvents(s);
        try {
          for (const e of events) await persist(e);
        } catch (err) {
          persistedResults.delete(s.toolCallId);
          throw err;
        }
        return events;
      };

      cached.tools = wrapToolsWriteAhead(finalTools, {
        sessionId,
        gates,
        isToolUsePersisted: (id) => writeAheadToolUses.has(id),
        persistResult: persistSettlement,
      }) as typeof cached.tools;

      // Live-streaming + first-token handling for one stream part. Used to
      // live in onChunk; moved into the transform so it is ordered with the
      // write-ahead flush (onChunk runs downstream and may lag the
      // transform, which would mint stream ids for text we already
      // committed).
      const observeLiveChunk = (chunk: { type: string; [k: string]: unknown }) => {
        // First chunk of this step → emit span.model_first_token. Pair via
        // model_request_start_id so consumers can split TTFT (start →
        // first_token) from generation (first_token → end). Any chunk
        // counts: text-delta, reasoning-delta, or tool-input-start —
        // whichever fires first signals "the model has begun responding".
        if (
          !stepSawFirstChunk && stepStartId &&
          (chunk.type === "text-delta" || chunk.type === "reasoning-delta" || chunk.type === "source" ||
            chunk.type === "tool-call" || chunk.type === "tool-result" || chunk.type === "tool-input-start" ||
            chunk.type === "tool-input-delta" || chunk.type === "raw")
        ) {
          stepSawFirstChunk = true;
          runtime.broadcast({
            type: "span.model_first_token",
            model: modelId,
            model_request_start_id: stepStartId,
          });
        }

        if (chunk.type === "text-delta") {
          if (!currentMessageId) {
            currentMessageId = generateEventId();
            // Fire-and-forget: the stream_start event lands at clients via
            // WS broadcast before chunks via the same single-threaded DO
            // send queue.
            void runtime.broadcastStreamStart(currentMessageId);
          }
          void runtime.broadcastChunk(currentMessageId, chunk.text as string);
        } else if (chunk.type === "reasoning-delta") {
          // AI SDK assigns a stable id per reasoning block. Use it as
          // the thinking_id so the client can correlate with the
          // matching agent.thinking event.
          const tid = chunk.id as string;
          if (!liveThinking.has(tid)) {
            liveThinking.add(tid);
            void runtime.broadcastThinkingStart(tid);
          }
          void runtime.broadcastThinkingChunk(tid, chunk.text as string);
        } else if (chunk.type === "tool-input-start") {
          // toolCallId here matches the eventual tool-call's id, which
          // becomes agent.tool_use.id. Same correlation contract.
          const id = chunk.id as string;
          if (!liveToolInput.has(id)) {
            liveToolInput.add(id);
            void runtime.broadcastToolInputStart(id, chunk.toolName as string);
          }
        } else if (chunk.type === "tool-input-delta") {
          const id = chunk.id as string;
          if (!liveToolInput.has(id)) {
            // Some providers skip the start event; mint lazily.
            liveToolInput.add(id);
            void runtime.broadcastToolInputStart(id);
          }
          void runtime.broadcastToolInputChunk(id, chunk.delta as string);
        }
      };

      // Ordered stream observer: mirrors step content (same rules as the
      // AI SDK's recordedContent) and runs the write-ahead flush on
      // tool-call parts. Awaited per part, so it sees the step exactly in
      // model output order.
      const observeStreamPart = async (part: { type: string; [k: string]: unknown }) => {
        switch (part.type) {
          case "start-step":
            stepParts = [];
            stepFlushedIdx = 0;
            stepFlushedReasoning = 0;
            stepFlushedText = 0;
            break;
          case "text-start":
            stepParts.push({ kind: "text", id: part.id as string, text: "" });
            break;
          case "text-delta": {
            const p = findOpenPart("text", part.id as string);
            if (p) p.text += (part.text as string) ?? "";
            break;
          }
          case "reasoning-start":
            stepParts.push({
              kind: "reasoning",
              id: part.id as string,
              text: "",
              providerMetadata: part.providerMetadata,
            });
            break;
          case "reasoning-delta":
          case "reasoning-end": {
            const p = findOpenPart("reasoning", part.id as string) as
              | { kind: "reasoning"; text: string; providerMetadata?: unknown }
              | undefined;
            if (p) {
              if (part.type === "reasoning-delta") p.text += (part.text as string) ?? "";
              p.providerMetadata = part.providerMetadata ?? p.providerMetadata;
            }
            break;
          }
          case "tool-call": {
            const tc = part as unknown as { toolCallId: string; toolName: string; input?: unknown; providerExecuted?: boolean };
            if (tc.providerExecuted) break; // provider-side tool: emitted from onStepFinish
            stepParts.push({ kind: "tool-call", toolCallId: tc.toolCallId });
            observeLiveChunk(part);
            await writeAheadToolCall(tc);
            return;
          }
        }
        observeLiveChunk(part);
      };
      const findOpenPart = (kind: "text" | "reasoning", id: string) => {
        for (let i = stepParts.length - 1; i >= 0; i--) {
          const p = stepParts[i];
          if (p.kind === kind && p.id === id) return p as { kind: typeof kind; id: string; text: string };
        }
        return undefined;
      };

      const streamStartedAt = Date.now();
      console.log(`[stream] streamText START model=${modelId} messages=${finalMessages.length} tools=${Object.keys(cached.tools ?? {}).length}`);

      // LLM full-body logging: wrap the model so every provider call's
      // request + response is teed to R2 keyed by the per-step span
      // event id. When env.llmLog is absent (test harnesses, non-CF),
      // we skip the wrap entirely so the model object passes through.
      // The spanIdResolver closure reads `stepStartId`, which AI SDK
      // mints in experimental_onStepStart (called BEFORE the provider
      // doStream call) — so the middleware always sees the right id at
      // wrapStream invocation time.
      // Note: wrapLanguageModel only accepts LanguageModelV3 instances
      // (not the LanguageModel union which includes string ids). All
      // resolveModel returns are V3 instances; cast through unknown to
      // satisfy the wrapper's narrower type without runtime conversion.
      const llmLogCtx = ctx.env.llmLog;
      const wrappedModel: LanguageModel = llmLogCtx
        ? (wrapLanguageModel({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            model: model as any,
            middleware: llmLoggingMiddleware({
              tenant_id: llmLogCtx.tenant_id,
              session_id: llmLogCtx.session_id,
              r2: llmLogCtx.r2,
              spanIdResolver: () => stepStartId,
            }),
          }) as unknown as LanguageModel)
        : model;

      try {
      const r = streamText({
      model: wrappedModel,
      // Empty system prompt → omit entirely. Anthropic's API rejects an
      // empty `system` block ("system: text content blocks must be non-
      // empty"); the AI SDK forwards the empty string as a block instead
      // of skipping it. Pass undefined so the SDK omits the field.
      system: cached.system && (typeof cached.system !== "string" || cached.system.length > 0)
        ? cached.system
        : undefined,
      messages: finalMessages,
      tools: cached.tools,
      // agent.reasoning_level mapped to provider knobs: OpenAI
      // reasoning_effort (Responses API for levels above instant — see
      // resolveModel) or Anthropic thinking budget. Also carries the
      // shipped floor: OpenAI reasoning models on chat/completions 400
      // when function tools are present unless reasoning_effort is
      // 'none'. Undefined for every other model — omitted from the
      // request.
      providerOptions: reasoningProviderOptions(
        model,
        modelId,
        agent.reasoning_level,
        Object.keys(cached.tools ?? {}).length > 0,
      ),
      stopWhen: stepCountIs(100),
      abortSignal: runtime.abortSignal,

      // Ordered stream observer (replaces onChunk): live chunk streaming
      // + write-ahead tool_use persistence. A TransformStream's transform
      // is awaited per part, so the model's output order is preserved and
      // later parts wait while a tool_use is being made durable. Parts are
      // passed through unchanged.
      experimental_transform: () =>
        new TransformStream({
          async transform(part, controller) {
            await observeStreamPart(part as unknown as { type: string; [k: string]: unknown });
            controller.enqueue(part);
          },
        }),

      // experimental_: vercel-ai may rename / change signature without
      // notice. Pin ai-sdk version on dep upgrade. The stable alternative
      // (consume `result.fullStream` for `start-step` chunks) requires
      // intercepting the iterator; this is materially simpler.
      experimental_onStepStart: () => {
        stepStartId = generateEventId();
        stepSawFirstChunk = false;
        runtime.broadcast({
          type: "span.model_request_start",
          id: stepStartId,
          model: modelId,
        });
      },

      onStepFinish: async (step) => {
        // Iterate step.content[] in order to preserve LLM output ordering
        // (reasoning → text → tool-call interleaving). The previous "reasoning
        // first, text next, tool-calls last" loop assumed an ordering AI SDK
        // doesn't guarantee, breaking byte-determinism on derive().
        //
        // Each part maps to exactly one wire event. The mapping is the inverse
        // of history.ts eventsToMessages — together they form the
        // ModelMessage[] ↔ SessionEvent[] bijection that prompt-cache
        // determinism rests on.
        //
        // Write-ahead: parts already made durable by the stream observer
        // (the reasoning/text prefix before each tool call, every tool_use,
        // and every result persisted by the execute wrapper) are skipped
        // here, so each part still maps to exactly one wire event.
        const broadcast = (e: SessionEvent) => runtime.broadcast(e);
        let reasoningSeen = 0;
        let textSeen = 0;
        for (const part of step.content as ReadonlyArray<ContentPart<any>>) {
          switch (part.type) {
            case "reasoning": {
              if (reasoningSeen++ < stepFlushedReasoning) break;
              // AI SDK reasoning parts in step.content[] don't carry the
              // chunk id directly, but the observer minted at most one
              // stream per step in practice. Drain whichever streams are
              // live so the client closes their pulsing bubbles. The
              // canonical agent.thinking carries thinking_id only when we
              // can correlate (single-stream case); multi-stream steps just
              // see the stream_end + a thinking event without correlation
              // (renderer falls back to dropping all live streams when
              // any thinking lands — see frontend).
              const partWithId = part as { type: "reasoning"; text: string; id?: string; providerMetadata?: unknown };
              await emitThinking(partWithId, broadcast);
              break;
            }
            case "text": {
              if (textSeen++ < stepFlushedText) break;
              await emitText(part.text, broadcast);
              break;
            }
            case "tool-call": {
              const partTC = part as { type: "tool-call"; toolCallId: string; toolName: string; input?: unknown };
              if (writeAheadToolUses.has(partTC.toolCallId)) break;
              if (liveToolInput.has(partTC.toolCallId)) {
                await runtime.broadcastToolInputEnd(partTC.toolCallId, "completed");
                liveToolInput.delete(partTC.toolCallId);
              }
              for (const e of toolCallEvents(partTC, toolUseExtras(partTC.toolName, partTC.toolCallId))) {
                runtime.broadcast(e);
              }
              writeAheadToolUses.add(partTC.toolCallId);
              break;
            }
            case "tool-result":
            case "tool-error": {
              const partTR = part as { type: "tool-result" | "tool-error"; toolCallId: string; toolName: string };
              if (persistedResults.has(partTR.toolCallId)) break;
              persistedResults.add(partTR.toolCallId);
              for (const e of toolResultEvents(partTR)) runtime.broadcast(e);
              break;
            }
            // source / file / tool-approval-request: not produced by current
            // tool surface; intentionally skipped. Add cases here if those
            // become reachable — the bijection requires every part write a
            // matching wire event.
          }
        }
        // Defensive: any thinking/tool-input streams that didn't pair
        // with a step.content entry get aborted so the client doesn't
        // leave bubbles spinning forever.
        for (const tid of liveThinking) {
          await runtime.broadcastThinkingEnd(tid, "aborted");
        }
        liveThinking.clear();
        for (const tid of liveToolInput) {
          await runtime.broadcastToolInputEnd(tid, "aborted");
        }
        liveToolInput.clear();

        // Per-step span.model_request_end. Carries this step's usage and
        // finishReason — Anthropic's wire format puts model_usage at this
        // granularity (per actual model API call), not aggregated across
        // the whole streamText loop. Pair via model_request_start_id so
        // consumers don't have to FIFO-match.
        const stepText = (step.content as ReadonlyArray<{ type: string; text?: string }>)
          .filter((p) => p.type === "text")
          .map((p) => p.text ?? "")
          .join("");
        const providerResponseId = (step.response as { id?: string } | undefined)?.id;
        // body_r2_key: pointer to the R2-persisted full request/response
        // for this provider call. Computable from session_id + event_id
        // at read time; we surface it on the event so consumers don't
        // have to know the key layout. Absent when llm logging is off.
        const bodyR2Key = llmLogCtx
          ? llmLogKey(llmLogCtx.tenant_id, llmLogCtx.session_id, stepStartId ?? "")
          : undefined;
        runtime.broadcast({
          type: "span.model_request_end",
          model: modelId,
          model_request_start_id: stepStartId ?? undefined,
          provider_response_id: providerResponseId,
          model_usage: step.usage ? {
            input_tokens: step.usage.inputTokens ?? 0,
            output_tokens: step.usage.outputTokens ?? 0,
            cache_read_input_tokens: step.usage.inputTokenDetails?.cacheReadTokens ?? 0,
            cache_creation_input_tokens: step.usage.inputTokenDetails?.cacheWriteTokens ?? 0,
          } : undefined,
          finish_reason: step.finishReason,
          final_text_length: stepText.length,
          is_error: false,
          ...(bodyR2Key ? { body_r2_key: bodyR2Key } : {}),
        });
        // Clear so onError / onAbort don't double-close.
        stepStartId = null;
      },

      onError: ({ error }) => {
        // streamText aborts the stream on error before onStepFinish can fire
        // for the failing step. Without closing here, the span.model_request_start
        // we emitted in the start-step chunk hangs unpaired. Mirror the
        // shape of the success-path end so consumers can treat is_error as
        // the success/fail discriminator.
        //
        // Providers can surface IN-STREAM errors as plain objects, not Error
        // instances — e.g. OpenAI Responses emits {type:'error', error:
        // {type:'insufficient_quota'}} mid-stream. String() on those yields
        // "[object Object]" in the event log (observed on prod 2026-07-15);
        // JSON.stringify keeps the diagnostic. Circular objects would make
        // stringify itself throw inside onError — fall back to String().
        let message: string;
        if (error instanceof Error) {
          message = error.message;
        } else if (typeof error === "object" && error !== null) {
          try {
            message = JSON.stringify(error);
          } catch {
            message = String(error);
          }
        } else {
          message = String(error);
        }
        // AI SDK's APICallError exposes the upstream HTTP status + raw response
        // body, but `error.message` is only the HTTP statusText (e.g. "Bad
        // Request"). Surface the body too so consumers (oma sessions logs /
        // console) can see the provider's actual diagnostic without having to
        // tail wrangler — most 4xx debugging starts and ends here.
        if (error && typeof error === "object" && "responseBody" in error) {
          const e = error as { statusCode?: number; responseBody?: string };
          if (e.statusCode || e.responseBody) {
            message = `${message} [${e.statusCode ?? "?"}] ${e.responseBody ?? ""}`;
          }
        }
        lastStreamErrorMessage = message;
        // No open span (error before the first step start, or a late error
        // after onStepFinish closed it) — the message is captured above for
        // the finishReason==="error" throw; there's just no span to close.
        if (!stepStartId) return;
        runtime.broadcast({
          type: "span.model_request_end",
          model: modelId,
          model_request_start_id: stepStartId,
          finish_reason: "error",
          final_text_length: 0,
          is_error: true,
          error_message: message.slice(0, 500),
          ...(llmLogCtx
            ? { body_r2_key: llmLogKey(llmLogCtx.tenant_id, llmLogCtx.session_id, stepStartId) }
            : {}),
        } as SessionEvent);
        stepStartId = null;
      },

      onAbort: () => {
        // User interrupt or AbortSignal trip. Same dangling-start problem as
        // onError. is_error stays false — abort is a normal control flow,
        // not a model failure.
        if (!stepStartId) return;
        runtime.broadcast({
          type: "span.model_request_end",
          model: modelId,
          model_request_start_id: stepStartId,
          finish_reason: "aborted",
          final_text_length: 0,
          is_error: false,
          ...(llmLogCtx
            ? { body_r2_key: llmLogKey(llmLogCtx.tenant_id, llmLogCtx.session_id, stepStartId) }
            : {}),
        });
        stepStartId = null;
        // Drain live chunk-stream registers same way the catch-around-
        // consumeStream below does. onAbort fires when the model emitted
        // its content cleanly but a follow-up await (finishReason / text /
        // step iteration) trips the abort signal — consumeStream itself
        // doesn't throw in that path, so the catch block doesn't run and
        // these stream lifecycles would be left half-open without us
        // emitting the *_stream_end markers here.
        if (currentMessageId) {
          void runtime.broadcastStreamEnd(currentMessageId, "aborted", "interrupted_mid_stream");
          currentMessageId = null;
        }
        for (const tid of liveThinking) {
          void runtime.broadcastThinkingEnd(tid, "aborted");
        }
        liveThinking.clear();
        for (const tid of liveToolInput) {
          void runtime.broadcastToolInputEnd(tid, "aborted");
        }
        liveToolInput.clear();
      },
    });
      // streamText returns a StreamTextResult; consumeStream forces the
      // pipeline to drain so onChunk + onStepFinish fully fire before
      // we read final fields.
      try {
        await r.consumeStream();
      } catch (err) {
        // Mid-stream abort (user.interrupt, abort signal trip). The
        // streams table has chunks accumulated so far; if we don't
        // finalize + persist as agent.message here, the partial text
        // sits at status='streaming' until cold-start recovery picks
        // it up. broadcastStreamEnd("aborted") does both: finalizes
        // the row AND appends agent.message with the partial (see
        // session-do.ts:broadcastStreamEnd) so the next turn's LLM
        // context includes what the model said before the cut.
        //
        // Re-throw so drainEventQueue's TurnAborted handling still
        // runs (status_idle, queue flush already happened in the
        // POST /event handler).
        //
        // Drain ALL three live-stream registers, not just the message
        // one — onStepFinish is the only place that drains thinking +
        // tool-input streams normally, but it doesn't run on abort. A
        // half-open thinking_stream_start without a matching
        // thinking_stream_end leaves the client's "Claude is thinking…"
        // bubble pulsing forever. Same for tool-input streams.
        if (currentMessageId) {
          await runtime.broadcastStreamEnd(currentMessageId, "aborted", "interrupted_mid_stream");
          currentMessageId = null;
        }
        for (const tid of liveThinking) {
          await runtime.broadcastThinkingEnd(tid, "aborted");
        }
        liveThinking.clear();
        for (const tid of liveToolInput) {
          await runtime.broadcastToolInputEnd(tid, "aborted");
        }
        liveToolInput.clear();
        throw err;
      }
      const finishReason = await r.finishReason;
      const finalText = await r.text;
      const toolCalls = await r.toolCalls;
      const toolResults = await r.toolResults;
      const usage = await r.usage;

      // Silent-stop detection: model returned with empty text + no tool
      // calls mid-conversation. Two flavors observed on MiniMax-M2:
      //   - finish_reason="stop"   — transient model hiccup
      //   - finish_reason="length" — runaway reasoning consumed the entire
      //     token budget without producing answer text or tool call
      //     (`sess-6o5qhaa3v1l5r82h` 2026-05-02: 20 KB of agent.thinking,
      //     0 chars final text). Without surfacing this as an error the
      //     turn looks "successful" but ships nothing to the user.
      // Throw so the failure is visible in events; the caller decides whether
      // to retry (current default-loop has no internal retry — the throw
      // propagates as a `unexpected` TurnError up to drainEventQueue).
      //
      // Scope: r.text / r.toolCalls describe the FINAL step only. A turn
      // whose earlier steps ran tools and streamed real text can still end
      // on one empty trailing step (observed on haiku wakeup turns
      // 2026-07-01, sess-w6jk4fppboterg3n: bash + summary shipped, then a
      // final empty step failed the whole work item). Only classify as
      // silent_stop when the ENTIRE turn shipped nothing.
      const steps = await r.steps;
      const turnShippedNothing = steps.every(
        (s) =>
          (!s.text || s.text.trim().length === 0)
          && (!s.toolCalls || s.toolCalls.length === 0),
      );
      if (
        (finishReason === "stop" || finishReason === "length")
        && turnShippedNothing
        && (!finalText || finalText.trim().length === 0)
        && (!toolCalls || toolCalls.length === 0)
      ) {
        // The current stream (if any) is bogus — abort it before retry mints a fresh id.
        if (currentMessageId) {
          await runtime.broadcastStreamEnd(currentMessageId, "aborted", "silent_stop");
        }
        // Throw as ModelError so processUserMessage's catch classifies
        // it as fatal (no retry). silent_stop is deterministic per
        // (model, prompt) — observed 2026-05-11 sess-y2bfxm1de4e1zqxm
        // burning 12 LLM calls retrying the same empty response 3x ×
        // 4 messages. classifyExternalError doesn't have a pattern
        // for it; we know the class at the throw site, just type it.
        throw new ModelError(
          `silent_stop: model returned finish_reason=${finishReason} with empty text and no tool calls`,
        );
      }
      // In-stream provider error that ended the stream (finish_reason=
      // "error"): streamText does NOT throw for these
      // — onError fires, consumeStream completes, and without this check
      // the turn "succeeds" with no reply and no session.error. The user
      // sees a session that just goes idle (observed 2026-07-15/16:
      // OpenAI insufficient_quota — "the model does not answer"). Throw
      // with the captured diagnostic so the machine emits session.error
      // and the console renders its error card.
      // Earlier successful tools do not make a later provider failure a
      // successful turn. Keep their durable events and surface the failure.
      if (finishReason === "error" || lastStreamErrorMessage) {
        if (currentMessageId) {
          await runtime.broadcastStreamEnd(currentMessageId, "aborted", "stream_error");
        }
        throw new ModelError(
          `model_stream_error: ${lastStreamErrorMessage ?? "provider stream ended in error with no output"}`,
        );
      }
      return { finishReason, text: finalText, toolCalls, toolResults, usage };
      } catch (err) {
        // Boundary: streamText + the read awaits above (finishReason /
        // text / toolCalls / usage) are the LLM-provider edge. Native
        // SDK errors (Anthropic 401/429/5xx, the `silent_stop` Error we
        // throw above, network failures during streamText's underlying
        // fetch) are remapped to typed OmaErrors here so
        // processUserMessage's catch dispatches by class (BillingError /
        // AuthError → fatal; everything else → retry-by-default) instead
        // of substring matching the message.
        // TODO: extend wrapper coverage to other boundaries as new
        // failure modes surface (D1 client, KV ops, MCP transport).
        throw classifyExternalError(err);
      } finally {
        // Any execute still parked on a gate whose tool-call part never
        // made it through the observer (stream error / abort) must not run.
        gates.closeAll(new Error("stream ended before the tool call was durably recorded; not executed"));
        const totalElapsed = Date.now() - streamStartedAt;
        console.log(`[stream] streamText END elapsed=${totalElapsed}ms`);
      }
    })();


    // 8. Detect pending tool confirmations and custom tool results
    if (result.toolCalls?.length) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resultedIds = new Set((result.toolResults as any[])?.map((r: any) => r.toolCallId) ?? []);
      const pending = result.toolCalls
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .filter((c: any) => !resultedIds.has(c.toolCallId))
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((c: any) => c.toolCallId);
      if (pending.length && ctx.runtime.pendingConfirmations) {
        ctx.runtime.pendingConfirmations.push(...pending);
      }
    }

    // 9. Per-step model_request span pairs are emitted in onStepFinish above.
    //    The aggregate-around-streamText pair that used to live here was
    //    removed — Anthropic's wire format puts model_usage at per-call
    //    granularity, so we track it the same way. The session state still
    //    aggregates total token spend below via reportUsage(result.usage).

    // 10. Report token usage
    if (result.usage && runtime.reportUsage) {
      await runtime.reportUsage(
        result.usage.inputTokens ?? 0,
        result.usage.outputTokens ?? 0
      );
    }
  }

  // -- Default hook implementations --
  // Custom harnesses can override any of these by extending DefaultHarness
  // and replacing the method, or by implementing HarnessInterface directly.

  /**
   * Default: async eventsToMessagesAsync (byte-deterministic + handles
   * agent.thread_context_compacted boundary + resolves file_id sources via
   * the supplied fileFetcher). Override for sliding window / RAG /
   * hierarchical strategies.
   */
  deriveModelContext(
    events: SessionEvent[],
    opts?: { fileFetcher?: FileResolver },
  ): Promise<ModelMessage[]> {
    return eventsToMessagesAsync(events, opts?.fileFetcher);
  }

  /**
   * Default: delegate to this.compactionStrategy (configured in run() from
   * agent.metadata overrides). Custom harnesses can override by extending
   * DefaultHarness and replacing this method.
   */
  shouldCompact(events: SessionEvent[], ctx: { contextWindowTokens: number }): boolean {
    return this.compactionStrategy.shouldCompact(events, ctx);
  }

  /**
   * Default: run this.compactionStrategy.compact and broadcast the result
   * as an `agent.thread_context_compacted` event with the summary attached.
   * eventsToMessages then honors the boundary marker on subsequent derives.
   *
   * Threads systemPrompt + tools + the provider cache strategy through to
   * the strategy so it can build a same-shape request that matches main
   * agent's prefix bytes (cache reuse).
   */
  async compact(
    events: SessionEvent[],
    runtime: HarnessRuntime,
    ctx: { model: LanguageModel; systemPrompt: string; tools: Record<string, any> },
  ): Promise<void> {
    const ctxWindow = resolveContextWindowTokens(ctx.model);
    const result = await this.compactionStrategy.compact(events, {
      model: ctx.model,
      contextWindowTokens: ctxWindow,
      systemPrompt: ctx.systemPrompt,
      tools: ctx.tools,
      applyCacheStrategy: (sys, tls, msgs) => applyProviderCacheStrategy(ctx.model, sys, tls, msgs),
      runtime,
    });
    if (!result) return;

    // Empty-summary defense (upstream layer). If a strategy returns a
    // result whose summary contains no actual text, do NOT broadcast the
    // boundary event. Otherwise eventsToMessages would later "honor" the
    // empty boundary and silently drop the entire pre-boundary history.
    //
    // Observed in the wild on MiniMax: model returns finish_reason="tool-calls"
    // with empty text → SummarizeCompactionStrategy returns
    // summary=[{type:"text", text:""}] → boundary written → next derive
    // tosses 60 turns of conversation. The new cc-style / opencode-style
    // strategies catch this themselves (return null) but the legacy
    // `summarize` strategy does not, so this layer is the safety net for
    // any strategy that doesn't self-defend.
    const hasContent = result.summary?.some(
      (b) => (b.type === "text" && b.text.trim().length > 0)
        || b.type === "image"
        || b.type === "document",
    );
    if (!hasContent) {
      console.warn("[compact] strategy produced empty summary — skipping boundary write");
      return;
    }

    runtime.broadcast({
      type: "agent.thread_context_compacted",
      original_message_count: result.original_message_count,
      compacted_message_count: result.compacted_message_count,
      summary: result.summary,
      trigger: "auto",
      pre_tokens: result.pre_tokens,
    });
  }

  /**
   * No-op. Pre-2026-05-17 this wrote each `platformReminder` as a
   * `<system-reminder>` user.message event so Claude would treat the
   * skill body as user-side context. Operators objected: skill bodies
   * leaked into the visible chat feed and polluted the event log even
   * though the content is static per session.
   *
   * Reminders now flow into the system prompt directly — see
   * `composeSystemPrompt(rawSystemPrompt, platformReminders)` in
   * `session-do.ts`. Each reminder is wrapped in
   * `<source name="…">…</source>` inside the system prompt, so the
   * model still has structural cues about which skill/memory each
   * chunk came from.
   *
   * Custom harnesses that DO want the legacy behavior (e.g. a RAG
   * loop that materializes skills only after retrieving them) can
   * override this method and broadcast their own user.message events.
   */
  async onSessionInit(_ctx: HarnessContext, _runtime: HarnessRuntime): Promise<void> {
    // intentionally empty — see jsdoc
  }
}

// === Token estimation + context-window resolution ===
// Both are best-effort heuristics. The bijection itself doesn't depend on
// these — they only drive WHEN to compact, not what the model sees.

/** Crude: 4 chars ≈ 1 token. Fine for compaction trigger; not for billing. */
function estimateMessageTokens(m: ModelMessage): number {
  const s = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
  return Math.ceil(s.length / 4);
}

function estimateMessagesTokens(messages: ModelMessage[]): number {
  let total = 0;
  for (const m of messages) total += estimateMessageTokens(m);
  return total;
}

/**
 * Map a LanguageModel to its context window in tokens. ai-sdk doesn't
 * expose this uniformly, so we hand-encode the common cases. Fallback to
 * 200K (Claude 4+ minimum) if unknown.
 */
function resolveContextWindowTokens(model: LanguageModel): number {
  const id = (model as any)?.modelId ?? (typeof model === "string" ? model : "");
  if (typeof id !== "string") return 200_000;
  if (id.includes("opus-4-8") || id.includes("opus-4-7") || id.includes("opus-4-6") || id.includes("sonnet-4-6")) return 1_000_000;
  if (id.includes("haiku-4-5")) return 200_000;
  if (id.includes("opus") || id.includes("sonnet")) return 200_000;
  if (id.includes("MiniMax")) return 1_000_000;
  return 200_000;
}

// === Provider-specific prompt cache strategy ===
//
// AI SDK has no provider-agnostic cache abstraction. Each provider exposes
// its own knobs via providerOptions, so we branch on model.provider:
//   anthropic: cache_control breakpoints on system / last tool / mid / last msg
//   openai:    automatic on the API side (no client-side knob to set)
//   google:    cachedContent (different model — explicit cache resource creation)
//   others:    no-op
//
// Adding a provider later: add a case below; the calling harness code
// doesn't change.

interface CacheStrategyResult {
  system: string | SystemModelMessage | SystemModelMessage[];
  tools: Record<string, any>;
  messages: ModelMessage[];
}

function applyProviderCacheStrategy(
  model: LanguageModel,
  systemPrompt: string,
  tools: Record<string, any>,
  messages: ModelMessage[],
): CacheStrategyResult {
  const provider = (model as any)?.provider as string | undefined;
  if (typeof provider === "string" && provider.toLowerCase().includes("anthropic")) {
    return applyAnthropicCacheControl(systemPrompt, tools, messages);
  }
  // No-op for other providers — system stays a string, no providerOptions
  // injected, no message mutation. Add cases here when wiring OpenAI /
  // Gemini / MiniMax cache support.
  return { system: systemPrompt, tools, messages };
}

/**
 * Anthropic prompt-cache strategy — up to 4 breakpoints per request.
 *
 * Render order is tools → system → messages. Marks (in priority order):
 *  1. `system` — promote string → SystemModelMessage with cacheControl.
 *     Caches both `tools` (everything before system in the prefix) and
 *     `system` itself.
 *  2. last `tool` — covers the tool block alone if system also contained
 *     dynamic content (defensive — system change shouldn't shift tools).
 *  3. last `message` — the conversation tail breakpoint. Most cache hits
 *     come from this on multi-turn chats.
 *  4. mid-conversation `message` — only if messages.length > 30. Anthropic's
 *     20-block lookback window means long single turns blow past the
 *     boundary; an intermediate breakpoint catches reads inside the turn.
 *
 * All marker bytes are stable (cacheControl object is identical across
 * turns), so adding them doesn't itself bust cache.
 */
function applyAnthropicCacheControl(
  systemPrompt: string,
  tools: Record<string, any>,
  messages: ModelMessage[],
): CacheStrategyResult {
  const ephemeral = { anthropic: { cacheControl: { type: "ephemeral" } } };

  // (1) System block as cached SystemModelMessage. Required for system to
  // cache at all — string-form `system` is wrapped by the provider with no
  // providerOptions, which means cache_control is omitted on the wire.
  //
  // Skip the cache_control wrapper when systemPrompt is empty: Anthropic's
  // API rejects `cache_control` on empty text blocks ("system.0:
  // cache_control cannot be set for empty text blocks"), and an empty
  // system isn't worth caching anyway. Pass the empty string through —
  // the SDK omits the system block entirely when given an empty string,
  // which is the desired wire shape.
  const system: SystemModelMessage | string = systemPrompt
    ? { role: "system", content: systemPrompt, providerOptions: ephemeral }
    : systemPrompt;

  // (2) Tools: tag the LAST tool's providerOptions so the entire tools
  // block becomes a 2nd cache breakpoint.
  const toolNames = Object.keys(tools);
  let cachedTools: Record<string, any> = tools;
  if (toolNames.length > 0) {
    const lastName = toolNames[toolNames.length - 1];
    const lastTool = tools[lastName];
    cachedTools = {
      ...tools,
      [lastName]: {
        ...lastTool,
        providerOptions: { ...(lastTool?.providerOptions ?? {}), ...ephemeral },
      },
    };
  }

  // (3) Last 1 message — Claude Code style.
  const cachedMessages: ModelMessage[] = messages.map((m) => ({ ...m }));
  if (cachedMessages.length > 0) {
    const last = cachedMessages[cachedMessages.length - 1] as any;
    last.providerOptions = { ...(last.providerOptions ?? {}), ...ephemeral };
  }

  return { system, tools: cachedTools, messages: cachedMessages };
}
