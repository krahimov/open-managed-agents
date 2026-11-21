import { describe, it, expect, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { BetterSqlite3SqlClient } from "../../../packages/sql-client/src/adapters/better-sqlite3";
import { createInMemoryVaultService } from "@open-managed-agents/vaults-store/test-fakes";
import { createInMemoryCredentialService } from "@open-managed-agents/credentials-store/test-fakes";
import { ChannelKeyLinks, KEY_PAGE_LIMITS, KEY_PAGE_PATH, secureKeyOrigin } from "../src/lib/channel-key-links.js";
import { IMessageOnboarding } from "../src/lib/imessage-onboarding.js";
import { TelegramOnboarding } from "../src/lib/telegram-onboarding.js";

const databases: Database.Database[] = [];
const restore: (() => void)[] = [];
afterEach(() => {
  databases.splice(0).forEach(d => d.close());
  restore.splice(0).forEach(f => f());
});
const migration = (name: string) => readFileSync(new URL(`../migrations-sqlite/${name}.sql`, import.meta.url), "utf8");
const SERVER = "https://mcp.retell.example/mcp";
const KEY = "key_live_Q7xV2mN9pL4kR8tW3zY6bC1d";
const IP = { incoming: { socket: { remoteAddress: "203.0.113.5", remotePort: 1, remoteFamily: "IPv4" } } };

async function fixture(channel: "imessage" | "telegram" = "imessage", opts: { publicBaseUrl?: string } = {}) {
  const db = new Database(":memory:");
  databases.push(db);
  for (const m of ["0004_telegram_onboarding", "0005_telegram_setup", "0006_imessage_onboarding"]) db.exec(migration(m));
  db.exec("CREATE TABLE sessions (id TEXT,tenant_id TEXT,agent_id TEXT)");
  db.exec(migration("0007_shared_channel_conversations"));
  db.exec(migration("0008_channel_key_links"));
  db.exec("CREATE TABLE agents (id TEXT,tenant_id TEXT,config TEXT,archived_at INTEGER)");
  const sql = new BetterSqlite3SqlClient(db);
  const saved: any[] = [];
  const events = new Map<string, any[]>();
  const sessionRows = new Map<string, any>();
  const messages: any[] = [];
  const logs: string[] = [];
  // Capture everything written to the console during the test.
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    const spy = vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logs.push(args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ")); });
    restore.push(() => spy.mockRestore());
  }
  const vaults = createInMemoryVaultService().service;
  const credentials = createInMemoryCredentialService().service;
  const agents = {
    create: vi.fn(async ({ tenantId, input }: any) => {
      const a = { ...input, id: `agent-${saved.length + 1}`, tenant_id: tenantId };
      saved.push(a);
      db.prepare("INSERT INTO agents VALUES (?,?,?,NULL)").run(a.id, tenantId, JSON.stringify(a));
      return a;
    }),
    update: vi.fn(async ({ tenantId, agentId, input }: any) => {
      const a = saved.find(a => a.id === agentId && a.tenant_id === tenantId);
      Object.assign(a, { ...input, metadata: { ...a.metadata, ...input.metadata } });
      db.prepare("UPDATE agents SET config=? WHERE id=?").run(JSON.stringify(a), agentId);
      return a;
    }),
    get: async ({ tenantId, agentId }: any) => saved.find(a => a.id === agentId && a.tenant_id === tenantId) ?? null,
  };
  const router = {
    getEvents: async (sid: string, o: any = {}) => ({ data: (events.get(sid) ?? []).filter(e => e.seq > (o.afterSeq ?? -1)), has_more: false }),
    appendEvent: vi.fn(async (sid: string, e: any) => {
      const es = events.get(sid)!;
      es.push({ ...e, seq: es.length });
      return { status: 202, body: "{}" };
    }),
  };
  const sessions = {
    create: vi.fn(async (o: any) => {
      const id = `sess-${events.size + 1}`;
      events.set(id, []);
      sessionRows.set(id, { id, agent_id: o.agentId, tenant_id: o.tenantId, archived_at: null, status: "idle" });
      return { session: { id, ...o } };
    }),
    get: async ({ sessionId }: any) => sessionRows.get(sessionId) ?? null,
  };
  const hasMembership = vi.fn(async (u: string, t: string) => t === `tenant-${u}`);
  const publicBaseUrl = opts.publicBaseUrl ?? "https://test.example";
  const keyLinks = new ChannelKeyLinks({
    sql, router, sessions: sessions as any, agents: agents as any, vaults, credentials, hasMembership, publicBaseUrl,
    log: (op, fields) => console.info(JSON.stringify({ op, ...fields })),
  });
  const fetch = vi.fn(async (_url: string, o: any) => {
    messages.push(JSON.parse(o.body));
    return channel === "imessage" ? Response.json({ status: "SENT", message_handle: "sent-id" }) : new Response('{"ok":true}');
  });
  const deps: any = {
    sql, agents, sessions, router, publicBaseUrl, hasMembership, keyLinks, fetch,
    model: "gpt-6-astra", harness: "codex-sdk", environmentId: "env-test",
    environment: async () => ({ id: "env-test", config: { type: "cloud" } }),
    requestAccess: vi.fn(async (_t: string, sid: string, service: string, requestId: string) => {
      await router.appendEvent(sid, { type: "system.access_request", request_id: requestId, service, auth_kind: "composio" });
    }),
    apiKeyId: "fake-id", apiSecretKey: "fake-secret", number: "+15550009999",
    token: "test-token", username: "test_bot", webhookSecret: "test-webhook-secret",
  };
  const make = () => channel === "imessage" ? new IMessageOnboarding(deps) : new TelegramOnboarding(deps);
  const service = make();
  let update = 1000;
  const post = async (text: string, sender = channel === "imessage" ? "+15550000101" : "101") => {
    const id = update++;
    const body = channel === "imessage"
      ? { message_handle: `m-${id}`, content: text, from_number: sender, to_number: deps.number, is_outbound: false, status: "RECEIVED" }
      : { update_id: id, message: { message_id: id, text, from: { id: Number(sender) }, chat: { id: Number(sender), type: "private" } } };
    const headers = channel === "imessage" ? { "sb-signing-secret": deps.webhookSecret } : { "x-telegram-bot-api-secret-token": deps.webhookSecret };
    return (service as any).webhookRoutes().request("/", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  };
  const link = async (sender?: string) => {
    const r: any = await service.link("tenant-u", "u");
    await post(channel === "imessage" ? r.code : `/start ${new URL(r.url).searchParams.get("start")}`, sender);
    await service.tick();
  };
  const text = (m: any) => channel === "imessage" ? m.content : m.text;
  const request = async (fields: Record<string, unknown> = {}, sid = "sess-1") => {
    await router.appendEvent(sid, { type: "system.access_request", id: `sevt-${fields.request_id ?? "acreq-key"}`, request_id: "acreq-key", service: "retell", reason: "Retell needs a key.", auth_kind: "mcp_api_key", mcp_server_url: SERVER, ...fields });
  };
  /** Deliver pending output and return the token from the newest secure link. */
  const deliver = async () => {
    await service.tick();
    const m = messages.at(-1);
    const url = channel === "imessage" ? text(m).match(/https?:\/\/\S+/)?.[0] : m.reply_markup?.inline_keyboard?.[0]?.[0]?.url;
    return url ? new URL(url).searchParams.get("t")! : null;
  };
  const app = new Hono();
  app.route(KEY_PAGE_PATH, keyLinks.routes());
  const get = (token: string, env: unknown = IP) => app.request(`${KEY_PAGE_PATH}?t=${encodeURIComponent(token)}`, {}, env);
  const submit = (token: string, body: string | URLSearchParams = new URLSearchParams({ key: KEY }), headers: Record<string, string> = {}, env: unknown = IP) =>
    app.request(`${KEY_PAGE_PATH}?t=${encodeURIComponent(token)}`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://test.example", ...headers }, body: body.toString(),
    }, env);
  const dump = () => JSON.stringify(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t: any) => db.prepare(`SELECT * FROM ${t.name}`).all()));
  return { db, sql, saved, events, sessionRows, messages, logs, vaults, credentials, agents, router, deps, keyLinks, service, make, post, link, text, request, deliver, app, get, submit, dump, hasMembership };
}
const creds = async (f: Awaited<ReturnType<typeof fixture>>) => {
  const all = [];
  for (const v of await f.vaults.list({ tenantId: "tenant-u", includeArchived: false })) all.push(...(await f.credentials.list({ tenantId: "tenant-u", vaultId: v.id, includeArchived: false })).map(c => ({ ...c, vault: v.name })));
  return all;
};
const noNonce = (html: string) => html.replace(/nonce="[^"]+"/g, "");

describe("secure key links", () => {
  it("accepts https PUBLIC_BASE_URL, http only for localhost, and nothing with a path or credentials", () => {
    expect(secureKeyOrigin("https://orrery.example")).toBe("https://orrery.example");
    expect(secureKeyOrigin("https://orrery.example/")).toBe("https://orrery.example");
    for (const local of ["http://localhost:8787", "http://127.0.0.1:18910", "http://[::1]:3000"]) expect(secureKeyOrigin(local)).toBe(new URL(local).origin);
    for (const bad of [undefined, "", "not a url", "http://orrery.example", "http://10.0.0.5", "ftp://orrery.example", "https://orrery.example/app", "https://u:p@orrery.example", "https://orrery.example/?x=1"])
      expect(secureKeyOrigin(bad)).toBeNull();
  });

  it("iMessage: sends the link as text, stores only its hash, and keeps other auth kinds on the console link", async () => {
    const f = await fixture("imessage");
    await f.link();
    await f.request();
    const token = await f.deliver();
    const m = f.messages.at(-1);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(m.content).toContain(`https://test.example${KEY_PAGE_PATH}?t=${token}`);
    expect(m.content).toContain("retell");
    expect(m.content).toMatch(/Do not paste keys in this chat/);
    expect(m.reply_markup).toBeUndefined();
    const row = f.db.prepare("SELECT * FROM channel_key_links").get() as any;
    expect(row).toMatchObject({ tenant_id: "tenant-u", user_id: "u", session_id: "sess-1", request_id: "acreq-key", channel: "imessage", consumed: 0, completed: 0 });
    expect(row.token_hash).toHaveLength(64);
    expect(row.expires_at).toBeGreaterThan(Date.now() + 14 * 60000);
    expect(row.expires_at).toBeLessThanOrEqual(Date.now() + 15 * 60000);
    expect(f.dump()).not.toContain(token);
    // OAuth / Composio requests are unchanged.
    await f.post("/connect linear");
    await f.service.tick();
    expect(f.messages.at(-1).content).toContain("https://test.example/sessions/sess-1#needs-you");
  });

  it("Telegram: sends a URL button (not a Mini App) and keeps the Mini App for other auth kinds", async () => {
    const f = await fixture("telegram");
    await f.link();
    await f.request();
    const token = await f.deliver();
    const m = f.messages.at(-1);
    expect(m.reply_markup.inline_keyboard[0][0]).toEqual({ text: "Add retell API key", url: `https://test.example${KEY_PAGE_PATH}?t=${token}` });
    expect(m.reply_markup.inline_keyboard[0][0].web_app).toBeUndefined();
    expect(m.text).not.toContain(token!);
    await f.post("/connect linear");
    await f.service.tick();
    expect(f.messages.at(-1).reply_markup.inline_keyboard[0][0].web_app.url).toContain("/telegram/connect/sess-1/");
  });

  it("keeps today's console link when PUBLIC_BASE_URL is not https, and http works for localhost", async () => {
    const plain = await fixture("imessage", { publicBaseUrl: "http://orrery.example" });
    await plain.link();
    await plain.request();
    expect(await plain.deliver()).toBeNull();
    expect(plain.messages.at(-1).content).toContain("http://orrery.example/sessions/sess-1#needs-you");
    expect(plain.db.prepare("SELECT COUNT(*) AS n FROM channel_key_links").get()).toEqual({ n: 0 });
    const local = await fixture("telegram", { publicBaseUrl: "http://localhost:8787" });
    await local.link();
    await local.request();
    await local.service.tick();
    const m = local.messages.at(-1);
    // Telegram cannot open a non-https URL button, so the local link goes in the text.
    expect(m.text).toContain(`http://localhost:8787${KEY_PAGE_PATH}?t=`);
    expect(m.reply_markup).toBeUndefined();
  });

  it("GET shows a minimal form, never consumes, and sends strict security headers", async () => {
    const f = await fixture();
    await f.link();
    await f.request();
    const token = (await f.deliver())!;
    for (let i = 0; i < 3; i++) {
      const r = await f.get(token);
      expect(r.status).toBe(200);
      const html = await r.text();
      expect(html).toContain("retell");
      expect(html).toContain("mcp.retell.example");
      expect(html).toContain("Your assistant");
      expect(html).toMatch(/<input[^>]+type="password"[^>]+autocomplete="off"/);
      expect(html).not.toMatch(/<script|https?:\/\/(?!test\.example)[^"]*\.(css|js)|<link /);
      expect(html).not.toContain(token);
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(r.headers.get("referrer-policy")).toBe("no-referrer");
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
      expect(r.headers.get("x-robots-tag")).toContain("noindex");
      const csp = r.headers.get("content-security-policy")!;
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("form-action 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).not.toContain("script-src");
      expect(csp).not.toContain("unsafe-inline");
      const nonce = csp.match(/'nonce-([^']+)'/)![1];
      expect(html).toContain(`<style nonce="${nonce}">`);
    }
    expect(f.db.prepare("SELECT consumed FROM channel_key_links").get()).toEqual({ consumed: 0 });
    expect((await f.submit(token)).status).toBe(200);
  });

  it("on an empty workspace, stores the key like the console card: vault credential, agent attachment, grant and notice", async () => {
    const f = await fixture();
    await f.link();
    await f.request();
    const token = (await f.deliver())!;
    const r = await f.submit(token, new URLSearchParams({ key: `  ${KEY}\n` }));
    const html = await r.text();
    expect(r.status).toBe(200);
    expect(html).toContain("Key saved");
    expect(html).toContain("agent has been told");
    expect(html).toMatch(/Go back to your chat/);
    expect(html).not.toContain(KEY);
    for (const h of ["cache-control", "content-security-policy", "referrer-policy", "x-content-type-options", "x-robots-tag"]) expect(r.headers.get(h)).toBeTruthy();
    const [cred] = await creds(f);
    expect(await creds(f)).toHaveLength(1);
    expect(cred).toMatchObject({ vault: "Connected Apps", display_name: expect.stringMatching(/^retell API key \(chat [0-9a-f]{8}\)$/), auth: { type: "static_bearer", token: KEY, mcp_server_url: SERVER } });
    expect(f.db.prepare("SELECT credential_id FROM channel_key_links").get()).toEqual({ credential_id: cred.id });
    const agent = f.saved.find(a => a.id === "agent-1");
    expect(agent.metadata.default_vault_ids).toEqual([cred.vault_id]);
    expect(agent.mcp_servers).toEqual(expect.arrayContaining([expect.objectContaining({ url: SERVER })]));
    const evs = f.events.get("sess-1")!;
    expect(evs.filter(e => e.type === "system.access_granted")).toEqual([expect.objectContaining({ request_id: "acreq-key", service: "retell", vault_id: cred.vault_id, mcp_server_url: SERVER })]);
    expect(evs.at(-1)).toMatchObject({ type: "user.message", content: [{ type: "text", text: expect.stringMatching(/^\[access granted\] The retell API key is saved/) }] });
    expect(JSON.stringify(evs)).not.toContain(KEY);
    expect(f.db.prepare("SELECT consumed,completed FROM channel_key_links").get()).toEqual({ consumed: 1, completed: 1 });
    // Secrets never reach logs or channel tables.
    const all = f.logs.join("\n") + f.dump() + JSON.stringify(f.messages);
    expect(all).not.toContain(KEY);
    expect(f.logs.join("\n") + f.dump()).not.toContain(token);
    expect(f.logs.join("\n")).toContain("channel_key.saved");
    // The link is done; the granted request does not issue new links.
    expect((await f.get(token)).status).toBe(404);
    expect(await f.keyLinks.pending({ tenantId: "tenant-u", userId: "u", sessionId: "sess-1", channel: "imessage", account: f.db.prepare("SELECT * FROM imessage_accounts").get() as any })).toBeNull();
  });

  it("reuses the Connected Apps vault, else the first active vault, as the console does", async () => {
    const f = await fixture();
    await f.vaults.create({ tenantId: "tenant-u", name: "Personal" });
    await f.link();
    await f.request();
    expect((await f.submit((await f.deliver())!)).status).toBe(200);
    expect((await creds(f))[0].vault).toBe("Personal");
    const g = await fixture();
    await g.vaults.create({ tenantId: "tenant-u", name: "Personal" });
    await g.vaults.create({ tenantId: "tenant-u", name: "Connected Apps" });
    await g.link();
    await g.request();
    expect((await g.submit((await g.deliver())!)).status).toBe(200);
    expect((await creds(g))[0].vault).toBe("Connected Apps");
    expect(await g.vaults.list({ tenantId: "tenant-u", includeArchived: false })).toHaveLength(2);
  });

  it("shows one generic page for invalid, expired and used tokens", async () => {
    const f = await fixture();
    await f.link();
    await f.request();
    const token = (await f.deliver())!;
    expect((await f.submit(token)).status).toBe(200);
    const used = await f.get(token);
    const invalid = await f.get("A".repeat(43));
    const malformed = await f.get("short");
    const missing = await f.app.request(KEY_PAGE_PATH, {}, IP);
    await f.request({ request_id: "acreq-two" });
    const expired = (await f.deliver())!;
    f.db.exec("UPDATE channel_key_links SET expires_at=0 WHERE request_id='acreq-two'");
    const old = await f.get(expired);
    const other = await f.app.request(`${KEY_PAGE_PATH}/anything`, {}, IP);
    const bodies = await Promise.all([used, invalid, malformed, missing, old, other].map(async r => ({ status: r.status, html: noNonce(await r.text()), csp: !!r.headers.get("content-security-policy") })));
    for (const b of bodies) expect(b).toEqual(bodies[0]);
    expect(bodies[0].status).toBe(404);
    expect(bodies[0].html).toContain("ask your agent for a new secure link");
    expect(bodies[0].html).not.toMatch(/expired\b(?! after)|already used|invalid/i);
    // POST with an expired token is the same page and stores nothing.
    const post = await f.submit(expired);
    expect(post.status).toBe(404);
    expect(noNonce(await post.text())).toBe(bodies[0].html);
    expect(await creds(f)).toHaveLength(1);
  });

  it("is single use, and a new link replaces the previous one", async () => {
    const f = await fixture();
    await f.link();
    await f.request();
    // A failed send is re-delivered with a fresh token.
    f.deps.fetch.mockImplementationOnce(async (_u: string, o: any) => { f.messages.push(JSON.parse(o.body)); return Response.json({ status: "ERROR" }, { status: 500 }); });
    await f.service.tick();
    const lost = f.messages.at(-1).content.match(/t=([A-Za-z0-9_-]{43})/)[1];
    f.db.exec("UPDATE channel_deliveries SET next_at=0");
    const first = (await f.deliver())!;
    expect(first).not.toBe(lost);
    expect((await f.get(lost)).status).toBe(404);
    // A later request for the same access request (here: the credential notice) replaces it again.
    const account = f.db.prepare("SELECT * FROM imessage_accounts").get() as any;
    const second = new URL((await f.keyLinks.pending({ tenantId: "tenant-u", userId: "u", sessionId: "sess-1", channel: "imessage", account }))!).searchParams.get("t")!;
    expect((await f.get(first)).status).toBe(404);
    expect((await f.submit(first)).status).toBe(404);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM channel_key_links").get()).toEqual({ n: 1 });
    expect((await f.submit(second)).status).toBe(200);
    expect((await f.submit(second)).status).toBe(404);
    expect(await creds(f)).toHaveLength(1);
  });

  it("concurrent submits in one process store one credential and one grant", async () => {
    const f = await fixture();
    await f.link();
    await f.request();
    const token = (await f.deliver())!;
    const results = await Promise.all([f.submit(token), f.submit(token), f.submit(token, new URLSearchParams({ key: "other_Zq8Wn3Kx7Vb2Lm9Pr4Ts" }))]);
    expect(results.map(r => r.status).sort()).toEqual([200, 404, 404]);
    expect(await creds(f)).toHaveLength(1);
    expect(f.events.get("sess-1")!.filter(e => e.type === "system.access_granted")).toHaveLength(1);
    expect(f.events.get("sess-1")!.filter(e => e.type === "user.message" && /access granted/.test(e.content[0].text))).toHaveLength(1);
  });

  it("revalidates ten listed conditions at submit time", async () => {
    const cases: [string, (f: Awaited<ReturnType<typeof fixture>>) => Promise<void> | void][] = [
      ["membership removed", f => { f.hasMembership.mockResolvedValue(false); }],
      ["channel unlinked", f => { f.db.exec("UPDATE imessage_accounts SET chat_id=NULL,sender_id=NULL"); }],
      ["relinked to another number", f => { f.db.exec("UPDATE imessage_accounts SET chat_id='+15550000202',sender_id='+15550000202'"); }],
      ["session archived", f => { f.sessionRows.get("sess-1").archived_at = new Date().toISOString(); }],
      ["agent archived", f => { f.saved[0].archived_at = new Date().toISOString(); }],
      ["conversation gone", f => { f.db.exec("DELETE FROM channel_conversations"); }],
      ["request missing", f => { f.events.set("sess-1", f.events.get("sess-1")!.filter(e => e.type !== "system.access_request")); }],
      ["request is not an API key", f => { f.events.get("sess-1")!.find(e => e.type === "system.access_request").auth_kind = "mcp_oauth"; }],
      ["already granted", async f => { await f.router.appendEvent("sess-1", { type: "system.access_granted", request_id: "acreq-key", service: "retell" }); }],
      ["unsafe MCP URL", f => { f.events.get("sess-1")!.find(e => e.type === "system.access_request").mcp_server_url = "http://mcp.retell.example/mcp"; }],
    ];
    for (const [name, change] of cases) {
      const f = await fixture();
      await f.link();
      await f.request();
      const token = (await f.deliver())!;
      await change(f);
      const r = await f.submit(token);
      expect(r.status, name).toBe(404);
      expect(await r.text(), name).toContain("ask your agent for a new secure link");
      expect(await creds(f), name).toHaveLength(0);
      expect(f.events.get("sess-1")!.filter(e => e.type === "system.access_granted" && e.vault_id), name).toHaveLength(0);
    }
  });

  it("validates input without using up the link, and rejects cross-site or malformed posts", async () => {
    const f = await fixture();
    await f.link();
    await f.request();
    const token = (await f.deliver())!;
    const inputs: [string, string][] = [
      ["too short", new URLSearchParams({ key: "  short  " }).toString()],
      ["too long", new URLSearchParams({ key: "a".repeat(4097) }).toString()],
      ["control character", new URLSearchParams({ key: "abc\u0000defghijkl" }).toString()],
      ["internal space", new URLSearchParams({ key: "Bearer abcdefghijkl" }).toString()],
      ["extra field", new URLSearchParams({ key: KEY, other: "x" }).toString()],
    ];
    for (const [name, body] of inputs.slice(0, 3)) {
      const r = await f.submit(token, body);
      expect(r.status, name).toBe(400);
      const html = await r.text();
      expect(html, name).toContain('role="alert"');
      expect(html, name).toContain('type="password"');
      expect(html, name).not.toContain("abcdefghijkl");
    }
    expect(f.db.prepare("SELECT consumed FROM channel_key_links").get()).toEqual({ consumed: 0 });
    // Hostile or malformed requests get the generic page.
    expect((await f.submit(token, new URLSearchParams({ key: KEY }), { origin: "https://evil.example" })).status).toBe(404);
    expect((await f.submit(token, new URLSearchParams({ key: KEY }), { origin: "", "sec-fetch-site": "cross-site" })).status).toBe(404);
    // Five submits per token per window, valid or not.
    expect((await f.submit(token)).status).toBe(429);
    expect(await creds(f)).toHaveLength(0);
    const big = await fixture();
    await big.link();
    await big.request();
    const t2 = (await big.deliver())!;
    const r = await big.submit(t2, new URLSearchParams({ key: "x".repeat(20000) }), { "content-length": "20006" });
    expect(r.status).toBe(413);
    expect(r.headers.get("content-security-policy")).toBeTruthy();
    expect((await big.submit(t2, inputs[3][1])).status).toBe(400);
    expect((await big.submit(t2, inputs[4][1])).status).toBe(400);
    expect((await big.submit(t2, JSON.stringify({ key: KEY }), { "content-type": "application/json" })).status).toBe(404);
    expect((await big.submit(t2)).status).toBe(200);
  });

  it("rate limits failed attempts per IP", async () => {
    const f = await fixture();
    await f.link();
    await f.request();
    const token = (await f.deliver())!;
    for (let i = 0; i < KEY_PAGE_LIMITS.ipFailures; i++) await f.get(`${"B".repeat(42)}${i % 10}`);
    expect((await f.get(token)).status).toBe(429);
    const elsewhere = { incoming: { socket: { remoteAddress: "198.51.100.7" } } };
    expect((await f.get(token, elsewhere)).status).toBe(200);
    expect(f.dump()).not.toContain("203.0.113.5");
  });

  it("converges on retry after an agent-attachment failure, updating only its own credential", async () => {
    const f = await fixture();
    await f.link();
    await f.request();
    const token = (await f.deliver())!;
    f.agents.update.mockRejectedValueOnce(new Error("agent store unavailable"));
    const failed = await f.submit(token);
    expect(failed.status).toBe(500);
    const failedHtml = await failed.text();
    expect(failedHtml).toContain("Your key is saved, but your agent could not be connected");
    expect(failedHtml).toContain("Submit the key again with this same link");
    expect(f.db.prepare("SELECT consumed FROM channel_key_links").get()).toEqual({ consumed: 0 });
    expect(await creds(f)).toHaveLength(1);
    const firstId = (await creds(f))[0].id;
    expect(f.events.get("sess-1")!.some(e => e.type === "system.access_granted")).toBe(false);
    // The request is still pending, so a fresh link is available (here through the chat guard).
    await f.post("my key is sk-proj-Ab3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3z");
    const retry = (await f.deliver())!;
    expect(retry).not.toBe(token);
    const replacement = "key_live_Zq8Wn3Kx7Vb2Lm9Pr4Ts6Yh1";
    expect((await f.submit(retry, new URLSearchParams({ key: replacement }))).status).toBe(200);
    const all = await creds(f);
    expect(all).toHaveLength(1);
    expect(all[0].auth.token).toBe(replacement);
    expect(all[0].id).toBe(firstId);
    expect(f.events.get("sess-1")!.filter(e => e.type === "system.access_granted")).toHaveLength(1);
    expect(f.logs.join("\n")).toContain("channel_key.save_failed");
    expect(f.logs.join("\n")).not.toContain("agent store unavailable");
  });

  it("tells the user when the key was saved but the agent could not be notified, and the tick posts the notice once", async () => {
    const f = await fixture();
    await f.link();
    await f.request();
    const token = (await f.deliver())!;
    const real = f.router.appendEvent.getMockImplementation()!;
    f.router.appendEvent.mockImplementation(async (sid: string, e: any) => e.type === "user.message" ? { status: 409, body: "{}" } : real(sid, e));
    const r = await f.submit(token);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("if your agent does not continue, send it any message");
    expect(await creds(f)).toHaveLength(1);
    expect(f.db.prepare("SELECT consumed,completed FROM channel_key_links").get()).toEqual({ consumed: 1, completed: 0 });
    f.router.appendEvent.mockImplementation(real);
    await f.service.tick();
    await f.make().tick();
    const notices = () => f.events.get("sess-1")!.filter(e => e.type === "user.message" && /^\[access granted\]/.test(e.content[0].text));
    expect(notices()).toHaveLength(1);
    expect(f.db.prepare("SELECT completed FROM channel_key_links").get()).toEqual({ completed: 1 });
  });

  // QA finding 5: failures after the grant is persisted.
  it("reconciles a completion failure after the grant: accurate page, then exactly one notice", async () => {
    const f = await fixture();
    await f.link();
    await f.request();
    const token = (await f.deliver())!;
    f.db.exec("CREATE TRIGGER fail_completed BEFORE UPDATE OF completed ON channel_key_links BEGIN SELECT RAISE(FAIL,'completion failed'); END;");
    const r = await f.submit(token);
    const html = await r.text();
    expect(r.status).toBe(200);
    expect(html).toContain("Your key is saved");
    expect(html).toContain("if your agent does not continue, send it any message");
    expect(html).not.toMatch(/not saved|new secure link/);
    expect(f.events.get("sess-1")!.filter(e => e.type === "system.access_granted")).toHaveLength(1);
    const notices = () => f.events.get("sess-1")!.filter(e => e.type === "user.message" && /^\[access granted\]/.test(e.content[0].text));
    expect(notices()).toHaveLength(1);
    expect(f.db.prepare("SELECT consumed,completed FROM channel_key_links").get()).toEqual({ consumed: 1, completed: 0 });
    // Re-opening the used link says it is saved; it does not ask for a link that cannot be issued.
    expect(await (await f.get(token)).text()).toContain("Your key is saved");
    f.db.exec("DROP TRIGGER fail_completed");
    // A resubmit of the same link finishes the job instead of failing.
    const again = await f.submit(token);
    expect(again.status).toBe(200);
    expect(await again.text()).toContain("Key saved");
    expect(f.db.prepare("SELECT completed FROM channel_key_links").get()).toEqual({ completed: 1 });
    await f.service.tick();
    expect(notices()).toHaveLength(1);
    expect(await creds(f)).toHaveLength(1);
  });

  it("finishes after a lost grant response via a later link request or the next tick, exactly once", async () => {
    for (const via of ["mint", "tick"] as const) {
      const f = await fixture();
      await f.link();
      await f.request();
      const token = (await f.deliver())!;
      const real = f.router.appendEvent.getMockImplementation()!;
      // The grant is persisted but its response is lost; the notice append then fails too.
      f.router.appendEvent.mockImplementation(async (sid: string, e: any) => {
        if (e.type === "system.access_granted") { await real(sid, e); throw new Error("connection reset"); }
        if (e.type === "user.message") return { status: 503, body: "{}" };
        return real(sid, e);
      });
      const r = await f.submit(token);
      expect(r.status, via).toBe(200);
      expect(await r.text(), via).toContain("Your key is saved");
      f.router.appendEvent.mockImplementation(real);
      const account = f.db.prepare("SELECT * FROM imessage_accounts").get() as any;
      if (via === "mint") expect(await f.keyLinks.mint({ tenantId: "tenant-u", userId: "u", sessionId: "sess-1", requestId: "acreq-key", channel: "imessage", account })).toBeNull();
      else await f.service.tick();
      await f.service.tick();
      const evs = f.events.get("sess-1")!;
      expect(evs.filter(e => e.type === "system.access_granted"), via).toHaveLength(1);
      expect(evs.filter(e => e.type === "user.message" && /^\[access granted\]/.test(e.content[0].text)), via).toHaveLength(1);
      expect(f.db.prepare("SELECT completed FROM channel_key_links").get(), via).toEqual({ completed: 1 });
    }
  });

  it("refuses to replace a different kind of login for the same server, without using up the link", async () => {
    const f = await fixture();
    const vault = await f.vaults.create({ tenantId: "tenant-u", name: "Connected Apps" });
    await f.credentials.create({ tenantId: "tenant-u", vaultId: vault.id, displayName: "OAuth", auth: { type: "mcp_oauth", access_token: "oauth-token", mcp_server_url: SERVER } });
    await f.link();
    await f.request();
    const r = await f.submit((await f.deliver())!);
    expect(r.status).toBe(409);
    expect(await r.text()).toContain("managed in the Orrery console");
    expect((await creds(f))[0].auth.type).toBe("mcp_oauth");
    expect(f.db.prepare("SELECT consumed FROM channel_key_links").get()).toEqual({ consumed: 0 });
  });

  // QA finding 1: a link must only write the credential it created.
  it("never overwrites an existing credential it did not create, and works once the conflict is resolved", async () => {
    const f = await fixture();
    const vault = await f.vaults.create({ tenantId: "tenant-u", name: "Connected Apps" });
    const other = await f.credentials.create({ tenantId: "tenant-u", vaultId: vault.id, displayName: "Other agents use this", auth: { type: "static_bearer", token: "existing-token-value", mcp_server_url: SERVER } });
    await f.link();
    await f.request();
    const token = (await f.deliver())!;
    const r = await f.submit(token);
    expect(r.status).toBe(409);
    const html = await r.text();
    expect(html).toContain("A key for this server already exists");
    expect(html).toContain("managed in the Orrery console");
    expect(html).toContain("Nothing was changed");
    expect(await creds(f)).toEqual([expect.objectContaining({ id: other.id, auth: expect.objectContaining({ token: "existing-token-value" }) })]);
    expect(f.saved[0].metadata.default_vault_ids ?? []).toEqual([]);
    expect(f.events.get("sess-1")!.some(e => e.type === "system.access_granted")).toBe(false);
    expect(f.db.prepare("SELECT consumed FROM channel_key_links").get()).toEqual({ consumed: 0 });
    // Equivalent URL spellings count as the same server.
    await f.credentials.archive({ tenantId: "tenant-u", vaultId: vault.id, credentialId: other.id });
    await f.credentials.create({ tenantId: "tenant-u", vaultId: vault.id, displayName: "slash", auth: { type: "static_bearer", token: "slash-token", mcp_server_url: `${SERVER}/` } });
    expect((await f.submit(token)).status).toBe(409);
    const slash = (await creds(f))[0];
    await f.credentials.archive({ tenantId: "tenant-u", vaultId: vault.id, credentialId: slash.id });
    // Once resolved in the console, the same link still works.
    expect((await f.submit(token)).status).toBe(200);
    expect((await creds(f)).map(c => c.auth.token)).toEqual([KEY]);
  });

  it("a second request for the same server does not overwrite the first request's credential", async () => {
    const f = await fixture();
    await f.link();
    await f.request();
    expect((await f.submit((await f.deliver())!)).status).toBe(200);
    await f.request({ request_id: "acreq-two" });
    const second = (await f.deliver())!;
    const r = await f.submit(second, new URLSearchParams({ key: "key_live_Zq8Wn3Kx7Vb2Lm9Pr4Ts6Yh1" }));
    expect(r.status).toBe(409);
    expect((await creds(f)).map(c => c.auth.token)).toEqual([KEY]);
  });

  // QA round 2, G: a lost response from the credential write is reported as "may have been saved".
  it("says the key may have been saved when the credential write's outcome is unknown, and the same link converges", async () => {
    const f = await fixture();
    await f.link();
    await f.request();
    const token = (await f.deliver())!;
    const create = f.credentials.create.bind(f.credentials);
    let once = true;
    (f.credentials as any).create = async (o: any) => { const row = await create(o); if (once) { once = false; throw new Error("response lost"); } return row; };
    const r = await f.submit(token);
    const html = await r.text();
    expect(r.status).toBe(500);
    expect(html).toContain("may have been saved");
    expect(html).toContain("Submit the key again with this same link");
    expect(html).not.toContain("nothing was stored");
    expect(await creds(f)).toHaveLength(1);
    expect(f.db.prepare("SELECT consumed,credential_id FROM channel_key_links").get()).toEqual({ consumed: 0, credential_id: null });
    expect((await f.submit(token, new URLSearchParams({ key: "key_live_Zq8Wn3Kx7Vb2Lm9Pr4Ts6Yh1" }))).status).toBe(200);
    const all = await creds(f);
    expect(all).toHaveLength(1);
    expect(all[0].auth.token).toBe("key_live_Zq8Wn3Kx7Vb2Lm9Pr4Ts6Yh1");
  });

  it("says nothing was stored only when nothing was written", async () => {
    const f = await fixture();
    await f.link();
    await f.request();
    const token = (await f.deliver())!;
    (f.credentials as any).list = async () => { throw new Error("db down"); };
    const r = await f.submit(token);
    expect(r.status).toBe(500);
    expect(await r.text()).toContain("nothing was stored");
    expect(f.db.prepare("SELECT consumed FROM channel_key_links").get()).toEqual({ consumed: 0 });
  });

  // QA round 2, H: pending() alone reconciles an unfinished granted request.
  it("pending() posts an owed notice for a granted but unfinished request", async () => {
    const f = await fixture();
    await f.link();
    await f.request();
    const token = (await f.deliver())!;
    const real = f.router.appendEvent.getMockImplementation()!;
    f.router.appendEvent.mockImplementation(async (sid: string, e: any) => e.type === "user.message" ? { status: 409, body: "{}" } : real(sid, e));
    expect((await f.submit(token)).status).toBe(200);
    f.router.appendEvent.mockImplementation(real);
    const account = f.db.prepare("SELECT * FROM imessage_accounts").get() as any;
    expect(await f.keyLinks.pending({ tenantId: "tenant-u", userId: "u", sessionId: "sess-1", channel: "imessage", account })).toBeNull();
    const notices = f.events.get("sess-1")!.filter(e => e.type === "user.message" && /^\[access granted\]/.test(e.content[0].text));
    expect(notices).toHaveLength(1);
    expect(f.db.prepare("SELECT completed FROM channel_key_links").get()).toEqual({ completed: 1 });
    await f.keyLinks.pending({ tenantId: "tenant-u", userId: "u", sessionId: "sess-1", channel: "imessage", account });
    expect(f.events.get("sess-1")!.filter(e => e.type === "user.message" && /^\[access granted\]/.test(e.content[0].text))).toHaveLength(1);
  });

  // QA finding 7: oversized bodies count against the budgets.
  it("charges oversized submits to the per-link and per-IP budgets, keeping the 413", async () => {
    const f = await fixture();
    await f.link();
    await f.request();
    const token = (await f.deliver())!;
    const big = new URLSearchParams({ key: "x".repeat(17000) });
    for (let i = 0; i < KEY_PAGE_LIMITS.tokenSubmits; i++) expect((await f.submit(token, big)).status).toBe(413);
    expect((await f.submit(token)).status).toBe(429);
    expect(await creds(f)).toHaveLength(0);
    const g = await fixture();
    await g.link();
    await g.request();
    const t2 = (await g.deliver())!;
    for (let i = 0; i < KEY_PAGE_LIMITS.ipFailures; i++) await g.submit(`${"C".repeat(42)}${i % 10}`, big);
    expect((await g.get(t2)).status).toBe(429);
  });
});

describe("credential-looking chat text", () => {
  for (const channel of ["imessage", "telegram"] as const) {
    it(`${channel}: tested key formats never reach the session or channel tables (in-memory session doubles), and the reply carries a fresh secure link when a key is pending`, async () => {
      const f = await fixture(channel);
      await f.link();
      const before = f.events.get("sess-1")!.length;
      const pasted = "here: sk-proj-Ab3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3z";
      await f.post(pasted);
      // Not even the inbox row keeps it: the webhook stores routing fields only.
      expect(f.dump()).not.toContain("sk-proj-");
      // A failed first attempt still scrubs the inbox row before retrying.
      f.hasMembership.mockRejectedValueOnce(new Error("db down"));
      await f.service.tick();
      expect(f.dump()).not.toContain("sk-proj-");
      f.db.exec(`UPDATE ${channel}_inbox SET next_at=0`);
      await f.service.tick();
      const reply = f.messages.at(-1);
      expect(f.text(reply)).toMatch(/not sent to your agent/);
      expect(f.text(reply)).toMatch(/rotate/i);
      expect(f.text(reply)).toMatch(/When your agent asks for a key/);
      expect(f.events.get("sess-1")!.length).toBe(before);
      // With a pending API-key request, the reply carries a new secure link.
      await f.request();
      const delivered = (await f.deliver())!;
      await f.post("sk-ant-api03-Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Jh1Gf0");
      const fresh = (await f.deliver())!;
      expect(fresh).not.toBe(delivered);
      expect(f.text(f.messages.at(-1))).toMatch(/Your agent is waiting for a key/);
      if (channel === "telegram") expect(f.messages.at(-1).reply_markup.inline_keyboard[0][0]).toEqual({ text: "Open secure key page", url: expect.stringContaining(`?t=${fresh}`) });
      else expect(f.text(f.messages.at(-1))).toContain(`?t=${fresh}`);
      expect((await f.get(delivered)).status).toBe(404);
      expect((await f.get(fresh)).status).toBe(200);
      expect(JSON.stringify([...f.events.values()])).not.toMatch(/sk-proj-|sk-ant-/);
      expect(f.dump()).not.toMatch(/sk-proj-|sk-ant-|Zx9Yw8Vu7/);
      expect(f.dump()).not.toContain(fresh);
      expect(f.logs.join("\n")).not.toMatch(/sk-proj-|sk-ant-/);
      // Ordinary text and commands still flow.
      await f.post("please continue with agent-1 and the key points");
      await f.service.tick();
      expect(f.events.get("sess-1")!.at(-1).content[0].text).toBe("please continue with agent-1 and the key points");
    });
  }
  // QA finding 2: known syntaxes without digits; QA finding 6: ordinary code still flows.
  for (const channel of ["imessage", "telegram"] as const) {
    it(`${channel}: withholds digit-free known formats and forwards readable code`, async () => {
      const f = await fixture(channel);
      await f.link();
      const before = f.events.get("sess-1")!.length;
      for (const secret of ["Authorization: Bearer AbCdEfGhIjKlMnOpQrStUvWxYz", "sk-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"]) {
        await f.post(secret);
        expect(f.dump(), secret).not.toContain(secret.slice(-20));
        await f.service.tick();
        expect(f.text(f.messages.at(-1)), secret).toMatch(/rotate/i);
      }
      expect(f.events.get("sess-1")!.length).toBe(before);
      const code = 'const cacheKey = "customerAccount2024BillingRegion2025";';
      await f.post(code);
      await f.service.tick();
      expect(f.events.get("sess-1")!.at(-1).content[0].text).toBe(code);
    });
  }

  // QA finding 3: link-code normalisation must not bypass the guard.
  it("iMessage: a linked sender's 32-character key is withheld, never stored, and never treated as a link code", async () => {
    const f = await fixture("imessage");
    await f.link();
    const before = f.events.get("sess-1")!.length;
    const sent = f.messages.length;
    for (const secret of ["sk_" + "live_AbCdEfGhIjKlMnOpQrStUvWx", "Zq8Wn3Kx7Vb2Lm9Pr4Ts6Yh1Ab3dE5fG", "ORRERY sk_" + "live_AbCdEfGhIjKlMnOpQrStUvWx"]) {
      await f.post(secret);
      expect(f.dump(), secret).not.toContain(secret.replace("ORRERY ", ""));
      f.hasMembership.mockRejectedValueOnce(new Error("db down"));
      await f.service.tick();
      expect(f.db.prepare("SELECT done,attempts FROM imessage_inbox WHERE done=0").get(), secret).toEqual({ done: 0, attempts: 1 });
      expect(f.dump(), secret).not.toContain(secret.replace("ORRERY ", ""));
      f.db.exec("UPDATE imessage_inbox SET next_at=0");
      await f.service.tick();
      expect(f.text(f.messages.at(-1)), secret).toMatch(/rotate/i);
    }
    expect(f.messages.slice(sent).some(m => /Your agent is ready/.test(m.content))).toBe(false);
    expect(f.events.get("sess-1")!.length).toBe(before);
  });

  it("iMessage: an unlinked sender can still link with a bare or prefixed code", async () => {
    for (const prefixed of [false, true]) {
      const f = await fixture("imessage");
      const r: any = await f.service.link("tenant-u", "u");
      await f.post(prefixed ? r.code : r.code.replace("ORRERY ", ""));
      await f.service.tick();
      expect((await f.service.status("tenant-u", "u")).connected).toBe(true);
      expect(f.messages.some(m => /Your agent is ready/.test(m.content))).toBe(true);
    }
  });

  // QA finding 4: Telegram stores only the fields processing needs.
  it("Telegram: persists only routing fields and text, never captions, quoted replies or entities; old rows still decode", async () => {
    const f = await fixture("telegram");
    await f.link();
    const secret = "sk-proj-Ab3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3z";
    const send = (update: any) => (f.service as any).webhookRoutes().request("/", {
      method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": f.deps.webhookSecret }, body: JSON.stringify(update),
    });
    const base = (id: number, message: any) => ({ update_id: id, message: { message_id: id, from: { id: 101, is_bot: false, first_name: "A" }, chat: { id: 101, type: "private", username: "a" }, date: 1, ...message } });
    await send(base(9001, { caption: `here ${secret}`, photo: [{ file_id: "x" }] }));
    await send(base(9002, { text: "thanks", entities: [{ type: "bold", offset: 0, length: 6 }], reply_to_message: { message_id: 3, text: secret } }));
    const rows = f.db.prepare("SELECT update_id,payload FROM telegram_inbox WHERE update_id IN ('9001','9002') ORDER BY update_id").all() as any[];
    expect(rows.map(r => JSON.parse(r.payload))).toEqual([
      { update_id: 9001, message: { message_id: 9001, from: { id: 101, is_bot: false }, chat: { id: 101, type: "private" } } },
      { update_id: 9002, message: { message_id: 9002, text: "thanks", from: { id: 101, is_bot: false }, chat: { id: 101, type: "private" } } },
    ]);
    expect(f.dump()).not.toContain(secret);
    await f.service.tick();
    expect(f.events.get("sess-1")!.at(-1).content[0].text).toBe("thanks");
    // A full update stored by an earlier version still decodes.
    f.db.prepare("INSERT INTO telegram_inbox (update_id,payload) VALUES (?,?)").run("9003", JSON.stringify(base(9003, { text: "legacy row", entities: [] })));
    await f.service.tick();
    expect(f.events.get("sess-1")!.at(-1).content[0].text).toBe("legacy row");
  });

  // QA round 2, A/B/C through the channel.
  it("iMessage: withholds introduced keys and reset links, forwards Authorization prose", async () => {
    const f = await fixture("imessage");
    await f.link();
    const before = f.events.get("sess-1")!.length;
    for (const secret of ["api key: qjzvbtmkcxwplrdnsfhy82964175", "secret: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "https://example.com/reset?token=deadbeef1234567890abcdef12345678"]) {
      await f.post(secret);
      expect(f.dump(), secret).not.toContain(secret.slice(-16));
      await f.service.tick();
      expect(f.text(f.messages.at(-1)), secret).toMatch(/rotate/i);
    }
    expect(f.events.get("sess-1")!.length).toBe(before);
    await f.post("Authorization: Bearer token-based-authentication");
    await f.service.tick();
    expect(f.events.get("sess-1")!.at(-1).content[0].text).toBe("Authorization: Bearer token-based-authentication");
  });

  // QA round 2, D: old full Telegram rows are reduced before anything can fail.
  it("Telegram: an old full-format inbox row loses captions and quoted text before a failed tick", async () => {
    const f = await fixture("telegram");
    await f.link();
    const secret = "sk-proj-Ab3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3z";
    const full = { update_id: 9101, message: { message_id: 9101, date: 1, text: "thanks", caption: `caption ${secret}`, entities: [{ type: "bold" }], reply_to_message: { message_id: 4, text: secret }, from: { id: 101, is_bot: false, first_name: "A" }, chat: { id: 101, type: "private", username: "a" } } };
    f.db.prepare("INSERT INTO telegram_inbox (update_id,payload) VALUES (?,?)").run("9101", JSON.stringify(full));
    f.hasMembership.mockRejectedValueOnce(new Error("db down"));
    await f.service.tick();
    const row = f.db.prepare("SELECT done,attempts,payload FROM telegram_inbox WHERE update_id='9101'").get() as any;
    expect({ done: row.done, attempts: row.attempts }).toEqual({ done: 0, attempts: 1 });
    expect(JSON.parse(row.payload)).toEqual({ update_id: 9101, message: { message_id: 9101, text: "thanks", from: { id: 101, is_bot: false }, chat: { id: 101, type: "private" } } });
    expect(f.dump()).not.toContain(secret);
    f.db.exec("UPDATE telegram_inbox SET next_at=0");
    await f.service.tick();
    expect(f.events.get("sess-1")!.at(-1).content[0].text).toBe("thanks");
  });

  // QA round 2, E: the link-code exemption needs a live code, and unlinked text is not kept.
  it("iMessage: only a live link code is exempt; other code-shaped or unlinked text is never stored", async () => {
    const f = await fixture("imessage");
    const generic = "Q7xV2mN9pL4kR8tW3zY6bC1dX5aF0gH2";
    const stranger = "+15550000999";
    for (const text of [generic, `ORRERY ${generic}`, "hello, my name is Sam and I want to sign up"]) {
      await f.post(text, stranger);
      const stored = JSON.stringify(f.db.prepare("SELECT payload FROM imessage_inbox").all());
      expect(stored, text).not.toContain(generic);
      expect(stored, text).not.toContain("my name is Sam");
    }
    await f.service.tick();
    // One "how to link" notice for the ordinary text; failed codes stay silent as before.
    expect(f.messages.filter(m => m.number === stranger)).toHaveLength(1);
    expect(f.messages.at(-1).content).toMatch(/To link your agent/);
    // A code-shaped row stored before this check is screened again at tick time.
    f.db.prepare("INSERT INTO imessage_inbox (update_id,payload,received_at) VALUES (?,?,?)").run("old-code", JSON.stringify({ message_handle: "old-code", from_number: stranger, content: `ORRERY ${generic}` }), Date.now());
    await f.service.tick();
    expect(f.dump()).not.toContain(generic);
    // A genuine live code still links, bare or prefixed (covered above), and from this sender.
    const r: any = await f.service.link("tenant-u", "u");
    await f.post(r.code.replace("ORRERY ", ""), stranger);
    await f.service.tick();
    expect((await f.service.status("tenant-u", "u")).connected).toBe(true);
  });

  it("Telegram: an unlinked /start with an unknown code is not stored", async () => {
    const f = await fixture("telegram");
    await f.post("/start Q7xV2mN9pL4kR8tW3zY6bC1dX5aF0gH2", "202");
    expect(f.dump()).not.toContain("Q7xV2mN9pL4kR8tW3zY6bC1dX5aF0gH2");
    await f.post("hi there, how do I sign up?", "202");
    expect(f.dump()).not.toContain("how do I sign up");
  });

  // QA round 2, F: a linked sender re-sending a bare code gets a neutral reply.
  it("iMessage: a linked sender re-sending a bare code is withheld with a neutral reply", async () => {
    const f = await fixture("imessage");
    const r: any = await f.service.link("tenant-u", "u");
    const code = r.code.replace("ORRERY ", "");
    await f.post(code);
    await f.service.tick();
    const before = f.events.get("sess-1")!.length;
    await f.post(code);
    expect(f.dump()).not.toContain(code);
    await f.service.tick();
    const reply = f.messages.at(-1).content;
    expect(reply).toContain("already linked");
    expect(reply).toContain("not sent to your agent");
    expect(reply).toMatch(/If it was a key rather than a linking code, rotate/);
    expect(reply).not.toMatch(/looked like a key/);
    expect(f.events.get("sess-1")!.length).toBe(before);
  });

  it("without a conversation, replies with guidance only; rows stored before the check are scrubbed", async () => {
    const f = await fixture("imessage");
    await f.link();
    f.db.exec("DELETE FROM channel_conversations");
    // As if received before this version: the raw text sits in the inbox until the tick.
    f.db.prepare("INSERT INTO imessage_inbox (update_id,payload,received_at) VALUES (?,?,?)")
      .run("old-row", JSON.stringify({ message_handle: "old-row", from_number: "+15550000101", content: "AKIAIOSFODNN7EXAMPLE" }), Date.now());
    f.hasMembership.mockRejectedValueOnce(new Error("db down"));
    await f.service.tick();
    expect(f.db.prepare("SELECT done,attempts FROM imessage_inbox WHERE update_id='old-row'").get()).toEqual({ done: 0, attempts: 1 });
    expect(f.dump()).not.toContain("AKIAIOSFODNN7EXAMPLE");
    f.db.exec("UPDATE imessage_inbox SET next_at=0");
    await f.service.tick();
    expect(f.messages.at(-1).content).toMatch(/When your agent asks for a key/);
    expect(f.dump()).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });
});
