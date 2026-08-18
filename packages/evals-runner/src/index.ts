// Public surface — runtime-agnostic eval runner.
//
//   - `tickEvalRuns(ctx)` is the entry point both runtimes call once per
//     cron tick. CF + Node both build their EvalRunnerContext from their
//     services bundle and a sandbox-binding resolver.
//
//   - Wire types (EvalRunRecord, EvalTaskSpec, …) re-exported here so
//     tests + admin tooling can deserialize the opaque results JSON
//     without re-importing from the route file.

export {
  tickEvalRuns,
  loadRun,
  regradeRun,
  finalizeTrajectoryForStorage,
  type EvalRunnerContext,
  type EvalRunnerServices,
  type SandboxFetcher,
  type EvalMemoryPort,
} from "./tick";
export {
  DEFAULT_PASS_THRESHOLD,
  passThresholdOf,
  trialPassed,
  computeTaskMetrics,
  computeRunRollup,
} from "./metrics";
export type {
  EvalRunRecord,
  EvalTaskSpec,
  EvalTaskResult,
  EvalTrialResult,
  EvalRunStatus,
  SimulationSpec,
  SimulationPersonaSpec,
  SimulationMemorySpec,
  SimulationEpisode,
  SimulationChaosRule,
  FindingsReport,
} from "./types";
export { rowToRecord, extractResults, kvKey } from "./types";
export {
  buildPersonaPrompt,
  parsePersonaTurn,
  salvageRawMessage,
  transcriptFromEvents,
  aggregateFindings,
  clipFinding,
  maxTurnsOf,
  effectiveSim,
  episodeCount,
  DEFAULT_MAX_TURNS,
  HARD_MAX_TURNS,
  SIM_DEFAULT_TIMEOUT_MS,
  type PersonaTurn,
  type TranscriptEntry,
} from "./simulation";
export {
  selectJudgeCard,
  providerFamily,
  judgeTier,
  type JudgeCandidateCard,
  type ProviderFamily,
} from "./judge-selection";
