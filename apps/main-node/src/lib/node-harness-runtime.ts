// NodeHarnessRuntime — implements the apps/agent HarnessRuntime port for the
// self-host Node host. Maps the harness's broadcast/history/sandbox calls onto
// the SqlEventLog + EventStreamHub + a stub SandboxExecutor.
//
// Phase B-harness scope: text-only completion. The stub SandboxExecutor
// throws on every method, which is fine if the agent's tool config doesn't
// register sandbox-dependent tools (bash, read, write, edit, glob, grep).
// Phase C-sandbox swaps the stub for E2B / docker / whatever.

import type { ModelMessage } from "ai";
import type {
  HarnessRuntime,
  HistoryStore,
  SandboxExecutor,
} from "@open-managed-agents/agent/harness/interface";
import type { SessionEvent } from "@open-managed-agents/shared";
import type { SqlEventLog } from "@open-managed-agents/event-log/sql";
import { eventsToMessages } from "@open-managed-agents/agent/runtime/history";
import { getLogger } from "@open-managed-agents/observability";
import type { EventStreamHub } from "./event-stream-hub";

const log = getLogger("node-harness");

/**
 * HistoryStore backed by a SqlEventLog. The interface is sync (matches the
 * CF DO contract); we call refresh() before each turn so the cache is
 * current. Adapt() returns the cached events; mutations via broadcast
 * persist to SQL and refresh the cache so subsequent getEvents reflect them.
 */
class SqlHistoryStore implements HistoryStore {
  private cache: SessionEvent[] = [];
  constructor(private log: SqlEventLog) {}

  async refresh(): Promise<void> {
    this.cache = await this.log.getEventsAsync();
  }

  appendInPlace(event: SessionEvent): void {
    // Mark with a tentative seq so eventsToMessages projection is stable.
    // The persisted seq from SQL may differ; we re-refresh after the turn.
    this.cache.push(event);
  }

  // ── HistoryStore ────────────────────────────────────────────────────────
  append(event: SessionEvent): void {
    this.cache.push(event);
  }
  getEvents(afterSeq?: number): SessionEvent[] {
    if (afterSeq === undefined) return this.cache.slice();
    return this.cache.filter((e) => (e as { seq?: number }).seq! > afterSeq);
  }
  getMessages(): ModelMessage[] {
    return eventsToMessages(this.cache);
  }
}

export interface NodeHarnessRuntimeOptions {
  sessionId: string;
  log: SqlEventLog;
  hub: EventStreamHub;
  /** Sandbox to use for tool execution. Caller picks the implementation:
   *  LocalSubprocessSandbox for local dev, E2BSandbox / CloudflareSandbox
   *  in production. */
  sandbox: SandboxExecutor;
  /** Turn abort (user.interrupt / lease loss) from SessionStateMachine. */
  abortSignal?: AbortSignal;
}

export class NodeHarnessRuntime implements HarnessRuntime {
  history: SqlHistoryStore;
  sandbox: SandboxExecutor;
  /** Tool calls the harness left without a result (always_ask / custom
   *  tools). DefaultHarness only records them when this array exists;
   *  SessionStateMachine reads it to build the requires_action stop_reason. */
  pendingConfirmations: string[] = [];
  /** Aborts on the turn's signal OR on a failed persist (see broadcast). */
  abortSignal: AbortSignal;
  private readonly abortController = new AbortController();
  /**
   * Per-runtime serial chain for SqlEventLog writes. The harness fires
   * many `broadcast()` calls in close succession (span_start, span_first_
   * token, tool_use, tool_result, …). Serialising them preserves logical
   * event order within the turn (seq allocation itself is safe under
   * concurrent writers — SqlEventLog retries on the unique PK).
   */
  private writeChain: Promise<void> = Promise.resolve();
  /** First persistence failure; rethrown by flush(). */
  private persistError: unknown = null;

  constructor(private opts: NodeHarnessRuntimeOptions) {
    this.history = new SqlHistoryStore(opts.log);
    this.sandbox = opts.sandbox;
    this.abortSignal = this.abortController.signal;
    const external = opts.abortSignal;
    if (external?.aborted) this.abortController.abort(external.reason);
    else external?.addEventListener("abort", () => this.abortController.abort(external.reason), { once: true });
  }

  /** Call before each harness.run() so getEvents reflects DB state. */
  async refreshHistory(): Promise<void> {
    await this.history.refresh();
  }

  /**
   * Single write path. Persists the event to SqlEventLog (durable,
   * survives crash), then publishes EXACTLY the stored row (with its
   * seq) to the hub for live SSE subscribers — persist-before-broadcast.
   *
   * broadcast() is sync in the HarnessRuntime contract, so a failed write
   * can't throw at the call site. Instead the first failure is retained,
   * later writes are skipped (the log must not get holes papered over),
   * and the turn is aborted so the harness stops producing work whose
   * record is being lost. SessionStateMachine awaits flush(), which
   * rethrows the failure as the turn's error.
   */
  broadcast = (event: SessionEvent): void => {
    // Failure is retained + aborts the turn inside enqueueWrite; the
    // rejection here is only observed via flush().
    void this.enqueueWrite(event).catch(() => {});
  };

  /**
   * Durable append for write-ahead tool execution (HarnessRuntime.persist,
   * docs/durable-execution.md): same serialized write chain as broadcast
   * (so ordering is shared), resolves only once the row is stored and
   * rejects when it isn't — including a lease-fenced write rejected
   * because another worker now owns the session (the log handed to this
   * runtime is the turn's guarded log).
   */
  persist = async (event: SessionEvent): Promise<void> => {
    await this.enqueueWrite(event);
  };

  /** Wait for every queued persist; rethrow the first failure. */
  async flush(): Promise<void> {
    await this.writeChain;
    if (this.persistError) throw this.persistError;
  }

  /** Set by close(): the turn ended without waiting for the harness. */
  private closed = false;

  /**
   * SessionStateMachine stopped waiting for this harness run (aborted
   * turn that didn't unwind within its grace period) and is ending the
   * turn itself. Any write the abandoned harness makes afterwards would
   * land after the turn's session.status_idle and corrupt the history —
   * drop it instead.
   */
  close(): void {
    this.closed = true;
    if (!this.abortController.signal.aborted) this.abortController.abort({ kind: "closed" });
  }

  private enqueueWrite(event: SessionEvent): Promise<void> {
    if (this.closed) {
      log.warn(
        { op: "node_harness.write_after_close", event_type: event.type },
        "dropping event written by an abandoned harness run",
      );
      return Promise.reject(Object.assign(new Error("harness runtime closed"), { code: "runtime_closed" }));
    }
    this.history.appendInPlace(event);
    const write = this.writeChain.then(async () => {
      if (this.persistError) throw this.persistError;
      const stored = await this.opts.log.appendAsync(event);
      const seq = (stored as { seq?: number }).seq;
      if (seq !== undefined) (event as { seq?: number }).seq = seq;
      this.opts.hub.publish(this.opts.sessionId, stored);
    });
    this.writeChain = write.catch((err) => {
      if (this.persistError) return;
      this.persistError = err;
      log.warn({ err, op: "node_harness.persist_failed" }, "event persist failed; aborting turn");
      this.abortController.abort({ kind: "persist_failed" });
    });
    return write;
  }

  // Stream lifecycle events: broadcast-only (NOT persisted to events log,
  // matching the CF contract — the eventual agent.message is the canonical
  // record). For PoC simplicity we publish a synthetic event without a seq.
  broadcastStreamStart = async (messageId: string): Promise<void> => {
    this.opts.hub.publish(this.opts.sessionId, {
      type: "agent.message_stream_start",
      message_id: messageId,
    } as unknown as SessionEvent);
  };
  broadcastChunk = async (messageId: string, delta: string): Promise<void> => {
    this.opts.hub.publish(this.opts.sessionId, {
      type: "agent.message_chunk",
      message_id: messageId,
      delta,
    } as unknown as SessionEvent);
  };
  broadcastStreamEnd = async (
    messageId: string,
    status: "completed" | "aborted",
    errorText?: string,
  ): Promise<void> => {
    this.opts.hub.publish(this.opts.sessionId, {
      type: "agent.message_stream_end",
      message_id: messageId,
      status,
      error_text: errorText,
    } as unknown as SessionEvent);
  };

  broadcastThinkingStart = async (thinkingId: string): Promise<void> => {
    this.opts.hub.publish(this.opts.sessionId, {
      type: "agent.thinking_stream_start",
      thinking_id: thinkingId,
    } as unknown as SessionEvent);
  };
  broadcastThinkingChunk = async (thinkingId: string, delta: string): Promise<void> => {
    this.opts.hub.publish(this.opts.sessionId, {
      type: "agent.thinking_chunk",
      thinking_id: thinkingId,
      delta,
    } as unknown as SessionEvent);
  };
  broadcastThinkingEnd = async (
    thinkingId: string,
    status: "completed" | "aborted",
  ): Promise<void> => {
    this.opts.hub.publish(this.opts.sessionId, {
      type: "agent.thinking_stream_end",
      thinking_id: thinkingId,
      status,
    } as unknown as SessionEvent);
  };

  broadcastToolInputStart = async (
    toolUseId: string,
    toolName?: string,
  ): Promise<void> => {
    this.opts.hub.publish(this.opts.sessionId, {
      type: "agent.tool_use_input_stream_start",
      tool_use_id: toolUseId,
      tool_name: toolName,
    } as unknown as SessionEvent);
  };
  broadcastToolInputChunk = async (toolUseId: string, delta: string): Promise<void> => {
    this.opts.hub.publish(this.opts.sessionId, {
      type: "agent.tool_use_input_chunk",
      tool_use_id: toolUseId,
      delta,
    } as unknown as SessionEvent);
  };
  broadcastToolInputEnd = async (
    toolUseId: string,
    status: "completed" | "aborted",
  ): Promise<void> => {
    this.opts.hub.publish(this.opts.sessionId, {
      type: "agent.tool_use_input_stream_end",
      tool_use_id: toolUseId,
      status,
    } as unknown as SessionEvent);
  };
}
