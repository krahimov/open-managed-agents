/**
 * PiHarness — HarnessInterface implementation that drives the model loop
 * with Pi's agent runtime (`@earendil-works/pi-agent-core` agent loop over
 * `@earendil-works/pi-ai` providers) instead of the Vercel AI SDK.
 *
 * Contract with the platform is identical to DefaultHarness:
 *   - stateless: each run() re-derives the transcript from the OMA event
 *     log (runtime/history.ts projection → pi messages), so crash recovery
 *     and harness switching work unchanged;
 *   - tools: ctx.tools (platform-built AI SDK tools) are adapted 1:1 and
 *     executed through their own `execute` (sandbox / vault / policy);
 *     tools without execute surface as requires_action via
 *     runtime.pendingConfirmations;
 *   - events: same wire shapes as DefaultHarness — built by the SAME
 *     functions (default-loop `toolCallEvents` / `toolResultEvents`) —
 *     plus live stream lifecycle via runtime.broadcast{Stream,Thinking,
 *     ToolInput}*. session.status_* stays with the platform;
 *   - durable execution (docs/durable-execution.md), reusing
 *     durable-tools.ts: orphaned tool calls are reconciled before the first
 *     model call; when an assistant message completes, its thinking/text and
 *     every tool_use (idempotency_key + execution_class +
 *     model_request_start_id) are persisted with the awaited
 *     `runtime.persist` BEFORE pi executes any tool (pi's loop awaits the
 *     event sink, and the write-ahead execute wrapper additionally gates on
 *     the tool_use being durable); each tool_result is persisted by the
 *     wrapper the moment that tool settles.
 *
 * Runs on Node (main-node) and on Workers: the pieces used here
 * (pi-agent-core's loop + pi-ai's anthropic/openai API modules) contain no
 * static node: imports and fall back to interpreted schema validation when
 * eval is unavailable.
 */

import type { AssistantMessage, AssistantMessageEvent, Message, ToolCall } from "@earendil-works/pi-ai";
import { createInitialSystemMessage, toToolDeclaration } from "@earendil-works/pi-ai";
import { runAgentLoopContinue } from "@earendil-works/pi-agent-core";
import type { AgentEvent, AgentLoopConfig, AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import type { ToolSet } from "ai";
import type { AgentConfig, SessionEvent } from "@open-managed-agents/shared";
import { classifyExternalError, generateEventId, ModelError, OmaError } from "@open-managed-agents/shared";
import { classifyTool, idempotencyKeyFor } from "@open-managed-agents/session-runtime";
import type { HarnessContext, HarnessInterface, HarnessRuntime } from "../interface";
import { eventsToMessagesAsync } from "../../runtime/history";
import { toolCallEvents, toolResultEvents } from "../default-loop";
import {
  ToolUseGates,
  mergePersistedResults,
  reconcileOrphanedToolCalls,
  wrapToolsWriteAhead,
  type ToolSettlement,
} from "../durable-tools";
import { resolveCompactionStrategy } from "../compaction";
import { OPENAI_MAX_TOOLS, applyToolBudget } from "../tool-budget";
import { credentialsFromLanguageModel, resolvePiModel, type PiModelCredentials, type ResolvedPiModel } from "./model";
import { ensureContinuableTail, modelMessagesToPi, providerOptionsFromThinking } from "./messages";
import { adaptOmaTools, piContentToWire, type AdaptedTools, type OmaToolDetails } from "./tools";

export interface PiHarnessOptions {
  /**
   * Resolve raw model credentials for an agent (model card → api key, base
   * url, compat, headers). main-node passes resolveNodeModelCredentials.
   * When absent, credentials are recovered from ctx.model (AI SDK) and
   * finally from ctx.env.ANTHROPIC_API_KEY.
   */
  resolveCredentials?: (agent: AgentConfig, tenantId: string) => Promise<PiModelCredentials>;
  /** Hard cap on model requests per run (DefaultHarness: stepCountIs(100)). */
  maxSteps?: number;
  /** Test seam: replace model resolution entirely (e.g. pi-ai's faux provider). */
  resolveModel?: (ctx: HarnessContext) => Promise<ResolvedPiModel> | ResolvedPiModel;
}

type Persist = (event: SessionEvent) => Promise<void>;

/** pi StopReason → the finish_reason vocabulary default-loop reports (AI SDK). */
function finishReasonOf(stop: AssistantMessage["stopReason"]): string {
  switch (stop) {
    case "toolUse":
      return "tool-calls";
    default:
      return String(stop);
  }
}

async function resolveCredentialsFor(ctx: HarnessContext, opts: PiHarnessOptions): Promise<PiModelCredentials> {
  if (opts.resolveCredentials) {
    return opts.resolveCredentials(ctx.agent, ctx.tenant_id ?? "default");
  }
  const fromModel = await credentialsFromLanguageModel(ctx.model);
  if (fromModel) return fromModel;
  if (ctx.env?.ANTHROPIC_API_KEY) {
    const id = typeof ctx.agent.model === "string" ? ctx.agent.model : ctx.agent.model.id;
    return { model: id, apiKey: ctx.env.ANTHROPIC_API_KEY, baseURL: ctx.env.ANTHROPIC_BASE_URL, apiCompat: "ant" };
  }
  throw new Error("pi harness: could not resolve model credentials for this agent");
}

export interface PiEventBridgeOptions {
  sessionId?: string;
  modelLabel: string;
  tools: AdaptedTools;
  /** Durable (awaited) write path. */
  persist: Persist;
  gates: ToolUseGates;
  /** OMA tool lookup, for execution-class classification. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  omaTools: Record<string, any>;
}

/**
 * Translates pi AgentEvents into OMA session events. One instance per run.
 * The sink is awaited by pi's loop, so canonical writes here are ordered
 * strictly before the next loop phase (tool preflight / execution).
 */
export class PiEventBridge {
  /** Live stream ids keyed by assistant contentIndex, reset per request. */
  private textIds = new Map<number, string>();
  private thinkingIds = new Map<number, string>();
  private toolInputIds = new Map<number, string>();
  private spanId: string | null = null;
  private sawFirstChunk = false;

  /** tool_use events made durable this run (write-ahead gate state). */
  readonly writeAheadToolUses = new Set<string>();
  /** tool calls whose result events are persisted (by the wrapper or here). */
  readonly persistedResults = new Set<string>();

  steps = 0;
  shippedSomething = false;
  lastAssistant: AssistantMessage | null = null;
  /** Tool calls that need confirmation / a client result, in this run. */
  pending: string[] = [];
  /** Pending calls added since the last finishTurn check. */
  pendingThisTurn = 0;
  usage = { input: 0, output: 0 };

  constructor(
    private runtime: HarnessRuntime,
    private opts: PiEventBridgeOptions,
  ) {}

  /** Persist a settled tool call's result events once (shared with the wrapper). */
  persistSettlement = async (s: ToolSettlement): Promise<SessionEvent[]> => {
    if (this.persistedResults.has(s.toolCallId)) return [];
    this.persistedResults.add(s.toolCallId);
    const events = toolResultEvents(s);
    try {
      for (const e of events) await this.opts.persist(e);
    } catch (err) {
      this.persistedResults.delete(s.toolCallId);
      throw err;
    }
    return events;
  };

  /** Called by the stream-function wrapper right before each provider request. */
  onRequestStart(): void {
    this.spanId = generateEventId();
    this.sawFirstChunk = false;
    this.textIds.clear();
    this.thinkingIds.clear();
    this.toolInputIds.clear();
    this.runtime.broadcast({
      type: "span.model_request_start",
      id: this.spanId,
      model: this.opts.modelLabel,
    } as SessionEvent);
  }

  handle = async (event: AgentEvent): Promise<void> => {
    switch (event.type) {
      case "message_update":
        await this.onUpdate(event.assistantMessageEvent);
        return;
      case "message_end":
        if (event.message.role === "assistant") await this.onAssistantEnd(event.message as AssistantMessage);
        return;
      case "tool_execution_end":
        await this.onToolEnd(event.toolCallId, event.toolName, event.result, event.isError);
        return;
      default:
        return;
    }
  };

  private async onUpdate(ev: AssistantMessageEvent): Promise<void> {
    const rt = this.runtime;
    if (!this.sawFirstChunk && this.spanId) {
      this.sawFirstChunk = true;
      rt.broadcast({
        type: "span.model_first_token",
        model: this.opts.modelLabel,
        model_request_start_id: this.spanId,
      } as SessionEvent);
    }
    switch (ev.type) {
      case "text_start":
      case "text_delta": {
        let id = this.textIds.get(ev.contentIndex);
        if (!id) {
          id = generateEventId();
          this.textIds.set(ev.contentIndex, id);
          await rt.broadcastStreamStart(id);
        }
        if (ev.type === "text_delta" && ev.delta) await rt.broadcastChunk(id, ev.delta);
        return;
      }
      case "thinking_start":
      case "thinking_delta": {
        let id = this.thinkingIds.get(ev.contentIndex);
        if (!id) {
          id = generateEventId();
          this.thinkingIds.set(ev.contentIndex, id);
          await rt.broadcastThinkingStart(id);
        }
        if (ev.type === "thinking_delta" && ev.delta) await rt.broadcastThinkingChunk(id, ev.delta);
        return;
      }
      case "toolcall_start":
      case "toolcall_delta": {
        let id = this.toolInputIds.get(ev.contentIndex);
        if (!id) {
          const block = ev.partial.content[ev.contentIndex] as ToolCall | undefined;
          id = block?.id || generateEventId();
          this.toolInputIds.set(ev.contentIndex, id);
          await rt.broadcastToolInputStart(id, block?.name ? this.opts.tools.toOma(block.name) : undefined);
        }
        if (ev.type === "toolcall_delta" && ev.delta) await rt.broadcastToolInputChunk(id, ev.delta);
        return;
      }
      default:
        return;
    }
  }

  private async closeLiveStreams(status: "completed" | "aborted", reason?: string): Promise<void> {
    const rt = this.runtime;
    for (const id of this.textIds.values()) await rt.broadcastStreamEnd(id, status, reason);
    for (const id of this.thinkingIds.values()) await rt.broadcastThinkingEnd(id, status);
    for (const id of this.toolInputIds.values()) await rt.broadcastToolInputEnd(id, status);
    this.textIds.clear();
    this.thinkingIds.clear();
    this.toolInputIds.clear();
  }

  private async onAssistantEnd(msg: AssistantMessage): Promise<void> {
    const rt = this.runtime;
    const persist = this.opts.persist;
    const stepId = this.spanId ?? undefined;
    const stepTag = stepId ? { model_request_start_id: stepId } : {};
    this.steps++;
    this.lastAssistant = msg;
    this.usage.input += msg.usage.input + msg.usage.cacheRead + msg.usage.cacheWrite;
    this.usage.output += msg.usage.output;

    if (msg.stopReason === "error" || msg.stopReason === "aborted") {
      // Partial output of a failed/aborted request is not committed as
      // canonical events: broadcastStreamEnd("aborted") lets the runtime
      // finalize whatever text streamed (same as default-loop's abort path).
      await this.closeLiveStreams(
        "aborted",
        msg.stopReason === "aborted" ? "interrupted_mid_stream" : "stream_error",
      );
    } else {
      for (let i = 0; i < msg.content.length; i++) {
        const block = msg.content[i];
        if (block.type === "thinking") {
          const tid = this.thinkingIds.get(i);
          if (tid) {
            await rt.broadcastThinkingEnd(tid, "completed");
            this.thinkingIds.delete(i);
          }
          if (!block.thinking && !block.thinkingSignature) continue;
          const providerOptions = providerOptionsFromThinking(block, msg.api);
          await persist({
            type: "agent.thinking",
            text: block.thinking,
            ...(providerOptions ? { providerOptions } : {}),
            ...(tid ? { thinking_id: tid } : {}),
            ...stepTag,
          } as SessionEvent);
        } else if (block.type === "text") {
          const sid = this.textIds.get(i);
          this.textIds.delete(i);
          // Trailing-whitespace trim matches default-loop (prompt-cache byte stability).
          const text = block.text.replace(/\s+$/, "");
          if (sid) await rt.broadcastStreamEnd(sid, "completed");
          if (!text) continue;
          this.shippedSomething = true;
          await persist({
            type: "agent.message",
            message_id: sid ?? generateEventId(),
            content: [{ type: "text", text }],
            ...stepTag,
          } as SessionEvent);
        } else if (block.type === "toolCall") {
          const iid = this.toolInputIds.get(i);
          if (iid) {
            await rt.broadcastToolInputEnd(iid, "completed");
            this.toolInputIds.delete(i);
          }
          this.shippedSomething = true;
          await this.writeAheadToolUse(block, stepId);
        }
      }
      // Anything still open never paired with a final block.
      await this.closeLiveStreams("aborted");
    }

    if (this.spanId) {
      rt.broadcast({
        type: "span.model_request_end",
        model: this.opts.modelLabel,
        model_request_start_id: this.spanId,
        provider_response_id: msg.responseId,
        model_usage: {
          // Same semantics as default-loop (AI SDK inputTokens = total incl. cache).
          input_tokens: msg.usage.input + msg.usage.cacheRead + msg.usage.cacheWrite,
          output_tokens: msg.usage.output,
          cache_read_input_tokens: msg.usage.cacheRead,
          cache_creation_input_tokens: msg.usage.cacheWrite,
        },
        finish_reason: finishReasonOf(msg.stopReason),
        final_text_length: msg.content
          .filter((c) => c.type === "text")
          .reduce((n, c) => n + (c as { text: string }).text.length, 0),
        is_error: msg.stopReason === "error",
        ...(msg.errorMessage ? { error_message: msg.errorMessage.slice(0, 500) } : {}),
      } as SessionEvent);
      this.spanId = null;
    }
  }

  /**
   * Write-ahead: persist the tool_use (classified + keyed exactly like
   * default-loop) and only then open the execution gate. If the write
   * fails, the gate fails and the tool never runs.
   */
  private async writeAheadToolUse(call: ToolCall, stepId: string | undefined): Promise<void> {
    const toolName = this.opts.tools.toOma(call.name);
    const t = this.opts.omaTools[toolName];
    const hasExecute = typeof t?.execute === "function";
    try {
      const events = toolCallEvents(
        { toolCallId: call.id, toolName, input: call.arguments ?? {} },
        {
          idempotency_key: idempotencyKeyFor(this.opts.sessionId, call.id),
          execution_class: classifyTool(toolName, { hasExecute, annotations: t?.annotations }),
          model_request_start_id: stepId,
          pending: !hasExecute,
        },
      );
      for (const e of events) await this.opts.persist(e);
      this.writeAheadToolUses.add(call.id);
      this.opts.gates.open(call.id);
    } catch (err) {
      this.opts.gates.fail(call.id, err);
      throw err;
    }
  }

  private async onToolEnd(toolCallId: string, wireName: string, result: unknown, isError: boolean): Promise<void> {
    const r = (result ?? {}) as { content?: Parameters<typeof piContentToWire>[0]; details?: OmaToolDetails };
    if (r.details?.oma_pending) {
      this.pending.push(toolCallId);
      this.pendingThisTurn++;
      return;
    }
    // Normal path: the write-ahead wrapper already persisted the result.
    if (this.persistedResults.has(toolCallId)) return;
    // Calls that never reached execute (schema validation failure, unknown
    // tool, abort) or whose wrapper-side persist failed.
    const toolName = this.opts.tools.toOma(wireName);
    const wire = r.details?.oma_wire ?? piContentToWire(r.content);
    await this.persistSettlement(
      isError
        ? { type: "tool-error", toolCallId, toolName, error: typeof wire === "string" ? wire : JSON.stringify(wire) }
        : { type: "tool-result", toolCallId, toolName, output: wire },
    );
  }
}

export class PiHarness implements HarnessInterface {
  constructor(private opts: PiHarnessOptions = {}) {}

  async run(ctx: HarnessContext): Promise<void> {
    const run = () => this.#run(ctx);
    // CF: hold the Durable Object alive for the whole loop.
    await (ctx.runtime.keepAliveWhile ? ctx.runtime.keepAliveWhile(run) : run());
  }

  async #run(ctx: HarnessContext): Promise<void> {
    const { agent, runtime, userMessage } = ctx;
    const sessionId = ctx.session_id;
    const modelLabel = typeof agent.model === "string" ? agent.model : agent.model.id;
    const persist: Persist = runtime.persist
      ? (event) => runtime.persist!(event)
      : async (event) => { runtime.broadcast(event); };

    // Primary-thread turns don't see sub-agent thread events (same filter as
    // default-loop — they would land between a call_agent tool_use and its result).
    const turnThread = (userMessage as { session_thread_id?: string } | undefined)?.session_thread_id;
    const visibleEvents = (): SessionEvent[] => {
      const all = runtime.history.getEvents();
      if (turnThread && turnThread !== "sthr_primary") return all;
      return all.filter((e) => {
        const t = (e as { session_thread_id?: string }).session_thread_id;
        return t == null || t === "sthr_primary";
      });
    };

    let omaTools = (ctx.tools ?? {}) as Record<string, unknown>;

    // 0. Resolve tool calls an interrupted run left without a result.
    const reconciled = await reconcileOrphanedToolCalls({
      events: visibleEvents(),
      tools: omaTools,
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

    const resolved = this.opts.resolveModel
      ? await this.opts.resolveModel(ctx)
      : resolvePiModel(await resolveCredentialsFor(ctx, this.opts), {
          reasoningLevel: agent.reasoning_level,
          hasTools: Object.keys(omaTools).length > 0,
        });

    // 1. Compaction — reuse the platform strategies (they summarize with
    //    ctx.model via the AI SDK and persist agent.thread_context_compacted,
    //    which the history projection below honors).
    await this.#maybeCompact(ctx, resolved.model.contextWindow);

    // 2. OpenAI's 128-tool cap — same budget default-loop applies.
    if (resolved.openAiToolNames && Object.keys(omaTools).length > OPENAI_MAX_TOOLS) {
      const budget = applyToolBudget(omaTools as ToolSet, {
        maxTools: OPENAI_MAX_TOOLS,
        serverOrder: (agent.mcp_servers ?? []).map((s) => s.name).filter(Boolean) as string[],
      });
      omaTools = budget.tools as Record<string, unknown>;
      runtime.broadcast({
        type: "session.warning",
        source: "tool_budget",
        message: `Model accepts at most ${OPENAI_MAX_TOOLS} tools; deferred ${budget.deferred.size} MCP tools.`,
      } as SessionEvent);
    }

    // 3. Durable tool wrappers + pi adapters.
    const gates = new ToolUseGates();
    let bridge!: PiEventBridge;
    const wrapped = wrapToolsWriteAhead(omaTools, {
      sessionId,
      gates,
      isToolUsePersisted: (id) => bridge.writeAheadToolUses.has(id),
      persistResult: (s) => bridge.persistSettlement(s),
    });
    const tools = await adaptOmaTools(wrapped as never, { openAiToolNames: resolved.openAiToolNames });
    bridge = new PiEventBridge(runtime, {
      sessionId,
      modelLabel,
      tools,
      persist,
      gates,
      omaTools: omaTools as never,
    });

    // 4. Transcript — rebuilt from the event log every turn.
    const contextEvents = mergePersistedResults(visibleEvents(), reconciled.extraEvents);
    const history = await eventsToMessagesAsync(contextEvents, ctx.fileFetcher);
    const transcript = ensureContinuableTail(
      modelMessagesToPi(history, { model: resolved.model, toolName: tools.toWire }),
    );
    // Leading system message declares prompt + tools exactly as the loop
    // expects, so it inserts no tool-delta system message mid-transcript.
    const system = createInitialSystemMessage(
      ctx.systemPrompt || undefined,
      tools.tools.map((t) => toToolDeclaration(t)),
    );
    const messages: AgentMessage[] = system ? [system, ...transcript] : transcript;

    // 5. Run pi's agent loop.
    const maxSteps = this.opts.maxSteps ?? 100;
    const streamFn: StreamFn = (model, context, options) => {
      bridge.onRequestStart();
      return resolved.streamFn(model, context, options);
    };
    const config: AgentLoopConfig = {
      model: resolved.model,
      apiKey: resolved.apiKey,
      ...(resolved.reasoning ? { reasoning: resolved.reasoning } : {}),
      ...(resolved.samplingParams ? { samplingParams: resolved.samplingParams } : {}),
      ...(sessionId ? { sessionId } : {}),
      cacheRetention: "short",
      convertToLlm: (msgs) => msgs as Message[],
      toolExecution: "parallel",
      finishTurn: ({ message }) => {
        if (message.stopReason === "error" || message.stopReason === "aborted") return undefined;
        if (bridge.pendingThisTurn > 0) {
          bridge.pendingThisTurn = 0;
          return { action: "end" };
        }
        if (bridge.steps >= maxSteps) return { action: "end" };
        return undefined;
      },
    };

    const signal = runtime.abortSignal;
    const startedAt = Date.now();
    try {
      await runAgentLoopContinue({ messages, tools: tools.tools }, config, bridge.handle, signal, streamFn);
    } finally {
      gates.closeAll(new Error("pi loop ended"));
      console.log(`[pi] loop END steps=${bridge.steps} elapsed=${Date.now() - startedAt}ms`);
    }

    // 6. Outcome handling (mirrors default-loop).
    if (bridge.pending.length > 0 && runtime.pendingConfirmations) {
      runtime.pendingConfirmations.push(...bridge.pending);
    }
    if (bridge.usage.input + bridge.usage.output > 0 && runtime.reportUsage) {
      await runtime.reportUsage(bridge.usage.input, bridge.usage.output);
    }

    const last = bridge.lastAssistant;
    if (signal?.aborted || last?.stopReason === "aborted") {
      const reason = signal?.reason;
      throw reason instanceof Error ? reason : new DOMException("The operation was aborted.", "AbortError");
    }
    if (last?.stopReason === "error") {
      const raw = last.errorMessage ?? "provider stream ended in error with no output";
      const classified = classifyExternalError(new Error(raw));
      throw classified instanceof OmaError ? classified : new ModelError(`model_stream_error: ${raw}`);
    }
    if (last && (last.stopReason === "stop" || last.stopReason === "length") && !bridge.shippedSomething) {
      throw new ModelError(
        `silent_stop: model returned finish_reason=${last.stopReason} with empty text and no tool calls`,
      );
    }
  }

  async #maybeCompact(ctx: HarnessContext, contextWindowTokens: number): Promise<void> {
    const meta = (ctx.agent.metadata ?? {}) as Record<string, unknown>;
    const num = (k: string) => (typeof meta[k] === "number" ? (meta[k] as number) : undefined);
    const strategy = resolveCompactionStrategy(
      typeof meta.compaction_strategy === "string" ? meta.compaction_strategy : undefined,
      {
        tailMinTokens: num("compaction_tail_min_tokens"),
        tailMaxTokens: num("compaction_tail_max_tokens"),
        tailMinMessages: num("compaction_tail_min_messages"),
        triggerFraction: num("compaction_trigger_fraction"),
      },
    );
    const events = ctx.runtime.history.getEvents();
    if (!strategy.shouldCompact(events, { contextWindowTokens })) return;
    try {
      const result = await strategy.compact(events, {
        model: ctx.model,
        contextWindowTokens,
        systemPrompt: ctx.systemPrompt,
        tools: ctx.tools,
        applyCacheStrategy: (system, tools, messages) => ({ system, tools, messages }),
        runtime: ctx.runtime,
      });
      const hasContent = result?.summary?.some(
        (b) => (b.type === "text" && b.text.trim().length > 0) || b.type === "image" || b.type === "document",
      );
      if (!result || !hasContent) return;
      ctx.runtime.broadcast({
        type: "agent.thread_context_compacted",
        original_message_count: result.original_message_count,
        compacted_message_count: result.compacted_message_count,
        summary: result.summary,
        trigger: "auto",
        pre_tokens: result.pre_tokens,
      } as SessionEvent);
    } catch (err) {
      console.warn(`[pi compact] failed: ${(err as Error).message}`);
    }
  }
}
