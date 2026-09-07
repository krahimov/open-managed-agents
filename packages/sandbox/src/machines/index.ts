// Barrel for `@open-managed-agents/sandbox/machines` — provider-agnostic
// agent-machine types, the store port, typed errors and the in-memory
// reference store. Provider-specific managers (Daytona) live next to this
// file in later slices and are exported from here as they land.

export type {
  AgentMachineState,
  AgentMachineDesiredState,
  AgentMachineSdkMode,
  AgentMachineSpec,
  AgentMachineRow,
  AgentMachineAttachment,
  AgentMachineEvent,
  AgentMachinePatch,
  AgentMachineInsertInput,
  AgentMachineAttachmentInput,
  AgentMachineAttachmentFlags,
  AgentMachineEventInput,
  AgentMachineStore,
  MachineErrorCode,
} from "./ports";

export {
  DEFAULT_ATTACHMENT_STALE_MS,
  DEFAULT_EVENT_LIST_LIMIT,
  RUNNING_LIKE_STATES,
  AgentMachineError,
  MachineBusyError,
  MachineQuotaError,
  MachineLockedError,
  MachineConfigMismatchError,
  isAgentMachineError,
  newAgentMachineRow,
  normalizeExpectedStates,
  InMemoryAgentMachineStore,
} from "./ports";
