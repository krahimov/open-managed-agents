import {
  generatePermissionGrantId,
  validatePermissionRules,
} from "@open-managed-agents/shared";
import type { EffectivePolicy } from "@open-managed-agents/shared";
import type {
  NewPermissionGrantInput,
  PermissionGrantClock,
  PermissionGrantIdGenerator,
  PermissionGrantRepo,
} from "./grants-ports";
import type { PermissionGrantRow } from "./grants-types";

export interface PermissionGrantServiceDeps {
  repo: PermissionGrantRepo;
  clock?: PermissionGrantClock;
  ids?: PermissionGrantIdGenerator;
}

/**
 * Versioned baseline grants (Phase 1). Every write — rule change or
 * enable/disable — appends a new version under the (tenant, agent,
 * baseline) key; nothing is updated in place. Phase 2's approval endpoint
 * and Phase 3's principal overlays reuse the same append path.
 */
export class PermissionGrantService {
  private readonly repo: PermissionGrantRepo;
  private readonly clock: PermissionGrantClock;
  private readonly ids: PermissionGrantIdGenerator;

  constructor(deps: PermissionGrantServiceDeps) {
    this.repo = deps.repo;
    this.clock = deps.clock ?? { nowMs: () => Date.now() };
    this.ids = deps.ids ?? { permissionGrantId: generatePermissionGrantId };
  }

  /** Write the next baseline version. `approvedBy` is required — a grant
   *  version without a ratifying identity must never exist. */
  async setBaseline(opts: {
    tenantId: string;
    agentId: string;
    rules: unknown;
    enabled?: boolean;
    approvedBy: string;
    proposedBy?: string;
  }): Promise<PermissionGrantRow> {
    if (typeof opts.approvedBy !== "string" || !opts.approvedBy.trim()) {
      throw new TypeError("approved_by is required");
    }
    const rules = validatePermissionRules(opts.rules);
    const current = await this.repo.getActive(
      opts.tenantId,
      opts.agentId,
      "baseline",
      null,
    );
    const input: NewPermissionGrantInput = {
      id: this.ids.permissionGrantId(),
      tenantId: opts.tenantId,
      agentId: opts.agentId,
      principalType: "baseline",
      principalId: null,
      rules,
      version: (current?.version ?? 0) + 1,
      enabled: opts.enabled ?? true,
      approvedBy: opts.approvedBy.trim(),
      ...(opts.proposedBy ? { proposedBy: opts.proposedBy } : {}),
      createdAt: this.clock.nowMs(),
    };
    return this.repo.insert(input);
  }

  getBaseline(opts: {
    tenantId: string;
    agentId: string;
  }): Promise<PermissionGrantRow | null> {
    return this.repo.getActive(opts.tenantId, opts.agentId, "baseline", null);
  }

  listBaselineVersions(opts: {
    tenantId: string;
    agentId: string;
  }): Promise<PermissionGrantRow[]> {
    return this.repo.listVersions(opts.tenantId, opts.agentId, "baseline", null);
  }

  /**
   * The policy to pin into a session snapshot at init. Phase 1: baseline
   * only — a disabled or absent baseline resolves to null (legacy
   * allow-all). Phase 3 extends this to baseline ∩ role ∩ user.
   */
  async resolveEffectivePolicy(opts: {
    tenantId: string;
    agentId: string;
  }): Promise<EffectivePolicy | null> {
    const baseline = await this.getBaseline(opts);
    if (!baseline || !baseline.enabled) return null;
    return {
      grant_id: baseline.id,
      grant_version: baseline.version,
      rules: baseline.rules,
    };
  }
}
