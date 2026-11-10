// Where does a DaytonaSandbox get its box from?
//
// `DaytonaSandbox` stays one instance per session (env vars, command secrets,
// vault proxy identity and the outputs mount are session-local). Only the
// SOURCE of the Daytona sandbox is pluggable, through `SandboxBoxProvider`:
//
//   SessionBoxProvider  — today's behaviour: create a fresh box on first use,
//                         delete it on destroy. `scope: "session"`.
//   AgentBoxProvider    — (packages/sandbox/src/machines, later slice) hands
//                         out the per-agent persistent machine and only
//                         detaches on release. `scope: "agent"`.
//
// The adapter never talks to the Daytona client directly any more; it calls
// `acquire()` (with `reason: "recover"` when the previous box vanished),
// `release()` on destroy, and consults `sessionDir()` / `procDir()` for the
// filesystem layout that differs between the two scopes.

import type {
  DaytonaClient,
  DaytonaCreateParams,
  DaytonaModule,
  DaytonaSandboxInstance,
} from "./daytona-types";
import { OMA_BOX_LABELS, loadDaytonaModule, mapDaytonaProvisionError } from "./daytona-types";
import type { SandboxBrowserEndpoint } from "../ports";

export const DEFAULT_SANDBOX_IMAGE = "node:22-bookworm";

export interface AcquiredBox {
  sb: DaytonaSandboxInstance;
  /** Increments every time the provider hands out a DIFFERENT box. The
   *  adapter uses it to know when per-box state (mounts, CA cert) must be
   *  re-applied. */
  generation: number;
  /** True when this call created the box (bootstrap just ran). */
  freshlyCreated: boolean;
}

// Single definition lives in ../ports (the SandboxExecutor port surface);
// re-exported here so provider implementations can import it locally.
export type { SandboxBrowserEndpoint };

export interface SandboxBoxProvider {
  readonly scope: "session" | "agent";
  readonly browserEnabled?: boolean;
  acquire(opts?: { reason?: "use" | "recover"; failedSandboxId?: string }): Promise<AcquiredBox>;
  /** Session scope: delete the box. Agent scope: detach this session. */
  release(): Promise<void>;
  /** Per-session directory root (agent scope: /mnt/sessions/<sid>); null when
   *  the legacy single-session layout (/mnt/session) applies. */
  sessionDir(): string | null;
  /** Directory for background-process bookkeeping (<procId>.env/.pid). */
  procDir(): string;
  /** Run `fn` while holding a shared (reader) lifecycle lock so an exclusive
   *  operation (reset/recreate) cannot swap the box mid-operation. Session
   *  scope has no such operations and runs `fn` directly. */
  lockShared<T>(fn: () => Promise<T>): Promise<T>;
  /** Keep-alive bookkeeping: `turn:<sid>`, `proc:<procId>`, `viewer:<key>`. */
  setActivityKey?(key: string, active: boolean): void;
  setTurnActive?(active: boolean): Promise<void>;
  watchProcess?(id: string, poll: () => Promise<string>): void;
  unwatchProcess?(id: string): void;
  getBrowserEndpoint?(): Promise<SandboxBrowserEndpoint | null>;
}

export interface SessionBoxProviderDeps {
  sessionId: string;
  /** Owning tenant and OMA deployment, stamped as labels so the orphan
   *  sweeper can prove a box is this install's before deleting it. */
  tenantId?: string;
  deploymentId?: string;
  /** Daytona API key. Falls back to DAYTONA_API_KEY env var. */
  apiKey?: string;
  /** Daytona API URL (self-host). Falls back to DAYTONA_API_URL. */
  apiUrl?: string;
  image?: string;
  ephemeral?: boolean;
  /** Test seam / pre-loaded SDK. Defaults to `await import("@daytonaio/sdk")`. */
  daytonaModule?: DaytonaModule;
  /** Runs once per created box (tool bootstrap). A throw fails `acquire()`. */
  bootstrap: (sb: DaytonaSandboxInstance) => Promise<void>;
  logger: { warn: (msg: string, ctx?: unknown) => void; log: (msg: string) => void };
}

/** Create params for a per-session box. Unchanged from the original adapter:
 *  `ephemeral: true` (delete-on-stop) by default, otherwise never auto-delete. */
export function buildDaytonaCreateParams(opts: {
  image?: string;
  sessionId: string;
  ephemeral?: boolean;
  tenantId?: string;
  deploymentId?: string;
}): {
  image: string;
  labels: Record<string, string>;
  ephemeral?: boolean;
  autoDeleteInterval?: number;
} {
  return {
    image: opts.image ?? DEFAULT_SANDBOX_IMAGE,
    labels: {
      [OMA_BOX_LABELS.session]: opts.sessionId,
      ...(opts.tenantId ? { [OMA_BOX_LABELS.tenant]: opts.tenantId } : {}),
      ...(opts.deploymentId ? { [OMA_BOX_LABELS.deployment]: opts.deploymentId } : {}),
    },
    ...(opts.ephemeral ?? true
      ? { ephemeral: true }
      : { autoDeleteInterval: -1 }),
  };
}

export class SessionBoxProvider implements SandboxBoxProvider {
  readonly scope = "session" as const;
  private client: DaytonaClient | null = null;
  private current: AcquiredBox | null = null;
  private inflight: Promise<AcquiredBox> | null = null;
  private generation = 0;

  constructor(private readonly deps: SessionBoxProviderDeps) {}

  async acquire(opts?: { reason?: "use" | "recover"; failedSandboxId?: string }): Promise<AcquiredBox> {
    if (opts?.reason === "recover") {
      if (this.inflight) await this.inflight.catch(() => null);
      // A stale recover request (the box named in `failedSandboxId` was
      // already replaced by a concurrent caller) must not throw away the
      // healthy replacement and create yet another box.
      if (
        this.current &&
        opts.failedSandboxId &&
        this.current.sb.id !== opts.failedSandboxId
      ) {
        return { ...this.current, freshlyCreated: false };
      }
      // The previous box is gone upstream; forget it and create again.
      this.current = null;
      this.inflight = null;
    }
    if (this.current) return { ...this.current, freshlyCreated: false };
    if (this.inflight) return this.inflight;
    const p = this.createBox();
    this.inflight = p;
    try {
      const box = await p;
      this.current = { ...box, freshlyCreated: false };
      return box;
    } finally {
      if (this.inflight === p) this.inflight = null;
    }
  }

  async release(): Promise<void> {
    if (this.inflight) await this.inflight.catch(() => null);
    const box = this.current;
    this.current = null;
    if (!box || !this.client) return;
    await this.client.delete(box.sb);
  }

  sessionDir(): string | null {
    return null;
  }

  procDir(): string {
    return "/tmp/oma-procs";
  }

  lockShared<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }

  private async ensureClient(): Promise<DaytonaClient> {
    if (this.client) return this.client;
    const apiKey = this.deps.apiKey ?? process.env.DAYTONA_API_KEY;
    if (!apiKey) {
      throw new Error(
        "DaytonaSandbox: apiKey not provided and DAYTONA_API_KEY env var not set",
      );
    }
    const mod = this.deps.daytonaModule ?? (await loadDaytonaModule());
    this.client = new mod.Daytona({
      apiKey,
      apiUrl: this.deps.apiUrl ?? process.env.DAYTONA_API_URL,
    });
    return this.client;
  }

  private async createBox(): Promise<AcquiredBox> {
    const client = await this.ensureClient();
    this.deps.logger.log(`creating sandbox for session ${this.deps.sessionId}`);
    const params: DaytonaCreateParams = buildDaytonaCreateParams({
      image: this.deps.image,
      sessionId: this.deps.sessionId,
      ephemeral: this.deps.ephemeral,
      tenantId: this.deps.tenantId,
      deploymentId: this.deps.deploymentId,
    });
    let sb: DaytonaSandboxInstance;
    try {
      sb = await client.create(params);
    } catch (err) {
      const mapped = mapDaytonaProvisionError(err);
      if (mapped !== err) {
        // The session sees the readable message; the provider's own text
        // (quota numbers, dashboard link) stays here.
        this.deps.logger.warn(
          `sandbox create for session ${this.deps.sessionId} refused by provider quota: ${(err as Error).message}`,
        );
      }
      throw mapped;
    }
    this.deps.logger.log(`sandbox ${sb.id} ready`);
    try {
      await this.deps.bootstrap(sb);
    } catch (err) {
      // Don't leak a half-bootstrapped box: the caller will see the bootstrap
      // error and the next acquire() creates a new one.
      await client.delete(sb).catch((delErr) => {
        this.deps.logger.warn(
          `cleanup of sandbox ${sb.id} after failed bootstrap failed: ${(delErr as Error).message}`,
        );
      });
      throw err;
    }
    this.generation += 1;
    return { sb, generation: this.generation, freshlyCreated: true };
  }
}
