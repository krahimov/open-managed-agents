/**
 * Pi harness — see harness.ts and docs/pi-harness.md.
 */
export { PiHarness, PiEventBridge, type PiHarnessOptions } from "./harness";
export {
  resolvePiModel,
  credentialsFromLanguageModel,
  errorStream,
  type PiModelCredentials,
  type ResolvedPiModel,
} from "./model";
export {
  modelMessagesToPi,
  ensureContinuableTail,
  thinkingFromProviderOptions,
  providerOptionsFromThinking,
} from "./messages";
export {
  adaptOmaTools,
  normalizeToolOutputForWire,
  wireToPiContent,
  piContentToWire,
  PENDING_TOOL_TEXT,
  type AdaptedTools,
  type OmaToolDetails,
} from "./tools";
