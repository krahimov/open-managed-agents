// Provider quota refusals become a message a session's user can act on, and
// the account inventory used by the orphan sweeper deletes only the box it
// was asked about.

import { afterEach, describe, expect, it, vi } from "vitest";
import { DaytonaSandbox } from "../src/adapters/daytona";
import { buildDaytonaCreateParams } from "../src/adapters/daytona-box-provider";
import { DaytonaBoxInventory } from "../src/adapters/daytona-inventory";
import { SandboxCapacityError, isDaytonaBoxGone, mapDaytonaProvisionError } from "../src/adapters/daytona-types";
import { AgentMachineManager } from "../src/machines/manager";
import { InMemoryAgentMachineStore } from "../src/machines/ports";
import { DaytonaNotFoundError, FakeDaytona, FakeDaytonaHttpError, fakeDaytonaModule } from "./fake-daytona";

// The text Daytona returned on prod, 2026-11-10.
const DISK_QUOTA =
  "Total disk limit exceeded. Maximum allowed: 30GiB. To increase concurrency limits, upgrade your organization's Tier by visiting https://app.daytona.io/dashboard/limits.";

const managers: AgentMachineManager[] = [];
afterEach(async () => { await Promise.all(managers.splice(0).map((m) => m.dispose())); });

describe("mapDaytonaProvisionError", () => {
  it("turns the disk quota refusal into a storage capacity error without provider details", () => {
    const raw = new FakeDaytonaHttpError(DISK_QUOTA, 403);
    const mapped = mapDaytonaProvisionError(raw) as SandboxCapacityError;
    expect(mapped).toBeInstanceOf(SandboxCapacityError);
    expect(mapped).toMatchObject({ code: "sandbox_capacity", resource: "storage", cause: raw });
    expect(mapped.message).toContain("sandbox storage is full");
    expect(mapped.message).toContain("workspace owner");
    expect(mapped.message).not.toMatch(/daytona|30GiB|https?:/i);
  });

  it("classifies cpu / memory and generic quota refusals", () => {
    expect(mapDaytonaProvisionError(new Error("Total CPU quota exceeded. Maximum allowed: 10"))).toMatchObject({ resource: "compute" });
    expect(mapDaytonaProvisionError(new Error("Total memory limit exceeded. Maximum allowed: 20GiB"))).toMatchObject({ resource: "compute" });
    expect(mapDaytonaProvisionError(new Error("Sandbox quota exceeded for organization"))).toMatchObject({ resource: "capacity" });
  });

  it("leaves every other error alone", () => {
    for (const message of [
      "rate limit exceeded, retry later",
      "upstream unavailable",
      "Sandbox with ID sb-1 not found",
      "image pull failed: no space left on device",
    ]) {
      const err = new Error(message);
      expect(mapDaytonaProvisionError(err)).toBe(err);
    }
    expect(mapDaytonaProvisionError("plain string")).toBe("plain string");
  });
});

describe("quota refusal while provisioning", () => {
  it("session sandbox: the tool result carries the readable message, the log keeps the raw one", async () => {
    const fake = new FakeDaytona();
    fake.failNextCreate(new FakeDaytonaHttpError(DISK_QUOTA, 403));
    fake.failNextCreate(new FakeDaytonaHttpError(DISK_QUOTA, 403));
    const warn = vi.fn();
    const sandbox = new DaytonaSandbox({
      sessionId: "sess-1", apiKey: "k", daytonaModule: fakeDaytonaModule(fake),
      bootstrapTools: false, logger: { log() {}, warn },
    });

    const out = await sandbox.exec("echo hi");

    expect(out).toContain("[error: Sandbox unavailable: this workspace's sandbox storage is full");
    expect(out).not.toMatch(/daytona\.io|30GiB/);
    expect(warn.mock.calls.some(([msg]) => String(msg).includes("Total disk limit exceeded"))).toBe(true);
    await expect(sandbox.readFile("/workspace/a.txt")).rejects.toBeInstanceOf(SandboxCapacityError);
    // Not cached: the next call provisions once space is available.
    expect(await sandbox.exec("echo hi")).toBe("hi");
  });

  it("agent computer: acquire rejects with the readable message and records the raw one on the row", async () => {
    const fake = new FakeDaytona();
    const store = new InMemoryAgentMachineStore();
    const warn = vi.fn();
    const manager = new AgentMachineManager({
      store, daytonaModule: fakeDaytonaModule(fake), apiKey: "k", tickIntervalMs: 0,
      bootstrap: async () => {}, logger: { warn },
    });
    managers.push(manager);
    fake.failNextCreate(new FakeDaytonaHttpError(DISK_QUOTA, 403));
    const spec = {
      image: "node:22-bookworm", workdir: "/workspace", aptPackages: [], bootstrapTools: false,
      browser: false, idleStopMinutes: 30, sdkMode: "off" as const,
    };

    await expect(manager.acquire({ tenantId: "tenant-a", agentId: "agent-a", spec })).rejects.toMatchObject({
      code: "sandbox_capacity", resource: "storage",
    });

    const row = (await manager.get("tenant-a", "agent-a"))!;
    expect(row.state).toBe("error");
    expect(row.errorReason).toContain("Total disk limit exceeded");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("provider quota"), expect.any(Error));
  });
});

describe("session box labels", () => {
  it("adds tenant and deployment labels only when they are known", () => {
    expect(buildDaytonaCreateParams({ sessionId: "sess-1" }).labels).toEqual({ "oma-session-id": "sess-1" });
    expect(buildDaytonaCreateParams({ sessionId: "sess-1", tenantId: "tenant-a", deploymentId: "dep_here" }).labels).toEqual({
      "oma-session-id": "sess-1", "oma-tenant-id": "tenant-a", "oma-deployment-id": "dep_here",
    });
  });

  it("stamps them on the box a session creates", async () => {
    const fake = new FakeDaytona();
    const sandbox = new DaytonaSandbox({
      sessionId: "sess-1", tenantId: "tenant-a", deploymentId: "dep_here", apiKey: "k",
      daytonaModule: fakeDaytonaModule(fake), bootstrapTools: false, logger: { log() {}, warn() {} },
    });
    await sandbox.exec("true");
    expect(fake.createCalls[0]).toMatchObject({
      labels: { "oma-session-id": "sess-1", "oma-tenant-id": "tenant-a", "oma-deployment-id": "dep_here" },
    });
  });
});

describe("DaytonaBoxInventory", () => {
  function setup() {
    const fake = new FakeDaytona();
    fake.now = () => 1_700_000_000_000;
    const inventory = new DaytonaBoxInventory({ apiKey: "k", daytonaModule: fakeDaytonaModule(fake) });
    return { fake, inventory };
  }

  it("lists every box with its labels, state and creation time", async () => {
    const { fake, inventory } = setup();
    const ours = await fake.create({ labels: { "oma-session-id": "sess-1" } });
    const foreign = await fake.create({ labels: { team: "data" } });
    expect(await inventory.list()).toEqual([
      { id: ours.id, state: "started", labels: { "oma-session-id": "sess-1" }, createdAtMs: 1_700_000_000_000 },
      { id: foreign.id, state: "started", labels: { team: "data" }, createdAtMs: 1_700_000_000_000 },
    ]);
  });

  it("deletes a box whose labels still match", async () => {
    const { fake, inventory } = setup();
    const sb = await fake.create({ labels: { "oma-session-id": "sess-1" } });
    expect(await inventory.delete(sb.id, { "oma-session-id": "sess-1", "oma-deployment-id": null })).toBe("deleted");
    expect(fake.deleteCalls).toEqual([sb.id]);
  });

  it("reports a box that is already gone instead of failing", async () => {
    const { fake, inventory } = setup();
    const sb = await fake.create({ labels: { "oma-session-id": "sess-1" } });
    fake.vanish(sb.id);
    expect(await inventory.delete(sb.id, { "oma-session-id": "sess-1" })).toBe("gone");
    expect(fake.deleteCalls).toEqual([]);
  });

  it("refuses a box that was relabelled or claimed by another deployment since it was listed", async () => {
    const { fake, inventory } = setup();
    const sb = await fake.create({ labels: { "oma-session-id": "sess-1" } });
    await expect(inventory.delete(sb.id, { "oma-session-id": "sess-other" })).rejects.toThrow("label oma-session-id changed");
    await sb.setLabels({ "oma-session-id": "sess-1", "oma-deployment-id": "dep_elsewhere" });
    await expect(inventory.delete(sb.id, { "oma-session-id": "sess-1", "oma-deployment-id": null })).rejects.toThrow("label oma-deployment-id changed");
    expect(fake.deleteCalls).toEqual([]);
  });

  it("propagates a provider failure", async () => {
    const { fake, inventory } = setup();
    const sb = await fake.create({ labels: { "oma-session-id": "sess-1" } });
    fake.delete = async () => { throw new FakeDaytonaHttpError("upstream unavailable", 503); };
    await expect(inventory.delete(sb.id, { "oma-session-id": "sess-1" })).rejects.toThrow("upstream unavailable");
  });
});

describe("isDaytonaBoxGone", () => {
  it("accepts sandbox not-found shapes and a bare 404, nothing else", () => {
    expect(isDaytonaBoxGone(new Error("not found: sandbox 1234abcd-0000 not found (it has been deleted)"))).toBe(true);
    expect(isDaytonaBoxGone(new DaytonaNotFoundError("Sandbox with ID sb-1 not found"))).toBe(true);
    expect(isDaytonaBoxGone(new FakeDaytonaHttpError("gone", 404))).toBe(true);
    expect(isDaytonaBoxGone(new FakeDaytonaHttpError("upstream unavailable", 503))).toBe(false);
    expect(isDaytonaBoxGone(new Error("socket hang up"))).toBe(false);
  });
});
