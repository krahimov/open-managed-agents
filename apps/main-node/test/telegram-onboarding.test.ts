import { describe, it, expect, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { BetterSqlite3SqlClient } from "../../../packages/sql-client/src/adapters/better-sqlite3";
import { TelegramOnboarding } from "../src/lib/telegram-onboarding.js";
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
        "../migrations-sqlite/0004_telegram_onboarding.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  db.exec(readFileSync(new URL("../migrations-sqlite/0005_telegram_setup.sql", import.meta.url), "utf8"));
  db.exec(readFileSync(new URL("../migrations-sqlite/0006_imessage_onboarding.sql", import.meta.url), "utf8"));
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
    token: "test-token",
    username: "test_bot",
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
      return new Response('{"ok":true}', { status: 200 });
    }),
  };
  const service = new TelegramOnboarding(deps);
  const post = async (
    id: number,
    text: string,
    chat = 101,
    secret = deps.webhookSecret,
  ) =>
    service.webhookRoutes().request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": secret,
      },
      body: JSON.stringify({
        update_id: id,
        message: {
          message_id: id,
          text,
          from: { id: chat },
          chat: { id: chat, type: "private" },
        },
      }),
    });
  const link = async (user = "u", chat = 101) => {
    const r = await service.link(`tenant-${user}`, user);
    const token = new URL(r.url!).searchParams.get("start");
    await post(chat, `/start ${token}`, chat);
    await service.tick();
    deps.router.appendEvent.mockClear();
    deps.sessions.create.mockClear();
  };
  return { db, sql, service, deps, create, events, messages, post, link };
}
describe("Telegram onboarding", () => {
  it("creates once, hashes one-use link tokens, and welcomes the linked chat", async () => {
    const f = await fixture();
    await Promise.all([
      f.service.ensure("tenant-u", "u"),
      f.service.ensure("tenant-u", "u"),
    ]);
    expect(f.create).toHaveBeenCalledTimes(1);
    const r = await f.service.link("tenant-u", "u");
    const token = new URL(r.url!).searchParams.get("start")!;
    const row = f.db.prepare("SELECT * FROM telegram_accounts").get() as any;
    expect(row.link_hash).not.toContain(token);
    expect(row.link_hash).toHaveLength(64);
    await f.post(1, `/start ${token}`);
    await f.service.tick();
    expect(f.messages[0].text).toContain("Your agent is ready");
    expect(await f.service.status("tenant-u", "u")).toMatchObject({
      connected: true,
      agent_id: "agent-1",
    });
    await f.post(2, `/start ${token}`, 202);
    await f.service.tick();
    expect(f.messages).toHaveLength(1);
    await f.service.link("tenant-u", "u");
    expect(f.deps.router.appendEvent).toHaveBeenCalledTimes(1);
  });
  it("rejects forged webhooks, expired links and revoked membership", async () => {
    const f = await fixture();
    expect((await f.post(1, "hello", 101, "wrong")).status).toBe(401);
    const r = await f.service.link("tenant-u", "u");
    f.db.exec("UPDATE telegram_accounts SET link_expires_at=0");
    await f.post(2, `/start ${new URL(r.url!).searchParams.get("start")}`);
    await f.service.tick();
    expect(f.messages).toHaveLength(0);
    await f.link();
    f.deps.hasMembership.mockResolvedValue(false);
    await f.post(3, "run this");
    await f.service.tick();
    expect(f.deps.router.appendEvent).not.toHaveBeenCalled();
  });
  it("deduplicates retries, creates agents from chat and preserves the cloud environment", async () => {
    const f = await fixture();
    await f.link();
    await f.post(200, "/new QA our website");
    await f.post(200, "/new QA our website");
    await f.service.tick();
    expect(f.create).toHaveBeenCalledTimes(2);
    expect(f.deps.router.appendEvent).toHaveBeenCalledTimes(1);
    expect(f.deps.sessions.create.mock.calls[0][0]).toMatchObject({
      environmentId: "env-test",
      environmentSnapshot: {
        config: { sandbox: { scope: "agent", desktop: true } },
      },
      agentSnapshot: { harness: "codex-sdk", model: "gpt-6-astra" },
      metadata: { oma_setup: true },
    });
    const sid = [...f.events.keys()].at(-1)!;
    f.events.get(sid)!.push({
      seq: 1,
      type: "agent.message",
      content: [{ type: "text", text: "QA complete" }],
    });
    await f.service.tick();
    await f.service.tick();
    expect(f.messages.filter((m) => m.text === "QA complete")).toHaveLength(1);
    await f.post(201, "/status");
    await f.post(202, "/stop");
    await f.service.tick();
    expect(f.messages.some((m) => m.text.includes("running"))).toBe(true);
    expect(f.deps.router.appendEvent.mock.calls.at(-1)[1].type).toBe(
      "user.interrupt",
    );
  });
  it("survives restart and prevents cross-account switching", async () => {
    const f = await fixture();
    await f.link();
    await f.link("v", 202);
    await f.post(300, "/use agent-2");
    await f.service.tick();
    expect(f.messages.at(-1).text).toContain("not available");
    await f.post(301, "hello after restart");
    const restarted = new TelegramOnboarding(f.deps);
    await restarted.tick();
    expect(f.deps.router.appendEvent).toHaveBeenCalledTimes(1);
    await f.post(302, "/unlink");
    await restarted.tick();
    await f.post(303, "should be ignored");
    await restarted.tick();
    expect(f.deps.router.appendEvent).toHaveBeenCalledTimes(1);
  });
  it("retries delivery without rerunning the agent task", async () => {
    const f = await fixture();
    await f.link();
    f.deps.fetch.mockResolvedValueOnce(
      new Response('{"ok":false}', { status: 500 }),
    );
    await f.post(400, "/status");
    await f.service.tick();
    f.db.exec("UPDATE telegram_outbox SET next_at=0");
    await f.service.tick();
    expect(f.messages.at(-1).text).toContain("running");
    expect(f.deps.sessions.create).toHaveBeenCalledTimes(0);
  });
  it("bare /new starts setup, accepts a bot suffix, then /run snapshots the saved configuration and vault", async () => {
    const f = await fixture(); await f.link();
    await f.post(501, "/new@test_bot"); await f.service.tick();
    expect(f.create).toHaveBeenCalledTimes(2);
    expect(f.deps.sessions.create.mock.calls[0][0].metadata.oma_setup).toBe(true);
    const input = f.deps.router.appendEvent.mock.calls[0][1].content[0].text;
    expect(input).toContain("Ask me what I want");
    await f.deps.agents.update({ tenantId: "tenant-u", agentId: "agent-2", input: { system: "Daily QA", metadata: { default_vault_ids: ["vault-u"] } } });
    f.deps.sessions.get = async () => ({ status: "idle" });
    await f.post(502, "/run"); await f.service.tick();
    const work = f.deps.sessions.create.mock.calls.at(-1)[0];
    expect(work.metadata.oma_setup).toBeUndefined();
    expect(work.agentSnapshot.system).toBe("Daily QA");
    expect(work.vaultIds).toEqual(["vault-u"]);
    // Recover after replacing the session but before the webhook is acknowledged.
    f.db.prepare("UPDATE telegram_inbox SET done=0,payload=? WHERE update_id='502'").run(JSON.stringify({ update_id:502, message:{ text:"/run", from:{id:101}, chat:{id:101,type:"private"} } }));
    await new TelegramOnboarding(f.deps).tick();
    expect(f.deps.sessions.create).toHaveBeenCalledTimes(2);
  });
  it("sends durable connect buttons, restricts the page to its owner, and validates vault ownership", async () => {
    const f = await fixture(); await f.link();
    await f.post(601, "/connect linear"); await f.service.tick();
    const button = f.messages.find(m => m.reply_markup)?.reply_markup.inline_keyboard[0][0];
    expect(button).toEqual({ text:"Connect linear", web_app: { url:"https://test.example/telegram/connect/sess-1/acreq-telegram-601" } });
    expect(JSON.stringify(button)).not.toContain("test-token");
    const app = (user: string) => {
      const h = new Hono<any>(); h.use("*", async (c,next) => { c.set("user_id",user);c.set("tenant_id", "tenant-u"); await next(); });
      h.route("/",f.service.routes());return h;
    };
    expect((await app("u").request("/conversations/sess-1/access/acreq-telegram-601")).status).toBe(200);
    expect((await app("v").request("/conversations/sess-1/access/acreq-telegram-601")).status).toBe(404);
    const attach = (id: string) => app("u").request("/conversations/sess-1/vault",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({vault_id:id})});
    expect((await attach("vault-other")).status).toBe(404);
    expect((await attach("vault-u")).status).toBe(200);
    expect(f.deps.agents.update).toHaveBeenCalledWith(expect.objectContaining({input:{metadata:{default_vault_ids:["vault-u"]}}}));
    await f.post(601, "/connect linear"); await f.service.tick();
    expect(f.deps.requestAccess).toHaveBeenCalledTimes(1);
    await f.post(602, "/unlink");await f.service.tick();
    expect((await app("u").request("/conversations/sess-1/access/acreq-telegram-601")).status).toBe(404);
  });

});

function signedLaunch(userId: number) {
  const fields = new URLSearchParams({ auth_date: String(Math.floor(Date.now()/1000)), user: JSON.stringify({ id: userId }) });
  const key = createHmac("sha256", "WebAppData").update("test-token").digest();
  fields.set("hash", createHmac("sha256", key).update([...fields.entries()].sort().map(([k,v]) => `${k}=${v}`).join("\n")).digest("hex"));
  return fields.toString();
}
it("binds signed Mini App identity to the exact owned request and rechecks membership and unlink", async () => {
  const f = await fixture(); await f.link();
  await f.post(700, "/connect linear"); await f.service.tick();
  const proof = signedLaunch(101);
  const verify = () => f.service.miniAppConnection(proof, "sess-1", "acreq-telegram-700");
  expect(await verify()).toMatchObject({ tenantId: "tenant-u", userId: "u", agent: { id: "agent-1" } });
  expect(await f.service.miniAppConnection(signedLaunch(102), "sess-1", "acreq-telegram-700")).toBeNull();
  expect(await f.service.miniAppConnection(proof, "sess-other", "acreq-telegram-700")).toBeNull();
  expect(await f.service.miniAppConnection(proof, "sess-1", "request-other")).toBeNull();
  f.deps.hasMembership.mockResolvedValue(false);
  expect(await verify()).toBeNull();
  f.deps.hasMembership.mockResolvedValue(true);
  await f.post(701, "/unlink"); await f.service.tick();
  expect(await verify()).toBeNull();
});

// Both real adapters share this fixture's SQL and session services; only providers are fake.
import { IMessageOnboarding } from "../src/lib/imessage-onboarding.js";
async function bothChannels() {
  const f = await fixture();
  await f.link();
  const imessages: any[] = [];
  const ideps = { ...f.deps, apiKeyId: "fake", apiSecretKey: "fake", number: "+15550009999",
    fetch: vi.fn(async (_url: string, o: any) => { imessages.push(JSON.parse(o.body)); return Response.json({ status: "SENT", message_handle: "fake-sent-id" }); }) };
  const imessage = new IMessageOnboarding(ideps);
  // Link the same workspace user, retaining independently selected agents.
  const link = await imessage.link("tenant-u", "u");
  const ipost = (id: string, content: string) => imessage.webhookRoutes().request("/", {
    method: "POST", headers: { "content-type": "application/json", "sb-signing-secret": ideps.webhookSecret },
    body: JSON.stringify({ message_handle: id, content, from_number: "+15550000101", to_number: ideps.number, is_outbound: false, status: "RECEIVED" }),
  });
  await ipost("link", link.code!); await imessage.tick();
  await ipost("select", "/use agent-1"); await imessage.tick();
  f.messages.length = 0; imessages.length = 0;
  const ticks = () => Promise.all([f.service.tick(), imessage.tick()]);
  return { ...f, imessage, ideps, imessages, ipost, ticks };
}
describe("workspace agents and shared conversations", () => {
  it("lists console agents, saves numbering across restart/list changes, and resolves IDs, exact names and prefixes", async () => {
    const f = await fixture(); await f.link();
    const alpha = await f.create({ tenantId: "tenant-u", input: { name: "Alpha", metadata: {} } });
    await f.create({ tenantId: "tenant-u", input: { name: "Alphabet", metadata: {} } });
    await f.post(800, "/agents"); await f.service.tick();
    expect(f.messages.at(-1).text).toContain(`1. Alpha — ${alpha.id}`);
    expect(f.messages.at(-1).text).toContain("(active)");
    await f.create({ tenantId: "tenant-u", input: { name: "Aardvark", metadata: {} } });
    await f.post(801, "/use 1"); await new TelegramOnboarding(f.deps).tick();
    expect(f.messages.at(-1).text).toBe("Now talking to Alpha.");
    await f.post(802, "/use aLpHa"); await f.service.tick();
    expect(f.messages.at(-1).text).toBe("Now talking to Alpha.");
    await f.post(803, "/use alphab"); await f.service.tick();
    expect(f.messages.at(-1).text).toBe("Now talking to Alphabet.");
    await f.post(804, `/use ${alpha.id}`); await f.service.tick();
    expect(f.messages.at(-1).text).toBe("Now talking to Alpha.");
    await f.post(805, "/use alph"); await f.service.tick();
    expect(f.messages.at(-1).text).toContain("Several agents match");
    expect(f.messages.at(-1).text).toContain("Alphabet");
    f.db.prepare("UPDATE agents SET archived_at=1 WHERE id=?").run(alpha.id);
    await f.post(806, `/use ${alpha.id}`); await f.service.tick();
    expect(f.messages.at(-1).text).toContain("not available");
    await f.post(807, "/use 1"); await f.service.tick();
    expect(f.messages.at(-1).text).toContain("not available");
    await f.create({ tenantId: "tenant-u", input: { name: "Alphabet", metadata: {} } });
    await f.post(808, "/use Alphabet"); await f.service.tick();
    expect(f.messages.at(-1).text).toContain("Several agents match");
  });
  it("caps long phone lists and does not gate agents on another user's provenance", async () => {
    const f = await fixture(); await f.link();
    for (let i=0; i<24; i++) await f.create({ tenantId: "tenant-u", input: { name: `Agent ${i}`, metadata: { imessage_owner: "other-member" } } });
    await f.post(810, "/agents"); await f.service.tick();
    expect(f.messages.at(-1).text).toContain("5 more omitted");
    expect(f.messages.at(-1).text.split("\n")).toHaveLength(21);
    await f.post(811, "/use agent-2"); await f.service.tick();
    expect(f.messages.at(-1).text).toBe("Now talking to Agent 0.");
  });
  it("uses the same session, namespaces inbound IDs, and sends each output only to the last used channel", async () => {
    const f = await bothChannels();
    await f.post(900, "from Telegram"); await f.service.tick();
    await f.ipost("900", "from iMessage"); await f.imessage.tick();
    const es = f.events.get("sess-1")!;
    expect(es.filter(e => e.content?.[0]?.text?.startsWith("from "))).toHaveLength(2);
    expect(new Set(es.map(e => e.id)).size).toBe(es.length);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM channel_conversations WHERE agent_id='agent-1'").get()).toEqual({ n: 1 });
    es.push({ seq: es.length, type: "agent.message", content: [{ type: "text", text: "only iMessage" }] });
    await f.ticks(); await f.ticks();
    expect(f.imessages.filter(m => m.content === "only iMessage")).toHaveLength(1);
    expect(f.messages.filter(m => m.text === "only iMessage")).toHaveLength(0);
    await f.post(901, "/status"); await f.service.tick();
    es.push({ seq: es.length, type: "agent.message", content: [{ type: "text", text: "only Telegram" }] });
    await Promise.all([new TelegramOnboarding(f.deps).tick(), new IMessageOnboarding(f.ideps).tick(), f.service.tick()]);
    expect(f.messages.filter(m => m.text === "only Telegram")).toHaveLength(1);
    expect(f.imessages.filter(m => m.content === "only Telegram")).toHaveLength(0);
    expect(f.deps.sessions.create.mock.calls.every(([o]: any) => !/Telegram|iMessage/.test(o.title))).toBe(true);
  });
  it("holds cursors without links and falls back, including already queued replies after a failed send", async () => {
    const f = await bothChannels();
    f.ideps.fetch.mockResolvedValueOnce(Response.json({ status: "ERROR" }, { status: 500 }));
    const es = f.events.get("sess-1")!;
    es.push({ seq: es.length, type: "agent.message", content: [{ type: "text", text: "queued reply" }] });
    await f.imessage.tick();
    expect(f.db.prepare("SELECT sent FROM channel_deliveries").get()).toEqual({ sent: 0 });
    await f.ipost("unlink", "/unlink"); await f.imessage.tick();
    f.db.exec("UPDATE channel_deliveries SET next_at=0");
    await f.service.tick();
    expect(f.messages.filter(m => m.text === "queued reply")).toHaveLength(1);
    await f.post(910, "/unlink"); await f.service.tick();
    const before = f.db.prepare("SELECT last_seq FROM channel_conversations WHERE session_id='sess-1'").get();
    es.push({ seq: es.length, type: "session.error", error: "failed" });
    await f.ticks();
    expect(f.db.prepare("SELECT last_seq FROM channel_conversations WHERE session_id='sess-1'").get()).toEqual(before);
    const link = await f.service.link("tenant-u", "u");
    await f.post(911, `/start ${new URL(link.url!).searchParams.get("start")}`); await f.ticks();
    expect(f.messages.filter(m => m.text.includes("encountered an error"))).toHaveLength(1);
  });
  it("keeps shared /run and /stop state and Mini App access checks, with channel-specific access rendering", async () => {
    const f = await bothChannels();
    await f.ipost("connect", "/connect linear"); await f.imessage.tick();
    expect(f.imessages.at(-1).content).toContain("/sessions/sess-1#needs-you");
    expect(await f.service.miniAppConnection(signedLaunch(101), "sess-1", "acreq-imessage-connect")).toMatchObject({ userId: "u" });
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM telegram_conversations").get()).toEqual({ n: 0 });
    await f.post(920, "/connect gmail"); await f.service.tick();
    expect(f.messages.at(-1).reply_markup.inline_keyboard[0][0].web_app.url).toContain("/telegram/connect/sess-1/");
    f.deps.sessions.get = async () => ({ status: "idle" });
    await f.post(921, "/run"); await f.service.tick();
    const work = f.db.prepare("SELECT session_id FROM channel_conversations WHERE agent_id='agent-1'").get() as any;
    expect(work.session_id).not.toBe("sess-1");
    await f.ipost("stop", "/stop"); await f.imessage.tick();
    expect(f.deps.router.appendEvent.mock.calls.at(-1)).toMatchObject([work.session_id, { type: "user.interrupt" }]);
  });
  it("rolls back event enqueue and cursor together and recovers on restart", async () => {
    const f = await bothChannels();
    const es = f.events.get("sess-1")!;
    es.push({ seq: es.length, type: "agent.message", content: [{ type: "text", text: "atomic" }] });
    const cursor = f.db.prepare("SELECT last_seq FROM channel_conversations WHERE session_id='sess-1'").get();
    f.db.exec("CREATE TRIGGER fail_cursor BEFORE UPDATE OF last_seq ON channel_conversations BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
    await expect(f.imessage.tick()).rejects.toThrow("injected failure");
    expect(f.db.prepare("SELECT last_seq FROM channel_conversations WHERE session_id='sess-1'").get()).toEqual(cursor);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM channel_deliveries").get()).toEqual({ n: 0 });
    f.db.exec("DROP TRIGGER fail_cursor");
    await Promise.all([new TelegramOnboarding(f.deps).tick(), new IMessageOnboarding(f.ideps).tick()]);
    expect(f.imessages.filter(m => m.content === "atomic")).toHaveLength(1);
  });
});

it("drains a displaced session without replaying its delivered prefix", async () => {
  const f = await bothChannels();
  f.events.set("displaced", [
    { seq: 4, type: "agent.message", content: [{ type: "text", text: "already delivered" }] },
    { seq: 5, type: "agent.message", content: [{ type: "text", text: "remaining legacy output" }] },
  ]);
  f.db.exec("INSERT INTO channel_conversation_drains VALUES ('displaced','tenant-u','u','agent-1',4)");
  await f.ticks(); await new IMessageOnboarding(f.ideps).tick();
  expect(f.imessages.filter(m => m.content === "remaining legacy output")).toHaveLength(1);
  expect(f.imessages.some(m => m.content === "already delivered")).toBe(false);
  expect(f.db.prepare("SELECT last_seq FROM channel_conversation_drains WHERE session_id='displaced'").get()).toEqual({ last_seq: 5 });
});
it("resumes partial output after restart and falls back on permanent contact failure", async () => {
  const f = await bothChannels();
  const es = f.events.get("sess-1")!;
  const content = "a".repeat(18996) + "remaining";
  es.push({ seq: es.length, type: "agent.message", content: [{ type: "text", text: content }] });
  f.ideps.fetch.mockImplementationOnce(async (_url: string, o: any) => { f.imessages.push(JSON.parse(o.body)); return Response.json({ status: "SENT", message_handle: "fake-sent-id" }); });
  f.ideps.fetch.mockResolvedValueOnce(Response.json({ status: "DECLINED", error_key: "OPTED_OUT" }));
  await f.imessage.tick();
  expect(f.imessages.map(m => m.content).join("")).toBe("a".repeat(18996));
  expect((await f.imessage.status("tenant-u", "u")).connected).toBe(false);
  await new TelegramOnboarding(f.deps).tick();
  expect(f.messages.map(m => m.text).join("")).toBe("remaining");
  await f.ticks();
  expect(f.messages).toHaveLength(1);
});
it("recovers a channel-created agent by its original creation key", async () => {
  const f = await fixture(); await f.link();
  await f.create({ tenantId: "tenant-u", input: { name: "Recovered", metadata: { telegram_creation_key: "u:950", telegram_owner: "u" } } });
  await f.post(950, "/new Recovered"); await f.service.tick();
  expect(f.create).toHaveBeenCalledTimes(2);
  expect(f.messages.at(-1).text).toContain("Created Recovered");
});
it("serializes first-session creation across simultaneous channel inputs and keeps selection independent", async () => {
  const f = await bothChannels();
  const agent = await f.create({ tenantId: "tenant-u", input: { name: "Console Research", metadata: {} } });
  await f.post(960, `/use ${agent.id}`);
  await f.ipost("list-console", "/agents"); await f.ticks();
  expect(f.imessages.at(-1).content).toContain("1. Console Research");
  await f.ipost("use-number", "/use 1"); await f.imessage.tick();
  expect(f.imessages.at(-1).content).toBe("Now talking to Console Research.");
  await f.ipost("use-name", "/use console res"); await f.imessage.tick();
  await f.post(961, "simultaneous Telegram"); await f.ipost("961", "simultaneous iMessage");
  await f.ticks();
  const c = f.db.prepare("SELECT session_id FROM channel_conversations WHERE agent_id=?").get(agent.id) as any;
  expect(f.events.get(c.session_id)!.map(e => e.content[0].text)).toEqual(["simultaneous Telegram", "simultaneous iMessage"]);
  expect(f.deps.sessions.create.mock.calls.filter(([o]: any) => o.agentId === agent.id)).toHaveLength(1);
  await f.ipost("select-original", "/use agent-1"); await f.imessage.tick();
  expect(f.db.prepare("SELECT active_agent_id FROM telegram_accounts").get()).toEqual({ active_agent_id: agent.id });
});
it("authorizes Telegram access buttons for a drained session through the shared ownership mapping", async () => {
  const f = await bothChannels();
  f.events.set("drained-access", [{ seq: 0, type: "system.access_request", request_id: "old-request", service: "gmail" }]);
  f.db.exec("INSERT INTO channel_conversation_drains VALUES ('drained-access','tenant-u','u','agent-1',-1)");
  await f.post(970, "/status"); await f.ticks();
  expect(f.messages.some(m => m.reply_markup?.inline_keyboard[0][0].web_app.url.includes("drained-access"))).toBe(true);
  expect(await f.service.miniAppConnection(signedLaunch(101), "drained-access", "old-request")).toMatchObject({ userId: "u" });
  expect(await f.service.miniAppConnection(signedLaunch(102), "drained-access", "old-request")).toBeNull();
});
it("does not repeat interrupted pre-upgrade inputs or /run transitions", async () => {
  const f = await fixture(); await f.link();
  f.deps.sessions.get = async () => ({ status: "idle", metadata: { telegram_user: "u" } });
  const es = f.events.get("sess-1")!;
  es.push({ seq: es.length, type: "user.message", id: "update:0000000000000980", content: [{ type: "text", text: "old input" }] });
  await f.post(980, "old input"); await f.service.tick();
  expect(es.filter(e => e.content?.[0]?.text === "old input")).toHaveLength(1);
  f.db.exec("UPDATE channel_conversations SET transition_id='update:0000000000000981'");
  es.push({ seq: es.length, type: "user.message", id: "update:0000000000000981", content: [{ type: "text", text: "old run" }] });
  await f.post(981, "/run"); await f.service.tick();
  expect(f.deps.sessions.create).not.toHaveBeenCalled();
  expect(f.deps.router.appendEvent).not.toHaveBeenCalled();
});
