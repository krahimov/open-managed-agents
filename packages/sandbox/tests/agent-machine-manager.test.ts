import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentMachineManager } from "../src/machines/manager";
import { InMemoryAgentMachineStore, MachineBusyError } from "../src/machines/ports";
import type { AgentMachineSpec } from "../src/machines/ports";
import { DaytonaSandbox, sandboxFactory } from "../src/adapters/daytona";
import { FakeDaytona, fakeDaytonaModule } from "./fake-daytona";

const spec: AgentMachineSpec = {
  image: "node:22-bookworm", workdir: "/workspace", aptPackages: [],
  bootstrapTools: false, browser: false, idleStopMinutes: 30, sdkMode: "tools_only",
};
const managers: AgentMachineManager[] = [];
afterEach(async () => { await Promise.all(managers.splice(0).map((m) => m.dispose())); });

function fixture(now?: () => number) {
  const store = new InMemoryAgentMachineStore();
  const fake = new FakeDaytona();
  if (now) fake.now = now;
  const bootstrap = vi.fn(async () => {});
  const makeManager = () => {
    const manager = new AgentMachineManager({ store, daytonaModule: fakeDaytonaModule(fake), apiKey: "test", tickIntervalMs: 0, bootstrap, now });
    managers.push(manager);
    return manager;
  };
  const manager = makeManager();
  const provider = (sessionId: string, from = manager) => from.provider({ tenantId: "tenant-a", agentId: "agent-a", sessionId, spec });
  const adapter = (sessionId: string, from = manager) => new DaytonaSandbox({ sessionId, box: provider(sessionId, from), daytonaModule: fakeDaytonaModule(fake), logger: { log() {}, warn() {} } });
  return { store, fake, manager, makeManager, provider, adapter, bootstrap };
}

describe("persistent agent machines", () => {
  it("shares the computer across sessions while keeping output directories separate", async () => {
    const { fake, adapter } = fixture();
    const a = adapter("sess-a");
    const b = adapter("sess-b");
    await a.mountSessionOutputs({ tenantId: "tenant-a", sessionId: "sess-a" });
    await a.writeFile(`${a.sessionOutputsPath()}/report.txt`, "session A");
    await a.writeFile("/workspace/shared.txt", "shared workspace");
    await b.mountSessionOutputs({ tenantId: "tenant-a", sessionId: "sess-b" });
    await b.writeFile(`${b.sessionOutputsPath()}/report.txt`, "session B");
    expect(await b.readFile("/workspace/shared.txt")).toBe("shared workspace");
    expect(await a.readFile(`${a.sessionOutputsPath()}/report.txt`)).toBe("session A");
    expect(a.sessionOutputsPath()).not.toBe(b.sessionOutputsPath());
    expect(fake.createCalls).toHaveLength(1);
    expect(fake.createCalls[0]).toMatchObject({ ephemeral: false, public: false, autoDeleteInterval: -1 });
    await a.destroy();
    expect(fake.deleteCalls).toEqual([]);
    expect(await b.readFile(`${b.sessionOutputsPath()}/report.txt`)).toBe("session B");
  });

  it("reuses the retained provider identity and output files after a host restart", async () => {
    const { manager, makeManager, adapter, fake, bootstrap } = fixture();
    const before = adapter("sess-a");
    await before.mountSessionOutputs({ tenantId: "tenant-a", sessionId: "sess-a" });
    await before.writeFile(`${before.sessionOutputsPath()}/keep.txt`, "retained");
    const row = await manager.get("tenant-a", "agent-a");
    await manager.dispose();
    const restarted = makeManager();
    const after = adapter("sess-a", restarted);
    await after.mountSessionOutputs({ tenantId: "tenant-a", sessionId: "sess-a" });
    expect(await after.readFile(`${after.sessionOutputsPath()}/keep.txt`)).toBe("retained");
    expect((await restarted.get("tenant-a", "agent-a"))?.providerRef).toBe(row?.providerRef);
    expect(fake.createCalls).toHaveLength(1);
    expect(bootstrap).toHaveBeenCalledTimes(1);
  });

  it("deduplicates concurrent creates across managers sharing a store", async () => {
    const { provider, makeManager, fake } = fixture();
    const boxes = await Promise.all([provider("sess-a").acquire(), provider("sess-b", makeManager()).acquire()]);
    expect(boxes[0].sb.id).toBe(boxes[1].sb.id);
    expect(fake.createCalls).toHaveLength(1);
  });

  it("refuses stopping active turns, keeps them alive, then stops without losing files", async () => {
    const { provider, manager, fake } = fixture();
    const p = provider("sess-a");
    const { sb } = await p.acquire();
    await sb.fs.uploadFile(Buffer.from("persist"), "/workspace/keep.txt");
    await p.setTurnActive(true);
    await expect(manager.stop("tenant-a", "agent-a")).rejects.toBeInstanceOf(MachineBusyError);
    const refreshes = fake.sandboxes.get(sb.id)!.activityRefreshes;
    await manager.tick();
    expect(fake.sandboxes.get(sb.id)!.activityRefreshes).toBeGreaterThan(refreshes);
    await p.setTurnActive(false);
    expect((await manager.stop("tenant-a", "agent-a"))?.state).toBe("stopped");
    const resumed = await p.acquire();
    expect(resumed.sb.id).toBe(sb.id);
    expect((await resumed.sb.fs.downloadFile("/workspace/keep.txt")).toString()).toBe("persist");
    expect(fake.createCalls).toHaveLength(1);
  });

  it("restarts an automatically stopped box transparently on the next file operation", async () => {
    const { adapter, fake } = fixture();
    const a = adapter("sess-a");
    await a.writeFile("/workspace/keep.txt", "persist");
    const sb = [...fake.sandboxes.values()][0];
    await sb.stop();
    expect(await a.readFile("/workspace/keep.txt")).toBe("persist");
    expect(sb.state).toBe("started");
    expect(fake.createCalls).toHaveLength(1);
  });

  it("stops truly idle machines even when SDK monitoring refreshes Daytona activity", async () => {
    let now = 1_000_000;
    const { provider, manager, fake } = fixture(() => now);
    const snapshot = vi.fn(async () => {});
    manager.options.snapshot = snapshot;
    const box = await provider("sess-a").acquire();
    const sb = fake.sandboxes.get(box.sb.id)!;
    const initial = (await manager.get("tenant-a", "agent-a"))!;
    const listSessions = sb.process.listSessions.bind(sb.process);
    vi.spyOn(sb.process, "listSessions").mockImplementation(async () => {
      // Match real Daytona: inventory SDK calls themselves refresh the
      // provider clock, even though no user or agent work occurred.
      sb.lastActivityAt = now;
      return listSessions();
    });
    now += 15 * 60_000;
    await manager.tick();
    expect(sb.state).toBe("started");
    expect(sb.lastActivityAt).toBe(now);
    expect((await manager.get("tenant-a", "agent-a"))?.lastActiveAt).toBe(initial.lastActiveAt);
    now += 15 * 60_000;
    await manager.tick();
    expect(sb.state).toBe("stopped");
    expect(snapshot).toHaveBeenCalledTimes(1);
    const stopped = (await manager.get("tenant-a", "agent-a"))!;
    expect(stopped.state).toBe("stopped");
    expect(stopped.desiredState).toBe("stopped");
    expect(stopped.lastActiveAt).toBe(initial.lastActiveAt);
    expect(fake.deleteCalls).toEqual([]);
  });

  it("keeps active turns awake beyond the original idle deadline and starts a new idle window", async () => {
    let now = 1_000_000;
    const { provider, manager, fake } = fixture(() => now);
    const p = provider("sess-a");
    const box = await p.acquire();
    const sb = fake.sandboxes.get(box.sb.id)!;
    await p.setTurnActive(true);
    now += 31 * 60_000;
    await manager.tick();
    expect(sb.state).toBe("started");
    expect((await manager.get("tenant-a", "agent-a"))?.lastActiveAt).toBe(now);
    await p.setTurnActive(false);
    now += 29 * 60_000;
    await manager.tick();
    expect(sb.state).toBe("started");
    now += 60_000;
    await manager.tick();
    expect(sb.state).toBe("stopped");
  });

  it("attaches a turn before its first tool and never creates a box merely to clear activity", async () => {
    const { provider, manager, store, fake } = fixture();
    const p = provider("sess-a");
    await p.setTurnActive(false);
    expect(fake.createCalls).toHaveLength(0);
    await p.setTurnActive(true);
    expect(fake.createCalls).toHaveLength(1);
    const row = (await manager.get("tenant-a", "agent-a"))!;
    expect((await store.liveAttachments(row.id, Date.now()))[0].turnActive).toBe(true);
    await expect(manager.stop("tenant-a", "agent-a")).rejects.toBeInstanceOf(MachineBusyError);
  });

  it("keeps orphan remote processes running beyond the idle deadline", async () => {
    let now = 1_000_000;
    const { provider, manager, fake } = fixture(() => now);
    const p = provider("sess-a");
    const box = await p.acquire();
    await box.sb.process.createSession("oma-proc-orphan");
    await box.sb.process.executeSessionCommand("oma-proc-orphan", { command: "long-task", runAsync: true });
    await p.release();
    now += 31 * 60_000;
    await manager.tick();
    expect(fake.sandboxes.get(box.sb.id)?.state).toBe("started");
    expect((await manager.get("tenant-a", "agent-a"))?.lastActiveAt).toBe(now);
  });

  it("replaces a disappeared box once and reports its new generation to all sessions", async () => {
    const { manager, fake, adapter } = fixture();
    const restore = vi.fn(async () => {});
    manager.options.restore = restore;
    const a = adapter("sess-a");
    const b = adapter("sess-b");
    await a.exec("echo before");
    await b.exec("echo before");
    const old = await manager.get("tenant-a", "agent-a");
    fake.vanish(old!.providerRef!);
    const results = await Promise.all([a.exec("echo recovered-a"), b.exec("echo recovered-b")]);
    expect(results).toEqual(["recovered-a", "recovered-b"]);
    const next = await manager.get("tenant-a", "agent-a");
    expect(next?.generation).toBe(2);
    expect(next?.providerRef).not.toBe(old?.providerRef);
    expect(fake.createCalls).toHaveLength(2);
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it("retains a partially bootstrapped box and retries on that same disk", async () => {
    const { provider, bootstrap, fake } = fixture();
    bootstrap.mockRejectedValueOnce(new Error("temporary package failure"));
    const p = provider("sess-a");
    await expect(p.acquire()).rejects.toThrow("temporary package failure");
    await p.acquire();
    expect(fake.createCalls).toHaveLength(1);
    expect(bootstrap).toHaveBeenCalledTimes(2);
    expect(fake.deleteCalls).toEqual([]);
  });

  it("retries a failed workspace restore on the retained replacement", async () => {
    const { manager, provider, fake, bootstrap } = fixture();
    const restore = vi.fn(async () => {}).mockRejectedValueOnce(new Error("backup unavailable"));
    manager.options.restore = restore;
    const p = provider("sess-a");
    const old = await p.acquire();
    fake.vanish(old.sb.id);
    await expect(p.acquire()).rejects.toThrow("backup unavailable");
    const failed = await manager.get("tenant-a", "agent-a");
    expect(failed?.bootstrapHash).toBeNull();
    expect(bootstrap).toHaveBeenCalledTimes(1);
    await p.acquire();
    expect(restore).toHaveBeenCalledTimes(2);
    expect(fake.createCalls).toHaveLength(2);
    expect((await manager.get("tenant-a", "agent-a"))?.bootstrapHash).not.toBeNull();
    expect(bootstrap).toHaveBeenCalledTimes(2);
  });

  it("does not let a stale heartbeat overwrite an explicit stop", async () => {
    const { manager, store, provider } = fixture();
    await provider("sess-a").acquire();
    let resume!: () => void;
    let listed!: () => void;
    const paused = new Promise<void>((resolve) => { resume = resolve; });
    const ready = new Promise<void>((resolve) => { listed = resolve; });
    const original = store.listByState.bind(store);
    vi.spyOn(store, "listByState").mockImplementationOnce(async (states) => {
      const rows = await original(states);
      listed();
      await paused;
      return rows;
    });
    const tick = manager.tick();
    await ready;
    await manager.stop("tenant-a", "agent-a");
    resume();
    await tick;
    expect((await manager.get("tenant-a", "agent-a"))?.state).toBe("stopped");
    expect(await manager.getBox("tenant-a", "agent-a")).toBeNull();
  });

  it("clears finished background activity without a client polling the handle", async () => {
    const { adapter, manager, fake, store } = fixture();
    fake.onSessionCommand = ({ sandbox, command }) => {
      const match = command.command.match(/'(\/var\/lib\/oma\/procs\/[^']+\.pid)'$/);
      if (match) sandbox.files.set(match[1], Buffer.from("12345"));
    };
    const a = adapter("sess-a");
    const process = await a.startProcess("long-running-command");
    expect(process).not.toBeNull();
    const sb = [...fake.sandboxes.values()][0];
    const session = [...sb.sessions.values()][0];
    fake.completeCommand(session.sessionId, session.commands[0].id, 0, "done");
    const refreshes = sb.activityRefreshes;
    await manager.tick();
    expect(sb.activityRefreshes).toBe(refreshes);
    const row = (await manager.get("tenant-a", "agent-a"))!;
    expect((await store.liveAttachments(row.id, Date.now()))[0].bgProcesses).toBe(0);
    expect((await manager.stop("tenant-a", "agent-a"))?.state).toBe("stopped");
    expect(await process!.getLogs()).toEqual({ stdout: "done", stderr: "" });
  });

  it("does not kill remote work when a session adapter is detached", async () => {
    const { adapter, fake, manager } = fixture();
    fake.onSessionCommand = ({ sandbox, command }) => {
      const match = command.command.match(/'(\/var\/lib\/oma\/procs\/[^']+\.pid)'$/);
      if (match) sandbox.files.set(match[1], Buffer.from("12345"));
    };
    const a = adapter("sess-a");
    const process = await a.startProcess("long-running-command");
    expect(process).not.toBeNull();
    await a.destroy();
    expect(fake.deleteCalls).toEqual([]);
    const sb = [...fake.sandboxes.values()][0];
    expect(sb.kills).toEqual([]);
    await expect(manager.stop("tenant-a", "agent-a")).rejects.toBeInstanceOf(MachineBusyError);
    const refreshes = sb.activityRefreshes;
    await manager.tick();
    expect(sb.activityRefreshes).toBeGreaterThan(refreshes);
  });

  it("does not mix tenants that use the same agent identifier", async () => {
    const { manager, provider, fake } = fixture();
    const a = await provider("sess-a").acquire();
    const b = await manager.provider({ tenantId: "tenant-b", agentId: "agent-a", sessionId: "sess-b", spec }).acquire();
    expect(a.sb.id).not.toBe(b.sb.id);
    expect(fake.createCalls).toHaveLength(2);
  });

  it("rejects incompatible environment changes without changing the existing computer", async () => {
    const { manager, provider, fake } = fixture();
    const before = await provider("sess-a").acquire();
    const incompatible = manager.provider({ tenantId: "tenant-a", agentId: "agent-a", sessionId: "sess-b", spec: { ...spec, browser: true } });
    await expect(incompatible.acquire()).rejects.toMatchObject({ code: "machine_config_mismatch" });
    const row = await manager.get("tenant-a", "agent-a");
    expect(row?.providerRef).toBe(before.sb.id);
    expect(row?.config.browser).toBe(false);
    expect(fake.createCalls).toHaveLength(1);
  });

  it("fails closed when agent scope was requested without its manager binding", async () => {
    await expect(sandboxFactory({ sessionId: "sess-a", workdir: "/tmp" }, { SANDBOX_SCOPE: "agent" })).rejects.toThrow("requires an agent machine manager");
  });
});
