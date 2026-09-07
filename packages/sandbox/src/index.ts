export type {
  AgentMachineBinding,
  ProcessHandle,
  SandboxBrowserEndpoint,
  SandboxExecutor,
  SandboxExecutorCapabilities,
  SandboxFactory,
  SandboxFactoryContext,
  SandboxFactoryEnv,
  SandboxProcessInfo,
} from "./ports";

export { DEFAULT_SESSION_OUTPUTS_DIR } from "./ports";

export {
  DefaultSandboxOrchestrator,
  type SandboxOrchestrator,
  type SandboxCapabilities,
  type ProvisionInput,
  type OrchestratorMemoryMount,
  type OrchestratorBackupHandle,
  type WorkspaceBackupService,
  type DefaultSandboxOrchestratorDeps,
} from "./orchestrator";
