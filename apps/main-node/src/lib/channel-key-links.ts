import { createHash, randomBytes } from "node:crypto";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type { AgentService } from "@open-managed-agents/agents-store";
import type { SessionService } from "@open-managed-agents/sessions-store";
import type { SessionRouter } from "@open-managed-agents/session-runtime";
import type { VaultService } from "@open-managed-agents/vaults-store";
import { CredentialDuplicateMcpUrlError, type CredentialRow, type CredentialService } from "@open-managed-agents/credentials-store";
import type { SessionEvent } from "@open-managed-agents/shared";
import type { Account } from "./channel-onboarding.js";
import { ensureConnectedAppsVault, findConnectedAppsVault } from "./connected-apps-vault.js";
import { credentialMatchesMcpServerUrl } from "./node-mcp-proxy.js";
import { attachGrantToAgent } from "./setup-harness.js";

/**
 * One-time API-key page for chat channels.
 *
 * A chat user cannot sign in to the console comfortably from a phone, and a
 * chat thread is no place for a key. When a `system.access_request` with
 * `auth_kind: "mcp_api_key"` is delivered to iMessage or Telegram, the
 * channel mints a link to this page. The link token is the only
 * authentication, so the page can do exactly one thing: store one
 * `static_bearer` credential for that one request, then attach it to the
 * session's agent and tell the agent, like the console's AccessRequestCard.
 *
 * Public URL shape: `<PUBLIC_BASE_URL origin>/integrations/channel-key?t=<token>`.
 * Nothing else is served under KEY_PAGE_PATH, so a reverse proxy can forward
 * just that prefix. The token travels in the query, not the path, so the
 * request tracer's `http.target` (path only) never records it.
 */
export const KEY_PAGE_PATH = "/integrations/channel-key";
export const KEY_LINK_TTL_MS = 15 * 60 * 1000;
const RATE_WINDOW_MS = 15 * 60 * 1000;
/** Per-IP failed requests, per-token requests, per-token submits, per window. */
export const KEY_PAGE_LIMITS = { ipFailures: 30, tokenRequests: 30, tokenSubmits: 5 };
const MAX_BODY = 16 * 1024;
const MIN_KEY = 8, MAX_KEY = 4096;

const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The page origin, or null when PUBLIC_BASE_URL cannot carry a key safely:
 *  https only (http for loopback development), no path, query or credentials. */
export function secureKeyOrigin(base?: string): string | null {
  if (!base) return null;
  try {
    const url = new URL(base);
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
    if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) return null;
    return url.origin;
  } catch { return null; }
}
/** Same rule for the MCP server that will receive the key as a bearer token. */
function keyTarget(raw: unknown): URL | null {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw);
    if (url.username || url.password) return null;
    if (url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname))) return url;
  } catch { /* invalid */ }
  return null;
}

export interface KeyLinkScope {
  tenantId: string;
  userId: string;
  sessionId: string;
  requestId: string;
  channel: "imessage" | "telegram";
  /** The linked channel account the link is delivered to. */
  account: Account;
}
/** What the channel core needs; ChannelKeyLinks implements it. */
export interface KeyLinkIssuer {
  /** A fresh link for one pending request, replacing any earlier one; null when not applicable. */
  mint(scope: KeyLinkScope): Promise<string | null>;
  /** A fresh link for the newest pending API-key request in a session, if any. */
  pending(scope: Omit<KeyLinkScope, "requestId">): Promise<string | null>;
  /** Finish links whose grant was recorded but not completed. */
  reconcile?(): Promise<void>;
}
export interface KeyLinkDeps {
  sql: SqlClient;
  router: Pick<SessionRouter, "getEvents" | "appendEvent">;
  sessions: Pick<SessionService, "get">;
  agents: Pick<AgentService, "get" | "update">;
  vaults: Pick<VaultService, "list" | "create" | "get">;
  credentials: Pick<CredentialService, "list" | "create" | "update">;
  hasMembership: (userId: string, tenantId: string) => Promise<boolean>;
  publicBaseUrl?: string;
  /** Structured operational log. Receives op names and IDs only, never tokens, keys or bodies. */
  log?: (op: string, fields?: Record<string, string>) => void;
}
interface Row {
  tenant_id: string; user_id: string; session_id: string; request_id: string;
  channel: string; account_hash: string; token_hash: string;
  expires_at: number; consumed: number; vault_id: string | null; credential_id: string | null; completed: number;
}
interface AccessRequest { type: string; id?: string; request_id?: string; auth_kind?: string; service?: unknown; mcp_server_url?: unknown }
type Valid = { agent: { id: string; name: string }; service: string; serverUrl: URL; mcpServerUrl: string };

const channelIdentity = (a: Account, channel: string) =>
  digest(JSON.stringify([channel, a.chat_id, channel === "telegram" ? a.telegram_user_id : a.sender_id]));

// One Node process owns channel work. Serialize mint and submit (including
// replacement instances); the conditional SQL claim also rejects concurrent claims.
let work: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = work.then(fn, fn);
  work = next.catch(() => {});
  return next;
}

const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const STYLE = ":root{color-scheme:light dark;font-family:system-ui,-apple-system,sans-serif;background:Canvas;color:CanvasText}"
  + "body{margin:0;padding:20px;line-height:1.5;font-size:17px}main{max-width:440px;margin:6vh auto}"
  + "h1{font-size:1.4rem;margin:0 0 12px}p{margin:0 0 12px}.muted{opacity:.75;font-size:.9rem}"
  + "label{display:block;font-weight:600;margin-top:16px}"
  + "input,button{box-sizing:border-box;width:100%;min-height:48px;padding:12px;font:inherit;border-radius:10px;margin:8px 0}"
  + "input{border:1px solid GrayText;background:Field;color:FieldText}"
  + "button{border:0;background:#2f5bd3;color:#fff;font-weight:600}"
  + ".error{border-left:4px solid #c62828;padding-left:10px}code{overflow-wrap:anywhere}";
function page(nonce: string, title: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><title>${escape(title)}</title><style nonce="${nonce}">${STYLE}</style></head><body><main>${body}</main></body></html>`;
}
const GENERIC = "<h1>This link can't be used</h1><p>Secure links work once and expire after 15 minutes.</p><p>Go back to your chat and ask your agent for a new secure link.</p>";

export class ChannelKeyLinks implements KeyLinkIssuer {
  constructor(private d: KeyLinkDeps) {}

  private async events(sid: string): Promise<AccessRequest[]> {
    const all: AccessRequest[] = [];
    let afterSeq = -1;
    for (;;) {
      const page = await this.d.router.getEvents(sid, { afterSeq, limit: 1000 });
      all.push(...(page.data as unknown as AccessRequest[]));
      if (!page.has_more || !page.data.length) return all;
      const next = Number((page.data.at(-1) as unknown as { seq?: number }).seq);
      if (!Number.isFinite(next) || next <= afterSeq) throw new Error("Invalid event cursor");
      afterSeq = next;
    }
  }

  /** Every check that gates both delivery and submission. Null means "not usable" with no reason. */
  private async validate(row: Pick<Row, "tenant_id" | "user_id" | "session_id" | "request_id" | "channel" | "account_hash" | "completed">): Promise<Valid | null> {
    if (row.completed) return null;
    if (row.channel !== "telegram" && row.channel !== "imessage") return null;
    if (!await this.d.hasMembership(row.user_id, row.tenant_id)) return null;
    const account = await this.d.sql.prepare(`SELECT * FROM ${row.channel}_accounts WHERE tenant_id=? AND user_id=?`)
      .bind(row.tenant_id, row.user_id).first<Account>();
    if (!account?.chat_id || channelIdentity(account, row.channel) !== row.account_hash) return null;
    const binding = await this.d.sql.prepare(`SELECT agent_id FROM (SELECT tenant_id,user_id,session_id,agent_id FROM channel_conversations
      UNION ALL SELECT tenant_id,user_id,session_id,agent_id FROM channel_conversation_drains) c WHERE tenant_id=? AND user_id=? AND session_id=?`)
      .bind(row.tenant_id, row.user_id, row.session_id).first<{ agent_id: string }>();
    if (!binding) return null;
    const session = await this.d.sessions.get({ tenantId: row.tenant_id, sessionId: row.session_id });
    if (!session || session.archived_at || (session.agent_id && session.agent_id !== binding.agent_id)) return null;
    const agent = await this.d.agents.get({ tenantId: row.tenant_id, agentId: binding.agent_id });
    if (!agent || agent.archived_at) return null;
    const events = await this.events(row.session_id);
    const request = events.find(e => e.type === "system.access_request" && e.request_id === row.request_id);
    if (!request || request.auth_kind !== "mcp_api_key" || typeof request.service !== "string" || !request.service) return null;
    const serverUrl = keyTarget(request.mcp_server_url);
    if (!serverUrl) return null;
    if (events.some(e => e.type === "system.access_granted" && e.request_id === row.request_id)) return null;
    // The exact string from the request: the credential's unique index and the console card use it verbatim.
    return { agent: { id: agent.id, name: agent.name }, service: request.service.slice(0, 100), serverUrl, mcpServerUrl: request.mcp_server_url as string };
  }

  async mint(scope: KeyLinkScope): Promise<string | null> {
    const origin = secureKeyOrigin(this.d.publicBaseUrl);
    if (!origin) return null;
    return serial(async () => {
      const ref = { tenant_id: scope.tenantId, session_id: scope.sessionId, request_id: scope.requestId };
      const prior = await this.d.sql.prepare("SELECT consumed,completed FROM channel_key_links WHERE tenant_id=? AND session_id=? AND request_id=?")
        .bind(scope.tenantId, scope.sessionId, scope.requestId).first<{ consumed: number; completed: number }>();
      // A consumed link whose grant landed but whose completion did not: finish it, no new link.
      if (prior && Number(prior.consumed) && !Number(prior.completed) && await this.finish(ref) !== "pending") return null;
      const account_hash = channelIdentity(scope.account, scope.channel);
      const candidate = { ...ref, user_id: scope.userId, channel: scope.channel, account_hash, completed: Number(prior?.completed ?? 0) };
      if (!await this.validate(candidate)) return null;
      const token = randomBytes(32).toString("base64url");
      // One row per request: a new token replaces (and so invalidates) the previous one.
      // vault_id and credential_id are kept, so a retry converges on the same credential.
      await this.d.sql.prepare(`INSERT INTO channel_key_links (tenant_id,user_id,session_id,request_id,channel,account_hash,token_hash,expires_at,consumed) VALUES (?,?,?,?,?,?,?,?,0)
        ON CONFLICT (tenant_id,session_id,request_id) DO UPDATE SET user_id=excluded.user_id,channel=excluded.channel,account_hash=excluded.account_hash,token_hash=excluded.token_hash,expires_at=excluded.expires_at,consumed=0`)
        .bind(scope.tenantId, scope.userId, scope.sessionId, scope.requestId, scope.channel, account_hash, digest(token), Date.now() + KEY_LINK_TTL_MS).run();
      this.d.log?.("channel_key.link_issued", { channel: scope.channel, session_id: scope.sessionId, request_id: scope.requestId });
      return `${origin}${KEY_PAGE_PATH}?t=${token}`;
    });
  }

  async pending(scope: Omit<KeyLinkScope, "requestId">): Promise<string | null> {
    const events = await this.events(scope.sessionId);
    const granted = new Set(events.filter(e => e.type === "system.access_granted").map(e => e.request_id));
    for (const e of events.reverse()) {
      if (e.type !== "system.access_request" || e.auth_kind !== "mcp_api_key" || !e.request_id) continue;
      if (granted.has(e.request_id)) {
        // Granted by this flow but not finished: post the owed notice now, like mint() and the tick.
        await this.settle({ tenant_id: scope.tenantId, session_id: scope.sessionId, request_id: e.request_id });
        continue;
      }
      const url = await this.mint({ ...scope, requestId: e.request_id });
      if (url) return url;
    }
    return null;
  }

  private settle(ref: RequestRef) {
    return serial(async () => {
      const row = await this.d.sql.prepare("SELECT consumed,completed FROM channel_key_links WHERE tenant_id=? AND session_id=? AND request_id=?")
        .bind(ref.tenant_id, ref.session_id, ref.request_id).first<{ consumed: number; completed: number }>();
      if (row && Number(row.consumed) && !Number(row.completed)) await this.finish(ref).catch(() => "pending");
    });
  }

  /** Finish links whose grant was recorded but whose completion was not (crash, lost
   *  response, failed notice). Called from the channel tick; idempotent. */
  async reconcile(): Promise<void> {
    await serial(async () => {
      const rows = await this.d.sql.prepare("SELECT tenant_id,session_id,request_id FROM channel_key_links WHERE consumed=1 AND completed=0 AND expires_at>?")
        .bind(Date.now() - RECONCILE_WINDOW_MS).all<RequestRef>();
      for (const row of rows.results ?? []) await this.finish(row).catch(() => "pending");
    });
  }

  /** After this flow's grant exists: post the `[access granted]` notice at most once (stable
   *  event ID), then mark the link completed. "pending" when the grant is not recorded. */
  private async finish(ref: RequestRef): Promise<"done" | "pending" | "notice_failed"> {
    let events = await this.events(ref.session_id);
    if (!events.some(e => e.type === "system.access_granted" && e.id === grantId(ref))) return "pending";
    if (!events.some(e => e.id === noticeId(ref))) {
      const request = events.find(e => e.type === "system.access_request" && e.request_id === ref.request_id);
      const service = String(request?.service ?? "app").slice(0, 100);
      const appended = await this.d.router.appendEvent(ref.session_id, {
        type: "user.message", id: noticeId(ref),
        content: [{ type: "text", text: `[access granted] The ${service} API key is saved in the vault — calls to ${String(request?.mcp_server_url ?? "")} are now authenticated automatically. Continue where you left off.` }],
      } as SessionEvent).catch(() => ({ status: 500 }));
      if (appended.status >= 400) {
        // The append may have landed even though its response was lost.
        events = await this.events(ref.session_id);
        if (!events.some(e => e.id === noticeId(ref))) return "notice_failed";
      }
    }
    await this.d.sql.prepare("UPDATE channel_key_links SET completed=1 WHERE tenant_id=? AND session_id=? AND request_id=?")
      .bind(ref.tenant_id, ref.session_id, ref.request_id).run();
    return "done";
  }

  private live(token: string | undefined) {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return Promise.resolve(null);
    return this.d.sql.prepare("SELECT * FROM channel_key_links WHERE token_hash=? AND expires_at>? AND consumed=0 AND completed=0")
      .bind(digest(token), Date.now()).first<Row>();
  }
  /** A used link whose key was stored but whose completion is unfinished. */
  private unfinished(token: string | undefined) {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return Promise.resolve(null);
    return this.d.sql.prepare("SELECT * FROM channel_key_links WHERE token_hash=? AND consumed=1 AND completed=0")
      .bind(digest(token)).first<Row>();
  }
  /** Fixed-window counter; returns the count including this hit. */
  private async hit(bucket: string): Promise<number> {
    const now = Date.now();
    await this.d.sql.prepare("DELETE FROM channel_key_attempts WHERE expires_at<=?").bind(now).run();
    await this.d.sql.prepare("INSERT INTO channel_key_attempts (bucket,expires_at,attempts) VALUES (?,?,1) ON CONFLICT (bucket) DO UPDATE SET attempts=channel_key_attempts.attempts+1")
      .bind(bucket, now + RATE_WINDOW_MS).run();
    const row = await this.d.sql.prepare("SELECT attempts FROM channel_key_attempts WHERE bucket=?").bind(bucket).first<{ attempts: number }>();
    return Number(row?.attempts ?? 0);
  }
  private async count(bucket: string): Promise<number> {
    const row = await this.d.sql.prepare("SELECT attempts FROM channel_key_attempts WHERE bucket=? AND expires_at>?").bind(bucket, Date.now()).first<{ attempts: number }>();
    return Number(row?.attempts ?? 0);
  }

  /** This request's own credential, if it already stored one: the recorded ID, or (for a
   *  crash between create and recording) the request-specific display name. */
  private own(row: Row, displayName: string, all: CredentialRow[]) {
    const byId = row.credential_id && all.find(c => c.id === row.credential_id);
    return byId || all.find(c => c.display_name === displayName && c.auth.type === "static_bearer") || null;
  }
  /** Read-only: would storing for this request collide with a credential it did not create? */
  private async conflicts(row: Row, valid: Valid): Promise<boolean> {
    let vault = row.vault_id ? await this.d.vaults.get({ tenantId: row.tenant_id, vaultId: row.vault_id }) : null;
    if (!vault || vault.archived_at) vault = await findConnectedAppsVault(this.d.vaults, row.tenant_id);
    if (!vault) return false;
    const all = (await this.d.credentials.list({ tenantId: row.tenant_id, vaultId: vault.id, includeArchived: false })).filter(c => !c.archived_at);
    const own = this.own(row, ownName(row, valid.service), all);
    return all.some(c => c !== own && credentialMatchesMcpServerUrl(c.auth, valid.mcpServerUrl));
  }

  /** Stores this request's key. Only ever creates one credential, or updates the one it
   *  created; refuses (KeyConflict) when the vault has another credential for the URL. */
  private async store(row: Row, valid: Valid, key: string, progress: { stage: Stage }): Promise<"done" | "notice_failed"> {
    const tenantId = row.tenant_id;
    const { mcpServerUrl } = valid;
    let vault = row.vault_id ? await this.d.vaults.get({ tenantId, vaultId: row.vault_id }) : null;
    if (!vault || vault.archived_at) {
      vault = await ensureConnectedAppsVault(this.d.vaults, tenantId);
      // Recorded before the key is stored: a retry for this request reuses the vault.
      await this.d.sql.prepare("UPDATE channel_key_links SET vault_id=? WHERE tenant_id=? AND session_id=? AND request_id=?")
        .bind(vault.id, tenantId, row.session_id, row.request_id).run();
    }
    const vaultId = vault.id;
    const displayName = ownName(row, valid.service);
    const save = async () => {
      const all = (await this.d.credentials.list({ tenantId, vaultId, includeArchived: false })).filter(c => !c.archived_at);
      const own = this.own(row, displayName, all);
      if (all.some(c => c !== own && credentialMatchesMcpServerUrl(c.auth, mcpServerUrl))) throw new KeyConflict();
      // From here the write may have happened even if it reports an error (lost response).
      progress.stage = "maybe";
      if (own) {
        await this.d.credentials.update({ tenantId, vaultId, credentialId: own.id, auth: { token: key } });
        return own.id;
      }
      const created = await this.d.credentials.create({ tenantId, vaultId, displayName, auth: { type: "static_bearer", token: key, mcp_server_url: mcpServerUrl } });
      return created.id;
    };
    let credentialId: string;
    try { credentialId = await save(); } catch (err) {
      if (!(err instanceof CredentialDuplicateMcpUrlError)) throw err;
      credentialId = await save(); // Lost a race; re-evaluates ownership and conflicts.
    }
    progress.stage = "stored";
    await this.d.sql.prepare("UPDATE channel_key_links SET credential_id=? WHERE tenant_id=? AND session_id=? AND request_id=?")
      .bind(credentialId, tenantId, row.session_id, row.request_id).run();
    await attachGrantToAgent(this.d.agents, tenantId, valid.agent.id, { vaultId, mcpServerUrl, service: valid.service });
    const appended = await this.d.router.appendEvent(row.session_id, {
      type: "system.access_granted", id: grantId(row), request_id: row.request_id,
      service: valid.service, vault_id: vaultId, mcp_server_url: mcpServerUrl,
    } as SessionEvent).catch(() => ({ status: 500 }));
    if (appended.status >= 400 && !(await this.events(row.session_id)).some(e => e.id === grantId(row))) throw new Error("grant not recorded");
    progress.stage = "granted";
    const result = await this.finish(row);
    if (result === "pending") throw new Error("grant not visible");
    return result;
  }
  routes() {
    const app = new Hono<{ Variables: { keyPageNonce: string; postCharged?: boolean } }>();
    app.use("*", async (c, next) => {
      const nonce = randomBytes(16).toString("base64");
      c.set("keyPageNonce", nonce);
      c.header("Cache-Control", "no-store");
      c.header("Pragma", "no-cache");
      c.header("Referrer-Policy", "no-referrer");
      c.header("X-Content-Type-Options", "nosniff");
      c.header("X-Robots-Tag", "noindex, nofollow");
      c.header("X-Frame-Options", "DENY");
      c.header("Content-Security-Policy", `default-src 'none'; style-src 'nonce-${nonce}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`);
      await next();
    });
    type C = Context<{ Variables: { keyPageNonce: string; postCharged?: boolean } }>;
    const render = (c: C, body: string, status: 200 | 400 | 404 | 409 | 413 | 429 | 500 = 200, title = "Secure key") =>
      c.html(page(c.get("keyPageNonce"), title, body), status);
    const generic = (c: C, status: 404 | 413 | 429 = 404) => render(c, GENERIC, status, "Link unavailable");
    const ipBucket = (c: C) => {
      let ip = "unknown";
      // The socket address. Forwarding headers are client-controlled and not trusted, and the
      // codebase has no trusted-proxy client-IP helper; behind a reverse proxy this is one
      // shared budget for the proxy.
      try { ip = getConnInfo(c).remote.address ?? ip; } catch { /* no Node socket (tests) */ }
      return `ip:${digest(ip)}`;
    };
    const fail = async (c: C, status: 404 | 429 = 404) => { await this.hit(ipBucket(c)); return generic(c, status); };
    const tokenOf = (c: C) => { const t = c.req.query("t"); return t && /^[A-Za-z0-9_-]{43}$/.test(t) ? t : null; };
    // Never surface or log errors: they could carry request data.
    app.onError((_err, c) => generic(c as C));
    // Oversized bodies are failed submits too: charge the link's and the IP's budgets.
    app.use("*", bodyLimit({
      maxSize: MAX_BODY,
      onError: async c => {
        const token = tokenOf(c as C);
        // Charged once: the handler may already have counted this submit before reading the body.
        if (token && !(c as C).get("postCharged")) await this.hit(`post:${digest(token)}`);
        await this.hit(ipBucket(c as C));
        return generic(c as C, 413);
      },
    }));
    const form = (c: C, v: Valid, error?: string) => render(c,
      `<h1>Add your ${escape(v.service)} API key</h1>`
      + `<p><strong>${escape(v.agent.name)}</strong> is asking for an API key for <strong>${escape(v.service)}</strong>. It will only be sent to <code>${escape(v.serverUrl.host)}</code>.</p>`
      + `<p class="muted">The key is saved in your Orrery vault. It is not posted to the chat or shown to the agent. This link works once.</p>`
      + (error ? `<p class="error" role="alert">${escape(error)}</p>` : "")
      + `<form method="post" autocomplete="off"><label for="key">API key</label>`
      + `<input id="key" name="key" type="password" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" minlength="${MIN_KEY}" maxlength="${MAX_KEY}" required>`
      + `<button type="submit">Save key</button></form>`,
      error ? 400 : 200, `Add ${v.service} API key`);
    const saved = (c: C, told: boolean) => render(c, told
      ? `<h1>Key saved</h1><p>Your key is saved and your agent has been told.</p><p>Go back to your chat. Your agent will continue there.</p>`
      : `<h1>Key saved</h1><p>Your key is saved. Go back to your chat; if your agent does not continue, send it any message.</p>`, 200, "Key saved");
    const CONFLICT = "<h1>A key for this server already exists</h1><p>Your workspace already has a saved login for this server, and it is managed in the Orrery console. Nothing was changed.</p><p>To replace it, update or remove it in the console's credential vault, then tell your agent in the chat. This link stays usable until it expires.</p>";

    app.get("/", async c => {
      if (await this.count(ipBucket(c)) >= KEY_PAGE_LIMITS.ipFailures) return generic(c, 429);
      if (!secureKeyOrigin(this.d.publicBaseUrl)) return fail(c);
      const token = c.req.query("t");
      const row = await this.live(token);
      if (!row) {
        // Read-only: a used link whose key is stored and granted (tick() finishes the rest).
        const done = await this.unfinished(token);
        if (done && (await this.events(done.session_id)).some(e => e.id === grantId(done))) return saved(c, false);
        return fail(c);
      }
      // GET never consumes: link previews and prefetchers open it too.
      if (await this.hit(`get:${row.token_hash}`) > KEY_PAGE_LIMITS.tokenRequests) return fail(c, 429);
      const valid = await this.validate(row);
      if (!valid) return fail(c);
      return form(c, valid);
    });

    app.post("/", async c => {
      if (await this.count(ipBucket(c)) >= KEY_PAGE_LIMITS.ipFailures) return generic(c, 429);
      if (!secureKeyOrigin(this.d.publicBaseUrl)) return fail(c);
      const token = tokenOf(c);
      if (!token) return fail(c);
      c.set("postCharged", true);
      if (await this.hit(`post:${digest(token)}`) > KEY_PAGE_LIMITS.tokenSubmits) return fail(c, 429);
      const origin = c.req.header("origin");
      if ((origin && origin !== "null" && origin !== secureKeyOrigin(this.d.publicBaseUrl)) || c.req.header("sec-fetch-site") === "cross-site") return fail(c);
      if (c.req.header("content-type")?.split(";")[0].trim().toLowerCase() !== "application/x-www-form-urlencoded") return fail(c);
      const raw = await c.req.text();
      if (Buffer.byteLength(raw, "utf8") > MAX_BODY) { await this.hit(ipBucket(c)); return generic(c, 413); }
      const fields = new URLSearchParams(raw);
      const names = [...fields.keys()];
      const key = (fields.get("key") ?? "").trim();
      const inputError = names.length !== 1 || names[0] !== "key" ? "Paste the key into the field and submit the form."
        : key.length < MIN_KEY || key.length > MAX_KEY ? `The key must be between ${MIN_KEY} and ${MAX_KEY} characters.`
        : /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(key) ? "The key contains control characters. Paste only the key."
        : /\s/.test(key) ? "The key contains spaces. Paste only the key, without a “Bearer” prefix."
        : null;
      type Outcome = { kind: "generic" } | { kind: "input"; valid: Valid } | { kind: "conflict" } | { kind: "error"; stage: Stage } | { kind: "saved"; told: boolean };
      const outcome = await serial(async (): Promise<Outcome> => {
        const row = await this.live(token);
        if (!row) {
          // A resubmitted used link whose grant landed: finish the job instead of failing.
          const done = await this.unfinished(token);
          const finished = done ? await this.finish(done) : "pending";
          return finished === "pending" ? { kind: "generic" } : { kind: "saved", told: finished === "done" };
        }
        const valid = await this.validate(row);
        if (!valid) return { kind: "generic" };
        // Bad input does not use up the link; the per-token submit limit still applies.
        if (inputError) return { kind: "input", valid };
        // Refuse before claiming, so the link stays usable once the conflict is resolved.
        if (await this.conflicts(row, valid)) return { kind: "conflict" };
        const claim = await this.d.sql.prepare("UPDATE channel_key_links SET consumed=1 WHERE token_hash=? AND consumed=0 AND completed=0 AND expires_at>?")
          .bind(row.token_hash, Date.now()).run();
        if (!claim.meta.changes) return { kind: "generic" };
        const progress: { stage: Stage } = { stage: "none" };
        try {
          const result = await this.store(row, valid, key, progress);
          this.d.log?.("channel_key.saved", { channel: row.channel, session_id: row.session_id, request_id: row.request_id, notified: String(result === "done") });
          return { kind: "saved", told: result === "done" };
        } catch (err) {
          const conflict = err instanceof KeyConflict;
          this.d.log?.("channel_key.save_failed", { channel: row.channel, session_id: row.session_id, request_id: row.request_id, reason: conflict ? "conflict" : "error", stage: progress.stage });
          if (conflict || progress.stage !== "granted") {
            // Before the grant, a resubmit of the same link converges on the same credential
            // (recorded ID or request-specific name): give the link back unless it was replaced.
            await this.d.sql.prepare("UPDATE channel_key_links SET consumed=0 WHERE token_hash=? AND completed=0").bind(row.token_hash).run().catch(() => {});
          }
          return conflict ? { kind: "conflict" } : { kind: "error", stage: progress.stage };
        }
      });
      switch (outcome.kind) {
        case "generic": return fail(c);
        case "input": await this.hit(ipBucket(c)); return form(c, outcome.valid, inputError!);
        case "conflict": return render(c, CONFLICT, 409, "Key not saved");
        case "error":
          if (outcome.stage === "granted") return saved(c, false);
          if (outcome.stage === "stored") return render(c, "<h1>Key saved, not yet connected</h1><p>Your key is saved, but your agent could not be connected to it yet.</p><p>Submit the key again with this same link to finish; that updates the same saved key. If the link has expired, ask your agent in the chat for a new secure link.</p>", 500, "Key saved, not connected");
          if (outcome.stage === "maybe") return render(c, "<h1>Key may have been saved</h1><p>Something went wrong while saving, and your key may or may not have been saved.</p><p>Submit the key again with this same link; that updates the same saved key rather than adding another. If the link has expired, ask your agent in the chat for a new secure link.</p>", 500, "Key may have been saved");
          return render(c, "<h1>Key not saved</h1><p>Something went wrong before your key was saved, so nothing was stored.</p><p>Try again with this same link in a moment; if it keeps failing, ask your agent in the chat for a new secure link.</p>", 500, "Key not saved");
        case "saved": return saved(c, outcome.told);
      }
    });
    app.all("*", c => generic(c));
    return app;
  }
}
class KeyConflict extends Error {}
/** How far a submit got: nothing written; a credential write attempted with unknown outcome;
 *  credential stored; grant recorded. */
type Stage = "none" | "maybe" | "stored" | "granted";
type RequestRef = Pick<Row, "tenant_id" | "session_id" | "request_id">;
const RECONCILE_WINDOW_MS = 24 * 60 * 60 * 1000;
const receiptOf = (r: RequestRef) => digest(JSON.stringify([r.tenant_id, r.session_id, r.request_id])).slice(0, 32);
/** Stable event IDs make the grant and the notice idempotent across retries. */
const grantId = (r: RequestRef) => `channel-key-grant-${receiptOf(r)}`;
const noticeId = (r: RequestRef) => `channel-key-notice-${receiptOf(r)}`;
/** Request-specific name: identifies this request's own credential after a crash. */
const ownName = (r: RequestRef, service: string) => `${service} API key (chat ${receiptOf(r).slice(0, 8)})`;
