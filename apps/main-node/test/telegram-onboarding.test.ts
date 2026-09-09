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
