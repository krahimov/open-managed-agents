import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { generateAgentMachineId } from "@open-managed-agents/shared";
import type { AcquiredBox, SandboxBoxProvider } from "../adapters/daytona-box-provider";
import type { DaytonaClient, DaytonaModule, DaytonaSandboxInstance } from "../adapters/daytona-types";
import { isDaytonaNotFound, loadDaytonaModule } from "../adapters/daytona-types";
import { buildDaytonaBootstrapScript } from "../adapters/daytona";
import type { SandboxBrowserEndpoint } from "../ports";
import { DEFAULT_ATTACHMENT_STALE_MS, MachineBusyError, MachineLockedError, MachineConfigMismatchError } from "./ports";
import type { AgentMachineRow, AgentMachineSpec, AgentMachineStore } from "./ports";

/** Provider transport. Existing session/file code uses the structural box port
 * originally introduced for Daytona; drivers need no Daytona SDK dependency. */
export interface MachineDriver {
  client(): Promise<DaytonaClient>;
  isNotFound(error: unknown): boolean;
  checkpoint?(sb: DaytonaSandboxInstance): Promise<string>;
  deleteCheckpoint?(id: string): Promise<void>;
  dispose?(): void;
}

export interface AgentMachineManagerOptions {
  drivers?: Partial<Record<"modal", MachineDriver>>;
  store: AgentMachineStore;
  apiKey?: string;
  apiUrl?: string;
  daytonaModule?: DaytonaModule;
  workerId?: string;
  bootstrap?: (sb: DaytonaSandboxInstance, spec: AgentMachineSpec) => Promise<void>;
  browserEndpoint?: (sb: DaytonaSandboxInstance, generation: number) => Promise<SandboxBrowserEndpoint | null>;
  snapshot?: (row: AgentMachineRow, sb: DaytonaSandboxInstance) => Promise<void>;
  restore?: (row: AgentMachineRow, sb: DaytonaSandboxInstance) => Promise<void>;
  now?: () => number;
  /** Set to zero when a host owns the periodic scheduler, or in tests. */
  tickIntervalMs?: number;
  logger?: { warn(message: string, detail?: unknown): void };
}

export interface AgentMachineProviderInput {
  tenantId: string;
  agentId: string;
  sessionId: string;
  spec: AgentMachineSpec;
}

const LOCK_TTL_MS = 60_000;
const LOCK_WAIT_MS = 120_000;

/** One durable machine per tenant + agent. No lifecycle operation deletes
 * a box: stopping preserves its disk, and detaching a session preserves
 * both the box and the other sessions using it. */
export class AgentMachineManager {
  readonly workerId: string;
  private clientPromise: Promise<DaytonaClient> | null = null;
  private readonly providers = new Set<AgentBoxProvider>();
  private readonly heldLocks = new AsyncLocalStorage<ReadonlySet<string>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking: Promise<void> | null = null;
  private disposed = false;
  private readonly now: () => number;

  constructor(readonly options: AgentMachineManagerOptions) {
    this.workerId = options.workerId ?? `machine-worker-${randomUUID()}`;
    this.now = options.now ?? Date.now;
    const interval = options.tickIntervalMs ?? 30_000;
    if (interval > 0) {
      this.timer = setInterval(() => {
        void this.tick().catch((err) => this.warn("agent machine heartbeat failed", err));
      }, interval);
      this.timer.unref();
    }
  }

  provider(input: AgentMachineProviderInput): AgentBoxProvider {
    if (this.disposed) throw new Error("agent machine manager is disposed");
    for (const value of [input.tenantId, input.agentId, input.sessionId]) {
      if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid agent machine identity");
    }
    const provider = new AgentBoxProvider(this, input);
    this.providers.add(provider);
    return provider;
  }

  get(tenantId: string, agentId: string): Promise<AgentMachineRow | null> {
    return this.options.store.get(tenantId, agentId);
  }

  async start(tenantId: string, agentId: string, spec: AgentMachineSpec): Promise<AgentMachineRow> {
    await this.acquire({ tenantId, agentId, spec });
    return (await this.get(tenantId, agentId))!;
  }

  /** Inspect the running provider box without starting or creating it. */
  async getBox(tenantId: string, agentId: string): Promise<AcquiredBox | null> {
    const row = await this.get(tenantId, agentId);
    if (!row?.providerRef) return null;
    try {
      const sb = await (await this.client(row.provider)).get(row.providerRef);
      if (sb.state !== "started") return null;
      return { sb, generation: row.generation, freshlyCreated: false };
    } catch (err) {
      if (this.isNotFound(err, row.provider)) return null;
      throw err;
    }
  }

  async stop(tenantId: string, agentId: string): Promise<AgentMachineRow | null> {
    const initial = await this.get(tenantId, agentId);
    if (!initial) return null;
    return this.withLock(initial.id, async () => {
      const row = (await this.options.store.getById(initial.id))!;
      await this.pollAttachedProcesses(row);
      const live = await this.options.store.liveAttachments(row.id, this.now());
      // Background work is checked against Daytona below; stale host
      // counters must not prevent an already completed machine from stopping.
      const busy = live.filter((a) => a.turnActive || a.viewers > 0);
      if (busy.length) throw new MachineBusyError("agent machine has active work or viewers", { sessions: busy.map((a) => a.sessionId) });
      await this.options.store.update(row.id, { state: "stopping", desiredState: "stopped" }, this.now());
      try {
        const box = row.providerRef
          ? await this.getProviderBox(row.providerRef, row.generation, row.provider)
          : null;
        if (box && box.sb.state !== "stopped" && box.sb.state !== "archived") {
          // Catch orphan processes left by a crashed host. An expired
          // attachment alone does not prove that its Linux work finished.
          if (await this.hasRunningProcesses(box.sb)) throw new MachineBusyError("agent machine has running background processes");
          await this.options.snapshot?.(row, box.sb);
          const driver = this.driver(row.provider);
          if (driver?.checkpoint) {
            const checkpoint = await driver.checkpoint(box.sb);
            // Commit the restore image BEFORE terminating the only live disk.
            await this.options.store.update(row.id, { snapshot: checkpoint, lastBackupAt: this.now() }, this.now());
            await box.sb.stop(120);
            if (row.snapshot && row.snapshot !== row.config.snapshot && row.snapshot !== checkpoint) {
              await driver.deleteCheckpoint?.(row.snapshot).catch(err => this.warn("old computer checkpoint cleanup failed", err));
            }
          } else {
            await box.sb.stop(120);
          }
        }
        await this.options.store.update(row.id, { state: "stopped", lastStoppedAt: this.now(), errorReason: null }, this.now());
        await this.event(row, "stopped");
      } catch (err) {
        await this.options.store.update(row.id, {
          state: err instanceof MachineBusyError ? row.state : "error",
          desiredState: err instanceof MachineBusyError ? row.desiredState : "stopped",
          errorReason: err instanceof MachineBusyError ? row.errorReason : String(err),
        }, this.now());
        throw err;
      }
      return (await this.options.store.getById(row.id))!;
    });
  }

  async acquire(input: Pick<AgentMachineProviderInput, "tenantId" | "agentId" | "spec">): Promise<AcquiredBox> {
    const { row } = await this.options.store.insertIfAbsent({
      id: generateAgentMachineId(), tenantId: input.tenantId, agentId: input.agentId,
      provider: input.spec.provider ?? "daytona", spec: input.spec,
      bootstrapHash: createHash("sha256").update(JSON.stringify(input.spec)).digest("hex"), now: this.now(),
    });
    if (row.provider !== (input.spec.provider ?? "daytona")) throw new MachineConfigMismatchError();
    if (canonicalSpec(row.config) !== canonicalSpec(input.spec)) throw new MachineConfigMismatchError();
    return this.withLock(row.id, async () => {
      const current = (await this.options.store.getById(row.id))!;
      const client = await this.client(current.provider);
      let sb: DaytonaSandboxInstance | null = null;
      let created = false;
      try {
        if (current.providerRef) {
          try { sb = await client.get(current.providerRef); }
          catch (err) { if (!this.isNotFound(err, current.provider)) throw err; }
        }
        if (current.provider === "modal" && sb?.state !== "started") sb = null;
        if (!sb) {
          // Recover the create→DB-write crash window by the immutable
          // machine label before creating another chargeable box.
          const found = await client.list({ "oma-machine-id": current.id });
          sb = found.items.find((s) => s.labels?.["oma-tenant-id"] === current.tenantId && (current.provider !== "modal" || s.state === "started")) ?? null;
        }
        // Modal terminates rather than suspending a VM. A stopped VM must be
        // replaced from its committed filesystem checkpoint.
        const previousRef = current.providerRef;
        if (current.provider === "modal" && previousRef && !sb && !current.snapshot) {
          throw new Error("Modal computer expired without a checkpoint; refusing to replace its disk with an empty computer");
        }
        if (!sb) {
          await this.options.store.update(current.id, { state: previousRef ? "recreating" : "creating", desiredState: "running" }, this.now());
          sb = await client.create({
            ...(current.snapshot ? { snapshot: current.snapshot } : { image: current.image }),
            name: current.id,
            ...(current.config.desktop ? { user: "root", envVars: { VNC_RESOLUTION: "1280x800" } } : {}),
            labels: { "oma-machine-id": current.id, "oma-tenant-id": current.tenantId, "oma-agent-id": current.agentId },
            public: false, ephemeral: false,
            autoDeleteInterval: -1, autoArchiveInterval: 0,
            autoStopInterval: current.idleStopMinutes,
          }, { timeout: 180 });
          created = true;
        }
        const replacement = !!previousRef && previousRef !== sb.id;
        const generation = replacement ? current.generation + 1 : current.generation;
        // A null hash on an existing row records a replacement whose
        // workspace restore has not completed. Keep it null on failure so
        // the next acquisition retries restore on this SAME new disk.
        const needsRestore = replacement || current.bootstrapHash === null;
        const needsBootstrap = created || previousRef !== sb.id || current.state !== "running" || sb.state !== "started";
        // Persist the provider identity before bootstrap: retrying a failed
        // bootstrap must use the same retained disk, not leak another box.
        await this.options.store.update(current.id, {
          providerRef: sb.id, generation, desiredState: "running", state: "starting",
          bootstrapHash: needsRestore ? null : current.bootstrapHash,
        }, this.now());
        if (sb.state === "error" && sb.recoverable) await sb.recover(120);
        if (sb.state !== "started") await sb.start(120);
        await sb.setAutostopInterval(current.idleStopMinutes);
        // Restore before browser startup: Chromium must not open its
        // profile while the previous profile is being unpacked into it.
        if (needsRestore) {
          if (current.provider !== "modal" || !current.snapshot) await this.options.restore?.({ ...current, providerRef: sb.id, generation }, sb);
          await this.options.store.update(current.id, {
            bootstrapHash: createHash("sha256").update(JSON.stringify(current.config)).digest("hex"),
          }, this.now());
        }
        if (needsBootstrap) {
          await this.options.store.update(current.id, { state: "bootstrapping" }, this.now());
          await this.bootstrap(sb, current.config);
        }
        await sb.refreshActivity();
        await this.options.store.update(current.id, {
          state: "running", lastStartedAt: needsBootstrap ? this.now() : current.lastStartedAt,
          lastActiveAt: this.now(), lastStateSyncAt: this.now(), errorReason: null, errorCount: 0,
        }, this.now());
        if (created || current.state !== "running") await this.event(current, created ? "created" : "started", { provider_ref: sb.id, generation });
        return { sb, generation, freshlyCreated: created };
      } catch (err) {
        await this.options.store.update(current.id, { state: "error", errorReason: String(err), errorCount: current.errorCount + 1 }, this.now());
        await this.event(current, "error", { message: String(err) });
        throw err;
      }
    });
  }

  /** The DB lease serializes lifecycle and tool operations across hosts.
   * Nested calls in the SAME async operation are reentrant; unrelated
   * operations, including ones on this worker, use different lease owners. */
  async withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    if (this.heldLocks.getStore()?.has(id)) return fn();
    const owner = `${this.workerId}:${randomUUID()}`;
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (!(await this.options.store.tryAcquireLock(id, owner, LOCK_TTL_MS, this.now()))) {
      if (Date.now() >= deadline) throw new MachineLockedError();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    let leaseError: Error | null = null;
    const timer = setInterval(() => {
      void this.options.store.renewLock(id, owner, LOCK_TTL_MS, this.now()).then((ok) => {
        if (!ok) leaseError = new MachineLockedError("agent machine lifecycle lease was lost");
      }).catch((err: unknown) => { leaseError = err instanceof Error ? err : new Error(String(err)); });
    }, LOCK_TTL_MS / 3);
    timer.unref();
    try {
      const held = new Set(this.heldLocks.getStore());
      held.add(id);
      const result = await this.heldLocks.run(held, fn);
      if (leaseError) throw leaseError;
      return result;
    } finally {
      clearInterval(timer);
      await this.options.store.releaseLock(id, owner);
    }
  }

  async heartbeat(provider: AgentBoxProvider): Promise<void> {
    const row = await this.get(provider.input.tenantId, provider.input.agentId);
    if (!row) return;
    await this.options.store.upsertAttachment({
      machineId: row.id, tenantId: row.tenantId, sessionId: provider.input.sessionId,
      workerId: this.workerId, generation: row.generation, ...provider.flags(), now: this.now(),
    });
  }

  async detach(provider: AgentBoxProvider): Promise<void> {
    this.providers.delete(provider);
    await this.options.store.detach(provider.input.sessionId);
  }

  tick(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.ticking) return this.ticking;
    this.ticking = this.doTick().finally(() => { this.ticking = null; });
    return this.ticking;
  }

  private async doTick(): Promise<void> {
    const rows = await this.options.store.listByState(["running"]);
    for (const candidate of rows) {
      try {
        await this.withLock(candidate.id, async () => {
          // Re-read under the lease: a stop/recreate can finish while this
          // tick waits. Never overwrite its state with the earlier snapshot.
          const row = await this.options.store.getById(candidate.id);
          if (!row || row.state !== "running") return;
          const box = row.providerRef ? await this.getProviderBox(row.providerRef, row.generation, row.provider) : null;
          if (!box) {
            await this.options.store.update(row.id, { state: "error", errorReason: "provider machine no longer exists", lastStateSyncAt: this.now() }, this.now());
            return;
          }
          await box.sb.refreshData();
          if (box.sb.state !== "started") {
            await this.options.store.update(row.id, { state: box.sb.state === "archived" ? "archived" : "stopped", lastStateSyncAt: this.now() }, this.now());
            return;
          }
          await this.pollAttachedProcesses(row);
          const live = await this.options.store.liveAttachments(row.id, this.now());
          // The provider process inventory is authoritative. A stale host
          // flag must not keep a finished command's machine billed forever.
          const active = live.some((a) => a.turnActive || a.viewers > 0);
          if (active || await this.hasRunningProcesses(box.sb)) {
            await box.sb.refreshActivity();
            await this.options.store.update(row.id, { lastActiveAt: this.now(), lastStateSyncAt: this.now() }, this.now());
          } else {
            // Daytona counts SDK calls (including our process inventory
            // polling) as activity. Its own auto-stop clock therefore
            // cannot tell monitoring from user work. Enforce the deadline
            // using the platform's last actual activity timestamp.
            const latest = await this.options.store.getById(row.id);
            const lastActiveAt = latest?.lastActiveAt ?? row.lastStartedAt ?? row.createdAt;
            if (this.now() - lastActiveAt >= row.idleStopMinutes * 60_000) {
              // Reentrant lease; stop also checks for newly active work
              // and snapshots the workspace before stopping the provider.
              await this.stop(row.tenantId, row.agentId);
            } else {
              await this.options.store.update(row.id, { lastStateSyncAt: this.now() }, this.now());
            }
          }
        });
      } catch (err) { this.warn(`machine heartbeat failed for ${candidate.id}`, err); }
    }
    await this.options.store.deleteStaleAttachments(this.now(), DEFAULT_ATTACHMENT_STALE_MS);
  }

  /** Host shutdown releases bookkeeping only. The cloud computer and its
   * Linux processes continue running after this Node process exits. */
  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.ticking;
    for (const provider of [...this.providers]) await provider.release();
    for (const driver of Object.values(this.options.drivers ?? {})) driver?.dispose?.();
  }

  private async hasRunningProcesses(sb: DaytonaSandboxInstance): Promise<boolean> {
    const sessions = await sb.process.listSessions();
    return sessions.some((s) => s.sessionId.startsWith("oma-proc-") && s.commands?.some((c) => c.exitCode === undefined || c.exitCode === null));
  }

  private async pollAttachedProcesses(row: AgentMachineRow): Promise<void> {
    for (const provider of this.providers) {
      if (provider.attached && provider.input.tenantId === row.tenantId && provider.input.agentId === row.agentId) {
        await provider.pollProcesses();
        await this.heartbeat(provider);
      }
    }
  }

  private async getProviderBox(id: string, generation: number, provider: string): Promise<AcquiredBox | null> {
    try {
      return { sb: await (await this.client(provider)).get(id), generation, freshlyCreated: false };
    } catch (err) {
      if (this.isNotFound(err, provider)) return null;
      throw err;
    }
  }

  private async bootstrap(sb: DaytonaSandboxInstance, spec: AgentMachineSpec): Promise<void> {
    if (this.options.bootstrap) return this.options.bootstrap(sb, spec);
    const script = buildDaytonaBootstrapScript({ workdir: spec.workdir, bootstrapTools: spec.bootstrapTools, aptPackages: spec.aptPackages, markerPath: "/var/lib/oma/tools-ready" });
    const r = await sb.process.executeCommand(script, undefined, undefined, 180);
    if (r.exitCode !== 0) throw new Error(`agent machine bootstrap failed: ${r.result}`);
    if (spec.browser) throw new Error("agent machine browser bootstrap is not configured");
  }

  private driver(provider: string): MachineDriver | undefined {
    if (provider === "daytona") return undefined;
    if (provider !== "modal" || !this.options.drivers?.modal) throw new Error(`Computer provider ${provider} is not configured`);
    return this.options.drivers.modal;
  }

  private isNotFound(error: unknown, provider: string): boolean {
    return this.driver(provider)?.isNotFound(error) ?? isDaytonaNotFound(error, this.options.daytonaModule);
  }

  private client(provider: string): Promise<DaytonaClient> {
    const driver = this.driver(provider);
    if (driver) return driver.client();
    if (!this.clientPromise) this.clientPromise = (async () => {
      const apiKey = this.options.apiKey ?? process.env.DAYTONA_API_KEY;
      if (!apiKey) throw new Error("DAYTONA_API_KEY is required for agent machines");
      const mod = this.options.daytonaModule ?? await loadDaytonaModule();
      return new mod.Daytona({ apiKey, apiUrl: this.options.apiUrl ?? process.env.DAYTONA_API_URL });
    })().catch((err) => { this.clientPromise = null; throw err; });
    return this.clientPromise;
  }

  private event(row: AgentMachineRow, kind: string, detail?: unknown): Promise<void> {
    return this.options.store.addEvent({ machineId: row.id, tenantId: row.tenantId, kind, detail, now: this.now() });
  }

  private warn(message: string, detail?: unknown): void { (this.options.logger ?? console).warn(message, detail); }
}

function canonicalSpec(spec: AgentMachineSpec): string {
  return JSON.stringify({
    provider: spec.provider ?? "daytona",
    image: spec.snapshot ? null : spec.image,
    snapshot: spec.snapshot || null,
    workdir: spec.workdir.replace(/\/+$/, "") || "/",
    aptPackages: spec.bootstrapTools ? [...new Set(spec.aptPackages)].sort() : [],
    bootstrapTools: spec.bootstrapTools,
    browser: spec.browser,
    desktop: spec.desktop === true,
    idleStopMinutes: spec.idleStopMinutes,
    maxFileBytes: spec.maxFileBytes ?? 512 * 1024 * 1024,
    sdkMode: spec.sdkMode,
  });
}

export class AgentBoxProvider implements SandboxBoxProvider {
  readonly scope = "agent" as const;
  attached = false;
  private readonly activity = new Set<string>();
  private pendingActivity: Promise<void> = Promise.resolve();
  private readonly processPollers = new Map<string, () => Promise<string>>();

  constructor(readonly manager: AgentMachineManager, readonly input: AgentMachineProviderInput) {}

  get browserEnabled(): boolean { return this.input.spec.browser; }

  async acquire(): Promise<AcquiredBox> {
    const box = await this.manager.acquire(this.input);
    this.attached = true;
    await this.manager.heartbeat(this);
    return box;
  }

  async release(): Promise<void> {
    this.attached = false;
    this.activity.clear();
    this.processPollers.clear();
    await this.pendingActivity;
    await this.manager.detach(this);
  }

  sessionDir(): string { return `/mnt/sessions/${this.input.sessionId}`; }
  procDir(): string { return `/var/lib/oma/procs/${this.input.sessionId}`; }

  async lockShared<T>(fn: () => Promise<T>): Promise<T> {
    let row = await this.manager.get(this.input.tenantId, this.input.agentId);
    if (!row) { await this.acquire(); row = await this.manager.get(this.input.tenantId, this.input.agentId); }
    return this.manager.withLock(row!.id, fn);
  }

  setActivityKey(key: string, active: boolean): void {
    if (active) this.activity.add(key); else this.activity.delete(key);
    this.pendingActivity = this.pendingActivity.then(async () => {
      if (!this.attached) return;
      await this.manager.heartbeat(this);
    }).catch((err) => { (this.manager.options.logger ?? console).warn("machine activity update failed", err); });
  }

  async setTurnActive(active: boolean): Promise<void> {
    const update = async () => {
      this.setActivityKey(`turn:${this.input.sessionId}`, active);
      await this.pendingActivity;
    };
    if (active) {
      // A turn may begin before any file/output/tool access attached this
      // executor. Acquire and publish its activity under the same lease
      // that stop uses, before allowing the model to run.
      await this.lockShared(async () => {
        await this.acquire();
        await update();
      });
    } else {
      const row = await this.manager.get(this.input.tenantId, this.input.agentId);
      if (row) await this.manager.withLock(row.id, update);
      else await update();
    }
  }

  watchProcess(id: string, poll: () => Promise<string>): void { this.processPollers.set(id, poll); }
  unwatchProcess(id: string): void { this.processPollers.delete(id); }

  async pollProcesses(): Promise<void> {
    for (const [id, poll] of this.processPollers) {
      try {
        if ((await poll()) !== "running") {
          this.processPollers.delete(id);
          this.activity.delete(`proc:${id}`);
        }
      } catch (err) { (this.manager.options.logger ?? console).warn(`machine process ${id} polling failed`, err); }
    }
    await this.pendingActivity;
  }

  flags(): { turnActive: boolean; bgProcesses: number; viewers: number } {
    return {
      turnActive: [...this.activity].some((key) => key.startsWith("turn:")),
      bgProcesses: [...this.activity].filter((key) => key.startsWith("proc:")).length,
      viewers: [...this.activity].filter((key) => key.startsWith("viewer:")).length,
    };
  }

  async getBrowserEndpoint(): Promise<SandboxBrowserEndpoint | null> {
    if (!this.input.spec.browser) return null;
    if (!this.manager.options.browserEndpoint) throw new Error("agent machine browser endpoint resolver is not configured");
    return this.lockShared(async () => {
      const box = await this.acquire();
      return this.manager.options.browserEndpoint!(box.sb, box.generation);
    });
  }
}
