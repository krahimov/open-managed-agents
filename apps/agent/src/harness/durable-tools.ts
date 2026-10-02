// Write-ahead tool execution for the default harness.
//
// Contract (docs/durable-execution.md):
//
//   1. Before a tool's `execute` runs, the harness has DURABLY persisted
//      the matching `agent.tool_use` event (with `idempotency_key` +
//      `execution_class`). The event is written by the stream observer in
//      default-loop.ts when the tool-call part flows through the stream —
//      that is the only place that knows the step's preceding text /
//      thinking, which must land first. The wrapped `execute` below waits
//      on a per-call gate until that write completed; if the write fails
//      the tool never runs.
//   2. Immediately after `execute` settles (result OR throw) the result
//      event is persisted — not batched into onStepFinish.
//   3. A crash between (1) and (2) leaves an orphan tool_use in the log;
//      recovery (packages/session-runtime/src/recovery.ts) and
//      `reconcileOrphanedToolCalls` below resolve it by execution class.
//
// Process-wide in-flight registry: a harness run that failed mid-step (e.g.
// provider stream error) can be retried in-process while one of its tools
// is still executing. The retry's reconcile step waits for the in-flight
// call instead of treating it as crashed, and "claims" the result slot so
// exactly one result event is ever persisted per tool call.

import type { SessionEvent } from "@open-managed-agents/shared";
import {
  findOrphanToolUses,
  buildInterruptedToolResult,
  idempotencyKeyFor,
  type OrphanToolUse,
} from "@open-managed-agents/session-runtime";

/** AI SDK execute options (subset we rely on). */
export interface ToolExecOptions {
  toolCallId: string;
  messages?: unknown[];
  abortSignal?: AbortSignal;
  [k: string]: unknown;
}

/** Settled outcome of one execution, in AI SDK content-part shape. */
export type ToolSettlement =
  | { type: "tool-result"; toolCallId: string; toolName: string; output: unknown }
  | { type: "tool-error"; toolCallId: string; toolName: string; error: unknown };

// ── Gates ────────────────────────────────────────────────────────────────

interface Gate {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
  settled: boolean;
}

/**
 * One gate per toolCallId. `wait` is called by the wrapped execute (which
 * the AI SDK may start before the stream observer has seen the tool-call
 * part); `open` is called by the observer once `agent.tool_use` is durable.
 * Gates are created lazily by whichever side arrives first.
 */
export class ToolUseGates {
  private gates = new Map<string, Gate>();
  private closedWith: unknown = null;

  private get(id: string): Gate {
    let g = this.gates.get(id);
    if (!g) {
      let resolve!: () => void;
      let reject!: (err: unknown) => void;
      const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      // Avoid unhandled-rejection noise for gates nobody waits on.
      promise.catch(() => {});
      g = { promise, resolve, reject, settled: false };
      this.gates.set(id, g);
      if (this.closedWith) {
        g.settled = true;
        g.reject(this.closedWith);
      }
    }
    return g;
  }

  open(id: string): void {
    const g = this.get(id);
    if (g.settled) return;
    g.settled = true;
    g.resolve();
  }

  fail(id: string, err: unknown): void {
    const g = this.get(id);
    if (g.settled) return;
    g.settled = true;
    g.reject(err);
  }

  /** Reject every pending gate (stream ended / errored / aborted). */
  closeAll(err: unknown): void {
    this.closedWith = err;
    for (const g of this.gates.values()) {
      if (g.settled) continue;
      g.settled = true;
      g.reject(err);
    }
  }

  async wait(id: string, signal?: AbortSignal): Promise<void> {
    const g = this.get(id);
    if (!signal) return g.promise;
    if (signal.aborted) throw signal.reason ?? new Error("aborted");
    await Promise.race([
      g.promise,
      new Promise<never>((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
      }),
    ]);
  }
}

// ── In-flight registry (process-wide) ────────────────────────────────────

interface InflightEntry {
  done: Promise<void>;
  /** Set by whoever gets to persist the result first. */
  claimed: boolean;
  /** Result events the owner persisted (for stale-cache projection merge). */
  persisted: SessionEvent[];
}

const INFLIGHT = new Map<string, InflightEntry>();

/** Test hook: number of executions currently tracked. */
export function inflightToolCallCount(): number {
  return INFLIGHT.size;
}

/** Test hook: simulate a process restart (the registry is in-memory). */
export function resetInflightToolCallsForTest(): void {
  INFLIGHT.clear();
}

// ── Wrapper ──────────────────────────────────────────────────────────────

export interface WriteAheadDeps {
  sessionId?: string;
  gates: ToolUseGates;
  /** True once the observer persisted the call's tool_use. */
  isToolUsePersisted: (toolCallId: string) => boolean;
  /**
   * Persist the result events for a settled call. Returns the events that
   * were written (empty when the slot was already taken). Called at most
   * once per toolCallId per run.
   */
  persistResult: (settlement: ToolSettlement) => Promise<SessionEvent[]>;
}

/**
 * Wrap every tool that has a server-side `execute` so execution waits for
 * the write-ahead tool_use and persists its result immediately. Tools
 * without `execute` (custom tools, always_ask) pass through untouched —
 * the AI SDK surfaces them as pending calls.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function wrapToolsWriteAhead(tools: Record<string, any>, deps: WriteAheadDeps): Record<string, any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: Record<string, any> = {};
  for (const [name, t] of Object.entries(tools)) {
    if (!t || typeof t.execute !== "function") {
      out[name] = t;
      continue;
    }
    const original = t.execute.bind(t);
    out[name] = {
      ...t,
      execute: async (input: unknown, options: ToolExecOptions) => {
        const toolCallId = options?.toolCallId;
        if (!toolCallId) return original(input, options);

        // 1. Write-ahead: never run before agent.tool_use is durable.
        await deps.gates.wait(toolCallId, options.abortSignal);

        const key = idempotencyKeyFor(deps.sessionId, toolCallId);
        let finish!: () => void;
        const entry: InflightEntry = {
          done: new Promise<void>((res) => { finish = res; }),
          claimed: false,
          persisted: [],
        };
        INFLIGHT.set(key, entry);

        const settle = async (settlement: ToolSettlement) => {
          // A reconcile in a later run may have given up on us and
          // written an "outcome unknown" result already — never write a
          // second result for the same call.
          if (entry.claimed || !deps.isToolUsePersisted(toolCallId)) return;
          entry.claimed = true;
          try {
            entry.persisted = await deps.persistResult(settlement);
          } catch (err) {
            // Tool already ran; don't turn its success into a tool-error.
            // onStepFinish falls back to the non-durable emit path.
            entry.claimed = false;
            console.warn(`[durable-tools] result persist failed for ${toolCallId}: ${(err as Error)?.message ?? err}`);
          }
        };

        try {
          // 2. Execute.
          const output = await original(input, options);
          await settle({ type: "tool-result", toolCallId, toolName: name, output });
          return output;
        } catch (error) {
          await settle({ type: "tool-error", toolCallId, toolName: name, error });
          throw error;
        } finally {
          finish();
          if (INFLIGHT.get(key) === entry) INFLIGHT.delete(key);
        }
      },
    };
  }
  return out;
}

// ── Orphan reconciliation at run start ───────────────────────────────────

export interface ReconcileDeps {
  events: SessionEvent[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: Record<string, any>;
  sessionId?: string;
  persist: (event: SessionEvent) => Promise<void>;
  /** Maps a settlement to wire result events (default-loop toolResultEvents). */
  resultEvents: (settlement: ToolSettlement) => SessionEvent[];
  abortSignal?: AbortSignal;
  /** How long to wait for a still-running execution from a previous run. */
  inflightWaitMs?: number;
}

export interface ReconcileReport {
  reexecuted: string[];
  injected: string[];
  awaitedInflight: string[];
  /** Result events known to be persisted but possibly absent from a stale
   *  history cache — merge into the projection input. */
  extraEvents: SessionEvent[];
}

/**
 * Resolve tool_uses left without a result by an interrupted run BEFORE the
 * model is called (Anthropic 400s on an unpaired tool_use):
 *
 *   - still executing in this process (in-process retry) → wait for it
 *   - idempotent + tool available → re-execute, persist the real result
 *   - side_effect (or idempotent tool unavailable) → persist the
 *     "may have taken effect — verify before retrying" error result
 *   - client (custom tool / awaiting confirmation) → leave alone
 *
 * Normally cold-start recovery already resolved side-effect orphans; this
 * is the harness-side half that makes idempotent re-execution real and
 * keeps the loop self-healing on runtimes whose recovery didn't run.
 */
export async function reconcileOrphanedToolCalls(deps: ReconcileDeps): Promise<ReconcileReport> {
  const report: ReconcileReport = { reexecuted: [], injected: [], awaitedInflight: [], extraEvents: [] };
  const orphans = findOrphanToolUses(deps.events);
  for (const orphan of orphans) {
    if (orphan.execution_class === "client") continue;
    const key = orphan.idempotency_key ?? idempotencyKeyFor(deps.sessionId, orphan.tool_use_id);

    const inflight = INFLIGHT.get(key);
    if (inflight) {
      const finished = await Promise.race([
        inflight.done.then(() => true),
        new Promise<boolean>((res) => setTimeout(() => res(false), deps.inflightWaitMs ?? 30_000)),
      ]);
      if (finished && inflight.claimed) {
        report.awaitedInflight.push(orphan.tool_use_id);
        report.extraEvents.push(...inflight.persisted);
        continue;
      }
      // Timed out (or it finished without persisting): take the slot so
      // a late completion can't add a second result.
      inflight.claimed = true;
    }

    const tool = orphan.name ? deps.tools[orphan.name] : undefined;
    if (orphan.execution_class === "idempotent" && tool && typeof tool.execute === "function") {
      const settlement = await reexecute(orphan, tool, deps.abortSignal);
      const events = deps.resultEvents(settlement);
      for (const e of events) await deps.persist(e);
      report.extraEvents.push(...events);
      report.reexecuted.push(orphan.tool_use_id);
      continue;
    }

    const result = buildInterruptedToolResult(orphan);
    if (!result) continue;
    await deps.persist(result);
    report.extraEvents.push(result);
    report.injected.push(orphan.tool_use_id);
  }
  return report;
}

async function reexecute(
  orphan: OrphanToolUse,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tool: any,
  abortSignal?: AbortSignal,
): Promise<ToolSettlement> {
  const toolName = orphan.name ?? "unknown";
  try {
    const output = await tool.execute(orphan.input ?? {}, {
      toolCallId: orphan.tool_use_id,
      messages: [],
      abortSignal,
    });
    return { type: "tool-result", toolCallId: orphan.tool_use_id, toolName, output };
  } catch (error) {
    return { type: "tool-error", toolCallId: orphan.tool_use_id, toolName, error };
  }
}

/**
 * Merge result events known to be persisted into a (possibly stale)
 * history snapshot, skipping any whose tool call is already resolved.
 */
export function mergePersistedResults(events: SessionEvent[], extra: SessionEvent[]): SessionEvent[] {
  if (extra.length === 0) return events;
  const resolved = new Set<string>();
  for (const e of events) {
    const r = e as { type: string; tool_use_id?: string; mcp_tool_use_id?: string };
    if (r.type === "agent.tool_result" && r.tool_use_id) resolved.add(r.tool_use_id);
    if (r.type === "agent.mcp_tool_result" && r.mcp_tool_use_id) resolved.add(r.mcp_tool_use_id);
  }
  const missing = extra.filter((e) => {
    const r = e as { type: string; tool_use_id?: string; mcp_tool_use_id?: string };
    const id = r.type === "agent.tool_result" ? r.tool_use_id : r.type === "agent.mcp_tool_result" ? r.mcp_tool_use_id : undefined;
    return id ? !resolved.has(id) : false;
  });
  return missing.length ? [...events, ...missing] : events;
}
