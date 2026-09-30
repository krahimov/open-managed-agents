// Public surface of @open-managed-agents/session-runtime.
//
// Phase 2 of the unified-runtime refactor: SessionStateMachine + the
// shared RuntimeAdapterImpl land here so apps/main-node (Node) can
// adopt them. Phase 3 swaps apps/agent's SessionDO to use the same
// SessionStateMachine.
//
// See nifty-prancing-flamingo.md plan for the full architecture.

export {
  recoverInterruptedState,
  type RecoveryReport,
  type RecoveryWarning,
  type RecoveryOptions,
  type RecoveredToolCall,
} from "./recovery";

export {
  classifyTool,
  executionClassOf,
  findOrphanToolUses,
  buildInterruptedToolResult,
  idempotencyKeyFor,
  IDEMPOTENT_TOOL_NAMES,
  type ToolExecutionClass,
  type OrphanToolUse,
  type McpToolAnnotations,
  type ClassifyToolOptions,
} from "./tool-classification";

export type { RuntimeAdapter, TurnId, OrphanTurn } from "./ports";
export { RuntimeAdapterImpl, type RuntimeAdapterOptions } from "./adapter";
export {
  SessionStateMachine,
  SESSION_ERROR_EMITTED_MARKER,
  sessionErrorAlreadyEmitted,
  TurnLeaseLostError,
  isTurnLeaseLost,
  type SessionMachineDeps,
  type HarnessRunFn,
  type TurnInputEvent,
  type TurnAbortReason,
  type TurnOptions,
  type TurnResult,
} from "./machine";
export {
  findUnresolvedToolUses,
  outstandingRequiredActions,
  computeStopReason,
  toolResultEventFor,
  withAskGatesLifted,
  type UnresolvedToolUse,
  type TurnStopReason,
} from "./tool-actions";
export { activeOutcomeFromEvents, type DerivedOutcome } from "./outcome";

export type {
  SessionRouter,
  SessionInitParams,
  SessionEventsQuery,
  SessionEventsPage,
  SessionFullStatus,
  SessionExecResult,
  SessionAppendResult,
  SessionStreamFrame,
  SessionStreamHandle,
  FileIdResolver,
} from "./router";
