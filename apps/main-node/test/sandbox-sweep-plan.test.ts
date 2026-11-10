// Orphan-sweep decisions (lib/sandbox-sweep-plan.ts). Pure: no provider, no
// database — every safety rule is pinned here.

import { describe, expect, it } from "vitest";
import type { ProviderBox } from "@open-managed-agents/sandbox/adapters/daytona-inventory";
import {
  agentKey,
  planSandboxSweep,
  sessionBoxReason,
  type SweepPlanInput,
  type SweepSession,
} from "../src/lib/sandbox-sweep-plan";

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const HERE = "dep_here";

let seq = 0;
function box(labels: Record<string, string>, extra: Partial<ProviderBox> = {}): ProviderBox {
  return { id: `box-${++seq}`, state: "stopped", labels, createdAtMs: NOW - 30 * DAY, ...extra };
}
function machineBox(extra: Record<string, string> = {}, more: Partial<ProviderBox> = {}): ProviderBox {
  return box({ "oma-machine-id": "amch-1", "oma-tenant-id": "tenant-a", "oma-agent-id": "agent-a", ...extra }, more);
}
function sessionBox(extra: Record<string, string> = {}, more: Partial<ProviderBox> = {}): ProviderBox {
  return box({ "oma-session-id": "sess-1", ...extra }, more);
}
function session(over: Partial<SweepSession> = {}): SweepSession {
  return { id: "sess-1", tenantId: "tenant-a", status: "idle", lastActiveAtMs: NOW - 30 * DAY, ...over };
}
function plan(over: Partial<SweepPlanInput>) {
  return planSandboxSweep({
    now: NOW, deploymentId: HERE, boxes: [], machines: [], existingAgents: new Set(), sessions: new Map(),
    sessionMaxAgeMs: 7 * DAY, minBoxAgeMs: HOUR, adoptUnlabelled: false, ...over,
  });
}
const agentAlive = new Set([agentKey("tenant-a", "agent-a")]);
const row = { id: "amch-1", tenantId: "tenant-a", agentId: "agent-a", providerRef: "box-ref" };

describe("planSandboxSweep — boxes that are never touched", () => {
  it("skips boxes without OMA labels", () => {
    const b = box({ team: "data", "oma-tenant-id": "tenant-a" });
    expect(plan({ boxes: [b] })).toEqual({ actions: [], skipped: [{ boxId: b.id, reason: "not_oma" }] });
  });

  it("skips boxes labelled for another deployment, even when they look orphaned", () => {
    const m = machineBox({ "oma-deployment-id": "dep_elsewhere" });
    const s = sessionBox({ "oma-deployment-id": "dep_elsewhere" });
    expect(plan({ boxes: [m, s], adoptUnlabelled: true })).toEqual({
      actions: [],
      skipped: [{ boxId: m.id, reason: "other_deployment" }, { boxId: s.id, reason: "other_deployment" }],
    });
  });

  it("skips unlabelled-deployment boxes this database knows nothing about", () => {
    const m = machineBox();
    const s = sessionBox();
    expect(plan({ boxes: [m, s] })).toEqual({
      actions: [],
      skipped: [{ boxId: m.id, reason: "unproven_owner" }, { boxId: s.id, reason: "unproven_owner" }],
    });
  });

  it("skips a machine box with incomplete identity labels", () => {
    const b = box({ "oma-machine-id": "amch-1", "oma-deployment-id": HERE });
    expect(plan({ boxes: [b] }).skipped).toEqual([{ boxId: b.id, reason: "label_mismatch" }]);
  });

  it("skips a machine box whose labels disagree with its row", () => {
    const b = machineBox({ "oma-tenant-id": "tenant-b", "oma-deployment-id": HERE });
    const result = plan({ boxes: [b], machines: [row], existingAgents: agentAlive });
    expect(result).toEqual({ actions: [], skipped: [{ boxId: b.id, reason: "label_mismatch" }] });
  });

  it("skips a session box whose tenant label disagrees with the session", () => {
    const b = sessionBox({ "oma-tenant-id": "tenant-b", "oma-deployment-id": HERE });
    const result = plan({ boxes: [b], sessions: new Map([["sess-1", session()]]) });
    expect(result).toEqual({ actions: [], skipped: [{ boxId: b.id, reason: "label_mismatch" }] });
  });

  it("skips boxes that are too new or of unknown age", () => {
    const fresh = sessionBox({ "oma-deployment-id": HERE }, { createdAtMs: NOW - 10 * 60_000 });
    const unknown = machineBox({ "oma-deployment-id": HERE }, { createdAtMs: null });
    expect(plan({ boxes: [fresh, unknown] })).toEqual({
      actions: [],
      skipped: [{ boxId: fresh.id, reason: "too_new" }, { boxId: unknown.id, reason: "too_new" }],
    });
  });
});

describe("planSandboxSweep — agent computers", () => {
  it("keeps the computer of a live agent", () => {
    const b = machineBox({ "oma-deployment-id": HERE });
    expect(plan({ boxes: [b], machines: [row], existingAgents: agentAlive })).toEqual({
      actions: [], skipped: [{ boxId: b.id, reason: "live" }],
    });
  });

  it("removes the machine row (and through it the box) when the agent is gone", () => {
    const b = machineBox();
    expect(plan({ boxes: [b], machines: [row] })).toEqual({
      actions: [{ kind: "machine", reason: "agent_missing", machineId: "amch-1", tenantId: "tenant-a", agentId: "agent-a", providerRef: "box-ref" }],
      skipped: [],
    });
  });

  it("removes a machine row for a missing agent even when no box is left", () => {
    expect(plan({ machines: [{ ...row, providerRef: null }] }).actions).toEqual([
      { kind: "machine", reason: "agent_missing", machineId: "amch-1", tenantId: "tenant-a", agentId: "agent-a", providerRef: null },
    ]);
  });

  it("deletes a box of this deployment whose row and agent are both gone", () => {
    const b = machineBox({ "oma-deployment-id": HERE });
    expect(plan({ boxes: [b] }).actions).toEqual([{
      kind: "machine_box", reason: "agent_missing", boxId: b.id, machineId: "amch-1", tenantId: "tenant-a", agentId: "agent-a",
      expectLabels: { "oma-machine-id": "amch-1", "oma-tenant-id": "tenant-a", "oma-agent-id": "agent-a", "oma-deployment-id": HERE },
    }]);
  });

  it("keeps a row-less box while its agent still exists", () => {
    const b = machineBox({ "oma-deployment-id": HERE });
    expect(plan({ boxes: [b], existingAgents: agentAlive })).toEqual({ actions: [], skipped: [{ boxId: b.id, reason: "live" }] });
  });

  it("tells tenants apart: the same agent id in another tenant does not keep a box alive", () => {
    const b = machineBox({ "oma-deployment-id": HERE });
    expect(plan({ boxes: [b], existingAgents: new Set([agentKey("tenant-b", "agent-a")]) }).actions).toHaveLength(1);
  });

  it("adopts unlabelled orphan boxes only when the operator opted in", () => {
    const b = machineBox();
    expect(plan({ boxes: [b] }).actions).toEqual([]);
    expect(plan({ boxes: [b], adoptUnlabelled: true }).actions).toEqual([
      expect.objectContaining({ kind: "machine_box", boxId: b.id, expectLabels: expect.objectContaining({ "oma-deployment-id": null }) }),
    ]);
  });
});

describe("planSandboxSweep — session sandboxes", () => {
  it("deletes this deployment's box when its session no longer exists", () => {
    const b = sessionBox({ "oma-tenant-id": "tenant-a", "oma-deployment-id": HERE });
    expect(plan({ boxes: [b] }).actions).toEqual([{
      kind: "session_box", reason: "session_missing", boxId: b.id, sessionId: "sess-1", tenantId: "tenant-a",
      expectLabels: { "oma-session-id": "sess-1", "oma-tenant-id": "tenant-a", "oma-deployment-id": HERE },
    }]);
  });

  it("deletes the box of a session idle or terminated beyond the max age", () => {
    const b = sessionBox({ "oma-deployment-id": HERE });
    const idle = plan({ boxes: [b], sessions: new Map([["sess-1", session({ lastActiveAtMs: NOW - 8 * DAY })]]) });
    expect(idle.actions).toEqual([expect.objectContaining({ kind: "session_box", reason: "session_idle", tenantId: "tenant-a" })]);
    const terminated = plan({ boxes: [b], sessions: new Map([["sess-1", session({ status: "terminated", lastActiveAtMs: NOW - 8 * DAY })]]) });
    expect(terminated.actions).toEqual([expect.objectContaining({ reason: "session_terminated" })]);
  });

  it("keeps the box of a recently active or running session", () => {
    const b = sessionBox({ "oma-deployment-id": HERE });
    for (const s of [
      session({ lastActiveAtMs: NOW - 6 * DAY }),
      session({ status: "terminated", lastActiveAtMs: NOW - DAY }),
      session({ status: "running", lastActiveAtMs: NOW - 30 * DAY }),
      session({ status: "rescheduling", lastActiveAtMs: NOW - 30 * DAY }),
    ]) {
      expect(plan({ boxes: [b], sessions: new Map([["sess-1", s]]) })).toEqual({
        actions: [], skipped: [{ boxId: b.id, reason: "live" }],
      });
    }
  });

  it("treats a pre-label box as this deployment's once its session is in the database", () => {
    const b = sessionBox();
    const result = plan({ boxes: [b], sessions: new Map([["sess-1", session()]]) });
    expect(result.actions).toEqual([
      expect.objectContaining({ kind: "session_box", reason: "session_idle", expectLabels: { "oma-session-id": "sess-1", "oma-deployment-id": null } }),
    ]);
  });

  it("honours a configured max age", () => {
    const b = sessionBox({ "oma-deployment-id": HERE });
    const sessions = new Map([["sess-1", session({ lastActiveAtMs: NOW - 2 * DAY })]]);
    expect(plan({ boxes: [b], sessions }).actions).toEqual([]);
    expect(plan({ boxes: [b], sessions, sessionMaxAgeMs: DAY }).actions).toHaveLength(1);
  });
});

describe("sessionBoxReason", () => {
  it("is the single source for when a session's box may go", () => {
    expect(sessionBoxReason(null, NOW, 7 * DAY)).toBe("session_missing");
    expect(sessionBoxReason(session({ lastActiveAtMs: NOW - 7 * DAY }), NOW, 7 * DAY)).toBe("session_idle");
    expect(sessionBoxReason(session({ lastActiveAtMs: NOW - 7 * DAY + 1 }), NOW, 7 * DAY)).toBeNull();
    expect(sessionBoxReason(session({ status: "running" }), NOW, 7 * DAY)).toBeNull();
  });
});
