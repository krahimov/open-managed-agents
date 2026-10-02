// Node wiring for the AMA outcome supervisor (user.define_outcome).
//
// CF runs runOutcomeSupervisor inside SessionDO.processUserMessage with the
// outcome held in DO state. Node has no per-session state store, so the
// active outcome, the iteration to resume at and the evaluation history are
// derived from the event log (activeOutcomeFromEvents), and every state
// "write" the supervisor makes is already durable as the span events it
// appends. SessionStateMachine calls this after a turn ends with end_turn.

import { generateText, type LanguageModel } from "ai";
import type { AgentConfig, SessionEvent, UserMessageEvent } from "@open-managed-agents/shared";
import { extractTextFromContent } from "@open-managed-agents/shared";
import {
  activeOutcomeFromEvents,
  type SessionMachineDeps,
} from "@open-managed-agents/session-runtime";
import {
  runOutcomeSupervisor,
  type ActiveOutcomeState,
  type OutcomeEvaluationRecord,
} from "@open-managed-agents/agent/runtime/outcome-supervisor";
import { getLogger } from "@open-managed-agents/observability";

const log = getLogger("node-outcome");

type RunOutcomeInput = Parameters<NonNullable<SessionMachineDeps["runOutcome"]>>[0] & {
  tenantId: string;
  sessionId: string;
};

export interface NodeOutcomeRunnerDeps {
  /** Model that grades the turn (the session's own model, CF parity). */
  resolveJudgeModel(agent: AgentConfig, tenantId: string): Promise<{ model: LanguageModel; modelId: string }>;
  /** Text of an uploaded rubric file, or null when missing. */
  loadRubricFile(tenantId: string, fileId: string): Promise<string | null>;
  /** Shell exec in the session sandbox, for rule-based verifiers. */
  runExec(
    tenantId: string,
    sessionId: string,
    cmd: string,
    timeoutMs: number,
  ): Promise<{ exit_code: number; output: string }>;
}

async function readEvents(input: RunOutcomeInput): Promise<SessionEvent[]> {
  const l = input.eventLog as unknown as { getEventsAsync?: () => Promise<SessionEvent[]> };
  return l.getEventsAsync ? l.getEventsAsync() : input.eventLog.getEvents();
}

export function createNodeOutcomeRunner(deps: NodeOutcomeRunnerDeps) {
  return async (input: RunOutcomeInput): Promise<void> => {
    // Cheap indexed probe first — almost no session ever defines an
    // outcome, so don't read the whole log at every turn end.
    const probe = (input.eventLog as unknown as {
      getLastEventSeqAsync?: (type: string) => Promise<number>;
    }).getLastEventSeqAsync;
    if (probe && (await probe.call(input.eventLog, "user.define_outcome")) < 0) return;
    let events = await readEvents(input);
    const derived = activeOutcomeFromEvents(events);
    if (!derived) return;

    // File rubrics are resolved here (Node blob store) and handed to the
    // supervisor pre-cached; it skips its own R2-only resolver then.
    const outcome = derived.outcome as ActiveOutcomeState;
    const rubric = outcome.rubric as { type?: string; file_id?: string } | undefined;
    if (!outcome.verifier && rubric?.type === "file" && rubric.file_id) {
      const text = await deps.loadRubricFile(input.tenantId, rubric.file_id).catch(() => null);
      if (text?.trim()) outcome.rubric_content = text;
    }

    const { model, modelId } = await deps.resolveJudgeModel(input.agent, input.tenantId);
    const makeJudge = (maxOutputTokens: number) =>
      async (prompt: { system: string; user: string }, signal?: AbortSignal) => {
        const result = await generateText({
          model,
          system: prompt.system,
          messages: [{ role: "user", content: prompt.user }],
          maxOutputTokens,
          abortSignal: signal,
        });
        const text =
          result.text ||
          extractTextFromContent((result as unknown as { content?: unknown }).content);
        const u = result.usage as
          | { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number }
          | undefined;
        return {
          text,
          usage: u
            ? {
                input_tokens: u.inputTokens ?? 0,
                output_tokens: u.outputTokens ?? 0,
                cache_read_input_tokens: u.cachedInputTokens,
              }
            : undefined,
        };
      };

    // The supervisor's append/getEvents callbacks are sync; queue writes on
    // a serial chain, keep a local view for its reads, and settle the
    // chain (surfacing failures) before each revision turn and at the end.
    let writes: Promise<unknown> = Promise.resolve();
    const appendAndBroadcast = (event: SessionEvent) => {
      events = [...events, event];
      writes = writes.then(() => input.appendAndPublish(event));
    };
    let evaluations = derived.evaluations as OutcomeEvaluationRecord[];

    try {
      await runOutcomeSupervisor({
        outcome,
        initialIteration: derived.iteration,
        tenantId: input.tenantId,
        filesBucket: null,
        abortSignal: input.abortSignal,
        judgeModelId: modelId,
        getEvents: () => events,
        appendAndBroadcast,
        broadcastOnly: (event) => input.publish(event),
        // State lives in the log (span.outcome_evaluation_end rows); only
        // keep the in-memory aggregate the supervisor reads back.
        persistState: (delta) => {
          if (delta.outcome_evaluations) evaluations = delta.outcome_evaluations;
        },
        readEvaluations: () => evaluations,
        makeVerifierContext: () => ({
          sessionId: input.sessionId,
          runExec: (cmd, opts) =>
            deps.runExec(input.tenantId, input.sessionId, cmd, opts?.timeoutMs ?? 600_000),
          resolveJudge: async () => ({
            judge: makeJudge(4096),
            judgeModelId: modelId,
            judgeReasoningLevel: "instant",
          }),
        }),
        makeJudgeFn: () => makeJudge(800),
        runHarnessTurn: async (msg: UserMessageEvent) => {
          await writes;
          await input.runHarnessTurn(msg);
          events = await readEvents(input);
        },
      });
    } catch (err) {
      // Supervisor-internal failures already land as a `failed` verdict;
      // this is a caller-side crash (e.g. a write failed).
      log.warn({ err, op: "node_outcome.supervisor_failed", session_id: input.sessionId }, "outcome supervisor crashed");
    }
    await writes;
  };
}
