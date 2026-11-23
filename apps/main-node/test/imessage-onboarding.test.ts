import { describe, it, expect, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { BetterSqlite3SqlClient } from "../../../packages/sql-client/src/adapters/better-sqlite3";
import { IMessageOnboarding, plainText, sendblueEnabled } from "../src/lib/imessage-onboarding.js";
const databases: Database.Database[] = [];
afterEach(() => {
  databases.splice(0).forEach((d) => d.close());
});
async function fixture() {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(
    readFileSync(
      new URL(
        "../migrations-sqlite/0006_imessage_onboarding.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  db.exec(readFileSync(new URL("../migrations-sqlite/0004_telegram_onboarding.sql", import.meta.url), "utf8"));
  db.exec(readFileSync(new URL("../migrations-sqlite/0005_telegram_setup.sql", import.meta.url), "utf8"));
  db.exec("CREATE TABLE sessions (id TEXT,tenant_id TEXT,agent_id TEXT)");
  db.exec(readFileSync(new URL("../migrations-sqlite/0007_shared_channel_conversations.sql", import.meta.url), "utf8"));
  db.exec(
    "CREATE TABLE agents (id TEXT,tenant_id TEXT,config TEXT,archived_at INTEGER)",
  );
  const sql = new BetterSqlite3SqlClient(db);
  const saved: any[] = [];
  const events = new Map<string, any[]>();
  const messages: any[] = [];
  const create = vi.fn(async ({ tenantId, input }: any) => {
    const a = {
      ...input,
      id: `agent-${saved.length + 1}`,
      tenant_id: tenantId,
    };
    saved.push(a);
    db.prepare("INSERT INTO agents VALUES (?,?,?,NULL)").run(
      a.id,
      tenantId,
      JSON.stringify(a),
    );
    return a;
  });
  const deps: any = {
    sql,
    agents: {
      create,
      update: vi.fn(async ({ tenantId, agentId, input }: any) => {
        const a = saved.find(a => a.id === agentId && a.tenant_id === tenantId);
        Object.assign(a, { ...input, metadata: { ...a.metadata, ...input.metadata } });
        db.prepare("UPDATE agents SET config=? WHERE id=?").run(JSON.stringify(a), agentId);
        return a;
      }),
      get: async ({ tenantId, agentId }: any) =>
        saved.find((a) => a.id === agentId && a.tenant_id === tenantId) ?? null,
    },
    sessions: {
      create: vi.fn(async (o: any) => {
        const id = `sess-${events.size + 1}`;
        events.set(id, []);
        return { session: { id, ...o } };
      }),
      get: async () => ({ status: "running" }),
    },
    router: {
      getEvents: async (sid: string, o: any = {}) => ({
        data: (events.get(sid) ?? []).filter((e) => e.seq > (o.afterSeq ?? -1)),
        has_more: false,
      }),
      appendEvent: vi.fn(async (sid: string, e: any) => {
        const es = events.get(sid)!;
        es.push({ ...e, seq: es.length });
        return { status: 202 };
      }),
    },
    publicBaseUrl: "https://test.example",
    hasVault: vi.fn(async (tenant: string, id: string) => tenant === "tenant-u" && id === "vault-u"),
    requestAccess: vi.fn(async (_tenant: string, sid: string, service: string, requestId: string) => {
      await deps.router.appendEvent(sid, { type: "system.access_request", request_id: requestId, service });
    }),
    apiKeyId: "fake-id", apiSecretKey: "fake-secret", number: "+15550009999",
    webhookSecret: "test-webhook-secret",
    model: "gpt-6-astra",
    harness: "codex-sdk",
    environmentId: "env-test",
    environment: async () => ({
      id: "env-test",
      config: { type: "cloud", sandbox: { scope: "agent", desktop: true } },
    }),
    hasMembership: vi.fn(async (u: string, t: string) => t === `tenant-${u}`),
    fetch: vi.fn(async (_url: string, o: any) => {
      messages.push(JSON.parse(o.body));
      return Response.json({status:'SENT',message_handle:'sent-id'});
    }),
  };
  const service = new IMessageOnboarding(deps);
  const post = async (id: string | number, text: string, sender = "+15550000101", extra: Record<string, unknown> = {}, secret = deps.webhookSecret) =>
    service.webhookRoutes().request("/", {
      method: "POST", headers: { "content-type": "application/json", "sb-signing-secret": secret },
      body: JSON.stringify({ message_handle: String(id), content: text, from_number: sender, to_number: deps.number, is_outbound: false, status: "RECEIVED", ...extra }),
    });
  const link = async (user = "u", sender = "+15550000101") => {
    const r = await service.link(`tenant-${user}`, user);
    await post(`link-${user}`, r.code!, sender);
    await service.tick();
    deps.router.appendEvent.mockClear(); deps.sessions.create.mockClear();
  };
  return { db, sql, service, deps, create, events, messages, post, link };
}

describe("iMessage channel", () => {
  it("requires every setting and an E.164 line", () => {
    const env = { SENDBLUE_API_KEY_ID: "id", SENDBLUE_API_SECRET_KEY: "secret", SENDBLUE_WEBHOOK_SECRET: "hook", SENDBLUE_NUMBER: "+15551234567" };
    expect(sendblueEnabled(env)).toBe(true);
    for (const key of Object.keys(env)) expect(sendblueEnabled({ ...env, [key]: "" })).toBe(false);
    expect(sendblueEnabled({ ...env, SENDBLUE_NUMBER: "not-a-number" })).toBe(false);
  });
  it("authenticates, limits bodies, ignores groups/echoes/status/reactions and validates identities", async () => {
    const f = await fixture();
    expect((await f.post(1, "hello", undefined, {}, "wrong")).status).toBe(401);
    expect((await f.post(2, "x".repeat(70000))).status).toBe(413);
    for (const extra of [{ is_outbound: true }, { is_outbound: "false" }, { status: "DELIVERED" }, { group_id: "group" }, { participants: ["a", "b", "c"] }, { to_number: "+15551111111" }, { is_reaction: true }, { message_type: "reaction" }])
      expect((await f.post(3, "ignore", undefined, extra)).status).toBe(200);
    expect((await f.post(4, "bad", "not-an-identity")).status).toBe(400);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM imessage_inbox").get()).toEqual({ n: 0 });
    f.deps.webhookSecretHeader = "x-custom-secret";
    const response = await new IMessageOnboarding(f.deps).webhookRoutes().request("/", { method: "POST", headers: { "x-custom-secret": f.deps.webhookSecret, "content-type": "application/json" }, body: "null" });
    expect(response.status).toBe(400);
  });
  it("hashes expiring single-use codes, rotates codes and rejects replay from another sender", async () => {
    const f = await fixture();
    await Promise.all([f.service.ensure("tenant-u", "u"), f.service.ensure("tenant-u", "u")]);
    expect(f.create).toHaveBeenCalledTimes(1);
    const old = await f.service.link("tenant-u", "u");
    const r = await f.service.link("tenant-u", "u");
    expect(r.number).toBe(f.deps.number);
    expect(decodeURIComponent(r.url!)).toContain(r.code);
    const row = f.db.prepare("SELECT * FROM imessage_accounts").get() as any;
    expect(row.link_hash).toHaveLength(64); expect(row.link_hash).not.toContain(r.code);
    await f.post(1, old.code!); await f.service.tick();
    expect((await f.service.status("tenant-u", "u")).connected).toBe(false);
    f.db.exec("UPDATE imessage_accounts SET link_expires_at=0");
    await f.post(2, r.code!); await f.service.tick();
    expect((await f.service.status("tenant-u", "u")).connected).toBe(false);
    const fresh = await f.service.link("tenant-u", "u");
    await f.post(3, fresh.code!); await f.service.tick();
    await f.post(4, fresh.code!, "+15550000202"); await f.service.tick();
    expect(f.db.prepare("SELECT chat_id,link_hash FROM imessage_accounts").get()).toEqual({ chat_id: "+15550000101", link_hash: null });
    expect(f.messages[0].content).toContain("Your agent is ready");
    const options = f.deps.fetch.mock.calls[0][1];
    expect(options.headers).toMatchObject({ "sb-api-key-id": "fake-id", "sb-api-secret-key": "fake-secret" });
    expect(f.messages[0]).toMatchObject({ number: "+15550000101", from_number: f.deps.number });
  });
  it("deduplicates across restarts, forwards text, creates setup and run snapshots, switches agents and interrupts", async () => {
    const f = await fixture(); await f.link();
    await f.post("new", "/new QA the site"); await f.post("new", "/new QA the site");
    await new IMessageOnboarding(f.deps).tick();
    expect(f.create).toHaveBeenCalledTimes(2);
    expect(f.deps.sessions.create.mock.calls[0][0]).toMatchObject({ environmentId: "env-test", metadata: { oma_setup: true }, agentSnapshot: { harness: "codex-sdk" } });
    await f.deps.agents.update({ tenantId: "tenant-u", agentId: "agent-2", input: { system: "Saved task", metadata: { default_vault_ids: ["vault-u"] } } });
    f.deps.sessions.get = async () => ({ status: "idle" });
    await f.post("run", "/run"); await f.service.tick();
    expect(f.deps.sessions.create.mock.calls.at(-1)[0]).toMatchObject({ agentSnapshot: { system: "Saved task" }, vaultIds: ["vault-u"] });
    const sid = [...f.events.keys()].at(-1)!;
    await f.post("text", "hello"); await f.service.tick();
    expect(f.events.get(sid)!.at(-1).content[0].text).toBe("hello");
    for (const command of ["/agents", "/use agent-1", "/status", "/stop", "/help"]) { await f.post(command.slice(1).replace(/ /g, "-"), command); await f.service.tick(); }
    expect(f.messages.some(m => m.content.includes("(active)"))).toBe(true);
    expect(f.messages.some(m => m.content.includes("Now talking"))).toBe(true);
    expect(f.deps.router.appendEvent.mock.calls.some((c: any) => c[1].type === "user.interrupt")).toBe(true);
    await f.link("v", "+15550000202"); await f.post("wrong-owner", "/use agent-3"); await f.service.tick();
    expect(f.messages.at(-1).content).toContain("not available");
  });
  it("forwards plain split agent replies once and links access requests to authenticated console", async () => {
    const f = await fixture(); await f.link();
    await f.post("connect", "/connect linear"); await f.service.tick();
    expect(f.messages.at(-1).content).toContain("https://test.example/sessions/sess-1#needs-you");
    expect(f.messages.at(-1).reply_markup).toBeUndefined();
    f.events.get("sess-1")!.push({ seq: 10, type: "agent.message", content: [{ type: "text", text: "# Done\n**Great** [link](https://example.com)\n" + "x".repeat(40000) }] });
    const before = f.messages.length;
    await f.service.tick(); await new IMessageOnboarding(f.deps).tick();
    const sent = f.messages.slice(before);
    expect(sent).toHaveLength(3); expect(sent.every(m => m.content.length <= 18996)).toBe(true);
    expect(sent.map(m => m.content).join("")).toContain("Done\nGreat link (https://example.com)");
    expect(plainText("```js\nconst n = 1;\n```\n`code` ~~old~~")).toBe("const n = 1;\n\ncode old");
  });
  it("answers /connect for a service with no one-click app instead of going silent", async () => {
    const f = await fixture(); await f.link();
    f.deps.requestAccess.mockImplementationOnce(async () => ({ request_id: "r", status: "unavailable", note: "No connect card was posted" }));
    await f.post("connect-origami", "/connect origami"); await f.service.tick();
    expect(f.messages.at(-1).content).toContain("origami isn't available as a one-click connection");
    expect(f.messages.at(-1).content).toContain("/connect origami");
  });
  it("retries temporary errors with backoff, honors Retry-After and unlinks only contact failures", async () => {
    const f = await fixture(); await f.link();
    f.deps.fetch.mockResolvedValueOnce(Response.json({ status: "ERROR" }, { status: 500 }));
    await f.post("retry", "/status"); await f.service.tick();
    const pending = () => f.db.prepare("SELECT * FROM imessage_outbox WHERE sent=0").get() as any;
    expect(pending().attempts).toBe(1); expect(pending().next_at).toBeGreaterThan(Date.now());
    f.db.exec("UPDATE imessage_outbox SET next_at=0");
    f.deps.fetch.mockResolvedValueOnce(Response.json({ status: "ERROR" }, { status: 429, headers: { "retry-after": "120" } }));
    await f.service.tick(); expect(pending().attempts).toBe(2); expect(pending().next_at).toBeGreaterThan(Date.now() + 110000);
    f.db.exec("UPDATE imessage_outbox SET next_at=0"); await f.service.tick(); expect(pending()).toBeUndefined();
    f.deps.fetch.mockResolvedValueOnce(Response.json({ status: "ERROR", error_key: "INVALID_API_KEY" }, { status: 403 }));
    await f.post("auth", "/status"); await f.service.tick(); expect((await f.service.status("tenant-u", "u")).connected).toBe(true);
    f.db.exec("UPDATE imessage_outbox SET next_at=0");
    f.deps.fetch.mockResolvedValueOnce(Response.json({ status: "DECLINED", error_key: "OPTED_OUT" }));
    await f.service.tick(); expect((await f.service.status("tenant-u", "u")).connected).toBe(false); expect(pending()).toBeUndefined();
  });
  it("checks membership on inbound, outbox delivery and authenticated routes", async () => {
    const f = await fixture(); await f.link();
    f.deps.hasMembership.mockResolvedValue(false);
    await f.post("revoked", "do not run"); await f.service.tick(); expect(f.deps.router.appendEvent).not.toHaveBeenCalled();
    f.db.exec("INSERT INTO imessage_outbox(id,tenant_id,user_id,chat_id,text) VALUES('pending','tenant-u','u','+15550000101','do not send')");
    const before = f.messages.length; await f.service.tick(); expect(f.messages).toHaveLength(before);
    const app = new Hono<any>(); app.use("*", async (c, next) => { c.set("tenant_id", "tenant-u"); c.set("user_id", "u"); await next(); }); app.route("/", f.service.routes());
    expect((await app.request("/connect", { method: "POST" })).status).toBe(403);
    f.deps.hasMembership.mockResolvedValue(true);
    expect((await app.request("/connection", { method: "DELETE" })).status).toBe(200);
    expect((await f.service.status("tenant-u", "u")).connected).toBe(false);
  });
  it("keeps a rejected session append in the durable inbox for retry", async () => {
    const f = await fixture(); await f.link();
    f.deps.router.appendEvent.mockResolvedValueOnce({ status: 503 });
    await f.post("append-retry", "retry this task"); await f.service.tick();
    expect(f.db.prepare("SELECT done,attempts FROM imessage_inbox WHERE update_id='append-retry'").get()).toEqual({ done: 0, attempts: 1 });
    f.db.exec("UPDATE imessage_inbox SET next_at=0");
    await new IMessageOnboarding(f.deps).tick();
    expect(f.events.get("sess-1")!.filter(e => e.content?.[0]?.text === "retry this task")).toHaveLength(1);
    expect(f.db.prepare("SELECT done,payload FROM imessage_inbox WHERE update_id='append-retry'").get()).toEqual({ done: 1, payload: "{}" });
  });
  it("preserves Apple ID identities and tells linked users attachments need text", async () => {
    const f = await fixture(); await f.link("u", "alice@example.com");
    await f.post("media", "", "alice@example.com", { media_url: "https://example.invalid/private.jpg" }); await f.service.tick();
    expect(f.messages.at(-1)).toMatchObject({ number: "alice@example.com", content: "Please send a text message. Attachments are not supported yet." });
    expect(JSON.stringify(f.deps.fetch.mock.calls)).not.toContain("private.jpg");
  });
  it("bounds stranger notices durably, without running agents", async () => {
    const f = await fixture();
    for (let i = 0; i < 12; i++) { await f.post(`notice-${i}`, "hi", `+15550000${String(i).padStart(3, "0")}`); await f.service.tick(); }
    expect(f.messages).toHaveLength(10); expect(f.create).not.toHaveBeenCalled();
    await f.post("repeat", "hi", "+15550000000"); await new IMessageOnboarding(f.deps).tick(); expect(f.messages).toHaveLength(10);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM imessage_notices").get()).toEqual({ n: 10 });
  });
});
