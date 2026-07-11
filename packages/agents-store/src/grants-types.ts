import type {
  PermissionPrincipalType,
  PermissionRule,
} from "@open-managed-agents/shared";

/**
 * One stored grant version. Rows are append-only: every change writes
 * version+1 for the same (tenant, agent, principal) key, so approvals have
 * immutable lineage. The active grant is the highest version; a disabled
 * active version means "no policy" (legacy allow-all).
 */
export interface PermissionGrantRow {
  id: string;
  tenant_id: string;
  agent_id: string;
  principal_type: PermissionPrincipalType;
  principal_id: string | null;
  rules: PermissionRule[];
  version: number;
  enabled: boolean;
  /** Session id when the version came from an agent proposal (Phase 2). */
  proposed_by?: string;
  /** User id that ratified this version. */
  approved_by: string;
  created_at: string;
}
