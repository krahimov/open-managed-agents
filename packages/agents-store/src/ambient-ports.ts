import type {
  AmbientDecisionSnapshot,
  AmbientRuleConfig,
  AmbientRuleRow,
  AmbientTriggerConfig,
  AmbientWakeMode,
} from "./ambient-types";

export interface NewAmbientRuleInput {
  id: string;
  tenantId: string;
  agentId: string;
  config: AmbientRuleConfig;
  createdAt: number;
}

export interface AmbientRuleUpdateFields {
  config: AmbientRuleConfig;
  enabled: boolean;
  triggerSource: string;
  wakeMode: string;
  updatedAt: number;
  nextWakeAt?: number | null;
  lastWakeAt?: number | null;
}

export interface AmbientRuleRepo {
  insert(input: NewAmbientRuleInput): Promise<AmbientRuleRow>;
  get(
    tenantId: string,
    agentId: string,
    ruleId: string,
  ): Promise<AmbientRuleRow | null>;
  listByAgent(tenantId: string, agentId: string): Promise<AmbientRuleRow[]>;
  listDue(opts: {
    tenantId?: string;
    now: number;
    limit: number;
  }): Promise<AmbientRuleRow[]>;
  update(
    tenantId: string,
    agentId: string,
    ruleId: string,
    fields: AmbientRuleUpdateFields,
  ): Promise<AmbientRuleRow>;
  softDelete(
    tenantId: string,
    agentId: string,
    ruleId: string,
    deletedAt: number,
  ): Promise<void>;
}

export interface AmbientRuleCreateInput {
  name: string;
  description?: string;
  enabled?: boolean;
  trigger: AmbientTriggerConfig;
  wake_mode?: AmbientWakeMode;
  decision_policy?: Record<string, unknown>;
  execution_profile?: string;
  budget?: Record<string, unknown>;
  next_wake_at?: string | null;
  created_by?: string;
}

export interface AmbientRuleUpdateInput {
  name?: string;
  description?: string | null;
  enabled?: boolean;
  trigger?: AmbientTriggerConfig;
  wake_mode?: AmbientWakeMode;
  decision_policy?: Record<string, unknown> | null;
  execution_profile?: string | null;
  budget?: Record<string, unknown> | null;
  next_wake_at?: string | null;
  last_wake_at?: string | null;
  last_decision?: AmbientDecisionSnapshot | null;
}

export interface AmbientRuleClock {
  nowMs(): number;
}

export interface AmbientRuleIdGenerator {
  ambientRuleId(): string;
}
