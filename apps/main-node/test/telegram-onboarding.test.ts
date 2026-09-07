import { describe, it, expect, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
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
});
