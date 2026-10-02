// Cold-start reconciliation for the session runtime. Pure function over
// the EventLog + StreamRepo ports — no DO/CF/Node dependencies — so it
// can be driven from a unit test with InMemoryEventLog +
// InMemoryStreamRepo adapters and exercised without spinning up
// workerd or a full process.
//
// Originally lived in apps/agent/src/runtime/recovery.ts; lifted into
// @open-managed-agents/session-runtime so both the CF SessionDO shell
// and the Node SessionRegistry shell call the same recovery logic.
//
// Two kinds of orphan state get cleaned up here:
//
//   1. Streaming `agent.message` runs that died mid-LLM. Chunks are in
//      the streams table but the final `agent.message` event never
//      landed. We append a partial `agent.message` carrying whatever
//      chunks the previous runtime had buffered (or a placeholder) and
//      finalize the streams row to "interrupted".
//
//   2. `agent.tool_use` (built-in or MCP) without a matching result
//      event. With write-ahead tool execution (docs/durable-execution.md)
//      the tool_use is durably persisted BEFORE the tool runs, so an
//      orphan means "the process died while the tool was executing".
//      Anthropic strictly requires every tool use be followed by a
//      result, so recovery resolves each orphan by its execution class
//      (see ./tool-classification.ts):
//        - side_effect -> error result: "started, crashed before
//          completion, MAY have taken effect - verify before retrying",
//          carrying the idempotency key;
//        - idempotent  -> error result telling the model it is safe to
//          re-run - OR, with `deferIdempotent`, left unresolved so the
//          default harness re-executes it at turn resume (the caller
//          promises a resume will follow);
//        - client      -> untouched (see below).
//
// `agent.custom_tool_use` orphans (and tool_uses parked on
// `evaluated_permission: "ask"`) are NOT auto-resolved - the result is
// user-driven (SDK confirms a custom tool's outcome / user approves) and
// silently completing it on the server would fabricate user input. We
// surface a warning and let the client decide.
//
// Warnings are returned (not appended to the event log) so the caller
// can broadcast them to live WS subscribers without polluting history.

import type { SessionEvent } from "@open-managed-agents/shared";
import type { StreamRepo, EventLogRepo } from "@open-managed-agents/event-log";
import {
  buildInterruptedToolResult,
  findOrphanToolUses,
  type ToolExecutionClass,
} from "./tool-classification";

export interface RecoveryWarning {
  source: "stream_interrupted" | "tool_call_interrupted" | "custom_tool_call_interrupted";
  message: string;
  details: Record<string, unknown>;
}

export interface RecoveryReport {
  /** Streams that were finalized as 'interrupted' during this scan. */
  finalizedStreams: string[];
  /** Tool-use ids that received an injected placeholder tool_result. */
  injectedToolResults: string[];
  /** Tool-use ids that received an injected placeholder mcp_tool_result. */
  injectedMcpToolResults: string[];
  /** Custom-tool-use ids surfaced as warning-only (no result injected). */
  pendingCustomToolUses: string[];
  /** Idempotent tool-use ids deliberately left unresolved for the harness
   *  to re-execute at turn resume (only with `deferIdempotent`). */
  pendingReexecution: string[];
  /** Per-orphan decision record (structured form of the warnings). */
  recoveredToolCalls: RecoveredToolCall[];
  /** Warnings to broadcast to live subscribers. */
  warnings: RecoveryWarning[];
}

export interface RecoveredToolCall {
  tool_use_id: string;
  tool_name?: string;
  execution_class: ToolExecutionClass;
  /** injected_unknown_outcome - side_effect, error result appended
   *  injected_retry_safe      - idempotent, "safe to re-run" result appended
   *  deferred_reexecution     - idempotent, left for the harness to re-run
   *  awaiting_client          - client-owned, untouched */
  action: "injected_unknown_outcome" | "injected_retry_safe" | "deferred_reexecution" | "awaiting_client";
  idempotency_key?: string;
  session_thread_id?: string;
}

export interface RecoveryOptions {
  /**
   * Leave idempotent orphans unresolved (reported in `pendingReexecution`)
   * instead of injecting a "safe to re-run" result. Only set this when the
   * caller will resume the turn with the default harness, which
   * re-executes unresolved idempotent calls before calling the model
   * (reconcileOrphanedToolCalls in apps/agent/src/harness/durable-tools.ts).
   * Default false.
   */
  deferIdempotent?: boolean;
}

export async function recoverInterruptedState(
  streams: StreamRepo,
  history: Pick<EventLogRepo, "append" | "getEvents">,
  opts: RecoveryOptions = {},
): Promise<RecoveryReport> {
  const report: RecoveryReport = {
    finalizedStreams: [],
    injectedToolResults: [],
    injectedMcpToolResults: [],
    pendingCustomToolUses: [],
    pendingReexecution: [],
    recoveredToolCalls: [],
    warnings: [],
  };

  // 1. Streams left mid-flight by the previous runtime.
  const interrupted = await streams.listByStatus("streaming");
  for (const s of interrupted) {
    const partial = s.chunks.join("");
    history.append({
      type: "agent.message",
      message_id: s.message_id,
      content: [
        { type: "text", text: partial || "(interrupted by maintenance restart)" },
      ],
    } as SessionEvent);
    await streams.finalize(s.message_id, "interrupted");
    report.finalizedStreams.push(s.message_id);
    report.warnings.push({
      source: "stream_interrupted",
      message: "LLM stream was cut short by a server restart",
      details: { message_id: s.message_id, partial_length: partial.length },
    });
  }

  // 2. Tool-use rows with no matching result, resolved by execution class.
  for (const orphan of findOrphanToolUses(history.getEvents())) {
    const base = {
      tool_use_id: orphan.tool_use_id,
      tool_name: orphan.name,
      execution_class: orphan.execution_class,
      ...(orphan.idempotency_key ? { idempotency_key: orphan.idempotency_key } : {}),
      ...(orphan.session_thread_id ? { session_thread_id: orphan.session_thread_id } : {}),
    };

    if (orphan.execution_class === "client") {
      report.pendingCustomToolUses.push(orphan.tool_use_id);
      report.recoveredToolCalls.push({ ...base, action: "awaiting_client" });
      report.warnings.push({
        source: "custom_tool_call_interrupted",
        message: "Custom tool call was interrupted; client should resend the result",
        details: { tool_use_id: orphan.tool_use_id, tool_name: orphan.name },
      });
      continue;
    }

    if (orphan.execution_class === "idempotent" && opts.deferIdempotent) {
      report.pendingReexecution.push(orphan.tool_use_id);
      report.recoveredToolCalls.push({ ...base, action: "deferred_reexecution" });
      report.warnings.push({
        source: "tool_call_interrupted",
        message: `${orphan.event_type} "${orphan.name ?? "unknown"}" cut short by a server restart; idempotent, will be re-executed on resume`,
        details: { ...base, action: "deferred_reexecution" },
      });
      continue;
    }

    const result = buildInterruptedToolResult(orphan);
    if (!result) continue;
    history.append(result);
    if (result.type === "agent.mcp_tool_result") {
      report.injectedMcpToolResults.push(orphan.tool_use_id);
    } else {
      report.injectedToolResults.push(orphan.tool_use_id);
    }
    const action = orphan.execution_class === "idempotent"
      ? "injected_retry_safe" as const
      : "injected_unknown_outcome" as const;
    report.recoveredToolCalls.push({ ...base, action });
    report.warnings.push({
      source: "tool_call_interrupted",
      message: action === "injected_unknown_outcome"
        ? `${orphan.event_type} "${orphan.name ?? "unknown"}" cut short by a server restart; it may have taken effect (outcome unknown)`
        : `${orphan.event_type} "${orphan.name ?? "unknown"}" cut short by a server restart; idempotent, model told it is safe to re-run`,
      details: { ...base, action },
    });
  }

  return report;
}
