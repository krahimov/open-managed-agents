// AgentMachineStore — contract tests.
//
// The same suite runs against:
//   1. NodeAgentMachineStore over an in-memory better-sqlite3 client (the
//      production sqlite path — same pattern as session-wakeups.test.ts),
//   2. InMemoryAgentMachineStore from @open-managed-agents/sandbox/machines
//      (the reference implementation packages/sandbox tests build on),
// so the two can never drift in CAS / lease / staleness semantics.
//
// A third describe, gated on PG_TEST_URL (pattern from pg-queue.test.ts),
// runs the schema + insert-if-absent + lock primitives against a real
// postgres — those are the statements whose SQL differs by dialect
// (ON CONFLICT DO NOTHING, BIGINT columns, $n placeholders).

import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { BetterSqlite3SqlClient } from "@open-managed-agents/sql-client/adapters/better-sqlite3";
import { createPostgresSqlClient, type SqlClient } from "@open-managed-agents/sql-client";
import { generateAgentMachineId } from "@open-managed-agents/shared";
import {
  InMemoryAgentMachineStore,
  MachineBusyError,
  MachineLockedError,
  MachineQuotaError,
  RUNNING_LIKE_STATES,
  isAgentMachineError,
  type AgentMachineSpec,
  type AgentMachineStore,
} from "@open-managed-agents/sandbox/machines";
import { NodeAgentMachineStore } from "../src/lib/agent-machine-store";

const T0 = 1_700_000_000_000;
const SEC = 1_000;

const SPEC: AgentMachineSpec = {
  image: "daytonaio/sandbox:0.4.3",
  snapshot: null,
  workdir: "/workspace",
  aptPackages: ["git", "ripgrep"],
  bootstrapTools: true,
  browser: true,
  idleStopMinutes: 30,
  maxFileBytes: 10_000_000,
  sdkMode: "tools",
};

function insertInput(overrides: Partial<{
  id: string;
  tenantId: string;
  agentId: string;
  spec: AgentMachineSpec;
  now: number;
}> = {}) {
  return {
    id: overrides.id ?? generateAgentMachineId(),
    tenantId: overrides.tenantId ?? "tenant-a",
    agentId: overrides.agentId ?? "agent-1",
    provider: "daytona",
    spec: overrides.spec ?? SPEC,
    bootstrapHash: "sha256:bootstrap-v1",
    now: overrides.now ?? T0,
  };
}

function sqliteStore(): AgentMachineStore {
  const db = new Database(":memory:");
  return new NodeAgentMachineStore({ sql: new BetterSqlite3SqlClient(db), dialect: "sqlite" });
}

const IMPLEMENTATIONS: Array<[string, () => AgentMachineStore]> = [
  ["NodeAgentMachineStore (sqlite :memory:)", sqliteStore],
  ["InMemoryAgentMachineStore", () => new InMemoryAgentMachineStore()],
];

describe.each(IMPLEMENTATIONS)("AgentMachineStore contract — %s", (_name, build) => {
  let store: AgentMachineStore;

  beforeEach(async () => {
    store = build();
    await store.ensureSchema();
  });

  // ─── schema ─────────────────────────────────────────────────────

  it("ensureSchema is idempotent", async () => {
    await store.ensureSchema();
    await store.ensureSchema();
    const { created } = await store.insertIfAbsent(insertInput());
    expect(created).toBe(true);
  });

  // ─── insertIfAbsent ─────────────────────────────────────────────

  it("insertIfAbsent creates once per (tenant, agent) and returns the winner afterwards", async () => {
    const first = await store.insertIfAbsent(insertInput({ id: "amch-first" }));
    expect(first.created).toBe(true);
    expect(first.row).toMatchObject({
      id: "amch-first",
      tenantId: "tenant-a",
      agentId: "agent-1",
      provider: "daytona",
      providerRef: null,
      state: "creating",
      desiredState: "running",
      generation: 1,
      image: SPEC.image,
      snapshot: null,
      bootstrapHash: "sha256:bootstrap-v1",
      workdir: "/workspace",
      idleStopMinutes: 30,
      browserEnabled: true,
      lockOwner: null,
      lockExpiresAt: null,
      lastActiveAt: null,
      lastStartedAt: null,
      lastStoppedAt: null,
      lastStateSyncAt: null,
      lastBackupAt: null,
      errorReason: null,
      errorCount: 0,
      createdAt: T0,
      updatedAt: T0,
    });
    expect(first.row.config).toEqual(SPEC);

    // Second racer: different id, same key → not created, same row back.
    const second = await store.insertIfAbsent(insertInput({ id: "amch-second", now: T0 + SEC }));
    expect(second.created).toBe(false);
    expect(second.row.id).toBe("amch-first");
    expect(second.row.createdAt).toBe(T0);

    // A different agent for the same tenant is independent.
    const other = await store.insertIfAbsent(insertInput({ id: "amch-other", agentId: "agent-2" }));
    expect(other.created).toBe(true);
    expect(other.row.id).toBe("amch-other");

    expect(await store.get("tenant-a", "agent-1")).toMatchObject({ id: "amch-first" });
    expect(await store.getById("amch-other")).toMatchObject({ agentId: "agent-2" });
    expect(await store.get("tenant-a", "nope")).toBeNull();
    expect(await store.getById("amch-nope")).toBeNull();
  });

  it("insertIfAbsent snapshots the spec (image/snapshot/workdir/browser/idle come from it)", async () => {
    const spec: AgentMachineSpec = {
      ...SPEC,
      snapshot: "oma-base-2026-09",
      browser: false,
      idleStopMinutes: 5,
      sdkMode: "off",
    };
    const { row } = await store.insertIfAbsent(insertInput({ spec }));
    expect(row.snapshot).toBe("oma-base-2026-09");
    expect(row.browserEnabled).toBe(false);
    expect(row.idleStopMinutes).toBe(5);
    expect(row.config.sdkMode).toBe("off");
  });

  // ─── list / listByState ─────────────────────────────────────────

  it("list and listByState return oldest-first, filtered", async () => {
    await store.insertIfAbsent(insertInput({ id: "m1", agentId: "a1", now: T0 }));
    await store.insertIfAbsent(insertInput({ id: "m2", agentId: "a2", now: T0 + 1 }));
    await store.insertIfAbsent(insertInput({ id: "m3", tenantId: "tenant-b", agentId: "a1", now: T0 + 2 }));
    await store.transition("m2", "creating", "running", undefined, T0 + 3);
    await store.transition("m3", "creating", "stopped", undefined, T0 + 3);

    expect((await store.list()).map((r) => r.id)).toEqual(["m1", "m2", "m3"]);
    expect((await store.list("tenant-a")).map((r) => r.id)).toEqual(["m1", "m2"]);
    expect((await store.list("tenant-zzz")).map((r) => r.id)).toEqual([]);
    expect((await store.listByState(["running", "stopped"])).map((r) => r.id)).toEqual(["m2", "m3"]);
    expect((await store.listByState(["creating"])).map((r) => r.id)).toEqual(["m1"]);
    expect(await store.listByState([])).toEqual([]);
  });

  // ─── update ─────────────────────────────────────────────────────

  it("update writes the patch (null explicit, undefined ignored) and bumps updated_at", async () => {
    const { row } = await store.insertIfAbsent(insertInput({ id: "m1" }));
    expect(row.updatedAt).toBe(T0);

    const newSpec: AgentMachineSpec = { ...SPEC, idleStopMinutes: 60, browser: false };
    await store.update(
      "m1",
      {
        providerRef: "sb_123",
        generation: 2,
        config: newSpec,
        idleStopMinutes: 60,
        browserEnabled: false,
        lastStartedAt: T0 + 5 * SEC,
        errorReason: "boom",
        errorCount: 3,
        // undefined must not null the column
        snapshot: undefined,
        image: undefined,
      },
      T0 + 10 * SEC,
    );
    let got = await store.getById("m1");
    expect(got).toMatchObject({
      providerRef: "sb_123",
      generation: 2,
      idleStopMinutes: 60,
      browserEnabled: false,
      lastStartedAt: T0 + 5 * SEC,
      errorReason: "boom",
      errorCount: 3,
      image: SPEC.image,
      snapshot: null,
      state: "creating",
      updatedAt: T0 + 10 * SEC,
      createdAt: T0,
    });
    expect(got!.config).toEqual(newSpec);

    await store.update("m1", { errorReason: null, providerRef: null }, T0 + 11 * SEC);
    got = await store.getById("m1");
    expect(got!.errorReason).toBeNull();
    expect(got!.providerRef).toBeNull();
    expect(got!.updatedAt).toBe(T0 + 11 * SEC);

    // Empty patch still touches updated_at only.
    await store.update("m1", {}, T0 + 12 * SEC);
    got = await store.getById("m1");
    expect(got!.updatedAt).toBe(T0 + 12 * SEC);
    expect(got!.errorCount).toBe(3);

    // Unknown id: no throw.
    await store.update("amch-missing", { errorCount: 1 }, T0);
  });

  // ─── transition (CAS) ───────────────────────────────────────────

  it("transition is a compare-and-set on state", async () => {
    await store.insertIfAbsent(insertInput({ id: "m1" }));

    // creating → bootstrapping, with the provider_ref written in the same statement.
    expect(
      await store.transition("m1", "creating", "bootstrapping", { providerRef: "sb_1" }, T0 + SEC),
    ).toBe(true);
    let got = await store.getById("m1");
    expect(got).toMatchObject({ state: "bootstrapping", providerRef: "sb_1", updatedAt: T0 + SEC });

    // Stale expectation → refused, nothing written (patch included).
    expect(
      await store.transition("m1", "creating", "error", { errorReason: "late" }, T0 + 2 * SEC),
    ).toBe(false);
    got = await store.getById("m1");
    expect(got).toMatchObject({ state: "bootstrapping", errorReason: null, updatedAt: T0 + SEC });

    // Array of expected states.
    expect(
      await store.transition("m1", ["creating", "bootstrapping"], "running", { lastStartedAt: T0 + 3 * SEC }, T0 + 3 * SEC),
    ).toBe(true);
    got = await store.getById("m1");
    expect(got).toMatchObject({ state: "running", lastStartedAt: T0 + 3 * SEC });

    // `to` wins over a `state` key smuggled into the patch.
    expect(
      await store.transition("m1", "running", "stopping", { state: "error" }, T0 + 4 * SEC),
    ).toBe(true);
    expect((await store.getById("m1"))!.state).toBe("stopping");

    // Empty expected set / unknown id → false.
    expect(await store.transition("m1", [], "running", undefined, T0)).toBe(false);
    expect(await store.transition("amch-missing", "creating", "running", undefined, T0)).toBe(false);

    // Default `now` (Date.now()) is accepted.
    const before = Date.now();
    expect(await store.transition("m1", "stopping", "stopped")).toBe(true);
    expect((await store.getById("m1"))!.updatedAt).toBeGreaterThanOrEqual(before);
  });

  // ─── lifecycle lease ────────────────────────────────────────────

  it("tryAcquireLock: exclusive while unexpired, re-entrant for the owner, free after expiry", async () => {
    await store.insertIfAbsent(insertInput({ id: "m1" }));
    const TTL = 120 * SEC;

    expect(await store.tryAcquireLock("m1", "worker-A", TTL, T0)).toBe(true);
    let got = await store.getById("m1");
    expect(got).toMatchObject({ lockOwner: "worker-A", lockExpiresAt: T0 + TTL, updatedAt: T0 });

    // Another owner is refused while the lease is live (even at the last ms).
    expect(await store.tryAcquireLock("m1", "worker-B", TTL, T0 + 30 * SEC)).toBe(false);
    expect(await store.tryAcquireLock("m1", "worker-B", TTL, T0 + TTL)).toBe(false);
    got = await store.getById("m1");
    expect(got!.lockOwner).toBe("worker-A");

    // Same owner re-enters and the lease is extended from `now`.
    expect(await store.tryAcquireLock("m1", "worker-A", TTL, T0 + 30 * SEC)).toBe(true);
    got = await store.getById("m1");
    expect(got!.lockExpiresAt).toBe(T0 + 30 * SEC + TTL);

    // Once expired (`lock_expires_at < now`) anyone can take it over.
    const expiredAt = T0 + 30 * SEC + TTL;
    expect(await store.tryAcquireLock("m1", "worker-B", TTL, expiredAt + 1)).toBe(true);
    got = await store.getById("m1");
    expect(got).toMatchObject({ lockOwner: "worker-B", lockExpiresAt: expiredAt + 1 + TTL });

    // Unknown id → false.
    expect(await store.tryAcquireLock("amch-missing", "worker-A", TTL, T0)).toBe(false);
  });

  it("renewLock and releaseLock are guarded by owner", async () => {
    await store.insertIfAbsent(insertInput({ id: "m1" }));
    const TTL = 120 * SEC;
    expect(await store.tryAcquireLock("m1", "worker-A", TTL, T0)).toBe(true);

    // Non-owner cannot renew or release.
    expect(await store.renewLock("m1", "worker-B", TTL, T0 + 30 * SEC)).toBe(false);
    await store.releaseLock("m1", "worker-B");
    let got = await store.getById("m1");
    expect(got).toMatchObject({ lockOwner: "worker-A", lockExpiresAt: T0 + TTL });

    // Owner renews: expiry moves, owner unchanged.
    expect(await store.renewLock("m1", "worker-A", TTL, T0 + 30 * SEC)).toBe(true);
    got = await store.getById("m1");
    expect(got).toMatchObject({ lockOwner: "worker-A", lockExpiresAt: T0 + 30 * SEC + TTL, updatedAt: T0 + 30 * SEC });

    // Owner releases → row unlocked, next acquirer wins immediately.
    await store.releaseLock("m1", "worker-A");
    got = await store.getById("m1");
    expect(got).toMatchObject({ lockOwner: null, lockExpiresAt: null });
    expect(await store.renewLock("m1", "worker-A", TTL, T0 + 31 * SEC)).toBe(false);
    expect(await store.tryAcquireLock("m1", "worker-B", TTL, T0 + 31 * SEC)).toBe(true);

    // Unknown id: renew false, release no-op.
    expect(await store.renewLock("amch-missing", "worker-B", TTL, T0)).toBe(false);
    await store.releaseLock("amch-missing", "worker-B");
  });

  // ─── attachments ────────────────────────────────────────────────

  it("attachments: upsert / heartbeat / flags / liveness (90 s) / detach / stale sweep", async () => {
    await store.insertIfAbsent(insertInput({ id: "m1" }));
    const base = {
      machineId: "m1",
      tenantId: "tenant-a",
      workerId: "node_1",
      generation: 1,
      turnActive: false,
      bgProcesses: 0,
      viewers: 0,
    };

    await store.upsertAttachment({ ...base, sessionId: "sess-1", now: T0 });
    await store.upsertAttachment({ ...base, sessionId: "sess-2", turnActive: true, now: T0 + 1 });

    let live = await store.liveAttachments("m1", T0 + 10 * SEC);
    expect(live.map((a) => a.sessionId)).toEqual(["sess-1", "sess-2"]);
    expect(live[0]).toEqual({
      sessionId: "sess-1",
      machineId: "m1",
      tenantId: "tenant-a",
      workerId: "node_1",
      generation: 1,
      turnActive: false,
      bgProcesses: 0,
      viewers: 0,
      attachedAt: T0,
      heartbeatAt: T0,
    });
    expect(live[1].turnActive).toBe(true);

    // Default staleness is 90 s and the comparison is strict (`>`).
    expect((await store.liveAttachments("m1", T0 + 90 * SEC - 1)).map((a) => a.sessionId)).toEqual([
      "sess-1",
      "sess-2",
    ]);
    expect((await store.liveAttachments("m1", T0 + 90 * SEC)).map((a) => a.sessionId)).toEqual(["sess-2"]);
    expect((await store.liveAttachments("m1", T0 + 90 * SEC + 1)).map((a) => a.sessionId)).toEqual([]);
    // Custom staleness window.
    expect((await store.liveAttachments("m1", T0 + 90 * SEC + 1, 10 * 60 * SEC)).length).toBe(2);

    // heartbeat keeps sess-1 alive past the window.
    await store.heartbeat("sess-1", T0 + 60 * SEC);
    live = await store.liveAttachments("m1", T0 + 100 * SEC);
    expect(live.map((a) => a.sessionId)).toEqual(["sess-1"]);
    expect(live[0].heartbeatAt).toBe(T0 + 60 * SEC);

    // Flag changes are partial and also count as a heartbeat.
    await store.setAttachmentFlags("sess-2", { bgProcesses: 2, viewers: 1 }, T0 + 100 * SEC);
    live = await store.liveAttachments("m1", T0 + 100 * SEC);
    expect(live.map((a) => a.sessionId)).toEqual(["sess-1", "sess-2"]);
    const s2 = live.find((a) => a.sessionId === "sess-2")!;
    expect(s2).toMatchObject({ turnActive: true, bgProcesses: 2, viewers: 1, heartbeatAt: T0 + 100 * SEC });
    await store.setAttachmentFlags("sess-2", { turnActive: false }, T0 + 101 * SEC);
    expect((await store.liveAttachments("m1", T0 + 101 * SEC)).find((a) => a.sessionId === "sess-2")).toMatchObject({
      turnActive: false,
      bgProcesses: 2,
      viewers: 1,
    });

    // Re-upsert for the same machine keeps attached_at, refreshes the rest.
    await store.upsertAttachment({ ...base, sessionId: "sess-1", workerId: "node_2", generation: 2, now: T0 + 120 * SEC });
    const s1 = (await store.liveAttachments("m1", T0 + 120 * SEC)).find((a) => a.sessionId === "sess-1")!;
    expect(s1).toMatchObject({ workerId: "node_2", generation: 2, attachedAt: T0, heartbeatAt: T0 + 120 * SEC });

    // Moving a session to another machine resets attached_at and leaves m1.
    await store.insertIfAbsent(insertInput({ id: "m2", agentId: "agent-2" }));
    await store.upsertAttachment({ ...base, sessionId: "sess-1", machineId: "m2", now: T0 + 130 * SEC });
    expect((await store.liveAttachments("m1", T0 + 130 * SEC)).map((a) => a.sessionId)).toEqual(["sess-2"]);
    expect(await store.liveAttachments("m2", T0 + 130 * SEC)).toMatchObject([
      { sessionId: "sess-1", machineId: "m2", attachedAt: T0 + 130 * SEC },
    ]);

    // deleteStaleAttachments: heartbeat_at <= now - staleMs goes away.
    // sess-2 heartbeat = T0+101s, sess-1 heartbeat = T0+130s.
    expect(await store.deleteStaleAttachments(T0 + 191 * SEC, 90 * SEC)).toBe(1); // sess-2 (exactly 90 s stale)
    expect(await store.liveAttachments("m1", T0 + 191 * SEC)).toEqual([]);
    expect((await store.liveAttachments("m2", T0 + 191 * SEC)).map((a) => a.sessionId)).toEqual(["sess-1"]);
    expect(await store.deleteStaleAttachments(T0 + 191 * SEC, 90 * SEC)).toBe(0);

    // detach removes the row; heartbeat/flags on unknown sessions are no-ops.
    await store.detach("sess-1");
    expect(await store.liveAttachments("m2", T0 + 191 * SEC)).toEqual([]);
    await store.heartbeat("sess-1", T0 + 200 * SEC);
    await store.setAttachmentFlags("sess-1", { viewers: 3 }, T0 + 200 * SEC);
    expect(await store.liveAttachments("m2", T0 + 200 * SEC)).toEqual([]);
  });

  // ─── countRunning ───────────────────────────────────────────────

  it("countRunning counts running-like states per tenant", async () => {
    expect(RUNNING_LIKE_STATES).toEqual(["creating", "bootstrapping", "starting", "running", "recreating"]);

    await store.insertIfAbsent(insertInput({ id: "a-run", agentId: "a1" }));
    await store.insertIfAbsent(insertInput({ id: "a-stop", agentId: "a2" }));
    await store.insertIfAbsent(insertInput({ id: "a-start", agentId: "a3" }));
    await store.insertIfAbsent(insertInput({ id: "a-err", agentId: "a4" }));
    await store.insertIfAbsent(insertInput({ id: "a-new", agentId: "a5" })); // stays `creating`
    await store.insertIfAbsent(insertInput({ id: "b-run", tenantId: "tenant-b", agentId: "a1" }));

    await store.transition("a-run", "creating", "running", undefined, T0);
    await store.transition("a-stop", "creating", "stopped", undefined, T0);
    await store.transition("a-start", "creating", "starting", undefined, T0);
    await store.transition("a-err", "creating", "error", undefined, T0);
    await store.transition("b-run", "creating", "running", undefined, T0);

    expect(await store.countRunning("tenant-a")).toBe(3); // running + starting + creating
    expect(await store.countRunning("tenant-b")).toBe(1);
    expect(await store.countRunning("tenant-zzz")).toBe(0);

    await store.transition("a-run", "running", "stopping", undefined, T0 + SEC);
    expect(await store.countRunning("tenant-a")).toBe(2);
  });

  // ─── events ─────────────────────────────────────────────────────

  it("events: add / list newest-first with limit / purge by age", async () => {
    await store.insertIfAbsent(insertInput({ id: "m1" }));
    await store.insertIfAbsent(insertInput({ id: "m2", agentId: "agent-2" }));

    await store.addEvent({ machineId: "m1", tenantId: "tenant-a", kind: "created", detail: { providerRef: "sb_1" }, now: T0 });
    await store.addEvent({ machineId: "m1", tenantId: "tenant-a", kind: "started", sessionId: "sess-1", now: T0 + SEC });
    await store.addEvent({ machineId: "m1", tenantId: "tenant-a", kind: "stopped", detail: null, now: T0 + 2 * SEC });
    await store.addEvent({ machineId: "m2", tenantId: "tenant-a", kind: "created", now: T0 + 3 * SEC });

    const all = await store.listEvents("m1");
    expect(all.map((e) => e.kind)).toEqual(["stopped", "started", "created"]);
    expect(all[2]).toMatchObject({
      machineId: "m1",
      tenantId: "tenant-a",
      kind: "created",
      detail: { providerRef: "sb_1" },
      sessionId: null,
      createdAt: T0,
    });
    expect(all[2].id).toMatch(/^amev-/);
    expect(all[1]).toMatchObject({ sessionId: "sess-1", detail: null });
    expect(all[0].detail).toBeNull();
    expect(new Set(all.map((e) => e.id)).size).toBe(3);

    expect((await store.listEvents("m1", 2)).map((e) => e.kind)).toEqual(["stopped", "started"]);
    expect(await store.listEvents("m1", 0)).toEqual([]);
    expect((await store.listEvents("m2")).map((e) => e.kind)).toEqual(["created"]);
    expect(await store.listEvents("amch-missing")).toEqual([]);

    // purge: strictly older than the cutoff, across all machines.
    expect(await store.purgeEvents(T0 + 2 * SEC)).toBe(2);
    expect((await store.listEvents("m1")).map((e) => e.kind)).toEqual(["stopped"]);
    expect((await store.listEvents("m2")).map((e) => e.kind)).toEqual(["created"]);
    expect(await store.purgeEvents(T0 + 2 * SEC)).toBe(0);
    expect(await store.purgeEvents(T0 + 10 * SEC)).toBe(2);
  });

  // ─── delete ─────────────────────────────────────────────────────

  it("delete removes the row and its attachments, frees the (tenant, agent) key, keeps events for retention", async () => {
    const { row } = await store.insertIfAbsent(insertInput({ id: "m1" }));
    await store.insertIfAbsent(insertInput({ id: "m-other", agentId: "agent-2" }));
    await store.upsertAttachment({
      sessionId: "sess-1", machineId: "m1", tenantId: "tenant-a", workerId: "w", generation: 1,
      turnActive: false, bgProcesses: 0, viewers: 0, now: T0,
    });
    await store.upsertAttachment({
      sessionId: "sess-o", machineId: "m-other", tenantId: "tenant-a", workerId: "w", generation: 1,
      turnActive: false, bgProcesses: 0, viewers: 0, now: T0,
    });
    await store.addEvent({ machineId: "m1", tenantId: "tenant-a", kind: "deleted", now: T0 });

    await store.delete(row.id);

    expect(await store.getById("m1")).toBeNull();
    expect(await store.get("tenant-a", "agent-1")).toBeNull();
    expect(await store.liveAttachments("m1", T0)).toEqual([]);
    // Sibling untouched.
    expect(await store.getById("m-other")).not.toBeNull();
    expect((await store.liveAttachments("m-other", T0)).map((a) => a.sessionId)).toEqual(["sess-o"]);
    // Audit trail survives until purge.
    expect((await store.listEvents("m1")).map((e) => e.kind)).toEqual(["deleted"]);

    // The unique key is free again: a fresh generation-1 row is created.
    const again = await store.insertIfAbsent(insertInput({ id: "m1-bis", now: T0 + SEC }));
    expect(again.created).toBe(true);
    expect(again.row).toMatchObject({ id: "m1-bis", generation: 1, state: "creating" });

    // Deleting an unknown id is a no-op.
    await store.delete("amch-missing");
  });
});

// ─── typed errors ─────────────────────────────────────────────────

describe("agent machine errors", () => {
  it("carry stable codes and pass the type guard", () => {
    const busy = new MachineBusyError();
    const quota = new MachineQuotaError("cap 10 reached", { limit: 10 });
    const locked = new MachineLockedError();
    expect(busy.code).toBe("machine_busy");
    expect(quota.code).toBe("machine_quota");
    expect(locked.code).toBe("machine_locked");
    expect(quota.message).toBe("cap 10 reached");
    expect(quota.detail).toEqual({ limit: 10 });
    expect(busy.name).toBe("MachineBusyError");
    expect(busy).toBeInstanceOf(Error);
    expect(isAgentMachineError(busy)).toBe(true);
    expect(isAgentMachineError(new Error("x"))).toBe(false);
  });
});

// ─── postgres (gated) ─────────────────────────────────────────────
//
// Skipped unless PG_TEST_URL is set (typical local: postgres://oma:oma@
// localhost:5432/oma_pg_test). Exercises the dialect-specific statements
// against a real server: BIGINT DDL, ON CONFLICT DO NOTHING + meta.changes,
// and the lease UPDATE with $n placeholders.

const PG_URL = process.env.PG_TEST_URL ?? "";
const pgEnabled = PG_URL.startsWith("postgres://") || PG_URL.startsWith("postgresql://");
const dpg = pgEnabled ? describe : describe.skip;

let pgSql: SqlClient;
let pgStore: NodeAgentMachineStore;
const PG_TENANT = `test-amch-${Date.now()}`;

beforeAll(async () => {
  if (!pgEnabled) return;
  pgSql = await createPostgresSqlClient(PG_URL);
  pgStore = new NodeAgentMachineStore({ sql: pgSql, dialect: "postgres" });
  await pgStore.ensureSchema();
});

afterAll(async () => {
  if (!pgEnabled || !pgSql) return;
  await pgSql.prepare(`DELETE FROM agent_machine_sessions WHERE tenant_id = ?`).bind(PG_TENANT).run();
  await pgSql.prepare(`DELETE FROM agent_machine_events WHERE tenant_id = ?`).bind(PG_TENANT).run();
  await pgSql.prepare(`DELETE FROM agent_machines WHERE tenant_id = ?`).bind(PG_TENANT).run();
});

dpg("NodeAgentMachineStore — postgres", () => {
  it("ensureSchema is idempotent", async () => {
    await pgStore.ensureSchema();
    await pgStore.ensureSchema();
  });

  it("insertIfAbsent: ON CONFLICT DO NOTHING reports created once and returns the winner", async () => {
    const first = await pgStore.insertIfAbsent(insertInput({ id: `amch-pg-${PG_TENANT}-1`, tenantId: PG_TENANT }));
    expect(first.created).toBe(true);
    expect(first.row).toMatchObject({ tenantId: PG_TENANT, agentId: "agent-1", state: "creating", generation: 1 });
    expect(first.row.config).toEqual(SPEC);
    expect(typeof first.row.createdAt).toBe("number");
    expect(first.row.createdAt).toBe(T0);

    const second = await pgStore.insertIfAbsent(
      insertInput({ id: `amch-pg-${PG_TENANT}-2`, tenantId: PG_TENANT, now: T0 + SEC }),
    );
    expect(second.created).toBe(false);
    expect(second.row.id).toBe(first.row.id);
  });

  it("tryAcquireLock / renewLock / releaseLock hold on postgres", async () => {
    const { row } = await pgStore.insertIfAbsent(
      insertInput({ id: `amch-pg-${PG_TENANT}-lock`, tenantId: PG_TENANT, agentId: "agent-lock" }),
    );
    const TTL = 120 * SEC;
    expect(await pgStore.tryAcquireLock(row.id, "A", TTL, T0)).toBe(true);
    expect(await pgStore.tryAcquireLock(row.id, "B", TTL, T0 + SEC)).toBe(false);
    expect(await pgStore.tryAcquireLock(row.id, "A", TTL, T0 + SEC)).toBe(true);
    expect(await pgStore.renewLock(row.id, "B", TTL, T0 + 2 * SEC)).toBe(false);
    expect(await pgStore.renewLock(row.id, "A", TTL, T0 + 2 * SEC)).toBe(true);
    expect((await pgStore.getById(row.id))!.lockExpiresAt).toBe(T0 + 2 * SEC + TTL);
    expect(await pgStore.tryAcquireLock(row.id, "B", TTL, T0 + 2 * SEC + TTL + 1)).toBe(true);
    await pgStore.releaseLock(row.id, "A"); // non-owner: no-op
    expect((await pgStore.getById(row.id))!.lockOwner).toBe("B");
    await pgStore.releaseLock(row.id, "B");
    expect((await pgStore.getById(row.id))).toMatchObject({ lockOwner: null, lockExpiresAt: null });
  });

  it("transition CAS, attachments upsert and events round-trip on postgres", async () => {
    const { row } = await pgStore.insertIfAbsent(
      insertInput({ id: `amch-pg-${PG_TENANT}-cas`, tenantId: PG_TENANT, agentId: "agent-cas" }),
    );
    expect(await pgStore.transition(row.id, "creating", "running", { providerRef: "sb_pg" }, T0 + SEC)).toBe(true);
    expect(await pgStore.transition(row.id, "creating", "error", undefined, T0 + SEC)).toBe(false);
    expect(await pgStore.getById(row.id)).toMatchObject({ state: "running", providerRef: "sb_pg" });
    expect(await pgStore.countRunning(PG_TENANT)).toBeGreaterThanOrEqual(1);

    const sid = `sess-${PG_TENANT}`;
    await pgStore.upsertAttachment({
      sessionId: sid, machineId: row.id, tenantId: PG_TENANT, workerId: "w", generation: 1,
      turnActive: true, bgProcesses: 0, viewers: 0, now: T0,
    });
    await pgStore.upsertAttachment({
      sessionId: sid, machineId: row.id, tenantId: PG_TENANT, workerId: "w2", generation: 1,
      turnActive: false, bgProcesses: 1, viewers: 0, now: T0 + SEC,
    });
    expect(await pgStore.liveAttachments(row.id, T0 + SEC)).toMatchObject([
      { sessionId: sid, workerId: "w2", turnActive: false, bgProcesses: 1, attachedAt: T0, heartbeatAt: T0 + SEC },
    ]);
    expect(await pgStore.deleteStaleAttachments(T0 + SEC + 90 * SEC, 90 * SEC)).toBe(1);

    await pgStore.addEvent({ machineId: row.id, tenantId: PG_TENANT, kind: "created", detail: { a: 1 }, now: T0 });
    await pgStore.addEvent({ machineId: row.id, tenantId: PG_TENANT, kind: "started", now: T0 + SEC });
    expect((await pgStore.listEvents(row.id)).map((e) => e.kind)).toEqual(["started", "created"]);
    expect(await pgStore.purgeEvents(T0 + SEC)).toBeGreaterThanOrEqual(1);
  });
});
