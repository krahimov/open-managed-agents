// Structural types for the slice of @daytonaio/sdk 0.231.0 the Daytona
// adapter, box providers, and the agent-machine manager use.
//
// They are deliberately structural (no import of the SDK's own types) so the
// sandbox package compiles and runs without `@daytonaio/sdk` installed — the
// driver is an optional peer dependency that is dynamic-imported through
// `loadDaytonaModule()`. Tests satisfy the same shapes with the in-memory
// fake (`tests/fake-daytona.ts`) via the `daytonaModule` seam.
//
// Field/method names mirror the SDK exactly (verified against the 0.231.0
// .d.ts files): `sandbox.refreshActivity()`, `sandbox.setAutostopInterval(n)`
// (lowercase "s"), `sandbox.getPreviewLink(port) → { url, token }`,
// `process.executeSessionCommand(id, { command, runAsync }) → { cmdId }`.

/** Response of `process.executeCommand`. The SDK's ExecutionArtifacts only
 *  carries `stdout` (+charts); `stderr` is kept optional here because the
 *  toolbox is not guaranteed to separate streams — callers must tolerate a
 *  combined `result`. */
export interface DaytonaExecuteResponse {
  exitCode: number;
  result: string;
  artifacts?: { stdout?: string; stderr?: string };
}

/** `process.executeSessionCommand` result. `exitCode`/`stdout`/`stderr`/
 *  `output` are only populated for synchronous (non-`runAsync`) commands. */
export interface DaytonaSessionExecuteResponse {
  cmdId: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  output?: string;
}

/** `process.getSessionCommand` result. `exitCode` is undefined while the
 *  command is still running. */
export interface DaytonaSessionCommand {
  id: string;
  command: string;
  exitCode?: number;
}

/** Non-streaming `process.getSessionCommandLogs` result. */
export interface DaytonaSessionCommandLogs {
  output?: string;
  stdout?: string;
  stderr?: string;
}

export interface DaytonaSessionSummary {
  sessionId: string;
  commands?: Array<{ id: string; exitCode?: number }>;
}

export interface DaytonaProcess {
  executeCommand(
    command: string,
    cwd?: string,
    env?: Record<string, string>,
    timeoutSec?: number,
  ): Promise<DaytonaExecuteResponse>;
  createSession(sessionId: string): Promise<void>;
  executeSessionCommand(
    sessionId: string,
    req: { command: string; runAsync?: boolean },
    timeoutSec?: number,
  ): Promise<DaytonaSessionExecuteResponse>;
  getSessionCommand(sessionId: string, cmdId: string): Promise<DaytonaSessionCommand>;
  getSessionCommandLogs(sessionId: string, cmdId: string): Promise<DaytonaSessionCommandLogs>;
  listSessions(): Promise<DaytonaSessionSummary[]>;
  deleteSession(sessionId: string): Promise<void>;
}

export interface DaytonaFileSystem {
  uploadFile(file: Buffer, remotePath: string, timeout?: number): Promise<void>;
  downloadFile(remotePath: string, timeout?: number): Promise<Buffer>;
  createFolder(path: string, mode: string): Promise<void>;
}

export interface DaytonaPreviewLink {
  url: string;
  token: string;
}

export interface DaytonaSandboxInstance {
  id: string;
  public?: boolean;
  name?: string;
  /** SDK SandboxState string: started | stopped | archived | error | … */
  state?: string;
  recoverable?: boolean;
  labels?: Record<string, string>;
  /** ISO timestamp from the SDK (the in-memory fake reports epoch ms). */
  createdAt?: string | number;
  autoStopInterval?: number;
  autoDeleteInterval?: number;
  computerUse?: {
    start(): Promise<unknown>;
    screenshot: { takeFullScreen(showCursor?: boolean): Promise<{ screenshot?: string }> };
    mouse: { click(x: number, y: number, button?: string, double?: boolean): Promise<unknown>; scroll(x: number, y: number, direction: string, amount?: number): Promise<unknown> };
    keyboard: { type(text: string): Promise<unknown>; press(key: string, modifiers?: string[]): Promise<unknown> };
  };
  process: DaytonaProcess;
  fs: DaytonaFileSystem;
  start(timeoutSec?: number): Promise<void>;
  stop(timeoutSec?: number, force?: boolean): Promise<void>;
  refreshData(): Promise<void>;
  /** Real keep-alive: PUT updateLastActivity (previews do NOT count). */
  refreshActivity(): Promise<void>;
  recover(timeoutSec?: number): Promise<void>;
  setAutostopInterval(minutes: number): Promise<void>;
  setLabels(labels: Record<string, string>): Promise<Record<string, string>>;
  getPreviewLink(port: number): Promise<DaytonaPreviewLink>;
  getSignedPreviewUrl(port: number, expiresInSeconds?: number): Promise<DaytonaPreviewLink>;
}

/** Union of CreateSandboxFromImageParams / CreateSandboxFromSnapshotParams.
 *  Declared as a type alias (not an interface) so it stays assignable to
 *  index-signature'd fakes. `resources` is only valid together with `image`. */
export type DaytonaCreateParams = {
  user?: string;
  public?: boolean;
  image?: string;
  snapshot?: string;
  name?: string;
  labels?: Record<string, string>;
  envVars?: Record<string, string>;
  ephemeral?: boolean;
  autoDeleteInterval?: number;
  autoStopInterval?: number;
  autoArchiveInterval?: number;
  resources?: { cpu?: number; memory?: number; disk?: number };
};

export interface DaytonaClient {
  create(params: DaytonaCreateParams, options?: { timeout?: number }): Promise<DaytonaSandboxInstance>;
  get(sandboxIdOrName: string): Promise<DaytonaSandboxInstance>;
  list(query?: { labels?: Record<string, string> }): AsyncIterable<DaytonaSandboxInstance>;
  delete(sandbox: DaytonaSandboxInstance, timeoutSec?: number): Promise<void>;
}

export interface DaytonaModule {
  Daytona: new (config: { apiKey: string; apiUrl?: string }) => DaytonaClient;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  DaytonaNotFoundError?: new (...args: any[]) => Error;
}

/** Dynamic-import seam for the optional `@daytonaio/sdk` peer. */
export async function loadDaytonaModule(): Promise<DaytonaModule> {
  return (await import(
    /* @vite-ignore */ "@daytonaio/sdk" as string
  ).catch((err) => {
    throw new Error(
      `DaytonaSandbox: failed to load '@daytonaio/sdk' — ` +
      `pnpm add @daytonaio/sdk (cause: ${String(err)})`,
    );
  })) as DaytonaModule;
}

/** Daytona 404s a deleted/archived box with messages like
 *  "not found: sandbox <uuid> not found (it has been deleted)" (live prod
 *  2026-07-25) or "sandbox <id> has been archived". Keep the match narrow —
 *  a missing FILE error must not trigger re-provisioning. */
export const DAYTONA_SANDBOX_GONE_MESSAGE_RE =
  /has been (deleted|archived)|not found: sandbox|sandbox [0-9a-f][0-9a-f-]{7,} not found/i;

/** Message shape of the SDK's own `DaytonaNotFoundError` for a missing box
 *  ("Sandbox with ID <id> not found" from `daytona.get`/`refreshData`, or
 *  "sandbox <id> not found"). The leading guard rejects paths such as
 *  "/workspace/sandbox/config.json". */
const DAYTONA_SANDBOX_REFERENCE_RE = /(^|[^/\w])sandbox( with id)? \S+ not found/i;

/**
 * Is `err` Daytona telling us the SANDBOX itself is gone (deleted upstream,
 * archived, unknown id)?
 *
 * `instanceof DaytonaNotFoundError` alone is NOT enough: the SDK raises the
 * same class for a missing file (`fs.downloadFile`), a missing process
 * session, or a missing session command. Treating those as "box gone" would
 * re-provision (and, in session scope, destroy) a perfectly healthy sandbox
 * on every `read_file` miss. So the class check additionally requires the
 * message to name a sandbox; the message regex alone (today's detector)
 * still covers the prod strings when no module is available.
 */
export function isDaytonaNotFound(err: unknown, mod?: DaytonaModule | null): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (DAYTONA_SANDBOX_GONE_MESSAGE_RE.test(msg)) return true;
  if (mod?.DaytonaNotFoundError && err instanceof mod.DaytonaNotFoundError) {
    return DAYTONA_SANDBOX_REFERENCE_RE.test(msg);
  }
  return false;
}

// ─── Box ownership labels ───────────────────────────────────────────

/** Labels OMA stamps on every Daytona box it creates. Cleanup code (agent
 *  delete, the orphan sweeper) identifies boxes by these and never touches a
 *  box that lacks them. `deployment` separates several OMA installs that
 *  share one Daytona account; boxes created before it existed carry none. */
export const OMA_BOX_LABELS = {
  session: "oma-session-id",
  machine: "oma-machine-id",
  tenant: "oma-tenant-id",
  agent: "oma-agent-id",
  deployment: "oma-deployment-id",
} as const;

// ─── Capacity errors ────────────────────────────────────────────────

export type SandboxCapacityResource = "storage" | "compute" | "capacity";

/** The provider account refused to create/start a box because an account
 *  quota is exhausted. `message` is written for the session's end user —
 *  the raw provider text (which names the provider's own dashboard) stays in
 *  `cause` and in server logs. */
export class SandboxCapacityError extends Error {
  readonly code = "sandbox_capacity" as const;
  constructor(readonly resource: SandboxCapacityResource, cause: unknown) {
    super(SANDBOX_CAPACITY_MESSAGES[resource], { cause });
    this.name = "SandboxCapacityError";
  }
}

const SANDBOX_CAPACITY_MESSAGES: Record<SandboxCapacityResource, string> = {
  storage:
    "Sandbox unavailable: this workspace's sandbox storage is full, so a sandbox could not be started and nothing was run. " +
    "A workspace owner can free space by deleting agents and sessions that are no longer needed (their sandboxes and computers are deleted with them), " +
    "or ask the operator of this deployment to raise the sandbox storage limit. Then try again.",
  compute:
    "Sandbox unavailable: this workspace's sandbox CPU/memory allowance is fully in use, so a sandbox could not be started and nothing was run. " +
    "Wait for running sessions to finish or stop agent computers that are not needed, " +
    "or ask the operator of this deployment to raise the sandbox limit. Then try again.",
  capacity:
    "Sandbox unavailable: this workspace has reached its sandbox limit, so a sandbox could not be started and nothing was run. " +
    "A workspace owner can free capacity by deleting agents and sessions that are no longer needed, " +
    "or ask the operator of this deployment to raise the sandbox limit. Then try again.",
};

/** Daytona's organization quota refusals, e.g. "Total disk limit exceeded.
 *  Maximum allowed: 30GiB" (live prod 2026-11-10), and the cpu / memory /
 *  "quota exceeded" variants of the same check. Rate limits ("rate limit
 *  exceeded") are transient and deliberately do not match. */
const DAYTONA_QUOTA_RE =
  /\btotal (?:cpu|memory|disk|storage|sandbox)[a-z ]* (?:quota|limit) exceeded\b|\bquota (?:has been )?(?:exceeded|reached)\b/i;

/** Translate a provider quota refusal into a `SandboxCapacityError`; every
 *  other error is returned unchanged. */
export function mapDaytonaProvisionError(err: unknown): unknown {
  if (err instanceof SandboxCapacityError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  if (!DAYTONA_QUOTA_RE.test(msg)) return err;
  const resource: SandboxCapacityResource = /\b(?:disk|storage)\b/i.test(msg)
    ? "storage"
    : /\b(?:cpu|memory|ram)\b/i.test(msg)
      ? "compute"
      : "capacity";
  return new SandboxCapacityError(resource, err);
}

/** A delete/get told us the box is already gone. Unlike `isDaytonaNotFound`
 *  this also accepts a bare HTTP 404, so only use it for calls addressed to
 *  the SANDBOX itself — never for file or process operations. */
export function isDaytonaBoxGone(err: unknown, mod?: DaytonaModule | null): boolean {
  if (isDaytonaNotFound(err, mod)) return true;
  return (err as { statusCode?: unknown } | null)?.statusCode === 404;
}
