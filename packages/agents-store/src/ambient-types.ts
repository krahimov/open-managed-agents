export const AMBIENT_TRIGGER_SOURCES = [
  "schedule",
  "webhook",
  "slack",
  "teams",
  "github",
  "linear",
  "email",
  "memory",
  "file",
  "manual",
] as const;

export type AmbientTriggerSource = (typeof AMBIENT_TRIGGER_SOURCES)[number];

export const AMBIENT_WAKE_MODES = [
  "observe",
  "decide",
  "act",
  "escalate",
] as const;

export type AmbientWakeMode = (typeof AMBIENT_WAKE_MODES)[number];

export const AMBIENT_DECISION_OUTCOMES = [
  "skip",
  "observe",
  "create_session",
  "resume_session",
  "request_approval",
  "error",
] as const;

export type AmbientDecisionOutcome =
  (typeof AMBIENT_DECISION_OUTCOMES)[number];

export interface AmbientTriggerConfig {
  source: AmbientTriggerSource;
  config?: Record<string, unknown>;
}

export interface AmbientDecisionSnapshot {
  outcome: AmbientDecisionOutcome;
  decided_at: string;
  reason?: string;
  session_id?: string;
  source_event_id?: string;
}

export interface AmbientRuleConfig {
  id: string;
  agent_id: string;
  name: string;
  description?: string;
  enabled: boolean;
  trigger: AmbientTriggerConfig;
  wake_mode: AmbientWakeMode;
  decision_policy?: Record<string, unknown>;
  execution_profile?: string;
  budget?: Record<string, unknown>;
  created_by?: string;
  created_at: string;
  updated_at?: string;
  next_wake_at?: string;
  last_wake_at?: string;
  last_decision?: AmbientDecisionSnapshot;
}

export type AmbientRuleRow = AmbientRuleConfig & {
  tenant_id: string;
};
