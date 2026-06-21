// Deployments — publish an agent for direct frontend access.
//
// A deployment pins an agent (optionally a specific version) plus an
// environment, and mints a *publishable key* (`oma_pk_...`). Unlike tenant
// API keys (`oma_...`, full account access), a publishable key can only
// drive sessions of its one deployed agent through the public gateway:
//
//   POST /public/v1/sessions                      create a session
//   GET  /public/v1/sessions/:id                  sanitized status
//   POST /public/v1/sessions/:id/events           user.message & co. only
//   GET  /public/v1/sessions/:id/events           history
//   GET  /public/v1/sessions/:id/events/stream    SSE
//
// That makes it safe(ish) to embed in a browser frontend — the worst a
// leaked key allows is starting sessions of an agent the owner explicitly
// published, never reading other tenants' data or mutating config. The
// gateway never exposes the agent snapshot (system prompt, tool config) to
// the public client.
//
// Storage is KV (CONFIG_KV on CF, SqlKvStore on Node) — no migrations
// needed on either runtime. Two route bundles:
//   buildDeploymentRoutes  — tenant-authed management CRUD (/v1/deployments)
//   buildPublicGatewayRoutes — publishable-key-authed gateway (/public/v1)
//
// The gateway doesn't reimplement session logic: it synthesizes requests
// into the runtime's existing sessions route bundle with the deployment's
// tenant injected (same trick as apps/main's invokePackage), so create /
// events / stream behavior stays byte-identical with the private API.

import { Hono, type Context } from "hono";
import type { KvStore } from "@open-managed-agents/kv-store";
import { resolveServices, type RouteServicesArg } from "../types";

interface Vars {
  Variables: { tenant_id: string; user_id?: string };
}

interface GatewayVars {
  Variables: { tenant_id: string; deployment: DeploymentRecord };
}

// ─── Records & storage ────────────────────────────────────────────────────

export interface DeploymentRecord {
  id: string;
  tenant_id: string;
  name: string;
  agent_id: string;
  /** null → resolve the agent's latest version at session-create time. */
  agent_version: number | null;
  /** null → fall back to the agent's default environment. */
  environment_id: string | null;
  /** First 12 chars of the publishable key, for display. */
  key_prefix: string;
  /** sha256 hex of the publishable key. Never serialized to clients. */
  key_hash: string;
  /** CORS allowlist. null → `*` (publishable keys are public by design). */
  allowed_origins: string[] | null;
  disabled: boolean;
  created_at: string;
  updated_at: string;
}

/** Wire shape — record minus the key hash. */
export type PublicDeployment = Omit<DeploymentRecord, "key_hash"> & {
  type: "deployment";
};

export interface DeploymentStorage {
  insert(record: DeploymentRecord): Promise<void>;
  get(tenantId: string, id: string): Promise<DeploymentRecord | null>;
  listByTenant(tenantId: string): Promise<DeploymentRecord[]>;
  findByKeyHash(hash: string): Promise<DeploymentRecord | null>;
  update(record: DeploymentRecord, previousKeyHash?: string): Promise<void>;
  delete(tenantId: string, id: string): Promise<boolean>;
  /** Bind a session to the deployment that created it (gateway ownership). */
  bindSession(sessionId: string, deploymentId: string): Promise<void>;
  sessionBinding(sessionId: string): Promise<string | null>;
}

const REC = (id: string) => `deploy:rec:${id}`;
const KEY = (hash: string) => `deploy:key:${hash}`;
const IDX = (tenantId: string) => `deploy:idx:${tenantId}`;
const SESS = (sessionId: string) => `deploy:sess:${sessionId}`;

/** KV-backed storage — works on CF (CONFIG_KV) and Node (SqlKvStore). */
export function kvDeploymentStorage(kv: KvStore): DeploymentStorage {
  async function readIndex(tenantId: string): Promise<string[]> {
    const raw = await kv.get(IDX(tenantId));
    return raw ? (JSON.parse(raw) as string[]) : [];
  }
  return {
    async insert(record) {
      await kv.put(REC(record.id), JSON.stringify(record));
      await kv.put(KEY(record.key_hash), record.id);
      const idx = await readIndex(record.tenant_id);
      if (!idx.includes(record.id)) idx.push(record.id);
      await kv.put(IDX(record.tenant_id), JSON.stringify(idx));
    },
    async get(tenantId, id) {
      const raw = await kv.get(REC(id));
      if (!raw) return null;
      const rec = JSON.parse(raw) as DeploymentRecord;
      return rec.tenant_id === tenantId ? rec : null;
    },
    async listByTenant(tenantId) {
      const idx = await readIndex(tenantId);
      const out: DeploymentRecord[] = [];
      for (const id of idx) {
        const raw = await kv.get(REC(id));
        if (raw) out.push(JSON.parse(raw) as DeploymentRecord);
      }
      return out;
    },
    async findByKeyHash(hash) {
      const id = await kv.get(KEY(hash));
      if (!id) return null;
      const raw = await kv.get(REC(id));
      return raw ? (JSON.parse(raw) as DeploymentRecord) : null;
    },
    async update(record, previousKeyHash) {
      await kv.put(REC(record.id), JSON.stringify(record));
      if (previousKeyHash && previousKeyHash !== record.key_hash) {
        await kv.delete(KEY(previousKeyHash));
        await kv.put(KEY(record.key_hash), record.id);
      }
    },
    async delete(tenantId, id) {
      const raw = await kv.get(REC(id));
      if (!raw) return false;
      const rec = JSON.parse(raw) as DeploymentRecord;
      if (rec.tenant_id !== tenantId) return false;
      await kv.delete(REC(id));
      await kv.delete(KEY(rec.key_hash));
      const idx = await readIndex(tenantId);
      await kv.put(IDX(tenantId), JSON.stringify(idx.filter((x) => x !== id)));
      return true;
    },
    async bindSession(sessionId, deploymentId) {
      await kv.put(SESS(sessionId), deploymentId);
    },
    async sessionBinding(sessionId) {
      return kv.get(SESS(sessionId));
    },
  };
}

// ─── Key + helpers ────────────────────────────────────────────────────────

const PK_PREFIX = "oma_pk_";

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function generatePublishableKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = PK_PREFIX;
  for (const b of bytes) s += chars[b % chars.length];
  return s;
}

function toPublicDeployment(rec: DeploymentRecord): PublicDeployment {
  const { key_hash: _kh, ...rest } = rec;
  return { type: "deployment", ...rest };
}

function parseAllowedOrigins(input: unknown): string[] | null | undefined {
  if (input === undefined) return undefined;
  if (input === null) return null;
  if (!Array.isArray(input) || !input.every((o) => typeof o === "string")) {
    return undefined;
  }
  const cleaned = input.map((o) => o.trim()).filter(Boolean);
  return cleaned.length > 0 ? cleaned : null;
}

// ─── Management routes — mount under /v1/deployments (tenant-authed) ─────

export interface DeploymentRoutesDeps {
  services: RouteServicesArg;
  /** Override the KV used for deployment records; defaults to services.kv. */
  kv?: KvStore | ((c: Context) => KvStore);
}

function resolveKv(
  deps: { services: RouteServicesArg; kv?: KvStore | ((c: Context) => KvStore) },
  c: Context,
): KvStore {
  if (deps.kv) return typeof deps.kv === "function" ? deps.kv(c) : deps.kv;
  return resolveServices(deps.services, c as never).kv;
}

export function buildDeploymentRoutes(deps: DeploymentRoutesDeps) {
  const app = new Hono<Vars>();

  // POST /v1/deployments — publish an agent. Returns the key ONCE.
  app.post("/", async (c) => {
    const services = resolveServices(deps.services, c);
    const storage = kvDeploymentStorage(resolveKv(deps, c));
    const t = c.var.tenant_id;
    const body = await c.req
      .json<{
        name?: string;
        agent?: string | { id: string; version?: number };
        agent_id?: string;
        agent_version?: number;
        environment_id?: string;
        allowed_origins?: string[] | null;
      }>()
      .catch(() => null);
    if (!body) return c.json({ error: "Invalid JSON body" }, 400);

    const agentId =
      body.agent_id ??
      (typeof body.agent === "string" ? body.agent : body.agent?.id);
    if (!agentId) return c.json({ error: "agent_id is required" }, 400);
    const agentVersion =
      body.agent_version ??
      (typeof body.agent === "object" ? body.agent?.version : undefined);

    const agentRow = await services.agents.get({ tenantId: t, agentId });
    if (!agentRow) return c.json({ error: "Agent not found" }, 404);

    const key = generatePublishableKey();
    const now = new Date().toISOString();
    const rec: DeploymentRecord = {
      id: `dep_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
      tenant_id: t,
      name: body.name || agentRow.name || "Untitled deployment",
      agent_id: agentId,
      agent_version: typeof agentVersion === "number" ? agentVersion : null,
      environment_id: body.environment_id ?? null,
      key_prefix: key.slice(0, PK_PREFIX.length + 4),
      key_hash: await sha256Hex(key),
      allowed_origins: parseAllowedOrigins(body.allowed_origins) ?? null,
      disabled: false,
      created_at: now,
      updated_at: now,
    };
    await storage.insert(rec);
    return c.json({ ...toPublicDeployment(rec), key }, 201);
  });

  // GET /v1/deployments
  app.get("/", async (c) => {
    const storage = kvDeploymentStorage(resolveKv(deps, c));
    const recs = await storage.listByTenant(c.var.tenant_id);
    return c.json({ data: recs.map(toPublicDeployment) });
  });

  // GET /v1/deployments/:id
  app.get("/:id", async (c) => {
    const storage = kvDeploymentStorage(resolveKv(deps, c));
    const rec = await storage.get(c.var.tenant_id, c.req.param("id"));
    if (!rec) return c.json({ error: "Deployment not found" }, 404);
    return c.json(toPublicDeployment(rec));
  });

  // POST /v1/deployments/:id — update name / origins / pin / disable.
  app.post("/:id", async (c) => {
    const storage = kvDeploymentStorage(resolveKv(deps, c));
    const rec = await storage.get(c.var.tenant_id, c.req.param("id"));
    if (!rec) return c.json({ error: "Deployment not found" }, 404);
    const body = await c.req
      .json<{
        name?: string;
        allowed_origins?: string[] | null;
        disabled?: boolean;
        environment_id?: string | null;
        agent_version?: number | null;
      }>()
      .catch(() => null);
    if (!body) return c.json({ error: "Invalid JSON body" }, 400);

    if (typeof body.name === "string" && body.name) rec.name = body.name;
    const origins = parseAllowedOrigins(body.allowed_origins);
    if (origins !== undefined || body.allowed_origins === null) {
      rec.allowed_origins = origins ?? null;
    }
    if (typeof body.disabled === "boolean") rec.disabled = body.disabled;
    if (body.environment_id !== undefined) {
      rec.environment_id = body.environment_id;
    }
    if (body.agent_version !== undefined) {
      rec.agent_version =
        typeof body.agent_version === "number" ? body.agent_version : null;
    }
    rec.updated_at = new Date().toISOString();
    await storage.update(rec);
    return c.json(toPublicDeployment(rec));
  });

  // POST /v1/deployments/:id/rotate_key — mint a fresh key, kill the old.
  app.post("/:id/rotate_key", async (c) => {
    const storage = kvDeploymentStorage(resolveKv(deps, c));
    const rec = await storage.get(c.var.tenant_id, c.req.param("id"));
    if (!rec) return c.json({ error: "Deployment not found" }, 404);
    const previousHash = rec.key_hash;
    const key = generatePublishableKey();
    rec.key_hash = await sha256Hex(key);
    rec.key_prefix = key.slice(0, PK_PREFIX.length + 4);
    rec.updated_at = new Date().toISOString();
    await storage.update(rec, previousHash);
    return c.json({ ...toPublicDeployment(rec), key });
  });

  // DELETE /v1/deployments/:id
  app.delete("/:id", async (c) => {
    const storage = kvDeploymentStorage(resolveKv(deps, c));
    const ok = await storage.delete(c.var.tenant_id, c.req.param("id"));
    if (!ok) return c.json({ error: "Deployment not found" }, 404);
    return c.json({ type: "deployment_deleted", id: c.req.param("id") });
  });

  return app;
}

// ─── Public gateway — mount under /public/v1 (publishable-key-authed) ────

/** Minimal fetch-able shape of a Hono app (avoids generics friction). */
export interface HonoFetchable {
  fetch(req: Request, env?: unknown, ctx?: unknown): Response | Promise<Response>;
}

export interface PublicGatewayDeps {
  /** KV holding deployment records. Resolvable without tenant context —
   *  key auth happens before any tenant-scoped service exists. */
  kv: KvStore | ((c: Context) => KvStore);
  /** The runtime's sessions route bundle (or a per-request builder — may be
   *  async, e.g. CF resolves the per-tenant DB first). The gateway
   *  dispatches synthesized requests into it with the deployment's tenant
   *  injected, so session behavior matches the private API. */
  sessionsApp:
    | HonoFetchable
    | ((c: Context) => HonoFetchable | Promise<HonoFetchable>);
}

const ALLOWED_EVENT_TYPES = new Set([
  "user.message",
  "user.interrupt",
  "user.tool_confirmation",
  "user.custom_tool_result",
]);

const CORS_BASE = {
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, content-type, x-deployment-key, last-event-id",
  "Access-Control-Max-Age": "86400",
};

function corsOrigin(rec: DeploymentRecord | null, origin: string | null): string | null {
  if (!rec || !rec.allowed_origins) return "*";
  if (origin && rec.allowed_origins.includes(origin)) return origin;
  return null;
}

function withCors(res: Response, rec: DeploymentRecord | null, origin: string | null): Response {
  const allow = corsOrigin(rec, origin);
  if (!allow) return res;
  const headers = new Headers(res.headers);
  headers.set("Access-Control-Allow-Origin", allow);
  if (allow !== "*") headers.append("Vary", "Origin");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function extractKey(c: Context): string | null {
  const auth = c.req.header("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) {
    const k = auth.slice(7).trim();
    if (k.startsWith(PK_PREFIX)) return k;
  }
  const headerKey = c.req.header("x-deployment-key");
  if (headerKey?.startsWith(PK_PREFIX)) return headerKey;
  return null;
}

/** Sanitized session shape returned to public clients — never the agent
 *  snapshot (system prompt, tool config, vault refs). */
function toPublicSession(session: Record<string, unknown>) {
  return {
    type: "session",
    id: session.id,
    status: session.status,
    title: session.title ?? null,
    created_at: session.created_at,
    updated_at: session.updated_at,
  };
}

async function dispatchSessions(
  c: Context,
  deps: PublicGatewayDeps,
  init: {
    tenantId: string;
    path: string;
    method: string;
    search?: string;
    body?: string | null;
    headers?: HeadersInit;
  },
): Promise<Response> {
  const inner =
    typeof deps.sessionsApp === "function"
      ? await deps.sessionsApp(c)
      : deps.sessionsApp;
  const wrapped = new Hono();
  wrapped.use("*", async (ic, next) => {
    ic.set("tenant_id" as never, init.tenantId as never);
    await next();
  });
  wrapped.route("/", inner as never);

  const url = new URL(c.req.url);
  url.pathname = init.path;
  url.search = init.search ?? "";
  const headers = new Headers(init.headers);
  if (init.body != null && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  let executionCtx: unknown;
  try {
    executionCtx = c.executionCtx;
  } catch {
    executionCtx = undefined;
  }
  return wrapped.fetch(
    new Request(url.toString(), {
      method: init.method,
      headers,
      body: init.body ?? null,
    }),
    (c as { env?: unknown }).env,
    executionCtx as Parameters<(typeof wrapped)["fetch"]>[2],
  );
}

export function buildPublicGatewayRoutes(deps: PublicGatewayDeps) {
  const app = new Hono<GatewayVars>();

  // Preflight — no key on OPTIONS, so answer permissively; the actual
  // request gets the per-deployment origin policy.
  app.options("*", (c) => {
    const origin = c.req.header("origin");
    return new Response(null, {
      status: 204,
      headers: {
        ...CORS_BASE,
        "Access-Control-Allow-Origin": origin ?? "*",
        ...(origin ? { Vary: "Origin" } : {}),
      },
    });
  });

  // Key auth — resolves the publishable key to a deployment, injects the
  // deployment's tenant. 401s never leak whether the key exists vs disabled.
  app.use("*", async (c, next) => {
    const key = extractKey(c);
    if (!key) {
      return withCors(
        c.json(
          { error: "Missing publishable key. Pass `Authorization: Bearer oma_pk_...`." },
          401,
        ),
        null,
        c.req.header("origin") ?? null,
      );
    }
    const kv = typeof deps.kv === "function" ? deps.kv(c) : deps.kv;
    const storage = kvDeploymentStorage(kv);
    const rec = await storage.findByKeyHash(await sha256Hex(key));
    if (!rec || rec.disabled) {
      return withCors(
        c.json({ error: "Invalid publishable key" }, 401),
        null,
        c.req.header("origin") ?? null,
      );
    }
    c.set("deployment", rec);
    c.set("tenant_id", rec.tenant_id);
    await next();
  });

  // POST /sessions — start a session of the deployed agent. The client
  // controls nothing but the title; agent + environment come from the
  // deployment.
  app.post("/sessions", async (c) => {
    const dep = c.var.deployment;
    const origin = c.req.header("origin") ?? null;
    const body = await c.req
      .json<{ title?: string }>()
      .catch(() => ({}) as { title?: string });

    const createBody: Record<string, unknown> = {
      agent:
        dep.agent_version != null
          ? { id: dep.agent_id, version: dep.agent_version }
          : dep.agent_id,
    };
    if (dep.environment_id) createBody.environment_id = dep.environment_id;
    if (typeof body.title === "string" && body.title) {
      createBody.title = body.title.slice(0, 200);
    }

    const res = await dispatchSessions(c, deps, {
      tenantId: dep.tenant_id,
      path: "/",
      method: "POST",
      body: JSON.stringify(createBody),
    });
    if (!res.ok) {
      // Pass the status through but never the raw internals.
      const detail = await res.json().catch(() => ({}) as Record<string, unknown>);
      return withCors(
        c.json(
          { error: (detail as { error?: string }).error ?? "Failed to create session" },
          res.status as 400,
        ),
        dep,
        origin,
      );
    }
    const session = (await res.json()) as Record<string, unknown>;
    const kv = typeof deps.kv === "function" ? deps.kv(c) : deps.kv;
    await kvDeploymentStorage(kv).bindSession(String(session.id), dep.id);
    return withCors(c.json(toPublicSession(session), 201), dep, origin);
  });

  // Ownership gate for everything session-scoped below.
  app.use("/sessions/:id/*", ownershipGate(deps));
  app.use("/sessions/:id", ownershipGate(deps));

  // GET /sessions/:id — sanitized status.
  app.get("/sessions/:id", async (c) => {
    const dep = c.var.deployment;
    const origin = c.req.header("origin") ?? null;
    const res = await dispatchSessions(c, deps, {
      tenantId: dep.tenant_id,
      path: `/${c.req.param("id")}`,
      method: "GET",
    });
    if (!res.ok) {
      return withCors(c.json({ error: "Session not found" }, 404), dep, origin);
    }
    const session = (await res.json()) as Record<string, unknown>;
    return withCors(c.json(toPublicSession(session)), dep, origin);
  });

  // POST /sessions/:id/events — user events only, allowlisted types.
  app.post("/sessions/:id/events", async (c) => {
    const dep = c.var.deployment;
    const origin = c.req.header("origin") ?? null;
    const body = await c.req
      .json<{ events?: Array<{ type?: string }> }>()
      .catch(() => null);
    if (!body || !Array.isArray(body.events) || body.events.length === 0) {
      return withCors(
        c.json({ error: "Body must be { events: [...] }" }, 400),
        dep,
        origin,
      );
    }
    for (const ev of body.events) {
      if (!ev?.type || !ALLOWED_EVENT_TYPES.has(ev.type)) {
        return withCors(
          c.json(
            {
              error: `Event type "${ev?.type ?? "unknown"}" is not allowed through the public gateway. Allowed: ${[...ALLOWED_EVENT_TYPES].join(", ")}`,
            },
            400,
          ),
          dep,
          origin,
        );
      }
    }
    const res = await dispatchSessions(c, deps, {
      tenantId: dep.tenant_id,
      path: `/${c.req.param("id")}/events`,
      method: "POST",
      body: JSON.stringify({ events: body.events }),
    });
    return withCors(res, dep, origin);
  });

  // GET /sessions/:id/events — history (JSON).
  app.get("/sessions/:id/events", async (c) => {
    const dep = c.var.deployment;
    const url = new URL(c.req.url);
    const res = await dispatchSessions(c, deps, {
      tenantId: dep.tenant_id,
      path: `/${c.req.param("id")}/events`,
      method: "GET",
      search: url.search,
      headers: { accept: c.req.header("accept") ?? "application/json" },
    });
    return withCors(res, dep, c.req.header("origin") ?? null);
  });

  // GET /sessions/:id/events/stream — SSE passthrough.
  app.get("/sessions/:id/events/stream", async (c) => {
    const dep = c.var.deployment;
    const url = new URL(c.req.url);
    const res = await dispatchSessions(c, deps, {
      tenantId: dep.tenant_id,
      path: `/${c.req.param("id")}/events/stream`,
      method: "GET",
      search: url.search,
      headers: {
        accept: "text/event-stream",
        ...(c.req.header("last-event-id")
          ? { "last-event-id": c.req.header("last-event-id")! }
          : {}),
      },
    });
    return withCors(res, dep, c.req.header("origin") ?? null);
  });

  return app;
}

function ownershipGate(deps: PublicGatewayDeps) {
  return async (
    c: Context<GatewayVars, "/sessions/:id" | "/sessions/:id/*">,
    next: () => Promise<void>,
  ) => {
    const dep = c.var.deployment;
    const sessionId = c.req.param("id");
    const kv = typeof deps.kv === "function" ? deps.kv(c) : deps.kv;
    const binding = await kvDeploymentStorage(kv).sessionBinding(sessionId);
    if (binding !== dep.id) {
      return withCors(
        c.json({ error: "Session not found" }, 404),
        dep,
        c.req.header("origin") ?? null,
      );
    }
    await next();
  };
}
