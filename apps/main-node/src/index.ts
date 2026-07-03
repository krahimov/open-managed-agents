/**
 * apps/main-node — self-host Node entry for the Open Managed Agents API.
 *
 * Wiring file. ~280 lines: build services → mount route bundles from
 * @open-managed-agents/http-routes → start server. All route bodies live
 * in packages/http-routes; storage adapters in their respective packages
 * (agents-store, vaults-store, memory-store, etc.).
 */

import { randomBytes } from "node:crypto";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import {
  createNodeLogger,
} from "@open-managed-agents/observability/logger/node";
import {
  createNodeMetricsRecorder,
  type NodeMetricsHandle,
} from "@open-managed-agents/observability/metrics/node";
import {
  createNodeTracer,
  type NodeTracerHandle,
} from "@open-managed-agents/observability/tracer/node";
import {
  requestMetrics,
  tracerMiddleware,
  setRootLogger,
  type Logger,
} from "@open-managed-agents/observability";
import {
  createBetterSqlite3SqlClient,
  createPostgresSqlClient,
  type SqlClient,
} from "@open-managed-agents/sql-client";
import {
  createSqliteAgentService,
  createSqliteAmbientRuleService,
} from "@open-managed-agents/agents-store";
import {
  createSqliteMemoryStoreService,
  SqlMemoryRepo,
} from "@open-managed-agents/memory-store";
import { LocalFsBlobStore as MemoryLocalFsBlobStore } from "@open-managed-agents/memory-store/adapters/local-fs-blob";
import {
  S3BlobStore as FilesS3BlobStore,
  type BlobStore,
} from "@open-managed-agents/blob-store";
import { LocalFsBlobStore as FilesLocalFsBlobStore } from "@open-managed-agents/blob-store/adapters/local-fs";
import { createSqliteVaultService } from "@open-managed-agents/vaults-store";
import { createSqliteCredentialService } from "@open-managed-agents/credentials-store";
import { createSqliteSessionService } from "@open-managed-agents/sessions-store";
import { createSqliteFileService } from "@open-managed-agents/files-store";
import { createSqliteEvalRunService } from "@open-managed-agents/evals-store";
import {
  createSqliteEnvironmentService,
  EnvironmentNotFoundError,
  toEnvironmentConfig,
} from "@open-managed-agents/environments-store";
import {
  createSqliteModelCardService,
  ModelCardDuplicateModelIdError,
  ModelCardNotFoundError,
  type ModelCardRow,
} from "@open-managed-agents/model-cards-store";
import { toFileRecord } from "@open-managed-agents/files-store";
import { SqlEventLog } from "@open-managed-agents/event-log/sql";
import type { AgentConfig, CredentialConfig, EnvironmentConfig, SessionEvent } from "@open-managed-agents/shared";
import { generateEventId } from "@open-managed-agents/shared";
import { DefaultHarness } from "@open-managed-agents/agent/harness/default-loop";
import { ClaudeAgentSdkHarness } from "./lib/claude-agent-sdk-harness.js";
import { buildTools } from "@open-managed-agents/agent/harness/tools";
import { resolveModel, type ApiCompat } from "@open-managed-agents/agent/harness/provider";
import { composeSystemPrompt } from "@open-managed-agents/agent/harness/platform-guidance";
import type { HarnessContext } from "@open-managed-agents/agent/harness/interface";
import { nodeToMarkdown } from "@open-managed-agents/markdown/adapters/node";
import { applyBetterAuthSchema } from "@open-managed-agents/schema";
import { ensureSchema as ensureEventLogSchema } from "@open-managed-agents/event-log/sql";
import {
  buildAgentRoutes,
  buildVaultRoutes,
  listComposioToolkits,
  buildSessionRoutes,
  buildMemoryRoutes,
  buildTenantRoutes,
  buildMeRoutes,
  buildApiKeyRoutes,
  buildEvalRoutes,
  buildIntegrationsRoutes,
  buildIntegrationsGatewayRoutes,
  type RouteServices,
  type ApiKeyStorage,
  type ApiKeyMeta,
  type ApiKeyRecord,
  type InstallProxyForwarder,
  mintApiKeyOnStorage,
  sha256Hex,
} from "@open-managed-agents/http-routes";
import {
  buildNodeRepos,
  SqlSlackInstallationRepo,
  SqlSlackPublicationRepo,
  SqlSlackAppRepo,
  WebCryptoAesGcm,
  CryptoIdGenerator,
  type NodeReposEnv,
} from "@open-managed-agents/integrations-adapters-node";
import {
  NodeInstallBridge,
  buildNodeProvidersForRequest,
} from "./lib/node-install-bridge.js";
import { OmaVaultResolver } from "@open-managed-agents/oma-cap-adapter";
import { NodeSessionRouter } from "./lib/node-session-router.js";
import {
  nodeOutputsAdapter,
  nodeS3OutputsAdapter,
} from "./lib/node-outputs-adapter.js";
import { nodeSessionLifecycle } from "./lib/node-session-lifecycle.js";
import { NodeWorkspaceBackupService } from "./lib/node-workspace-backup.js";
import { DefaultSandboxOrchestrator } from "@open-managed-agents/sandbox/orchestrator";
import { createAuthMiddleware as buildAuthMw } from "@open-managed-agents/auth";
import {
  buildBetterAuth,
  ensureTenantSqlite,
} from "@open-managed-agents/auth-config";
import { senderFromEnv } from "@open-managed-agents/email/adapters/nodemailer";
import { SqlKvStore } from "@open-managed-agents/kv-store/adapters/sql";
import {
  selectBrowserHarness,
  buildSelectedBrowserHarness,
} from "@open-managed-agents/browser-harness/select";
import type { BrowserHarness } from "@open-managed-agents/browser-harness";
import { startMemoryBlobWatcher } from "./lib/memory-blob-watcher.js";
import { buildNodeScheduler } from "./lib/node-scheduler-jobs.js";
import { startNodeMemoryQueue } from "./lib/node-memory-queue.js";
import {
  buildSandboxEnvForEnvironment,
  environmentMemoryStoreRefs,
  sandboxProviderFromEnvironment,
} from "./lib/environment-runtime-config.js";
import { buildNodeOAuthRoutes } from "./lib/node-oauth-routes.js";
import { NodeSessionWorkQueue } from "./lib/node-session-work-queue.js";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nanoid } from "nanoid";
import {
  InProcessEventStreamHub,
  type EventStreamHub,
} from "./lib/event-stream-hub";
import { PgEventStreamHub } from "./lib/pg-event-stream-hub";
import { NodeHarnessRuntime } from "./lib/node-harness-runtime";
import { NodeSessionWakeups } from "./lib/node-session-wakeups";
import {
  resolveClerkConfig,
  ClerkTokenVerifier,
  ClerkStore,
  buildClerkPreCreateGate,
  handleClerkWebhook,
} from "./lib/clerk";
import { resolveMaxAgentsPerTenant, buildAgentPreCreateGate } from "./lib/agent-limits";
import { NodeAmbientDispatcher } from "./lib/node-ambient-dispatch";
import { Cron } from "croner";
import { SessionRegistry } from "./registry.js";

loadDotenvDefaults();

const toMarkdownProvider = nodeToMarkdown();
const MODEL_CARD_PROVIDERS = ["ant", "ant-compatible", "oai", "oai-compatible"] as const;
const DEFAULT_OPENAI_MODEL = "gpt-5.5";
const LEGACY_OPENAI_MODEL = "gpt-4o";
const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";
const ANTHROPIC_OPUS_MODEL = "claude-opus-4-8";
const LEGACY_ANTHROPIC_OPUS_MODEL = "claude-opus-4-7";
const LEGACY_ANTHROPIC_OPUS_46_MODEL = "claude-opus-4-6";

// ─── Observability bootstrap ─────────────────────────────────────────────
//
// Logger is constructed first so every later step can use it instead of
// raw console.*. Metrics + tracer follow; both are no-ops by default and
// only spin up real backends when the env opts in.
//   - Prometheus metrics: always-on in-process registry; /metrics text
//     endpoint mounted below.
//   - OTel tracing: starts only when OTEL_EXPORTER_OTLP_ENDPOINT is set.
const logger: Logger = await createNodeLogger({
  bindings: { service: "main-node", pid: process.pid },
});
setRootLogger(logger);

const metrics: NodeMetricsHandle = await createNodeMetricsRecorder();
const tracer: NodeTracerHandle = await createNodeTracer({
  serviceName: "oma-main-node",
});

// ─── Bootstrap ───────────────────────────────────────────────────────────

const dbUrl = process.env.DATABASE_URL ?? "";
const usePostgres = dbUrl.startsWith("postgres://") || dbUrl.startsWith("postgresql://");
const dialect = usePostgres ? "postgres" : "sqlite";

let sql: SqlClient;
let backendDescription: string;
// drizzleDb is the dependency-inversion seam new-style adapters take.
// Constructed once at the composition root from the right concrete driver.
// Existing SqlClient is still built alongside for the legacy applySchema /
// integrations adapters until those finish migrating.
import type { OmaDb } from "@open-managed-agents/db-schema";
let drizzleDb: OmaDb<Record<string, unknown>>;
if (usePostgres) {
  sql = await createPostgresSqlClient(dbUrl);
  const { drizzle: drizzlePostgresJs } = await import("drizzle-orm/postgres-js");
  const postgresMod = (await import("postgres" as string)) as {
    default: (dsn: string, opts?: unknown) => unknown;
  };
  // Coerce int8/BIGINT (OID 20) to JS number — postgres.js returns bigint as
  // a string by default, and drizzle's `mode:"number"` does not re-coerce it,
  // so msToIso(created_at) saw "1781293530632" and threw "Invalid time value"
  // on the first Postgres boot. Mirrors the same parser in
  // packages/sql-client/src/adapters/postgres.ts. Safe: every bigint column in
  // the node-pg schema (ms timestamps, versions, flags) is within 2^53.
  const pgClient = postgresMod.default(dbUrl, {
    types: {
      bigint: {
        to: 20,
        from: [20],
        serialize: (v: number) => v.toString(),
        parse: (v: string) => Number(v),
      },
    },
  });
  drizzleDb = drizzlePostgresJs(pgClient as never) as unknown as OmaDb<Record<string, unknown>>;
  const u = new URL(dbUrl);
  backendDescription = `postgres ${u.hostname}:${u.port || 5432}${u.pathname}`;
} else {
  const dbPath = process.env.DATABASE_PATH ?? "./data/oma.db";
  mkdirSync(dirname(dbPath), { recursive: true });
  sql = await createBetterSqlite3SqlClient(dbPath);
  const { drizzle: drizzleBetterSqlite3 } = await import("drizzle-orm/better-sqlite3");
  const BetterSqlite3 = (await import("better-sqlite3")).default;
  const sqliteRaw = new BetterSqlite3(dbPath);
  // Match D1's runtime default — FK enforcement off. See packages/sql-client
  // for the rationale (publication-first install + a few other paths).
  sqliteRaw.exec("PRAGMA foreign_keys = OFF");
  drizzleDb = drizzleBetterSqlite3(sqliteRaw) as unknown as OmaDb<Record<string, unknown>>;
  backendDescription = `sqlite ${dbPath}`;
}

// Apply the consolidated baseline (Drizzle migrate runner — one folder per
// dialect, generated by `pnpm db:generate:node-{pg,sqlite}`). Replaces the
// pre-Drizzle applySchema / applyTenantSchema / applyIntegrationsSchema /
// applyMemoryPollerSchema chain — those creator functions hand-wrote
// CREATE TABLE IF NOT EXISTS and ad-hoc ALTER backfills, which had been
// drifting from the canonical CF migration files.
//
// session_events (event-log) is still its own concern: its idempotent
// ensureSchema lives in @open-managed-agents/event-log/sql and runs after
// the baseline migration applies the rest.
const migrationsFolder = usePostgres
  ? new URL("../migrations", import.meta.url).pathname
  : new URL("../migrations-sqlite", import.meta.url).pathname;
if (usePostgres) {
  const { migrate } = await import("drizzle-orm/postgres-js/migrator");
  await migrate(drizzleDb as never, { migrationsFolder });
} else {
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(drizzleDb as never, { migrationsFolder });
}
await ensureEventLogSchema(sql, dialect);

// Integrations subsystem boot is gated on PLATFORM_ROOT_SECRET (used to
// encrypt OAuth tokens etc.). Tables are part of the consolidated baseline
// above so they're always created — the gate now only controls subsystem
// wiring, not schema bootstrap.
const platformRootSecret = process.env.PLATFORM_ROOT_SECRET;

// ─── Auth ───────────────────────────────────────────────────────────────

const authDisabled = process.env.AUTH_DISABLED === "1";
const authDbPath = process.env.AUTH_DATABASE_PATH ?? "./data/auth.db";
const sender = senderFromEnv(process.env);

// AUTH_MODE=clerk → Clerk is the ONLY auth: better-auth is not mounted at
// all (no /auth/* endpoints, no cookie sessions); every request must carry
// a Clerk session JWT (or an x-api-key). Pair with a console built with
// VITE_CLERK_PUBLISHABLE_KEY. AUTH_DISABLED=1 still wins for bare dev.
const clerkOnly = (process.env.AUTH_MODE ?? "").trim().toLowerCase() === "clerk";
if (clerkOnly && !resolveClerkConfig()) {
  throw new Error(
    "AUTH_MODE=clerk requires CLERK_ISSUER or CLERK_PUBLISHABLE_KEY to be set",
  );
}

let auth: ReturnType<typeof buildBetterAuth> | null = null;
let authShutdown: (() => Promise<void>) | null = null;

if (!authDisabled && !clerkOnly) {
  if (usePostgres) {
    const { Pool } = (await import("pg")) as typeof import("pg");
    const pgPool = new Pool({ connectionString: dbUrl });
    await applyBetterAuthSchema({ sql, dialect: "postgres" });
    auth = buildBetterAuth({
      database: pgPool,
      sender,
      secret: process.env.BETTER_AUTH_SECRET ?? randomFallback(),
      baseURL: process.env.PUBLIC_BASE_URL,
      googleClientId: process.env.GOOGLE_CLIENT_ID,
      googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
      githubClientId: process.env.GITHUB_AUTH_CLIENT_ID,
      githubClientSecret: process.env.GITHUB_AUTH_CLIENT_SECRET,
      betterAuthInfraApiKey: process.env.BETTER_AUTH_API_KEY,
      betterAuthInfraApiUrl: process.env.BETTER_AUTH_API_URL,
      betterAuthInfraKvUrl: process.env.BETTER_AUTH_KV_URL,
      requireEmailVerify: process.env.AUTH_REQUIRE_EMAIL_VERIFY === "1",
      cookieDomain: process.env.AUTH_COOKIE_DOMAIN,
      ensureTenant: (u) => ensureTenantSqlite(sql, u.id, u.name, u.email),
    });
    authShutdown = async () => {
      await pgPool.end();
    };
  } else {
    mkdirSync(dirname(authDbPath), { recursive: true });
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const authDb = new BetterSqlite3(authDbPath);
    // Run the better-auth schema on the auth db via a thin SqlClient shim —
    // applyBetterAuthSchema only uses sql.exec which maps cleanly.
    await applyBetterAuthSchema({
      sql: betterSqliteAsSqlClient(authDb),
      dialect: "sqlite",
    });
    auth = buildBetterAuth({
      database: authDb,
      sender,
      secret: process.env.BETTER_AUTH_SECRET ?? randomFallback(),
      baseURL: process.env.PUBLIC_BASE_URL,
      googleClientId: process.env.GOOGLE_CLIENT_ID,
      googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
      githubClientId: process.env.GITHUB_AUTH_CLIENT_ID,
      githubClientSecret: process.env.GITHUB_AUTH_CLIENT_SECRET,
      betterAuthInfraApiKey: process.env.BETTER_AUTH_API_KEY,
      betterAuthInfraApiUrl: process.env.BETTER_AUTH_API_URL,
      betterAuthInfraKvUrl: process.env.BETTER_AUTH_KV_URL,
      requireEmailVerify: process.env.AUTH_REQUIRE_EMAIL_VERIFY === "1",
      cookieDomain: process.env.AUTH_COOKIE_DOMAIN,
      ensureTenant: (u) => ensureTenantSqlite(sql, u.id, u.name, u.email),
    });
    authShutdown = async () => {
      authDb.close();
    };
  }
}

// ─── Clerk (optional managed-auth overlay) ──────────────────────────────
// Active when CLERK_ISSUER or CLERK_PUBLISHABLE_KEY is set. Coexists with
// better-auth: cookie sessions resolve first, then `Authorization:
// Bearer <clerk session JWT>`. Users sync into clerk_users (+ tenant +
// membership via the same ensureTenant path) through /clerk/webhook.

const clerkConfig = resolveClerkConfig();
const clerkVerifier = clerkConfig ? new ClerkTokenVerifier(clerkConfig) : null;
const clerkStore = clerkConfig
  ? new ClerkStore({
      sql,
      dialect,
      ensureTenant: (userId, name, email) => ensureTenantSqlite(sql, userId, name, email),
      // Org tenancy — same tenant/membership SQL shapes ensureTenantSqlite
      // uses (better-auth camelCase tenant columns, snake_case membership).
      orgTenancy: {
        createTenant: async (name) => {
          const tenantId = `tn_${randomBytes(16).toString("hex")}`;
          const now = Date.now();
          await sql
            .prepare(`INSERT INTO "tenant" (id, name, "createdAt", "updatedAt") VALUES (?, ?, ?, ?)`)
            .bind(tenantId, name, now, now)
            .run();
          return tenantId;
        },
        addMembership: async (userId, tenantId, role) => {
          await sql
            .prepare(
              `INSERT INTO "membership" (user_id, tenant_id, role, created_at)
               VALUES (?, ?, ?, ?)
               ON CONFLICT (user_id, tenant_id) DO NOTHING`,
            )
            .bind(userId, tenantId, role, Date.now())
            .run();
        },
        removeMembership: async (userId, tenantId) => {
          await sql
            .prepare(`DELETE FROM "membership" WHERE user_id = ? AND tenant_id = ?`)
            .bind(userId, tenantId)
            .run();
        },
      },
    })
  : null;
if (clerkStore) {
  await clerkStore.ensureSchema();
  logger.info(
    { op: "main-node.clerk.enabled", issuer: clerkConfig!.issuer, billing_enforce: clerkConfig!.billingEnforce },
    "clerk auth enabled",
  );
}

// ─── Stores ─────────────────────────────────────────────────────────────

const agentsService = createSqliteAgentService({ db: drizzleDb });
const ambientRulesService = createSqliteAmbientRuleService({ db: drizzleDb });
const vaultService = createSqliteVaultService({ db: drizzleDb });
const credentialService = createSqliteCredentialService({ db: drizzleDb });
const sessionsService = createSqliteSessionService({ db: drizzleDb });
const filesService = createSqliteFileService({ db: drizzleDb });
const evalsService = createSqliteEvalRunService({ db: drizzleDb });
const environmentsService = createSqliteEnvironmentService({ db: drizzleDb });
const modelCardService = createSqliteModelCardService(
  { db: drizzleDb },
  {
    crypto: platformRootSecret
      ? new WebCryptoAesGcm(platformRootSecret, "model.cards.keys")
      : undefined,
  },
);
await seedEnvModelCard();

// ─── Outbound webhooks (requires PLATFORM_ROOT_SECRET for secret storage) ──
const { WebhookStore, startWebhookDeliveryPoller, WEBHOOK_EVENT_TYPES } = await import(
  "./lib/webhooks.js"
);
const webhookStore = platformRootSecret
  ? new WebhookStore(sql, dialect, new WebCryptoAesGcm(platformRootSecret, "webhooks.signing_secrets"))
  : null;
if (webhookStore) await webhookStore.ensureSchema();
if (webhookStore) startWebhookDeliveryPoller({ store: webhookStore });

// ─── Skills (SKILL.md storage + GitHub import) ─────────────────────────────
const { SkillStore } = await import("./lib/skills.js");
const skillStore = new SkillStore(sql);
await skillStore.ensureSchema();

let memoryBlobs: import("@open-managed-agents/memory-store").BlobStore;
let memoryBlobDescription: string;
let memoryBlobLocalDir: string | null = null;
let s3MemoryConfig: {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  region: string;
} | null = null;

if (
  process.env.MEMORY_S3_ENDPOINT &&
  process.env.MEMORY_S3_BUCKET &&
  process.env.MEMORY_S3_ACCESS_KEY &&
  process.env.MEMORY_S3_SECRET_KEY
) {
  const { S3BlobStore } = await import(
    "@open-managed-agents/memory-store/adapters/s3-blob"
  );
  s3MemoryConfig = {
    endpoint: process.env.MEMORY_S3_ENDPOINT,
    bucket: process.env.MEMORY_S3_BUCKET,
    accessKey: process.env.MEMORY_S3_ACCESS_KEY,
    secretKey: process.env.MEMORY_S3_SECRET_KEY,
    region: process.env.MEMORY_S3_REGION ?? "us-east-1",
  };
  memoryBlobs = new S3BlobStore({
    endpoint: s3MemoryConfig.endpoint,
    bucket: s3MemoryConfig.bucket,
    accessKeyId: s3MemoryConfig.accessKey,
    secretAccessKey: s3MemoryConfig.secretKey,
    region: s3MemoryConfig.region,
  });
  memoryBlobDescription = `s3 ${s3MemoryConfig.endpoint}/${s3MemoryConfig.bucket}`;
} else {
  memoryBlobLocalDir = process.env.MEMORY_BLOB_DIR ?? "./data/memory-blobs";
  memoryBlobs = new MemoryLocalFsBlobStore({ baseDir: memoryBlobLocalDir });
  memoryBlobDescription = `localfs ${memoryBlobLocalDir}`;
}

const memoryService = createSqliteMemoryStoreService({
  db: drizzleDb,
  blobs: memoryBlobs,
});
const memoryRepo = new SqlMemoryRepo(drizzleDb);
// Memory blob watcher — wires chokidar fs events through
// packages/queue's processMemoryEvent so CF + Node share one upsert
// code path. PG mode uses the multi-replica-safe PG queue table; SQLite
// single-instance uses an in-memory queue. Set MEMORY_QUEUE=disabled to
// skip wiring and fall back to the legacy direct-call watcher.
const useQueue = (process.env.MEMORY_QUEUE ?? "auto") !== "disabled";
const memoryWatcher = memoryBlobLocalDir && useQueue
  ? await startNodeMemoryQueue({
      mode: usePostgres ? "pg" : "in-memory",
      sql: usePostgres ? sql : undefined,
      memoryRepo,
      memoryBlobs,
      memoryRoot: memoryBlobLocalDir,
    })
  : memoryBlobLocalDir
    ? startMemoryBlobWatcher({ memoryRoot: memoryBlobLocalDir, memoryRepo })
    : { stop: async () => {} };

let s3Poller: { stop: () => Promise<void> } | null = null;
if (s3MemoryConfig) {
  // memory_blob_poller_lease lives in the consolidated baseline already; no
  // separate schema bootstrap needed here.
  const replicaId = `replica_${process.pid}_${Math.floor(Math.random() * 1e9).toString(36)}`;
  const intervalSec = Number(process.env.MEMORY_S3_POLL_INTERVAL_SEC ?? 30);
  const { startS3MemoryPoller } = await import("./lib/s3-memory-poller.js");
  s3Poller = await startS3MemoryPoller({
    sql,
    sqlDialect: dialect,
    memoryRepo,
    replicaId,
    intervalMs: Math.max(5_000, intervalSec * 1000),
    s3: s3MemoryConfig,
  });
}

const outputsRoot = process.env.SESSION_OUTPUTS_DIR ?? "./data/session-outputs";
mkdirSync(outputsRoot, { recursive: true });
const sessionOutputsBackend = (() => {
  const provider = (process.env.SANDBOX_PROVIDER ?? "subprocess").toLowerCase();
  if ((provider === "daytona" || provider === "e2b") && s3MemoryConfig) {
    return {
      adapter: nodeS3OutputsAdapter({
        endpoint: s3MemoryConfig.endpoint,
        bucket: s3MemoryConfig.bucket,
        accessKeyId: s3MemoryConfig.accessKey,
        secretAccessKey: s3MemoryConfig.secretKey,
        region: s3MemoryConfig.region,
      }),
      kind: "s3",
      description: `s3 ${s3MemoryConfig.endpoint}/${s3MemoryConfig.bucket}/session-outputs`,
    };
  }
  return {
    adapter: nodeOutputsAdapter(outputsRoot),
    kind: "localfs",
    description: `localfs ${outputsRoot}`,
  };
})();

// ─── Files-store blob backend ────────────────────────────────────────
//
// Keyed off FILES_S3_* env vars; falls back to a local-FS adapter under
// FILES_BLOB_DIR (default ./data/files-blobs). The blob store backs both
// the files-store table content AND workspace_backups tar archives —
// same single store, two key prefixes.

let filesBlob: BlobStore;
let filesBlobDescription: string;
if (
  process.env.FILES_S3_ENDPOINT &&
  process.env.FILES_S3_BUCKET &&
  process.env.FILES_S3_ACCESS_KEY &&
  process.env.FILES_S3_SECRET_KEY
) {
  filesBlob = new FilesS3BlobStore({
    endpoint: process.env.FILES_S3_ENDPOINT,
    bucket: process.env.FILES_S3_BUCKET,
    accessKeyId: process.env.FILES_S3_ACCESS_KEY,
    secretAccessKey: process.env.FILES_S3_SECRET_KEY,
    region: process.env.FILES_S3_REGION ?? "us-east-1",
  });
  filesBlobDescription = `s3 ${process.env.FILES_S3_ENDPOINT}/${process.env.FILES_S3_BUCKET}`;
} else {
  const filesBlobDir = process.env.FILES_BLOB_DIR ?? "./data/files-blobs";
  mkdirSync(filesBlobDir, { recursive: true });
  filesBlob = new FilesLocalFsBlobStore({ baseDir: filesBlobDir });
  filesBlobDescription = `localfs ${filesBlobDir}`;
}

const workspaceBackups = new NodeWorkspaceBackupService({
  sql,
  blobs: filesBlob,
  maxBytes: parsePositiveIntEnv(process.env.WORKSPACE_BACKUP_MAX_BYTES),
});

const sandboxOrchestrator = new DefaultSandboxOrchestrator({
  backups: workspaceBackups,
});

function parsePositiveIntEnv(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

// ─── Hub + event log ────────────────────────────────────────────────────

function newEventLog(sessionId: string): SqlEventLog {
  return new SqlEventLog(sql, sessionId, (e) => {
    const ev = e as SessionEvent & { id?: string; processed_at?: string };
    if (!ev.id) ev.id = `sevt_${generateEventId()}`;
    if (!ev.processed_at) ev.processed_at = new Date().toISOString();
  });
}

let hub: EventStreamHub;
if (usePostgres) {
  hub = await PgEventStreamHub.create({
    dsn: dbUrl,
    fetchEventsAfter: (sid, afterSeq) => newEventLog(sid).getEventsAsync(afterSeq),
  });
} else {
  hub = new InProcessEventStreamHub();
}

// ─── Sandbox factory ────────────────────────────────────────────────────

const SANDBOX_PROVIDER_PATHS: Record<string, string> = {
  subprocess: "@open-managed-agents/sandbox/adapters/local-subprocess",
  litebox: "@open-managed-agents/sandbox/adapters/litebox",
  boxlite: "@open-managed-agents/sandbox/adapters/litebox",
  boxrun: "@open-managed-agents/sandbox/adapters/boxrun",
  daytona: "@open-managed-agents/sandbox/adapters/daytona",
  e2b: "@open-managed-agents/sandbox/adapters/e2b",
};

async function buildSandbox(
  sessionId: string,
  workdir: string,
  environment?: EnvironmentConfig | null,
): Promise<import("@open-managed-agents/sandbox").SandboxExecutor> {
  const sandboxEnv = buildSandboxEnvForEnvironment(process.env, environment);
  const provider = sandboxProviderFromEnvironment(process.env, environment);
  const path = SANDBOX_PROVIDER_PATHS[provider];
  if (!path) {
    throw new Error(
      `SANDBOX_PROVIDER=${provider} not recognized; valid: ${Object.keys(SANDBOX_PROVIDER_PATHS).join(", ")}`,
    );
  }
  const mod = (await import(path)) as {
    sandboxFactory: import("@open-managed-agents/sandbox").SandboxFactory;
  };
  return mod.sandboxFactory(
    {
      sessionId,
      workdir,
      memoryRoot: memoryBlobLocalDir ?? "",
      outputsRoot,
    },
    sandboxEnv,
  );
}

// ─── Session registry ───────────────────────────────────────────────────

const sessionRegistry = new SessionRegistry({
  sql,
  hub,
  onSessionEvent: webhookStore
    ? (tenantId, sessionId, event) => {
        void webhookStore.enqueueFor(tenantId, sessionId, event).catch(() => {});
      }
    : undefined,
  agentsService,
  memoryService,
  sandboxOrchestrator,
  newEventLog,
  buildSandbox,
  sandboxWorkdirRoot: process.env.SANDBOX_WORKDIR ?? "./data/sandboxes",
  sqlDialect: dialect,
  buildModel: async (agent, tenantId) => {
    const creds = await resolveNodeModelCredentials(agent, tenantId);
    return resolveModel(
      creds.model,
      creds.apiKey,
      creds.baseURL,
      creds.apiCompat,
      creds.customHeaders,
    );
  },
  buildTools: async (agent, sandbox, context) => {
    const creds = await resolveNodeModelCredentials(agent, context.tenantId);
    return buildTools(agent, sandbox, {
      ANTHROPIC_API_KEY: creds.apiCompat.startsWith("ant") ? creds.apiKey : undefined,
      ANTHROPIC_BASE_URL: creds.apiCompat.startsWith("ant") ? creds.baseURL : undefined,
      toMarkdown: toMarkdownProvider,
      environmentConfig: context.environment?.config as never,
      mcpBinding: nodeMcpBinding,
      tenantId: context.tenantId,
      sessionId: context.sessionId,
      // Durable wakeups (session_wakeups table + scheduler pump) — wiring
      // these unlocks the schedule/cancel_schedule/list_schedules tools,
      // which tools.ts only registers when the runtime provides the hooks.
      // Parity with SessionDO's DO-alarm implementation on CF.
      scheduleWakeup: (a) =>
        sessionWakeups.schedule({
          tenantId: context.tenantId,
          sessionId: context.sessionId,
          agentId: agent.id,
          ...a,
        }),
      cancelWakeup: (id) => sessionWakeups.cancel(context.sessionId, id),
      listWakeups: () => sessionWakeups.list(context.sessionId),
      // Ambient rules from inside the session — "set up a daily deep-research
      // run" said in chat becomes a standing agent-level rule the ambient
      // dispatcher fires as fresh sessions. next_wake_at is armed here from
      // the cron so the rule is live the moment the tool returns.
      createAmbientRule: async (a) => {
        const timezone = a.timezone?.trim() || "UTC";
        const next = new Cron(a.cron, { timezone }).nextRun();
        if (!next) throw new Error(`cron "${a.cron}" has no future occurrence`);
        const row = await ambientRulesService.create({
          tenantId: context.tenantId,
          agentId: agent.id,
          input: {
            name: a.name,
            ...(a.description ? { description: a.description } : {}),
            trigger: {
              source: "schedule",
              config: { cron: a.cron, timezone, prompt: a.prompt },
            },
            wake_mode: a.wake_mode ?? "decide",
            next_wake_at: next.toISOString(),
            created_by: `session:${context.sessionId}`,
          },
        });
        return { id: row.id, next_wake_at: row.next_wake_at };
      },
      listAmbientRules: async () => {
        const rows = await ambientRulesService.listByAgent({
          tenantId: context.tenantId,
          agentId: agent.id,
        });
        return rows.map((r) => ({
          id: r.id,
          name: r.name,
          enabled: r.enabled,
          cron: typeof r.trigger.config?.cron === "string" ? r.trigger.config.cron : undefined,
          next_wake_at: r.next_wake_at,
          wake_mode: r.wake_mode,
        }));
      },
      deleteAmbientRule: async (id) => {
        await ambientRulesService.delete({
          tenantId: context.tenantId,
          agentId: agent.id,
          ruleId: id,
        });
        return { deleted: true };
      },
    });
  },
  buildHarness: () => {
    const def = new DefaultHarness();
    const sdk = new ClaudeAgentSdkHarness({
      resolveMcpTarget: resolveNodeMcpProxyTarget,
      resolveSkills: (tenantId, refs) => skillStore.resolveRefs(tenantId, refs),
      // Setup-session support: the in-process oma_setup MCP server stages the
      // agent's refined harness in session metadata and, on finish, applies it
      // to the agent it belongs to.
      readSessionMetadata: async (tenantId, sessionId) =>
        (await sessionsService.get({ tenantId, sessionId }))?.metadata ?? null,
      patchSessionMetadata: async (tenantId, sessionId, patch) => {
        await sessionsService.update({ tenantId, sessionId, metadata: patch });
      },
      updateAgent: async (tenantId, agentId, patch) => {
        return await agentsService.update({ tenantId, agentId, input: patch });
      },
    });
    return {
      run: (ctx: unknown) => {
        const c = ctx as HarnessContext;
        // Per-agent harness wins; OMA_DEFAULT_HARNESS covers agents that
        // never set one (e.g. console quick-create flows).
        const harness = c.agent?.harness ?? process.env.OMA_DEFAULT_HARNESS;
        if (harness === "claude-agent-sdk") {
          // Hard gate: this harness spawns Claude Code ON THE HOST with
          // tool permissions bypassed — single-operator/self-host only.
          // A hosted multi-tenant deploy must never route tenants here,
          // so it's opt-in via env rather than reachable by agent config.
          if (process.env.OMA_ENABLE_CLAUDE_AGENT_SDK !== "1") {
            const msg =
              "claude-agent-sdk harness is disabled on this deployment — " +
              "it runs Claude Code on the host and is intended for " +
              "single-operator self-hosting. Set OMA_ENABLE_CLAUDE_AGENT_SDK=1 to enable.";
            c.runtime.broadcast({ type: "session.error", error: msg } as SessionEvent);
            return Promise.reject(new Error(msg));
          }
          return sdk.run(c);
        }
        return def.run(c);
      },
    };
  },
  buildHarnessContext: async (input) => {
    const creds = await resolveNodeModelCredentials(input.agent, input.tenantId);
    const runtime = new NodeHarnessRuntime({
      sessionId: input.sessionId,
      log: input.eventLog,
      hub,
      sandbox: input.sandbox,
    });
    await runtime.refreshHistory();
    const rawSystemPrompt = input.agent.system ?? "";
    const memoryContext = await buildNodeMemoryPromptContext(input.tenantId, input.sessionId);
    return {
      agent: input.agent,
      userMessage: input.userMessage,
      session_id: input.sessionId,
      tenant_id: input.tenantId,
      tools: input.tools as HarnessContext["tools"],
      model: input.model,
      systemPrompt: composeSystemPrompt(rawSystemPrompt, memoryContext.reminders),
      rawSystemPrompt,
      platformReminders: memoryContext.reminders,
      env: {
        ANTHROPIC_API_KEY: creds.apiKey,
        ANTHROPIC_BASE_URL: creds.apiCompat.startsWith("ant") ? creds.baseURL : undefined,
        memoryStoreIds: memoryContext.storeIds,
      },
      runtime,
    } satisfies HarnessContext;
  },
});

const sessionWorkQueue = new NodeSessionWorkQueue({
  sql,
  dialect,
  run: async (item) => {
    const entry = await sessionRegistry.getOrCreate(item.sessionId, item.tenantId);
    await entry.machine.runHarnessTurn(item.agentId, item.event);
  },
  onError: async (item, err) => {
    const log = newEventLog(item.sessionId);
    await log.appendAsync({
      type: "session.error",
      error: "harness_turn_failed",
      message: err instanceof Error ? err.message : String(err),
      work_item_id: item.id,
    } as unknown as SessionEvent);
    const stored = await log.getEventsAsync();
    const last = stored[stored.length - 1];
    if (last) hub.publish(item.sessionId, last);
  },
});
await sessionWorkQueue.ensureSchema();

// Durable session wakeups — fired by the scheduler's session-wakeups job;
// synthetic user.message events flow through the same work queue as real
// ones so turn ordering and crash recovery hold.
const sessionWakeups = new NodeSessionWakeups({
  sql,
  dialect,
  enqueue: async (item) => {
    await sessionWorkQueue.enqueue(item);
    void sessionWorkQueue.wake(item.sessionId);
  },
  persistEvent: async (sessionId, event) => {
    const log = newEventLog(sessionId);
    await log.appendAsync(event);
    const stored = await log.getEventsAsync();
    const last = stored[stored.length - 1];
    if (last) hub.publish(sessionId, last);
  },
  hasEvent: async (sessionId, eventId) => {
    const stored = await newEventLog(sessionId).getEventsAsync();
    return stored.some((e) => (e as { id?: string }).id === eventId);
  },
});
await sessionWakeups.ensureSchema();

await sessionRegistry.bootstrap();
void sessionWorkQueue.wakeAll().catch((err) => {
  logger.error({ err, op: "session_work_queue.bootstrap_failed" }, "session work queue bootstrap failed");
});

// ─── Services bundle ────────────────────────────────────────────────────

const kv = new SqlKvStore({ db: drizzleDb, tenantId: "default" });

const services: RouteServices = {
  sql,
  agents: agentsService,
  ambientRules: ambientRulesService,
  vaults: vaultService,
  credentials: credentialService,
  memory: memoryService,
  sessions: sessionsService,
  kv,
  newEventLog,
  hub: {
    publish: (sid, ev) => hub.publish(sid, ev as SessionEvent),
    attach: (sid, writer) => hub.attach(sid, writer),
  },
  sessionRegistry: {
    enqueueUserMessage: (sid, tenantId, agentId, ev) => {
      // Auto-title on first message — "Untitled" rows are unscannable in
      // session lists. Best-effort; never blocks the turn.
      void (async () => {
        const s = await sessionsService.get({ tenantId, sessionId: sid }).catch(() => null);
        if (!s || s.title) return;
        const text = ((ev as { content?: Array<{ type?: string; text?: string }> }).content ?? [])
          .map((b) => (b?.type === "text" ? (b.text ?? "") : ""))
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        if (!text) return;
        const title = text.length > 48 ? `${text.slice(0, 48).trimEnd()}…` : text;
        await sessionsService.update({ tenantId, sessionId: sid, title }).catch(() => {});
      })();
      void sessionWorkQueue
        .enqueue({
          tenantId,
          sessionId: sid,
          agentId,
          event: ev as import("@open-managed-agents/shared").UserMessageEvent,
        })
        .then(() => sessionWorkQueue.wake(sid))
        .catch((err) => {
          logger.error(
            { err, op: "session.work_queue.failed", session_id: sid, agent_id: agentId },
            "session work queue failed",
          );
          void newEventLog(sid).appendAsync({
            type: "session.error",
            error: "harness_turn_failed",
            message: err instanceof Error ? err.message : String(err),
          } as unknown as SessionEvent);
        });
    },
    interrupt: (sid) => {
      sessionRegistry.interrupt?.(sid);
    },
  },
  background: {
    run: (p) => {
      void p.catch((err) =>
        logger.error({ err, op: "main-node.background.failed" }, "background task failed"),
      );
    },
  },
  outputsRoot,
  logger,
  metrics,
  tracer,
};

// ─── API key storage (SQL) ──────────────────────────────────────────────

const apiKeyStorage: ApiKeyStorage = {
  async insert({ id, hash, prefix, record }) {
    await sql
      .prepare(
        `INSERT INTO api_keys (id, tenant_id, user_id, name, prefix, hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        record.tenant_id,
        record.user_id ?? null,
        record.name,
        prefix,
        hash,
        Date.parse(record.created_at),
      )
      .run();
  },
  async listByTenant(tenantId) {
    const r = await sql
      .prepare(
        `SELECT id, name, prefix, created_at FROM api_keys
          WHERE tenant_id = ? AND revoked_at IS NULL
          ORDER BY created_at DESC`,
      )
      .bind(tenantId)
      .all<{ id: string; name: string; prefix: string; created_at: number }>();
    return (r.results ?? []).map<ApiKeyMeta>((row) => ({
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      created_at: new Date(row.created_at).toISOString(),
    }));
  },
  async findByHash(hash) {
    const row = await sql
      .prepare(
        `SELECT id, tenant_id, user_id, name, created_at FROM api_keys
          WHERE hash = ? AND revoked_at IS NULL`,
      )
      .bind(hash)
      .first<{
        id: string;
        tenant_id: string;
        user_id: string | null;
        name: string;
        created_at: number;
      }>();
    if (!row) return null;
    const rec: ApiKeyRecord = {
      id: row.id,
      tenant_id: row.tenant_id,
      ...(row.user_id ? { user_id: row.user_id } : {}),
      name: row.name,
      created_at: new Date(row.created_at).toISOString(),
    };
    return rec;
  },
  async deleteById(tenantId, id) {
    const r = await sql
      .prepare(
        `UPDATE api_keys SET revoked_at = ? WHERE tenant_id = ? AND id = ? AND revoked_at IS NULL`,
      )
      .bind(Date.now(), tenantId, id)
      .run();
    return (r.meta?.changes ?? 0) > 0;
  },
};

// ─── HTTP ───────────────────────────────────────────────────────────────

const app = new Hono<{
  Variables: { tenant_id: string; user_id?: string };
}>();

// Observability middleware first so it captures auth failures, rate-limit
// rejects, and unhandled exceptions. Mirrors apps/main's CF wiring.
app.use("*", requestMetrics({ recorder: metrics }));
app.use("*", tracerMiddleware({ tracer }));

// Prometheus scrape endpoint. When METRICS_BIND_TOKEN is set, callers must
// pass it in `x-metrics-token`; absent, the endpoint is open on the same
// port (acceptable for self-host single-operator deploys, documented in
// .env.example). For prod, ops should either set the token or front the
// app with a reverse proxy that filters /metrics.
const metricsToken = process.env.METRICS_BIND_TOKEN;
app.get("/metrics", async (c) => {
  if (metricsToken && c.req.header("x-metrics-token") !== metricsToken) {
    return c.text("forbidden", 403);
  }
  const text = await metrics.getPromText();
  return new Response(text, {
    headers: { "Content-Type": metrics.promContentType() },
  });
});

app.get("/health", (c) =>
  c.json({
    status: "ok",
    runtime: "node",
    pid: process.pid,
    uptime_s: Math.round(process.uptime()),
    auth: authDisabled
      ? "disabled"
      : usePostgres
        ? "better-auth-pg"
        : "better-auth-sqlite",
    backends: {
      agents: dialect,
      events: dialect,
      hub: usePostgres ? "pg-notify" : "in-process",
      memory_blobs: memoryBlobDescription,
      db: backendDescription,
    },
  }),
);

app.get("/auth-info", (c) =>
  c.json({
    auth_disabled: authDisabled,
    providers: authDisabled
      ? []
      : clerkOnly
        ? ["clerk"]
        : [
            "email",
            ...(process.env.AUTH_REQUIRE_EMAIL_VERIFY === "1" ? ["email-otp"] : []),
            ...(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
              ? ["google"]
              : []),
            ...(process.env.GITHUB_AUTH_CLIENT_ID && process.env.GITHUB_AUTH_CLIENT_SECRET
              ? ["github"]
              : []),
            ...(clerkConfig ? ["clerk"] : []),
          ],
    turnstile_site_key: null,
  }),
);

if (authDisabled) {
  app.on(["GET", "POST"], "/auth/get-session", (c) => c.json(null));
}

if (auth) {
  app.on(["GET", "POST"], "/auth/*", (c) => auth!.handler(c.req.raw));
}

// Clerk webhooks (user sync + billing) — public route on the root app
// (svix signature IS the auth; the v1 auth middleware never sees this).
if (clerkConfig && clerkStore) {
  app.post("/clerk/webhook", async (c) => {
    const rawBody = await c.req.text();
    const result = await handleClerkWebhook({
      config: clerkConfig,
      store: clerkStore,
      rawBody,
      headers: {
        svixId: c.req.header("svix-id"),
        svixTimestamp: c.req.header("svix-timestamp"),
        svixSignature: c.req.header("svix-signature"),
      },
    });
    return c.json(result.body, result.status as 200);
  });
}

// Auth middleware via packages/auth — same five-priority resolution as
// apps/main on CF.
const authMw = buildAuthMw({
  disabled: authDisabled,
  bypassPath: (path) => path === "/health" || path.startsWith("/auth/"),
  resolveSession: async (headers) => {
    if (auth) {
      const session = (await auth.api.getSession({ headers })) as
        | { user?: { id: string; email?: string | null; name?: string | null } }
        | null;
      if (session?.user) {
        return {
          userId: session.user.id,
          email: session.user.email ?? null,
          name: session.user.name ?? null,
        };
      }
    }
    // Clerk session JWT — `Authorization: Bearer <token>` (API keys use
    // the x-api-key header, so there's no collision on Bearer).
    if (clerkVerifier && clerkStore) {
      const authz = headers.get("authorization") ?? "";
      const token = authz.startsWith("Bearer ") ? authz.slice("Bearer ".length).trim() : "";
      if (token) {
        try {
          const verified = await clerkVerifier.verify(token);
          let row = await clerkStore.getByClerkId(verified.userId);
          if (!row) {
            // JIT provision when the user.created webhook hasn't landed
            // yet (or isn't configured): tenant + membership + clerk_users
            // row keyed by the Clerk user id. The webhook enriches later.
            row = await clerkStore.upsertUser({ id: verified.userId });
          }
          // Claims are authoritative only when the token actually carries
          // billing claims — absent pla/fea must not clobber webhook state.
          if (
            row &&
            verified.hasBillingClaims &&
            row.plan !== verified.entitlements.plan
          ) {
            await clerkStore.syncEntitlementsFromClaims(verified.userId, verified.entitlements);
          }
          // Active organization → route to the org's tenant (validated
          // against membership by the middleware before it takes effect).
          let tenantHint: string | null = null;
          if (verified.orgId) {
            const org = await clerkStore.getOrg(verified.orgId);
            if (org?.tenant_id && !org.deleted_at) tenantHint = org.tenant_id;
          }
          return {
            userId: verified.userId,
            email: row?.email ?? null,
            name: row?.name ?? null,
            tenantHint,
          };
        } catch (err) {
          logger.debug?.({ err, op: "main-node.clerk.verify_failed" }, "clerk token rejected");
          return null;
        }
      }
    }
    return null;
  },
  resolveApiKey: async (apiKey) => {
    const hash = await sha256Hex(apiKey);
    const rec = await apiKeyStorage.findByHash(hash);
    if (!rec) return null;
    return { tenantId: rec.tenant_id, userId: rec.user_id };
  },
  defaultTenantForUser: async (userId) => {
    const row = await sql
      .prepare(
        `SELECT tenant_id FROM membership WHERE user_id = ? ORDER BY created_at ASC, tenant_id ASC LIMIT 1`,
      )
      .bind(userId)
      .first<{ tenant_id: string }>();
    return row?.tenant_id ?? null;
  },
  hasMembership: async (userId, tenantId) => {
    const row = await sql
      .prepare(
        `SELECT 1 AS one FROM membership WHERE user_id = ? AND tenant_id = ? LIMIT 1`,
      )
      .bind(userId, tenantId)
      .first<{ one: number }>();
    return row !== null;
  },
  ensureTenantForUser: (s) => ensureTenantSqlite(sql, s.userId, s.name, s.email),
});

const v1 = new Hono<{
  Variables: { tenant_id: string; user_id?: string };
}>();
v1.use("*", authMw);
v1.use("*", async (c, next) => {
  await ensureTenantDefaults(c.var.tenant_id);
  await next();
});

// Mount route bundles. Same paths CF uses; behavior preserved.
// Flat per-tenant agent cap (MAX_AGENTS_PER_TENANT) — interim production
// guard for every tenant until billing entitlements own limits.
const maxAgentsPerTenant = resolveMaxAgentsPerTenant();
v1.route("/agents", buildAgentRoutes({
  services,
  validateModel: validateNodeModel,
  ...(maxAgentsPerTenant
    ? { preCreateGate: buildAgentPreCreateGate({ sql, maxAgents: maxAgentsPerTenant }) }
    : {}),
}));
const sessionRouter = new NodeSessionRouter({
  sql,
  hub,
  registry: sessionRegistry,
  newEventLog,
  workQueue: sessionWorkQueue,
});
v1.route("/sessions", buildSessionRoutes({
  services,
  router: sessionRouter,
  outputs: sessionOutputsBackend.adapter,
  lifecycle: {
    ...nodeSessionLifecycle({ files: filesService, filesBlob }),
    // Clerk Billing entitlement gate: free-plan tenants get a concurrent-
    // session cap (402), paid plans pass, non-Clerk tenants fail open.
    ...(clerkConfig && clerkStore && clerkConfig.billingEnforce
      ? {
          preCreateGate: buildClerkPreCreateGate({
            store: clerkStore,
            config: clerkConfig,
            countActiveSessions: async (tenantId) => {
              const row = await sql
                .prepare(
                  `SELECT COUNT(*) AS n FROM sessions
                   WHERE tenant_id = ? AND archived_at IS NULL AND terminated_at IS NULL`,
                )
                .bind(tenantId)
                .first<{ n: number }>();
              return Number(row?.n ?? 0);
            },
          }),
        }
      : {}),
  },
  // Node sandboxes are selected by SANDBOX_PROVIDER. Environment rows still
  // carry the package/networking config and are snapshotted onto sessions.
  localRuntimeEnvId: "env-local-runtime",
  loadEnvironment: async ({ tenantId, environmentId }) => {
    const row = await environmentsService.get({ tenantId, environmentId });
    if (row) return toEnvironmentConfig(row);
    return {
      id: environmentId,
      runtime: "local",
      sandbox_template: null,
    } as unknown as import("@open-managed-agents/shared").EnvironmentConfig;
  },
}));
v1.route("/vaults", buildVaultRoutes({
  services,
  composio: {
    apiKey: process.env.COMPOSIO_API_KEY,
    // Managed-first: a tenant's pasted key (vault credential) wins over the
    // operator env fallback. Hoisted function declaration defined below.
    resolveApiKey: async (tenantId) =>
      (await resolveTenantComposioKey(tenantId))?.apiKey ?? null,
  },
}));
v1.route("/oauth", buildNodeOAuthRoutes({ services, env: process.env }));
// ── Composio key resolution ────────────────────────────────────────────────
// Managed-first: tenants paste their own Composio key in the console (stored
// as a composio_mcp vault credential — same shape the MCP proxy already
// resolves, so sessions need zero extra wiring). The operator-level
// COMPOSIO_API_KEY env var remains as a self-host convenience fallback;
// a tenant key always wins so multi-user instances stay isolated.
const COMPOSIO_TOOL_ROUTER_URL = "https://app.composio.dev/tool_router/v3/session/mcp";

async function resolveTenantComposioKey(tenantId: string): Promise<{
  apiKey: string;
  vaultId: string;
  credentialId: string;
} | null> {
  const vaults = await vaultService.list({ tenantId }).catch(() => []);
  if (vaults.length === 0) return null;
  const grouped = await credentialService
    .listByVaults({ tenantId, vaultIds: vaults.map((v) => v.id) })
    .catch(() => []);
  const candidates = grouped
    .flatMap((g) => g.credentials.map((cred) => ({ vaultId: g.vault_id, cred })))
    .filter(({ cred }) => !(cred as { archived_at?: string | null }).archived_at)
    .filter(({ cred }) => {
      const auth = (cred as { auth?: { type?: string; api_key?: string } }).auth;
      return auth?.type === "composio_mcp" && typeof auth.api_key === "string" && auth.api_key.length > 0;
    })
    .sort((a, b) => {
      // created_at is ISO on CredentialRow; tolerate epoch-ms too.
      const ts = (x: unknown) => {
        const v = (x as { created_at?: number | string }).created_at;
        return typeof v === "number" ? v : v ? Date.parse(v) : 0;
      };
      return ts(b.cred) - ts(a.cred); // newest wins — a re-pasted key replaces a stale one
    });
  const top = candidates[0];
  if (!top) return null;
  const auth = (top.cred as { auth?: { api_key?: string } }).auth;
  return {
    apiKey: auth!.api_key!,
    vaultId: top.vaultId,
    credentialId: (top.cred as { id: string }).id,
  };
}

async function composioKeyForTenant(
  tenantId: string,
): Promise<{ apiKey: string; source: "tenant" | "platform" } | null> {
  const tenant = await resolveTenantComposioKey(tenantId);
  if (tenant) return { apiKey: tenant.apiKey, source: "tenant" };
  if (process.env.COMPOSIO_API_KEY) {
    return { apiKey: process.env.COMPOSIO_API_KEY, source: "platform" };
  }
  return null;
}

v1.get("/composio/status", async (c) => {
  const key = await composioKeyForTenant(c.get("tenant_id"));
  return c.json({
    configured: !!key,
    source: key?.source ?? null,
    message: key
      ? null
      : "Connect your Composio account — paste an API key from app.composio.dev.",
  });
});
v1.put("/composio/key", async (c) => {
  const tenantId = c.get("tenant_id");
  const body = await c.req
    .json<{ api_key?: string; mcp_server_url?: string }>()
    .catch(() => null);
  const apiKey = body?.api_key?.trim();
  if (!apiKey) return c.json({ error: "api_key required" }, 400);
  const mcpServerUrl = body?.mcp_server_url?.trim() || COMPOSIO_TOOL_ROUTER_URL;
  // Validate against Composio BEFORE persisting — a typo'd key failing later
  // inside an agent session is far harder to debug than a 422 here.
  try {
    await listComposioToolkits({ apiKey }, { limit: 1 });
  } catch {
    return c.json({ error: "Composio rejected this API key — check it at app.composio.dev" }, 422);
  }
  const auth = { type: "composio_mcp", mcp_server_url: mcpServerUrl, api_key: apiKey };
  const existing = await resolveTenantComposioKey(tenantId);
  if (existing) {
    await credentialService.update({
      tenantId,
      vaultId: existing.vaultId,
      credentialId: existing.credentialId,
      auth: auth as never,
    });
    return c.json({ vault_id: existing.vaultId, credential_id: existing.credentialId, updated: true });
  }
  const vaults = await vaultService.list({ tenantId }).catch(() => []);
  let vault = vaults.find((v) => !v.archived_at && v.name === "integrations") ?? vaults.find((v) => !v.archived_at) ?? null;
  if (!vault) vault = await vaultService.create({ tenantId, name: "integrations" });
  const cred = await credentialService.create({
    tenantId,
    vaultId: vault.id,
    displayName: "Composio",
    auth: auth as never,
  });
  return c.json({ vault_id: vault.id, credential_id: cred.id, created: true }, 201);
});
v1.get("/composio/toolkits", async (c) => {
  const key = await composioKeyForTenant(c.get("tenant_id"));
  if (!key) {
    return c.json({ error: "Composio is not connected — add your API key in Apps." }, 503);
  }
  try {
    const catalog = await listComposioToolkits(
      { apiKey: key.apiKey },
      {
        search: c.req.query("q") || undefined,
        category: c.req.query("category") || undefined,
        cursor: c.req.query("cursor") || undefined,
        limit: Number.parseInt(c.req.query("limit") || "300", 10),
      },
    );
    return c.json(catalog);
  } catch (err) {
    return c.json({ error: `Failed to fetch Composio toolkits: ${(err as Error).message}` }, 502);
  }
});
v1.route("/memory_stores", buildMemoryRoutes({ services }));
v1.route("/me", buildMeRoutes({
  services,
  authDisabled,
  loadTenant: async (tenantId) => {
    const r = await sql
      .prepare(`SELECT id, name FROM "tenant" WHERE id = ?`)
      .bind(tenantId)
      .first<{ id: string; name: string }>();
    return r ?? null;
  },
  listMemberships: async (userId) => {
    const r = await sql
      .prepare(
        `SELECT t.id AS id, t.name AS name, m.role AS role, m.created_at AS created_at
           FROM "membership" m JOIN "tenant" t ON t.id = m.tenant_id
          WHERE m.user_id = ? ORDER BY m.created_at ASC, t.id ASC`,
      )
      .bind(userId)
      .all<{ id: string; name: string; role: string; created_at: number }>();
    return r.results ?? [];
  },
  hasMembership: async (userId, tenantId) => {
    const row = await sql
      .prepare(
        `SELECT 1 AS one FROM membership WHERE user_id = ? AND tenant_id = ? LIMIT 1`,
      )
      .bind(userId, tenantId)
      .first<{ one: number }>();
    return row !== null;
  },
  mintApiKey: (input) => mintApiKeyOnStorage(apiKeyStorage, input),
}));
v1.route("/tenants", buildTenantRoutes({ services }));
v1.route("/api_keys", buildApiKeyRoutes({ storage: apiKeyStorage }));
v1.route("/evals", buildEvalRoutes({
  evals: evalsService,
  agents: agentsService,
  // Node has no per-tenant cloud environments yet — leave the optional
  // dep undefined so the route accepts any environment_id without 404ing.
}));
mountNodeModelCardRoutes(v1);
mountNodeModelsRoutes(v1);
mountNodeEnvironmentRoutes(v1);
mountNodeStatsRoutes(v1);
mountNodeSandboxConfigRoutes(v1);

// Outbound webhook endpoints — thin CRUD. The signing secret is returned
// ONCE on create; receivers verify `x-oma-webhook-signature` (see
// lib/webhooks.ts verifyWebhook).
v1.get("/webhook_endpoints", async (c) => {
  if (!webhookStore) return c.json({ error: "webhooks require PLATFORM_ROOT_SECRET" }, 503);
  return c.json({ data: await webhookStore.list(c.get("tenant_id")) });
});
v1.post("/webhook_endpoints", async (c) => {
  if (!webhookStore) return c.json({ error: "webhooks require PLATFORM_ROOT_SECRET" }, 503);
  const body = await c.req.json<{ url?: string; event_types?: string[] }>().catch(() => null);
  if (!body?.url || !Array.isArray(body.event_types) || body.event_types.length === 0) {
    return c.json({ error: "url and non-empty event_types[] required" }, 400);
  }
  const bad = body.event_types.filter((t) => !WEBHOOK_EVENT_TYPES.includes(t));
  if (bad.length > 0) {
    return c.json(
      { error: `unknown event_types: ${bad.join(", ")} — valid: ${WEBHOOK_EVENT_TYPES.join(", ")}` },
      400,
    );
  }
  const { endpoint, secret } = await webhookStore.create({
    tenantId: c.get("tenant_id"),
    url: body.url,
    eventTypes: body.event_types,
  });
  return c.json({ ...endpoint, secret }, 201);
});
v1.delete("/webhook_endpoints/:id", async (c) => {
  if (!webhookStore) return c.json({ error: "webhooks require PLATFORM_ROOT_SECRET" }, 503);
  const ok = await webhookStore.delete(c.get("tenant_id"), c.req.param("id"));
  return ok ? c.body(null, 204) : c.json({ error: "not found" }, 404);
});

// Stubs for routes the console hits but main-node doesn't yet implement.
v1.get("/runtimes", (c) => {
  const runtimes: unknown[] = [];
  return c.json({ runtimes, data: runtimes });
});
// Skills — SKILL.md storage, agent-attachable, importable from GitHub.
v1.get("/skills", async (c) => c.json({ data: await skillStore.list(c.get("tenant_id")) }));
v1.post("/skills", async (c) => {
  const body = await c.req.json<{ content?: string; name?: string }>().catch(() => null);
  if (!body?.content) return c.json({ error: "content (SKILL.md text) required" }, 400);
  try {
    return c.json(await skillStore.create({ tenantId: c.get("tenant_id"), content: body.content, name: body.name }), 201);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "create failed" }, 400);
  }
});
v1.post("/skills/import", async (c) => {
  const body = await c.req.json<{ source?: string }>().catch(() => null);
  if (!body?.source) return c.json({ error: "source required (URL or owner/repo[/path])" }, 400);
  try {
    const rows = await skillStore.importFromSource(c.get("tenant_id"), body.source);
    return c.json({ imported: rows.length, data: rows }, 201);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "import failed" }, 400);
  }
});
v1.get("/skills/:id", async (c) => {
  const row = await skillStore.get(c.get("tenant_id"), c.req.param("id"));
  return row ? c.json(row) : c.json({ error: "not found" }, 404);
});
v1.delete("/skills/:id", async (c) => {
  const ok = await skillStore.delete(c.get("tenant_id"), c.req.param("id"));
  return ok ? c.body(null, 204) : c.json({ error: "not found" }, 404);
});
v1.get("/integrations/github/credentials", (c) => c.json({ data: [] }));
v1.get("/integrations/linear/credentials", (c) => c.json({ data: [] }));
v1.get("/integrations/slack/credentials", (c) => c.json({ data: [] }));

// Real integration CRUD + lookup (linear/github/slack publications,
// installations, dispatch rules). Active only when PLATFORM_ROOT_SECRET is
// set — otherwise the routes 503 with a remediation message. Install-proxy
// endpoints (start-a1 / credentials / handoff-link / personal-token) return
// 503 because the OAuth/install gateway is not yet ported to Node (P4
// follow-up); the read endpoints work standalone.
// Real integration CRUD + lookup (linear/github/slack publications,
// installations, dispatch rules). Active only when PLATFORM_ROOT_SECRET is
// set — otherwise the routes 503 with a remediation message. The
// install-proxy endpoints (start-a1 / credentials / handoff-link /
// personal-token) call into the in-process InstallBridge, mirroring the
// CF /linear/publications/* etc. wire shapes verbatim.
const integrationsInternalToken = process.env.INTEGRATIONS_INTERNAL_TOKEN ?? null;
const gatewayOrigin = process.env.GATEWAY_ORIGIN ?? process.env.PUBLIC_BASE_URL ?? "http://localhost:8787";
let installBridge: NodeInstallBridge | null = null;
if (platformRootSecret) {
  installBridge = new NodeInstallBridge({
    sql,
    db: drizzleDb,
    platformRootSecret,
    gatewayOrigin: gatewayOrigin.replace(/\/+$/, ""),
    vaults: vaultService,
    credentials: credentialService,
    sessions: sessionsService,
    agents: agentsService,
    resolveTenantId: async (userId) => {
      const row = await sql
        .prepare(
          `SELECT tenant_id FROM membership WHERE user_id = ? ORDER BY created_at ASC, tenant_id ASC LIMIT 1`,
        )
        .bind(userId)
        .first<{ tenant_id: string }>();
      return row?.tenant_id ?? null;
    },
    appendUserEvent: async (sessionId, _tenantId, _agentId, event) => {
      // Webhook → session-resume drives the same NodeSessionRouter the
      // public POST /v1/sessions/:id/events route uses, so the harness
      // wakes up via the existing event-driven runtime.
      await sessionRouter.appendEvent(sessionId, event);
    },
  });
}

if (platformRootSecret) {
  const integrationsRepoEnv: NodeReposEnv = {
    sql,
    db: drizzleDb,
    PLATFORM_ROOT_SECRET: platformRootSecret,
  };
  v1.route(
    "/integrations",
    buildIntegrationsRoutes({
      bags: () => {
        const repos = buildNodeRepos(integrationsRepoEnv);
        const slackCrypto = new WebCryptoAesGcm(platformRootSecret, "integrations.tokens");
        const slackIds = new CryptoIdGenerator();
        return {
          linear: {
            installations: repos.linearInstallations,
            publications: repos.linearPublications,
            apps: repos.apps,
            dispatchRules: repos.dispatchRules,
          },
          github: {
            installations: repos.githubInstallations,
            publications: repos.githubPublications,
            githubApps: repos.githubApps,
          },
          slack: {
            installations: new SqlSlackInstallationRepo(drizzleDb, slackCrypto, slackIds),
            publications: new SqlSlackPublicationRepo(drizzleDb, slackIds, slackCrypto),
            apps: new SqlSlackAppRepo(drizzleDb, slackCrypto, slackIds),
          },
        };
      },
      installProxy: installBridge ? bridgeAsInstallProxy(installBridge) : null,
    }),
  );
} else {
  v1.get("/integrations/github/agents/:id/publications", (c) => c.json({ data: [] }));
  v1.get("/integrations/linear/agents/:id/publications", (c) => c.json({ data: [] }));
  v1.get("/integrations/slack/agents/:id/publications", (c) => c.json({ data: [] }));
}

// ── Files API (subset of apps/main/src/routes/files.ts) ──
//
// CF mounts a richer files surface with synthesized session-output ids
// and multipart upload; Node ships the read-side equivalent so the SDK
// + console can list, download, and delete files. Uploads still go via
// POST /v1/sessions/:id/files (lifecycle.promoteSandboxFile) and the
// CF-only POST /v1/files (multipart upload from the browser) — that
// route can be ported when console upload UX needs it.
v1.get("/files", async (c) => {
  const t = c.var.tenant_id;
  const scopeId = c.req.query("scope_id") ?? undefined;
  const limitParam = c.req.query("limit");
  let requested = limitParam ? parseInt(limitParam, 10) : 100;
  if (isNaN(requested) || requested < 1) requested = 100;
  if (requested > 1000) requested = 1000;
  const rows = await filesService.list({
    tenantId: t,
    sessionId: scopeId,
    limit: requested,
  });
  return c.json({ data: rows.map(toFileRecord), has_more: false });
});
v1.get("/files/:id/content", async (c) => {
  const id = c.req.param("id");
  const t = c.var.tenant_id;
  const row = await filesService.get({ tenantId: t, fileId: id });
  if (!row) return c.json({ error: "File not found" }, 404);
  if (!row.downloadable) return c.json({ error: "This file is not downloadable" }, 403);
  const obj = await filesBlob.get(row.r2_key);
  if (!obj) return c.json({ error: "File content not found" }, 404);
  return new Response(obj.body, {
    headers: { "Content-Type": row.media_type },
  });
});
v1.get("/files/:id", async (c) => {
  const id = c.req.param("id");
  const t = c.var.tenant_id;
  const row = await filesService.get({ tenantId: t, fileId: id });
  if (!row) return c.json({ error: "File not found" }, 404);
  return c.json(toFileRecord(row));
});
v1.delete("/files/:id", async (c) => {
  try {
    const deleted = await filesService.delete({
      tenantId: c.var.tenant_id,
      fileId: c.req.param("id"),
    });
    await filesBlob.delete(deleted.r2_key).catch(() => undefined);
    return c.json({ type: "file_deleted", id: deleted.id });
  } catch (err) {
    if ((err as { code?: string }).code === "file_not_found") {
      return c.json({ error: "File not found" }, 404);
    }
    throw err;
  }
});

app.route("/v1", v1);

// /v1/oma/* mirror — same Hono sub-app mounted twice. New OMA-only
// endpoints should be added here only; the bare /v1/<resource> mounts
// stay live for back-compat with Console + CLI.
app.route("/v1/oma/me", buildMeRoutes({
  services,
  authDisabled,
  loadTenant: async (tenantId) => {
    const r = await sql
      .prepare(`SELECT id, name FROM "tenant" WHERE id = ?`)
      .bind(tenantId)
      .first<{ id: string; name: string }>();
    return r ?? null;
  },
  listMemberships: async (userId) => {
    const r = await sql
      .prepare(
        `SELECT t.id AS id, t.name AS name, m.role AS role, m.created_at AS created_at
           FROM "membership" m JOIN "tenant" t ON t.id = m.tenant_id
          WHERE m.user_id = ? ORDER BY m.created_at ASC, t.id ASC`,
      )
      .bind(userId)
      .all<{ id: string; name: string; role: string; created_at: number }>();
    return r.results ?? [];
  },
  hasMembership: async (userId, tenantId) => {
    const row = await sql
      .prepare(
        `SELECT 1 AS one FROM membership WHERE user_id = ? AND tenant_id = ? LIMIT 1`,
      )
      .bind(userId, tenantId)
      .first<{ one: number }>();
    return row !== null;
  },
  mintApiKey: (input) => mintApiKeyOnStorage(apiKeyStorage, input),
}));
app.route("/v1/oma/tenants", buildTenantRoutes({ services }));
app.route("/v1/oma/api_keys", buildApiKeyRoutes({ storage: apiKeyStorage }));
app.route("/v1/oma/evals", buildEvalRoutes({
  evals: evalsService,
  agents: agentsService,
}));

// /v1/oma/integrations mirror — same factory used twice. New OMA-only
// endpoints (if any) get added in the package, not here.
if (platformRootSecret) {
  const integrationsRepoEnvOma: NodeReposEnv = {
    sql,
    db: drizzleDb,
    PLATFORM_ROOT_SECRET: platformRootSecret,
  };
  app.route(
    "/v1/oma/integrations",
    buildIntegrationsRoutes({
      bags: () => {
        const repos = buildNodeRepos(integrationsRepoEnvOma);
        const slackCrypto = new WebCryptoAesGcm(platformRootSecret, "integrations.tokens");
        const slackIds = new CryptoIdGenerator();
        return {
          linear: {
            installations: repos.linearInstallations,
            publications: repos.linearPublications,
            apps: repos.apps,
            dispatchRules: repos.dispatchRules,
          },
          github: {
            installations: repos.githubInstallations,
            publications: repos.githubPublications,
            githubApps: repos.githubApps,
          },
          slack: {
            installations: new SqlSlackInstallationRepo(drizzleDb, slackCrypto, slackIds),
            publications: new SqlSlackPublicationRepo(drizzleDb, slackIds, slackCrypto),
            apps: new SqlSlackAppRepo(drizzleDb, slackCrypto, slackIds),
          },
        };
      },
      installProxy: installBridge ? bridgeAsInstallProxy(installBridge) : null,
    }),
  );
}

// ─── Integrations gateway (OAuth callbacks, setup pages, Linear MCP,
// GitHub internal refresh, webhooks) — mounted on `app` (NOT under /v1)
// because the upstream OAuth/webhook URLs are at /linear/oauth/...,
// /linear-setup/..., /linear/webhook/..., etc. Active only when
// PLATFORM_ROOT_SECRET is set (encryption requires it). The bridge
// constructs providers per-request off the same Container builder used
// by the read-side routes, so a write hits the same underlying tables.
if (installBridge) {
  const containers = installBridge.buildContainers();
  app.route(
    "/",
    buildIntegrationsGatewayRoutes({
      installBridge,
      jwt: containers.linear.jwt,
      webhooks: {
        linear: (req) => buildNodeProvidersForRequest(installBridge!, gatewayOrigin).linear.handleWebhook(req),
        github: (req) => buildNodeProvidersForRequest(installBridge!, gatewayOrigin).github.handleWebhook(req),
        slack: (req) => buildNodeProvidersForRequest(installBridge!, gatewayOrigin).slack.handleWebhook(req),
      },
      internalSecret: integrationsInternalToken,
      // Node has no per-tenant rate-limit binding by default; soft-pass.
      rateLimit: undefined,
    }),
  );
}

// oma-cap-adapter wire — exposes a Resolver against the in-process vault
// services so a future Node outbound proxy (mirroring CF's mcp-proxy) can
// inject cap_cli credentials into sandbox traffic. Wired here at the
// services construction site so the resolver is available even before
// the outbound surface lands.
const _capResolver = new OmaVaultResolver({
  sessions: {
    get: ({ tenantId, sessionId }) => sessionsService.get({ tenantId, sessionId }) as never,
  },
  credentials: {
    listByVaults: ({ tenantId, vaultIds }) =>
      credentialService.listByVaults({ tenantId, vaultIds }) as never,
    update: ({ tenantId, vaultId, credentialId, auth }) =>
      credentialService.update({ tenantId, vaultId, credentialId, auth }) as never,
    create: ({ tenantId, vaultId, displayName, auth }) =>
      credentialService.create({ tenantId, vaultId, displayName, auth }) as never,
  },
});
void _capResolver;

// ── Session ↔ memory_store binding (Node-specific; not in package yet) ──
v1.post("/sessions/:id/memory_stores", async (c) => {
  const sid = c.req.param("id");
  const session = await sql
    .prepare(`SELECT id FROM sessions WHERE tenant_id = ? AND id = ?`)
    .bind(c.var.tenant_id, sid)
    .first();
  if (!session) return c.json({ error: "Session not found" }, 404);
  const body = await c.req.json<{ store_id: string; access?: string }>();
  if (!body.store_id) return c.json({ error: "store_id is required" }, 400);
  const store = await memoryService.getStore({
    tenantId: c.var.tenant_id,
    storeId: body.store_id,
  });
  if (!store) return c.json({ error: "Memory store not found" }, 404);
  const access = body.access === "read_only" ? "read_only" : "read_write";
  await sql
    .prepare(
      `INSERT INTO session_memory_stores (session_id, store_id, access, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id, store_id) DO UPDATE SET access = excluded.access`,
    )
    .bind(sid, body.store_id, access, Date.now())
    .run();
  return c.json({ session_id: sid, store_id: body.store_id, access }, 201);
});
v1.get("/sessions/:id/memory_stores", async (c) => {
  const r = await sql
    .prepare(
      `SELECT store_id, access, created_at FROM session_memory_stores WHERE session_id = ?`,
    )
    .bind(c.req.param("id"))
    .all<{ store_id: string; access: string; created_at: number }>();
  return c.json({ data: r.results ?? [] });
});

// ── Console UI (optional) ──
const consoleDir = process.env.CONSOLE_DIR;
if (consoleDir) {
  const cwd = process.cwd();
  const rootRel = consoleDir.startsWith("/")
    ? relative(cwd, consoleDir)
    : consoleDir;
  app.use("/*", serveStatic({ root: rootRel }));
  app.get("/*", serveStatic({ root: rootRel, path: "index.html" }));
  logger.info({ op: "main-node.console_ui", dir: consoleDir, cwd_rel: rootRel }, "console UI served");
}

app.notFound((c) => c.json({ error: "not found" }, 404));
app.onError((err, c) => {
  logger.error({ err, op: "main-node.unhandled" }, "unhandled error");
  return c.json({ error: "internal_error", message: err.message }, 500);
});

// ─── Listen ──────────────────────────────────────────────────────────────

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "0.0.0.0";
serve({ fetch: app.fetch, port, hostname: host }, (info) => {
  logger.info(
    { op: "main-node.listening", address: info.address, port: info.port, db: backendDescription },
    `listening on http://${info.address}:${info.port}`,
  );
});

// Cron — eval-tick + memory retention sweep + (when integrations schema is
// applied) webhook-events retention. Linear dispatch is left un-wired here
// because main-node doesn't construct a LinearProvider; pass `linearSweeper`
// when an in-process gateway lands.
const ambientDispatcher = new NodeAmbientDispatcher({
  ambientRules: ambientRulesService,
  agents: agentsService,
  sessions: sessionsService,
  // Same lever the integrations bridge uses: append a user.message via
  // NodeSessionRouter so the harness runs a real turn.
  appendUserEvent: async (sessionId, _tenantId, _agentId, event) => {
    await sessionRouter.appendEvent(sessionId, event);
  },
});

const scheduler = buildNodeScheduler({
  evalServices: {
    agents: agentsService,
    environments: environmentsService,
    sessions: sessionsService,
    evals: evalsService,
    kv,
  },
  memory: memoryService,
  ambientDispatcher,
  integrationsSql: platformRootSecret ? sql : null,
  wakeups: { pump: () => sessionWakeups.pump() },
});
await scheduler.start();
logger.info({ op: "main-node.scheduler.started" }, "scheduler started");

const shutdown = async (signal: string) => {
  logger.info({ op: "main-node.shutdown", signal }, `received ${signal}, shutting down`);
  try { await scheduler.stop(); } catch (err) { logger.warn({ err, op: "main-node.shutdown.scheduler_stop_failed" }, "scheduler stop failed"); }
  try { await memoryWatcher.stop(); } catch (err) { logger.warn({ err, op: "main-node.shutdown.watcher_stop_failed" }, "memory watcher stop failed"); }
  if (s3Poller) {
    try { await s3Poller.stop(); } catch (err) { logger.warn({ err, op: "main-node.shutdown.s3_poller_stop_failed" }, "s3-poller stop failed"); }
  }
  if (hub instanceof PgEventStreamHub) {
    try { await hub.stop(); } catch (err) { logger.warn({ err, op: "main-node.shutdown.pg_hub_stop_failed" }, "pg-hub stop failed"); }
  }
  if (authShutdown) {
    try { await authShutdown(); } catch (err) { logger.warn({ err, op: "main-node.shutdown.auth_failed" }, "auth shutdown failed"); }
  }
  try { await tracer.shutdown(); } catch { /* tracer shutdown is best-effort */ }
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// ─── Helpers ─────────────────────────────────────────────────────────────

function loadDotenvDefaults(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(process.cwd(), ".env.local"),
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "../.env.local"),
    resolve(process.cwd(), "../.env"),
    resolve(process.cwd(), "../../.env.local"),
    resolve(process.cwd(), "../../.env"),
    resolve(here, "../../../.env.local"),
    resolve(here, "../../../.env"),
  ];
  for (const file of Array.from(new Set(candidates))) {
    if (!existsSync(file)) continue;
    for (const [key, value] of parseDotenv(readFileSync(file, "utf8"))) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}

function parseDotenv(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const line = trimmed.startsWith("export ") ? trimmed.slice(7).trimStart() : trimmed;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    out.push([key, parseDotenvValue(line.slice(eq + 1).trim())]);
  }
  return out;
}

function parseDotenvValue(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  const hash = value.indexOf("#");
  return (hash >= 0 ? value.slice(0, hash) : value).trim();
}

const SENSITIVE_UPSTREAM_AUTH_HEADERS = ["authorization", "x-api-key"];

type NodeMcpProxyTarget = {
  upstreamUrl: string;
  upstreamToken: string;
  upstreamAuthHeader?: { name: string; value: string };
};

const nodeMcpBinding = {
  async fetch(request: Request): Promise<Response> {
    const tenantId = request.headers.get("x-oma-tenant");
    const sessionId = request.headers.get("x-oma-session");
    const serverName = request.headers.get("x-oma-mcp-server");
    if (!tenantId || !sessionId || !serverName) {
      return Response.json(
        { error: "missing x-oma-tenant / x-oma-session / x-oma-mcp-server header" },
        { status: 400 },
      );
    }

    const target = await resolveNodeMcpProxyTarget(tenantId, sessionId, serverName);
    if (!target) return Response.json({ error: "forbidden" }, { status: 403 });

    const inboundHeaders = new Headers(request.headers);
    inboundHeaders.delete("x-oma-tenant");
    inboundHeaders.delete("x-oma-session");
    inboundHeaders.delete("x-oma-mcp-server");
    const body = ["GET", "HEAD"].includes(request.method)
      ? null
      : await request.arrayBuffer();
    return forwardNodeMcpRequest(target, request.method, inboundHeaders, body);
  },
};

async function resolveNodeMcpProxyTarget(
  tenantId: string,
  sessionId: string,
  serverName: string,
): Promise<NodeMcpProxyTarget | null> {
  const session = await sessionsService.get({ tenantId, sessionId }).catch(() => null);
  if (!session || session.archived_at) return null;

  const agent = session.agent_snapshot as AgentConfig | null | undefined;
  const server = (agent?.mcp_servers ?? []).find((s) => s.name === serverName);
  if (!server?.url) return null;

  if (server.authorization_token) {
    return { upstreamUrl: server.url, upstreamToken: server.authorization_token };
  }

  const vaultIds = session.vault_ids ?? [];
  if (vaultIds.length === 0) return null;

  const grouped = await credentialService
    .listByVaults({ tenantId, vaultIds })
    .catch(() => []);
  for (const group of grouped) {
    for (const credential of group.credentials) {
      if ((credential as { archived_at?: string | null }).archived_at) continue;
      const auth = (credential as unknown as CredentialConfig).auth as
        | {
            type?: string;
            mcp_server_url?: string;
            bearer_token?: string;
            token?: string;
            access_token?: string;
            api_key?: string;
            api_key_env?: string;
          }
        | undefined;
      if (!auth || !credentialMatchesMcpServerUrl(auth, server.url)) continue;

      if (auth.type === "composio_mcp") {
        const apiKey = resolveNodeComposioApiKey(auth);
        if (!apiKey) continue;
        return {
          upstreamUrl: auth.mcp_server_url || server.url,
          upstreamToken: apiKey,
          upstreamAuthHeader: { name: "x-api-key", value: apiKey },
        };
      }

      const token = auth.bearer_token ?? auth.token ?? auth.access_token;
      if (!token) continue;
      return { upstreamUrl: server.url, upstreamToken: token };
    }
  }
  return null;
}

function resolveNodeComposioApiKey(auth: { api_key?: string; api_key_env?: string }): string | null {
  if (typeof auth.api_key === "string" && auth.api_key.length > 0) return auth.api_key;
  const envName = auth.api_key_env || "COMPOSIO_API_KEY";
  const value = process.env[envName];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function credentialMatchesMcpServerUrl(
  auth: { type?: string; mcp_server_url?: string },
  serverUrl: string,
): boolean {
  if (!auth.mcp_server_url) return false;
  if (auth.mcp_server_url === serverUrl) return true;
  if (auth.type !== "composio_mcp") return false;
  if (isComposioMcpUrl(auth.mcp_server_url) && isComposioMcpUrl(serverUrl)) return true;
  return normalizeMcpUrlForMatch(auth.mcp_server_url) === normalizeMcpUrlForMatch(serverUrl);
}

function normalizeMcpUrlForMatch(raw: string): string | null {
  try {
    const url = new URL(raw);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    return `${url.origin}${path}`;
  } catch {
    return null;
  }
}

function isComposioMcpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    const path = url.pathname.replace(/\/+$/, "");
    if (url.hostname === "connect.composio.dev" && path === "/mcp") return true;
    return (
      (url.hostname === "app.composio.dev" || url.hostname === "backend.composio.dev") &&
      path.includes("/tool_router/") &&
      path.endsWith("/mcp")
    );
  } catch {
    return false;
  }
}

async function forwardNodeMcpRequest(
  target: NodeMcpProxyTarget,
  method: string,
  inboundHeaders: Headers,
  body: BodyInit | null,
): Promise<Response> {
  const upstreamHeaders = new Headers(inboundHeaders);
  for (const header of SENSITIVE_UPSTREAM_AUTH_HEADERS) upstreamHeaders.delete(header);
  const authHeader = target.upstreamAuthHeader ?? {
    name: "authorization",
    value: `Bearer ${target.upstreamToken}`,
  };
  upstreamHeaders.set(authHeader.name, authHeader.value);
  upstreamHeaders.delete("host");
  upstreamHeaders.delete("connection");
  upstreamHeaders.delete("content-length");
  upstreamHeaders.delete("x-forwarded-for");
  upstreamHeaders.delete("x-forwarded-proto");
  upstreamHeaders.delete("x-real-ip");

  return fetch(new Request(target.upstreamUrl, {
    method,
    headers: upstreamHeaders,
    body: ["GET", "HEAD"].includes(method) ? undefined : body,
  }));
}

function parseCustomHeaders(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  const out: Record<string, string> = {};
  for (const part of raw.split(",")) {
    const [name, ...rest] = part.split(":");
    if (!name || rest.length === 0) continue;
    out[name.trim()] = rest.join(":").trim();
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

type NodeV1App = Hono<{ Variables: { tenant_id: string; user_id?: string } }>;

function mountNodeEnvironmentRoutes(v1App: NodeV1App): void {
  v1App.post("/environments", async (c) => {
    const tenantId = c.get("tenant_id");
    const body = await c.req.json<{
      name?: string;
      description?: string;
      config?: import("@open-managed-agents/shared").EnvironmentConfig["config"];
      metadata?: Record<string, unknown>;
    }>();
    if (!body.name) return c.json({ error: "name is required" }, 400);
    const row = await environmentsService.create({
      tenantId,
      name: body.name,
      description: body.description ?? null,
      config: body.config ?? { type: "cloud" },
      metadata: body.metadata ?? null,
      status: "ready",
      sandboxWorkerName: process.env.SANDBOX_PROVIDER ?? "subprocess",
      imageStrategy: null,
    });
    return c.json(toEnvironmentConfig(row), 201);
  });

  v1App.get("/environments", async (c) => {
    const statusRaw = c.req.query("status");
    let status: "active" | "archived" | "any" | undefined;
    if (statusRaw !== undefined) {
      if (statusRaw === "active" || statusRaw === "archived" || statusRaw === "any") {
        status = statusRaw;
      } else {
        return c.json({ error: `Invalid status '${statusRaw}'` }, 400);
      }
    }
    const createdAfter = parseIsoMs(c.req.query("created_after"));
    const createdBefore = parseIsoMs(c.req.query("created_before"));
    if (createdAfter.err) return c.json({ error: createdAfter.err }, 400);
    if (createdBefore.err) return c.json({ error: createdBefore.err }, 400);
    const limitRaw = c.req.query("limit");
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
    const page = await environmentsService.listPage({
      tenantId: c.get("tenant_id"),
      status,
      cursor: c.req.query("cursor") || undefined,
      q: c.req.query("q") || undefined,
      createdAfter: createdAfter.value,
      createdBefore: createdBefore.value,
      limit,
    });
    return c.json({
      data: page.items.map(toEnvironmentConfig),
      ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}),
      has_more: !!page.nextCursor,
    });
  });

  v1App.get("/environments/:id", async (c) => {
    const row = await environmentsService.get({
      tenantId: c.get("tenant_id"),
      environmentId: c.req.param("id"),
    });
    if (!row) return c.json({ error: "Environment not found" }, 404);
    return c.json(toEnvironmentConfig(row));
  });

  v1App.on(["PUT", "POST"], "/environments/:id", async (c) => {
    const body = await c.req.json<{
      name?: string;
      description?: string;
      config?: import("@open-managed-agents/shared").EnvironmentConfig["config"];
      metadata?: Record<string, unknown>;
    }>();
    try {
      const row = await environmentsService.update({
        tenantId: c.get("tenant_id"),
        environmentId: c.req.param("id"),
        name: body.name,
        description: body.description,
        config: body.config,
        metadata: body.metadata,
      });
      return c.json(toEnvironmentConfig(row));
    } catch (err) {
      if (err instanceof EnvironmentNotFoundError) {
        return c.json({ error: "Environment not found" }, 404);
      }
      throw err;
    }
  });

  v1App.post("/environments/:id/archive", async (c) => {
    try {
      const row = await environmentsService.archive({
        tenantId: c.get("tenant_id"),
        environmentId: c.req.param("id"),
      });
      return c.json(toEnvironmentConfig(row));
    } catch (err) {
      if (err instanceof EnvironmentNotFoundError) {
        return c.json({ error: "Environment not found" }, 404);
      }
      throw err;
    }
  });

  v1App.delete("/environments/:id", async (c) => {
    try {
      await environmentsService.delete({
        tenantId: c.get("tenant_id"),
        environmentId: c.req.param("id"),
      });
      return c.json({ deleted: true });
    } catch (err) {
      if (err instanceof EnvironmentNotFoundError) {
        return c.json({ error: "Environment not found" }, 404);
      }
      throw err;
    }
  });
}

async function validateNodeModel(
  tenantId: string,
  model: string | { id: string; speed?: string },
): Promise<{ valid: boolean; error?: string }> {
  const id = typeof model === "string" ? model : model.id;
  const card = await modelCardService.findByModelId({ tenantId, modelId: id });
  if (card) return { valid: true };
  if (process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY) return { valid: true };
  return {
    valid: false,
    error: `No model card with model_id "${id}". Create a model card first.`,
  };
}

const tenantDefaultsInFlight = new Map<string, Promise<void>>();

async function ensureTenantDefaults(tenantId: string): Promise<void> {
  if (!tenantId || process.env.AUTO_SEED_TENANT_DEFAULTS === "0") return;
  if (tenantDefaultsInFlight.has(tenantId)) {
    await tenantDefaultsInFlight.get(tenantId);
    return;
  }
  const promise = seedTenantDefaults(tenantId).catch((err) => {
    tenantDefaultsInFlight.delete(tenantId);
    logger.warn(
      { err, op: "main-node.tenant_defaults.seed_failed", tenant_id: tenantId },
      "tenant defaults seed failed",
    );
  });
  tenantDefaultsInFlight.set(tenantId, promise);
  await promise;
}

async function seedTenantDefaults(tenantId: string): Promise<void> {
  const activeEnvironments = await environmentsService.listPage({
    tenantId,
    status: "active",
    limit: 1,
  });
  if (activeEnvironments.items.length === 0) {
    const provider = process.env.SANDBOX_PROVIDER ?? "subprocess";
    const providerName = provider === "daytona" ? "Daytona" : provider;
    await environmentsService.create({
      tenantId,
      name: `Default ${providerName} sandbox`,
      description: "Default sandbox environment for cloud agent sessions.",
      status: "ready",
      sandboxWorkerName: provider,
      config: {
        type: "cloud",
        sandbox: {
          provider,
          ...(process.env.SANDBOX_IMAGE ? { image: process.env.SANDBOX_IMAGE } : {}),
          ...(process.env.DAYTONA_WORKDIR ? { workdir: process.env.DAYTONA_WORKDIR } : {}),
          ...(process.env.DAYTONA_EPHEMERAL
            ? { ephemeral: parseBooleanEnv(process.env.DAYTONA_EPHEMERAL, true) }
            : {}),
          ...(process.env.DAYTONA_BOOTSTRAP_TOOLS
            ? { bootstrap_tools: parseBooleanEnv(process.env.DAYTONA_BOOTSTRAP_TOOLS, true) }
            : {}),
          ...(process.env.DAYTONA_BOOTSTRAP_APT_PACKAGES
            ? {
                bootstrap_apt_packages: process.env.DAYTONA_BOOTSTRAP_APT_PACKAGES
                  .split(",")
                  .map((item) => item.trim())
                  .filter(Boolean),
              }
            : {}),
          ...(process.env.DAYTONA_MAX_FILE_BYTES
            ? { max_file_bytes: parsePositiveIntEnv(process.env.DAYTONA_MAX_FILE_BYTES) }
            : {}),
        },
        networking: {
          type: "unrestricted",
          allow_mcp_servers: true,
          allow_package_managers: true,
        },
        resources: {
          outputs: true,
        },
      },
      metadata: {
        bootstrap_default: true,
        sandbox_provider: provider,
      },
      imageStrategy: null,
    });
  }

  const activeVaults = await vaultService.list({ tenantId, includeArchived: false });
  if (!activeVaults.some((vault) => vault.name === "Connected Apps")) {
    await vaultService.create({ tenantId, name: "Connected Apps" });
  }
}

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

async function buildNodeMemoryPromptContext(
  tenantId: string,
  sessionId: string,
): Promise<{
  storeIds: string[];
  reminders: Array<{ source: string; text: string }>;
}> {
  const attachments = new Map<string, {
    storeId: string;
    access: "read_only" | "read_write";
    instructions?: string;
  }>();

  const session = await sessionsService.get({ tenantId, sessionId }).catch(() => null);
  await addEnvironmentMemoryPromptBindings(attachments, tenantId, session?.environment_snapshot);

  {
    // Both dialects use the shared service (JSON `config` blob) since
    // migration 0002 reconciled PG session_resources with the cf-auth shape.
    const resources = await sessionsService
      .listResourcesBySession({ sessionId })
      .catch(() => []);
    for (const row of resources) {
      if (row.type !== "memory_store") continue;
      const resource = row.resource as {
        memory_store_id?: string;
        store_id?: string;
        access?: string;
        instructions?: string;
      };
      const storeId = resource.memory_store_id ?? resource.store_id;
      if (!storeId) continue;
      attachments.set(storeId, {
        storeId,
        access: resource.access === "read_only" ? "read_only" : "read_write",
        instructions:
          typeof resource.instructions === "string"
            ? resource.instructions.slice(0, 4096)
            : undefined,
      });
    }
  }

  const legacyRows = await sql
    .prepare(`SELECT store_id, access FROM session_memory_stores WHERE session_id = ?`)
    .bind(sessionId)
    .all<{ store_id: string; access: string }>()
    .catch(() => ({ results: [] }));
  for (const row of legacyRows.results ?? []) {
    if (attachments.has(row.store_id)) continue;
    attachments.set(row.store_id, {
      storeId: row.store_id,
      access: row.access === "read_only" ? "read_only" : "read_write",
    });
  }

  const reminders: Array<{ source: string; text: string }> = [];
  for (const attachment of attachments.values()) {
    const store = await memoryService.getStore({
      tenantId,
      storeId: attachment.storeId,
    });
    if (!store) continue;
    const accessLabel = attachment.access === "read_only" ? "read-only" : "read-write";
    const lines = [
      `## Memory store: ${store.name}`,
      `Mounted at /mnt/memory/${store.name}/ (${accessLabel})`,
    ];
    if (store.description) lines.push(store.description);
    if (attachment.instructions) lines.push(attachment.instructions);
    if (attachment.access === "read_only") {
      lines.push("(read-only mount - write attempts to this directory will fail)");
    }
    reminders.push({
      source: `memory:${attachment.storeId}`,
      text: lines.join("\n"),
    });
  }

  return {
    storeIds: [...attachments.keys()],
    reminders,
  };
}

async function addEnvironmentMemoryPromptBindings(
  attachments: Map<string, {
    storeId: string;
    access: "read_only" | "read_write";
    instructions?: string;
  }>,
  tenantId: string,
  environment?: EnvironmentConfig | null,
): Promise<void> {
  const refs = environmentMemoryStoreRefs(environment);
  if (refs.length === 0) return;

  let storesByName: Map<string, string> | null = null;
  for (const ref of refs) {
    let storeId = ref.storeId;
    if (!storeId && ref.name) {
      storesByName ??= await loadNodeMemoryStoresByName(tenantId);
      storeId = storesByName.get(ref.name);
    }
    if (!storeId) continue;
    attachments.set(storeId, {
      storeId,
      access: ref.access,
      ...(ref.instructions ? { instructions: ref.instructions } : {}),
    });
  }
}

async function loadNodeMemoryStoresByName(tenantId: string): Promise<Map<string, string>> {
  const stores = await memoryService.listStores({ tenantId, status: "active" });
  return new Map(stores.map((store) => [store.name, store.id]));
}

function mountNodeSandboxConfigRoutes(v1App: NodeV1App): void {
  v1App.get("/sandbox/config", (c) => {
    const s3Status = getMemoryS3Status();
    return c.json({
      provider: process.env.SANDBOX_PROVIDER ?? "subprocess",
      image: process.env.SANDBOX_IMAGE ?? null,
      daytona_api_url_configured: !!process.env.DAYTONA_API_URL,
      daytona_api_key_configured: !!process.env.DAYTONA_API_KEY,
      memory_s3_configured: s3Status.configured,
      memory_s3_missing: s3Status.missing,
      memory_s3_endpoint_host: s3Status.endpointHost,
      memory_s3_bucket: s3Status.bucket,
      memory_s3_region: s3Status.region,
      session_outputs_backend: sessionOutputsBackend.kind,
      session_outputs_backend_description: sessionOutputsBackend.description,
    });
  });

  v1App.post("/sandbox/storage-check", async (c) => {
    const provider = process.env.SANDBOX_PROVIDER ?? "subprocess";
    const checkedAt = new Date().toISOString();

    if (!s3MemoryConfig) {
      const s3Status = getMemoryS3Status();
      return c.json({
        ok: false,
        configured: false,
        provider,
        checked_at: checkedAt,
        endpoint_host: s3Status.endpointHost,
        bucket: s3Status.bucket,
        region: s3Status.region,
        missing: s3Status.missing,
        checks: {
          s3_write_read_delete: {
            ok: false,
            error: s3Status.missing.length
              ? `Missing ${s3Status.missing.join(", ")}.`
              : "S3 memory config is incomplete.",
          },
        },
      });
    }

    const startedAt = Date.now();
    const key = `_oma_healthchecks/${process.pid}-${Date.now()}-${nanoid(8)}.txt`;
    const body = JSON.stringify({
      checked_at: checkedAt,
      provider,
      bucket: s3MemoryConfig.bucket,
    });

    try {
      const put = await memoryBlobs.put(key, body, {
        actorMetadata: {
          actor_type: "system",
          actor_id: "sandbox-storage-check",
        },
      });
      if (!put) {
        throw new Error("S3 put returned no metadata");
      }
      const read = await memoryBlobs.getText(key);
      if (!read) {
        throw new Error("S3 read returned no object after successful write");
      }
      if (read.text !== body) {
        throw new Error("S3 readback did not match the probe payload");
      }
      await memoryBlobs.delete(key);
      return c.json({
        ok: true,
        configured: true,
        provider,
        checked_at: checkedAt,
        endpoint_host: safeUrlHost(s3MemoryConfig.endpoint),
        bucket: s3MemoryConfig.bucket,
        region: s3MemoryConfig.region,
        key,
        checks: {
          s3_write_read_delete: {
            ok: true,
            duration_ms: Date.now() - startedAt,
            bytes: put.size,
          },
        },
      });
    } catch (err) {
      await memoryBlobs.delete(key).catch(() => {});
      return c.json({
        ok: false,
        configured: true,
        provider,
        checked_at: checkedAt,
        endpoint_host: safeUrlHost(s3MemoryConfig.endpoint),
        bucket: s3MemoryConfig.bucket,
        region: s3MemoryConfig.region,
        key,
        checks: {
          s3_write_read_delete: {
            ok: false,
            duration_ms: Date.now() - startedAt,
            error: errorMessage(err),
          },
        },
      });
    }
  });
}

function getMemoryS3Status(): {
  configured: boolean;
  missing: string[];
  endpointHost: string | null;
  bucket: string | null;
  region: string | null;
} {
  const required = [
    "MEMORY_S3_ENDPOINT",
    "MEMORY_S3_BUCKET",
    "MEMORY_S3_ACCESS_KEY",
    "MEMORY_S3_SECRET_KEY",
  ] as const;
  const missing = required.filter((key) => !process.env[key]);
  const endpoint = process.env.MEMORY_S3_ENDPOINT ?? null;
  return {
    configured: missing.length === 0,
    missing,
    endpointHost: endpoint ? safeUrlHost(endpoint) : null,
    bucket: process.env.MEMORY_S3_BUCKET ?? null,
    region: process.env.MEMORY_S3_REGION ?? null,
  };
}

function safeUrlHost(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function mountNodeStatsRoutes(v1App: NodeV1App): void {
  v1App.get("/stats", async (c) => {
    const tenantId = c.get("tenant_id");
    const [
      agents,
      sessions,
      environments,
      vaults,
      modelCards,
      apiKeys,
    ] = await Promise.all([
      agentsService.count({ tenantId }),
      sessionsService.count({ tenantId }),
      environmentsService.count({ tenantId }),
      vaultService.count({ tenantId }),
      modelCardService.list({ tenantId }),
      apiKeyStorage.listByTenant(tenantId),
    ]);

    return c.json({
      agents,
      sessions,
      environments,
      vaults,
      skills: (await skillStore.list(tenantId)).length,
      model_cards: modelCards.filter((card) => !card.archived_at).length,
      api_keys: apiKeys.length,
    });
  });
}

function mountNodeModelCardRoutes(v1App: NodeV1App): void {
  v1App.post("/model_cards", async (c) => {
    const tenantId = c.get("tenant_id");
    const body = await c.req.json<{
      model_id?: string;
      model?: string;
      provider?: string;
      api_key?: string;
      base_url?: string;
      custom_headers?: Record<string, string>;
      is_default?: boolean;
    }>();
    if (!body.model_id || !body.provider || !body.api_key) {
      return c.json({ error: "model_id, provider, and api_key are required" }, 400);
    }
    if (!MODEL_CARD_PROVIDERS.includes(body.provider as (typeof MODEL_CARD_PROVIDERS)[number])) {
      return c.json({ error: `Invalid provider '${body.provider}'` }, 400);
    }
    try {
      const card = await modelCardService.create({
        tenantId,
        modelId: body.model_id,
        provider: body.provider,
        model: body.model || body.model_id,
        apiKey: body.api_key,
        baseUrl: body.base_url ?? null,
        customHeaders: body.custom_headers ?? null,
        makeDefault: !!body.is_default,
      });
      return c.json(toModelCardApiShape(card), 201);
    } catch (err) {
      if (err instanceof ModelCardDuplicateModelIdError) {
        return c.json({ error: err.message }, 409);
      }
      throw err;
    }
  });

  v1App.get("/model_cards", async (c) => {
    const providerRaw = c.req.query("provider");
    if (
      providerRaw !== undefined &&
      !MODEL_CARD_PROVIDERS.includes(providerRaw as (typeof MODEL_CARD_PROVIDERS)[number])
    ) {
      return c.json({ error: `Invalid provider '${providerRaw}'` }, 400);
    }
    const createdAfter = parseIsoMs(c.req.query("created_after"));
    const createdBefore = parseIsoMs(c.req.query("created_before"));
    if (createdAfter.err) return c.json({ error: createdAfter.err }, 400);
    if (createdBefore.err) return c.json({ error: createdBefore.err }, 400);
    const limitRaw = c.req.query("limit");
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
    const page = await modelCardService.listPage({
      tenantId: c.get("tenant_id"),
      limit,
      cursor: c.req.query("cursor") || c.req.query("page") || undefined,
      q: c.req.query("q") || undefined,
      provider: providerRaw,
      createdAfter: createdAfter.value,
      createdBefore: createdBefore.value,
    });
    const data = page.items
      .filter((card) => card.archived_at === null)
      .map(toModelCardApiShape);
    return page.nextCursor
      ? c.json({ data, next_page: page.nextCursor, next_cursor: page.nextCursor })
      : c.json({ data });
  });

  v1App.get("/model_cards/:id/key", async (c) => {
    const apiKey = await modelCardService.getApiKey({
      tenantId: c.get("tenant_id"),
      cardId: c.req.param("id"),
    });
    if (apiKey === null) return c.json({ error: "Key not found" }, 404);
    return c.json({ api_key: apiKey });
  });

  v1App.get("/model_cards/:id", async (c) => {
    const card = await modelCardService.get({
      tenantId: c.get("tenant_id"),
      cardId: c.req.param("id"),
    });
    if (!card) return c.json({ error: "Model card not found" }, 404);
    return c.json(toModelCardApiShape(card));
  });

  v1App.post("/model_cards/:id", async (c) => {
    const body = await c.req.json<{
      model_id?: string;
      model?: string;
      provider?: string;
      api_key?: string;
      base_url?: string | null;
      custom_headers?: Record<string, string> | null;
      is_default?: boolean;
    }>();
    try {
      const updated = await modelCardService.update({
        tenantId: c.get("tenant_id"),
        cardId: c.req.param("id"),
        modelId: body.model_id,
        model: body.model,
        provider: body.provider,
        apiKey: body.api_key,
        baseUrl: body.base_url === undefined ? undefined : (body.base_url || null),
        customHeaders: body.custom_headers === undefined ? undefined : (body.custom_headers || null),
        isDefault: body.is_default,
      });
      return c.json(toModelCardApiShape(updated));
    } catch (err) {
      if (err instanceof ModelCardNotFoundError) {
        return c.json({ error: "Model card not found" }, 404);
      }
      if (err instanceof ModelCardDuplicateModelIdError) {
        return c.json({ error: err.message }, 409);
      }
      throw err;
    }
  });

  v1App.delete("/model_cards/:id", async (c) => {
    try {
      await modelCardService.delete({
        tenantId: c.get("tenant_id"),
        cardId: c.req.param("id"),
      });
      return c.json({ type: "model_card_deleted", id: c.req.param("id") });
    } catch (err) {
      if (err instanceof ModelCardNotFoundError) {
        return c.json({ error: "Model card not found" }, 404);
      }
      throw err;
    }
  });
}

function mountNodeModelsRoutes(v1App: NodeV1App): void {
  v1App.post("/models/list", async (c) => {
    const body = await c.req.json<{ provider?: string; api_key?: string }>();
    if (!body.api_key) return c.json({ error: "api_key is required" }, 400);
    try {
      return c.json({ data: await fetchProviderModels(body.provider || "ant", body.api_key) });
    } catch (err) {
      return c.json({ error: `Failed to fetch models: ${(err as Error).message}` }, 502);
    }
  });
}

function parseIsoMs(raw: string | undefined): { value?: number; err?: string } {
  if (!raw) return {};
  const ms = Date.parse(raw);
  return Number.isNaN(ms)
    ? { err: `Invalid timestamp '${raw}'` }
    : { value: ms };
}

async function fetchProviderModels(
  provider: string,
  apiKey: string,
): Promise<Array<{ id: string; name: string }>> {
  if (provider === "oai") {
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`OpenAI API ${res.status}`);
    const data = (await res.json()) as { data?: Array<{ id: string }> };
    const chatPrefixes = ["gpt-", "o1", "o3", "o4", "chatgpt-"];
    return sortProviderModels(
      (data.data ?? [])
      .filter((m) => chatPrefixes.some((p) => m.id.startsWith(p)))
        .map((m) => ({ id: m.id, name: m.id })),
      [DEFAULT_OPENAI_MODEL, "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano"],
    );
  }
  const res = await fetch("https://api.anthropic.com/v1/models?limit=100", {
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}`);
  const data = (await res.json()) as {
    data?: Array<{ id: string; display_name?: string }>;
  };
  return sortProviderModels(
    (data.data ?? []).map((m) => ({ id: m.id, name: m.display_name || m.id })),
    [ANTHROPIC_OPUS_MODEL, DEFAULT_ANTHROPIC_MODEL, LEGACY_ANTHROPIC_OPUS_MODEL, LEGACY_ANTHROPIC_OPUS_46_MODEL],
  );
}

function sortProviderModels<T extends { id: string }>(models: T[], preferred: string[]): T[] {
  const rank = new Map(preferred.map((id, index) => [id, index]));
  return [...models].sort((a, b) => {
    const ar = rank.get(a.id);
    const br = rank.get(b.id);
    if (ar !== undefined || br !== undefined) {
      return (ar ?? Number.MAX_SAFE_INTEGER) - (br ?? Number.MAX_SAFE_INTEGER);
    }
    return a.id.localeCompare(b.id);
  });
}

function modelHandle(model: import("@open-managed-agents/shared").AgentConfig["model"]): string {
  return typeof model === "string" ? model : model.id;
}

function toModelCardApiShape(card: ModelCardRow) {
  return {
    id: card.id,
    model_id: card.model_id,
    model: card.model,
    provider: card.provider,
    api_key_preview: card.api_key_preview,
    base_url: card.base_url ?? undefined,
    custom_headers: card.custom_headers ?? undefined,
    is_default: card.is_default,
    created_at: card.created_at,
    updated_at: card.updated_at ?? undefined,
    archived_at: card.archived_at,
  };
}

type NodeModelCredentials = {
  model: string;
  apiKey: string;
  baseURL?: string;
  apiCompat: ApiCompat;
  customHeaders?: Record<string, string>;
};

function providerToCompat(provider: string): ApiCompat {
  return provider === "oai" || provider === "oai-compatible"
    ? provider
    : provider === "ant-compatible"
      ? "ant-compatible"
      : "ant";
}

async function resolveNodeModelCredentials(
  agent: import("@open-managed-agents/shared").AgentConfig,
  tenantId: string,
): Promise<NodeModelCredentials> {
  const handle = modelHandle(agent.model);
  // tenantId MUST come from the session context, never from the agent
  // object: session agent_snapshots are persisted with tenant_id stripped
  // (sessions route), so `agent.tenant_id ?? "default"` silently searched
  // the wrong tenant at turn time and no real tenant's model card was
  // ever found — the production "No model card with model_id …" bug.
  const card = await modelCardService.findByModelId({ tenantId, modelId: handle });
  if (card) {
    const apiKey = await modelCardService.getApiKey({ tenantId, cardId: card.id });
    if (!apiKey) {
      throw new Error(`Model card "${card.model_id}" has no decryptable API key`);
    }
    return {
      model: card.model,
      apiKey,
      // Cards persist '' for "no base url" — coerce to undefined so the
      // provider default (with /v1) applies instead of an empty string.
      baseURL: card.base_url || undefined,
      apiCompat: providerToCompat(card.provider),
      customHeaders: card.custom_headers ?? undefined,
    };
  }

  const looksOpenAI = /^(gpt-|o\d|chatgpt-)/i.test(handle);
  if (!looksOpenAI && process.env.ANTHROPIC_API_KEY) {
    return {
      model: handle,
      apiKey: process.env.ANTHROPIC_API_KEY,
      baseURL: process.env.ANTHROPIC_BASE_URL,
      apiCompat: "ant",
      customHeaders: parseCustomHeaders(process.env.ANTHROPIC_CUSTOM_HEADERS),
    };
  }
  if (process.env.OPENAI_API_KEY) {
    return {
      model: handle,
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL,
      apiCompat: "oai",
      customHeaders: parseCustomHeaders(process.env.OPENAI_CUSTOM_HEADERS),
    };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      model: handle,
      apiKey: process.env.ANTHROPIC_API_KEY,
      baseURL: process.env.ANTHROPIC_BASE_URL,
      apiCompat: "ant",
      customHeaders: parseCustomHeaders(process.env.ANTHROPIC_CUSTOM_HEADERS),
    };
  }
  throw new Error(
    `No model card with model_id "${handle}" and no ANTHROPIC_API_KEY or OPENAI_API_KEY fallback is configured`,
  );
}

async function seedEnvModelCard(): Promise<void> {
  const tenantId = "default";
  const hasDefault = await modelCardService.getDefault({ tenantId });
  const candidates: Array<{
    modelId: string;
    provider: "ant" | "oai";
    apiKey: string;
  }> = [];
  if (process.env.ANTHROPIC_API_KEY) {
    const anthropicModels = unique([
      process.env.ANTHROPIC_MODEL ?? DEFAULT_ANTHROPIC_MODEL,
      ANTHROPIC_OPUS_MODEL,
      LEGACY_ANTHROPIC_OPUS_MODEL,
      LEGACY_ANTHROPIC_OPUS_46_MODEL,
      DEFAULT_ANTHROPIC_MODEL,
    ]);
    for (const modelId of anthropicModels) {
      candidates.push({
        modelId,
        provider: "ant",
        apiKey: process.env.ANTHROPIC_API_KEY,
      });
    }
  }
  if (process.env.OPENAI_API_KEY) {
    candidates.push({
      modelId: process.env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL,
      provider: "oai",
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  const preferredAnthropicDefault =
    process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY
      ? process.env.ANTHROPIC_MODEL ?? DEFAULT_ANTHROPIC_MODEL
      : null;
  let defaultAssigned = !!hasDefault;
  for (const candidate of candidates) {
    const promoteOverLegacyOpenAI =
      candidate.provider === "oai" &&
      !process.env.OPENAI_MODEL &&
      hasDefault?.provider === "oai" &&
      hasDefault.model_id === LEGACY_OPENAI_MODEL &&
      candidate.modelId !== LEGACY_OPENAI_MODEL;
    const promoteAnthropicWhenOnlyAnthropicEnv =
      candidate.provider === "ant" &&
      candidate.modelId === preferredAnthropicDefault &&
      hasDefault?.provider === "oai";
    const makeDefault =
      !defaultAssigned || promoteOverLegacyOpenAI || promoteAnthropicWhenOnlyAnthropicEnv;
    const existing = await modelCardService.findByModelId({
      tenantId,
      modelId: candidate.modelId,
    });
    if (existing) {
      if (makeDefault && !existing.is_default) {
        await modelCardService.setDefault({ tenantId, cardId: existing.id });
        defaultAssigned = true;
      }
      continue;
    }
    await modelCardService.create({
      tenantId,
      modelId: candidate.modelId,
      provider: candidate.provider,
      model: candidate.modelId,
      apiKey: candidate.apiKey,
      makeDefault,
    });
    defaultAssigned = true;
  }
  await removeLegacyOpenAIEnvCard(tenantId);
}

async function removeLegacyOpenAIEnvCard(tenantId: string): Promise<void> {
  if (!process.env.OPENAI_API_KEY || process.env.OPENAI_MODEL === LEGACY_OPENAI_MODEL) return;
  const legacy = await modelCardService.findByModelId({
    tenantId,
    modelId: LEGACY_OPENAI_MODEL,
  });
  if (!legacy || legacy.is_default) return;

  const apiKey = await modelCardService.getApiKey({ tenantId, cardId: legacy.id });
  if (apiKey !== process.env.OPENAI_API_KEY) return;
  await modelCardService.delete({ tenantId, cardId: legacy.id });
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function randomFallback(): string {
  // Pre-bootstrap fallback — logger is built before BetterAuth in the
  // current ordering, so this can use the structured logger.
  logger.warn(
    { op: "main-node.auth_secret_missing" },
    "BETTER_AUTH_SECRET not set — generating per-process random secret. Sessions will not survive restart.",
  );
  return Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * In-process forwarder for the package's `installProxy` deps. Each subpath
 * (e.g. "linear/publications/start-a1") routes to bridge.startInstallation.
 * Mirrors apps/main/src/routes/integrations.ts but skips the
 * INTEGRATIONS.fetch hop.
 *
 * Linear's publication-first endpoints use distinct subpath shapes:
 *   - POST  linear/publications                       → mode='create-publication'
 *   - PATCH linear/publications/<id>/credentials      → mode='submit-credentials-pub'
 * Slack/GitHub continue using the legacy /start-a1, /credentials,
 * /handoff-link variants until they ship their own publication-first
 * refactors.
 */
function bridgeAsInstallProxy(bridge: NodeInstallBridge): InstallProxyForwarder {
  return {
    async forward({ subpath, body, method }) {
      // Linear publication-first endpoints first — they share a subpath
      // prefix with the legacy ones so order matters.
      const newPub = /^linear\/publications$/.exec(subpath);
      if (newPub && method === "POST") {
        const result = await bridge.startInstallation!({
          provider: "linear",
          mode: "create-publication",
          body: (body ?? {}) as Record<string, unknown>,
        });
        return new Response(JSON.stringify(result.body), {
          status: result.status,
          headers: { "content-type": "application/json" },
        });
      }
      const newCreds = /^linear\/publications\/([^/]+)\/credentials$/.exec(subpath);
      if (newCreds && (method === "PATCH" || method === "POST")) {
        const result = await bridge.startInstallation!({
          provider: "linear",
          mode: "submit-credentials-pub",
          body: { ...(body ?? {}), publicationId: newCreds[1] } as Record<string, unknown>,
        });
        return new Response(JSON.stringify(result.body), {
          status: result.status,
          headers: { "content-type": "application/json" },
        });
      }

      const m = /^([^/]+)\/publications\/(start-a1|credentials|handoff-link|personal-token)$/.exec(
        subpath,
      );
      if (!m) {
        return new Response(
          JSON.stringify({ error: `unsupported install proxy subpath: ${subpath}` }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      const [, provider, mode] = m;
      const result = await bridge.startInstallation!({
        provider: provider as "linear" | "github" | "slack",
        mode: mode as "start-a1" | "credentials" | "handoff-link" | "personal-token",
        body: (body ?? {}) as Record<string, unknown>,
      });
      return new Response(JSON.stringify(result.body), {
        status: result.status,
        headers: { "content-type": "application/json" },
      });
    },
  };
}

/**
 * Lightweight SqlClient shim around a better-sqlite3 Database. Used only
 * to run the better-auth schema apply against the auth db (separate
 * connection from the main SqlClient). We don't ship a full adapter — only
 * .exec() is needed.
 */
function betterSqliteAsSqlClient(
  db: import("better-sqlite3").Database,
): SqlClient {
  return {
    exec: async (s: string) => {
      db.exec(s);
    },
    prepare: () => {
      throw new Error("not implemented");
    },
    batch: async () => [],
  } as SqlClient;
}
