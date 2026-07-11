import type {
  PermissionPrincipalType,
  PermissionRule,
} from "@open-managed-agents/shared";
import type { PermissionGrantRow } from "./grants-types";

export interface NewPermissionGrantInput {
  id: string;
  tenantId: string;
  agentId: string;
  principalType: PermissionPrincipalType;
  principalId: string | null;
  rules: PermissionRule[];
  version: number;
  enabled: boolean;
  proposedBy?: string;
  approvedBy: string;
  createdAt: number;
}

export interface PermissionGrantRepo {
  insert(input: NewPermissionGrantInput): Promise<PermissionGrantRow>;
  /** Highest-version row for the principal key, enabled or not. */
  getActive(
    tenantId: string,
    agentId: string,
    principalType: PermissionPrincipalType,
    principalId: string | null,
  ): Promise<PermissionGrantRow | null>;
  /** All versions for the principal key, newest first. */
  listVersions(
    tenantId: string,
    agentId: string,
    principalType: PermissionPrincipalType,
    principalId: string | null,
  ): Promise<PermissionGrantRow[]>;
}

export interface PermissionGrantClock {
  nowMs(): number;
}

export interface PermissionGrantIdGenerator {
  permissionGrantId(): string;
}
