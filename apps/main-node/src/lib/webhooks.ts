/**
 * Outbound webhooks — notify customer backends when a session changes state.
 *
 * Anthropic-parity semantics:
 *   - Thin payloads: event type + resource ids only; receivers fetch the
 *     session via the API for content.
 *   - HMAC-signed deliveries: `x-oma-webhook-signature: t=<unix>,v1=<hex>`
 *     where v1 = HMAC-SHA256(secret, `${t}.${rawBody}`). Secret is
 *     `whsec_…`, shown once at create/rotate, stored encrypted under
 *     PLATFORM_ROOT_SECRET.
 *   - Retries with backoff; consecutive endpoint failures auto-disable at
 *     a threshold. Receivers dedupe on delivery event id (re-sent verbatim
 *     on retry). No ordering guarantee.
 *   - Webhook names are PAST-TENSE (session.status_idled) — a separate
 *     namespace from live SSE event types (session.status_idle).
 *
 * Storage follows node-session-work-queue's self-contained DDL pattern
 * (CREATE TABLE IF NOT EXISTS at construction) rather than the drizzle
 * baseline — promote to packages/db-schema when the feature graduates.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { nanoid } from "nanoid";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type { SessionEvent } from "@open-managed-agents/api-types";
import type { WebCryptoAesGcm } from "@open-managed-agents/integrations-adapters-node";

// ─── Event mapping ────────────────────────────────────────────────────────

/** SSE event type → webhook notification type (past tense). */
const WEBHOOK_EVENT_FOR: Record<string, string> = {
  "session.status_running": "session.status_run_started",
  "session.status_idle": "session.status_idled",
  "session.status_terminated": "session.status_terminated",
  "session.error": "session.errored",
};

export const WEBHOOK_EVENT_TYPES = Object.values(WEBHOOK_EVENT_FOR);

// ─── Store ────────────────────────────────────────────────────────────────

export interface WebhookEndpoint {
  id: string;
  tenant_id: string;
  url: string;
  event_types: string[];
  disabled: boolean;
  failure_count: number;
  created_at: number;
}

const MAX_ATTEMPTS = 5;
const DISABLE_AFTER_CONSECUTIVE_FAILURES = 20;
const BACKOFF_BASE_MS = 30_000;

export class WebhookStore {
  constructor(
    private readonly sql: SqlClient,
    private readonly dialect: "sqlite" | "postgres",
    private readonly crypto: WebCryptoAesGcm,
  ) {}

  async ensureSchema(): Promise<void> {
    // Epoch-ms columns MUST be bigint: on Postgres `integer` is int4 (max
    // ~2.1e9) and a Date.now() value (~1.78e12) overflows. `bigint` also
    // works on SQLite (INTEGER affinity, 64-bit), so the DDL stays dialect-
    // agnostic. Small counters/flags stay integer.
    await this.sql.exec(`CREATE TABLE IF NOT EXISTS webhook_endpoints (
      id text PRIMARY KEY,
      tenant_id text NOT NULL,
      url text NOT NULL,
      event_types text NOT NULL,
      secret_cipher text NOT NULL,
      disabled integer NOT NULL DEFAULT 0,
      failure_count integer NOT NULL DEFAULT 0,
      created_at bigint NOT NULL
    )`);
    await this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_tenant ON webhook_endpoints (tenant_id, disabled)`,
    );
    await this.sql.exec(`CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id text PRIMARY KEY,
      endpoint_id text NOT NULL,
      tenant_id text NOT NULL,
      body text NOT NULL,
      attempt integer NOT NULL DEFAULT 0,
      next_attempt_at bigint NOT NULL,
      delivered_at bigint,
      failed_at bigint,
      last_status text
    )`);
    await this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_due ON webhook_deliveries (delivered_at, failed_at, next_attempt_at)`,
    );
  }

  /** Returns the endpoint plus the plaintext secret — caller shows it ONCE. */
  async create(opts: {
    tenantId: string;
    url: string;
    eventTypes: string[];
  }): Promise<{ endpoint: WebhookEndpoint; secret: string }> {
    const id = `whk-${nanoid()}`;
    const secret = `whsec_${randomBytes(24).toString("hex")}`;
    const cipher = await this.crypto.encrypt(secret);
    const now = Date.now();
    await this.sql
      .prepare(
        `INSERT INTO webhook_endpoints (id, tenant_id, url, event_types, secret_cipher, disabled, failure_count, created_at)
         VALUES (?, ?, ?, ?, ?, 0, 0, ?)`,
      )
      .bind(id, opts.tenantId, opts.url, JSON.stringify(opts.eventTypes), cipher, now)
      .run();
    return {
      endpoint: {
        id,
        tenant_id: opts.tenantId,
        url: opts.url,
        event_types: opts.eventTypes,
        disabled: false,
        failure_count: 0,
        created_at: now,
      },
      secret,
    };
  }

  async list(tenantId: string): Promise<WebhookEndpoint[]> {
    type Row = {
      id: string;
      tenant_id: string;
      url: string;
      event_types: string;
      disabled: number;
      failure_count: number;
      created_at: number;
    };
    const res = await this.sql
      .prepare(
        `SELECT id, tenant_id, url, event_types, disabled, failure_count, created_at
         FROM webhook_endpoints WHERE tenant_id = ? ORDER BY created_at DESC`,
      )
      .bind(tenantId)
      .all<Row>();
    return (res.results ?? []).map((r) => ({
      ...r,
      event_types: JSON.parse(r.event_types) as string[],
      disabled: !!r.disabled,
    }));
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    const res = await this.sql
      .prepare(`DELETE FROM webhook_endpoints WHERE tenant_id = ? AND id = ?`)
      .bind(tenantId, id)
      .run();
    return (res.meta?.changes ?? 0) > 0;
  }

  async secretFor(endpointId: string): Promise<string | null> {
    const row = await this.sql
      .prepare(`SELECT secret_cipher FROM webhook_endpoints WHERE id = ?`)
      .bind(endpointId)
      .first<{ secret_cipher: string }>();
    if (!row) return null;
    return this.crypto.decrypt(row.secret_cipher);
  }

  /** Fan out one session event to every subscribed, enabled endpoint. */
  async enqueueFor(tenantId: string, sessionId: string, event: SessionEvent): Promise<void> {
    const webhookType = WEBHOOK_EVENT_FOR[event.type];
    if (!webhookType) return;
    const endpoints = (await this.list(tenantId)).filter(
      (e) => !e.disabled && e.event_types.includes(webhookType),
    );
    if (endpoints.length === 0) return;
    const now = Date.now();
    for (const ep of endpoints) {
      const body = JSON.stringify({
        type: "event",
        id: `event_${nanoid()}`,
        created_at: new Date(now).toISOString(),
        data: { type: webhookType, id: sessionId, tenant_id: tenantId },
      });
      await this.sql
        .prepare(
          `INSERT INTO webhook_deliveries (id, endpoint_id, tenant_id, body, attempt, next_attempt_at)
           VALUES (?, ?, ?, ?, 0, ?)`,
        )
        .bind(`whd-${nanoid()}`, ep.id, tenantId, body, now)
        .run();
    }
  }

  async claimDue(limit: number): Promise<
    Array<{ id: string; endpoint_id: string; body: string; attempt: number; url: string }>
  > {
    const res = await this.sql
      .prepare(
        `SELECT d.id, d.endpoint_id, d.body, d.attempt, e.url
         FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id
         WHERE d.delivered_at IS NULL AND d.failed_at IS NULL
           AND d.next_attempt_at <= ? AND e.disabled = 0
         ORDER BY d.next_attempt_at ASC LIMIT ${limit}`,
      )
      .bind(Date.now())
      .all<{ id: string; endpoint_id: string; body: string; attempt: number; url: string }>();
    return res.results ?? [];
  }

  async markResult(deliveryId: string, endpointId: string, ok: boolean, status: string): Promise<void> {
    const now = Date.now();
    const run = (sql: string, ...params: unknown[]) =>
      this.sql.prepare(sql).bind(...params).run();
    if (ok) {
      await run(
        `UPDATE webhook_deliveries SET delivered_at = ?, last_status = ? WHERE id = ?`,
        now, status, deliveryId,
      );
      await run(`UPDATE webhook_endpoints SET failure_count = 0 WHERE id = ?`, endpointId);
      return;
    }
    const row = await this.sql
      .prepare(`SELECT attempt FROM webhook_deliveries WHERE id = ?`)
      .bind(deliveryId)
      .first<{ attempt: number }>();
    const attempt = (row?.attempt ?? 0) + 1;
    if (attempt >= MAX_ATTEMPTS) {
      await run(
        `UPDATE webhook_deliveries SET failed_at = ?, attempt = ?, last_status = ? WHERE id = ?`,
        now, attempt, status, deliveryId,
      );
    } else {
      await run(
        `UPDATE webhook_deliveries SET attempt = ?, next_attempt_at = ?, last_status = ? WHERE id = ?`,
        attempt, now + BACKOFF_BASE_MS * 2 ** (attempt - 1), status, deliveryId,
      );
    }
    await run(
      `UPDATE webhook_endpoints SET failure_count = failure_count + 1 WHERE id = ?`,
      endpointId,
    );
    await run(
      `UPDATE webhook_endpoints SET disabled = 1 WHERE id = ? AND failure_count >= ?`,
      endpointId, DISABLE_AFTER_CONSECUTIVE_FAILURES,
    );
  }
}

// ─── Signing ──────────────────────────────────────────────────────────────

export function signWebhook(secret: string, timestampSec: number, rawBody: string): string {
  const mac = createHmac("sha256", secret).update(`${timestampSec}.${rawBody}`).digest("hex");
  return `t=${timestampSec},v1=${mac}`;
}

/** Receiver-side check (also shipped in @openma/sdk). Exported for tests. */
export function verifyWebhook(
  secret: string,
  signatureHeader: string,
  rawBody: string,
  toleranceSec = 300,
): boolean {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(signatureHeader.trim());
  if (!m) return false;
  const t = Number(m[1]);
  if (Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const expect = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return timingSafeEqual(Buffer.from(expect, "hex"), Buffer.from(m[2], "hex"));
}

// ─── SSRF guard ───────────────────────────────────────────────────────────

function isPrivateIp(ip: string): boolean {
  if (ip === "::1") return true;
  const v4 = ip.replace(/^::ffff:/, "");
  if (isIP(v4) === 4) {
    const [a, b] = v4.split(".").map(Number);
    return (
      a === 127 || a === 10 || a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  return /^f[cd]/i.test(ip) || /^fe80/i.test(ip);
}

/** Shared SSRF gate: https-only public hosts (every resolved address must be
 *  non-private). Also used by the skills import path — user-supplied URLs
 *  must never read internal services. WEBHOOKS_ALLOW_PRIVATE=1 is the local-
 *  dev escape hatch for both consumers. */
export async function publicUrlAllowed(raw: string): Promise<boolean> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  if (process.env.WEBHOOKS_ALLOW_PRIVATE === "1") return true;
  if (u.protocol !== "https:") return false;
  try {
    const addrs = await lookup(u.hostname, { all: true });
    return addrs.length > 0 && addrs.every((a) => !isPrivateIp(a.address));
  } catch {
    return false;
  }
}

// ─── Delivery poller ──────────────────────────────────────────────────────

export function startWebhookDeliveryPoller(opts: {
  store: WebhookStore;
  intervalMs?: number;
  log?: { warn: (o: object, msg: string) => void };
}): { stop: () => void } {
  const interval = opts.intervalMs ?? 5_000;
  let inFlight = false;
  const timer = setInterval(async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const due = await opts.store.claimDue(20);
      for (const d of due) {
        let ok = false;
        let status = "error";
        try {
          if (!(await publicUrlAllowed(d.url))) {
            status = "blocked_url";
          } else {
            const secret = await opts.store.secretFor(d.endpoint_id);
            if (!secret) {
              status = "missing_secret";
            } else {
              const ts = Math.floor(Date.now() / 1000);
              const res = await fetch(d.url, {
                method: "POST",
                redirect: "manual", // redirects count as failure
                headers: {
                  "content-type": "application/json",
                  "user-agent": "openma-webhooks/1.0",
                  "x-oma-webhook-signature": signWebhook(secret, ts, d.body),
                },
                body: d.body,
                signal: AbortSignal.timeout(10_000),
              });
              ok = res.status >= 200 && res.status < 300;
              status = String(res.status);
            }
          }
        } catch (err) {
          status = err instanceof Error ? err.name : "fetch_error";
        }
        await opts.store.markResult(d.id, d.endpoint_id, ok, status);
        if (!ok) opts.log?.warn({ delivery: d.id, url: d.url, status }, "webhook delivery failed");
      }
    } finally {
      inFlight = false;
    }
  }, interval);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
