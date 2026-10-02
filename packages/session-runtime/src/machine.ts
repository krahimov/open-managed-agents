// SessionStateMachine — single source for turn lifecycle on both CF and
// Node. Phase 2 of the unified-runtime plan: Node adopts this; Phase 3
// CF SessionDO becomes a thin shell that constructs one of these.
//
// Surface (callable from per-platform shell):
//
//   runTurn(agentId, event, opts) / runHarnessTurn(agentId, userMessage)
//     beginTurn → promote the queued user.* event into the log →
//     (tool confirmation / custom tool result handling) → harness.run →
//     stop_reason → endTurn. The same body will replace the CF
//     SessionDO's drainEventQueue+turn-runtime stack in Phase 3.
//
//   interrupt(reason)
//     Abort the in-flight turn via its AbortController (plumbed into the
//     harness as HarnessRuntime.abortSignal).
//
//   onWake()
//     Detect orphan turns (sessions row marked 'running' with a
//     turn_id we don't recognise as our own active turn) and reconcile
//     them via recoverInterruptedState. Called from:
//       - CF DO alarm() (every 30s while a turn is in flight, and on
//         cold start when a request hits an evicted DO)
//       - Node SessionRegistry.bootstrap() at process start
//       - Anywhere a stale-state hint is useful (e.g. an SSE reconnect)
//
//   destroy()
//     Mark the session destroyed. End-of-life signal for graceful
//     shutdown.
//
// Per-platform polymorphism is entirely in the RuntimeAdapter the
// machine holds (one impl, both platforms via SqlClient + the optional
// hintTurnInFlight callback).

import { nanoid } from "nanoid";
import { generateEventId } from "@open-managed-agents/shared";
import type {
  AgentConfig,
  SessionEvent,
  UserCustomToolResultEvent,
  UserMessageEvent,
  UserToolConfirmationEvent,
} from "@open-managed-agents/shared";
import type { LanguageModel } from "ai";
import type { EventLogRepo } from "@open-managed-agents/event-log";
import { recoverInterruptedState } from "./recovery";
import { buildInterruptedToolResult, classifyTool, type ToolExecutionClass } from "./tool-classification";
import type { OrphanTurn, RuntimeAdapter, TurnId } from "./ports";
import type { SandboxExecutor } from "@open-managed-agents/sandbox";
import {
  computeStopReason,
  findUnresolvedToolUses,
  outstandingRequiredActions,
  toolResultEventFor,
  withAskGatesLifted,
  type TurnStopReason,
} from "./tool-actions";

/**
 * Pluggable harness — both CF and Node want the same default-loop
 * harness, but the machine doesn't import it directly so we keep the
 * package's dep graph small (no `@open-managed-agents/agent` dep).
 *
 * The shell wires this with:
 *   buildHarness: () => new DefaultHarness()
 *   buildContext: () => HarnessContext  // model + tools + system + ...
 */
export interface HarnessRunFn {
  (ctx: unknown): Promise<void>;
}

export interface SessionMachineDeps {
  sessionId: string;
  tenantId: string;

  /** Single shared adapter for I/O. */
  adapter: RuntimeAdapter;

  /** Per-session sandbox. Constructed by the shell so it can pick the
   *  backend (LocalSubprocess / E2B / Daytona / CloudflareSandbox) and
   *  inject sessionId-scoped paths.  */
  sandbox: SandboxExecutor;

  /** Look up the agent config. CF reads from a snapshot or the agents
   *  store; Node reads from agentsService. */
  loadAgent(agentId: string): Promise<AgentConfig | null>;

  /** Bind a memory store into the sandbox. Phase 2 keeps the loop in
   *  the shell to avoid pulling memory-store types into this package;
   *  the shell calls sandbox.mountMemoryStore directly via sandbox. */
  mountMemoryStores?(opts: { sandbox: SandboxExecutor }): Promise<void>;

  /** Mount /mnt/session/outputs/ into the sandbox. Per-session bound
   *  directory the agent uses to deliver final artefacts; the same path
   *  is exposed by the main worker via GET /v1/sessions/:id/outputs.
   *  Optional — sandboxes / hosts that don't support it skip silently. */
  mountSessionOutputs?(opts: { sandbox: SandboxExecutor }): Promise<void>;

  /** Build the LanguageModel for this turn. CF reads env from
   *  bindings; Node from process.env. */
  buildModel(agent: AgentConfig): LanguageModel | Promise<LanguageModel>;

  /** Build harness tools. The harness package owns the tool list; the
   *  machine doesn't know which tools exist, just hands the result to
   *  the harness. */
  buildTools(agent: AgentConfig, sandbox: SandboxExecutor): Promise<unknown>;

  /** Build the harness instance + context for one turn. The shell does
   *  this so the machine doesn't need a hard dep on
   *  `@open-managed-agents/agent`. The machine just calls run().
   *
   *  Async because shells often need to warm up state (e.g. read the
   *  event log into the harness's history cache) before harness.run
   *  reads from it. */
  buildHarness(): { run: (ctx: unknown) => Promise<void> };
  buildHarnessContext(input: {
    agent: AgentConfig;
    userMessage: UserMessageEvent;
    sandbox: SandboxExecutor;
    tools: unknown;
    model: LanguageModel;
    /** Fires on interrupt / lease loss; wire into HarnessRuntime.abortSignal
     *  (the default harness hands it to streamText). */
    abortSignal: AbortSignal;
    /** Turn-scoped (possibly lease-fenced) log the harness must write to. */
    eventLog: EventLogRepo;
  }): Promise<unknown>;

  /** Optional outcome supervisor (user.define_outcome). Called after a
   *  turn ends with end_turn; the shell decides whether an outcome is
   *  active (see activeOutcomeFromEvents) and runs the grader loop,
   *  using runHarnessTurn for revision turns. */
  runOutcome?(input: {
    agent: AgentConfig;
    eventLog: EventLogRepo;
    abortSignal: AbortSignal;
    appendAndPublish(event: SessionEvent): Promise<SessionEvent>;
    publish(event: SessionEvent): void;
    runHarnessTurn(msg: UserMessageEvent): Promise<void>;
  }): Promise<void>;

  /** Publish a synthetic event to the hub (e.g. session.error,
   *  session.status_idle on recovery). The shell wires this with the
   *  in-process or DO-level hub. */
  publish(event: SessionEvent): void;

  /** Logger. Defaults to console. */
  logger?: { warn: (msg: string, ctx?: unknown) => void; log: (msg: string) => void };

  /** After the turn's AbortSignal fires, how long to wait for the harness
   *  to unwind before ending the turn without it (its later writes are
   *  dropped via HarnessRuntime.close). Default 2000ms. */
  abortGraceMs?: number;
}

export const SESSION_ERROR_EMITTED_MARKER = "__omaSessionErrorEmitted";

export function sessionErrorAlreadyEmitted(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as Record<string, unknown>)[SESSION_ERROR_EMITTED_MARKER] === true
  );
}

function markSessionErrorEmitted(err: unknown): void {
  if (typeof err !== "object" || err === null) return;
  try {
    Object.defineProperty(err, SESSION_ERROR_EMITTED_MARKER, {
      value: true,
      enumerable: false,
      configurable: true,
    });
  } catch {
    /* best effort */
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The three queue-input event types a turn can be driven by. */
export type TurnInputEvent =
  | UserMessageEvent
  | UserToolConfirmationEvent
  | UserCustomToolResultEvent;

/**
 * Why a turn's AbortSignal fired. `user_interrupt` ends the turn cleanly
 * (session.status_idle, no session.error); `lease_lost` / `shutdown` /
 * `destroyed` mean another owner (or nobody) should finish the turn, so
 * the machine unwinds WITHOUT writing turn-end events.
 */
export type TurnAbortReason =
  | { kind: "user_interrupt" }
  | { kind: "lease_lost" }
  | { kind: "shutdown" }
  | { kind: "destroyed" };

export interface TurnOptions {
  /** External abort (work queue: cross-replica interrupt, lease loss). */
  signal?: AbortSignal;
  /** Turn-scoped event log (e.g. SqlEventLog.withGuard fenced on the
   *  work-item lease). Defaults to adapter.eventLog. */
  eventLog?: EventLogRepo;
  /** Pending-queue position, echoed on system.user_message_promoted. */
  pendingSeq?: number;
  /** Reconcile orphan turns (cut-off streams/tools, resolved by execution
   *  class — recovery.ts) before starting. Only safe when the caller
   *  guarantees exclusive ownership of the session (the Node work queue
   *  does). When the input event was already promoted by an earlier
   *  attempt, idempotent orphans are deferred so the default harness
   *  re-executes them as the turn resumes from the log. */
  recoverOrphans?: boolean;
}

export interface TurnResult {
  status: "completed" | "interrupted";
  stopReason?: TurnStopReason;
  /** The input's turn had already reached its terminal idle in an earlier
   *  attempt (crash before queue acknowledgement); nothing was re-run. */
  alreadyCompleted?: boolean;
}

/** Thrown when the turn lost its lease mid-flight; no events were written
 *  for the turn end, the new owner reconciles. */
export class TurnLeaseLostError extends Error {
  readonly code = "lease_lost";
  constructor(message = "turn lease lost; another worker owns this session") {
    super(message);
    this.name = "TurnLeaseLostError";
  }
}

export function isTurnLeaseLost(err: unknown): boolean {
  const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  return code === "lease_lost" || code === "append_rejected";
}

function abortKind(signal: AbortSignal): TurnAbortReason["kind"] {
  const kind = (signal.reason as { kind?: unknown } | undefined)?.kind;
  return kind === "lease_lost" || kind === "shutdown" || kind === "destroyed"
    ? kind
    : "user_interrupt";
}

/** Structural view of the async extensions SqlEventLog adds to the port. */
interface AsyncEventLog {
  appendAsync?: (event: SessionEvent) => Promise<SessionEvent | void>;
  getEventsAsync?: (afterSeq?: number) => Promise<SessionEvent[]>;
  findEventByIdAsync?: (id: string) => Promise<SessionEvent | null>;
}

/** Runtime fields the machine reads off the harness context, if present. */
interface HarnessRuntimeView {
  flush?: () => Promise<void>;
  pendingConfirmations?: string[];
  /** Stop accepting writes (the machine abandoned this harness run). */
  close?: () => void;
}

/**
 * Wait for `run` to settle, or — once `signal` aborts — at most `graceMs`
 * more. Resolves true when the run was abandoned (still going).
 */
function waitOrAbandon(run: Promise<void>, signal: AbortSignal, graceMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onAbort = () => {
      timer = setTimeout(() => resolve(true), graceMs);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    void run.then(() => {
      signal.removeEventListener("abort", onAbort);
      if (timer) clearTimeout(timer);
      resolve(false);
    });
  });
}

const RESUME_MESSAGE: UserMessageEvent = {
  type: "user.message",
  content: [{ type: "text", text: "" }],
};

export class SessionStateMachine {
  private activeTurnId: TurnId | null = null;
  private activeController: AbortController | null = null;
  private logger: NonNullable<SessionMachineDeps["logger"]>;

  constructor(private deps: SessionMachineDeps) {
    this.logger = deps.logger ?? {
      warn: (msg, ctx) => console.warn(`[session ${deps.sessionId}] ${msg}`, ctx ?? ""),
      log: (msg) => console.log(`[session ${deps.sessionId}] ${msg}`),
    };
  }

  /** Currently-running turn id, or null if idle. Used by per-platform
   *  shells to decide whether to keep the alarm armed (CF) or skip a
   *  recovery scan that would race the active turn. */
  hasInflightTurn(): boolean {
    return this.activeTurnId !== null;
  }

  /**
   * Abort the in-flight turn (if any). The turn unwinds on its own: a
   * `user_interrupt` ends with session.status_idle(end_turn) and no
   * session.error. Returns whether a turn was running in this process.
   */
  interrupt(reason: TurnAbortReason = { kind: "user_interrupt" }): boolean {
    const ctrl = this.activeController;
    if (!ctrl) return false;
    ctrl.abort(reason);
    return true;
  }

  /**
   * Back-compat entry point for user.message turns. Throws on harness
   * failure (after emitting session.error), like it always has.
   */
  async runHarnessTurn(
    agentId: string,
    userMessage: UserMessageEvent,
    opts: TurnOptions = {},
  ): Promise<void> {
    await this.runTurn(agentId, userMessage, opts);
  }

  /**
   * Drive one turn for a queue-input event:
   *
   *   user.message            → run the harness
   *   user.tool_confirmation  → execute (allow) or deny the gated tool
   *                             call, then resume the harness once every
   *                             requires_action the client owes is in
   *   user.custom_tool_result → record the result, resume likewise
   *
   * The input event is PROMOTED into the event log here (turn start), not
   * when it arrived — a message sent mid-turn can't interleave into the
   * previous answer (CF pending-queue design, ORDERING_DESIGN.md). The
   * turn ends with session.status_idle carrying the real stop_reason
   * (requires_action when the model left gated / custom tool calls).
   */
  async runTurn(
    agentId: string,
    event: TurnInputEvent,
    opts: TurnOptions = {},
  ): Promise<TurnResult> {
    const log = opts.eventLog ?? this.deps.adapter.eventLog;
    event = { ...event, id: (event as { id?: string }).id ?? generateEventId() } as TurnInputEvent;
    // A previous attempt at this same event already promoted it: this run
    // is a RESUME (lease reclaimed after a crash). The harness rebuilds
    // context from the log, so completed steps aren't redone and the user
    // message isn't re-sent (docs/durable-execution.md).
    const alreadyPromoted = await this.findEventById(log, (event as { id: string }).id);
    const resuming = alreadyPromoted !== null;

    // ...unless that earlier attempt already FINISHED the turn and only
    // died afterwards (post-turn cleanup, before the queue acknowledged
    // the item). The turn-ending session.status_idle is the durable
    // completion marker: it is written last, after every turn event.
    // Re-entering the harness here would call the model again and could
    // repeat a side effect under a fresh tool-call id.
    if (alreadyPromoted) {
      const terminal = await this.findTurnTerminal(log, alreadyPromoted);
      if (terminal?.failed) {
        // The earlier attempt FAILED (error idle, no stop_reason) and died
        // before the queue recorded it. Keep that outcome: re-raise instead
        // of acknowledging the item as completed. The session.error is
        // already in the log, so don't emit another.
        if (opts.recoverOrphans) await this.onWake(log, { deferIdempotent: false });
        const err = new Error(
          `turn for ${(event as { id: string }).id} already failed before the crash` +
            (terminal.error ? `: ${terminal.error}` : ""),
        );
        markSessionErrorEmitted(err);
        throw err;
      }
      if (terminal) {
        if (opts.recoverOrphans) await this.onWake(log, { deferIdempotent: false });
        this.logger.log(
          `turn for ${(event as { id: string }).id} already completed; acknowledging without re-running`,
        );
        return {
          status: "completed",
          alreadyCompleted: true,
          ...(terminal.stop_reason ? { stopReason: terminal.stop_reason } : {}),
        };
      }
    }

    if (opts.recoverOrphans) await this.onWake(log, { deferIdempotent: resuming });

    const agent = await this.deps.loadAgent(agentId);
    if (!agent) throw new Error(`agent ${agentId} not found`);

    const turnId = nanoid();
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort(opts.signal?.reason);
    if (opts.signal?.aborted) controller.abort(opts.signal.reason);
    else opts.signal?.addEventListener("abort", onExternalAbort, { once: true });
    this.activeTurnId = turnId;
    this.activeController = controller;
    await this.deps.adapter.beginTurn(this.deps.sessionId, turnId);
    this.deps.adapter.hintTurnInFlight?.(this.deps.sessionId, turnId);

    const threadId = (event as { session_thread_id?: string }).session_thread_id;
    const threadField = threadId ? { session_thread_id: threadId } : {};
    let ending: "completed" | "interrupted" | "failed" | "silent" = "completed";
    let stopReason: TurnStopReason = { type: "end_turn" };
    let turnFromSeq: number | undefined;
    try {
      const before = await this.readEvents(log);

      // A new user.message supersedes tool calls still waiting on the
      // client (or cut off by a crash / interrupt). Close them first so
      // the model context keeps its strict tool_use → tool_result pairing;
      // otherwise every later model call 400s. Not on a resume: there the
      // unresolved calls are this turn's own, and the harness reconciles
      // them (re-runs idempotent ones) before calling the model.
      if (event.type === "user.message" && !resuming) {
        for (const use of findUnresolvedToolUses(before)) {
          await this.appendAndPublish(
            log,
            toolResultEventFor(
              use,
              "(not executed: the user sent a new message before this tool call was resolved)",
              true,
            ),
          );
        }
      }

      const promoted = await this.promote(log, event, opts.pendingSeq, alreadyPromoted);
      turnFromSeq = seqOf(promoted);

      await this.appendAndPublish(log, {
        type: "session.status_running",
        ...threadField,
      } as SessionEvent);

      // Memory store mounts: optional adapter step, runs once per turn
      // so a session newly bound to a store picks it up on the next
      // user.message without restarting.
      if (this.deps.mountMemoryStores) {
        await this.deps.mountMemoryStores({ sandbox: this.deps.sandbox });
      }

      // /mnt/session/outputs/ mount. Idempotent on the supported adapters
      // (LocalSubprocess re-symlinks, CF re-mounts the R2 prefix), so
      // re-running per turn is safe and means the path is always present
      // for a fresh sandbox that warmed in this turn.
      if (this.deps.mountSessionOutputs) {
        await this.deps.mountSessionOutputs({ sandbox: this.deps.sandbox });
      }

      const tools = await this.deps.buildTools(agent, this.deps.sandbox);

      let runHarness = true;
      if (event.type === "user.tool_confirmation" || event.type === "user.custom_tool_result") {
        await this.applyClientToolResult(log, agent, event, before, controller.signal, resuming);
        const after = await this.readEvents(log);
        const remaining = outstandingRequiredActions(after);
        if (remaining.length > 0) {
          // Other calls from the same step still wait on the client —
          // resuming now would send the model an incomplete tool_result
          // set. Hand control back with the remaining ids.
          runHarness = false;
          stopReason = computeStopReason(after, remaining);
        }
      }

      if (runHarness) {
        let pending: string[] | null = [];
        if (resuming && modelLoopFinished(await this.readEvents(log, turnFromSeq), threadId)) {
          // The crash hit after the final model step was persisted but
          // before the turn's idle: the answer is already in the log.
          // Finalize instead of calling the model again (which would
          // duplicate the reply and could re-issue a side-effecting call
          // under a fresh tool-call id).
          this.logger.log(
            `turn for ${(event as { id: string }).id} already has its final model step; finalizing without a model call`,
          );
        } else {
          const userMessage = event.type === "user.message" ? event : RESUME_MESSAGE;
          pending = await this.runHarnessOnce(agent, tools, userMessage, controller.signal, log);
          if (controller.signal.aborted) throw controller.signal.reason ?? new Error("aborted");
        }
        stopReason = computeStopReason(await this.readEvents(log, turnFromSeq), pending);

        // Outcome supervisor (user.define_outcome): grade the finished
        // turn and drive revision turns until a terminal verdict. Only on
        // end_turn — a turn waiting on the client isn't done yet.
        if (stopReason.type === "end_turn" && this.deps.runOutcome) {
          await this.deps.runOutcome({
            agent,
            eventLog: log,
            abortSignal: controller.signal,
            appendAndPublish: (ev) => this.appendAndPublish(log, ev),
            publish: (ev) => this.deps.publish(ev),
            runHarnessTurn: async (msg) => {
              await this.runHarnessOnce(agent, tools, msg, controller.signal, log);
            },
          });
          if (controller.signal.aborted) throw controller.signal.reason ?? new Error("aborted");
          stopReason = computeStopReason(await this.readEvents(log, turnFromSeq), []);
        }
      }
    } catch (err) {
      const aborted = controller.signal.aborted ? abortKind(controller.signal) : null;
      if (isTurnLeaseLost(err) || (aborted && aborted !== "user_interrupt")) {
        // Someone else owns (or nobody should continue) this turn. Writing
        // turn-end events would race the new owner — unwind silently.
        ending = "silent";
        throw isTurnLeaseLost(err) ? err : new TurnLeaseLostError(`turn aborted: ${aborted}`);
      }
      if (aborted === "user_interrupt") {
        ending = "interrupted";
        // Close tool calls the abort cut off mid-execution so the next
        // model call sees a valid tool_use/tool_result pairing.
        try {
          const cut = findUnresolvedToolUses(await this.readEvents(log, turnFromSeq))
            .filter((u) => u.type !== "agent.custom_tool_use" && u.evaluated_permission !== "ask");
          for (const use of cut) {
            await this.appendAndPublish(log, toolResultEventFor(use, "(interrupted by user)", true));
          }
        } catch (fixErr) {
          this.logger.warn(`interrupt fixup failed: ${errorMessage(fixErr)}`);
        }
      } else {
        ending = "failed";
        try {
          await this.appendAndPublish(log, {
            type: "session.error",
            error: "harness_turn_failed",
            message: errorMessage(err),
            ...threadField,
          } as unknown as SessionEvent);
          markSessionErrorEmitted(err);
        } catch (emitErr) {
          this.logger.warn(`session.error emit failed: ${errorMessage(emitErr)}`);
        }
        if (typeof err === "object" && err !== null) throw err;
        const wrapped = new Error(errorMessage(err));
        markSessionErrorEmitted(wrapped);
        throw wrapped;
      }
    } finally {
      opts.signal?.removeEventListener("abort", onExternalAbort);
      this.activeTurnId = null;
      if (this.activeController === controller) this.activeController = null;
      if (ending !== "silent") {
        await this.deps.adapter.endTurn(this.deps.sessionId, turnId, "idle");
        const idle = {
          type: "session.status_idle",
          // Error paths carry no stop_reason (CF parity). Interrupt maps to
          // end_turn — Anthropic's StopReason union has no `interrupted`
          // and pydantic SDK clients require the field; the preceding
          // user.interrupt event in the log carries the actual cause.
          ...(ending === "failed" ? {} : { stop_reason: ending === "interrupted" ? { type: "end_turn" } : stopReason }),
          ...threadField,
        } as SessionEvent;
        if (ending === "failed") {
          await this.appendAndPublish(log, idle).catch((e) =>
            this.logger.warn(`status_idle emit failed: ${errorMessage(e)}`),
          );
        } else {
          await this.appendAndPublish(log, idle);
        }
      }
    }
    return ending === "interrupted"
      ? { status: "interrupted", stopReason: { type: "end_turn" } }
      : { status: "completed", stopReason };
  }

  /**
   * Reconcile orphan turns. Reads sessions WHERE status='running',
   * filters out our own active turn, and runs recoverInterruptedState
   * for each. Recovery injects placeholder events into the event log so
   * the next user.message sees a clean tool-use bijection.
   *
   * Idempotent + safe to call repeatedly.
   */
  async onWake(
    eventLog?: EventLogRepo,
    opts: { deferIdempotent?: boolean } = {},
  ): Promise<void> {
    const orphans = await this.deps.adapter.listOrphanTurns(this.deps.sessionId);
    for (const o of orphans) {
      if (o.turn_id === this.activeTurnId) continue; // we own it
      await this.recoverOrphan(o, eventLog ?? this.deps.adapter.eventLog, opts);
    }
  }

  /**
   * Externally-driven destroy. The shell calls this on graceful
   * shutdown of a session (DELETE /v1/sessions/:id). Kills any
   * in-flight sandbox + flips status to 'destroyed'.
   */
  async destroy(): Promise<void> {
    const turnId = this.activeTurnId;
    this.activeController?.abort({ kind: "destroyed" } satisfies TurnAbortReason);
    this.activeTurnId = null;
    try {
      if (this.deps.sandbox.destroy) await this.deps.sandbox.destroy();
    } catch (err) {
      this.logger.warn(`sandbox destroy failed: ${(err as Error).message}`);
    }
    if (turnId) {
      await this.deps.adapter.endTurn(this.deps.sessionId, turnId, "destroyed");
    } else {
      // No active turn — directly mark the row destroyed.
      await this.deps.adapter.endTurn(this.deps.sessionId, "", "destroyed");
    }
  }

  // ── helpers ─────────────────────────────────────────────────────────

  /**
   * One harness run. Waits for the harness runtime's queued writes
   * (NodeHarnessRuntime persists off the sync broadcast() path) and
   * surfaces a persistence failure as THE turn failure — a turn whose
   * events didn't reach the log must not report success. Returns the
   * runtime's pendingConfirmations when it tracks them.
   */
  private async runHarnessOnce(
    agent: AgentConfig,
    tools: unknown,
    userMessage: UserMessageEvent,
    abortSignal: AbortSignal,
    eventLog: EventLogRepo,
  ): Promise<string[] | null> {
    const model = await this.deps.buildModel(agent);
    const ctx = await this.deps.buildHarnessContext({
      agent,
      userMessage,
      sandbox: this.deps.sandbox,
      tools,
      model,
      abortSignal,
      eventLog,
    });
    const runtime = (ctx as { runtime?: HarnessRuntimeView } | null)?.runtime;
    let runErr: unknown = null;
    let run: Promise<void>;
    try {
      run = this.deps.buildHarness().run(ctx).then(
        () => {},
        (err) => {
          runErr = err ?? new Error("harness failed");
        },
      );
    } catch (err) {
      run = Promise.resolve();
      runErr = err ?? new Error("harness failed");
    }
    // An aborted turn (interrupt / lease loss) must end promptly even if
    // some tool ignores the signal: give the harness a short grace to
    // unwind, then stop waiting and close its runtime so its late writes
    // can't land after the turn-ending events.
    const abandoned = await waitOrAbandon(run, abortSignal, this.deps.abortGraceMs ?? 2_000);
    if (abandoned) {
      this.logger.warn("harness did not unwind after abort; ending the turn without it");
      runtime?.close?.();
      await runtime?.flush?.().catch(() => {});
      throw abortSignal.reason ?? new Error("aborted");
    }
    // A persistence failure wins over the harness's own error: the runtime
    // aborts the harness when a write fails, so runErr is then just the
    // resulting AbortError.
    await runtime?.flush?.();
    if (runErr) throw runErr;
    return Array.isArray(runtime?.pendingConfirmations) ? [...runtime.pendingConfirmations] : null;
  }

  /** Record the client's answer for a gated / custom tool call. */
  private async applyClientToolResult(
    log: EventLogRepo,
    agent: AgentConfig,
    event: UserToolConfirmationEvent | UserCustomToolResultEvent,
    before: SessionEvent[],
    abortSignal: AbortSignal,
    resuming: boolean,
  ): Promise<void> {
    const unresolved = findUnresolvedToolUses(before);
    if (event.type === "user.custom_tool_result") {
      // Pair against the materialized agent.tool_result, not the client's
      // input: on a resume `before` already holds this promoted input, and
      // a crash between promotion and the result write must still produce
      // the result (idempotent — skipped when the output exists).
      const use = findUnresolvedToolUses(before, { clientInputResolves: false }).find(
        (u) => u.id === event.custom_tool_use_id,
      );
      if (!use) {
        this.logger.warn(`custom_tool_result for unknown/resolved call ${event.custom_tool_use_id}`);
        return;
      }
      const text = (event.content ?? [])
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("");
      await this.appendAndPublish(log, toolResultEventFor(use, text, event.is_error === true));
      return;
    }

    const use = unresolved.find((u) => u.id === event.tool_use_id);
    if (!use) {
      this.logger.warn(`tool_confirmation for unknown/resolved call ${event.tool_use_id}`);
      return;
    }
    if (event.result !== "allow") {
      const denyMsg = event.deny_message || "Tool execution was denied by the user.";
      await this.appendAndPublish(log, toolResultEventFor(use, `Denied: ${denyMsg}`, true));
      return;
    }
    // A previous attempt at this confirmation died with the approved call
    // possibly mid-execution (its intent is durable; its result isn't).
    // Never repeat a side effect blindly — record the unknown outcome.
    // (An ask-gated call may be stamped "client"; judge the tool itself.)
    const stamped = use.execution_class as ToolExecutionClass | undefined;
    const cls = stamped && stamped !== "client" ? stamped : classifyTool(use.name);
    if (resuming && cls !== "idempotent") {
      const result = buildInterruptedToolResult({
        tool_use_id: use.id,
        event_type: use.type,
        name: use.name,
        input: use.input,
        execution_class: "side_effect",
        ...(use.idempotency_key ? { idempotency_key: use.idempotency_key } : {}),
      });
      if (result) await this.appendAndPublish(log, result);
      return;
    }
    // Allowed: rebuild the tool dict with the ask-gates lifted so the
    // tool carries its execute function (buildTools strips it for
    // always_ask / policy-ask tools), then run exactly this call. The
    // tool_use intent is already durable (previous turn), and the result
    // is persisted as soon as it settles.
    let content: string;
    let isError = false;
    try {
      const built = (await this.deps.buildTools(withAskGatesLifted(agent), this.deps.sandbox)) as Record<
        string,
        { execute?: (input: unknown, opts: unknown) => Promise<unknown> } | undefined
      >;
      const execute = built?.[use.name]?.execute;
      if (!execute) throw new Error(`tool ${use.name} is not available`);
      const result = await execute(use.input, {
        toolCallId: use.id,
        messages: [],
        abortSignal,
      });
      content = typeof result === "string" ? result : JSON.stringify(result);
    } catch (err) {
      if (abortSignal.aborted) throw err;
      content = `Error: ${errorMessage(err)}`;
      isError = true;
    }
    await this.appendAndPublish(log, toolResultEventFor(use, content, isError));
  }

  /**
   * Move a queue-input event into the event log (processed_at = now) and
   * publish it plus the system.user_message_promoted notification.
   * Idempotent by event id: a retried turn (lease reclaimed after a
   * crash) finds the row the first attempt already promoted.
   */
  private async promote(
    log: EventLogRepo,
    event: TurnInputEvent,
    pendingSeq: number | undefined,
    existing: SessionEvent | null,
  ): Promise<SessionEvent> {
    const ev = { ...event } as SessionEvent & { id?: string; processed_at?: string };
    ev.id ??= generateEventId();
    ev.processed_at = new Date().toISOString();
    let stored: SessionEvent;
    if (existing) {
      stored = existing;
    } else {
      stored = await this.appendStored(log, ev);
      this.deps.publish(stored);
    }
    this.deps.publish({
      type: "system.user_message_promoted",
      event_id: ev.id,
      ...(pendingSeq !== undefined ? { pending_seq: pendingSeq } : {}),
      ...(seqOf(stored) !== undefined ? { seq: seqOf(stored) } : {}),
      processed_at: (stored as { processed_at?: string }).processed_at ?? ev.processed_at,
      session_thread_id:
        (stored as { session_thread_id?: string }).session_thread_id ?? "sthr_primary",
    } as unknown as SessionEvent);
    return stored;
  }

  /**
   * The session.status_idle that ended the turn driven by `promoted`, if
   * one was written. Turns are serialized per session (one running work
   * item, enforced by the queue), so the first idle on the input's thread
   * after its promotion is that turn's terminal event. Recovery never
   * writes session.status_idle, so an orphan reconciliation can't fake it.
   */
  private async findTurnTerminal(
    log: EventLogRepo,
    promoted: SessionEvent,
  ): Promise<{ stop_reason?: TurnStopReason; failed?: boolean; error?: string } | null> {
    const id = (promoted as { id?: string }).id;
    const seq = seqOf(promoted);
    let after: SessionEvent[];
    if (seq !== undefined) {
      after = await this.readEvents(log, seq);
    } else {
      const all = await this.readEvents(log);
      const idx = all.findIndex((e) => (e as { id?: string }).id === id);
      if (idx < 0) return null;
      after = all.slice(idx + 1);
    }
    const thread = (promoted as { session_thread_id?: string }).session_thread_id ?? "sthr_primary";
    let lastError: string | undefined;
    for (const e of after) {
      const t = (e as { session_thread_id?: string }).session_thread_id ?? "sthr_primary";
      if (t !== thread) continue;
      if (e.type === "session.error") {
        const ev = e as { message?: string; error?: unknown };
        lastError = ev.message ?? (typeof ev.error === "string" ? ev.error : undefined);
        continue;
      }
      if (e.type !== "session.status_idle") continue;
      const stop = (e as { stop_reason?: TurnStopReason }).stop_reason;
      // Error paths write their idle WITHOUT a stop_reason (CF parity).
      return stop ? { stop_reason: stop } : { failed: true, error: lastError };
    }
    return null;
  }

  private async findEventById(log: EventLogRepo, id: string): Promise<SessionEvent | null> {
    const lookup = (log as unknown as AsyncEventLog).findEventByIdAsync;
    return lookup ? lookup.call(log, id) : null;
  }

  private async recoverOrphan(
    o: OrphanTurn,
    log: EventLogRepo,
    opts: { deferIdempotent?: boolean },
  ): Promise<void> {
    this.logger.warn(
      `recovering orphan turn ${o.turn_id} (started ${
        Date.now() - o.turn_started_at
      }ms ago)`,
    );

    // recoverInterruptedState is pure over a sync {append, getEvents}
    // pair. Serve getEvents from one fresh snapshot, and route its sync
    // appends through a serial chain of awaited, published writes so
    // placeholder events keep their order and failures surface here.
    const allEvents = await this.readEvents(log);
    let writes: Promise<unknown> = Promise.resolve();
    const syncLog: Pick<EventLogRepo, "append" | "getEvents"> = {
      append: (event: SessionEvent) => {
        writes = writes.then(() => this.appendAndPublish(log, event));
      },
      getEvents: () => allEvents,
    };

    const report = await recoverInterruptedState(this.deps.adapter.streams, syncLog, {
      deferIdempotent: opts.deferIdempotent === true,
    });
    await writes;

    // Persist (then publish) warnings so they survive a refresh / replay,
    // not just reach live SSE subscribers. Same durable session.warning
    // the harness writes for tool_call_recovered.
    for (const w of report.warnings) {
      await this.appendAndPublish(log, {
        ...w.details,
        type: "session.warning",
        source: w.source,
        message: w.message,
      } as unknown as SessionEvent);
    }

    // Mark the orphaned turn done so subsequent listOrphanTurns calls
    // don't re-trigger recovery.
    await this.deps.adapter.endTurn(this.deps.sessionId, o.turn_id, "idle");
  }

  private async readEvents(log: EventLogRepo, afterSeq?: number): Promise<SessionEvent[]> {
    const asyncRead = (log as unknown as AsyncEventLog).getEventsAsync;
    return asyncRead ? asyncRead.call(log, afterSeq) : log.getEvents(afterSeq);
  }

  /** Persist and return the event as stored (with seq when available). */
  private async appendStored(log: EventLogRepo, event: SessionEvent): Promise<SessionEvent> {
    const appendAsync = (log as unknown as AsyncEventLog).appendAsync;
    if (appendAsync) {
      const stored = await appendAsync.call(log, event);
      return stored ?? event;
    }
    log.append(event);
    const seq = log.getLastEventSeq(event.type);
    return (seq >= 0 ? { ...event, seq } : event) as SessionEvent;
  }

  private async appendAndPublish(log: EventLogRepo, event: SessionEvent): Promise<SessionEvent> {
    const stamped = {
      ...event,
      id: (event as { id?: string }).id ?? generateEventId(),
      processed_at:
        (event as { processed_at?: string }).processed_at ??
        new Date().toISOString(),
    } as SessionEvent;
    const stored = await this.appendStored(log, stamped);
    this.deps.publish(stored);
    return stored;
  }
}

/**
 * Did the harness's model loop already finish, judging from the turn's
 * persisted events? Only when the harness SAID so: the last model output
 * on the thread is an agent.message carrying `step_final` (written once
 * the whole step was known to have no tool calls and non-empty text) and
 * nothing is left unresolved. Inferring completion from a partially
 * persisted step is unsafe — text before a tool call is written ahead of
 * the tool_use, and empty replies are written before silent_stop fails the
 * turn (PR #30 QA round 3, R1/R2). No marker → resume, as before.
 */
const STEP_OUTPUT_TYPES = new Set([
  "agent.message",
  "agent.tool_use",
  "agent.custom_tool_use",
  "agent.mcp_tool_use",
  "agent.tool_result",
  "agent.mcp_tool_result",
]);

function isBlankMessage(e: SessionEvent): boolean {
  const content = (e as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
  return content.every((b) => b.type === "text" && !(b.text ?? "").trim());
}

export function modelLoopFinished(turnEvents: SessionEvent[], threadId?: string): boolean {
  const thread = threadId ?? "sthr_primary";
  const onThread = turnEvents.filter(
    (e) => ((e as { session_thread_id?: string }).session_thread_id ?? "sthr_primary") === thread,
  );
  // Blank messages carry no answer (a step can end with an empty text
  // block after its real reply) — skip them when finding the last output.
  const outputs = onThread.filter(
    (e) => STEP_OUTPUT_TYPES.has(e.type) && !(e.type === "agent.message" && isBlankMessage(e)),
  );
  const last = outputs[outputs.length - 1];
  if (!last || last.type !== "agent.message") return false;
  if ((last as { step_final?: boolean }).step_final !== true) return false;
  return findUnresolvedToolUses(onThread).length === 0;
}

function seqOf(event: SessionEvent): number | undefined {
  const seq = (event as { seq?: unknown }).seq;
  return typeof seq === "number" ? seq : undefined;
}
